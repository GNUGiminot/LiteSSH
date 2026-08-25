import type { LiteSSHApi } from '@shared/types'

declare global {
  interface Window {
    api: LiteSSHApi
  }
}

export {}
