import { useEffect, useState } from 'react'
import { Check, Server, X } from 'lucide-react'
import {
  useConnectProgress,
  STAGE_ORDER,
  STAGE_LABEL,
  type Attempt
} from '@/stores/useConnectProgress'

/** 842 → «842 мс», 1530 → «1,5 с» */
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1).replace('.', ',')} с`
}

/** Тикающий счётчик времени подключения; замирает на finishedAt. */
function useElapsed(a: Attempt): number {
  const [, tick] = useState(0)
  const running = a.outcome === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick((n) => n + 1), 100)
    return () => clearInterval(t)
  }, [running])
  return (a.finishedAt ?? Date.now()) - a.startedAt
}

function StageRow({
  status,
  label,
  ms,
  last
}: {
  status: string
  label: string
  ms?: number
  last: boolean
}) {
  const done = status === 'done'
  const active = status === 'active'
  const error = status === 'error'

  const dot = done ? (
    <Check size={11} strokeWidth={3} className="text-emerald-400" />
  ) : error ? (
    <X size={11} strokeWidth={3} className="text-red-400" />
  ) : active ? (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
    </span>
  ) : (
    <span className="h-1.5 w-1.5 rounded-full bg-surface-3" />
  )

  return (
    <div className="flex h-6 items-center gap-2">
      {/* иконка + отрезок «рельса» до следующей стадии */}
      <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {dot}
        {!last && (
          <span
            className={`absolute left-1/2 top-full h-[10px] w-px -translate-x-1/2 transition-colors duration-300 ${
              done ? 'bg-emerald-400/40' : 'bg-surface-3'
            }`}
          />
        )}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[11px] transition-colors ${
          active
            ? 'text-content-1'
            : error
              ? 'text-red-400'
              : done
                ? 'text-content-2'
                : 'text-content-3'
        }`}
      >
        {label}
      </span>
      {ms !== undefined && !active && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-content-3">
          {fmtMs(ms)}
        </span>
      )}
    </div>
  )
}

function Card({ a }: { a: Attempt }) {
  const dismiss = useConnectProgress((s) => s.dismiss)
  const elapsed = useElapsed(a)

  // Успешную карточку убираем сами через 1.4с; ошибку оставляем до клика
  useEffect(() => {
    if (a.outcome === 'ok') {
      const t = setTimeout(() => dismiss(a.id), 1400)
      return () => clearTimeout(t)
    }
  }, [a.outcome, a.id, dismiss])

  // Текущая (ещё не завершённая) стадия считается за половину — иначе на первой
  // стадии полоса стояла бы на нуле всё время ожидания TCP-соединения.
  const doneCount = STAGE_ORDER.filter((s) => a.stages[s] === 'done').length
  const inFlight = STAGE_ORDER.some((s) => a.stages[s] === 'active') ? 0.5 : 0
  const pct =
    a.outcome === 'ok' ? 100 : ((doneCount + inFlight) / STAGE_ORDER.length) * 100
  const barColor =
    a.outcome === 'ok' ? 'bg-emerald-400' : a.outcome === 'error' ? 'bg-red-400' : 'bg-accent'

  const headIcon =
    a.outcome === 'ok' ? (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/30">
        <Check size={13} strokeWidth={2.5} className="text-emerald-400" />
      </span>
    ) : a.outcome === 'error' ? (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-500/15 ring-1 ring-red-400/30">
        <X size={13} strokeWidth={2.5} className="text-red-400" />
      </span>
    ) : (
      <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 ring-1 ring-accent/30">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/20" />
        <Server size={12} className="relative text-accent" />
      </span>
    )

  return (
    <div className="animate-in-fade pointer-events-auto w-[278px] overflow-hidden rounded-xl border border-surface-3 bg-surface-1/95 shadow-2xl backdrop-blur">
      {/* полоса прогресса по стадиям */}
      <div className="h-[3px] w-full bg-surface-2">
        <div
          className={`h-full transition-[width] duration-500 ease-out ${barColor} ${
            a.outcome === 'running' ? 'connect-bar-live' : ''
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="p-3">
        <div className="mb-2.5 flex items-center gap-2.5">
          {headIcon}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium leading-tight text-content-1">
              {a.title}
            </div>
            {a.subtitle && (
              <div className="truncate font-mono text-[10px] leading-tight text-content-3">
                {a.subtitle}
              </div>
            )}
          </div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-content-3">
            {fmtMs(elapsed)}
          </span>
          {a.outcome !== 'running' && (
            <button
              onClick={() => dismiss(a.id)}
              className="-mr-1 shrink-0 rounded p-0.5 text-content-3 hover:bg-surface-2 hover:text-content-1"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="pl-0.5">
          {STAGE_ORDER.map((s, i) => (
            <StageRow
              key={s}
              status={a.stages[s]}
              label={STAGE_LABEL[s]}
              ms={a.times[s]}
              last={i === STAGE_ORDER.length - 1}
            />
          ))}
        </div>

        {a.outcome === 'error' && a.error && (
          <p className="mt-2 break-words rounded-md bg-red-500/10 px-2 py-1.5 text-[10px] leading-snug text-red-400">
            {a.error}
          </p>
        )}
      </div>
    </div>
  )
}

export function ConnectProgress() {
  const attempts = useConnectProgress((s) => s.attempts)
  if (!attempts.length) return null
  return (
    <div className="pointer-events-none fixed bottom-9 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {attempts.map((a) => (
        <Card key={a.id} a={a} />
      ))}
    </div>
  )
}
