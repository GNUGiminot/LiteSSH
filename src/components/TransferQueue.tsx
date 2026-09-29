import { ArrowDown, ArrowUp, FolderOpen, RotateCw, Trash2, X } from 'lucide-react'
import { useTransfers } from '@/stores/useTransfers'

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function TransferQueue() {
  const { items, order, clearFinished } = useTransfers()
  const pending = order.filter((id) => items[id]?.status === 'active' || items[id]?.status === 'queued')
  const finished = [...order]
    .reverse()
    .filter((id) => items[id]?.status !== 'active' && items[id]?.status !== 'queued')
  const visible = [...pending, ...finished].slice(0, 8)
  if (!visible.length) return null

  return (
    <div className="max-h-40 shrink-0 overflow-y-auto border-t border-surface-3 bg-surface-1">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-content-3">
          Передачи
        </span>
        <button
          onClick={clearFinished}
          title="Очистить завершённые"
          className="rounded p-0.5 text-content-3 hover:bg-surface-2 hover:text-content-1"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {visible.map((id) => {
        const t = items[id]
        if (!t) return null
        const pct = t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0
        const elapsed = t.startedAt ? Math.max(0.001, (Date.now() - t.startedAt) / 1000) : 0
        const speed = elapsed > 0 && t.done > 0 ? t.done / elapsed : 0
        return (
          <div key={id} className="flex items-center gap-2 px-2 py-1">
            {t.direction === 'upload' ? (
              <ArrowUp size={12} className="shrink-0 text-accent" />
            ) : (
              <ArrowDown size={12} className="shrink-0 text-emerald-400" />
            )}
            <span
              className="w-48 truncate text-[11px] text-content-1"
              title={t.localPath ? `${t.name}\nСохраняется в: ${t.localPath}` : t.name}
            >
              {t.currentFile ? `${t.name} · ${t.currentFile}` : t.name}
            </span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full transition-all ${
                  t.status === 'error'
                    ? 'bg-red-500'
                    : t.status === 'cancelled'
                      ? 'bg-yellow-500'
                      : t.status === 'done'
                        ? 'bg-emerald-500'
                        : 'bg-accent'
                }`}
                style={{ width: `${t.status === 'done' ? 100 : pct}%` }}
              />
            </div>
            <span className="w-28 shrink-0 text-right text-[10px] text-content-3">
              {t.status === 'error'
                ? 'ошибка'
                : t.status === 'cancelled'
                  ? 'отменено'
                  : t.status === 'queued'
                    ? 'в очереди'
                  : t.phase === 'scanning'
                    ? 'сканирование…'
                  : t.phase === 'preparing'
                    ? 'создание папок…'
                  : t.status === 'done'
                    ? humanSize(t.total)
                    : `${humanSize(t.done)} / ${humanSize(t.total)}${speed ? ` · ${humanSize(speed)}/s` : ''}${t.totalFiles ? ` · ${t.fileIndex ?? 0}/${t.totalFiles}` : ''}`}
            </span>
            {t.status === 'active' && (
              <button
                onClick={() => window.api.transfer.cancel(id)}
                title="Отменить"
                className="rounded p-0.5 text-content-3 hover:bg-surface-2 hover:text-red-400"
              >
                <X size={11} />
              </button>
            )}
            {t.status === 'queued' && (
              <button
                onClick={() => window.api.transfer.cancel(id)}
                title="Убрать из очереди"
                className="rounded p-0.5 text-content-3 hover:bg-surface-2 hover:text-red-400"
              >
                <X size={11} />
              </button>
            )}
            {t.direction === 'download' && t.status === 'done' && t.localPath && (
              <button
                onClick={() => window.api.fs.reveal(t.localPath!)}
                title={`Открыть расположение: ${t.localPath}`}
                className="rounded p-0.5 text-content-3 hover:bg-surface-2 hover:text-accent"
              >
                <FolderOpen size={11} />
              </button>
            )}
            {t.canResume && (
              <button
                onClick={() => void window.api.transfer.resume(id)}
                title="Возобновить (докачать)"
                className="rounded p-0.5 text-content-3 hover:bg-surface-2 hover:text-accent"
              >
                <RotateCw size={11} />
              </button>
            )}
            {t.status === 'error' && t.error && (
              <span className="max-w-32 truncate text-[10px] text-red-400" title={t.error}>
                {t.error}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
