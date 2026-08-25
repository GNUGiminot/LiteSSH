import { create } from 'zustand'

export interface MenuItem {
  label: string
  danger?: boolean
  action: () => void
}

interface ContextMenuState {
  x: number
  y: number
  items: MenuItem[] | null
  show: (x: number, y: number, items: MenuItem[]) => void
  hide: () => void
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  x: 0,
  y: 0,
  items: null,
  show: (x, y, items) => set({ x, y, items }),
  hide: () => set({ items: null })
}))
