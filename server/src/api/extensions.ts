/**
 * Route extensions. Each feature module registers its own endpoints so independent phase
 * branches only append one entry to `EXTENSIONS` instead of editing the router.
 */
import type { App } from '../app.ts';
import { riskRoutes } from '../risk/routes.ts';
import { validationRoutes } from '../validation/routes.ts';
import { opsRoutes } from '../ops/routes.ts';

export type RouteAdder = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', route: string, handler: (params: Record<string, string>, url: URL, body: any) => Promise<unknown> | unknown) => void;
export type Extension = (add: RouteAdder, app: App) => void;

export const EXTENSIONS: Extension[] = [
  riskRoutes,        // phases 2/3/5: /api/risk, /api/execution, /api/marks
  validationRoutes,  // phases 1/6: /api/validation, /api/scanners/:id/inputs, /api/scanners/:id/rule
  opsRoutes,         // phase 4:    /api/ops, /api/metrics
];
