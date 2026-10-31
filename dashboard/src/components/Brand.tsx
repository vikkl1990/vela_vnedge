import { useTheme } from '../lib/theme'

/** The supplied VN EDGE symbol, reconstructed as resolution-independent artwork. */
export function BrandMark({ className = '', white = false }: { className?: string; white?: boolean }) {
  return <img className={`brand-mark ${className}`} src={`/brand/mark${white ? '-white' : ''}.svg`} alt="" aria-hidden="true" width="40" height="30" />
}

export function BrandLockup({ tagline = false, className = '' }: { tagline?: boolean; className?: string }) {
  const { theme } = useTheme()
  return <div className={`brand-lockup ${className}`}>
    <img className="brand-logo" src={`/brand/logo-${theme === 'dark' ? 'white' : 'blue'}.svg`} alt="VN EDGE" width="332" height="226" />
    {tagline && <p className="brand-tagline">Trade with precision</p>}
  </div>
}
