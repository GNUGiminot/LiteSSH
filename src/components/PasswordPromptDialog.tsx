import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { KeyRound } from 'lucide-react'
import { usePasswordPrompt } from '@/stores/usePasswordPrompt'

export function PasswordPromptDialog() {
  const { open, label, submit, cancel } = usePasswordPrompt()
  const [value, setValue] = useState('')

  useEffect(() => {
    if (open) setValue('')
  }, [open])

  if (!open) return null

  return (
    <Dialog.Root open onOpenChange={(v) => !v && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <div className="mb-3 flex items-center gap-2">
            <KeyRound size={17} className="text-accent" />
            <Dialog.Title className="text-sm font-semibold text-content-1">{label}</Dialog.Title>
          </div>
          <input
            autoFocus
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit(value)
              if (e.key === 'Escape') cancel()
            }}
            className="w-full rounded-md border border-surface-3 bg-surface-0 px-2.5 py-1.5 text-xs text-content-1 outline-none focus:border-accent"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={cancel}
              className="rounded-md px-3 py-1.5 text-xs text-content-2 hover:bg-surface-2"
            >
              Отмена
            </button>
            <button
              onClick={() => submit(value)}
              className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            >
              Подключиться
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
