import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRightLeft, Play, Plus, Square, Trash2, X } from 'lucide-react'
import { useTabs } from '@/stores/useTabs'
import { useToasts } from '@/stores/useToasts'
import type { TunnelConfig, TunnelState, TunnelType } from '@shared/types'

interface Props {
  open: boolean
  onClose: () => void
}

const TYPE_LABEL: Record<TunnelType, string> = {
  local: 'Local (-L)',
  remote: 'Remote (-R)',
  dynamic: 'Dynamic SOCKS (-D)'
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

const EMPTY_FORM = {
  type: 'local' as TunnelType,
  srcHost: '127.0.0.1',
  srcPort: 8080,
  dstHost: '127.0.0.1',
  dstPort: 80,
  autostart: false
}

export function TunnelsDialog({ open, onClose }: Props) {
  const { tabs, activeId } = useTabs()
  const push = useToasts((s) => s.push)
  const activeTab = tabs.find((t) => t.termId === activeId)
  const sessionId = activeTab?.sessionId
  const [tunnels, setTunnels] = useState<TunnelConfig[]>([])
  const [states, setStates] = useState<Record<string, TunnelState>>({})
  const [form, setForm] = useState(EMPTY_FORM)
  const [adding, setAdding] = useState(false)

  const reload = async () => {
    if (sessionId) setTunnels(await window.api.tunnels.list(sessionId))
  }

  useEffect(() => {
    if (open) void reload()
  }, [open, sessionId])

  useEffect(() => {
    if (!open) return
    void window.api.tunnels.states().then((list) => {
      setStates(Object.fromEntries(list.map((s) => [s.id, s])))
    })
    return window.api.tunnels.onState((list) => {
      setStates(Object.fromEntries(list.map((s) => [s.id, s])))
    })
  }, [open])

  const saveForm = async () => {
    if (!sessionId) return
    await window.api.tunnels.save({ ...form, sessionId })
    setAdding(false)
    setForm(EMPTY_FORM)
    await reload()
  }

  const start = async (t: TunnelConfig) => {
    if (!activeId) return push('error', 'Нет активной сессии')
    const res = await window.api.tunnels.start(activeId, t.id)
    if (!res.ok) push('error', res.error ?? 'Не удалось запустить туннель')
  }

  const field =
    'rounded-md border border-surface-3 bg-surface-0 px-2 py-1 text-xs text-content-1 outline-none focus:border-accent'

  if (!open) return null

  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[600px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-content-1">
              <ArrowRightLeft size={16} className="text-accent" /> Туннели
              {activeTab && <span className="text-xs font-normal text-content-3">— {activeTab.title}</span>}
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
              <X size={15} />
            </Dialog.Close>
          </div>

          {!sessionId ? (
            <p className="py-6 text-center text-xs text-content-3">
              Туннели привязаны к сохранённой сессии. Откройте вкладку сохранённой сессии, чтобы
              управлять её туннелями.
            </p>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-surface-3">
                {tunnels.length === 0 && (
                  <p className="px-3 py-4 text-xs text-content-3">Нет туннелей для этой сессии.</p>
                )}
                {tunnels.map((t) => {
                  const st = states[t.id]
                  const running = st?.running
                  return (
                    <div
                      key={t.id}
                      className="flex items-center gap-2 border-b border-surface-3 px-3 py-2 last:border-0"
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          running ? 'bg-emerald-500' : st?.error ? 'bg-red-500' : 'bg-content-3'
                        }`}
                        title={st?.error ?? (running ? 'активен' : 'остановлен')}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-content-1">
                          {TYPE_LABEL[t.type]} · {t.srcHost}:{t.srcPort}
                          {t.type !== 'dynamic' && ` → ${t.dstHost}:${t.dstPort}`}
                        </div>
                        <div className="text-[10px] text-content-3">
                          {st
                            ? `соединений: ${st.conns} · ↓${humanSize(st.bytesIn)} ↑${humanSize(st.bytesOut)}`
                            : t.autostart
                              ? 'автозапуск'
                              : 'вручную'}
                        </div>
                      </div>
                      {running ? (
                        <button
                          onClick={() => window.api.tunnels.stop(t.id)}
                          title="Остановить"
                          className="rounded p-1 text-content-2 hover:bg-surface-2 hover:text-red-400"
                        >
                          <Square size={13} />
                        </button>
                      ) : (
                        <button
                          onClick={() => void start(t)}
                          title="Запустить"
                          className="rounded p-1 text-content-2 hover:bg-surface-2 hover:text-emerald-400"
                        >
                          <Play size={13} />
                        </button>
                      )}
                      <button
                        onClick={() => void window.api.tunnels.remove(t.id).then(reload)}
                        title="Удалить"
                        className="rounded p-1 text-content-2 hover:bg-surface-2 hover:text-red-400"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>

              {adding ? (
                <div className="mt-3 space-y-2 rounded-md border border-surface-3 p-3">
                  <div className="flex items-center gap-2">
                    <select
                      className={field}
                      value={form.type}
                      onChange={(e) => setForm({ ...form, type: e.target.value as TunnelType })}
                    >
                      <option value="local">Local (-L)</option>
                      <option value="remote">Remote (-R)</option>
                      <option value="dynamic">Dynamic SOCKS (-D)</option>
                    </select>
                    <label className="flex items-center gap-1 text-[11px] text-content-2">
                      <input
                        type="checkbox"
                        checked={form.autostart}
                        onChange={(e) => setForm({ ...form, autostart: e.target.checked })}
                        className="accent-accent"
                      />
                      автозапуск
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      className={`${field} w-28`}
                      value={form.srcHost}
                      onChange={(e) => setForm({ ...form, srcHost: e.target.value })}
                      placeholder={form.type === 'remote' ? '0.0.0.0' : '127.0.0.1'}
                    />
                    <input
                      className={`${field} w-20`}
                      type="number"
                      value={form.srcPort}
                      onChange={(e) => setForm({ ...form, srcPort: Number(e.target.value) })}
                      placeholder="порт"
                    />
                    {form.type !== 'dynamic' && (
                      <>
                        <span className="text-content-3">→</span>
                        <input
                          className={`${field} flex-1`}
                          value={form.dstHost}
                          onChange={(e) => setForm({ ...form, dstHost: e.target.value })}
                          placeholder="целевой хост"
                        />
                        <input
                          className={`${field} w-20`}
                          type="number"
                          value={form.dstPort}
                          onChange={(e) => setForm({ ...form, dstPort: Number(e.target.value) })}
                          placeholder="порт"
                        />
                      </>
                    )}
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setAdding(false)}
                      className="rounded-md px-3 py-1 text-xs text-content-2 hover:bg-surface-2"
                    >
                      Отмена
                    </button>
                    <button
                      onClick={() => void saveForm()}
                      className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover"
                    >
                      Добавить
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setAdding(true)}
                  className="mt-3 flex items-center justify-center gap-1 rounded-md border border-dashed border-surface-3 py-2 text-xs text-content-2 hover:bg-surface-2 hover:text-content-1"
                >
                  <Plus size={13} /> Новый туннель
                </button>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
