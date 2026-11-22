import type { AppConfig } from '../config.ts';

/** Legacy credentials remain usable on the server, but never leave through the general API. */
export function configView(cfg: AppConfig) {
  const view = structuredClone(cfg) as Partial<AppConfig>;
  delete (view.alerts!.telegram as Partial<AppConfig['alerts']['telegram']>).botToken;
  return view;
}

/** Credentials and their destination are managed only by the admin-only connection routes. */
export function configPatch(body: Partial<AppConfig>, current: AppConfig): Partial<AppConfig> {
  const patch = structuredClone(body);
  const telegram = patch?.alerts?.telegram;
  if (telegram) {
    if ((telegram.botToken !== undefined && telegram.botToken !== '') ||
        (telegram.chatId !== undefined && telegram.chatId !== current.alerts.telegram.chatId)) {
      throw Object.assign(new Error('Manage Telegram credentials and chat pairing in Settings → Telegram alerts'), { status: 400 });
    }
    // Empty/redacted round trips must not erase a server-side legacy credential.
    delete (telegram as Partial<typeof telegram>).botToken;
    delete (telegram as Partial<typeof telegram>).chatId;
  }
  return patch;
}
