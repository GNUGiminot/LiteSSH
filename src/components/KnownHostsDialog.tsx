import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ShieldCheck, Trash2, X } from 'lucide-react'
import { useToasts } from '@/stores/useToasts'
import { confirmAsync } from '@/stores/useConfirm'
import type { KnownHost } from '@shared/types'

interface Props {
  open: boolean
  onClose: () => void
}

export function KnownHostsDialog({ open, onClose }: Props) {
  const push = useToasts((s) => s.push)
  const [hosts, setHosts] = useState<KnownHost[]>([])

  const reload = async () => setHosts(await window.api.knownHosts.list())

  useEffect(() => {
    if (open) void reload()
  }, [open])

  const remove = async (h: KnownHost) => {
    const yes = await confirmAsync(
      `Удалить ключ сервера ${h.host}:${h.port} (${h.keyType})?\nПри следующем подключении отпечаток нужно будет подтвердить заново.`
    )
    if (!yes) return
    await window.api.knownHosts.remove(h.host, h.port, h.keyType)
    push('success', 'Ключ сервера удалён')
    await reload()
  }

  if (!open) return null

  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <div className="mb-1 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-content-1">
              <ShieldCheck size={16} className="text-accent" /> Ключи серверов (known_hosts)
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
              <X size={15} />
            </Dialog.Close>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-content-3">
            Сохранённые отпечатки серверов. Удалите запись, если сервер был переустановлен и его
            ключ законно изменился — тогда при следующем подключении вы подтвердите новый отпечаток.
          </p>

          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-surface-3">
            {hosts.length === 0 && (
              <p className="px-3 py-4 text-xs text-content-3">
                Пока нет сохранённых ключей серверов. Они появляются при первом подключении.
              </p>
            )}
            {hosts.map((h) => (
              <div
                key={`${h.host}:${h.port}:${h.keyType}`}
                className="flex items-center gap-2 border-b border-surface-3 px-3 py-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-content-1">
                    {h.host}
                    <span className="text-content-3">:{h.port}</span>{' '}
                    <span className="text-content-3">· {h.keyType}</span>
                  </div>
                  <div className="truncate font-mono text-[10px] text-content-3" title={h.fingerprint}>
                    {h.fingerprint}
                  </div>
                </div>
                <button
                  onClick={() => void remove(h)}
                  title="Удалить (сбросить доверие)"
                  className="rounded p-1 text-content-2 hover:bg-surface-2 hover:text-red-400"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
