import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Copy,
  FileDown,
  FileUp,
  KeyRound,
  Send,
  Trash2,
  X
} from 'lucide-react'
import { useToasts } from '@/stores/useToasts'
import { useSessions } from '@/stores/useSessions'
import { usePasswordPrompt } from '@/stores/usePasswordPrompt'
import { confirmAsync } from '@/stores/useConfirm'
import type { KeyInfo } from '@shared/types'

interface Props {
  open: boolean
  onClose: () => void
}

export function KeysDialog({ open, onClose }: Props) {
  const push = useToasts((s) => s.push)
  const sessions = useSessions((s) => s.sessions)
  const [keys, setKeys] = useState<KeyInfo[]>([])
  const [genName, setGenName] = useState('')
  const [genAlgo, setGenAlgo] = useState('ed25519')
  const [busy, setBusy] = useState(false)
  const [deployFor, setDeployFor] = useState<string | null>(null)
  const [deploySession, setDeploySession] = useState('')

  const reload = async () => setKeys(await window.api.keys.list())

  useEffect(() => {
    if (open) void reload()
  }, [open])

  const generate = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await window.api.keys.generate({
        name: genName.trim() || `litessh-${genAlgo}`,
        algo: genAlgo
      })
      if (res.ok) {
        push('success', 'Ключ сгенерирован')
        setGenName('')
        await reload()
      } else push('error', res.error ?? 'Ошибка генерации')
    } finally {
      setBusy(false)
    }
  }

  const importKey = async () => {
    const path = await window.api.dialog.pickKeyFile()
    if (!path) return
    let res = await window.api.keys.importKey(path)
    if (!res.ok && res.error === 'NEED_PASSPHRASE') {
      const pass = await usePasswordPrompt.getState().ask('Passphrase ключа')
      if (pass === null) return
      res = await window.api.keys.importKey(path, pass)
    }
    if (res.ok) {
      push('success', 'Ключ импортирован')
      await reload()
    } else if (res.error) {
      push('error', res.error === 'NEED_PASSPHRASE' ? 'Неверная passphrase' : res.error)
    }
  }

  const copyPublic = (k: KeyInfo) => {
    void navigator.clipboard.writeText(k.publicKey)
    push('success', 'Публичный ключ скопирован в буфер')
  }

  const exportPrivate = async (k: KeyInfo) => {
    const res = await window.api.keys.exportPrivate(k.id)
    if (res.ok) push('success', 'Приватный ключ сохранён в файл')
    else if (res.error) push('error', res.error)
  }

  const deploy = async (k: KeyInfo) => {
    if (!deploySession) return push('info', 'Выберите сессию')
    setBusy(true)
    try {
      const res = await window.api.keys.deploy(k.id, deploySession)
      if (res.ok) {
        push('success', `Ключ добавлен в authorized_keys`)
        setDeployFor(null)
      } else push('error', res.error ?? 'Ошибка деплоя')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (k: KeyInfo) => {
    if (!(await confirmAsync(`Удалить ключ «${k.name}»? Приватный ключ будет потерян безвозвратно.`)))
      return
    await window.api.keys.remove(k.id)
    await reload()
  }

  const field =
    'rounded-md border border-surface-3 bg-surface-0 px-2.5 py-1.5 text-xs text-content-1 outline-none focus:border-accent placeholder:text-content-3'
  const iconBtn = 'rounded p-1 text-content-2 transition-colors hover:bg-surface-2 hover:text-content-1'

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-content-1">
              <KeyRound size={16} className="text-accent" /> SSH-ключи
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
              <X size={15} />
            </Dialog.Close>
          </div>

          <div className="mb-4 flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-[11px] font-medium text-content-2">Имя ключа</label>
              <input
                className={`${field} w-full`}
                value={genName}
                onChange={(e) => setGenName(e.target.value)}
                placeholder="work-laptop"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-content-2">Алгоритм</label>
              <select className={field} value={genAlgo} onChange={(e) => setGenAlgo(e.target.value)}>
                <option value="ed25519">Ed25519 (рекомендуется)</option>
                <option value="rsa4096">RSA 4096</option>
                <option value="rsa2048">RSA 2048</option>
                <option value="ecdsa">ECDSA P-256</option>
              </select>
            </div>
            <button
              onClick={() => void generate()}
              disabled={busy}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              Сгенерировать
            </button>
            <button
              onClick={() => void importKey()}
              title="Импортировать существующий приватный ключ"
              className="rounded-md border border-surface-3 px-3 py-1.5 text-xs text-content-2 hover:bg-surface-2"
            >
              Импорт
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-surface-3">
            {keys.length === 0 && (
              <p className="px-3 py-4 text-xs text-content-3">
                Нет ключей. Сгенерируйте новый или импортируйте существующий.
              </p>
            )}
            {keys.map((k) => (
              <div key={k.id} className="border-b border-surface-3 px-3 py-2 last:border-0">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-content-1">{k.name}</div>
                    <div className="truncate font-mono text-[10px] text-content-3">
                      {k.algo} · {k.publicKey.slice(0, 56)}…
                    </div>
                  </div>
                  <button className={iconBtn} title="Копировать публичный ключ" onClick={() => copyPublic(k)}>
                    <Copy size={13} />
                  </button>
                  <button className={iconBtn} title="Экспорт приватного ключа в файл" onClick={() => void exportPrivate(k)}>
                    <FileDown size={13} />
                  </button>
                  <button
                    className={iconBtn}
                    title="Отправить на сервер (authorized_keys)"
                    onClick={() => setDeployFor(deployFor === k.id ? null : k.id)}
                  >
                    <Send size={13} />
                  </button>
                  <button
                    className={`${iconBtn} hover:text-red-400`}
                    title="Удалить"
                    onClick={() => void remove(k)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {deployFor === k.id && (
                  <div className="mt-2 flex items-center gap-2">
                    <select
                      className={`${field} flex-1`}
                      value={deploySession}
                      onChange={(e) => setDeploySession(e.target.value)}
                    >
                      <option value="">— выберите сессию —</option>
                      {sessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.username}@{s.host})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => void deploy(k)}
                      disabled={busy}
                      className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      <FileUp size={12} /> Деплой
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
