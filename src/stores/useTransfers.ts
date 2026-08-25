import { create } from 'zustand'
import type { TransferInfo } from '@shared/types'

interface TransfersState {
  items: Record<string, TransferInfo>
  order: string[]
  /** Увеличивается при каждом завершении — триггер для обновления панелей. */
  completedTick: number
  update: (info: TransferInfo) => void
  clearFinished: () => void
}

export const useTransfers = create<TransfersState>((set) => ({
  items: {},
  order: [],
  completedTick: 0,
  update: (info) =>
    set((s) => {
      const isNew = !s.items[info.id]
      const wasActive = s.items[info.id]?.status === 'active'
      const finished = info.status !== 'active'
      return {
        items: { ...s.items, [info.id]: info },
        order: isNew ? [info.id, ...s.order].slice(0, 50) : s.order,
        completedTick: (isNew || wasActive) && finished ? s.completedTick + 1 : s.completedTick
      }
    }),
  clearFinished: () =>
    set((s) => {
      const items: Record<string, TransferInfo> = {}
      const order = s.order.filter((id) => {
        const keep = s.items[id]?.status === 'active'
        if (keep) items[id] = s.items[id]
        return keep
      })
      return { items, order }
    })
}))
