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
      const previousStatus = s.items[info.id]?.status
      const wasPending = previousStatus === 'active' || previousStatus === 'queued'
      const finished = info.status !== 'active' && info.status !== 'queued'
      return {
        items: { ...s.items, [info.id]: info },
        // Сохраняем порядок добавления: он совпадает с порядком выполнения очереди.
        order: isNew ? [...s.order, info.id].slice(-50) : s.order,
        completedTick: !isNew && wasPending && finished ? s.completedTick + 1 : s.completedTick
      }
    }),
  clearFinished: () =>
    set((s) => {
      const items: Record<string, TransferInfo> = {}
      const order = s.order.filter((id) => {
        const status = s.items[id]?.status
        const keep = status === 'active' || status === 'queued'
        if (keep) items[id] = s.items[id]
        return keep
      })
      return { items, order }
    })
}))
