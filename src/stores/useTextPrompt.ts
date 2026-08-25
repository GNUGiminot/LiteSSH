import { create } from 'zustand'

interface TextPromptState {
  open: boolean
  title: string
  placeholder: string
  initial: string
  _resolve: ((value: string | null) => void) | null
  ask: (title: string, opts?: { placeholder?: string; initial?: string }) => Promise<string | null>
  submit: (value: string) => void
  cancel: () => void
}

export const useTextPrompt = create<TextPromptState>((set, get) => ({
  open: false,
  title: '',
  placeholder: '',
  initial: '',
  _resolve: null,
  ask: (title, opts) =>
    new Promise<string | null>((resolve) => {
      get()._resolve?.(null)
      set({
        open: true,
        title,
        placeholder: opts?.placeholder ?? '',
        initial: opts?.initial ?? '',
        _resolve: resolve
      })
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
