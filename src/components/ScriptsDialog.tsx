import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  FileTerminal,
  FolderPlus,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { useTabs } from '@/stores/useTabs'
import { useToasts } from '@/stores/useToasts'
import { useTextPrompt } from '@/stores/useTextPrompt'
import { confirmAsync } from '@/stores/useConfirm'
import type { ScriptPreset } from '@shared/types'

const CodeEditor = lazy(() => import('./CodeEditor'))

interface Props {
  open: boolean
  onClose: () => void
}

const NEW: ScriptPreset = { id: '', name: '', category: '', body: '#!/usr/bin/env bash\nset -e\n\n' }

export function ScriptsDialog({ open, onClose }: Props) {
  const { tabs, activeId } = useTabs()
  const push = useToasts((s) => s.push)
  const ask = useTextPrompt((s) => s.ask)
  const [scripts, setScripts] = useState<ScriptPreset[]>([])
  const [sel, setSel] = useState<ScriptPreset | null>(null)
  const [dirty, setDirty] = useState(false)

  const activeTab = tabs.find((t) => t.termId === activeId)
  const canRun = !!activeTab // вставка — в любой терминал; загрузка — только ssh
  const canDeploy = activeTab?.kind === 'ssh'

  const reload = async () => setScripts(await window.api.scripts.list())

  useEffect(() => {
    if (open) {
      void reload()
      setSel(null)
      setDirty(false)
    }
  }, [open])

  const groups = useMemo(() => {
    const map = new Map<string, ScriptPreset[]>()
    for (const s of scripts) {
      const k = s.category || ''
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(s)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [scripts])

  const categories = useMemo(
    () => [...new Set(scripts.map((s) => s.category).filter(Boolean))].sort(),
    [scripts]
  )

  const newScript = async () => {
    const name = await ask('Название скрипта', { placeholder: 'Базовая настройка сервера' })
    if (!name) return
    const category = await ask('Категория (можно пусто)', { placeholder: 'Provisioning, VPN…' })
    setSel({ ...NEW, name, category: category ?? '' })
    setDirty(true)
  }

  const save = async () => {
    if (!sel) return
    if (!sel.name.trim()) return push('error', 'Укажите название')
    const saved = await window.api.scripts.save({
      id: sel.id || undefined,
      name: sel.name.trim(),
      category: sel.category.trim(),
      body: sel.body
    })
    setSel(saved)
    setDirty(false)
    await reload()
    push('success', 'Скрипт сохранён')
  }

  const remove = async (s: ScriptPreset) => {
    if (!(await confirmAsync(`Удалить скрипт «${s.name}»?`))) return
    await window.api.scripts.remove(s.id)
    if (sel?.id === s.id) setSel(null)
    await reload()
  }

  const write = (data: string) => {
    if (!activeTab) return
    if (activeTab.kind === 'pty') window.api.pty.write(activeTab.termId, data)
    else window.api.ssh.write(activeTab.termId, data)
  }

  // Вставка тела в активный терминал (быстро, но для больших скриптов хрупко)
  const pasteRun = () => {
    if (!sel || !activeTab) return
    write(sel.body.endsWith('\n') ? sel.body : sel.body + '\n')
    onClose()
  }

  // Загрузка во временный файл на сервере и запуск одной командой (надёжно)
  const deployRun = async () => {
    if (!sel || !activeTab || activeTab.kind !== 'ssh') return
    const res = await window.api.scripts.upload(activeTab.termId, sel.body)
    if (!res.ok || !res.path) return push('error', res.error ?? 'Не удалось загрузить скрипт')
    // запускаем и убираем за собой; вывод идёт вживую в терминал
    write(`bash ${res.path}; rm -f ${res.path}\n`)
    onClose()
  }

  const field =
    'rounded-md border border-surface-3 bg-surface-0 px-2 py-1 text-xs text-content-1 outline-none focus:border-accent'

  if (!open) return null

  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-[820px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-surface-3 bg-surface-1 shadow-2xl">
          {/* Список слева */}
          <div className="flex w-64 shrink-0 flex-col border-r border-surface-3">
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-content-1">
                <FileTerminal size={15} className="text-accent" /> Скрипты
              </span>
              <button
                title="Новый скрипт"
                onClick={() => void newScript()}
                className="rounded p-1 text-content-2 hover:bg-surface-2 hover:text-content-1"
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {scripts.length === 0 && (
                <p className="px-2 py-4 text-xs leading-relaxed text-content-3">
                  Пока нет скриптов. Создайте пресет для установки утилит, настройки VPN и т.п.
                </p>
              )}
              {groups.map(([cat, items]) => (
                <div key={cat || '_root'} className="mb-1">
                  {cat && (
                    <div className="flex items-center gap-1 px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide text-content-3">
                      <FolderPlus size={10} /> {cat}
                    </div>
                  )}
                  {items.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => {
                        setSel(s)
                        setDirty(false)
                      }}
                      className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${
                        sel?.id === s.id ? 'bg-surface-2' : 'hover:bg-surface-2'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-xs text-content-1">{s.name}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void remove(s)
                        }}
                        className="hidden rounded p-0.5 text-content-3 hover:text-red-400 group-hover:block"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Редактор справа */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-surface-3 px-3 py-2">
              {sel ? (
                <>
                  <input
                    className={`${field} w-44`}
                    value={sel.name}
                    onChange={(e) => {
                      setSel({ ...sel, name: e.target.value })
                      setDirty(true)
                    }}
                    placeholder="Название"
                  />
                  <input
                    className={`${field} w-32`}
                    value={sel.category}
                    onChange={(e) => {
                      setSel({ ...sel, category: e.target.value })
                      setDirty(true)
                    }}
                    placeholder="Категория"
                    list="litessh-script-cats"
                  />
                  <datalist id="litessh-script-cats">
                    {categories.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                  <button
                    onClick={() => void save()}
                    disabled={!dirty}
                    className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                  >
                    <Save size={12} /> Сохранить
                  </button>
                </>
              ) : (
                <span className="text-xs text-content-3">Выберите скрипт или создайте новый «+»</span>
              )}
              <div className="flex-1" />
              <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
                <X size={15} />
              </Dialog.Close>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden bg-[#1e1e1e]">
              {sel ? (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-content-3">
                      <Loader2 size={20} className="animate-spin" />
                    </div>
                  }
                >
                  <CodeEditor
                    value={sel.body}
                    filename="script.sh"
                    onChange={(v) => {
                      setSel({ ...sel, body: v })
                      setDirty(true)
                    }}
                  />
                </Suspense>
              ) : (
                <div className="flex h-full items-center justify-center text-content-3">
                  <FileTerminal size={40} strokeWidth={1.2} />
                </div>
              )}
            </div>

            {sel && (
              <div className="flex items-center gap-2 border-t border-surface-3 px-3 py-2">
                <span className="text-[11px] text-content-3">
                  {activeTab ? `Цель: ${activeTab.title}` : 'Нет активного терминала'}
                </span>
                <div className="flex-1" />
                <button
                  onClick={pasteRun}
                  disabled={!canRun}
                  title="Вставить тело в активный терминал"
                  className="flex items-center gap-1 rounded-md border border-surface-3 px-2.5 py-1 text-[11px] text-content-2 hover:bg-surface-2 disabled:opacity-40"
                >
                  <Play size={12} /> Вставить
                </button>
                <button
                  onClick={() => void deployRun()}
                  disabled={!canDeploy}
                  title="Загрузить во временный файл на сервере и выполнить (надёжно)"
                  className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                >
                  <Upload size={12} /> Загрузить и выполнить
                </button>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
