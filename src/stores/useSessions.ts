import { create } from 'zustand'
import type { SessionProfile } from '@shared/types'

interface SessionsState {
  sessions: SessionProfile[]
  load: () => Promise<void>
  save: (profile: SessionProfile) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useSessions = create<SessionsState>((set) => ({
  sessions: [],
  load: async () => {
    set({ sessions: await window.api.sessions.list() })
  },
  save: async (profile) => {
    await window.api.sessions.save(profile)
    set({ sessions: await window.api.sessions.list() })
  },
  remove: async (id) => {
    await window.api.sessions.remove(id)
    set({ sessions: await window.api.sessions.list() })
  }
}))
