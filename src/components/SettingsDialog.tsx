import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Lock, Settings2, X } from 'lucide-react'
import { useSettings } from '@/stores/useSettings'
import { useVault } from '@/stores/useVault'
import { useToasts } from '@/stores/useToasts'
import { TERM_THEMES } from '@/lib/termThemes'
import { KeybindingsSection } from './KeybindingsSection'

interface Props {
  open: boolean
  onClose: () => void
}

const ACCENT_PRESETS = ['#3B82F6', '#8B5CF6', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#14B8A6']

export function SettingsDialog({ open, onClose }: Props) {
  const s = useSettings()
  const { mode, refresh, setLocked } = useVault()
  const push = useToasts((st) => st.push)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)

  const enableMaster = async () => {
    if (pw1.length < 4) return push('error', 'Пароль слишком короткий (мин. 4 символа)')
    if (pw1 !== pw2) return push('error', 'Пароли не совпадают')
    setBusy(true)
    try {
      const res = await window.api.vault.setup(pw1)
      if (res.ok) {
        push('success', 'Мастер-пароль включён')
        setPw1('')
        setPw2('')
        await refresh()
      } else push('error', res.error ?? 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  const disableMaster = async () => {
    const pw = prompt('Введите мастер-пароль для отключения')
    if (pw === null) return
    setBusy(true)
    try {
      const res = await window.api.vault.disable(pw)
      if (res.ok) {
        push('success', 'Мастер-пароль отключён (секреты в keychain ОС)')
        await refresh()
      } else push('error', res.error ?? 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  const lockNow = async () => {
    await window.api.vault.lock()
    setLocked(true)
    onClose()
  }

  const label = 'mb-1 block text-[11px] font-medium text-content-2'
  const field =
    'w-full rounded-md border border-surface-3 bg-surface-0 px-2.5 py-1.5 text-xs text-content-1 outline-none focus:border-accent'

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[400px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-content-1">
              <Settings2 size={16} className="text-accent" /> Настройки
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
              <X size={15} />
            </Dialog.Close>
          </div>

          <div className="space-y-4">
            <div>
              <label className={label}>Тема терминала</label>
              <select
                className={field}
                value={s.termTheme}
                onChange={(e) => s.setTermTheme(e.target.value)}
              >
                {Object.entries(TERM_THEMES).map(([key, t]) => (
                  <option key={key} value={key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={label}>Размер шрифта терминала: {s.fontSize}px</label>
              <input
                type="range"
                min={10}
                max={20}
                value={s.fontSize}
                onChange={(e) => s.setFontSize(Number(e.target.value))}
                className="w-full accent-accent"
              />
            </div>

            <div>
              <label className={label}>Акцентный цвет</label>
              <div className="flex items-center gap-2">
                {ACCENT_PRESETS.map((c) => (
                  <button
                    key={c}
                    onClick={() => s.setAccent(c)}
                    style={{ background: c }}
                    className={`h-6 w-6 rounded-full transition-transform hover:scale-110 ${
                      s.accent === c ? 'ring-2 ring-content-1 ring-offset-2 ring-offset-surface-1' : ''
                    }`}
                  />
                ))}
                <input
                  type="color"
                  value={s.accent}
                  onChange={(e) => s.setAccent(e.target.value)}
                  className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
                  title="Свой цвет"
                />
              </div>
            </div>

            <div className="border-t border-surface-3 pt-4">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-content-1">
                <Lock size={13} className="text-accent" /> Хранилище секретов
              </div>
              {mode === 'keychain' ? (
                <div className="space-y-2">
                  <p className="text-[10px] leading-relaxed text-content-3">
                    Сейчас пароли и ключи защищены keychain ОС. Можно включить мастер-пароль
                    (scrypt + AES-256-GCM) — тогда для доступа к секретам потребуется его ввод.
                  </p>
                  <input
                    type="password"
                    value={pw1}
                    onChange={(e) => setPw1(e.target.value)}
                    placeholder="Новый мастер-пароль"
                    className={field}
                  />
                  <input
                    type="password"
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                    placeholder="Повторите пароль"
                    className={field}
                  />
                  <button
                    onClick={() => void enableMaster()}
                    disabled={busy}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    Включить мастер-пароль
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-[10px] leading-relaxed text-content-3">
                    Мастер-пароль включён. Секреты зашифрованы им, а не keychain ОС.
                  </p>
                  <div>
                    <label className={label}>Автоблокировка через (мин, 0 = выкл)</label>
                    <input
                      type="number"
                      min={0}
                      max={240}
                      value={s.autoLockMinutes}
                      onChange={(e) => s.setAutoLockMinutes(Number(e.target.value))}
                      className={field}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void lockNow()}
                      className="rounded-md border border-surface-3 px-3 py-1.5 text-xs text-content-2 hover:bg-surface-2"
                    >
                      Заблокировать сейчас
                    </button>
                    <button
                      onClick={() => void disableMaster()}
                      disabled={busy}
                      className="rounded-md border border-surface-3 px-3 py-1.5 text-xs text-content-2 hover:bg-surface-2 hover:text-red-400 disabled:opacity-50"
                    >
                      Отключить мастер-пароль
                    </button>
                  </div>
                </div>
              )}
            </div>

            <KeybindingsSection />

            <p className="text-[10px] leading-relaxed text-content-3">
              Поиск в терминале: Ctrl+Shift+F · Копирование/вставка: Ctrl+C/V и Ctrl+Shift+C/V ·
              Файлы (mc): F3 просмотр, F4 правка, F5 копир., F7 папка, F8 удалить
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
