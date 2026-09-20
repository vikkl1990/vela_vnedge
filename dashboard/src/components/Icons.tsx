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
