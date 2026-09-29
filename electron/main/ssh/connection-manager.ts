import { Client, type ClientChannel } from 'ssh2'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { readFileSync, createWriteStream, type WriteStream } from 'fs'
import { StringDecoder } from 'string_decoder'
import { getKnownHostKey, listKnownHostKeyTypes, saveKnownHostKey } from '../db'
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
  logDecoder?: StringDecoder
  /** Renderer смонтировал терминал; до этого вывод копится в backlog, чтобы не потерять баннер. */
  attached: boolean
  backlog: Buffer[]
  backlogBytes: number
}

/** Предел вывода, который держим до монтирования терминала. */
const MAX_BACKLOG_BYTES = 2 * 1024 * 1024
/** Время на установку соединения без учёта ожидания ответа в диалоге ключа хоста. */
const READY_TIMEOUT_MS = 20_000
/** Сколько ждём решения пользователя по ключу хоста. */
const HOST_KEY_PROMPT_MS = 120_000

const terms = new Map<string, ActiveTerm>()
/** Сколько панелей (shell-каналов) держат общий SSH-клиент — для split view. */
const clientRefs = new Map<Client, number>()
const hostKeyResolvers = new Map<string, (accept: boolean) => void>()
/** Слушатели закрытия терминала (для остановки туннелей). */
const closeListeners = new Set<(termId: string) => void>()
/** Слушатели передачи соединения другой панели (split: закрылась главная панель, клиент жив). */
const moveListeners = new Set<(fromTermId: string, toTermId: string) => void>()

export function onTermClosed(cb: (termId: string) => void): void {
  closeListeners.add(cb)
}

export function onTermMoved(cb: (fromTermId: string, toTermId: string) => void): void {
  moveListeners.add(cb)
}

function notifyClosed(termId: string): void {
  for (const cb of closeListeners) cb(termId)
}

function notifyMoved(fromTermId: string, toTermId: string): void {
  for (const cb of moveListeners) cb(fromTermId, toTermId)
}

/**
 * Таймаут подключения, который замирает, пока открыт диалог ключа хоста.
 * Встроенный readyTimeout ssh2 тикает и во время диалога — соединение обрывалось,
 * если пользователь читал отпечаток дольше 20 секунд.
 */
function readyWatchdog(onTimeout: () => void) {
  let remaining = READY_TIMEOUT_MS
  let startedAt = 0
  let timer: NodeJS.Timeout | undefined
  let finished = false
  const start = () => {
    if (finished || timer) return
    startedAt = Date.now()
    timer = setTimeout(() => {
      finished = true
      onTimeout()
    }, remaining)
  }
  start()
  return {
    pause() {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
      remaining = Math.max(2_000, remaining - (Date.now() - startedAt))
    },
    resume: start,
    clear() {
      finished = true
      if (timer) clearTimeout(timer)
      timer = undefined
    }
  }
}

function timeoutError(host: string): Error {
  return new Error(`Сервер ${host} не ответил за ${READY_TIMEOUT_MS / 1000} с (таймаут подключения)`)
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
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      watchdog.clear()
      jumpClient.end()
      for (const c of chain) c.end()
      reject(error)
    }
    const watchdog = readyWatchdog(() => fail(timeoutError(jump.host)))
    jumpClient.on('ready', () => {
      watchdog.clear()
      jumpClient.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
        if (err) return fail(new Error(`Бастион ${jump.host} не смог открыть канал к ${target.host}: ${err.message}`))
        settled = true
        // порядок: внешний бастион(ы) ... этот бастион
        resolve({ sock: stream, clients: [...chain, jumpClient] })
      })
    })
    jumpClient.on('error', (err) => fail(new Error(`Ошибка бастиона ${jump.host}: ${err.message}`)))
    jumpClient.on('close', () => fail(new Error(`Бастион ${jump.host} закрыл соединение`)))
    jumpClient.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => jump.password ?? ''))
    })
    try {
      const cfg = buildConfig(win, jump, (phase) => (phase === 'start' ? watchdog.pause() : watchdog.resume()))
      if (jumpSock) (cfg as { sock?: NodeJS.ReadWriteStream }).sock = jumpSock
      jumpClient.connect(cfg)
    } catch (e) {
      fail(e as Error)
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

  // Сервер предъявил ключ другого типа, чем сохранённые — это тоже смена ключа, а не новый хост
  const otherTypes = listKnownHostKeyTypes(profile.host, profile.port).filter((type) => type !== keyType)
  const prompt: HostKeyPrompt = {
    requestId: randomUUID(),
    host: profile.host,
    port: profile.port,
    keyType,
    fingerprint,
    changed: known !== undefined || otherTypes.length > 0,
    ...(known === undefined && otherTypes.length ? { knownKeyTypes: otherTypes } : {})
  }
  const accepted = await new Promise<boolean>((resolve) => {
    hostKeyResolvers.set(prompt.requestId, resolve)
    if (win.isDestroyed()) return resolve(false)
    win.webContents.send('hostkey:prompt', prompt)
    // Never hang a connection forever on an unanswered dialog
    setTimeout(() => {
      if (hostKeyResolvers.delete(prompt.requestId)) resolve(false)
    }, HOST_KEY_PROMPT_MS)
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
    // Таймаут ведёт readyWatchdog: он не считает время ожидания в диалоге ключа хоста
    readyTimeout: 0,
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
        .catch(() => {
          onHostKey?.('done')
          verify(false)
        })
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
export async function execOnClient(
  termId: string,
  command: string,
  timeoutMs = 30_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await execOnClientLimited(termId, command, {
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024
  })
  return { code, stdout, stderr }
}

/** Ограниченный exec для внешних инструментов: таймаут и жёсткий предел буфера вывода. */
export function execOnClientLimited(
  termId: string,
  command: string,
  options: {
    timeoutMs: number
    maxOutputBytes: number
    onStdout?: (chunk: string) => void
    onStderr?: (chunk: string) => void
  }
): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const client = terms.get(termId)?.client
    if (!client) return reject(new Error('SSH-сессия не активна'))
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let settled = false
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const append = (target: Buffer[], chunk: Buffer, used: number): number => {
        const remaining = Math.max(0, options.maxOutputBytes - stdoutBytes - stderrBytes)
        if (remaining <= 0) {
          truncated = true
          return used
        }
        const kept = chunk.subarray(0, remaining)
        target.push(kept)
        if (kept.length < chunk.length) truncated = true
        return used + kept.length
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        stream.close()
        reject(new Error(`Команда превысила таймаут ${Math.ceil(options.timeoutMs / 1000)} с`))
      }, options.timeoutMs)
      stream.on('data', (chunk: Buffer) => {
        stdoutBytes = append(stdout, chunk, stdoutBytes)
        options.onStdout?.(chunk.toString('utf8'))
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        stderrBytes = append(stderr, chunk, stderrBytes)
        options.onStderr?.(chunk.toString('utf8'))
      })
      stream.on('error', (streamError: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(streamError)
      })
      stream.on('close', (code: number) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          code: code ?? 0,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          truncated
        })
      })
    })
  })
}

/** Одноразовое подключение для exec-команды (деплой ключей и т.п.), в том числе через бастион. */
export async function execOnProfile(
  win: BrowserWindow,
  profile: ConnectProfile,
  command: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const via = profile.jump
    ? await openViaJump(win, profile.jump, { host: profile.host, port: profile.port })
    : undefined
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const closeAll = () => {
      client.end()
      via?.clients.forEach((c) => c.end())
    }
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      watchdog.clear()
      closeAll()
      reject(err)
    }
    const watchdog = readyWatchdog(() => fail(timeoutError(profile.host)))
    client.on('ready', () => {
      watchdog.clear()
      client.exec(command, (err, stream) => {
        if (err) return fail(err)
        let stdout = ''
        let stderr = ''
        stream.on('data', (d: Buffer) => (stdout += d.toString()))
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
        stream.on('close', (code: number) => {
          if (settled) return
          settled = true
          closeAll()
          resolve({ code: code ?? 0, stdout, stderr })
        })
      })
    })
    client.on('error', fail)
    client.on('close', () => fail(new Error('Соединение закрыто до завершения команды')))
    client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => profile.password ?? ''))
    })
    try {
      const cfg = buildConfig(win, profile, (phase) => (phase === 'start' ? watchdog.pause() : watchdog.resume()))
      if (via) (cfg as { sock?: NodeJS.ReadWriteStream }).sock = via.sock
      client.connect(cfg)
    } catch (e) {
      fail(e as Error)
    }
  })
}

function endLog(t: ActiveTerm): void {
  if (!t.logStream) return
  const tail = t.logDecoder?.end()
  if (tail) t.logStream.write(stripAnsi(tail))
  t.logStream.end()
  t.logStream = undefined
  t.logDecoder = undefined
}

/** Освобождает одну панель; общий клиент закрывается только когда снята последняя ссылка. */
function releasePane(termId: string): void {
  const t = terms.get(termId)
  if (!t) return
  endLog(t)
  terms.delete(termId)
  const n = (clientRefs.get(t.client) ?? 1) - 1
  if (n <= 0) {
    clientRefs.delete(t.client)
    notifyClosed(termId)
    t.client.end()
    t.jumpClients?.forEach((c) => c.end())
  } else {
    clientRefs.set(t.client, n)
    // Соединение живо в других панелях: туннели, SFTP и MCP переходят к первой оставшейся
    // (renderer так же продвигает первую оставшуюся панель в главную).
    const heir = [...terms].find(([, other]) => other.client === t.client)
    if (heir) {
      heir[1].jumpClients ??= t.jumpClients
      notifyMoved(termId, heir[0])
    }
  }
  if (!t.win.isDestroyed()) t.win.webContents.send('term:exit', termId)
}

/** Обрыв на уровне соединения — гасит все панели этого клиента. */
function failClient(client: Client, message?: string): void {
  let jumps: Client[] | undefined
  for (const [id, t] of [...terms]) {
    if (t.client !== client) continue
    jumps = jumps ?? t.jumpClients
    endLog(t)
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
    const t = terms.get(termId)
    if (t?.logStream && t.logDecoder) t.logStream.write(stripAnsi(t.logDecoder.write(data)))
    if (t && !t.attached) {
      t.backlog.push(data)
      t.backlogBytes += data.length
      while (t.backlogBytes > MAX_BACKLOG_BYTES && t.backlog.length > 1) {
        t.backlogBytes -= t.backlog.shift()!.length
      }
      return
    }
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

/** Renderer смонтировал терминал: отдаём накопленный вывод и дальше шлём напрямую. */
export function attachTerm(termId: string): void {
  const t = terms.get(termId)
  if (!t || t.attached) return
  t.attached = true
  const data = Buffer.concat(t.backlog)
  t.backlog = []
  t.backlogBytes = 0
  if (data.length && !t.win.isDestroyed()) t.win.webContents.send('term:data', termId, data)
}

function newTerm(client: Client, stream: ClientChannel, win: BrowserWindow, jumpClients?: Client[]): ActiveTerm {
  return { client, stream, win, jumpClients, attached: false, backlog: [], backlogBytes: 0 }
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
      terms.set(termId, newTerm(client, stream, win))
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
      watchdog.clear()
      emit(activeStage, 'error', err.message)
      client.end()
      jumpClients?.forEach((c) => c.end())
      reject(err)
    }
    // Таймаут считается с начала попытки, включая бастионы, но без времени в диалоге ключа
    const watchdog = readyWatchdog(() => fail(timeoutError(profile.host)))

    // Стадии по событиям ssh2: hostVerifier → handshake → auth → ready → shell
    client.on('handshake', () => {
      emit('auth', 'active')
    })
    client.on('ready', () => {
      watchdog.clear()
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
          if (settled) {
            stream.close()
            return
          }
          terms.set(termId, newTerm(client, stream, win, jumpClients))
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
      // Сервер может закрыть сокет без события error — попытка не должна висеть до таймаута
      if (!settled) return fail(new Error('Сервер закрыл соединение до завершения подключения'))
      if ([...terms.values()].some((t) => t.client === client)) failClient(client)
    })

    const startConnect = () => {
      if (settled) return
      try {
        const cfg = buildConfig(win, profile, (phase) => {
          if (phase === 'start') {
            watchdog.pause()
            emit('connect', 'done')
            emit('hostkey', 'active')
          } else {
            watchdog.resume()
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
      // Бастионы ведут собственные таймауты; общий на время их подключения приостанавливаем
      watchdog.pause()
      openViaJump(win, profile.jump, { host: profile.host, port: profile.port })
        .then(({ sock, clients }) => {
          jumpClients = clients
          if (settled) {
            clients.forEach((c) => c.end())
            return
          }
          pendingSock = sock
          watchdog.resume()
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
  endLog(t)
  const stream = createWriteStream(filePath, { flags: 'a' })
  stream.write(`\n===== LiteSSH log ${new Date().toISOString()} =====\n`)
  t.logStream = stream
  // Декодер не рвёт многобайтные символы UTF-8 на границе пакетов
  t.logDecoder = new StringDecoder('utf8')
}

export function stopLogging(termId: string): void {
  const t = terms.get(termId)
  if (t) endLog(t)
}

export function resizeTerm(termId: string, cols: number, rows: number): void {
  terms.get(termId)?.stream.setWindow(rows, cols, 0, 0)
}

export function closeTerm(termId: string): void {
  const t = terms.get(termId)
  if (!t) return
  // завершаем поток панели; releasePane снимет ссылку и,
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
