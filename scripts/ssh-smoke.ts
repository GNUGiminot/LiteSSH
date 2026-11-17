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

function startSshServer(
  opts: {
    user?: string
    pass?: string
    banner?: string
    onTcpip?: (dest: string) => void
    /** Свой ответ на exec (команда и её stdin); undefined — стандартное эхо */
    onExec?: (command: string, stdin: string) => { stdout?: string; stderr?: string; code?: number } | undefined
  } = {}
): Promise<number> {
  const { user = USER, pass = PASS, banner = BANNER } = opts
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === user && ctx.password === pass) ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (ok) => ok?.())
        session.on('window-change', (ok) => ok?.())
        session.on('shell', (ok) => {
          const stream = ok()
          stream.write(`${banner}\r\n$ `) // баннер сразу, до монтирования терминала
          stream.on('data', (d: Buffer) => stream.write(d))
        })
        session.on('exec', (ok, _reject, info) => {
          const stream = ok()
          const reply = (stdin: string) => {
            const custom = opts.onExec?.(info.command, stdin)
            if (!custom) stream.write(`exec:${info.command}\n`)
            if (custom?.stdout) stream.write(custom.stdout)
            if (custom?.stderr) stream.stderr.write(custom.stderr)
            stream.exit(custom?.code ?? 0)
            stream.end()
          }
          // stdin читаем только у sudo -S (пароль); остальным отвечаем сразу
          if (!info.command.startsWith('sudo -S')) return reply('')
          let input = ''
          stream.on('data', (d: Buffer) => (input += d.toString()))
          stream.on('end', () => reply(input))
        })
      })
      // direct-tcpip: для бастиона и туннелей -L/-D
      client.on('tcpip', (accept, reject, info) => {
        opts.onTcpip?.(`${info.destIP}:${info.destPort}`)
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

  // 10. Перезагрузка/падение страницы окна закрывает её сессии и туннели, не трогая другие окна
  const winA = fakeWindow(() => undefined)
  const winB = fakeWindow(() => undefined)
  const keep = await cm.connect(winA, profile, { cols: 80, rows: 24 })
  const gone = await cm.connect(winB, profile, { cols: 80, rows: 24 })
  const goneTunnelPort = await freePort()
  const goneTunnel = db.saveTunnel({ id: '', session_id: sessionRow.id, type: 'local', src_host: '127.0.0.1', src_port: goneTunnelPort, dst_host: '127.0.0.1', dst_port: echoPort, autostart: 0 })
  assert(tm.startTunnel(gone.termId, goneTunnel.id).ok, 'туннель окна B запущен')
  cm.closeTermsForWindow(winB)
  await new Promise((r) => setTimeout(r, 200))
  assert(!cm.getClient(gone.termId), 'сессия окна B закрыта')
  assert(!tm.tunnelStates().some((s) => s.id === goneTunnel.id), 'туннель окна B остановлен')
  assert(cm.getClient(keep.termId), 'сессия окна A жива')
  console.log('OK window-cleanup')

  // 11. Подключение «в полёте» во время перезагрузки не оставляет shell без вкладки
  const winC = fakeWindow(() => undefined)
  const pending = cm.connect(winC, profile, { cols: 80, rows: 24 })
  cm.closeTermsForWindow(winC)
  const raced = await pending.then(() => 'connected', (e: Error) => e.message)
  assert(raced.includes('перезагружено'), `подключение после перезагрузки отклонено: ${raced}`)
  console.log('OK reload-race')
  cm.closeTerm(keep.termId)

  // 12. Удаление сессии убирает её туннели из БД
  const doomed = db.saveSession({ id: '', name: 'doomed', folder: '', host: '127.0.0.1', port: sshPort, username: USER, authType: 'password' })
  db.saveTunnel({ id: '', session_id: doomed.id, type: 'local', src_host: '127.0.0.1', src_port: 1, dst_host: 'x', dst_port: 1, autostart: 1 })
  db.deleteSession(doomed.id)
  assert(db.listTunnels(doomed.id).length === 0, 'туннели удалённой сессии удалены')
  console.log('OK delete-cascade')

  // 13. Имена файлов от сервера не выводят скачивание за пределы папки назначения
  const sftp = await import('../electron/main/ssh/sftp-manager')
  for (const bad of ['..', '.', '', '../x', '..\\..\\evil.exe', 'a/b', 'nul\0x']) {
    let threw = false
    try { sftp.assertSafeRemoteName(bad) } catch { threw = true }
    assert(threw, `имя «${bad}» отклонено`)
  }
  assert(sftp.assertSafeRemoteName('normal.tar.gz') === 'normal.tar.gz', 'обычное имя проходит')
  assert(sftp.assertSafeRemoteName('..hidden') === '..hidden', 'имя, начинающееся с двух точек, проходит')
  console.log('OK remote-name-guard')

  // 14. ssh -J: терминал на целевом сервере с нестандартным портом через отдельный бастион
  //     (свои логин/пароль у каждого), туннель -L поверх такой сессии и видимая ошибка канала
  const hops: string[] = []
  const bastionPort = await startSshServer({ user: 'hop', pass: 'hop-pass', onTcpip: (d) => hops.push(d) })
  const targetPort = await startSshServer({ user: 'root', pass: 'target-pass', banner: 'TARGET-BANNER' })
  const targetOut: Buffer[] = []
  const winJ = fakeWindow((channel, ...args) => {
    if (channel === 'hostkey:prompt') cm.respondHostKey((args[0] as { requestId: string }).requestId, true)
    if (channel === 'term:data') targetOut.push(args[1] as Buffer)
  })
  const bastionProfile = { name: 'bastion', host: '127.0.0.1', port: bastionPort, username: 'hop', authType: 'password' as const, password: 'hop-pass' }
  const viaBastion = await cm.connect(
    winJ,
    { name: 'target', host: '127.0.0.1', port: targetPort, username: 'root', authType: 'password', password: 'target-pass', jump: bastionProfile },
    { cols: 80, rows: 24 }
  )
  cm.attachTerm(viaBastion.termId)
  await new Promise((r) => setTimeout(r, 200))
  assert(Buffer.concat(targetOut).toString().includes('TARGET-BANNER'), 'терминал открыт на целевом сервере')
  assert(hops.includes(`127.0.0.1:${targetPort}`), `бастион открыл канал к целевому порту ${targetPort}: ${hops.join(', ')}`)
  console.log('OK jump-terminal-custom-port')

  const jumpTunnelPort = await freePort()
  const jumpTunnel = db.saveTunnel({ id: '', session_id: sessionRow.id, type: 'local', src_host: '127.0.0.1', src_port: jumpTunnelPort, dst_host: '127.0.0.1', dst_port: echoPort, autostart: 0 })
  assert(tm.startTunnel(viaBastion.termId, jumpTunnel.id).ok, 'туннель на сессии через бастион запущен')
  await new Promise((r) => setTimeout(r, 200))
  const echoViaJump = await new Promise<string>((resolve, reject) => {
    const sock = netConnect(jumpTunnelPort, '127.0.0.1', () => sock.write('LOCAL-VIA-JUMP'))
    sock.on('data', (d) => {
      resolve(d.toString())
      sock.destroy()
    })
    sock.on('error', reject)
  })
  assert(echoViaJump.includes('LOCAL-VIA-JUMP'), 'эхо через -L на сессии за бастионом')
  console.log('OK jump-local-tunnel')

  const closedPort = await freePort()
  const deadTunnelPort = await freePort()
  const dead = db.saveTunnel({ id: '', session_id: sessionRow.id, type: 'local', src_host: '127.0.0.1', src_port: deadTunnelPort, dst_host: '127.0.0.1', dst_port: closedPort, autostart: 0 })
  assert(tm.startTunnel(viaBastion.termId, dead.id).ok, 'туннель на закрытый порт слушает')
  await new Promise((r) => setTimeout(r, 200))
  await new Promise<void>((resolve) => {
    const sock = netConnect(deadTunnelPort, '127.0.0.1')
    sock.on('close', () => resolve())
    sock.on('error', () => undefined)
  })
  await new Promise((r) => setTimeout(r, 100))
  const deadState = tm.tunnelStates().find((s) => s.id === dead.id)
  assert(deadState?.running && deadState.lastError?.includes(`:${closedPort}`), `отказ канала виден: ${deadState?.lastError}`)
  console.log('OK tunnel-error-visible')
  cm.closeTerm(viaBastion.termId)

  // 15. «Сетевой экран»: probe → sudo с паролем → web enable/token → туннель → API панели → confirm.
  // С VPSWALL_DEMO_PORT (запущен `vpswall web --demo`, порт 8091) проверяется настоящий API VPSWall.
  {
    const fw = await import('../electron/main/firewall')
    const http = await import('http')
    const demoPort = Number(process.env.VPSWALL_DEMO_PORT) || 0
    const TOKEN = demoPort ? 'vpswall-demo' : 'smoke-token-0123456789'
    const seen: string[] = []
    // Имитация веб-панели: те же проверки Host/Bearer/Origin/Content-Type, что в web.go VPSWall
    const panel = http.createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const host = req.headers.host ?? ''
      if (!/^127\.0\.0\.1:\d+$/.test(host)) return send(403, { error: 'host' })
      if (req.url === '/api/demo') return send(200, { demo: false })
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'token' })
      if (req.url === '/api/state') return send(200, { config: { rules: [] }, revision: 'r1', windows: [], pending: null })
      if (req.url === '/api/action' && req.method === 'POST') {
        if (req.headers.origin !== `http://${host}`) return send(403, { error: 'origin' })
        if (req.headers['content-type'] !== 'application/json') return send(415, { error: 'type' })
        let body = ''
        req.on('data', (d) => (body += d))
        req.on('end', () => {
          seen.push(body)
          send(202, { id: 'j1', running: true, message: '' })
        })
        return
      }
      send(404, { error: 'нет' })
    })
    const panelPort = demoPort || (await new Promise<number>((r) => panel.listen(0, '127.0.0.1', () => r((panel.address() as AddressInfo).port))))
    const commands: string[] = []
    const fwSsh = await startSshServer({
      onExec: (command, stdin) => {
        commands.push(command)
        if (command.startsWith("sh -c '")) {
          return { stdout: 'UID=1000\nARCH=x86_64\nOS=Linux\nSYSTEMD=1\nBIN=/usr/local/bin/vpswall\nVER=vpswall 0.3.0\nSUDO=1\n' }
        }
        if (command.startsWith('sudo -S')) {
          if (stdin !== `${PASS}\n`) return { stderr: 'Sorry, try again.\nsudo: 1 incorrect password attempt\n', code: 1 }
          if (command.endsWith('vpswall web token')) return { stdout: `Токен на 8 часов (предыдущий заменён):\n${TOKEN}\n\nНа вашем компьютере: ssh -N\n` }
          if (command.includes('vpswall confirm ')) return { stdout: 'Подтверждено.\n' }
          return { stdout: 'ok\n' }
        }
        return undefined
      }
    })
    const fwProfile = { host: '127.0.0.1', port: fwSsh, username: USER, authType: 'password' as const, password: PASS }
    const fwWin = fakeWindow((channel, ...args) => {
      if (channel === 'hostkey:prompt') cm.respondHostKey((args[0] as { requestId: string }).requestId, true)
    })
    const fwTerm = await cm.connect(fwWin, fwProfile, { cols: 80, rows: 24 })
    const st = fw._testApi.stateOf(fwTerm.termId)
    fw.rememberProfile(fwTerm.termId, fwProfile)
    st.remotePort = panelPort

    const failure = async () => {
      try {
        await fw._testApi.api(fwTerm.termId, 'GET', '/api/state')
        return ''
      } catch (e) {
        return (e as Error).message
      }
    }
    assert((await failure()).includes('пароль sudo'), 'без пароля sudo — запрос пароля')
    st.password = 'wrong'
    assert((await failure()).includes('Неверный пароль') && st.password === undefined, 'неверный пароль sudo сброшен')
    st.password = PASS
    const state = await fw._testApi.api(fwTerm.termId, 'GET', '/api/state')
    assert(typeof state.revision === 'string' && state.revision, 'состояние панели получено через туннель')
    assert(
      commands.includes("sudo -S -p '' --preserve-env=SSH_CONNECTION /usr/local/bin/vpswall web token"),
      'token выдаётся с SSH_CONNECTION'
    )
    assert(!commands.some((c) => c.includes(PASS) || c.includes(TOKEN)), 'пароль и токен не попали в командную строку')
    const job = await fw._testApi.api(fwTerm.termId, 'POST', '/api/action', {
      op: 'rule-save',
      revision: state.revision,
      action: 'allow',
      protocol: 'tcp',
      port: '8443',
      source: 'any',
      comment: 'smoke',
      priority: 5000
    })
    assert(typeof job.id === 'string' && job.id, 'POST прошёл проверку Origin')
    if (!demoPort) assert(seen[0]?.includes('8443'), 'тело операции дошло')
    const port = await fw._testApi.confirm(fwTerm.termId, fwWin, 'abcd1234')
    assert(port === fwSsh && commands.some((c) => c.endsWith('vpswall confirm abcd1234')), 'confirm из нового подключения')
    if (demoPort) {
      // Окно полной панели: настоящий интерфейс VPSWall через туннель, токен подставлен и вход выполнен
      const panelWin = fw._testApi.openPanel(fwTerm.termId, 'smoke')
      let loggedIn = false
      for (let i = 0; i < 40 && !loggedIn; i++) {
        await new Promise((r) => setTimeout(r, 250))
        loggedIn = await panelWin.webContents
          .executeJavaScript("document.body.classList.contains('authenticated') && sessionStorage.getItem('vpswall-token') === 'vpswall-demo'")
          .catch(() => false)
      }
      assert(loggedIn, 'панель VPSWall открылась в окне и вошла по токену')
      panelWin.destroy()
    }
    cm.closeTerm(fwTerm.termId)
    panel.close()
    console.log(`OK firewall-vpswall${demoPort ? ' (настоящий web --demo)' : ''}`)
  }

  // 16. Архив VPSWall 0.4.0+: вместе с бинарником на сервер уходит dist/SHA256SUMS
  {
    const fw = await import('../electron/main/firewall')
    const { existsSync } = await import('fs')
    const zipPath = join(__dirname, '..', '..', '..', 'vpswall', 'vpswall-0.4.0.zip')
    if (existsSync(zipPath)) {
      const files = fw.pickInstallFiles(fw.readZip(readFileSync(zipPath)), 'amd64')
      const line = files.sums?.toString('utf8').split(/\r?\n/).find((l) => l.endsWith('vpswall-linux-amd64'))
      const { createHash } = await import('crypto')
      assert(line?.startsWith(createHash('sha256').update(files.binary).digest('hex')), 'SHA256SUMS из архива совпадает с бинарником')
      console.log('OK vpswall-040-sums')
    } else console.log('SKIP vpswall-040-sums (нет архива)')
  }

  // 17. «Установить с GitHub»: последний выпуск VPSWall, сумма из SHA256SUMS.txt того же выпуска
  {
    const fw = await import('../electron/main/firewall')
    const { createHash } = await import('crypto')
    const zip = Buffer.from('fake-vpswall-zip')
    const good = createHash('sha256').update(zip).digest('hex')
    const base = `https://github.com/${fw.VPSWALL_REPO}/releases/download/v9.8.7/`
    const fakeFetch = (sum: string, zipUrl = `${base}vpswall-9.8.7.zip`) => async (url: string) => {
      const body = (b: Buffer | string) => ({ ok: true, status: 200, json: async () => JSON.parse(String(b)), arrayBuffer: async () => { const x = Buffer.from(b); return x.buffer.slice(x.byteOffset, x.byteOffset + x.length) } })
      if (url.endsWith('/releases/latest')) {
        return body(JSON.stringify({ tag_name: 'v9.8.7', assets: [
          { name: 'vpswall-9.8.7.zip', browser_download_url: zipUrl },
          { name: 'SHA256SUMS.txt', browser_download_url: `${base}SHA256SUMS.txt` }
        ] }))
      }
      if (url.endsWith('SHA256SUMS.txt')) return body(`${'0'.repeat(64)}  dist/vpswall-linux-amd64\n${sum}  vpswall-9.8.7.zip\n`)
      return body(zip)
    }
    const got = await fw.fetchLatestVpswall(fakeFetch(good))
    assert(got.version === '9.8.7' && got.zip.equals(zip), 'последний выпуск скачан и сверен')
    const bad = await fw.fetchLatestVpswall(fakeFetch('f'.repeat(64))).then(() => 'ok', (e: Error) => e.message)
    assert(bad.includes('не совпадает'), `подменённый архив отклонён: ${bad}`)
    const foreign = await fw.fetchLatestVpswall(fakeFetch(good, 'https://example.com/vpswall-9.8.7.zip')).then(() => 'ok', (e: Error) => e.message)
    assert(foreign.includes('нет файла'), `чужой URL архива отклонён: ${foreign}`)
    console.log('OK vpswall-latest-release')
  }

  console.log('SSH_SMOKE_OK')
}

app.whenReady().then(() => main()).then(
  () => app.exit(0),
  (error) => {
    console.error('SSH_SMOKE_FAIL', error)
    app.exit(1)
  }
)
