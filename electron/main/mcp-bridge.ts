import { app, BrowserWindow } from 'electron'
import { createServer, type Server as HttpServer } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { posix } from 'path'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { z } from 'zod'
import type { SFTPWrapper } from 'ssh2'
import { getClient, execOnClientLimited } from './ssh/connection-manager'
import { getSftp, sftpRemove } from './ssh/sftp-manager'
import { beginMcpActivity, exportMcpActivity, finishMcpActivity, listMcpActivity, updateMcpActivity, updateMcpOutput } from './mcp-activity'
import type {
  McpAccessMode,
  McpActivityEvent,
  McpAuditEntry,
  McpBridgeConfig,
  McpBridgeState,
  McpClientToken
} from '@shared/types'

const DEFAULT_PORT = 27183
const MAX_REQUEST_BYTES = 6 * 1024 * 1024
const MAX_READ_BYTES = 1024 * 1024
const MAX_WRITE_BYTES = 4 * 1024 * 1024
const MAX_LIST_ENTRIES = 2000
const S_IFMT = 0xf000
const S_IFDIR = 0x4000

interface AccessGrant {
  termId: string
  title: string
  root: string
  mode: McpAccessMode
  allowExec: boolean
  port: number
  startedAt: number
}

interface Runtime {
  access: AccessGrant
  clients: McpClientToken[]
  http: HttpServer
  handler: ReturnType<typeof createMcpHandler>
}

const runtimes = new Map<string, Runtime>()
const requestClient = new AsyncLocalStorage<McpActivityEvent['client']>()
const startingTerms = new Set<string>()
const startingPorts = new Set<number>()
const audit: McpAuditEntry[] = []

function emitState(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('mcp:state')
  }
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}

function newClientTokens(): McpClientToken[] {
  return [
    { id: 'codex', label: 'Codex', token: newToken() },
    { id: 'claude', label: 'Claude Code', token: newToken() },
    { id: 'other', label: 'Другой клиент', token: newToken() }
  ]
}


function record(tool: string, ok: boolean, detail: string): void {
  audit.unshift({ ts: Date.now(), tool, ok, detail: detail.slice(0, 500) })
  audit.splice(100)
  emitState()
}

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function call<T>(
  access: AccessGrant,
  tool: string,
  detail: string,
  params: McpActivityEvent['params'],
  fn: (eventId: string) => Promise<T>,
  command?: string
): Promise<T> {
  const eventId = beginMcpActivity({
    termId: access.termId,
    server: access.title,
    client: requestClient.getStore() ?? 'other',
    tool,
    summary: detail.slice(0, 500),
    params,
    ...(command ? { command } : {})
  })
  return fn(eventId).then(
    (value) => {
      finishMcpActivity(eventId, { status: 'ok' })
      record(tool, true, detail)
      return value
    },
    (error: unknown) => {
      finishMcpActivity(eventId, { status: 'error', error: String((error as Error).message ?? error).slice(0, 500) })
      record(tool, false, `${detail}: ${(error as Error).message}`)
      throw error
    }
  )
}

function result(value: unknown) {
  const structured = value && typeof value === 'object' ? value as Record<string, unknown> : { value }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: structured
  }
}

function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) =>
    sftp.realpath(path, (error, resolved) => error ? reject(error) : resolve(resolved))
  )
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<{ size: number; mtime: number; mode: number }> {
  return new Promise((resolve, reject) =>
    sftp.stat(path, (error, attrs) => error ? reject(error) : resolve(attrs))
  )
}

function sftpLstat(sftp: SFTPWrapper, path: string): Promise<{ size: number; mtime: number; mode: number }> {
  return new Promise((resolve, reject) =>
    sftp.lstat(path, (error, attrs) => error ? reject(error) : resolve(attrs))
  )
}

function inside(root: string, path: string): boolean {
  return root === '/' ? path.startsWith('/') : path === root || path.startsWith(`${root}/`)
}

function lexicalPath(root: string, requested: string): string {
  const raw = requested.trim() || '.'
  const candidate = raw.startsWith('/') ? posix.normalize(raw) : posix.resolve(root, raw)
  if (!inside(root, candidate)) throw new Error(`Путь вне разрешённой области: ${requested}`)
  return candidate
}

async function existingPath(sftp: SFTPWrapper, root: string, requested: string): Promise<string> {
  const candidate = lexicalPath(root, requested)
  const resolved = await sftpRealpath(sftp, candidate)
  if (!inside(root, resolved)) throw new Error('Символическая ссылка ведёт за пределы разрешённой области')
  return candidate
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code
  return code === 2 || code === 'ENOENT' || /no such file/i.test((error as Error)?.message ?? '')
}

async function writablePath(sftp: SFTPWrapper, root: string, requested: string): Promise<string> {
  const candidate = lexicalPath(root, requested)
  if (candidate === root) throw new Error('Нельзя заменить корень разрешённой области')
  try {
    return await existingPath(sftp, root, requested)
  } catch (error) {
    if (!isMissing(error)) throw error
    const parent = await existingPath(sftp, root, posix.dirname(candidate))
    const target = posix.join(parent, posix.basename(candidate))
    if (!inside(root, target)) throw error
    return target
  }
}

function relativePath(root: string, path: string): string {
  const rel = posix.relative(root, path)
  return rel || '.'
}

function readChunk(
  sftp: SFTPWrapper,
  path: string,
  offset: number,
  bytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, 'r', (openError, handle) => {
      if (openError) return reject(openError)
      const buffer = Buffer.alloc(bytes)
      sftp.read(handle, buffer, 0, bytes, offset, (readError, bytesRead) => {
        sftp.close(handle, () => {
          if (readError) reject(readError)
          else resolve(buffer.subarray(0, bytesRead))
        })
      })
    })
  })
}

function writeRemote(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.writeFile(path, data, (error) => error ? reject(error) : resolve())
  )
}

function mkdirRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.mkdir(path, (error) => error ? reject(error) : resolve())
  )
}

function renameRemote(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.rename(from, to, (error) => error ? reject(error) : resolve())
  )
}

function listRemote(sftp: SFTPWrapper, path: string) {
  return new Promise<{ filename: string; attrs: { size: number; mtime: number; mode: number } }[]>(
    (resolve, reject) => sftp.readdir(path, (error, entries) => error ? reject(error) : resolve(entries))
  )
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function buildMcpServer(access: AccessGrant): McpServer {
  const server = new McpServer(
    { name: 'litessh', version: '1.1.4' },
    {
      instructions:
        `Работайте только в разрешённом SSH-корне ${access.root}. ` +
        `Режим: ${access.mode === 'read-only' ? 'только чтение' : 'чтение и запись'}. ` +
        'Сначала осматривайте файлы, минимизируйте изменения и сообщайте пути изменённых объектов.'
    }
  )

  server.registerTool(
    'ssh_session_info',
    {
      title: 'SSH session access',
      description: 'Show the active LiteSSH MCP grant and its restrictions.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async () => call(access, 'ssh_session_info', 'Доступ к сессии', {}, async () =>
      result({ title: access.title, root: access.root, mode: access.mode, allowExec: access.allowExec })
    )
  )

  server.registerTool(
    'ssh_list_directory',
    {
      title: 'List remote directory',
      description: 'List files in a remote directory inside the granted root.',
      inputSchema: z.object({ path: z.string().default('.') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ path }) => call(access, 'ssh_list_directory', path, { path }, async () => {
      const sftp = await getSftp(access.termId)
      const absolute = await existingPath(sftp, access.root, path)
      const entries = await listRemote(sftp, absolute)
      if (entries.length > MAX_LIST_ENTRIES) throw new Error(`Слишком много записей: ${entries.length}; максимум ${MAX_LIST_ENTRIES}`)
      return result({
        path: relativePath(access.root, absolute),
        entries: entries
          .map((entry) => ({
            name: entry.filename,
            path: relativePath(access.root, posix.join(absolute, entry.filename)),
            type: (entry.attrs.mode & S_IFMT) === S_IFDIR ? 'directory' : 'file',
            size: entry.attrs.size,
            modifiedAt: entry.attrs.mtime * 1000,
            mode: (entry.attrs.mode & 0o7777).toString(8)
          }))
          .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1)
      })
    })
  )

  server.registerTool(
    'ssh_stat',
    {
      title: 'Stat remote path',
      description: 'Read metadata for a remote file or directory inside the granted root.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ path }) => call(access, 'ssh_stat', path, { path }, async () => {
      const sftp = await getSftp(access.termId)
      const absolute = await existingPath(sftp, access.root, path)
      const stat = await sftpStat(sftp, absolute)
      return result({
        path: relativePath(access.root, absolute),
        type: (stat.mode & S_IFMT) === S_IFDIR ? 'directory' : 'file',
        size: stat.size,
        modifiedAt: stat.mtime * 1000,
        mode: (stat.mode & 0o7777).toString(8)
      })
    })
  )

  server.registerTool(
    'ssh_read_file',
    {
      title: 'Read remote file',
      description: `Read at most ${MAX_READ_BYTES} bytes from a remote file. Use offset for subsequent chunks.`,
      inputSchema: z.object({
        path: z.string(),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        offset: z.number().int().min(0).default(0),
        maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(256 * 1024)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ path, encoding, offset, maxBytes }) => call(access, 'ssh_read_file', `${path} @${offset}`, { path, encoding, offset, maxBytes }, async () => {
      const sftp = await getSftp(access.termId)
      const absolute = await existingPath(sftp, access.root, path)
      const stat = await sftpStat(sftp, absolute)
      if ((stat.mode & S_IFMT) === S_IFDIR) throw new Error('Указанный путь является каталогом')
      const length = Math.min(maxBytes, Math.max(0, stat.size - offset))
      const data = length ? await readChunk(sftp, absolute, offset, length) : Buffer.alloc(0)
      return result({
        path: relativePath(access.root, absolute),
        encoding,
        offset,
        size: stat.size,
        nextOffset: offset + data.length,
        eof: offset + data.length >= stat.size,
        content: data.toString(encoding)
      })
    })
  )

  if (access.mode === 'read-write') {
    server.registerTool(
      'ssh_write_file',
      {
        title: 'Write remote file',
        description: `Create or replace a remote file inside the granted root (maximum ${MAX_WRITE_BYTES} bytes).`,
        inputSchema: z.object({
          path: z.string(),
          content: z.string(),
          encoding: z.enum(['utf8', 'base64']).default('utf8')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
      },
      async ({ path, content, encoding }) => call(access, 'ssh_write_file', path, { path, encoding, bytes: Buffer.byteLength(content, encoding) }, async () => {
        const data = Buffer.from(content, encoding)
        if (data.length > MAX_WRITE_BYTES) throw new Error(`Файл превышает лимит ${MAX_WRITE_BYTES} байт`)
        const sftp = await getSftp(access.termId)
        const absolute = await writablePath(sftp, access.root, path)
        await writeRemote(sftp, absolute, data)
        return result({ path: relativePath(access.root, absolute), bytesWritten: data.length })
      })
    )

    server.registerTool(
      'ssh_mkdir',
      {
        title: 'Create remote directory',
        description: 'Create one remote directory inside the granted root. Its parent must exist.',
        inputSchema: z.object({ path: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
      },
      async ({ path }) => call(access, 'ssh_mkdir', path, { path }, async () => {
        const sftp = await getSftp(access.termId)
        const absolute = await writablePath(sftp, access.root, path)
        await mkdirRemote(sftp, absolute)
        return result({ path: relativePath(access.root, absolute) })
      })
    )

    server.registerTool(
      'ssh_rename',
      {
        title: 'Rename remote path',
        description: 'Rename or move a remote path; both paths must remain inside the granted root.',
        inputSchema: z.object({ from: z.string(), to: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
      },
      async ({ from, to }) => call(access, 'ssh_rename', `${from} -> ${to}`, { from, to }, async () => {
        const sftp = await getSftp(access.termId)
        const source = await existingPath(sftp, access.root, from)
        if (source === access.root) throw new Error('Нельзя переименовать корень разрешённой области')
        const target = await writablePath(sftp, access.root, to)
        await renameRemote(sftp, source, target)
        return result({ from: relativePath(access.root, source), to: relativePath(access.root, target) })
      })
    )

    server.registerTool(
      'ssh_remove',
      {
        title: 'Remove remote path',
        description: 'Delete a file or, only with recursive=true, a directory inside the granted root.',
        inputSchema: z.object({ path: z.string(), recursive: z.boolean().default(false) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
      },
      async ({ path, recursive }) => call(access, 'ssh_remove', path, { path, recursive }, async () => {
        const sftp = await getSftp(access.termId)
        const absolute = await existingPath(sftp, access.root, path)
        if (absolute === access.root) throw new Error('Нельзя удалить корень разрешённой области')
        const stat = await sftpLstat(sftp, absolute)
        const isDir = (stat.mode & S_IFMT) === S_IFDIR
        if (isDir && !recursive) throw new Error('Для удаления каталога требуется recursive=true')
        await sftpRemove(access.termId, absolute, isDir)
        return result({ path: relativePath(access.root, absolute), removed: true })
      })
    )
  }

  if (access.allowExec) {
    server.registerTool(
      'ssh_exec',
      {
        title: 'Execute SSH command',
        description: 'Execute a command through the active SSH connection. Shell access may affect files outside the granted SFTP root.',
        inputSchema: z.object({
          command: z.string().min(1).max(64 * 1024),
          cwd: z.string().default('.'),
          timeoutSeconds: z.number().int().min(1).max(120).default(60)
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
      },
      async ({ command, cwd, timeoutSeconds }) => call(access, 'ssh_exec', `Команда SSH (${command.length} символов)`, { cwd, timeoutSeconds, commandLength: command.length }, async (eventId) => {
        const sftp = await getSftp(access.termId)
        const absoluteCwd = await existingPath(sftp, access.root, cwd)
        const stat = await sftpStat(sftp, absoluteCwd)
        if ((stat.mode & S_IFMT) !== S_IFDIR) throw new Error('cwd должен быть каталогом')
        const executed = `cd -- ${posixQuote(absoluteCwd)} && ${command}`
        const executedResult = await execOnClientLimited(access.termId, executed, {
          timeoutMs: timeoutSeconds * 1000,
          maxOutputBytes: 1024 * 1024,
          onStdout: (chunk) => updateMcpOutput(eventId, 'stdout', chunk),
          onStderr: (chunk) => updateMcpOutput(eventId, 'stderr', chunk)
        })
        updateMcpActivity(eventId, { exitCode: executedResult.code, truncated: executedResult.truncated })
        return result(executedResult)
      }, command)
    )
  }

  return server
}

function responseJson(text: string): Record<string, unknown> {
  const dataLine = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data:'))
  const payload = dataLine ? dataLine.slice(5).trim() : text
  return JSON.parse(payload) as Record<string, unknown>
}

/** Проверяет initialize и реальный tools/list без подключения к SSH. */
export async function smokeMcpProtocol(): Promise<number> {
  const access: AccessGrant = {
    termId: 'smoke',
    title: 'Smoke',
    root: '/tmp',
    mode: 'read-write',
    allowExec: true,
    port: 0,
    startedAt: Date.now()
  }
  const handler = createMcpHandler(() => buildMcpServer(access), {
    legacy: 'stateless',
    responseMode: 'json'
  })
  const request = async (body: Record<string, unknown>) => {
    const response = await handler.fetch(new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-03-26'
      },
      body: JSON.stringify(body)
    }))
    if (!response.ok) throw new Error(`MCP smoke HTTP ${response.status}: ${await response.text()}`)
    return responseJson(await response.text())
  }
  try {
    const initialized = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'litessh-smoke', version: '1.0.0' }
      }
    })
    if (!initialized.result) throw new Error('MCP initialize не вернул result')
    const listed = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = (listed.result as { tools?: unknown[] } | undefined)?.tools
    if (!Array.isArray(tools) || tools.length < 8) throw new Error('MCP tools/list вернул неполный список')
    return tools.length
  } finally {
    await handler.close()
  }
}

function validLoopbackRequest(hostHeader: string | undefined, originHeader: string | undefined): boolean {
  const host = (hostHeader ?? '').toLowerCase().replace(/:\d+$/, '')
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  if (!originHeader) return true
  try {
    const origin = new URL(originHeader).hostname.toLowerCase()
    return origin === '127.0.0.1' || origin === 'localhost'
  } catch {
    return false
  }
}

function stateOf(current: Runtime): McpBridgeState {
  const { access, clients } = current
  return {
    running: true,
    url: `http://127.0.0.1:${access.port}/mcp`,
    token: clients.find((client) => client.id === 'other')?.token,
    clients: clients.map((client) => ({ ...client })),
    termId: access.termId,
    title: access.title,
    root: access.root,
    mode: access.mode,
    allowExec: access.allowExec,
    port: access.port,
    startedAt: access.startedAt,
    audit: [...audit]
  }
}

export function getMcpBridgeState(termId: string): McpBridgeState {
  const current = runtimes.get(termId)
  return current ? stateOf(current) : { running: false, audit: [...audit] }
}

export function listMcpBridges(): McpBridgeState[] {
  return [...runtimes.values()]
    .map((current) => ({ ...stateOf(current), token: undefined, clients: undefined, audit: [] }))
    .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))
}

async function openRuntime(access: AccessGrant, clients: McpClientToken[]): Promise<Runtime> {
  const handler = createMcpHandler(() => buildMcpServer(access), {
    legacy: 'stateless',
    responseMode: 'auto',
    onerror: (error) => record('protocol', false, error.message)
  })
  const handleMcp = toNodeHandler(handler, {
    onerror: (error) => record('transport', false, error.message)
  })
  const http = createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0]
    if (pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not found')
    }
    if (!validLoopbackRequest(req.headers.host, req.headers.origin)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Loopback requests only')
    }
    const authorization = req.headers.authorization ?? ''
    const current = runtimes.get(access.termId)
    const client = current?.http === http && authorization.startsWith('Bearer ')
      ? current.clients.find((item) => secureEqual(authorization.slice(7), item.token))
      : undefined
    if (!client) {
      res.writeHead(401, {
        'content-type': 'text/plain; charset=utf-8',
        'www-authenticate': 'Bearer realm="LiteSSH MCP"'
      })
      return res.end('Unauthorized')
    }
    const contentLength = Number(req.headers['content-length'] ?? 0)
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_REQUEST_BYTES) {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Request too large')
    }
    requestClient.run(client.id, () => { void handleMcp(req, res) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      http.once('error', onError)
      http.listen(access.port, '127.0.0.1', () => {
        http.off('error', onError)
        resolve()
      })
    })
  } catch (error) {
    await handler.close().catch(() => undefined)
    throw error
  }
  if (access.port === 0) access.port = (http.address() as { port: number }).port
  return { access, clients, http, handler }
}

export async function startMcpBridge(config: McpBridgeConfig): Promise<McpBridgeState> {
  const port = Number(config.port || DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Порт должен быть от 1024 до 65535')
  if (startingTerms.has(config.termId)) throw new Error('MCP для этой сессии уже запускается')
  if (startingPorts.has(port) || [...runtimes.values()].some((item) => item.access.port === port && item.access.termId !== config.termId)) {
    throw new Error(`Порт ${port} уже занят другим MCP-мостом`)
  }
  startingTerms.add(config.termId)
  startingPorts.add(port)
  try {
    if (!getClient(config.termId)) throw new Error('SSH-сессия не активна')
    const sftp = await getSftp(config.termId)
    const root = await sftpRealpath(sftp, config.root.trim() || '.')
    const stat = await sftpStat(sftp, root)
    if ((stat.mode & S_IFMT) !== S_IFDIR) throw new Error('Разрешённый корень должен быть каталогом')
    if (!getClient(config.termId)) throw new Error('SSH-сессия закрылась во время запуска MCP')
    const access: AccessGrant = {
      termId: config.termId,
      title: config.title.slice(0, 200),
      root,
      mode: config.mode,
      allowExec: !!config.allowExec,
      port,
      startedAt: Date.now()
    }
    // У каждого моста свой секрет: доступ к одному серверу не открывает другие.
    const clients = newClientTokens()
    if (runtimes.has(config.termId)) await stopMcpBridge(config.termId)
    const current = await openRuntime(access, clients)
    if (!getClient(config.termId)) {
      await current.handler.close().catch(() => undefined)
      current.http.close()
      throw new Error('SSH-сессия закрылась во время запуска MCP')
    }
    runtimes.set(config.termId, current)
    record('bridge', true, `Доступ открыт для ${access.title}: ${access.root}`)
    return getMcpBridgeState(config.termId)
  } finally {
    startingTerms.delete(config.termId)
    startingPorts.delete(port)
  }
}

export async function stopMcpBridge(termId: string): Promise<McpBridgeState> {
  const current = runtimes.get(termId)
  runtimes.delete(termId)
  if (current) {
    await current.handler.close().catch(() => undefined)
    await new Promise<void>((resolve) => current.http.close(() => resolve()))
    audit.unshift({ ts: Date.now(), tool: 'bridge', ok: true, detail: 'Доступ закрыт' })
    audit.splice(100)
  }
  emitState()
  return getMcpBridgeState(termId)
}

export async function rotateMcpToken(termId: string): Promise<McpBridgeState> {
  const current = runtimes.get(termId)
  if (!current) throw new Error('MCP для этой SSH-сессии не запущен')
  current.clients = newClientTokens()
  record('bridge', true, 'Токен доступа изменён')
  return getMcpBridgeState(termId)
}

/** Интеграционная проверка независимости двух HTTP-мостов без реальных SSH-серверов. */
export async function smokeMcpParallel(): Promise<number> {
  const createGrant = (termId: string): AccessGrant => ({
    termId, title: termId, root: '/', mode: 'read-only', allowExec: false,
    port: 0, startedAt: Date.now()
  })
  const firstId = 'mcp-smoke-first'
  const secondId = 'mcp-smoke-second'
  const firstClients = newClientTokens()
  const secondClients = newClientTokens()
  const firstToken = firstClients[0].token
  const secondToken = secondClients[1].token
  const request = (port: number, token: string, body: Record<string, unknown> = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-parallel-smoke', version: '1' } }
  }) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-03-26'
    },
    body: JSON.stringify(body)
  })
  try {
    runtimes.set(firstId, await openRuntime(createGrant(firstId), firstClients))
    runtimes.set(secondId, await openRuntime(createGrant(secondId), secondClients))
    const firstPort = runtimes.get(firstId)!.access.port
    const secondPort = runtimes.get(secondId)!.access.port
    if (firstPort === secondPort || listMcpBridges().length !== 2) throw new Error('Два MCP-моста не запустились независимо')
    const [firstOk, secondOk, wrongToken] = await Promise.all([
      request(firstPort, firstToken), request(secondPort, secondToken), request(secondPort, firstToken)
    ])
    if (!firstOk.ok || !secondOk.ok || wrongToken.status !== 401) {
      throw new Error(`MCP isolation: ${firstOk.status}/${secondOk.status}/${wrongToken.status}`)
    }
    const toolBody = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ssh_session_info', arguments: {} } }
    const [firstTool, secondTool] = await Promise.all([
      request(firstPort, firstToken, toolBody), request(secondPort, secondToken, toolBody)
    ])
    if (!firstTool.ok || !secondTool.ok) throw new Error(`MCP activity calls: ${firstTool.status}/${secondTool.status}`)
    await Promise.all([firstTool.text(), secondTool.text()])
    const firstEvents = await listMcpActivity({ termId: firstId })
    const secondEvents = await listMcpActivity({ termId: secondId })
    if (!firstEvents.some((event) => event.client === 'codex' && event.tool === 'ssh_session_info') ||
        !secondEvents.some((event) => event.client === 'claude' && event.tool === 'ssh_session_info')) {
      throw new Error('MCP-вызовы не были атрибутированы по токенам клиентов')
    }
    const secretEvent = beginMcpActivity({
      termId: firstId, server: firstId, client: 'codex', tool: 'ssh_exec',
      summary: 'Команда SSH (14 символов)', params: { commandLength: 14 }, command: 'secret=private'
    })
    updateMcpOutput(secretEvent, 'stdout', 'private-output')
    finishMcpActivity(secretEvent, { status: 'ok' })
    const exportPath = join(app.getPath('userData'), 'mcp-smoke-export.jsonl')
    try {
      const count = await exportMcpActivity(exportPath, { termId: firstId })
      const exported = await fsp.readFile(exportPath, 'utf8')
      if (count < 2 || exported.includes('secret=private') || exported.includes('private-output')) {
        throw new Error('Экспорт MCP сохранил секретные данные или не записал события')
      }
    } finally {
      await fsp.rm(exportPath, { force: true })
    }
    await stopMcpBridge(firstId)
    if (listMcpBridges().length !== 1 || !(await request(secondPort, secondToken)).ok) {
      throw new Error('Закрытие одного MCP отключило другой')
    }
    const rotated = await rotateMcpToken(secondId)
    const rotatedToken = rotated.clients?.find((client) => client.id === 'claude')?.token
    if (!rotatedToken || (await request(secondPort, secondToken)).status !== 401 || !(await request(secondPort, rotatedToken)).ok) {
      throw new Error('Ротация токена MCP нарушила изоляцию')
    }
    return 2
  } finally {
    await stopMcpBridge(firstId)
    await stopMcpBridge(secondId)
  }
}

export function revokeMcpForTerm(termId: string): void {
  if (runtimes.has(termId)) void stopMcpBridge(termId)
}

export function closeMcpBridge(): void {
  for (const current of runtimes.values()) {
    void current.handler.close()
    current.http.close()
  }
  runtimes.clear()
}
