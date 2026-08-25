import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock, CornerDownLeft, Pencil, Plus, Terminal, Trash2 } from 'lucide-react'
import { useTabs } from '@/stores/useTabs'
import { useToasts } from '@/stores/useToasts'
import { useTextPrompt } from '@/stores/useTextPrompt'
import type { Snippet } from '@shared/types'

interface Props {
  open: boolean
  onClose: () => void
}

type Entry =
  | { kind: 'snippet'; id: string; name: string; command: string }
  | { kind: 'history'; command: string }

export function SnippetsPalette({ open, onClose }: Props) {
  const { activeId, tabs } = useTabs()
  const push = useToasts((s) => s.push)
  const ask = useTextPrompt((s) => s.ask)
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const reload = async () => {
    setSnippets(await window.api.snippets.list())
    const h = await window.api.history.list()
    setHistory(h.map((x) => x.command))
  }

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      void reload()
    }
  }, [open])

  const entries = useMemo<Entry[]>(() => {
    const q = query.toLowerCase()
    const snipEntries: Entry[] = snippets
      .filter((s) => s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q))
      .map((s) => ({ kind: 'snippet', id: s.id, name: s.name, command: s.command }))
    const snipCmds = new Set(snippets.map((s) => s.command))
    const histEntries: Entry[] = history
      .filter((c) => !snipCmds.has(c) && c.toLowerCase().includes(q))
      .map((c) => ({ kind: 'history', command: c }))
    return [...snipEntries, ...histEntries]
  }, [snippets, history, query])

  const writeToActive = (command: string, execute: boolean) => {
    const tab = tabs.find((t) => t.termId === activeId)
    if (!activeId || !tab) {
      push('info', 'Нет активного терминала')
      return
    }
    const data = command + (execute ? '\n' : '')
    if (tab.kind === 'pty') window.api.pty.write(activeId, data)
    else window.api.ssh.write(activeId, data)
    onClose()
  }

  const addSnippet = async () => {
    const name = await ask('Название сниппета', { placeholder: 'Перезапуск nginx' })
    if (!name) return
    const command = await ask('Команда', { placeholder: 'sudo systemctl restart nginx' })
    if (!command) return
    await window.api.snippets.save({ name, command })
    await reload()
  }

  const editSnippet = async (s: Snippet) => {
    const name = await ask('Название сниппета', { initial: s.name })
    if (!name) return
    const command = await ask('Команда', { initial: s.command })
    if (!command) return
    await window.api.snippets.save({ id: s.id, name, command })
    await reload()
  }

  const saveHistoryAsSnippet = async (command: string) => {
    const name = await ask('Название сниппета', { initial: command.slice(0, 40) })
    if (!name) return
    await window.api.snippets.save({ name, command })
    await reload()
  }

  if (!open) return null

  const firstHistoryIdx = entries.findIndex((e) => e.kind === 'history')

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-24"
      onMouseDown={onClose}
    >
      <div
        className="w-[540px] overflow-hidden rounded-xl border border-surface-3 bg-surface-1 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-surface-3 px-3">
          <Terminal size={14} className="shrink-0 text-accent" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, entries.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (e.key === 'Enter' && entries[cursor]) {
                writeToActive(entries[cursor].command, e.ctrlKey)
              }
            }}
            placeholder="Сниппеты и история команд…  Enter — вставить, Ctrl+Enter — выполнить"
            className="w-full bg-transparent py-2.5 text-xs text-content-1 outline-none placeholder:text-content-3"
          />
          <button
            title="Добавить сниппет"
            onClick={() => void addSnippet()}
            className="rounded p-1 text-content-2 hover:bg-surface-2 hover:text-content-1"
          >
            <Plus size={14} />
          </button>
          {history.length > 0 && (
            <button
              title="Очистить историю команд"
              onClick={() => void window.api.history.clear().then(reload)}
              className="rounded p-1 text-content-2 hover:bg-surface-2 hover:text-red-400"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto">
          {entries.length === 0 && (
            <p className="px-3 py-4 text-xs text-content-3">
              {snippets.length === 0 && history.length === 0
                ? 'Нет сниппетов и истории. Добавьте сниппет кнопкой «+» или начните вводить команды.'
                : 'Ничего не найдено'}
            </p>
          )}
          {entries.map((e, i) => (
            <div key={e.kind === 'snippet' ? 's' + e.id : 'h' + i}>
              {i === firstHistoryIdx && (
                <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-content-3">
                  <Clock size={10} /> Недавние команды
                </div>
              )}
              <div
                onClick={() => writeToActive(e.command, false)}
                onMouseEnter={() => setCursor(i)}
                className={`group flex cursor-pointer items-center gap-2 px-3 py-2 ${
                  i === cursor ? 'bg-surface-2' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  {e.kind === 'snippet' && (
                    <div className="truncate text-xs text-content-1">{e.name}</div>
                  )}
                  <div className="truncate font-mono text-[10px] text-content-3">{e.command}</div>
                </div>
                <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <button
                    title="Выполнить"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      writeToActive(e.command, true)
                    }}
                    className="rounded p-1 text-content-2 hover:bg-surface-3 hover:text-content-1"
                  >
                    <CornerDownLeft size={12} />
                  </button>
                  {e.kind === 'snippet' ? (
                    <>
                      <button
                        title="Редактировать"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void editSnippet({ id: e.id, name: e.name, command: e.command })
                        }}
                        className="rounded p-1 text-content-2 hover:bg-surface-3 hover:text-content-1"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        title="Удалить"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void window.api.snippets.remove(e.id).then(reload)
                        }}
                        className="rounded p-1 text-content-2 hover:bg-surface-3 hover:text-red-400"
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  ) : (
                    <button
                      title="Сохранить как сниппет"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void saveHistoryAsSnippet(e.command)
                      }}
                      className="rounded p-1 text-content-2 hover:bg-surface-3 hover:text-content-1"
                    >
                      <Plus size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
