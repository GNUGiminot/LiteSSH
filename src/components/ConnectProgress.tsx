import { useEffect, useState } from 'react'
import {
  Check,
  KeyRound,
  LoaderCircle,
  Network,
  Server,
  ShieldCheck,
  SquareTerminal,
  X,
  type LucideIcon
} from 'lucide-react'
import type { ConnectStage } from '@shared/types'
import {
  useConnectProgress,
  STAGE_ORDER,
  STAGE_LABEL,
  type Attempt
} from '@/stores/useConnectProgress'

const SHORT_LABEL: Record<ConnectStage, string> = {
  connect: 'Соединение',
  hostkey: 'Ключ хоста',
  auth: 'Авторизация',
  shell: 'Терминал'
}

const STAGE_ICON: Record<ConnectStage, LucideIcon> = {
  connect: Network,
  hostkey: ShieldCheck,
  auth: KeyRound,
  shell: SquareTerminal
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} мс` : `${(ms / 1000).toFixed(1).replace('.', ',')} с`
}

/** Обновляет общий и активный таймеры десять раз в секунду. */
function useElapsed(a: Attempt): number {
  const [, tick] = useState(0)
  const running = a.outcome === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => tick((value) => value + 1), 100)
    return () => clearInterval(timer)
  }, [running])
  return (a.finishedAt ?? Date.now()) - a.startedAt
}

function TimelineStage({
  attempt,
  stage,
  now,
  first
}: {
  attempt: Attempt
  stage: ConnectStage
  now: number
  first: boolean
}) {
  const status = attempt.stages[stage]
  const done = status === 'done'
  const active = status === 'active'
  const error = status === 'error'
  const Icon = STAGE_ICON[stage]
  const mark = attempt.marks[stage]
  const elapsed = active && mark !== undefined ? now - mark : attempt.times[stage]

  return (
    <div className="relative min-w-0 flex-1 px-1 text-center">
      {!first && (
        <div
          className={`absolute -left-1/2 right-1/2 top-[13px] h-0.5 transition-colors ${
            done || active || error ? 'bg-accent/55' : 'bg-surface-3'
          }`}
        />
      )}
      <span
        className={`relative z-10 mx-auto flex h-7 w-7 items-center justify-center rounded-full ring-2 ring-surface-1 transition-colors ${
          done
            ? 'bg-emerald-500 text-white'
            : error
              ? 'bg-red-500 text-white'
              : active
                ? 'bg-accent text-white'
                : 'bg-surface-2 text-content-3'
        }`}
      >
        {done ? (
          <Check size={14} strokeWidth={2.7} />
        ) : error ? (
          <X size={14} strokeWidth={2.7} />
        ) : active ? (
          <LoaderCircle size={14} className="animate-spin" />
        ) : (
          <Icon size={13} />
        )}
      </span>
      <div
        className={`mt-2 truncate text-[11px] font-medium ${
          error ? 'text-red-400' : active ? 'text-accent' : done ? 'text-content-1' : 'text-content-3'
        }`}
      >
        {SHORT_LABEL[stage]}
      </div>
      <div className={`mt-0.5 font-mono text-[10px] tabular-nums ${active ? 'text-accent' : 'text-content-3'}`}>
        {elapsed !== undefined ? fmtMs(elapsed) : '—'}
      </div>
    </div>
  )
}

function Card({ attempt }: { attempt: Attempt }) {
  const dismiss = useConnectProgress((state) => state.dismiss)
  const elapsed = useElapsed(attempt)
  const now = attempt.startedAt + elapsed

  useEffect(() => {
    if (attempt.outcome === 'ok') {
      const timer = setTimeout(() => dismiss(attempt.id), 1800)
      return () => clearTimeout(timer)
    }
  }, [attempt.outcome, attempt.id, dismiss])

  const doneCount = STAGE_ORDER.filter((stage) => attempt.stages[stage] === 'done').length
  const inFlight = STAGE_ORDER.some((stage) => attempt.stages[stage] === 'active') ? 0.5 : 0
  const percent = attempt.outcome === 'ok' ? 100 : ((doneCount + inFlight) / STAGE_ORDER.length) * 100
  const activeStage = STAGE_ORDER.find((stage) => attempt.stages[stage] === 'active')
  const failedStage = STAGE_ORDER.find((stage) => attempt.stages[stage] === 'error')
  const currentStage = failedStage ?? activeStage
  const progressColor =
    attempt.outcome === 'ok' ? 'bg-emerald-400' : attempt.outcome === 'error' ? 'bg-red-400' : 'bg-accent'

  return (
    <div className="animate-in-fade pointer-events-auto w-[min(620px,calc(100vw-24px))] overflow-hidden rounded-xl border border-surface-3 bg-surface-1/97 shadow-2xl backdrop-blur">
      <div className="h-1 w-full bg-surface-2">
        <div
          className={`h-full transition-[width] duration-500 ease-out ${progressColor} ${
            attempt.outcome === 'running' ? 'connect-bar-live' : ''
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="px-5 pb-4 pt-4">
        <div className="mb-5 flex items-center gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1 ${
              attempt.outcome === 'ok'
                ? 'bg-emerald-500/15 text-emerald-400 ring-emerald-400/30'
                : attempt.outcome === 'error'
                  ? 'bg-red-500/15 text-red-400 ring-red-400/30'
                  : 'bg-accent/15 text-accent ring-accent/30'
            }`}
          >
            {attempt.outcome === 'ok' ? (
              <Check size={17} strokeWidth={2.6} />
            ) : attempt.outcome === 'error' ? (
              <X size={17} strokeWidth={2.6} />
            ) : (
              <Server size={16} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-content-1">
              {attempt.outcome === 'ok'
                ? `Подключено: ${attempt.title}`
                : attempt.outcome === 'error'
                  ? `Не удалось подключиться: ${attempt.title}`
                  : `Подключение к ${attempt.title}`}
            </div>
            {attempt.subtitle && (
              <div className="mt-0.5 truncate font-mono text-[11px] text-content-3">
                {attempt.subtitle}
              </div>
            )}
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-base font-medium tabular-nums text-content-1">
              {fmtMs(elapsed)}
            </div>
            <div className="text-[10px] text-content-3">общее время</div>
          </div>
          {attempt.outcome !== 'running' && (
            <button
              onClick={() => dismiss(attempt.id)}
              title="Закрыть"
              className="-mr-1 shrink-0 rounded p-1 text-content-3 hover:bg-surface-2 hover:text-content-1"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="flex px-1">
          {STAGE_ORDER.map((stage, index) => (
            <TimelineStage
              key={stage}
              attempt={attempt}
              stage={stage}
              now={now}
              first={index === 0}
            />
          ))}
        </div>

        <div
          className={`mt-4 flex min-h-9 items-center gap-2 rounded-lg px-3 py-2 text-[11px] leading-snug ${
            attempt.outcome === 'error'
              ? 'bg-red-500/10 text-red-400'
              : attempt.outcome === 'ok'
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-surface-2 text-content-2'
          }`}
        >
          {attempt.outcome === 'running' ? (
            <LoaderCircle size={14} className="shrink-0 animate-spin text-accent" />
          ) : attempt.outcome === 'ok' ? (
            <Check size={14} className="shrink-0" />
          ) : (
            <X size={14} className="shrink-0" />
          )}
          <span className="min-w-0 break-words">
            {attempt.outcome === 'error'
              ? attempt.error || `Ошибка на этапе «${currentStage ? STAGE_LABEL[currentStage] : 'подключение'}»`
              : attempt.outcome === 'ok'
                ? 'SSH-соединение установлено, терминал готов к работе.'
                : currentStage
                  ? `${STAGE_LABEL[currentStage]}…`
                  : 'Подготавливаю SSH-соединение…'}
          </span>
        </div>
      </div>
    </div>
  )
}

export function ConnectProgress() {
  const attempts = useConnectProgress((state) => state.attempts)
  if (!attempts.length) return null
  return (
    <div className="pointer-events-none fixed bottom-9 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {attempts.map((attempt) => (
        <Card key={attempt.id} attempt={attempt} />
      ))}
    </div>
  )
}
