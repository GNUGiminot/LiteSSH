import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ShieldAlert, ShieldQuestion } from 'lucide-react'
import type { HostKeyPrompt } from '@shared/types'

export function HostKeyDialog() {
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null)

  useEffect(() => window.api.hostkey.onPrompt(setPrompt), [])

  const respond = (accept: boolean) => {
    if (!prompt) return
    window.api.hostkey.respond(prompt.requestId, accept)
    setPrompt(null)
  }

  if (!prompt) return null

  return (
    <Dialog.Root open onOpenChange={(v) => !v && respond(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <div className="mb-3 flex items-center gap-2.5">
            {prompt.changed ? (
              <ShieldAlert size={22} className="text-red-500" />
            ) : (
              <ShieldQuestion size={22} className="text-yellow-500" />
            )}
            <Dialog.Title className="text-sm font-semibold text-content-1">
              {prompt.changed ? 'ключ сервера ИЗМЕНИЛСЯ!' : 'Неизвестный сервер'}
            </Dialog.Title>
          </div>

          {prompt.changed ? (
            <p className="mb-3 text-xs leading-relaxed text-red-400">
              Отпечаток ключа сервера {prompt.host}:{prompt.port} не совпадает с сохранённым.
              Это может означать атаку «человек посередине» (MITM) — либо сервер был переустановлен.
              Продолжайте, только если уверены в причине смены ключа.
            </p>
          ) : (
            <p className="mb-3 text-xs leading-relaxed text-content-2">
              Первое подключение к {prompt.host}:{prompt.port}. Проверьте отпечаток ключа сервера,
              прежде чем доверять ему.
            </p>
          )}

          <div className="mb-4 rounded-md bg-surface-0 p-3 font-mono text-[11px]">
            <div className="text-content-3">{prompt.keyType}</div>
            <div className="break-all text-content-1">{prompt.fingerprint}</div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={() => respond(false)}
              className="rounded-md px-3 py-1.5 text-xs text-content-2 hover:bg-surface-2"
            >
              Отклонить
            </button>
            <button
              onClick={() => respond(true)}
              className={`rounded-md px-4 py-1.5 text-xs font-medium text-white ${
                prompt.changed ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent-hover'
              }`}
            >
              {prompt.changed ? 'Всё равно доверять' : 'Доверять и подключиться'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
