import { create } from 'zustand'

interface PreviewState {
  open: boolean
  termId: string
  path: string
  name: string
  show: (termId: string, path: string, name: string) => void
  close: () => void
}

export const usePreview = create<PreviewState>((set) => ({
  open: false,
  termId: '',
  path: '',
  name: '',
  show: (termId, path, name) => set({ open: true, termId, path, name }),
  close: () => set({ open: false })
}))
