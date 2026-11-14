import type { ReactElement } from 'react'
import {
  IconActivity, IconBars, IconBell, IconBook, IconBookmark, IconCalendar, IconCandles, IconExchange, IconFlask, IconGraduation,
  IconGrid, IconScan, IconSettings, IconShield, IconTarget, IconTerminal, IconTrades,
} from '../Icons'
import { GROUPS as MODEL, type NavGroup as ModelGroup, type NavItem as ModelItem } from './navModel'

export { ACCOUNT_PAGES, PHONE_TABS, routeMeta, visibleGroups as visibleModel } from './navModel'
export type { RouteMeta } from './navModel'

export type NavItem = ModelItem & { icon: (p: { size?: number }) => ReactElement }
export type NavGroup = Omit<ModelGroup, 'items'> & { items: NavItem[] }

const ICONS: Record<string, NavItem['icon']> = {
  '/': IconActivity, '/decisions': IconBookmark, '/signals': IconBell, '/radar': IconGrid, '/monitor': IconActivity, '/trades': IconTrades, '/chart': IconCandles,
  '/scanners': IconScan, '/library': IconBook, '/incubator': IconFlask, '/trackers': IconTarget, '/analytics': IconBars, '/daily': IconCalendar, '/learn': IconGraduation,
  '/gates': IconShield, '/exchange': IconExchange, '/settings': IconSettings, '/logs': IconTerminal,
}

/** The sidebar's groups: the model plus an icon per page. */
export const GROUPS: NavGroup[] = MODEL.map((g) => ({ ...g, items: g.items.map((n) => ({ ...n, icon: ICONS[n.to] ?? IconActivity })) }))

export function visibleGroups(isAdmin: boolean): NavGroup[] {
  return GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => !n.adminOnly || isAdmin) }))
}
