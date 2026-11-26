import { legacyPath } from '../../lib/routeHubs.ts'
/** The navigation as data: no React, no icons, so it can be tested and reused. Icons are attached in nav.ts. */
export type NavItem = {
  to: string
  label: string
  /** second key of the `g <key>` chord */
  key: string
  end?: boolean
  adminOnly?: boolean
  /** words that find the page in the command palette but are not shown */
  keywords?: string
  /** one line for the palette */
  blurb: string
}
export type NavGroup = { label: string; items: NavItem[] }

/**
 * The pages in four groups, named for how the product is used: Work (the account as it trades now), Markets (what the
 * scanners see), Lab (building and judging strategies, including the shadow and incubator books) and Control (what
 * stands between a setup and real money).
 * Profile and Users live in the account menu, not the sidebar.
 */
export const GROUPS: NavGroup[] = [
  {
    label: 'Work',
    items: [
      {
        to: '/',
        label: 'Trading',
        end: true,
        key: 'v',
        keywords: 'home overview account equity funnel signals rules performance live backtest dashboard',
        blurb: 'Results, how each signal was decided, and the rules in force',
      },
      {
        to: '/workspace',
        label: 'Workspace',
        key: 'o',
        keywords: 'terminal chart market canvas',
        blurb: 'Markets, chart and positions in one view',
      },
      {
        to: '/trades',
        label: 'Trades',
        key: 't',
        keywords: 'journals history fills paper shadow',
        blurb: 'The trade journal for each book',
      },
    ],
  },
  {
    label: 'Markets',
    items: [
      {
        to: '/signals',
        label: 'Signals',
        key: 'i',
        keywords: 'alerts entries refused',
        blurb: 'Every signal and what became of it',
      },
      {
        to: '/radar',
        label: 'Radar',
        key: 'w',
        keywords: 'heatmap markets',
        blurb: 'Signals across markets at a glance',
      },
      {
        to: '/monitor',
        label: 'Trade health',
        key: 'h',
        keywords: 'positions advisory monitor',
        blurb: 'How open trades are behaving',
      },
      {
        to: '/chart',
        label: 'Chart',
        key: 'c',
        keywords: 'price frames vela',
        blurb: 'Price charts with scripts and positions',
      },
    ],
  },
  {
    label: 'Lab',
    items: [
      {
        to: '/strategies',
        label: 'Strategies',
        key: 'q',
        keywords: 'ladder books backtest shadow paper live scripts',
        blurb: 'Every script and how far it has climbed',
      },
      {
        to: '/decisions',
        label: 'Decisions',
        key: 'd',
        keywords: 'proposals approve queue',
        blurb: 'Incubator proposals waiting for a yes or no',
      },
      {
        to: '/overview',
        label: 'Books',
        key: 'z',
        keywords: 'overview operations books shadow incubator ml needs you',
        blurb: 'The account, shadow and research books side by side',
      },
      {
        to: '/lab',
        label: 'Lab',
        key: 'j',
        keywords: 'backtest ml model train validate experiment',
        blurb: 'Run configured backtests and manage ML training',
      },
      {
        to: '/scanners',
        label: 'Scanners',
        key: 's',
        keywords: 'strategies enable settings',
        blurb: 'The scanners that trade and their records',
      },
      {
        to: '/library',
        label: 'Library',
        key: 'b',
        keywords: 'catalogue scripts author',
        blurb: 'Every script with the bot’s measured record',
      },
      {
        to: '/incubator',
        label: 'Incubator',
        key: 'n',
        keywords: 'shadow promote pairs evidence',
        blurb: 'Where pairs earn their way to the account',
      },
      {
        to: '/trackers',
        label: 'Trackers',
        key: 'r',
        keywords: 'family cells',
        blurb: 'Tracked scanner families and cells',
      },
      {
        to: '/analytics',
        label: 'Performance',
        key: 'a',
        keywords: 'pnl equity analytics',
        blurb: 'Results by scanner, market and period',
      },
      { to: '/daily', label: 'Daily', key: 'y', keywords: 'day report', blurb: 'Day-by-day results' },
      {
        to: '/learn',
        label: 'Learn',
        key: 'l',
        keywords: 'ml model features',
        blurb: 'What the models have learned',
      },
    ],
  },
  {
    label: 'Control',
    items: [
      {
        to: '/live',
        label: 'Live control',
        key: 'f',
        keywords: 'go-live real money arm kill switch readiness',
        blurb: 'Read-only production status and go-live readiness',
      },
      {
        to: '/gates',
        label: 'Gates',
        key: 'k',
        keywords: 'admission risk checks',
        blurb: 'Why entries are allowed or refused',
      },
      {
        to: '/exchange',
        label: 'Exchange',
        key: 'x',
        keywords: 'delta connection orders',
        blurb: 'Exchange connection and reconciliation',
      },
      {
        to: '/settings',
        label: 'Settings',
        key: 'e',
        keywords: 'config risk sizing fees',
        blurb: 'Every number the system runs on',
      },
      { to: '/logs', label: 'Logs', key: 'g', keywords: 'errors audit', blurb: 'Server log and audit trail' },
    ],
  },
]

/** Pages reached from the account menu rather than the sidebar. */
export const ACCOUNT_PAGES: NavItem[] = [
  {
    to: '/profile',
    label: 'Profile',
    key: 'p',
    keywords: 'account password theme',
    blurb: 'Your account and preferences',
  },
  {
    to: '/users',
    label: 'Users',
    key: 'u',
    adminOnly: true,
    keywords: 'admin people roles',
    blurb: 'Who can sign in and what they can do',
  },
]

/** The four views an operator checks from a phone; a fifth button opens the full menu. */
export const PHONE_TABS: Array<{ to: string; label: string; end?: boolean }> = [
  { to: '/', label: 'Trading', end: true },
  { to: '/signals', label: 'Signals' },
  { to: '/trades', label: 'Trades' },
  { to: '/analytics', label: 'Performance' },
]

export function visibleGroups(isAdmin: boolean): NavGroup[] {
  return GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => !n.adminOnly || isAdmin) }))
}

export type RouteMeta = { title: string; section: string | null; parent?: { label: string; to: string } }

/** Route → title, section and parent crumb. Scanner detail resolves the scanner's name once it is loaded. */
export function routeMeta(pathname: string, scannerName?: string): RouteMeta {
  pathname = legacyPath(pathname)
  const m = /^\/scanners\/([^/]+)/.exec(pathname)
  if (m)
    return {
      title: scannerName ?? decodeURIComponent(m[1]),
      section: 'Lab',
      parent: { label: 'Scanners', to: '/scanners' },
    }
  const r = /^\/trades\/(\d+)\/replay/.exec(pathname)
  if (r)
    return { title: `Trade #${r[1]} replay`, section: 'Work', parent: { label: 'Trades', to: '/trades' } }
  const seg = pathname === '/' ? '/' : `/${pathname.replace(/^\//, '').split('/')[0]}`
  const group = GROUPS.find((g) => g.items.some((n) => n.to === seg))
  const nav = group?.items.find((n) => n.to === seg)
  if (nav) return { title: nav.label, section: group!.label }
  const acct = ACCOUNT_PAGES.find((n) => n.to === seg)
  return acct ? { title: acct.label, section: 'Account' } : { title: 'Not found', section: null }
}
