import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useToasts } from '@/stores/useToasts'

const ICONS = {
  error: <AlertCircle size={15} className="text-red-400" />,
  success: <CheckCircle2 size={15} className="text-emerald-400" />,
  info: <Info size={15} className="text-accent" />
}

export function Toasts() {
  const { toasts, dismiss } = useToasts()
  if (!toasts.length) return null

  return (
    <div className="pointer-events-none fixed bottom-9 right-3 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="animate-in-fade pointer-events-auto flex items-start gap-2 rounded-lg border border-surface-3 bg-surface-1 px-3 py-2.5 shadow-xl"
        >
          {ICONS[t.kind]}
          <p className="flex-1 break-words text-xs leading-relaxed text-content-1">{t.text}</p>
          <button
            onClick={() => dismiss(t.id)}
            className="rounded p-0.5 text-content-3 hover:bg-surface-2 hover:text-content-1"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
