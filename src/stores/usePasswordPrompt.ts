import { create } from 'zustand'

interface PasswordPromptState {
  open: boolean
  label: string
  _resolve: ((value: string | null) => void) | null
  ask: (label: string) => Promise<string | null>
  submit: (value: string) => void
  cancel: () => void
}

export const usePasswordPrompt = create<PasswordPromptState>((set, get) => ({
  open: false,
  label: '',
  _resolve: null,
  ask: (label) =>
    new Promise<string | null>((resolve) => {
      get()._resolve?.(null)
      set({ open: true, label, _resolve: resolve })
    }),
  submit: (value) => {
    get()._resolve?.(value)
    set({ open: false, _resolve: null })
  },
  cancel: () => {
    get()._resolve?.(null)
    set({ open: false, _resolve: null })
  }
}))
