/**
 * Route extensions. Each feature module exports `register(api, app)` and is listed here so
 * independent branches only append one line to this file.
 */
import type { App } from '../app.ts';

export type RouteAdder = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', route: string, handler: (params: Record<string, string>, url: URL, body: any) => Promise<unknown> | unknown) => void;
export type Extension = (add: RouteAdder, app: App) => void;

export const EXTENSIONS: Extension[] = [
  // phase modules append here, e.g.: validationRoutes,
  (await import('../risk/routes.ts')).riskRoutes, // phases 2/3/5: /api/risk, /api/execution, /api/marks
];
