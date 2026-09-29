import { useEffect, useMemo, useState } from 'react'
import { Download, Eye, EyeOff, Search, X } from 'lucide-react'
import type { McpActivityEvent, McpActivityFilter } from '@shared/types'

interface Props {
  open: boolean
  onClose: () => void
}

function matches(event: McpActivityEvent, filter: McpActivityFilter): boolean {
  if (filter.termId && event.termId !== filter.termId) return false
  if (filter.client && event.client !== filter.client) return false
  if (filter.status && event.status !== filter.status) return false
  const query = filter.query?.trim().toLocaleLowerCase()
  return !query || [event.server, event.client, event.tool, event.summary, event.error, ...Object.values(event.params)]
    .some((value) => String(value ?? '').toLocaleLowerCase().includes(query))
}

function duration(event: McpActivityEvent, now: number): string {
  const elapsed = (event.finishedAt ?? now) - event.startedAt
  return elapsed < 1000 ? `${elapsed} мс` : `${(elapsed / 1000).toFixed(1)} с`
}

function clientLabel(client: McpActivityEvent['client']): string {
  return client === 'codex' ? 'Codex' : client === 'claude' ? 'Claude Code' : 'Другой клиент'
}

export function McpActivityPanel({ open, onClose }: Props) {
  const [events, setEvents] = useState<McpActivityEvent[]>([])
  const [servers, setServers] = useState<{ id: string; title: string }[]>([])
  const [serverId, setServerId] = useState('')
  const [client, setClient] = useState('')
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [showCommand, setShowCommand] = useState(false)
  const [showOutput, setShowOutput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => setDebouncedQuery(query), 250)
    return () => clearTimeout(timer)
  }, [open, query])

  const filter = useMemo<McpActivityFilter>(() => ({
    termId: serverId || undefined,
    client: client ? client as McpActivityEvent['client'] : undefined,
    status: status ? status as McpActivityEvent['status'] : undefined,
    query: debouncedQuery || undefined
  }), [serverId, client, status, debouncedQuery])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api.mcp.activity(filter).then((items) => {
      if (!cancelled) setEvents(items)
    }).catch((error) => {
      if (!cancelled) setNotice(`Не удалось прочитать журнал: ${String(error)}`)
    })
    return () => { cancelled = true }
  }, [open, filter])

  useEffect(() => {
    if (!open) return
    void window.api.mcp.activity().then((items) =>
      setServers([...new Map(items.map((item) => [item.termId, { id: item.termId, title: item.server }])).values()]
        .sort((a, b) => a.title.localeCompare(b.title)))
    )
    const unsubscribe = window.api.mcp.onActivity((event) => {
      setServers((previous) => previous.some((item) => item.id === event.termId)
        ? previous
        : [...previous, { id: event.termId, title: event.server }].sort((a, b) => a.title.localeCompare(b.title)))
      setEvents((previous) => {
        const without = previous.filter((item) => item.id !== event.id)
        return matches(event, filter) ? [event, ...without].sort((a, b) => b.startedAt - a.startedAt).slice(0, 500) : without
      })
    })
    const ticker = setInterval(() => setNow(Date.now()), 1000)
    return () => { unsubscribe(); clearInterval(ticker) }
  }, [open, filter])

  useEffect(() => { setShowCommand(false); setShowOutput(false) }, [selectedId])

  const selected = events.find((event) => event.id === selectedId)

  const exportLog = async () => {
    setBusy(true)
    setNotice('')
    const result = await window.api.mcp.exportActivity(filter)
    setBusy(false)
    if (result.ok) setNotice(`Экспортировано ${result.count ?? 0} записей: ${result.path}`)
    else if (result.error !== 'Отменено') setNotice(result.error ?? 'Не удалось экспортировать журнал')
  }

  if (!open) return null
  const field = 'rounded border border-surface-3 bg-surface-0 px-2 py-1.5 text-[11px] text-content-1 outline-none focus:border-accent'
  return (
    <aside className="flex h-full w-[440px] shrink-0 flex-col border-l border-surface-3 bg-surface-1 text-content-1">
      <div className="flex items-center gap-2 border-b border-surface-3 px-3 py-2">
        <span className="flex-1 text-xs font-semibold">Активность MCP</span>
        <button disabled={busy} onClick={() => void exportLog()} title="Экспортировать журнал JSONL" className="rounded p-1 text-content-2 hover:bg-surface-2"><Download size={14} /></button>
        <button onClick={onClose} title="Закрыть панель" className="rounded p-1 text-content-2 hover:bg-surface-2"><X size={14} /></button>
      </div>
      <div className="grid grid-cols-3 gap-1.5 border-b border-surface-3 p-2">
        <select aria-label="Сервер" value={serverId} onChange={(event) => setServerId(event.target.value)} className={field}>
          <option value="">Все серверы</option>
          {servers.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.id.slice(0, 8)}</option>)}
        </select>
        <select aria-label="Клиент" value={client} onChange={(event) => setClient(event.target.value)} className={field}>
          <option value="">Все клиенты</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
          <option value="other">Другой</option>
        </select>
        <select aria-label="Статус" value={status} onChange={(event) => setStatus(event.target.value)} className={field}>
          <option value="">Все статусы</option>
          <option value="running">Выполняется</option>
          <option value="ok">Успешно</option>
          <option value="error">Ошибка</option>
        </select>
        <label className="col-span-3 flex items-center gap-2 rounded border border-surface-3 bg-surface-0 px-2 text-content-3">
          <Search size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по инструменту, пути, серверу…" className="w-full bg-transparent py-1.5 text-[11px] text-content-1 outline-none" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {events.length > 0 && <p className="border-b border-surface-3/60 px-3 py-1 text-[10px] text-content-3">Последние {events.length} совпадений · экспорт включает весь журнал</p>}
        {events.length === 0 && <p className="p-4 text-center text-xs text-content-3">Вызовов MCP по этому фильтру пока нет.</p>}
        {events.map((event) => (
          <button key={event.id} onClick={() => setSelectedId(event.id)} className={`block w-full border-b border-surface-3/60 px-3 py-2 text-left hover:bg-surface-2 ${selectedId === event.id ? 'bg-surface-2' : ''}`}>
            <div className="flex items-center gap-2 text-[11px]">
              <span className={event.status === 'error' ? 'text-red-400' : event.status === 'running' ? 'text-amber-300' : 'text-emerald-400'}>●</span>
              <span className="min-w-0 flex-1 truncate font-mono">{event.tool}</span>
              <span className="text-content-3">{duration(event, now)}</span>
            </div>
            <div className="mt-0.5 truncate text-[10px] text-content-3">{event.server} · {clientLabel(event.client)} · {new Date(event.startedAt).toLocaleString()}</div>
            <div className="mt-0.5 truncate text-[10px] text-content-2">{event.summary}</div>
          </button>
        ))}
      </div>
      {selected && (
        <div className="max-h-[43%] overflow-y-auto border-t border-surface-3 bg-surface-0 p-3 text-[11px]">
          <div className="mb-2 flex items-center justify-between"><b>{selected.tool}</b><span className="text-content-3">{selected.status} · {duration(selected, now)}</span></div>
          <p className="text-content-2">{selected.server} · {clientLabel(selected.client)}</p>
          <p className="mt-1 break-all text-content-3">{selected.summary}</p>
          {Object.entries(selected.params).length > 0 && <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-surface-1 p-2 font-mono text-[10px]">{JSON.stringify(selected.params, null, 2)}</pre>}
          {selected.error && <p className="mt-2 break-all text-red-400">{selected.error}</p>}
          {selected.exitCode !== undefined && <p className="mt-2 text-content-2">Код выхода: {selected.exitCode}{selected.truncated ? ' · вывод обрезан' : ''}</p>}
          {selected.tool === 'ssh_exec' && (
            <div className="mt-2 space-y-2">
              <button onClick={() => setShowCommand(!showCommand)} className="flex items-center gap-1 text-accent">{showCommand ? <EyeOff size={12} /> : <Eye size={12} />} {showCommand ? 'Скрыть команду' : 'Показать команду'}</button>
              {showCommand && <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-1 p-2 font-mono text-[10px]">{selected.command ?? 'Команда не сохранялась на диск и доступна только в текущем запуске.'}</pre>}
              <button onClick={() => setShowOutput(!showOutput)} className="flex items-center gap-1 text-accent">{showOutput ? <EyeOff size={12} /> : <Eye size={12} />} {showOutput ? 'Скрыть вывод' : 'Показать stdout / stderr'}</button>
              {showOutput && <div className="space-y-1">
                <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-1 p-2 font-mono text-[10px]">stdout: {selected.stdout ?? 'нет сохранённого вывода'}</pre>
                <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-1 p-2 font-mono text-[10px] text-amber-200">stderr: {selected.stderr ?? 'нет сохранённого вывода'}</pre>
                <p className="text-content-3">Вывод доступен только в памяти текущего запуска, не включается в экспорт.</p>
              </div>}
            </div>
          )}
        </div>
      )}
      {notice && <p className="border-t border-surface-3 px-3 py-2 text-[10px] text-content-2">{notice}</p>}
    </aside>
  )
}
