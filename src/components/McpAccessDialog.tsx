import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, Copy, KeyRound, Power, RefreshCw, Shield, X } from 'lucide-react'
import type { McpAccessMode, McpBridgeState } from '@shared/types'

interface Props {
  open: boolean
  termId?: string
  title?: string
  onClose: () => void
}

function copyText(text: string, setCopied: (value: string) => void, key: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    setCopied(key)
    setTimeout(() => setCopied(''), 1500)
  })
}

export function McpAccessDialog({ open, termId, title, onClose }: Props) {
  const [state, setState] = useState<McpBridgeState>({ running: false, audit: [] })
  const [bridges, setBridges] = useState<McpBridgeState[]>([])
  const [root, setRoot] = useState('.')
  const [mode, setMode] = useState<McpAccessMode>('read-only')
  const [allowExec, setAllowExec] = useState(false)
  const [port, setPort] = useState(27183)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  useEffect(() => {
    if (!open) return
    const refresh = () => {
      if (termId) void window.api.mcp.state(termId).then(setState)
      else setState({ running: false, audit: [] })
      void window.api.mcp.list().then(setBridges)
    }
    refresh()
    return window.api.mcp.onState(refresh)
  }, [open, termId])

  useEffect(() => {
    if (!open || state.running || !bridges.some((bridge) => bridge.port === port)) return
    const occupied = new Set(bridges.map((bridge) => bridge.port))
    let candidate = 27183
    while (occupied.has(candidate) && candidate < 65535) candidate++
    setPort(candidate)
  }, [open, state.running, bridges])

  const snippets = useMemo(() => {
    if (!state.running || !state.url || !state.clients) return null
    const tokenFor = (id: 'codex' | 'claude' | 'other') => state.clients?.find((client) => client.id === id)?.token ?? ''
    const name = `litessh_${state.port}`
    return {
      generic: JSON.stringify({
        type: 'http',
        url: state.url,
        headers: { Authorization: `Bearer ${tokenFor('other')}` }
      }, null, 2),
      codex:
        `[mcp_servers.${name}]\n` +
        `url = "${state.url}"\n` +
        `http_headers = { Authorization = "Bearer ${tokenFor('codex')}" }\n` +
        `default_tools_approval_mode = "writes"`,
      claude: `claude mcp add --transport http ${name} ${state.url} --header "Authorization: Bearer ${tokenFor('claude')}"`
    }
  }, [state])

  const start = async () => {
    if (!termId) return setError('Сначала откройте SSH-сессию')
    setBusy(true)
    setError('')
    const response = await window.api.mcp.start({
      termId,
      title: title || 'SSH',
      root,
      mode,
      allowExec,
      port
    })
    setBusy(false)
    if (!response.ok || !response.state) return setError(response.error ?? 'Не удалось запустить MCP')
    setState(response.state)
  }

  const stop = async () => {
    setBusy(true)
    const response = await window.api.mcp.stop(termId!)
    setBusy(false)
    if (!response.ok) return setError(response.error ?? 'Не удалось остановить MCP')
    if (response.state) setState(response.state)
  }

  const rotate = async () => {
    setBusy(true)
    const response = await window.api.mcp.rotateToken(termId!)
    setBusy(false)
    if (!response.ok) return setError(response.error ?? 'Не удалось изменить токен')
    if (response.state) setState(response.state)
  }

  const copyBtn = (key: string, text: string, label: string) => (
    <button
      onClick={() => copyText(text, setCopied, key)}
      className="flex shrink-0 items-center gap-1 rounded border border-surface-3 px-2 py-1 text-[11px] text-content-2 hover:bg-surface-2 hover:text-content-1"
    >
      {copied === key ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      {label}
    </button>
  )

  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/55" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[680px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-surface-3 bg-surface-1 shadow-2xl">
          <div className="flex items-center gap-2 border-b border-surface-3 px-5 py-4">
            <Shield size={17} className="text-accent" />
            <Dialog.Title className="flex-1 text-sm font-semibold text-content-1">
              MCP-доступ к SSH
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
              <X size={15} />
            </Dialog.Close>
          </div>

          <div className="min-h-0 overflow-y-auto p-5">
            {!state.running ? (
              <div className="space-y-4">
                <p className="text-xs leading-5 text-content-2">
                  Откройте отдельный Streamable HTTP MCP-мост для этого SSH-соединения.
                  Другие мосты продолжат работу на своих портах и с собственными токенами.
                  Пароли и приватные ключи клиенту не передаются.
                </p>
                <label className="block text-xs text-content-2">
                  Разрешённый каталог на сервере
                  <input
                    value={root}
                    onChange={(event) => setRoot(event.target.value)}
                    spellCheck={false}
                    placeholder="/srv/project или ."
                    className="mt-1 w-full rounded border border-surface-3 bg-surface-0 px-3 py-2 font-mono text-xs text-content-1 outline-none focus:border-accent"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-content-2">
                    Доступ к файлам
                    <select
                      value={mode}
                      onChange={(event) => setMode(event.target.value as McpAccessMode)}
                      className="mt-1 w-full rounded border border-surface-3 bg-surface-0 px-3 py-2 text-xs text-content-1 outline-none focus:border-accent"
                    >
                      <option value="read-only">Только чтение</option>
                      <option value="read-write">Чтение и запись</option>
                    </select>
                  </label>
                  <label className="text-xs text-content-2">
                    Локальный порт
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={port}
                      onChange={(event) => setPort(Number(event.target.value))}
                      className="mt-1 w-full rounded border border-surface-3 bg-surface-0 px-3 py-2 font-mono text-xs text-content-1 outline-none focus:border-accent"
                    />
                  </label>
                </div>
                <label className="flex items-start gap-2 rounded border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-content-2">
                  <input
                    type="checkbox"
                    checked={allowExec}
                    onChange={(event) => setAllowExec(event.target.checked)}
                    className="mt-0.5 accent-[rgb(var(--accent))]"
                  />
                  <span>
                    Разрешить выполнение команд. Команды работают с правами SSH-пользователя и могут
                    обращаться за пределы выбранного каталога.
                  </span>
                </label>
                {mode === 'read-write' && (
                  <p className="rounded border border-red-500/25 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
                    Клиент сможет создавать, заменять, перемещать и удалять файлы внутри разрешённого каталога.
                  </p>
                )}
                {bridges.length > 0 && (
                  <div className="rounded border border-surface-3 bg-surface-0 p-3 text-[11px] text-content-2">
                    <p className="mb-1 font-semibold">Другие активные MCP-мосты</p>
                    {bridges.map((bridge) => (
                      <p key={bridge.termId} className="truncate">{bridge.title} · порт {bridge.port} · {bridge.root}</p>
                    ))}
                  </div>
                )}
                {error && <p className="text-xs text-red-400">{error}</p>}
                <button
                  disabled={busy || !termId}
                  onClick={() => void start()}
                  className="flex w-full items-center justify-center gap-2 rounded bg-accent px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
                >
                  <Power size={14} /> {busy ? 'Запуск…' : 'Открыть MCP-доступ'}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 rounded border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-emerald-300">MCP-мост активен</p>
                    <p className="truncate text-[11px] text-content-2">
                      {state.title} · {state.root} · {state.mode === 'read-only' ? 'только чтение' : 'чтение и запись'}
                      {state.allowExec ? ' · команды разрешены' : ''}
                    </p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => void stop()}
                    className="rounded border border-red-500/40 px-3 py-1.5 text-[11px] text-red-300 hover:bg-red-500/10"
                  >
                    Закрыть доступ
                  </button>
                </div>

                {bridges.length > 1 && (
                  <p className="text-[11px] text-content-3">
                    Одновременно работают {bridges.length} MCP-моста. Закрытие этого доступа не остановит остальные.
                  </p>
                )}

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-surface-0 px-3 py-2 text-[11px] text-content-1">
                      {state.url}
                    </code>
                    {state.url && copyBtn('url', state.url, 'URL')}
                  </div>
                  <div className="space-y-1">
                    {state.clients?.map((client) => (
                      <div key={client.id} className="flex items-center gap-2 text-[11px] text-content-2">
                        <span className="w-28 shrink-0">{client.label}</span>
                        <code className="min-w-0 flex-1 truncate rounded bg-surface-0 px-3 py-2 text-content-3">••••••••••••••••</code>
                        {copyBtn(`token-${client.id}`, client.token, 'Токен')}
                      </div>
                    ))}
                    <button
                      disabled={busy}
                      onClick={() => void rotate()}
                      title="Сменить все три токена; настройки клиентов потребуется обновить"
                      className="flex items-center gap-1 rounded border border-surface-3 px-2 py-1.5 text-content-2 hover:bg-surface-2"
                    >
                      <RefreshCw size={12} /> Сменить все токены
                    </button>
                  </div>
                </div>

                {snippets && (
                  <div className="space-y-3">
                    <p className="text-[11px] text-content-3">
                      Подключение стандартное — используйте любой MCP-клиент с HTTP-транспортом и заголовком Bearer.
                    </p>
                    {[
                      ['generic', 'Универсальная конфигурация', snippets.generic],
                      ['codex', 'Codex config.toml', snippets.codex],
                      ['claude', 'Claude Code', snippets.claude]
                    ].map(([key, label, value]) => (
                      <div key={key}>
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-[11px] font-semibold text-content-2">{label}</span>
                          {copyBtn(key, value, 'Копировать')}
                        </div>
                        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-0 p-2 font-mono text-[10px] leading-4 text-content-2">
                          {state.clients?.reduce((masked, client) => masked.replaceAll(client.token, '••••••••'), value)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}

                <div>
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-content-2">
                    <KeyRound size={12} /> Последние обращения
                  </div>
                  <div className="max-h-32 overflow-y-auto rounded border border-surface-3 bg-surface-0">
                    {state.audit.length ? state.audit.slice(0, 20).map((entry, index) => (
                      <div key={`${entry.ts}-${index}`} className="flex gap-2 border-b border-surface-3/60 px-2 py-1 text-[10px] last:border-0">
                        <span className={entry.ok ? 'text-emerald-400' : 'text-red-400'}>{entry.ok ? 'OK' : 'ERR'}</span>
                        <span className="shrink-0 text-content-3">{new Date(entry.ts).toLocaleTimeString()}</span>
                        <span className="font-mono text-content-2">{entry.tool}</span>
                        <span className="min-w-0 truncate text-content-3" title={entry.detail}>{entry.detail}</span>
                      </div>
                    )) : <p className="px-2 py-3 text-center text-[10px] text-content-3">Обращений пока нет</p>}
                  </div>
                </div>
                {error && <p className="text-xs text-red-400">{error}</p>}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
