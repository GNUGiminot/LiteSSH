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

/** SOCKS5-хендшейк (без аутентификации), возвращает целевой host:port. */
function socks5Handshake(socket: Socket): Promise<{ host: string; port: number } | null> {
  return new Promise((resolve) => {
    let stage = 0
    const onData = (chunk: Buffer) => {
      if (stage === 0) {
        // [ver, nmethods, methods...]
        if (chunk[0] !== 0x05) return finish(null)
        socket.write(Buffer.from([0x05, 0x00])) // no auth
        stage = 1
      } else if (stage === 1) {
        // [ver, cmd, rsv, atyp, addr, port]
        if (chunk[0] !== 0x05 || chunk[1] !== 0x01) {
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          return finish(null)
        }
        const atyp = chunk[3]
        let host: string
        let offset: number
        if (atyp === 0x01) {
          host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          const len = chunk[4]
          host = chunk.subarray(5, 5 + len).toString('utf8')
          offset = 5 + len
        } else if (atyp === 0x04) {
          const parts: string[] = []
          for (let i = 0; i < 16; i += 2) parts.push(chunk.readUInt16BE(4 + i).toString(16))
          host = parts.join(':')
          offset = 20
        } else {
          return finish(null)
        }
        const port = chunk.readUInt16BE(offset)
        // ответ success
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        stage = 2
        finish({ host, port })
      }
    }
    const finish = (result: { host: string; port: number } | null) => {
      socket.off('data', onData)
      resolve(result)
    }
    socket.on('data', onData)
    socket.once('error', () => finish(null))
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
  if (active.has(tunnelId)) return { ok: true }

  const t: ActiveTunnel = { row, termId, sockets: new Set(), bytesIn: 0, bytesOut: 0, conns: 0 }

  if (row.type === 'local' || row.type === 'dynamic') {
    const server = createServer((socket) => {
      const handle = (host: string, port: number) => {
        client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, host, port, (err, stream) => {
          if (err) {
            socket.destroy()
            return
          }
          pipeThrough(t, socket, stream)
        })
      }
      if (row.type === 'dynamic') {
        void socks5Handshake(socket).then((target) => {
          if (target) handle(target.host, target.port)
          else socket.destroy()
        })
      } else {
        handle(row.dst_host, row.dst_port)
      }
    })
    server.on('error', (err) => {
      t.error = err.message
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
