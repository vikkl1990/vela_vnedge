/** In-memory only. A fatal process must stop admitting entries without changing saved risk rules. */
export class RuntimeState {
  state: 'running' | 'stopping' | 'failed' = 'running';
  reason: string | null = null;
  stop(fatal: boolean, reason: string): void {
    if (fatal) { this.state = 'failed'; this.reason = reason; }
    else if (this.state === 'running') { this.state = 'stopping'; this.reason = reason; }
  }
  // Ordinary deployment still drains with the established pending-order lifecycle. Returning a
  // gate rejection while stopping would cancel valid resting setups before they can be saved.
  get entryBlock(): string | null { return this.state === 'failed' ? 'Runtime failed: entries stopped' : null; }
}

interface SupervisorDependencies {
  mark: (fatal: boolean, reason: string) => void;
  shutdown: (fatal: () => boolean) => Promise<void>;
  timeoutMs: () => number;
  report: (message: string) => void;
  exit: (code: number) => void;
}

/** Single bounded shutdown, with fatal errors permanently upgrading the exit status to failure. */
export class ProcessSupervisor {
  private failed = false;
  private started = false;
  private finished = false;
  private readonly d: SupervisorDependencies;
  constructor(d: SupervisorDependencies) { this.d = d; }
  request(reason: 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection' | 'startup'): void {
    const fatal = reason !== 'SIGINT' && reason !== 'SIGTERM';
    this.failed ||= fatal;
    // Do not serialize error objects: rejection values may contain credentials or request bodies.
    const message = fatal ? `Fatal runtime failure (${reason})` : `${reason} received`;
    try { this.d.mark(this.failed, message); } catch { this.failed = true; }
    try { this.d.report(message); } catch { /* shutdown must survive a broken logger */ }
    if (this.started) return;
    this.started = true;
    let timeout = 30_000;
    try { const ms = this.d.timeoutMs(); if (Number.isFinite(ms) && ms > 0) timeout = ms; } catch { /* startup may not have a config */ }
    const timer = setTimeout(() => this.finish(1), timeout);
    void Promise.resolve().then(() => this.d.shutdown(() => this.failed)).then(
      () => { clearTimeout(timer); this.finish(this.failed ? 1 : 0); },
      () => { clearTimeout(timer); this.failed = true; this.finish(1); },
    );
  }
  private finish(code: number): void { if (!this.finished) { this.finished = true; this.d.exit(code); } }
  install(): () => void {
    const uncaught = () => this.request('uncaughtException');
    const rejection = () => this.request('unhandledRejection');
    const sigint = () => this.request('SIGINT');
    const sigterm = () => this.request('SIGTERM');
    process.on('uncaughtException', uncaught);
    process.on('unhandledRejection', rejection);
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
    return () => {
      process.off('uncaughtException', uncaught); process.off('unhandledRejection', rejection);
      process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
    };
  }
}
