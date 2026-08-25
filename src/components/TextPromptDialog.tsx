import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useTextPrompt } from '@/stores/useTextPrompt'

export function TextPromptDialog() {
  const { open, title, placeholder, initial, submit, cancel } = useTextPrompt()
  const [value, setValue] = useState('')

  useEffect(() => {
    if (open) setValue(initial)
  }, [open, initial])

  if (!open) return null

  return (
    <Dialog.Root open onOpenChange={(v) => !v && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <Dialog.Title className="mb-3 text-sm font-semibold text-content-1">{title}</Dialog.Title>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit(value)
              if (e.key === 'Escape') cancel()
            }}
            placeholder={placeholder}
            spellCheck={false}
            className="w-full rounded-md border border-surface-3 bg-surface-0 px-2.5 py-1.5 text-xs text-content-1 outline-none focus:border-accent placeholder:text-content-3"
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
              ОК
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
