import { create } from 'zustand'

interface VaultState {
  mode: 'keychain' | 'master'
  locked: boolean
  refresh: () => Promise<void>
  setLocked: (v: boolean) => void
}

export const useVault = create<VaultState>((set) => ({
  mode: 'keychain',
  locked: false,
  refresh: async () => {
    const s = await window.api.vault.state()
    set({ mode: s.mode, locked: s.locked })
  },
  setLocked: (locked) => set({ locked })
}))
