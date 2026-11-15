/** Stable child routes keep each view's filters and deep links independent. */
export const HUB_ROUTES: Record<string, string> = {
  '/scanners': '/strategies/scanners',
  '/library': '/strategies/library',
  '/incubator': '/strategies/incubator',
  '/trackers': '/strategies/trackers',
  '/decisions': '/strategies/decisions',
  '/radar': '/signals/radar',
  '/gates': '/signals/gates',
  '/daily': '/analytics/daily',
  '/learn': '/lab/learn',
  '/logs': '/settings/logs',
}
export const HUBS = [
  {
    root: '/strategies',
    label: 'Strategies',
    tabs: [
      ['/strategies', 'Overview'],
      ['/scanners', 'Scanners'],
      ['/library', 'Library'],
      ['/incubator', 'Incubator'],
      ['/trackers', 'Trackers'],
      ['/decisions', 'Decisions'],
    ],
  },
  {
    root: '/signals',
    label: 'Signals',
    tabs: [
      ['/signals', 'Decisions feed'],
      ['/radar', 'Market radar'],
      ['/gates', 'Entry gates'],
    ],
  },
  {
    root: '/analytics',
    label: 'Performance',
    tabs: [
      ['/analytics', 'Analysis'],
      ['/daily', 'Daily results'],
    ],
  },
  {
    root: '/lab',
    label: 'Research',
    tabs: [
      ['/lab', 'Experiments'],
      ['/learn', 'Model evidence'],
    ],
  },
  {
    root: '/settings',
    label: 'Settings',
    tabs: [
      ['/settings', 'Configuration'],
      ['/logs', 'Audit logs'],
    ],
  },
]
export function canonicalPath(path: string): string {
  const key = Object.keys(HUB_ROUTES).find((key) => path === key || path.startsWith(`${key}/`))
  return key ? HUB_ROUTES[key] + path.slice(key.length) : path
}
export function legacyPath(path: string): string {
  const item = Object.entries(HUB_ROUTES).find(
    ([, target]) => path === target || path.startsWith(`${target}/`),
  )
  return item ? item[0] + path.slice(item[1].length) : path
}
