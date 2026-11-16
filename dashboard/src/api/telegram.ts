export type TelegramStatus = {
  configured: boolean
  ready: boolean
  username: string | null
  savedAt: number | null
  binding: {
    chatId: string
    userId: string
    username: string | null
    name: string
    approvedAt: number
    verifiedAt: number | null
  } | null
  controlsEnabled: boolean
  ownerActive: boolean
  mode: string
  receiverRunning: boolean
  lastPollAt: number | null
  lastError: string | null
  pairing: {
    id: string
    expiresAt: number
    candidate: { chatId: string; userId: string; username: string | null; name: string } | null
  } | null
  recent: { at: number; command: string; status: string; result: string | null }[]
}
export type TelegramPairing = { url: string; expiresAt: number; status: TelegramStatus }
