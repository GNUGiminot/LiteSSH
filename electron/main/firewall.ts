/**
 * «Сетевой экран»: встроенная работа с VPSWall (https://github.com/GNUGiminot/vpswall) на сервере
 * открытой SSH-сессии. LiteSSH не управляет firewall сам: все изменения идут через веб-API
 * VPSWall (тот же механизм с откатом через 120 с, что в его TUI), а LiteSSH лишь
 * - проверяет/устанавливает VPSWall (только по явному действию пользователя);
 * - включает его веб-службу (127.0.0.1:8090 на сервере) и выдаёт токен;
 * - поднимает эфемерный -L на неё и открывает панель в отдельном окне;
 * - показывает упрощённый вид «Порты» через JSON-API панели;
 * - подтверждает изменение из НОВОГО SSH-подключения (требование VPSWall).
 * Токен панели и пароль sudo живут только в памяти main-процесса и не логируются.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { inflateRawSync } from 'zlib'
import { posix } from 'path'
import { z } from 'zod'
import {
  execOnClientLimited,
  execOnProfile,
  getClient,
  onTermClosed,
  onTermMoved,
  type ConnectProfile
} from './ssh/connection-manager'
import { getSftp } from './ssh/sftp-manager'
import { startEphemeralLocal, stopTunnel, tunnelStates } from './ssh/tunnel-manager'
import type { FirewallAction, FirewallProbe, FirewallResult } from '@shared/types'

/** Порт веб-службы VPSWall на сервере (слушает только 127.0.0.1). */
export const VPSWALL_WEB_PORT = 8090

/** Репозиторий VPSWall: «Установить с GitHub» берёт его последний выпуск. */
export const VPSWALL_REPO = 'GNUGiminot/vpswall'
/** Файлы выпуска скачиваются только отсюда — какие бы URL ни вернул API. */
const VPSWALL_DOWNLOAD_PREFIX = `https://github.com/${VPSWALL_REPO}/releases/download/`
const MAX_RELEASE_BYTES = 64 * 1024 * 1024

type FetchFn = (url: string, init?: { headers?: Record<string, string>; redirect?: 'follow' }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

/**
 * Последний выпуск VPSWall с GitHub: архив `vpswall-<версия>.zip` сверяется по SHA-256
 * из `SHA256SUMS.txt` того же выпуска. Так новая версия VPSWall не требует выпуска LiteSSH;
 * доверие — к выпускам репозитория VPSWall (архив и суммы публикует один владелец).
 */
export async function fetchLatestVpswall(fetchImpl: FetchFn = fetch as unknown as FetchFn): Promise<{ version: string; zip: Buffer }> {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'LiteSSH' }
  const meta = await fetchImpl(`https://api.github.com/repos/${VPSWALL_REPO}/releases/latest`, { headers })
  if (!meta.ok) throw new Error(`GitHub: не удалось узнать последний выпуск VPSWall (HTTP ${meta.status})`)
  const rel = (await meta.json()) as { tag_name?: unknown; assets?: { name?: unknown; browser_download_url?: unknown }[] }
  const tag = typeof rel.tag_name === 'string' ? rel.tag_name : ''
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`GitHub: неожиданная метка выпуска VPSWall «${tag}»`)
  const version = tag.slice(1)
  const zipName = `vpswall-${version}.zip`
  const asset = (name: string): string => {
    const url = rel.assets?.find((a) => a.name === name)?.browser_download_url
    if (typeof url !== 'string' || !url.startsWith(`${VPSWALL_DOWNLOAD_PREFIX}${tag}/`)) {
      throw new Error(`В выпуске VPSWall ${version} нет файла ${name}`)
    }
    return url
  }
  const download = async (url: string): Promise<Buffer> => {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'LiteSSH' }, redirect: 'follow' })
    if (!res.ok) throw new Error(`Загрузка ${url.slice(url.lastIndexOf('/') + 1)}: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_RELEASE_BYTES) throw new Error('Файл выпуска VPSWall слишком большой')
    return buf
  }
  const sums = (await download(asset('SHA256SUMS.txt'))).toString('utf8')
  const expected = sums
    .split(/\r?\n/)
    .map((line) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim()))
    .find((m) => m && m[2].split('/').pop() === zipName)?.[1]
    ?.toLowerCase()
  if (!expected) throw new Error(`В SHA256SUMS.txt выпуска ${version} нет суммы для ${zipName}`)
  const zip = await download(asset(zipName))
  if (createHash('sha256').update(zip).digest('hex') !== expected) {
    throw new Error(`SHA-256 архива VPSWall ${version} не совпадает с SHA256SUMS.txt — установка отменена`)
  }
  return { version, zip }
}

type Privilege = 'root' | 'sudo' | 'sudo-password'

interface FirewallState {
  privilege?: Privilege
  /** Пароль sudo — только в памяти, до закрытия сессии */
  password?: string
  bin?: string
  token?: string
  tunnelId?: string
  localPort?: number
  remotePort: number
  panel?: BrowserWindow
  title?: string
}

class NeedPassword extends Error {}

const states = new Map<string, FirewallState>()
const profiles = new Map<string, ConnectProfile>()

function stateOf(termId: string): FirewallState {
  let st = states.get(termId)
  if (!st) {
    st = { remotePort: VPSWALL_WEB_PORT }
    states.set(termId, st)
  }
  return st
}

/** Профиль подключения вкладки — нужен для нового SSH-подключения при подтверждении. */
export function rememberProfile(termId: string, profile: ConnectProfile): void {
  profiles.set(termId, profile)
}

/** split view: новая панель на том же соединении получает профиль исходной. */
export function copyProfile(fromTermId: string, toTermId: string): void {
  const p = profiles.get(fromTermId)
  if (p) profiles.set(toTermId, p)
}

function forgetTerm(termId: string): void {
  const st = states.get(termId)
  if (st?.panel && !st.panel.isDestroyed()) st.panel.close()
  states.delete(termId)
  profiles.delete(termId)
}

function moveTerm(fromTermId: string, toTermId: string): void {
  const st = states.get(fromTermId)
  if (st) {
    states.delete(fromTermId)
    states.set(toTermId, st)
  }
  copyProfile(fromTermId, toTermId)
  profiles.delete(fromTermId)
}

// ---------- команды на сервере ----------

async function run(termId: string, command: string, input?: string, timeoutMs = 60_000) {
  return execOnClientLimited(termId, command, { timeoutMs, maxOutputBytes: 1024 * 1024, input })
}

/** Обёртка команды правами root: напрямую, через sudo -n или sudo -S с паролем на stdin. */
export function rootCommand(privilege: Privilege, command: string, preserveSsh = false): string {
  const keep = preserveSsh ? '--preserve-env=SSH_CONNECTION ' : ''
  if (privilege === 'root') return command
  if (privilege === 'sudo') return `sudo -n ${keep}${command}`
  return `sudo -S -p '' ${keep}${command}`
}

function sudoFailed(stderr: string): boolean {
  return /incorrect password|Sorry, try again|no password was provided|a password is required/i.test(stderr)
}

async function runRoot(
  termId: string,
  st: FirewallState,
  command: string,
  opts: { preserveSsh?: boolean; timeoutMs?: number } = {}
) {
  if (!st.privilege) throw new Error('Права на сервере не определены')
  if (st.privilege === 'sudo-password' && st.password === undefined) {
    throw new NeedPassword('Нужен пароль sudo')
  }
  const input = st.privilege === 'sudo-password' ? `${st.password}\n` : undefined
  const res = await run(termId, rootCommand(st.privilege, command, opts.preserveSsh), input, opts.timeoutMs)
  if (res.code !== 0 && st.privilege !== 'root' && sudoFailed(res.stderr)) {
    st.password = undefined
    throw new NeedPassword('Неверный пароль sudo')
  }
  return res
}

function commandError(res: { code: number; stdout: string; stderr: string }, what: string): Error {
  const text = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')
  return new Error(`${what}: ${text || `код ${res.code}`}`)
}

const PROBE = [
  'echo "UID=$(id -u)"',
  'echo "ARCH=$(uname -m)"',
  'echo "OS=$(uname -s)"',
  '[ -d /run/systemd/system ] && echo SYSTEMD=1',
  'p=$(PATH="$PATH:/usr/local/bin:/usr/sbin:/sbin" command -v vpswall) && echo "BIN=$p" && echo "VER=$("$p" --version 2>/dev/null)"',
  'command -v sudo >/dev/null 2>&1 && echo SUDO=1',
  'sudo -n true >/dev/null 2>&1 && echo SUDON=1',
  'true'
].join('; ')

export function parseProbe(stdout: string): FirewallProbe & { privilege?: Privilege } {
  const kv = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  const bin = kv.get('BIN')
  const ver = /vpswall\s+v?([\w.-]+)/.exec(kv.get('VER') ?? '')?.[1]
  const machine = kv.get('ARCH') ?? ''
  const arch = machine === 'x86_64' ? 'amd64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : undefined
  const privilege: Privilege | undefined =
    kv.get('UID') === '0' ? 'root' : kv.get('SUDON') ? 'sudo' : kv.get('SUDO') ? 'sudo-password' : undefined
  return {
    installed: !!bin && /^\/[\w./-]+$/.test(bin),
    version: ver,
    bin: bin && /^\/[\w./-]+$/.test(bin) ? bin : undefined,
    arch,
    machine,
    linux: kv.get('OS') === 'Linux',
    systemd: kv.get('SYSTEMD') === '1',
    privilege,
    canRoot: !!privilege
  }
}

async function probe(termId: string, st: FirewallState): Promise<FirewallProbe> {
  const res = await run(termId, `sh -c '${PROBE}'`, undefined, 20_000)
  const p = parseProbe(res.stdout)
  st.privilege = p.privilege
  st.bin = p.bin
  return p
}

// ---------- туннель и API панели ----------

function tunnelAlive(termId: string, st: FirewallState): boolean {
  if (!st.tunnelId || !st.localPort) return false
  return tunnelStates().some((t) => t.id === st.tunnelId && t.running && t.srcPort === st.localPort) &&
    !!getClient(termId)
}

async function ensureTunnel(termId: string, st: FirewallState): Promise<number> {
  if (tunnelAlive(termId, st)) return st.localPort!
  if (st.tunnelId) stopTunnel(st.tunnelId)
  const before = new Set(tunnelStates().map((t) => t.id))
  const port = await startEphemeralLocal(termId, '127.0.0.1', st.remotePort)
  st.localPort = port
  st.tunnelId = tunnelStates().find((t) => !before.has(t.id) && t.srcPort === port)?.id
  return port
}

function baseUrl(st: FirewallState): string {
  return `http://127.0.0.1:${st.localPort}`
}

/** Ждём, пока веб-служба ответит (после enable она стартует не мгновенно). */
async function waitPanel(st: FirewallState, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl(st)}/api/demo`)
      if (res.ok) return
      last = `HTTP ${res.status}`
    } catch (e) {
      last = (e as Error).message
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`Веб-служба VPSWall не отвечает на 127.0.0.1:${st.remotePort} сервера (${last})`)
}

export function parseToken(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^[A-Za-z0-9_-]{8,128}$/.test(l))
}

async function issueToken(termId: string, st: FirewallState): Promise<void> {
  const enable = await runRoot(termId, st, `${st.bin} web enable`)
  if (enable.code !== 0) throw commandError(enable, 'vpswall web enable')
  const res = await runRoot(termId, st, `${st.bin} web token`, { preserveSsh: true })
  const token = res.code === 0 ? parseToken(res.stdout) : undefined
  // stdout не пересказываем в ошибке: там мог быть токен
  if (!token) throw new Error(`vpswall web token: ${res.stderr.trim() || 'токен не получен'}`)
  st.token = token
  refreshPanelToken(st)
}

async function apiRequest(
  st: FirewallState,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const origin = baseUrl(st)
  const res = await fetch(origin + path, {
    method,
    headers: {
      Authorization: `Bearer ${st.token ?? ''}`,
      Origin: origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let data: Record<string, unknown> = {}
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch {
    // пустой ответ
  }
  return { status: res.status, data }
}

/** Подготовить доступ к панели: права, enable+token (если токена нет), туннель, ответ службы. */
async function ensurePanel(termId: string, st: FirewallState): Promise<void> {
  if (!st.bin || !st.privilege) {
    const p = await probe(termId, st)
    if (!p.installed) throw new Error('VPSWall на сервере не установлен')
    if (!p.privilege) throw new Error('Нужны права root: войдите под root или установите sudo')
  }
  await ensureTunnel(termId, st)
  if (!st.token) await issueToken(termId, st)
  await waitPanel(st)
}

async function api(termId: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const st = stateOf(termId)
  await ensurePanel(termId, st)
  let res = await apiRequest(st, method, path, body)
  if (res.status === 401) {
    // Токен истёк (8 ч) или заменён из другого сеанса — выдаём новый один раз
    st.token = undefined
    await issueToken(termId, st)
    res = await apiRequest(st, method, path, body)
  }
  if (res.status >= 400) throw new Error(String(res.data.error ?? `HTTP ${res.status}`))
  return res.data
}

// ---------- окно полной панели ----------

function refreshPanelToken(st: FirewallState): void {
  const win = st.panel
  if (!win || win.isDestroyed() || !st.token) return
  void win.webContents
    .executeJavaScript(`sessionStorage.setItem('vpswall-token', ${JSON.stringify(st.token)}); location.reload()`)
    .catch(() => undefined)
}

function openPanelWindow(st: FirewallState, title: string): void {
  if (st.panel && !st.panel.isDestroyed()) {
    st.panel.focus()
    return
  }
  const origin = baseUrl(st)
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: `VPSWall — ${title}`,
    autoHideMenuBar: true,
    webPreferences: {
      // Отдельная непостоянная сессия: sessionStorage панели не попадает на диск и в другие окна
      partition: `vpswall-${randomUUID()}`,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  st.panel = win
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${origin}/`) && url !== origin) e.preventDefault()
  })
  win.on('page-title-updated', (e) => e.preventDefault())
  win.on('closed', () => {
    if (st.panel === win) st.panel = undefined
  })
  // Панель берёт токен из sessionStorage; подставляем его после первой загрузки и перезагружаем
  win.webContents.once('did-finish-load', () => refreshPanelToken(st))
  void win.loadURL(`${origin}/`)
}

// ---------- установка ----------

/** Минимальное чтение zip (stored/deflate) — достаточно для релизного архива VPSWall. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Файл не похож на zip-архив')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Повреждён каталог zip')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    if (method === 0) out.set(name, Buffer.from(raw))
    else if (method === 8) out.set(name, inflateRawSync(raw))
    else throw new Error(`Неподдерживаемое сжатие в zip: ${name}`)
  }
  return out
}

/**
 * Из архива нужны install.sh, бинарник под архитектуру сервера и dist/SHA256SUMS,
 * если он есть: install.sh начиная с VPSWall 0.4.0 без него отказывается ставить.
 */
export function pickInstallFiles(entries: Map<string, Buffer>, arch: string) {
  const script = [...entries.keys()].find((k) => k === 'install.sh' || k.endsWith('/install.sh'))
  if (!script) throw new Error('В архиве нет install.sh — это не релиз VPSWall')
  const prefix = script.slice(0, -'install.sh'.length)
  const binary = entries.get(`${prefix}dist/vpswall-linux-${arch}`)
  if (!binary) throw new Error(`В архиве нет dist/vpswall-linux-${arch}`)
  return { script: entries.get(script)!, binary, sums: entries.get(`${prefix}dist/SHA256SUMS`) }
}

async function loadRelease(
  source: 'github' | 'file',
  win: BrowserWindow | null
): Promise<{ zip: Buffer; version?: string } | null> {
  if (source === 'file') {
    const opts = {
      title: 'Архив релиза VPSWall',
      filters: [{ name: 'zip', extensions: ['zip'] }],
      properties: ['openFile' as const]
    }
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (pick.canceled || !pick.filePaths.length) return null
    return { zip: await readFile(pick.filePaths[0]) }
  }
  return fetchLatestVpswall()
}

function sftpWrite(termId: string, path: string, data: Buffer, mode: number): Promise<void> {
  return getSftp(termId).then(
    (sftp) =>
      new Promise<void>((resolve, reject) =>
        sftp.writeFile(path, data, { mode }, (e) => (e ? reject(e) : resolve()))
      )
  )
}

async function install(termId: string, st: FirewallState, zip: Buffer): Promise<string> {
  const p = await probe(termId, st)
  if (!p.linux || !p.systemd) throw new Error('VPSWall требует Linux с systemd')
  if (!p.arch) throw new Error(`Архитектура ${p.machine || '?'} не поддерживается (нужна amd64 или arm64)`)
  if (!p.privilege) throw new Error('Нужны права root: войдите под root или установите sudo')
  if (p.privilege === 'sudo-password' && st.password === undefined) throw new NeedPassword('Нужен пароль sudo')
  const files = pickInstallFiles(readZip(zip), p.arch)
  const mk = await run(termId, 'mktemp -d /tmp/litessh-vpswall.XXXXXX')
  const dir = mk.stdout.trim()
  if (mk.code !== 0 || !/^\/tmp\/litessh-vpswall\.\w+$/.test(dir)) throw commandError(mk, 'mktemp')
  try {
    await run(termId, `mkdir -p ${dir}/dist`)
    await sftpWrite(termId, posix.join(dir, 'install.sh'), files.script, 0o644)
    await sftpWrite(termId, posix.join(dir, 'dist', `vpswall-linux-${p.arch}`), files.binary, 0o755)
    if (files.sums) await sftpWrite(termId, posix.join(dir, 'dist', 'SHA256SUMS'), files.sums, 0o644)
    const res = await runRoot(termId, st, `sh ${dir}/install.sh`, { timeoutMs: 180_000 })
    if (res.code !== 0) throw commandError(res, 'install.sh')
    await probe(termId, st)
    return res.stdout.trim().split('\n').slice(-1)[0] ?? ''
  } finally {
    await run(termId, `rm -rf ${dir}`).catch(() => undefined)
  }
}

// ---------- подтверждение из нового SSH ----------

async function confirm(termId: string, st: FirewallState, win: BrowserWindow, code: string, sshPort?: string) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) throw new Error('Неверный код подтверждения')
  const profile = profiles.get(termId)
  if (!profile) throw new Error('Параметры подключения этой вкладки недоступны — подтвердите вручную из нового SSH')
  if (!st.bin || !st.privilege) await probe(termId, st)
  if (!st.privilege) throw new Error('Нужны права root')
  if (st.privilege === 'sudo-password' && st.password === undefined) throw new NeedPassword('Нужен пароль sudo')
  const port = sshPort && /^\d{1,5}$/.test(sshPort) ? Number(sshPort) : profile.port
  const input = st.privilege === 'sudo-password' ? `${st.password}\n` : undefined
  const res = await execOnProfile(
    win,
    { ...profile, port },
    rootCommand(st.privilege, `${st.bin} confirm ${code}`, true),
    input
  )
  if (res.code !== 0) {
    if (st.privilege !== 'root' && sudoFailed(res.stderr)) {
      st.password = undefined
      throw new NeedPassword('Неверный пароль sudo')
    }
    throw commandError(res, 'vpswall confirm')
  }
  return port
}

// ---------- IPC ----------

const ActionSchema: z.ZodType<FirewallAction> = z
  .object({
    op: z.enum(['rule-save', 'rule-delete', 'window-add', 'window-pause', 'window-delete', 'rollback']),
    revision: z.string().max(200).optional(),
    id: z.string().max(100).optional(),
    action: z.enum(['allow', 'deny', 'reject']).optional(),
    protocol: z.string().max(10).optional(),
    port: z.string().max(20).optional(),
    source: z.string().max(100).optional(),
    comment: z.string().max(200).optional(),
    priority: z.number().int().min(0).max(9999).optional(),
    kind: z.enum(['lease', 'daily', 'once']).optional(),
    clock: z.string().max(10).optional(),
    zone: z.string().max(100).optional(),
    duration: z.string().max(10).optional(),
    start: z.string().max(30).optional()
  })
  .strict()

async function handle(fn: () => Promise<Record<string, unknown> | void>): Promise<FirewallResult> {
  try {
    return { ok: true, ...((await fn()) ?? {}) }
  } catch (e) {
    if (e instanceof NeedPassword) return { ok: false, needPassword: true, error: e.message }
    return { ok: false, error: (e as Error).message ?? String(e) }
  }
}

function setPassword(st: FirewallState, password: unknown): void {
  if (typeof password === 'string') st.password = password
}

export function registerFirewallIpc(): void {
  onTermClosed(forgetTerm)
  onTermMoved(moveTerm)

  ipcMain.handle('firewall:probe', (_e, termId: string) =>
    handle(async () => ({ probe: await probe(String(termId), stateOf(String(termId))) }))
  )

  ipcMain.handle('firewall:install', (e, termId: string, source: 'github' | 'file', password?: string) =>
    handle(async () => {
      const st = stateOf(String(termId))
      setPassword(st, password)
      const release = await loadRelease(source === 'file' ? 'file' : 'github', BrowserWindow.fromWebContents(e.sender))
      if (!release) return { canceled: true }
      const message = await install(String(termId), st, release.zip)
      return { message: release.version ? `VPSWall ${release.version}: ${message || 'установлен'}` : message }
    })
  )

  ipcMain.handle('firewall:connect', (_e, termId: string, password?: string) =>
    handle(async () => {
      const st = stateOf(String(termId))
      setPassword(st, password)
      await ensurePanel(String(termId), st)
      return { port: st.localPort }
    })
  )

  ipcMain.handle('firewall:state', (_e, termId: string) =>
    handle(async () => ({ state: await api(String(termId), 'GET', '/api/state') }))
  )

  ipcMain.handle('firewall:job', (_e, termId: string) =>
    handle(async () => ({ job: await api(String(termId), 'GET', '/api/job') }))
  )

  ipcMain.handle('firewall:action', (_e, termId: string, raw: unknown) =>
    handle(async () => ({ job: await api(String(termId), 'POST', '/api/action', ActionSchema.parse(raw)) }))
  )

  ipcMain.handle('firewall:panel', (_e, termId: string, title: string) =>
    handle(async () => {
      const st = stateOf(String(termId))
      await ensurePanel(String(termId), st)
      openPanelWindow(st, String(title || 'сервер'))
    })
  )

  ipcMain.handle('firewall:confirm', (e, termId: string, code: string, sshPort?: string, password?: string) =>
    handle(async () => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) throw new Error('Окно не найдено')
      const st = stateOf(String(termId))
      setPassword(st, password)
      return { port: await confirm(String(termId), st, win, String(code), sshPort ? String(sshPort) : undefined) }
    })
  )

  ipcMain.handle('firewall:disable-web', (_e, termId: string, password?: string) =>
    handle(async () => {
      const st = stateOf(String(termId))
      setPassword(st, password)
      if (!st.bin || !st.privilege) await probe(String(termId), st)
      const res = await runRoot(String(termId), st, `${st.bin} web disable`)
      if (res.code !== 0) throw commandError(res, 'vpswall web disable')
      if (st.panel && !st.panel.isDestroyed()) st.panel.close()
      if (st.tunnelId) stopTunnel(st.tunnelId)
      st.token = undefined
      st.tunnelId = undefined
      st.localPort = undefined
    })
  )
}

/** Для smoke-теста: прямой вызов без IPC (stateOf(...).remotePort — порт демо-панели). */
export const _testApi = {
  api,
  stateOf,
  confirm: (termId: string, win: BrowserWindow, code: string, sshPort?: string) =>
    confirm(termId, stateOf(termId), win, code, sshPort),
  openPanel: (termId: string, title: string) => {
    openPanelWindow(stateOf(termId), title)
    return stateOf(termId).panel!
  }
}
