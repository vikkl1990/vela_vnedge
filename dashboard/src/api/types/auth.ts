// ---- authentication ----

/** `viewer` is backtest only, `trader` adds trading, `admin` adds user management. */
export type Role = 'admin' | 'trader' | 'viewer' | 'guest'
/** Decision 117: a read-only, expiring, revocable way into the dashboard for someone without an account. */
export interface ShareLink {
  id: number
  label: string
  userId: number
  createdBy: number | null
  createdAt: number
  expiresAt: number
  revokedAt: number | null
  uses: number
  lastUsedAt: number | null
}
export type Permission = 'read' | 'backtest' | 'trade' | 'admin'
export interface RoleOption {
  role: Role
  label: string
}

export interface Me {
  id: number
  username: string
  displayName: string
  role: Role
  roleLabel: string
  createdAt: number
  lastLoginAt: number | null
  disabled: boolean
}

export interface Session {
  user: Me
  permissions: Permission[]
  sessions: number
}

export interface AuthStatus {
  /** False on a brand new instance: the first administrator has not been created yet. */
  configured: boolean
  /** Only true when the browser is on the server itself, which is where first-run setup is allowed. */
  canSetup: boolean
  roles: RoleOption[]
}
