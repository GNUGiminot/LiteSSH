import { create } from 'zustand'
import type { ConnectStage, StageStatus } from '@shared/types'

export const STAGE_ORDER: ConnectStage[] = ['connect', 'hostkey', 'auth', 'shell']
export const STAGE_LABEL: Record<ConnectStage, string> = {
  connect: 'Установка соединения',
  hostkey: 'Проверка ключа хоста',
  auth: 'Аутентификация',
  shell: 'Открытие терминала'
}

export interface Attempt {
  id: string
  title: string
  /** user@host:port — показывается под названием, если отличается от него */
  subtitle?: string
  stages: Record<ConnectStage, StageStatus | 'pending'>
  /** Длительность завершённых стадий, мс */
  times: Partial<Record<ConnectStage, number>>
  /** Момент перехода стадии в 'active' — для расчёта длительности */
  marks: Partial<Record<ConnectStage, number>>
  startedAt: number
  finishedAt?: number
  outcome: 'running' | 'ok' | 'error'
  error?: string
}

interface ProgressState {
  attempts: Attempt[]
  start: (id: string, title: string, subtitle?: string) => void
  setStage: (id: string, stage: ConnectStage, status: StageStatus, error?: string) => void
  finish: (id: string, ok: boolean, error?: string) => void
  dismiss: (id: string) => void
}

const emptyStages = (): Attempt['stages'] => ({
  connect: 'pending',
  hostkey: 'pending',
  auth: 'pending',
  shell: 'pending'
})

export const useConnectProgress = create<ProgressState>((set) => ({
  attempts: [],
  start: (id, title, subtitle) =>
    set((s) => ({
      attempts: [
        ...s.attempts.filter((a) => a.id !== id),
        {
          id,
          title,
          subtitle,
          stages: emptyStages(),
          times: {},
          marks: {},
          startedAt: Date.now(),
          outcome: 'running'
        }
      ]
    })),
  setStage: (id, stage, status, error) =>
    set((s) => ({
      attempts: s.attempts.map((a) => {
        if (a.id !== id) return a
        const now = Date.now()
        const marks = status === 'active' ? { ...a.marks, [stage]: now } : a.marks
        const mark = a.marks[stage]
        const times =
          status !== 'active' && mark !== undefined ? { ...a.times, [stage]: now - mark } : a.times
        return { ...a, stages: { ...a.stages, [stage]: status }, marks, times, error: error ?? a.error }
      })
    })),
  finish: (id, ok, error) =>
    set((s) => ({
      attempts: s.attempts.map((a) =>
        a.id === id
          ? { ...a, outcome: ok ? 'ok' : 'error', finishedAt: Date.now(), error: error ?? a.error }
          : a
      )
    })),
  dismiss: (id) => set((s) => ({ attempts: s.attempts.filter((a) => a.id !== id) }))
}))
