import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileCog,
  FileDown,
  FileUp,
  Folder,
  Monitor,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { useSessions } from '@/stores/useSessions'
import { useToasts } from '@/stores/useToasts'
import { useTextPrompt } from '@/stores/useTextPrompt'
import { confirmAsync } from '@/stores/useConfirm'
import { useContextMenu, type MenuItem } from '@/stores/useContextMenu'
import { connectAndOpen } from '@/lib/connect'
import type { SessionProfile } from '@shared/types'

interface Props {
  visible: boolean
  onEdit: (session: SessionProfile | null) => void
}

export function Sidebar({ visible, onEdit }: Props) {
  const { sessions, remove, load, save } = useSessions()
  const push = useToasts((s) => s.push)
  const ask = useTextPrompt((s) => s.ask)
  const showMenu = useContextMenu((s) => s.show)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)

  const allGroups = useMemo(() => {
    const set = new Set<string>()
    for (const s of sessions) if (s.folder) set.add(s.folder)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [sessions])

  // Переместить сессию в группу (password/passphrase undefined → секреты сохраняются)
  const moveToGroup = (s: SessionProfile, folder: string) =>
    void save({ ...s, folder, password: undefined, passphrase: undefined })

  const askRemove = (s: SessionProfile) =>
    void confirmAsync(`Удалить сессию «${s.name}»?`).then((yes) => {
      if (yes) void remove(s.id)
    })

  const sessionMenu = (s: SessionProfile): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Подключиться', action: () => void connectAndOpen({ sessionId: s.id }) },
      { label: 'Редактировать', action: () => onEdit(s) }
    ]
    for (const g of allGroups) {
      if (g !== s.folder) items.push({ label: `→ Группа «${g}»`, action: () => moveToGroup(s, g) })
    }
    items.push({
      label: '→ Новая группа…',
      action: () => {
        void ask('Название группы', { placeholder: 'LAN, VPN, Работа…' }).then((name) => {
          if (name?.trim()) moveToGroup(s, name.trim())
        })
      }
    })
    if (s.folder) items.push({ label: '→ Без группы', action: () => moveToGroup(s, '') })
    items.push({
      label: 'Удалить',
      danger: true,
      action: () => askRemove(s)
    })
    return items
  }

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const s of sessions) for (const t of s.tags ?? []) set.add(t)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [sessions])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sessions.filter((s) => {
      if (activeTag && !(s.tags ?? []).includes(activeTag)) return false
      if (!q) return true
      const hay = [s.name, s.host, s.username, s.folder, ...(s.tags ?? [])]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [sessions, query, activeTag])

  const runIo = async (
    fn: () => Promise<{ ok: boolean; error?: string; count?: unknown }>,
    okMsg: (n: number) => string
  ) => {
    const res = await fn()
    if (res.ok) {
      push('success', okMsg(Number(res.count ?? 0)))
      await load()
    } else if (res.error) {
      push('error', res.error)
    }
  }

  const groups = useMemo(() => {
    const map = new Map<string, SessionProfile[]>()
    for (const s of filtered) {
      const key = s.folder || ''
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filtered])

  const toggleFolder = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  if (!visible) return null

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-surface-3 bg-surface-1">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-content-2">
          Сессии
        </span>
        <div className="flex items-center gap-0.5">
          <button
            title="Импорт из ~/.ssh/config"
            onClick={() =>
              void runIo(window.api.sessions.importSshConfig, (n) => `Импортировано хостов: ${n}`)
            }
            className="rounded p-1 text-content-2 transition-colors hover:bg-surface-2 hover:text-content-1"
          >
            <FileCog size={14} />
          </button>
          <button
            title="Импорт сессий (JSON)"
            onClick={() =>
              void runIo(window.api.sessions.importJson, (n) => `Импортировано сессий: ${n}`)
            }
            className="rounded p-1 text-content-2 transition-colors hover:bg-surface-2 hover:text-content-1"
          >
            <FileUp size={14} />
          </button>
          <button
            title="Экспорт сессий (JSON, без паролей)"
            onClick={() =>
              void runIo(window.api.sessions.exportJson, (n) => `Экспортировано сессий: ${n}`)
            }
            className="rounded p-1 text-content-2 transition-colors hover:bg-surface-2 hover:text-content-1"
          >
            <FileDown size={14} />
          </button>
          <button
            title="Новая сессия"
            onClick={() => onEdit(null)}
            className="rounded p-1 text-content-2 transition-colors hover:bg-surface-2 hover:text-content-1"
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-surface-3 bg-surface-0 px-2 py-1 focus-within:border-accent">
          <Search size={12} className="shrink-0 text-content-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по хостам…"
            spellCheck={false}
            className="w-full bg-transparent text-[11px] text-content-1 outline-none placeholder:text-content-3"
          />
          {query && (
            <button onClick={() => setQuery('')} className="shrink-0 text-content-3 hover:text-content-1">
              <X size={11} />
            </button>
          )}
        </div>
        {allTags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                  activeTag === tag
                    ? 'bg-accent text-white'
                    : 'bg-surface-2 text-content-2 hover:bg-surface-3'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-4 text-xs leading-relaxed text-content-3">
            Нет сохранённых сессий.
            <br />
            Нажмите «+» или используйте строку быстрого подключения сверху.
          </p>
        )}
        {sessions.length > 0 && filtered.length === 0 && (
          <p className="px-2 py-4 text-xs text-content-3">Ничего не найдено.</p>
        )}
        {groups.map(([folder, items]) => (
          <div key={folder || '_root'}>
            {folder && (
              <button
                onClick={() => toggleFolder(folder)}
                className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-content-2 hover:bg-surface-2"
              >
                {collapsed.has(folder) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <Folder size={13} className="text-accent" />
                <span className="flex-1 truncate text-left">{folder}</span>
                <span className="text-[10px] text-content-3">{items.length}</span>
              </button>
            )}
            {!collapsed.has(folder) &&
              items.map((s) => (
                <div
                  key={s.id}
                  onDoubleClick={() => void connectAndOpen({ sessionId: s.id })}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    showMenu(e.clientX, e.clientY, sessionMenu(s))
                  }}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2 ${folder ? 'ml-3' : ''}`}
                  title="Двойной клик — подключиться · ПКМ — меню"
                >
                  <Monitor size={15} className="shrink-0 text-content-2" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-content-1">{s.name}</div>
                    <div className="truncate text-[11px] text-content-3">
                      {s.username}@{s.host}
                      {s.port !== 22 ? `:${s.port}` : ''}
                    </div>
                    {(s.tags ?? []).length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {(s.tags ?? []).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-surface-2 px-1.5 text-[9px] leading-4 text-content-2"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    <button
                      title="Подключить"
                      onClick={(e) => {
                        e.stopPropagation()
                        void connectAndOpen({ sessionId: s.id })
                      }}
                      className="rounded p-1 text-content-2 hover:bg-surface-3 hover:text-emerald-400"
                    >
                      <Play size={12} />
                    </button>
                    <button
                      title="Редактировать"
                      onClick={(e) => {
                        e.stopPropagation()
                        onEdit(s)
                      }}
                      className="rounded p-1 text-content-2 hover:bg-surface-3 hover:text-content-1"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      title="Удалить"
                      onClick={(e) => {
                        e.stopPropagation()
                        askRemove(s)
                      }}
                      className="rounded p-1 text-content-2 hover:bg-surface-3 hover:text-red-400"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
    </aside>
  )
}
