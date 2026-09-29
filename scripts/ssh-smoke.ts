/**
 * Интеграционная проверка SSH-логики на локальном ssh2-сервере под настоящим Electron
 * (нативный better-sqlite3 собран под ABI Electron). Данные — во временном userData.
 * Запуск: npm run test:ssh
 */
import { app, type BrowserWindow } from 'electron'
import { createServer, connect as netConnect, type AddressInfo, type Socket } from 'net'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Server, utils } from 'ssh2'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'litessh-ssh-smoke-')))

type Cm = typeof import('../electron/main/ssh/connection-manager')
type Tm = typeof import('../electron/main/ssh/tunnel-manager')
type Db = typeof import('../electron/main/db')

const BANNER = 'LITESSH-BANNER-0123456789'
const USER = 'tester'
const PASS = 'secret'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function startSshServer(): Promise<number> {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (ok) => ok?.())
        session.on('window-change', (ok) => ok?.())
        session.on('shell', (ok) => {
          const stream = ok()
          stream.write(`${BANNER}\r\n$ `) // баннер сразу, до монтирования терминала
          stream.on('data', (d: Buffer) => stream.write(d))
        })
        session.on('exec', (ok, _reject, info) => {
          const stream = ok()
          stream.write(`exec:${info.command}\n`)
          stream.exit(0)
          stream.end()
        })
      })
      // direct-tcpip: для бастиона и туннелей -L/-D
      client.on('tcpip', (accept, reject, info) => {
        const target = netConnect(info.destPort, info.destIP)
        target.once('connect', () => {
          const channel = accept()
          channel.pipe(target).pipe(channel)
        })
        target.once('error', () => reject())
      })
    })
    client.on('error', () => undefined)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

function startEchoServer(): Promise<number> {
  const server = createServer((socket) => socket.pipe(socket))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

function fakeWindow(onSend: (channel: string, ...args: unknown[]) => void): BrowserWindow {
  return { isDestroyed: () => false, webContents: { send: onSend } } as unknown as BrowserWindow
}

function freePort(): Promise<number> {
  const s = createServer()
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as AddressInfo).port
    s.close(() => resolve(port))
  }))
}

/** SOCKS5 CONNECT одним пакетом вместе с полезными данными — проверка, что байты не теряются. */
function socksRoundTrip(socksPort: number, destPort: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = netConnect(socksPort, '127.0.0.1')
    let stage = 0
    let received = Buffer.alloc(0)
    const timer = setTimeout(() => reject(new Error('SOCKS timeout')), 5000)
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      if (stage === 0 && received.length >= 2) {
        received = received.subarray(2)
        stage = 1
        const req = Buffer.alloc(10)
        req.set([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1])
        req.writeUInt16BE(destPort, 8)
        socket.write(Buffer.concat([req, Buffer.from(payload)])) // данные слитно с запросом
      }
      if (stage === 1 && received.length >= 10) {
        if (received[1] !== 0x00) return reject(new Error(`SOCKS reply ${received[1]}`))
        received = received.subarray(10)
        stage = 2
      }
      if (stage === 2 && received.toString().includes(payload)) {
        clearTimeout(timer)
        socket.destroy()
        resolve(received.toString())
      }
    })
    socket.on('error', reject)
  })
}

async function main(): Promise<void> {
  const cm: Cm = await import('../electron/main/ssh/connection-manager')
  const tm: Tm = await import('../electron/main/ssh/tunnel-manager')
  const db: Db = await import('../electron/main/db')

  const sshPort = await startSshServer()
  const echoPort = await startEchoServer()
  const profile = { host: '127.0.0.1', port: sshPort, username: USER, authType: 'password' as const, password: PASS }

  // 1. Диалог ключа хоста дольше 20 с не должен обрывать подключение
  const data: Buffer[] = []
  const win = fakeWindow((channel, ...args) => {
    if (channel === 'hostkey:prompt') {
      const prompt = args[0] as { requestId: string }
      setTimeout(() => cm.respondHostKey(prompt.requestId, true), 23_000)
    }
    if (channel === 'term:data') data.push(args[1] as Buffer)
  })
  const started = Date.now()
  const { termId } = await cm.connect(win, profile, { cols: 80, rows: 24 })
  assert(Date.now() - started >= 22_000, 'подключение дождалось ответа в диалоге ключа')
  console.log(`OK hostkey-wait ${Math.round((Date.now() - started) / 1000)}s`)

  // 2. Баннер до монтирования терминала не теряется
  await new Promise((r) => setTimeout(r, 500))
  assert(data.length === 0, 'до attach вывод не отправляется')
  cm.attachTerm(termId)
  assert(Buffer.concat(data).toString().includes(BANNER), 'баннер доставлен после attach')
  console.log('OK banner-backlog')

  // 3. Смена типа ключа сервера распознаётся как изменение
  db.saveKnownHostKey('127.0.0.1', sshPort + 1, 'ssh-rsa', 'SHA256:old')
  const otherTypes = db.listKnownHostKeyTypes('127.0.0.1', sshPort + 1)
  assert(otherTypes.includes('ssh-rsa'), 'типы ключей хоста читаются')
  console.log('OK hostkey-types')

  // 4. SOCKS5 (-D): данные, пришедшие вместе с CONNECT, доходят
  const socksPort = await freePort()
  const sessionRow = db.saveSession({ id: '', name: 'smoke', folder: '', host: '127.0.0.1', port: sshPort, username: USER, authType: 'password' })
  const tunnel = db.saveTunnel({ id: '', session_id: sessionRow.id, type: 'dynamic', src_host: '127.0.0.1', src_port: socksPort, dst_host: '', dst_port: 0, autostart: 0 })
  assert(tm.startTunnel(termId, tunnel.id).ok, 'SOCKS-туннель запущен')
  await new Promise((r) => setTimeout(r, 200))
  const echoed = await socksRoundTrip(socksPort, echoPort, 'HELLO-THROUGH-SOCKS')
  assert(echoed.includes('HELLO-THROUGH-SOCKS'), 'эхо через SOCKS')
  console.log('OK socks-early-data')

  // 5. Туннель с ошибкой (порт занят) перезапускается
  const busy = createServer()
  const busyPort = await freePort()
  await new Promise<void>((r) => busy.listen(busyPort, '127.0.0.1', () => r()))
  const local = db.saveTunnel({ id: '', session_id: sessionRow.id, type: 'local', src_host: '127.0.0.1', src_port: busyPort, dst_host: '127.0.0.1', dst_port: echoPort, autostart: 0 })
  tm.startTunnel(termId, local.id)
  await new Promise((r) => setTimeout(r, 200))
  assert(tm.tunnelStates().find((s) => s.id === local.id)?.error, 'ошибка занятого порта видна')
  await new Promise<void>((r) => busy.close(() => r()))
  tm.startTunnel(termId, local.id)
  await new Promise((r) => setTimeout(r, 200))
  assert(tm.tunnelStates().find((s) => s.id === local.id)?.running, 'повторный запуск после ошибки работает')
  console.log('OK tunnel-restart')

  // 6. split: закрытие главной панели не останавливает туннели — они переходят к оставшейся
  // в приложении эти слушатели подключает ipc.ts
  cm.onTermMoved((from, to) => tm.moveTunnelsToTerm(from, to))
  cm.onTermClosed((id) => tm.stopTunnelsForTerm(id))
  const extra = await cm.openExtraShell(termId, { cols: 80, rows: 24 })
  cm.closeTerm(termId)
  await new Promise((r) => setTimeout(r, 200))
  assert(cm.getClient(extra.termId), 'соединение живо во второй панели')
  const again = await socksRoundTrip(socksPort, echoPort, 'AFTER-SPLIT-CLOSE')
  assert(again.includes('AFTER-SPLIT-CLOSE'), 'SOCKS работает после закрытия главной панели')
  console.log('OK split-move')

  // 7. exec с таймаутом и установка ключа через бастион (execOnProfile + ProxyJump)
  const exec = await cm.execOnClient(extra.termId, 'uptime', 5_000)
  assert(exec.stdout.includes('exec:uptime'), 'exec на открытом клиенте')
  const viaJump = await cm.execOnProfile(win, { ...profile, jump: { ...profile } }, 'deploy')
  assert(viaJump.stdout.includes('exec:deploy'), 'execOnProfile прошёл через бастион')
  console.log('OK exec-via-jump')

  cm.closeTerm(extra.termId)

  // 8. Импорт ~/.ssh/config: Include, Match, ProxyJump, «ключ=значение», без дублей
  const io = await import('../electron/main/sessions-io')
  const dir = mkdtempSync(join(tmpdir(), 'litessh-sshcfg-'))
  writeFileSync(join(dir, 'extra.conf'), 'Host inner\n  HostName 10.0.0.5\n  User deploy\n  ProxyJump bastion\n')
  writeFileSync(join(dir, 'config'), [
    `Include ${join(dir, 'extra.conf').replace(/\\/g, '/')}`,
    'Host bastion b2',
    '  HostName=bastion.example.com',
    '  Port 2222',
    'Match host *.internal',
    '  User wrong',
    'Host *',
    '  User ignored',
    ''
  ].join('\n'))
  assert(io.importSshConfig(join(dir, 'config')) === 2, 'импортированы inner и bastion')
  assert(io.importSshConfig(join(dir, 'config')) === 0, 'повторный импорт без дублей')
  const imported = db.listSessions()
  const bastion = imported.find((s) => s.name === 'bastion')
  const inner = imported.find((s) => s.name === 'inner')
  assert(bastion?.host === 'bastion.example.com' && bastion.port === 2222 && bastion.username === 'root', 'Match не прилип к bastion')
  assert(inner?.jumpSessionId === bastion?.id, 'ProxyJump связан с сессией-бастионом')
  console.log('OK ssh-config-import')

  // 9. Экспорт/импорт JSON сохраняет бастион, проброс агента и теги
  const exported = join(dir, 'sessions.json')
  io.exportSessionsJson(exported)
  const json = JSON.parse(readFileSync(exported, 'utf8'))
  json.sessions = json.sessions.map((s: { name: string }) => ({ ...s, name: `${s.name}-copy` }))
  json.sessions.forEach((s: { jump?: string }) => { if (s.jump) s.jump = `${s.jump}-copy` })
  writeFileSync(exported, JSON.stringify(json))
  io.importSessionsJson(exported)
  const copies = db.listSessions()
  const innerCopy = copies.find((s) => s.name === 'inner-copy')
  assert(innerCopy?.jumpSessionId === copies.find((s) => s.name === 'bastion-copy')?.id, 'бастион восстановлен по имени')
  console.log('OK sessions-json-roundtrip')

  console.log('SSH_SMOKE_OK')
}

app.whenReady().then(() => main()).then(
  () => app.exit(0),
  (error) => {
    console.error('SSH_SMOKE_FAIL', error)
    app.exit(1)
  }
)
