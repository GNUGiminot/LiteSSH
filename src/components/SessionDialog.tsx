import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Copy, Eye, EyeOff, FolderOpen, X } from 'lucide-react'
import { useSessions } from '@/stores/useSessions'
import { useToasts } from '@/stores/useToasts'
import type { AuthType, KeyInfo, SessionProfile } from '@shared/types'

const NO_JUMP = ''

interface Props {
  open: boolean
  session: SessionProfile | null
  onClose: () => void
}

const EMPTY = {
  id: '',
  name: '',
  folder: '',
  host: '',
  port: 22,
  username: '',
  authType: 'password' as AuthType,
  keyPath: '',
  password: '',
  passphrase: '',
  jumpSessionId: NO_JUMP,
  agentForward: false,
  tags: ''
}

export function SessionDialog({ open, session, onClose }: Props) {
  const save = useSessions((s) => s.save)
  const sessions = useSessions((s) => s.sessions)
  const push = useToasts((s) => s.push)
  const existingGroups = useMemo(() => {
    const set = new Set<string>()
    for (const s of sessions) if (s.folder) set.add(s.folder)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [sessions])
  const [form, setForm] = useState(EMPTY)
  const [passwordTouched, setPasswordTouched] = useState(false)
  const [storedKeys, setStoredKeys] = useState<KeyInfo[]>([])
  const [showSecrets, setShowSecrets] = useState(false)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (!open) return
    setPasswordTouched(false)
    setShowSecrets(false)
    setRevealed(false)
    void window.api.keys.list().then(setStoredKeys)
    setForm(
      session
        ? {
            id: session.id,
            name: session.name,
            folder: session.folder,
            host: session.host,
            port: session.port,
            username: session.username,
            authType: session.authType,
            keyPath: session.keyPath ?? '',
            password: '',
            passphrase: '',
            jumpSessionId: session.jumpSessionId ?? NO_JUMP,
            agentForward: !!session.agentForward,
            tags: (session.tags ?? []).join(', ')
          }
        : EMPTY
    )
  }, [open, session])

  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }))

  // «Наследование»: скопировать настройки из существующей сессии (кроме имени/хоста/секретов)
  const copyFrom = (id: string) => {
    const src = sessions.find((s) => s.id === id)
    if (!src) return
    set({
      folder: src.folder,
      port: src.port,
      username: src.username,
      authType: src.authType,
      keyPath: src.keyPath ?? '',
      jumpSessionId: src.jumpSessionId ?? NO_JUMP,
      agentForward: !!src.agentForward,
      tags: (src.tags ?? []).join(', ')
    })
    push('info', `Настройки скопированы из «${src.name}»`)
  }

  const submit = async () => {
    if (!form.host.trim() || !form.username.trim()) {
      push('error', 'Заполните хост и имя пользователя')
      return
    }
    try {
      const profile: SessionProfile = {
        id: form.id,
        name: form.name.trim() || `${form.username}@${form.host}`,
        folder: form.folder.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        authType: form.authType,
        keyPath: form.authType === 'key' ? form.keyPath || undefined : undefined,
        jumpSessionId: form.jumpSessionId || undefined,
        agentForward: form.agentForward,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        // undefined = не менять сохранённый секрет
        password: passwordTouched ? form.password : undefined,
        passphrase: passwordTouched ? form.passphrase : undefined
      }
      await save(profile)
      push('success', 'Сессия сохранена')
      onClose()
    } catch (e) {
      push('error', `Не удалось сохранить: ${(e as Error).message}`)
    }
  }

  /**
   * Показать сохранённые секреты. Подставленные значения НЕ помечают форму как
   * изменённую (passwordTouched), поэтому простой просмотр без правок сохраняет
   * секрет в хранилище как есть.
   */
  const ensureRevealed = async (): Promise<{ password: string; passphrase: string } | null> => {
    const hasStored = session && (session.hasPassword || session.hasPassphrase)
    if (!hasStored || revealed || passwordTouched) {
      return { password: form.password, passphrase: form.passphrase }
    }
    const res = await window.api.sessions.reveal(session.id)
    if (!res.ok) {
      push('error', res.error ?? 'Не удалось показать сохранённый пароль')
      return null
    }
    const secrets = { password: res.password ?? '', passphrase: res.passphrase ?? '' }
    setRevealed(true)
    set(secrets)
    return secrets
  }

  const toggleSecrets = async () => {
    if (showSecrets) return setShowSecrets(false)
    if (await ensureRevealed()) setShowSecrets(true)
  }

  const copySecret = async (which: 'password' | 'passphrase') => {
    const secrets = await ensureRevealed()
    if (!secrets) return
    if (!secrets[which]) return push('info', 'Секрет не сохранён')
    await navigator.clipboard.writeText(secrets[which])
    push('success', 'Скопировано в буфер обмена')
  }

  const pickKey = async () => {
    const path = await window.api.dialog.pickKeyFile()
    if (path) set({ keyPath: path })
  }

  const field =
    'w-full rounded-md border border-surface-3 bg-surface-0 px-2.5 py-1.5 text-xs text-content-1 outline-none focus:border-accent placeholder:text-content-3'
  const label = 'mb-1 block text-[11px] font-medium text-content-2'
  const secretBtn =
    'shrink-0 rounded-md border border-surface-3 px-2 text-content-2 hover:bg-surface-2 hover:text-content-1'

  /** Кнопки «показать»/«скопировать» рядом с полем секрета. */
  const secretActions = (which: 'password' | 'passphrase') => (
    <>
      <button
        type="button"
        onClick={() => void toggleSecrets()}
        className={secretBtn}
        title={showSecrets ? 'Скрыть' : 'Показать сохранённый секрет'}
      >
        {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
      <button
        type="button"
        onClick={() => void copySecret(which)}
        className={secretBtn}
        title="Скопировать в буфер обмена"
      >
        <Copy size={14} />
      </button>
    </>
  )

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold text-content-1">
              {session ? 'Редактировать сессию' : 'Новая сессия'}
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
              <X size={15} />
            </Dialog.Close>
          </div>

          {!session && sessions.length > 0 && (
            <div className="mb-3">
              <label className={label}>Скопировать настройки из (шаблон)</label>
              <select
                className={field}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) copyFrom(e.target.value)
                  e.target.value = ''
                }}
              >
                <option value="">— не копировать —</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.username}@{s.host})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Название</label>
              <input
                className={field}
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="prod-web-01"
              />
            </div>
            <div>
              <label className={label}>Группа</label>
              <input
                className={field}
                value={form.folder}
                onChange={(e) => set({ folder: e.target.value })}
                placeholder="LAN, VPN, Работа…"
                list="litessh-groups"
                spellCheck={false}
              />
              <datalist id="litessh-groups">
                {existingGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
            <div className="col-span-2">
              <label className={label}>Теги (через запятую)</label>
              <input
                className={field}
                value={form.tags}
                onChange={(e) => set({ tags: e.target.value })}
                placeholder="prod, web, nginx"
                spellCheck={false}
              />
            </div>
            <div>
              <label className={label}>Хост *</label>
              <input
                className={field}
                value={form.host}
                onChange={(e) => set({ host: e.target.value })}
                placeholder="192.168.1.10"
                spellCheck={false}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Порт</label>
                <input
                  className={field}
                  type="number"
                  value={form.port}
                  onChange={(e) => set({ port: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className={label}>Auth</label>
                <select
                  className={field}
                  value={form.authType}
                  onChange={(e) => set({ authType: e.target.value as AuthType })}
                >
                  <option value="password">Пароль</option>
                  <option value="key">Ключ</option>
                  <option value="agent">Агент</option>
                </select>
              </div>
            </div>
            <div className="col-span-2">
              <label className={label}>Пользователь *</label>
              <input
                className={field}
                value={form.username}
                onChange={(e) => set({ username: e.target.value })}
                placeholder="root"
                spellCheck={false}
              />
            </div>
            <div className="col-span-2">
              <label className={label}>Бастион / ProxyJump (опционально)</label>
              <select
                className={field}
                value={form.jumpSessionId}
                onChange={(e) => set({ jumpSessionId: e.target.value })}
              >
                <option value={NO_JUMP}>— прямое подключение —</option>
                {sessions
                  .filter((s) => s.id !== form.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      через {s.name} ({s.username}@{s.host})
                    </option>
                  ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-content-1">
                <input
                  type="checkbox"
                  checked={form.agentForward}
                  onChange={(e) => set({ agentForward: e.target.checked })}
                  className="accent-accent"
                />
                Проброс SSH-агента (ForwardAgent) — прыгать дальше без копирования ключей
              </label>
            </div>

            {form.authType === 'password' && (
              <div className="col-span-2">
                <label className={label}>Пароль</label>
                <div className="flex gap-2">
                  <input
                    className={field}
                    type={showSecrets ? 'text' : 'password'}
                    value={form.password}
                    onChange={(e) => {
                      setPasswordTouched(true)
                      set({ password: e.target.value })
                    }}
                    placeholder={session?.hasPassword ? '•••••• (сохранён, не менять)' : ''}
                    spellCheck={false}
                  />
                  {secretActions('password')}
                </div>
              </div>
            )}

            {form.authType === 'key' && (
              <>
                <div className="col-span-2">
                  <label className={label}>Источник ключа</label>
                  <select
                    className={field}
                    value={form.keyPath.startsWith('vault:') ? form.keyPath : 'file'}
                    onChange={(e) =>
                      set({ keyPath: e.target.value === 'file' ? '' : e.target.value })
                    }
                  >
                    <option value="file">Файл с диска</option>
                    {storedKeys.map((k) => (
                      <option key={k.id} value={`vault:${k.id}`}>
                        Из менеджера: {k.name} ({k.algo})
                      </option>
                    ))}
                  </select>
                </div>
                {!form.keyPath.startsWith('vault:') && (
                  <div className="col-span-2">
                    <label className={label}>Путь к приватному ключу</label>
                    <div className="flex gap-2">
                      <input
                        className={field}
                        value={form.keyPath}
                        onChange={(e) => set({ keyPath: e.target.value })}
                        placeholder="C:\Users\you\.ssh\id_ed25519"
                        spellCheck={false}
                      />
                      <button
                        onClick={() => void pickKey()}
                        className="shrink-0 rounded-md border border-surface-3 px-2 text-content-2 hover:bg-surface-2"
                        title="Выбрать файл"
                      >
                        <FolderOpen size={14} />
                      </button>
                    </div>
                  </div>
                )}
                <div className="col-span-2">
                  <label className={label}>Passphrase (если есть)</label>
                  <div className="flex gap-2">
                    <input
                      className={field}
                      type={showSecrets ? 'text' : 'password'}
                      value={form.passphrase}
                      onChange={(e) => {
                        setPasswordTouched(true)
                        set({ passphrase: e.target.value })
                      }}
                      placeholder={session?.hasPassphrase ? '•••••• (сохранена, не менять)' : ''}
                      spellCheck={false}
                    />
                    {secretActions('passphrase')}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-content-2 hover:bg-surface-2"
            >
              Отмена
            </button>
            <button
              onClick={() => void submit()}
              className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Сохранить
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
