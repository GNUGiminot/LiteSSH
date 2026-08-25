import { create } from 'zustand'

export interface Toast {
  id: number
  kind: 'error' | 'info' | 'success'
  text: string
}

interface ToastsState {
  toasts: Toast[]
  push: (kind: Toast['kind'], text: string) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastsState>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
