import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { createReadStream, promises as fsp } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import type { McpActivityEvent, McpActivityFilter } from '@shared/types'

const KEEP_DAYS = 14
const SEGMENT_BYTES = 5 * 1024 * 1024
const MEMORY_EVENTS = 500
const OUTPUT_PREVIEW_BYTES = 32 * 1024
const recent = new Map<string, McpActivityEvent>()
let writeQueue: Promise<void> = Promise.resolve()
let lastCleanupDay = ''

export function flushMcpActivity(): Promise<void> {
  return writeQueue
}

function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function dayOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function emit(event: McpActivityEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('mcp:activity', { ...event })
  }
}

function remember(event: McpActivityEvent): void {
  recent.delete(event.id)
  recent.set(event.id, event)
  while (recent.size > MEMORY_EVENTS) recent.delete(recent.keys().next().value!)
  emit(event)
}

function stored(event: McpActivityEvent): McpActivityEvent {
  const { command: _command, stdout: _stdout, stderr: _stderr, ...safe } = event
  return safe
}

async function cleanup(day: string): Promise<void> {
  if (lastCleanupDay === day) return
  lastCleanupDay = day
  const oldest = dayOf(Date.now() - (KEEP_DAYS - 1) * 86_400_000)
  for (const name of await fsp.readdir(logDir())) {
    const match = /^mcp-(\d{4}-\d{2}-\d{2})(?:\.1)?\.jsonl$/.exec(name)
    if (match && match[1] < oldest) await fsp.rm(join(logDir(), name), { force: true })
  }
}

function persist(event: McpActivityEvent): void {
  const snapshot = stored(event)
  writeQueue = writeQueue.then(async () => {
    const dir = logDir()
    await fsp.mkdir(dir, { recursive: true })
    const day = dayOf(snapshot.startedAt)
    await cleanup(day)
    const file = join(dir, `mcp-${day}.jsonl`)
    const archive = join(dir, `mcp-${day}.1.jsonl`)
    const size = await fsp.stat(file).then((stat) => stat.size, () => 0)
    if (size >= SEGMENT_BYTES) {
      await fsp.rm(archive, { force: true })
      await fsp.rename(file, archive)
    }
    await fsp.appendFile(file, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 })
  }).catch((error) => {
    // Ошибка журнала не должна прерывать SSH-вызов, но остаётся видна в диагностике.
    console.error('MCP activity log:', error)
  })
}

export function beginMcpActivity(input: Omit<McpActivityEvent, 'id' | 'status' | 'startedAt'>): string {
  const event: McpActivityEvent = { ...input, id: randomUUID(), status: 'running', startedAt: Date.now() }
  remember(event)
  persist(event)
  return event.id
}

export function updateMcpOutput(id: string, kind: 'stdout' | 'stderr', chunk: string): void {
  const event = recent.get(id)
  if (!event || event.status !== 'running') return
  event.outputBytes = (event.outputBytes ?? 0) + Buffer.byteLength(chunk)
  const existing = event[kind] ?? ''
  const remaining = Math.max(0, OUTPUT_PREVIEW_BYTES - Buffer.byteLength(existing))
  if (remaining > 0) event[kind] = existing + Buffer.from(chunk).subarray(0, remaining).toString('utf8')
  if (Buffer.byteLength(chunk) > remaining) event.truncated = true
  const now = Date.now()
  if (now - (lastOutputEmit.get(id) ?? 0) > 120) {
    lastOutputEmit.set(id, now)
    emit(event)
  }
}

const lastOutputEmit = new Map<string, number>()

export function updateMcpActivity(id: string, update: Partial<McpActivityEvent>): void {
  const event = recent.get(id)
  if (!event || event.status !== 'running') return
  Object.assign(event, update)
  emit(event)
}

export function finishMcpActivity(id: string, update: Partial<McpActivityEvent>): void {
  const event = recent.get(id)
  if (!event) return
  Object.assign(event, update, { finishedAt: Date.now() })
  if (event.status === 'ok' && event.exitCode !== undefined && event.exitCode !== 0) {
    event.status = 'error'
    event.error = `Команда завершилась с кодом ${event.exitCode}`
  }
  lastOutputEmit.delete(id)
  remember(event)
  persist(event)
}

function matches(event: McpActivityEvent, filter: McpActivityFilter): boolean {
  if (filter.termId && event.termId !== filter.termId) return false
  if (filter.server && event.server !== filter.server) return false
  if (filter.client && event.client !== filter.client) return false
  if (filter.status && event.status !== filter.status) return false
  const query = filter.query?.trim().toLocaleLowerCase()
  if (!query) return true
  return [event.server, event.client, event.tool, event.summary, event.error, ...Object.values(event.params)]
    .some((value) => String(value ?? '').toLocaleLowerCase().includes(query))
}

async function logFiles(): Promise<string[]> {
  const dir = logDir()
  const oldest = dayOf(Date.now() - (KEEP_DAYS - 1) * 86_400_000)
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  return names
    .filter((name) => /^mcp-\d{4}-\d{2}-\d{2}(?:\.1)?\.jsonl$/.test(name) && name.slice(4, 14) >= oldest)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(dir, name))
}

/** Последние совпадения, включая события предыдущих запусков приложения. */
export async function listMcpActivity(filter: McpActivityFilter = {}): Promise<McpActivityEvent[]> {
  await writeQueue
  const found = new Map<string, McpActivityEvent>()
  for (const file of await logFiles()) {
    try {
      const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
      for await (const line of lines) {
        try {
          const event = JSON.parse(line) as McpActivityEvent
          if (event.id) {
            found.delete(event.id)
            if (!matches(event, filter)) continue
            found.set(event.id, event)
            while (found.size > MEMORY_EVENTS) found.delete(found.keys().next().value!)
          }
        } catch { /* Повреждённая строка не скрывает остальной журнал. */ }
      }
    } catch { /* Файл мог быть удалён при ротации. */ }
  }
  for (const event of recent.values()) {
    found.delete(event.id)
    if (!matches(event, filter)) continue
    found.set(event.id, { ...event })
  }
  return [...found.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, MEMORY_EVENTS)
}

/** Экспортирует сохранённый JSONL без команд, содержимого файлов и вывода процессов. */
export async function exportMcpActivity(path: string, filter: McpActivityFilter = {}): Promise<number> {
  await writeQueue
  let count = 0
  const target = await fsp.open(path, 'w', 0o600)
  try {
    let currentDay = ''
    const dayEvents = new Map<string, McpActivityEvent>()
    const flush = async () => {
      for (const event of dayEvents.values()) {
        if (!matches(event, filter)) continue
        await target.writeFile(`${JSON.stringify(stored(event))}\n`, 'utf8')
        count++
      }
      dayEvents.clear()
    }
    for (const file of await logFiles()) {
      const day = /mcp-(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? ''
      if (currentDay && day !== currentDay) await flush()
      currentDay = day
      const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
      for await (const line of lines) {
        let event: McpActivityEvent
        try { event = JSON.parse(line) as McpActivityEvent }
        catch { continue }
        if (event.id) dayEvents.set(event.id, event)
      }
    }
    await flush()
  } finally {
    await target.close()
  }
  return count
}
