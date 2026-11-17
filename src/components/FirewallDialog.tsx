import { useCallback, useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ExternalLink, Pause, Play, RefreshCw, Shield, Trash2, X } from 'lucide-react'
import type { FirewallAction, FirewallProbe, FirewallResult, FirewallState } from '@shared/types'
import { usePasswordPrompt } from '@/stores/usePasswordPrompt'
import { useConfirm } from '@/stores/useConfirm'
import { useToasts } from '@/stores/useToasts'

interface Props {
  open: boolean
  termId: string | null
  title: string
  onClose: () => void
}

type Phase = 'loading' | 'install' | 'ready' | 'error'

const input =
  'rounded-md border border-surface-3 bg-surface-0 px-2 py-1 text-xs text-content-1 outline-none focus:border-accent'
const btn = 'rounded-md px-2.5 py-1 text-xs text-content-2 hover:bg-surface-2 hover:text-content-1 disabled:opacity-50'
const primary = 'rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50'

const ACTION_LABEL: Record<string, string> = { allow: 'открыт', deny: 'закрыт', reject: 'отклонён' }
const POLICY_LABEL: Record<string, string> = { allow: 'разрешён', deny: 'запрещён', reject: 'отклоняется' }
const KIND_LABEL: Record<string, string> = { lease: 'сейчас', daily: 'ежедневно', once: 'однократно' }

function fmtTime(iso?: string): string {
  if (!iso || iso.startsWith('0001')) return '—'
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function FirewallDialog({ open, termId, title, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [probe, setProbe] = useState<FirewallProbe | null>(null)
  const [state, setState] = useState<FirewallState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [now, setNow] = useState(Date.now())
  const [rule, setRule] = useState({ action: 'allow', port: '', protocol: 'tcp', source: '', comment: '' })
  const [lease, setLease] = useState({ port: '', protocol: 'tcp', source: '', duration: '1h' })
  const alive = useRef(true)
  const toast = useToasts.getState().push

  /** Вызов, которому может понадобиться пароль sudo: спросить и повторить. */
  const withPassword = useCallback(
    async <T extends FirewallResult>(fn: (password?: string) => Promise<T>): Promise<T | null> => {
      let res = await fn()
      for (let i = 0; i < 3 && res.needPassword; i++) {
        const pw = await usePasswordPrompt.getState().ask(`${res.error ?? 'Пароль sudo'} — ${title}`)
        if (pw === null) return null
        res = await fn(pw)
      }
      return res
    },
    [title]
  )

  /** Запрос к API панели; если для перевыдачи токена нужен пароль — через connect(пароль). */
  const call = useCallback(
    async <T extends FirewallResult>(fn: () => Promise<T>): Promise<T | null> => {
      if (!termId) return null
      let res = await fn()
      if (res.needPassword) {
        const c = await withPassword((pw) => window.api.firewall.connect(termId, pw))
        if (!c?.ok) return c ? ({ ...c } as T) : null
        res = await fn()
      }
      return res
    },
    [termId, withPassword]
  )

  const refresh = useCallback(async () => {
    if (!termId) return
    const res = await call(() => window.api.firewall.state(termId))
    if (!alive.current || !res) return
    if (res.ok && res.state) {
      setState(res.state)
      setError('')
    } else setError(res.error ?? 'Не удалось получить состояние')
  }, [termId, call])

  const start = useCallback(async () => {
    if (!termId) return
    setPhase('loading')
    setError('')
    const p = await window.api.firewall.probe(termId)
    if (!alive.current) return
    if (!p.ok || !p.probe) {
      setError(p.error ?? 'Не удалось проверить сервер')
      return setPhase('error')
    }
    setProbe(p.probe)
    if (!p.probe.installed) return setPhase('install')
    const c = await withPassword((pw) => window.api.firewall.connect(termId, pw))
    if (!alive.current) return
    if (!c?.ok) {
      setError(c?.error ?? 'Пароль sudo не введён')
      return setPhase('error')
    }
    setPhase('ready')
    await refresh()
  }, [termId, withPassword, refresh])

  useEffect(() => {
    alive.current = true
    if (open && termId) {
      setState(null)
      void start()
    }
    return () => {
      alive.current = false
    }
  }, [open, termId, start])

  useEffect(() => {
    if (!open || phase !== 'ready') return
    const poll = setInterval(() => void refresh(), 8000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [open, phase, refresh])

  const run = async (action: FirewallAction, label: string) => {
    if (!termId) return
    setBusy(label)
    try {
      const res = await call(() =>
        window.api.firewall.action(termId, { ...action, revision: action.revision ?? state?.revision })
      )
      if (!res) return
      if (!res.ok) return toast('error', res.error ?? 'Операция отклонена')
      // Операция выполняется на сервере в фоне — ждём результат
      for (let i = 0; i < 120; i++) {
        const j = await call(() => window.api.firewall.job(termId))
        if (!j?.ok || !j.job) {
          toast('error', j?.error ?? 'Нет ответа о результате')
          break
        }
        if (!j.job.running) {
          if (j.job.error) toast('error', j.job.error)
          else toast('success', j.job.message || 'Готово')
          break
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const install = async (source: 'github' | 'file') => {
    if (!termId) return
    const ok = await useConfirm.getState().ask(
      source === 'github'
        ? 'LiteSSH скачает последний выпуск VPSWall с GitHub, сверит SHA-256 архива по SHA256SUMS.txt того же выпуска, загрузит install.sh, бинарник и файл контрольных сумм в /tmp сервера по SFTP и выполнит install.sh от root.\n\nУстановка не включает firewall и не меняет правила — это делается потом в панели с откатом через 120 с.'
        : 'Выберите zip-релиз VPSWall. LiteSSH загрузит из него install.sh и бинарник в /tmp сервера по SFTP и выполнит install.sh от root.\n\nУстановка не включает firewall и не меняет правила.',
      { title: 'Установить VPSWall на сервер?', confirmLabel: 'Установить', danger: false }
    )
    if (!ok) return
    setBusy('install')
    try {
      const res = await withPassword((pw) => window.api.firewall.install(termId, source, pw))
      if (!res || res.canceled) return
      if (!res.ok) return toast('error', res.error ?? 'Установка не удалась')
      toast('success', res.message || 'VPSWall установлен')
      await start()
    } finally {
      setBusy('')
    }
  }

  const confirmPending = async () => {
    if (!termId || !state?.pending) return
    const p = state.pending
    setBusy('confirm')
    try {
      const res = await withPassword((pw) => window.api.firewall.confirm(termId, p.token, p.ssh_port, pw))
      if (!res) return
      if (res.ok) toast('success', `Подтверждено из нового SSH-подключения (порт ${res.port})`)
      else toast('error', res.error ?? 'Подтверждение не удалось')
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const disableWeb = async () => {
    if (!termId) return
    const ok = await useConfirm.getState().ask(
      'Служба vpswall-web будет остановлена, токен отозван. Правила firewall и окна портов продолжат работать.',
      { title: 'Отключить веб-службу VPSWall?', confirmLabel: 'Отключить', danger: true }
    )
    if (!ok) return
    const res = await withPassword((pw) => window.api.firewall.disableWeb(termId, pw))
    if (!res) return
    if (!res.ok) return toast('error', res.error ?? 'Не удалось отключить')
    toast('success', 'Веб-служба VPSWall отключена')
    onClose()
  }

  if (!open) return null

  const rules = state?.config.rules ?? []
  const pending = state?.pending
  const left = pending ? Math.max(0, Math.ceil((new Date(pending.deadline).getTime() - now) / 1000)) : 0
  const locked = !!busy || !!pending

  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[720px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
          <div className="mb-3 flex items-center justify-between gap-2">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-content-1">
              <Shield size={16} className="text-accent" /> Сетевой экран
              <span className="text-xs font-normal text-content-3">— {title}</span>
            </Dialog.Title>
            <div className="flex items-center gap-1">
              {phase === 'ready' && (
                <>
                  <button className={btn} title="Обновить" onClick={() => void refresh()}>
                    <RefreshCw size={13} />
                  </button>
                  <button
                    className={btn}
                    onClick={async () => {
                      if (!termId) return
                      const res = await call(() => window.api.firewall.panel(termId, title))
                      if (res && !res.ok) toast('error', res.error ?? 'Не удалось открыть панель')
                    }}
                  >
                    <ExternalLink size={13} className="mr-1 inline" />
                    Полная панель
                  </button>
                </>
              )}
              <Dialog.Close className="rounded p-1 text-content-2 hover:bg-surface-2">
                <X size={15} />
              </Dialog.Close>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {phase === 'loading' && <p className="py-8 text-center text-xs text-content-3">Проверка VPSWall на сервере…</p>}

            {phase === 'error' && (
              <div className="py-6 text-center">
                <p className="mb-3 text-xs text-red-400">{error}</p>
                <button className={btn} onClick={() => void start()}>
                  Повторить
                </button>
              </div>
            )}

            {phase === 'install' && probe && (
              <div className="space-y-3 text-xs text-content-2">
                <p>
                  На сервере не найден <b className="text-content-1">VPSWall</b> — менеджер правил UFW / firewalld /
                  nftables / iptables с веб-панелью и автоматическим откатом изменений, если доступ потерян.
                </p>
                <ul className="list-inside list-disc text-content-3">
                  <li>Система: {probe.linux ? 'Linux' : 'не Linux'}, systemd: {probe.systemd ? 'есть' : 'нет'}</li>
                  <li>Архитектура: {probe.machine || '?'} {probe.arch ? `(${probe.arch})` : '— не поддерживается'}</li>
                  <li>
                    Права root:{' '}
                    {probe.privilege === 'root'
                      ? 'вход под root'
                      : probe.privilege === 'sudo'
                        ? 'sudo без пароля'
                        : probe.privilege === 'sudo-password'
                          ? 'sudo спросит пароль'
                          : 'нет sudo'}
                  </li>
                </ul>
                {probe.linux && probe.systemd && probe.arch && probe.canRoot ? (
                  <div className="flex gap-2">
                    <button className={primary} disabled={!!busy} onClick={() => void install('github')}>
                      {busy === 'install' ? 'Установка…' : 'Установить с GitHub (последний выпуск)'}
                    </button>
                    <button className={btn} disabled={!!busy} onClick={() => void install('file')}>
                      Выбрать zip…
                    </button>
                  </div>
                ) : (
                  <p className="text-red-400">Установка на этот сервер невозможна: нужен Linux с systemd, amd64/arm64 и права root.</p>
                )}
              </div>
            )}

            {phase === 'ready' && (
              <div className="space-y-4">
                {error && <p className="text-xs text-red-400">{error}</p>}
                {state && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-content-3">
                    <span>
                      VPSWall {state.version} · {state.host}
                      {state.demo ? ' · демо' : ''}
                    </span>
                    <span>
                      {state.config.backend || 'backend не выбран'} ·{' '}
                      <b className={state.config.enabled ? 'text-emerald-500' : 'text-yellow-500'}>
                        {state.config.enabled ? 'включён' : 'выключен'}
                      </b>
                    </span>
                    <span>прочий входящий: {POLICY_LABEL[state.config.policy] ?? (state.config.policy || '—')}</span>
                    {state.ssh_port && <span>SSH-порт сессии: {state.ssh_port}</span>}
                  </div>
                )}

                {pending && (
                  <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-3 text-xs">
                    <div className="mb-1 font-semibold text-content-1">
                      Ожидает подтверждения · откат через {left} с
                    </div>
                    <div className="mb-2 text-content-2">{pending.description}</div>
                    <div className="mb-2 text-content-3">
                      Подтверждение выполняется из нового SSH-подключения
                      {pending.ssh_port ? ` на порт ${pending.ssh_port}` : ''}: если оно не пройдёт — правило не
                      подтверждено и VPSWall откатит изменение сам.
                    </div>
                    <div className="flex gap-2">
                      <button className={primary} disabled={!!busy} onClick={() => void confirmPending()}>
                        {busy === 'confirm' ? 'Подтверждение…' : 'Подтвердить из нового SSH'}
                      </button>
                      <button className={btn} disabled={!!busy} onClick={() => void run({ op: 'rollback' }, 'rollback')}>
                        Отменить изменение
                      </button>
                    </div>
                  </div>
                )}

                <section>
                  <h3 className="mb-1.5 text-xs font-semibold text-content-1">Порты и правила VPSWall</h3>
                  {rules.length === 0 ? (
                    <p className="text-xs text-content-3">Своих правил нет. Чужие системные правила — в полной панели, раздел «Диагностика».</p>
                  ) : (
                    <table className="w-full text-xs">
                      <tbody>
                        {[...rules]
                          .sort((a, b) => a.priority - b.priority)
                          .map((r) => (
                            <tr key={r.id} className="border-t border-surface-3">
                              <td className="py-1 pr-2 font-mono text-content-1">
                                {r.port}/{r.protocol}
                              </td>
                              <td className={`py-1 pr-2 ${r.action === 'allow' ? 'text-emerald-500' : 'text-red-400'}`}>
                                {ACTION_LABEL[r.action] ?? r.action}
                              </td>
                              <td className="py-1 pr-2 text-content-2">{r.source === 'any' ? 'все' : r.source}</td>
                              <td className="py-1 pr-2 text-content-3">{r.comment}</td>
                              <td className="py-1 text-right">
                                <button
                                  className={btn}
                                  disabled={locked || r.auto_ssh}
                                  title={r.auto_ssh ? 'Правило доступа SSH — меняйте через SSH-мастер в полной панели' : 'Удалить правило'}
                                  onClick={() => void run({ op: 'rule-delete', id: r.id }, 'delete')}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <select className={input} value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value })}>
                      <option value="allow">Открыть</option>
                      <option value="deny">Закрыть</option>
                    </select>
                    <input className={`${input} w-24`} placeholder="порт: 443" value={rule.port} onChange={(e) => setRule({ ...rule, port: e.target.value.trim() })} />
                    <select className={input} value={rule.protocol} onChange={(e) => setRule({ ...rule, protocol: e.target.value })}>
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                    </select>
                    <input className={`${input} w-32`} placeholder="откуда: все / IP / подсеть" value={rule.source} onChange={(e) => setRule({ ...rule, source: e.target.value.trim() })} />
                    <input className={`${input} w-32`} placeholder="комментарий" value={rule.comment} onChange={(e) => setRule({ ...rule, comment: e.target.value })} />
                    <button
                      className={primary}
                      disabled={locked || !rule.port}
                      onClick={() =>
                        void run(
                          {
                            op: 'rule-save',
                            action: rule.action as 'allow' | 'deny',
                            port: rule.port,
                            protocol: rule.protocol,
                            source: rule.source || 'any',
                            comment: rule.comment,
                            priority: 5000
                          },
                          'rule'
                        )
                      }
                    >
                      Применить
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] text-content-3">
                    Изменение правил VPSWall откатит через 120 с, если его не подтвердить из нового SSH-подключения.
                  </p>
                </section>

                <section>
                  <h3 className="mb-1.5 text-xs font-semibold text-content-1">Временные окна</h3>
                  {state?.windows.length ? (
                    <table className="w-full text-xs">
                      <tbody>
                        {state.windows.map((w) => (
                          <tr key={w.id} className="border-t border-surface-3">
                            <td className="py-1 pr-2 font-mono text-content-1">
                              {w.rule.port}/{w.rule.protocol}
                            </td>
                            <td className="py-1 pr-2 text-content-2">
                              {KIND_LABEL[w.kind] ?? w.kind}
                              {w.kind === 'daily' ? ` ${w.clock} ${w.zone}` : ''}
                            </td>
                            <td className={`py-1 pr-2 ${w.active ? 'text-emerald-500' : 'text-content-3'}`}>
                              {w.paused ? 'пауза' : w.active ? `открыт до ${fmtTime(w.end)}` : `след.: ${fmtTime(w.next)}`}
                            </td>
                            <td className="py-1 text-right">
                              <button className={btn} disabled={!!busy} title={w.paused ? 'Продолжить' : 'Пауза'} onClick={() => void run({ op: 'window-pause', id: w.id }, 'pause')}>
                                {w.paused ? <Play size={12} /> : <Pause size={12} />}
                              </button>
                              <button className={btn} disabled={!!busy} title="Удалить окно" onClick={() => void run({ op: 'window-delete', id: w.id }, 'wdel')}>
                                <Trash2 size={12} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-xs text-content-3">Нет окон. Расписания (ежедневно, на дату) — в полной панели.</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-content-2">Открыть сейчас</span>
                    <input className={`${input} w-24`} placeholder="порт: 80" value={lease.port} onChange={(e) => setLease({ ...lease, port: e.target.value.trim() })} />
                    <select className={input} value={lease.protocol} onChange={(e) => setLease({ ...lease, protocol: e.target.value })}>
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                    </select>
                    <input className={`${input} w-32`} placeholder="откуда: все / IP" value={lease.source} onChange={(e) => setLease({ ...lease, source: e.target.value.trim() })} />
                    <select className={input} value={lease.duration} onChange={(e) => setLease({ ...lease, duration: e.target.value })}>
                      {['15m', '30m', '1h', '2h', '4h', '8h', '24h'].map((d) => (
                        <option key={d} value={d}>
                          на {d.replace('m', ' мин').replace('h', ' ч')}
                        </option>
                      ))}
                    </select>
                    <button
                      className={primary}
                      disabled={locked || !lease.port}
                      onClick={() =>
                        void run(
                          { op: 'window-add', kind: 'lease', port: lease.port, protocol: lease.protocol, source: lease.source || 'any', duration: lease.duration },
                          'lease'
                        )
                      }
                    >
                      Открыть
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] text-content-3">Окно закроется само (планировщик VPSWall), даже без открытого LiteSSH.</p>
                </section>

                <div className="flex justify-end border-t border-surface-3 pt-3">
                  <button className={btn} disabled={!!busy} onClick={() => void disableWeb()}>
                    Отключить веб-службу
                  </button>
                </div>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
