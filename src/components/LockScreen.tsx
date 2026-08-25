import { useState } from 'react'
import { Lock, TerminalSquare } from 'lucide-react'
import { useVault } from '@/stores/useVault'
import { useToasts } from '@/stores/useToasts'

export function LockScreen() {
  const { locked, mode, setLocked } = useVault()
  const push = useToasts((s) => s.push)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  if (mode !== 'master' || !locked) return null

  const unlock = async () => {
    if (!password || busy) return
    setBusy(true)
    try {
      const res = await window.api.vault.unlock(password)
      if (res.ok) {
        setPassword('')
        setLocked(false)
      } else {
        push('error', res.error ?? 'Неверный пароль')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-surface-0">
      <div className="mb-6 flex items-center gap-2 text-content-2">
        <TerminalSquare size={22} className="text-accent" />
        <span className="text-lg font-semibold tracking-tight text-content-1">LiteSSH</span>
      </div>
      <div className="w-80 rounded-xl border border-surface-3 bg-surface-1 p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-2">
          <Lock size={16} className="text-accent" />
          <span className="text-sm font-semibold text-content-1">Хранилище заблокировано</span>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-content-3">
          Введите мастер-пароль, чтобы расшифровать сохранённые пароли и ключи.
        </p>
        <input
          autoFocus
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void unlock()
          }}
          placeholder="Мастер-пароль"
          className="w-full rounded-md border border-surface-3 bg-surface-0 px-2.5 py-1.5 text-sm text-content-1 outline-none focus:border-accent"
        />
        <button
          onClick={() => void unlock()}
          disabled={busy}
          className="mt-4 w-full rounded-md bg-accent py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Разблокировать
        </button>
      </div>
    </div>
  )
}
