import type http from 'node:http';
import { isLoopback } from '../auth/routes.ts';
import { ConnectionError, DeltaConnection } from './delta.ts';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, url: URL, body: unknown) => unknown;
type Add = (method: string, route: string, handler: Handler) => void;

/** Trust forwarded TLS only from the local reverse proxy, never from an internet peer. */
export function protectConnectionRequest(req: http.IncomingMessage): void {
  const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  const secure = !!(req.socket as http.IncomingMessage['socket'] & { encrypted?: boolean }).encrypted ||
    (localPeer && req.headers['x-forwarded-proto'] === 'https');
  if (!secure && !isLoopback(req)) throw new ConnectionError(403, 'Use HTTPS or the local SSH tunnel to manage credentials.');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ConnectionError(403, 'Use the connection form on this dashboard.');
  if (req.headers.origin) {
    let origin: URL;
    try { origin = new URL(req.headers.origin); } catch { throw new ConnectionError(403, 'Invalid request origin.'); }
    if (origin.host !== req.headers.host || origin.protocol !== (secure ? 'https:' : 'http:')) {
      throw new ConnectionError(403, 'Use the connection form on this dashboard.');
    }
  }
  if (['PUT', 'POST'].includes(req.method ?? '') && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new ConnectionError(415, 'Send credentials as JSON using the connection form.');
  }
}

export function deltaConnectionRoutes(add: Add, connection: DeltaConnection): void {
  const guard = (handler: Handler): Handler => (req, res, params, url, body) => {
    protectConnectionRequest(req);
    res.setHeader('Cache-Control', 'no-store');
    return handler(req, res, params, url, body);
  };
  add('GET', '/api/connections/delta', guard(() => connection.status()));
  add('PUT', '/api/connections/delta', guard((_r, _s, _p, _u, body) => connection.save(body)));
  add('DELETE', '/api/connections/delta', guard(() => connection.remove()));
  add('POST', '/api/connections/delta/check', guard(() => connection.check()));
}
