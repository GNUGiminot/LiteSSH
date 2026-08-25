import { Client, type ClientChannel } from 'ssh2'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { readFileSync, createWriteStream, type WriteStream } from 'fs'
import { getKnownHostKey, saveKnownHostKey } from '../db'
import { parseKeyType, fingerprintOf } from './host-keys'
import type { HostKeyPrompt } from '@shared/types'

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB012]|\x1b[=>]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export interface ConnectProfile {
  name?: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key' | 'agent'
  password?: string
  keyPath?: string
  /** PEM приватного ключа из менеджера ключей (вместо keyPath) */
  privateKeyPem?: string
  passphrase?: string
  /** Бастион (ProxyJump): подключаемся к нему, затем forwardOut на целевой хост */
  jump?: ConnectProfile
  /** Проброс SSH-агента на удалённый хост (ForwardAgent) */
  agentForward?: boolean
}

interface ActiveTerm {
  client: Client
  stream: ClientChannel
  win: BrowserWindow
  /** Клиенты бастионов цепочки ProxyJump — закрываются вместе с сессией */
  jumpClients?: Client[]
  /** Активный лог сессии (вывод пишется без ANSI-кодов) */
  logStream?: WriteStream
}

const terms = new Map<string, ActiveTerm>()
/** Сколько панелей (shell-каналов) держат общий SSH-клиент — для split view. */
const clientRefs = new Map<Client, number>()
const hostKeyResolvers = new Map<string, (accept: boolean) => void>()
/** Слушатели закрытия терминала (для остановки туннелей). */
const closeListeners = new Set<(termId: string) => void>()

export function onTermClosed(cb: (termId: string) => void): void {
  closeListeners.add(cb)
}

function notifyClosed(termId: string): void {
  for (const cb of closeListeners) cb(termId)
}

/**
 * Устанавливает соединение с бастионом и открывает канал к целевому хосту.
 * Поддерживает цепочку: если у бастиона тоже задан jump — рекурсивно проходим её.
 * Возвращает sock до target и список всех клиентов цепочки (для закрытия).
 */
async function openViaJump(
  win: BrowserWindow,
  jump: ConnectProfile,
  target: { host: string; port: number }
): Promise<{ sock: NodeJS.ReadWriteStream; clients: Client[] }> {
  // Сначала добираемся до самого бастиона (возможно, через свою цепочку)
  let jumpSock: NodeJS.ReadWriteStream | undefined
  let chain: Client[] = []
  if (jump.jump) {
    const inner = await openViaJump(win, jump.jump, { host: jump.host, port: jump.port })
    jumpSock = inner.sock
    chain = inner.clients
  }

  return new Promise((resolve, reject) => {
    const jumpClient = new Client()
    const cleanup = () => {
      jumpClient.end()
      for (const c of chain) c.end()
    }
    jumpClient.on('ready', () => {
      jumpClient.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
        if (err) {
          cleanup()
          return reject(new Error(`Бастион ${jump.host} не смог открыть канал к ${target.host}: ${err.message}`))
        }
        // порядок: внешний бастион(ы) ... этот бастион
        resolve({ sock: stream, clients: [...chain, jumpClient] })
      })
    })
    jumpClient.on('error', (err) => {
      cleanup()
      reject(new Error(`Ошибка бастиона ${jump.host}: ${err.message}`))
    })
    jumpClient.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => jump.password ?? ''))
    })
    try {
      const cfg = buildConfig(win, jump)
      if (jumpSock) (cfg as { sock?: NodeJS.ReadWriteStream }).sock = jumpSock
      jumpClient.connect(cfg)
    } catch (e) {
      cleanup()
      reject(e as Error)
    }
  })
}

export function respondHostKey(requestId: string, accept: boolean): void {
  const resolve = hostKeyResolvers.get(requestId)
  hostKeyResolvers.delete(requestId)
  resolve?.(accept)
}

function defaultAgent(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  return undefined
}

async function verifyHostKey(win: BrowserWindow, profile: ConnectProfile, key: Buffer): Promise<boolean> {
  const keyType = parseKeyType(key)
  const fingerprint = fingerprintOf(key)
  const known = getKnownHostKey(profile.host, profile.port, keyType)
  if (known === fingerprint) return true

  const prompt: HostKeyPrompt = {
    requestId: randomUUID(),
    host: profile.host,
    port: profile.port,
    keyType,
    fingerprint,
    changed: known !== undefined
  }
  const accepted = await new Promise<boolean>((resolve) => {
    hostKeyResolvers.set(prompt.requestId, resolve)
    if (win.isDestroyed()) return resolve(false)
    win.webContents.send('hostkey:prompt', prompt)
    // Never hang a connection forever on an unanswered dialog
    setTimeout(() => {
      if (hostKeyResolvers.delete(prompt.requestId)) resolve(false)
    }, 120_000)
  })
  if (accepted) saveKnownHostKey(profile.host, profile.port, keyType, fingerprint)
  return accepted
}

function buildConfig(
  win: BrowserWindow,
  profile: ConnectProfile,
  onHostKey?: (phase: 'start' | 'done') => void
): Parameters<Client['connect']>[0] {
  const cfg: Parameters<Client['connect']>[0] = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    tryKeyboard: true,
    hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
      onHostKey?.('start')
      verifyHostKey(win, profile, key)
        .then((ok) => {
          onHostKey?.('done')
          verify(ok)
        })
        .catch(() => verify(false))
    }
  }
  if (profile.authType === 'password') {
    cfg.password = profile.password ?? ''
  } else if (profile.authType === 'key') {
    if (profile.privateKeyPem) {
      cfg.privateKey = profile.privateKeyPem
    } else {
      if (!profile.keyPath) throw new Error('Не указан путь к приватному ключу')
      try {
        cfg.privateKey = readFileSync(profile.keyPath)
      } catch (e) {
        throw new Error(`Не удалось прочитать ключ: ${(e as Error).message}`)
      }
    }
    if (profile.passphrase) cfg.passphrase = profile.passphrase
  } else {
    const agent = defaultAgent()
    if (!agent) throw new Error('SSH-агент не найден (SSH_AUTH_SOCK не задан)')
    cfg.agent = agent
  }
  // Проброс агента требует доступного агента (даже при аутентификации ключом/паролем)
  if (profile.agentForward) {
    const agent = cfg.agent ?? defaultAgent()
    if (agent) {
      cfg.agent = agent
      cfg.agentForward = true
    }
  }
  return cfg
}

export function getClient(termId: string): Client | undefined {
  return terms.get(termId)?.client
}

/** Выполнить команду на уже открытом клиенте (для метрик и т.п.), без нового подключения. */
export function execOnClient(
  termId: string,
  command: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const client = terms.get(termId)?.client
    if (!client) return reject(new Error('SSH-сессия не активна'))
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', (d: Buffer) => (stdout += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      stream.on('close', (code: number) => resolve({ code: code ?? 0, stdout, stderr }))
    })
  })
}

/** Одноразовое подключение для exec-команды (деплой ключей и т.п.). */
export function execOnProfile(
  win: BrowserWindow,
  profile: ConnectProfile,
  command: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      client.end()
      reject(err)
    }
    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) return fail(err)
        let stdout = ''
        let stderr = ''
        stream.on('data', (d: Buffer) => (stdout += d.toString()))
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
        stream.on('close', (code: number) => {
          settled = true
          client.end()
          resolve({ code: code ?? 0, stdout, stderr })
        })
      })
    })
    client.on('error', fail)
    client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => profile.password ?? ''))
    })
    try {
      client.connect(buildConfig(win, profile))
    } catch (e) {
      fail(e as Error)
    }
  })
}

/** Освобождает одну панель; общий клиент закрывается только когда снята последняя ссылка. */
function releasePane(termId: string): void {
  const t = terms.get(termId)
  if (!t) return
  t.logStream?.end()
  terms.delete(termId)
  notifyClosed(termId)
  const n = (clientRefs.get(t.client) ?? 1) - 1
  if (n <= 0) {
    clientRefs.delete(t.client)
    t.client.end()
    t.jumpClients?.forEach((c) => c.end())
  } else {
    clientRefs.set(t.client, n)
  }
  if (!t.win.isDestroyed()) t.win.webContents.send('term:exit', termId)
}

/** Обрыв на уровне соединения — гасит все панели этого клиента. */
function failClient(client: Client, message?: string): void {
  let jumps: Client[] | undefined
  for (const [id, t] of [...terms]) {
    if (t.client !== client) continue
    jumps = jumps ?? t.jumpClients
    t.logStream?.end()
    terms.delete(id)
    notifyClosed(id)
    if (!t.win.isDestroyed()) t.win.webContents.send('term:exit', id, message)
  }
  clientRefs.delete(client)
  jumps?.forEach((c) => c.end())
}

/** Провод shell-потока: батчинг вывода в renderer + журналирование + закрытие панели. */
function wireShellStream(
  win: BrowserWindow,
  termId: string,
  stream: ClientChannel
): void {
  let pending: Buffer[] = []
  let scheduled = false
  const flush = () => {
    scheduled = false
    if (!pending.length) return
    const data = Buffer.concat(pending)
    pending = []
    const log = terms.get(termId)?.logStream
    if (log) log.write(stripAnsi(data.toString('utf8')))
    if (!win.isDestroyed()) win.webContents.send('term:data', termId, data)
  }
  const onData = (d: Buffer) => {
    pending.push(d)
    if (!scheduled) {
      scheduled = true
      setTimeout(flush, 8)
    }
  }
  stream.on('data', onData)
  stream.stderr.on('data', onData)
  stream.on('close', () => releasePane(termId))
}

/** Открывает ещё один shell-канал на уже существующем соединении (для split view). */
export function openExtraShell(
  sourceTermId: string,
  size: { cols: number; rows: number }
): Promise<{ termId: string }> {
  return new Promise((resolve, reject) => {
    const src = terms.get(sourceTermId)
    if (!src) return reject(new Error('Исходная сессия не активна'))
    const { client, win } = src
    client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, stream) => {
      if (err) return reject(err)
      const termId = randomUUID()
      terms.set(termId, { client, stream, win })
      clientRefs.set(client, (clientRefs.get(client) ?? 1) + 1)
      wireShellStream(win, termId, stream)
      resolve({ termId })
    })
  })
}

export function connect(
  win: BrowserWindow,
  profile: ConnectProfile,
  size: { cols: number; rows: number },
  attemptId?: string
): Promise<{ termId: string; title: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const termId = randomUUID()
    const title = profile.name || `${profile.username}@${profile.host}`
    let settled = false
    let jumpClients: Client[] | undefined

    // Прогресс стадий подключения — для анимации в renderer
    let activeStage: 'connect' | 'hostkey' | 'auth' | 'shell' = 'connect'
    const emit = (stage: typeof activeStage, status: 'active' | 'done' | 'error', error?: string) => {
      if (!attemptId || win.isDestroyed()) return
      if (status === 'active') activeStage = stage
      win.webContents.send('ssh:progress', { attemptId, stage, status, error })
    }
    emit('connect', 'active')

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      emit(activeStage, 'error', err.message)
      client.end()
      jumpClients?.forEach((c) => c.end())
      reject(err)
    }

    // Стадии по событиям ssh2: hostVerifier → handshake → auth → ready → shell
    client.on('handshake', () => {
      emit('auth', 'active')
    })
    client.on('ready', () => {
      emit('auth', 'done')
      emit('shell', 'active')
      client.shell(
        {
          term: 'xterm-256color',
          cols: size.cols,
          rows: size.rows,
          ...(profile.agentForward ? { agentForward: true } : {})
        },
        (err, stream) => {
          if (err) return fail(err)
          terms.set(termId, { client, stream, win, jumpClients })
          clientRefs.set(client, 1)
          wireShellStream(win, termId, stream)
          emit('shell', 'done')
          settled = true
          resolve({ termId, title })
        }
      )
    })

    client.on('error', (err) => {
      if (!settled) return fail(err)
      failClient(client, err.message)
    })

    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(() => profile.password ?? ''))
    })

    client.on('close', () => {
      if ([...terms.values()].some((t) => t.client === client)) failClient(client)
    })

    const startConnect = () => {
      try {
        const cfg = buildConfig(win, profile, (phase) => {
          if (phase === 'start') {
            emit('connect', 'done')
            emit('hostkey', 'active')
          } else {
            emit('hostkey', 'done')
          }
        })
        if (pendingSock) {
          // при ProxyJump хост/порт неважны — соединение идёт через sock
          ;(cfg as { sock?: NodeJS.ReadWriteStream }).sock = pendingSock
        }
        client.connect(cfg)
      } catch (e) {
        fail(e as Error)
      }
    }

    let pendingSock: NodeJS.ReadWriteStream | undefined
    if (profile.jump) {
      openViaJump(win, profile.jump, { host: profile.host, port: profile.port })
        .then(({ sock, clients }) => {
          jumpClients = clients
          pendingSock = sock
          startConnect()
        })
        .catch(fail)
    } else {
      startConnect()
    }
  })
}

export function writeTerm(termId: string, data: string): void {
  terms.get(termId)?.stream.write(data)
}

export function isLogging(termId: string): boolean {
  return !!terms.get(termId)?.logStream
}

export function startLogging(termId: string, filePath: string): void {
  const t = terms.get(termId)
  if (!t) throw new Error('Сессия не активна')
  t.logStream?.end()
  const stream = createWriteStream(filePath, { flags: 'a' })
  stream.write(`\n===== LiteSSH log ${new Date().toISOString()} =====\n`)
  t.logStream = stream
}

export function stopLogging(termId: string): void {
  const t = terms.get(termId)
  if (t?.logStream) {
    t.logStream.end()
    t.logStream = undefined
  }
}

export function resizeTerm(termId: string, cols: number, rows: number): void {
  terms.get(termId)?.stream.setWindow(rows, cols, 0, 0)
}

export function closeTerm(termId: string): void {
  const t = terms.get(termId)
  if (!t) return
  // завершаем поток панели; releasePane (по событию close) снимет ссылку и,
  // если это была последняя панель, закроет общий клиент
  t.stream.end()
  releasePane(termId)
}

export function closeAll(): void {
  for (const [, t] of terms) {
    try {
      t.client.end()
    } catch {
      /* ignore */
    }
  }
  terms.clear()
  clientRefs.clear()
}
