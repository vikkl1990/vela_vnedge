import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }
const base = (size: number, props: P) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
})

export const IconActivity = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </svg>
)
export const IconScan = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />
  </svg>
)
export const IconChart = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M4 20V4M4 20h16" />
    <path d="M8 14l3-4 3 3 5-7" />
  </svg>
)
export const IconBell = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0" />
  </svg>
)
export const IconSettings = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
)
export const IconList = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
)
export const IconTrades = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M7 3v18M7 7H4M7 15H4M17 3v18M17 7h-3v8h3M10 7h4" />
  </svg>
)
export const IconLogs = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M4 5h16v14H4zM8 10l2 2-2 2M12 14h4" />
  </svg>
)
export const IconSun = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)
export const IconMoon = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
)
export const IconPlay = ({ size = 14, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M6 4l14 8-14 8z" />
  </svg>
)
export const IconExternal = ({ size = 12, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </svg>
)
export const IconGrid = ({ size = 14, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
  </svg>
)
export const IconRows = ({ size = 14, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M4 5h16M4 10h16M4 15h16M4 20h16" />
  </svg>
)
export const IconRefresh = ({ size = 14, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
  </svg>
)
export const IconX = ({ size = 14, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)
export const IconLogo = ({ size = 18, ...p }: P) => (
  <svg {...base(size, p)} strokeWidth={2.4}>
    <path d="M4 17L9 7l5 8 6-11" />
  </svg>
)

// ---- navigation icons (decision 169: one per section, so the sidebar reads at a glance) ----
export const IconBook = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" />
    <path d="M4 19a2 2 0 0 1 2-2h12" />
  </svg>
)
export const IconFlask = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M9 3h6M10 3v6L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9V3" />
    <path d="M7 15h10" />
  </svg>
)
export const IconTarget = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </svg>
)
export const IconBars = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M5 20V10M12 20V4M19 20v-7" />
  </svg>
)
export const IconCalendar = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
)
export const IconGraduation = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M2 9l10-5 10 5-10 5z" />
    <path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5" />
  </svg>
)
export const IconBookmark = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M6 3h12v18l-6-4-6 4z" />
  </svg>
)
export const IconShield = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
  </svg>
)
export const IconExchange = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </svg>
)
export const IconTerminal = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M5 7l5 5-5 5M12 17h7" />
  </svg>
)
export const IconUser = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </svg>
)
export const IconUsers = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4.5-6.2" />
  </svg>
)
export const IconCandles = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M7 4v3M7 17v3M17 4v4M17 16v4" />
    <rect x="4.5" y="7" width="5" height="10" rx="1" />
    <rect x="14.5" y="8" width="5" height="8" rx="1" />
  </svg>
)
export const IconMenu = ({ size = 18, ...p }: P) => (
  <svg {...base(size, p)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
)
export const IconPanelLeft = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
)
