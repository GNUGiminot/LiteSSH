import { BrowserWindow } from 'electron'
import { createServer, connect as netConnect, type Server, type Socket } from 'net'
import { randomUUID } from 'crypto'
import type { ClientChannel } from 'ssh2'
import { getClient } from './connection-manager'
import { listTunnels, getTunnelRow, type TunnelRow } from '../db'
import type { TunnelState } from '@shared/types'

// Туннель привязан к активному SSH-подключению (termId). Пока это подключение живо,
// туннель работает; при закрытии сессии все её туннели останавливаются.

type TcpConnListener = (
  info: { destPort: number },
  accept: () => ClientChannel
) => void

interface ActiveTunnel {
  row: TunnelRow
  termId: string
  server?: Server // для local и dynamic
  /** Слушатель входящих forwardIn-соединений (для remote), чтобы снять его при остановке */
  tcpListener?: TcpConnListener
  sockets: Set<Socket>
  bytesIn: number
  bytesOut: number
  conns: number
  error?: string
}

const active = new Map<string, ActiveTunnel>() // tunnelId -> tunnel

function toState(t: ActiveTunnel): TunnelState {
  return {
    id: t.row.id,
    sessionId: t.row.session_id,
    type: t.row.type as TunnelState['type'],
    srcHost: t.row.src_host,
    srcPort: t.row.src_port,
    dstHost: t.row.dst_host,
    dstPort: t.row.dst_port,
    running: !t.error,
    error: t.error,
    conns: t.conns,
    bytesIn: t.bytesIn,
    bytesOut: t.bytesOut
  }
}

function broadcast(): void {
  const states = [...active.values()].map(toState)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('tunnel:state', states)
  }
}

let statsTimer: NodeJS.Timeout | null = null
function ensureStatsLoop(): void {
  if (statsTimer) return
  statsTimer = setInterval(() => {
    if (active.size === 0) {
      if (statsTimer) clearInterval(statsTimer)
      statsTimer = null
      return
    }
    broadcast()
  }, 1000)
}

const SOCKS_REPLY_OK = 0x00
const SOCKS_REPLY_HOST_UNREACHABLE = 0x04
const SOCKS_REPLY_COMMAND_UNSUPPORTED = 0x07

function socksReply(code: number): Buffer {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

/**
 * SOCKS5-хендшейк (без аутентификации), возвращает целевой host:port.
 * Сообщения клиента копятся в буфер (могут прийти частями или слитно), а байты сверх
 * запроса возвращаются в поток через unshift — иначе данные, отправленные сразу
 * после запроса CONNECT, терялись. Ответ «успех» шлёт вызывающий после открытия канала.
 */
function socks5Handshake(socket: Socket): Promise<{ host: string; port: number } | null> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    let greeted = false
    let done = false
    const finish = (result: { host: string; port: number } | null, rest?: Buffer) => {
      if (done) return
      done = true
      socket.off('data', onData)
      socket.off('error', onError)
      socket.pause()
      if (rest?.length) socket.unshift(rest)
      resolve(result)
    }
    const onError = () => finish(null)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 1024) return finish(null)
      if (!greeted) {
        // [ver, nmethods, methods...]
        if (buffer.length < 2) return
        if (buffer[0] !== 0x05) return finish(null)
        const need = 2 + buffer[1]
        if (buffer.length < need) return
        const methods = buffer.subarray(2, need)
        if (!methods.includes(0x00)) {
          socket.write(Buffer.from([0x05, 0xff])) // нет приемлемого метода
          return finish(null)
        }
        socket.write(Buffer.from([0x05, 0x00])) // no auth
        greeted = true
        buffer = buffer.subarray(need)
      }
      // [ver, cmd, rsv, atyp, addr, port]
      if (buffer.length < 4) return
      if (buffer[0] !== 0x05 || buffer[1] !== 0x01) {
        socket.write(socksReply(SOCKS_REPLY_COMMAND_UNSUPPORTED))
        return finish(null)
      }
      const atyp = buffer[3]
      let host: string
      let offset: number
      if (atyp === 0x01) {
        if (buffer.length < 10) return
        host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`
        offset = 8
      } else if (atyp === 0x03) {
        if (buffer.length < 5) return
        const len = buffer[4]
        if (buffer.length < 5 + len + 2) return
        host = buffer.subarray(5, 5 + len).toString('utf8')
        offset = 5 + len
      } else if (atyp === 0x04) {
        if (buffer.length < 22) return
        const parts: string[] = []
        for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(4 + i).toString(16))
        host = parts.join(':')
        offset = 20
      } else {
        socket.write(socksReply(0x08))
        return finish(null)
      }
      const port = buffer.readUInt16BE(offset)
      finish({ host, port }, buffer.subarray(offset + 2))
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

function pipeThrough(t: ActiveTunnel, a: Socket, b: NodeJS.ReadWriteStream): void {
  t.sockets.add(a)
  t.conns++
  a.on('data', (d: Buffer) => (t.bytesOut += d.length))
  b.on('data', (d: Buffer) => (t.bytesIn += d.length))
  a.pipe(b as NodeJS.WritableStream)
  ;(b as NodeJS.ReadableStream).pipe(a)
  const cleanup = () => {
    t.sockets.delete(a)
    a.destroy()
    ;(b as unknown as Socket).destroy?.()
  }
  a.on('close', cleanup)
  a.on('error', cleanup)
  b.on('close', cleanup)
  b.on('error', cleanup)
}

export function startTunnel(termId: string, tunnelId: string): { ok: boolean; error?: string } {
  const row = getTunnelRow(tunnelId)
  if (!row) return { ok: false, error: 'Туннель не найден' }
  const client = getClient(termId)
  if (!client) return { ok: false, error: 'SSH-сессия не активна' }
  const existing = active.get(tunnelId)
  if (existing && !existing.error) return { ok: true }
  // Туннель с ошибкой (порт занят, сервер отказал) перезапускаем, а не отвечаем «уже запущен»
  if (existing) stopTunnel(tunnelId)

  const t: ActiveTunnel = { row, termId, sockets: new Set(), bytesIn: 0, bytesOut: 0, conns: 0 }

  if (row.type === 'local' || row.type === 'dynamic') {
    const server = createServer((socket) => {
      socket.on('error', () => socket.destroy())
      const handle = (host: string, port: number, socks: boolean) => {
        const current = getClient(t.termId) ?? client
        current.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, host, port, (err, stream) => {
          if (err) {
            // Клиент SOCKS должен узнать о неудаче, а не получить «успех» и обрыв
            if (socks && !socket.destroyed) socket.end(socksReply(SOCKS_REPLY_HOST_UNREACHABLE))
            else socket.destroy()
            return
          }
          if (socks) socket.write(socksReply(SOCKS_REPLY_OK))
          pipeThrough(t, socket, stream)
          socket.resume()
        })
      }
      if (row.type === 'dynamic') {
        void socks5Handshake(socket).then((target) => {
          if (target) handle(target.host, target.port, true)
          else socket.destroy()
        })
      } else {
        handle(row.dst_host, row.dst_port, false)
      }
    })
    server.on('error', (err) => {
      t.error = err.message
      server.close()
      broadcast()
    })
    server.listen(row.src_port, row.src_host, () => {
      t.error = undefined
      broadcast()
    })
    t.server = server
  } else if (row.type === 'remote') {
    client.forwardIn(row.src_host, row.src_port, (err) => {
      if (err) {
        t.error = err.message
        broadcast()
      }
    })
    // forwardIn-соединения приходят событием 'tcp connection' на клиенте.
    // Храним ссылку на слушатель, чтобы снять его в stopTunnel (иначе при перезапуске — дубли).
    const listener: TcpConnListener = (info, accept) => {
      if (info.destPort !== row.src_port) return
      const stream = accept()
      const local = netConnect(row.dst_port, row.dst_host || '127.0.0.1')
      pipeThrough(t, local, stream)
    }
    t.tcpListener = listener
    client.on('tcp connection', listener)
  } else {
    return { ok: false, error: `Неизвестный тип туннеля: ${row.type}` }
  }

  active.set(tunnelId, t)
  ensureStatsLoop()
  broadcast()
  return { ok: true }
}

export function stopTunnel(tunnelId: string): void {
  const t = active.get(tunnelId)
  if (!t) return
  t.server?.close()
  for (const s of t.sockets) s.destroy()
  if (t.row.type === 'remote') {
    const client = getClient(t.termId)
    if (client && t.tcpListener) client.removeListener('tcp connection', t.tcpListener)
    try {
      client?.unforwardIn(t.row.src_host, t.row.src_port)
    } catch {
      /* ignore */
    }
  }
  active.delete(tunnelId)
  broadcast()
}

/** split view: соединение перешло к другой панели — туннели продолжают работать под её id. */
export function moveTunnelsToTerm(fromTermId: string, toTermId: string): void {
  for (const t of active.values()) if (t.termId === fromTermId) t.termId = toTermId
}

/** Останавливает все туннели закрываемой сессии. */
export function stopTunnelsForTerm(termId: string): void {
  for (const [id, t] of active) if (t.termId === termId) stopTunnel(id)
}

export function tunnelStates(): TunnelState[] {
  return [...active.values()].map(toState)
}

export function autostartTunnels(termId: string, sessionId: string): void {
  for (const row of listTunnels(sessionId)) {
    if (row.autostart) startTunnel(termId, row.id)
  }
}

/**
 * Эфемерный local-forward на свободный локальный порт (для RDP/VNC over SSH).
 * Не сохраняется в БД; живёт вместе с сессией (снимается stopTunnelsForTerm).
 * Возвращает выбранный локальный порт.
 */
export function startEphemeralLocal(
  termId: string,
  dstHost: string,
  dstPort: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = getClient(termId)
    if (!client) return reject(new Error('SSH-сессия не активна'))
    const id = randomUUID()
    const row: TunnelRow = {
      id,
      session_id: '',
      type: 'local',
      src_host: '127.0.0.1',
      src_port: 0,
      dst_host: dstHost,
      dst_port: dstPort,
      autostart: 0,
      created_at: Date.now()
    }
    const t: ActiveTunnel = { row, termId, sockets: new Set(), bytesIn: 0, bytesOut: 0, conns: 0 }
    const server = createServer((socket) => {
      client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        dstHost,
        dstPort,
        (err, stream) => {
          if (err) return socket.destroy()
          pipeThrough(t, socket, stream)
        }
      )
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      row.src_port = port
      t.server = server
      active.set(id, t)
      ensureStatsLoop()
      broadcast()
      resolve(port)
    })
  })
}
