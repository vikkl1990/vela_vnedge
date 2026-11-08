import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeltaRest, DeltaRequestError, DELTA_INDIA_PROD, DELTA_INDIA_TESTNET } from '../delta/rest.ts';
import { productionReader, type AccountReader } from './reader.ts';

export type ObservationSession = { revision: string; reader: AccountReader; current: () => boolean };

export type DeltaEnvironment = 'production' | 'testnet';
type Credentials = { version: 1; revision: string; environment: DeltaEnvironment; apiKey: string; apiSecret: string; savedAt: number };
export type ConnectionCheck = { ok: boolean; at: number; latencyMs: number; message: string };
export type ConnectionStatus = { configured: boolean; environment: DeltaEnvironment | null; savedAt: number | null; check: ConnectionCheck | null };
type Probe = (credentials: Readonly<Credentials>) => Promise<void>;

export class ConnectionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function credential(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(value.trim())) {
    throw new ConnectionError(400, 'Enter both the API key and API secret, without spaces.');
  }
  return value.trim();
}

/** Fixed hosts and authenticated reads only. Never constructs an executor. */
export async function probeDelta(c: Readonly<Credentials>): Promise<void> {
  const rest = new DeltaRest({ baseUrl: c.environment === 'production' ? DELTA_INDIA_PROD : DELTA_INDIA_TESTNET,
    apiKey: c.apiKey, apiSecret: c.apiSecret, timeoutMs: 8_000 });
  for (const endpoint of ['/v2/wallet/balances', '/v2/positions/margined']) {
    const result = await rest.request('GET', endpoint, { auth: true, retries: 0 });
    if (!Array.isArray(result)) throw new Error('unexpected_response');
  }
}

/** Upstream responses can contain key identifiers: never return their text or arbitrary codes. */
function failureMessage(e: unknown): string {
  if (e instanceof DeltaRequestError) {
    if (e.status === 429) return 'Delta rate limit reached. Wait briefly before checking again.';
    if (e.code === 'ip_not_whitelisted_for_api_key' || e.code === 'ip_not_whitelisted') return 'Add this server’s public IP to the key’s Delta IP allowlist.';
    if (e.code === 'SignatureExpired' || e.code === 'signature_expired') return 'Delta rejected the request timestamp. Check the server clock.';
    if (e.status === 401 || e.status === 403 || /signature|api_key|permission/i.test(e.code ?? '')) {
      return 'Authentication refused. Check the key, secret, selected environment, Read Data permission and server IP allowlist.';
    }
    if (e.status >= 500) return 'Delta is temporarily unavailable. Try again later.';
  }
  return 'Connection could not be verified. Check server connectivity and try again.';
}

/** Deliberately separate from config, the database, backups and executor environment credentials. */
export class DeltaConnection {
  private readonly directory: string;
  private readonly filename: string;
  private last: { revision: string; result: ConnectionCheck } | null = null;
  private active: { revision: string; promise: Promise<ConnectionStatus> } | null = null;
  private lastStarted = -Infinity;
  private probe: Probe;
  constructor(dataDir: string, probe: Probe = probeDelta) {
    this.probe = probe;
    this.directory = path.join(dataDir, 'secrets');
    this.filename = path.join(this.directory, 'delta-connection.json');
  }

  private safe(stat: fs.Stats, directory = false): void {
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe_storage');
  }

  private ensureDirectory(create = false): boolean {
    if (create) { try { fs.mkdirSync(this.directory, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; } }
    try { this.safe(fs.lstatSync(this.directory), true); return true; }
    catch (e: any) { if (e.code === 'ENOENT') return false; throw e; }
  }

  private storage<T>(fn: () => T): T {
    try { return fn(); } catch (e) {
      if (e instanceof ConnectionError) throw e;
      throw new ConnectionError(503, 'Credential storage unavailable. Check the server’s private secrets directory and file permissions.');
    }
  }

  private read(): Credentials | null {
    return this.storage(() => {
      if (!this.ensureDirectory()) return null;
      let fd: number;
      try { fd = fs.openSync(this.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
      try {
        const stat = fs.fstatSync(fd); this.safe(stat);
        if (stat.size > 4096) throw new Error('oversize');
        const c = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (c.version !== 1 || !['production', 'testnet'].includes(c.environment) ||
          typeof c.revision !== 'string' || !Number.isFinite(c.savedAt)) throw new Error('invalid_storage');
        // Disk validation errors must not echo content or appear as a form validation failure.
        try { credential(c.apiKey); credential(c.apiSecret); } catch { throw new Error('invalid_storage'); }
        return c as Credentials;
      } finally { fs.closeSync(fd); }
    });
  }

  status(): ConnectionStatus {
    const c = this.read();
    return { configured: !!c, environment: c?.environment ?? null, savedAt: c?.savedAt ?? null,
      check: c && this.last?.revision === c.revision ? this.last.result : null };
  }

  /** Internal capability only; neither secrets nor a general REST client leave this store. */
  observationRevision(): { revision: string; environment: DeltaEnvironment } | null {
    const c = this.read();
    return c ? { revision: c.revision, environment: c.environment } : null;
  }

  observationSession(): ObservationSession | null {
    const c = this.read();
    if (!c || c.environment !== 'production') return null;
    const current = () => this.read()?.revision === c.revision;
    return { revision: c.revision, reader: productionReader(c.apiKey, c.apiSecret, current), current };
  }

  save(input: unknown): ConnectionStatus {
    const body = input as Record<string, unknown> | null;
    if (!body || !['production', 'testnet'].includes(String(body.environment))) throw new ConnectionError(400, 'Choose Delta India production or testnet.');
    const c: Credentials = { version: 1, revision: randomUUID(), environment: body.environment as DeltaEnvironment,
      apiKey: credential(body.apiKey), apiSecret: credential(body.apiSecret), savedAt: Date.now() };
    this.storage(() => {
      this.ensureDirectory(true);
      try { this.safe(fs.lstatSync(this.filename)); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
      let fd: number | undefined;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(c)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, this.filename);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
      }
    });
    this.last = null;
    return this.status();
  }

  remove(): ConnectionStatus {
    this.storage(() => {
      if (!this.ensureDirectory()) return;
      try { this.safe(fs.lstatSync(this.filename)); fs.unlinkSync(this.filename); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    });
    this.last = null;
    return this.status();
  }

  async check(): Promise<ConnectionStatus> {
    const c = this.read();
    if (!c) throw new ConnectionError(400, 'Save a Delta API key and secret first.');
    if (this.active) {
      if (this.active.revision === c.revision) return this.active.promise;
      throw new ConnectionError(409, 'The previous connection check is finishing. Try again shortly.');
    }
    if (Date.now() - this.lastStarted < 5000) throw new ConnectionError(429, 'Wait five seconds between connection checks.');
    this.lastStarted = Date.now();
    const promise = (async () => {
      let ok = true, message = 'Authenticated wallet and position reads verified. Trading permission was not tested.';
      try { await this.probe(c); } catch (e) { ok = false; message = failureMessage(e); }
      if (this.read()?.revision !== c.revision) throw new ConnectionError(409, 'Credentials changed during the check. Check the saved credentials again.');
      this.last = { revision: c.revision, result: { ok, at: Date.now(), latencyMs: Date.now() - this.lastStarted, message } };
      return this.status();
    })();
    this.active = { revision: c.revision, promise };
    try { return await promise; } finally { this.active = null; }
  }
}
