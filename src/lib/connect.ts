import { useTabs } from '@/stores/useTabs'
import { useToasts } from '@/stores/useToasts'
import { usePasswordPrompt } from '@/stores/usePasswordPrompt'
import { useVault } from '@/stores/useVault'
import { useSessions } from '@/stores/useSessions'
import { useConnectProgress } from '@/stores/useConnectProgress'
import type { ConnectRequest } from '@shared/types'

const DEFAULT_SIZE = { cols: 100, rows: 30 }

function newAttemptId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Math.random())
}

function target(username: string, host: string, port?: number): string {
  return `${username}@${host}${port && port !== 22 ? `:${port}` : ''}`
}

function titleFor(req: ConnectRequest): string {
  if (req.sessionId) {
    const s = useSessions.getState().sessions.find((x) => x.id === req.sessionId)
    return s?.name ?? 'SSH'
  }
  if (req.profile) return target(req.profile.username, req.profile.host)
  return 'SSH'
}

/** user@host:port под названием карточки прогресса (если это не оно само). */
function subtitleFor(req: ConnectRequest): string | undefined {
  if (req.sessionId) {
    const s = useSessions.getState().sessions.find((x) => x.id === req.sessionId)
    return s && target(s.username, s.host, s.port)
  }
  return req.profile && target(req.profile.username, req.profile.host, req.profile.port)
}

export async function connectAndOpen(req: ConnectRequest, titleOverride?: string): Promise<boolean> {
  const attemptId = newAttemptId()
  const title = titleOverride ?? titleFor(req)
  const subtitle = subtitleFor(req)
  useConnectProgress.getState().start(attemptId, title, subtitle === title ? undefined : subtitle)
  const res = await window.api.ssh.connect({ size: DEFAULT_SIZE, ...req, attemptId })
  if (res.ok && res.termId) {
    useConnectProgress.getState().finish(attemptId, true)
    useTabs.getState().addTab({
      termId: res.termId,
      title: res.title ?? title,
      status: 'connected',
      sessionId: req.sessionId
    })
    return true
  }
  useConnectProgress.getState().finish(attemptId, false, res.error)
  if (res.error === 'VAULT_LOCKED') {
    void useVault.getState().refresh() // покажет экран блокировки
    useConnectProgress.getState().dismiss(attemptId)
    useToasts.getState().push('info', 'Разблокируйте хранилище мастер-паролем')
  }
  return false
}

/** Переподключает отвалившуюся вкладку сохранённой сессии, сохраняя её позицию. */
export async function reconnectTab(termId: string): Promise<void> {
  const tab = useTabs.getState().tabs.find((t) => t.termId === termId)
  if (!tab) return
  if (!tab.sessionId) {
    useToasts
      .getState()
      .push('info', 'Переподключение доступно только для сохранённых сессий')
    return
  }
  const res = await window.api.ssh.connect({ sessionId: tab.sessionId, size: DEFAULT_SIZE })
  if (res.ok && res.termId) {
    useTabs.getState().replaceTermId(termId, res.termId, res.title)
  } else {
    useToasts.getState().push('error', res.error ?? 'Не удалось переподключиться')
  }
}

/** Разделить активную SSH-вкладку: открывает ещё один shell на том же соединении. */
export async function splitActivePane(): Promise<void> {
  const { activeId, tabs } = useTabs.getState()
  const tab = tabs.find((t) => t.termId === activeId)
  if (!tab || tab.kind !== 'ssh') {
    useToasts.getState().push('info', 'Разделение доступно только для SSH-сессий')
    return
  }
  if (tab.panes.length >= 4) {
    useToasts.getState().push('info', 'Максимум 4 панели на вкладку')
    return
  }
  const res = await window.api.ssh.split(tab.termId)
  if (res.ok && res.termId) {
    useTabs.getState().addPane(tab.termId, res.termId)
  } else {
    useToasts.getState().push('error', res.error ?? 'Не удалось разделить панель')
  }
}

export async function openLocalTerminal(shell: string): Promise<void> {
  const res = await window.api.pty.spawn(shell, DEFAULT_SIZE)
  if (res.ok && res.termId) {
    useTabs.getState().addTab({
      termId: res.termId,
      title: shell.split(/[\\/]/).pop() ?? 'local',
      status: 'connected',
      kind: 'pty'
    })
  } else {
    useToasts.getState().push('error', res.error ?? 'Не удалось запустить терминал')
  }
}

/** Parse "user@host:port" (user and port optional). */
export function parseTarget(input: string): { username: string; host: string; port: number } | null {
  const m = input.trim().match(/^(?:([^@\s]+)@)?([^@:\s]+)(?::(\d{1,5}))?$/)
  if (!m || !m[2]) return null
  return {
    username: m[1] ?? 'root',
    host: m[2],
    port: m[3] ? parseInt(m[3], 10) : 22
  }
}

/** Quick connect: try the SSH agent first, fall back to a password prompt. */
export async function quickConnect(input: string): Promise<void> {
  const target = parseTarget(input)
  if (!target) {
    useToasts.getState().push('error', 'Формат: user@host:port')
    return
  }
  // Пробуем агент по-тихому (без карточки прогресса — частый быстрый путь)
  const res = await window.api.ssh.connect({
    profile: { ...target, authType: 'agent' },
    size: DEFAULT_SIZE
  })
  if (res.ok && res.termId) {
    useTabs.getState().addTab({ termId: res.termId, title: res.title ?? input, status: 'connected' })
    return
  }
  // Агент не подошёл — спрашиваем пароль и подключаемся с анимацией стадий
  const password = await usePasswordPrompt
    .getState()
    .ask(`Пароль для ${target.username}@${target.host}`)
  if (password === null) return
  await connectAndOpen(
    { profile: { ...target, authType: 'password', password } },
    `${target.username}@${target.host}`
  )
}
