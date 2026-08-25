import { useEffect, useState } from 'react'
import { ChevronDown, MonitorPlay } from 'lucide-react'
import { openLocalTerminal } from '@/lib/connect'

export function LocalShellMenu() {
  const [shells, setShells] = useState<{ label: string; cmd: string }[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void window.api.pty.shells().then(setShells)
  }, [])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  return (
    <div className="relative">
      <button
        title="Локальный терминал"
        onClick={(e) => {
          e.stopPropagation()
          if (shells.length === 1) void openLocalTerminal(shells[0].cmd)
          else setOpen((v) => !v)
        }}
        className="flex items-center gap-0.5 rounded-md p-1.5 text-content-2 transition-colors hover:bg-surface-2 hover:text-content-1"
      >
        <MonitorPlay size={16} />
        {shells.length > 1 && <ChevronDown size={11} />}
      </button>
      {open && shells.length > 1 && (
        <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-surface-3 bg-surface-1 py-1 shadow-2xl">
          {shells.map((s) => (
            <button
              key={s.cmd}
              onClick={() => {
                setOpen(false)
                void openLocalTerminal(s.cmd)
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-content-1 hover:bg-surface-2"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
