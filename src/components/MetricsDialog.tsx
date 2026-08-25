import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Activity, X } from 'lucide-react'
import type { HostMetrics } from '@shared/types'

interface Props {
  open: boolean
  termId: string | null
  title: string
  onClose: () => void
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}д ${h}ч ${m}м` : h > 0 ? `${h}ч ${m}м` : `${m}м`
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 70) return 'bg-yellow-500'
  return 'bg-emerald-500'
}

function Gauge({ label, pct, sub }: { label: string; pct: number; sub?: string }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-content-2">{label}</span>
        <span className="text-sm font-semibold text-content-1">{Math.round(pct)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full transition-all duration-500 ${barColor(pct)}`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      {sub && <div className="mt-1 text-[10px] text-content-3">{sub}</div>}
    </div>
  )
}

export function MetricsDialog({ open, termId, title, onClose }: Props) {
  const [data, setData] = useState<HostMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!open || !termId) return
    let cancelled = false
    const poll = async () => {
      const res = await window.api.metrics.get(termId)
      if (cancelled) return
      if (res.ok && res.memTotal !== undefined) {
        setData(res as HostMetrics)
        setError(null)
      } else if (res.ok === false) {
        setError(res.error ?? 'Не удалось получить метрики')
      } else {
        setError('Хост не отдаёт метрики (нужен Linux с /proc)')
      }
      setLoading(false)
    }
    setLoading(true)
    setData(null)
    setError(null)
    void poll()
    timer.current = setInterval(poll, 2500)
    return () => {
      cancelled = true
      if (timer.current) clearInterval(timer.current)
    }
  }, [open, termId])

  if (!open) return null

  const memPct = data && data.memTotal ? (data.memUsed / data.memTotal) * 100 : 0
  const diskPct = data && data.diskTotal ? (data.diskUsed / data.diskTotal) * 100 : 0

  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-content-1">
              <Activity size={16} className="text-accent" /> Метрики хоста
              <span className="text-xs font-normal text-content-3">— {title}</span>
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
              <X size={15} />
            </Dialog.Close>
          </div>

          {error ? (
            <p className="py-6 text-center text-xs text-content-3">{error}</p>
          ) : !data ? (
            <p className="py-6 text-center text-xs text-content-3">
              {loading ? 'Сбор метрик…' : 'Нет данных'}
            </p>
          ) : (
            <div className="space-y-4">
              <Gauge label={`CPU (${data.cores} ядер)`} pct={data.cpu} sub={`load: ${data.load.join(' · ')}`} />
              <Gauge
                label="Память"
                pct={memPct}
                sub={`${humanSize(data.memUsed)} из ${humanSize(data.memTotal)}`}
              />
              <Gauge
                label="Диск /"
                pct={diskPct}
                sub={`${humanSize(data.diskUsed)} из ${humanSize(data.diskTotal)}`}
              />
              <div className="flex justify-between border-t border-surface-3 pt-3 text-[11px] text-content-3">
                <span>{data.hostname && `хост: ${data.hostname}`}</span>
                <span>аптайм: {fmtUptime(data.uptime)}</span>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
