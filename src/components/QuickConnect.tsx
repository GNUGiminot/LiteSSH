import { useState } from 'react'
import { Zap } from 'lucide-react'
import { quickConnect } from '@/lib/connect'

export function QuickConnect() {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    try {
      await quickConnect(value)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-md flex-1 items-center gap-2 rounded-md border border-surface-3 bg-surface-0 px-2.5 py-1.5 focus-within:border-accent">
      <Zap size={14} className={busy ? 'animate-pulse text-accent' : 'text-content-3'} />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void go()
        }}
        placeholder="Быстрое подключение: user@host:port"
        spellCheck={false}
        className="w-full bg-transparent text-xs text-content-1 outline-none placeholder:text-content-3"
      />
    </div>
  )
}
