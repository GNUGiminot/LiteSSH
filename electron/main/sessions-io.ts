import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import { listSessions, saveSession } from './db'
import type { SessionProfile } from '@shared/types'

function sameTarget(a: Pick<SessionProfile, 'host' | 'port' | 'username'>, b: Pick<SessionProfile, 'host' | 'port' | 'username'>): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.username === b.username
}

function validPort(value: unknown): number {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22
}

export function exportSessionsJson(destPath: string): number {
  const all = listSessions()
  const nameById = new Map(all.map((s) => [s.id, s.name]))
  const sessions = all.map((s) => ({
    name: s.name,
    folder: s.folder,
    host: s.host,
    port: s.port,
    username: s.username,
    authType: s.authType,
    keyPath: s.keyPath,
    agentForward: s.agentForward || undefined,
    tags: s.tags?.length ? s.tags : undefined,
    // id при импорте поменяются — бастион сохраняем по имени сессии
    jump: s.jumpSessionId ? nameById.get(s.jumpSessionId) : undefined
    // секреты намеренно не экспортируются
  }))
  writeFileSync(destPath, JSON.stringify({ litessh: 2, sessions }, null, 2), 'utf8')
  return sessions.length
}

type ImportedSession = Partial<SessionProfile> & { jump?: string }

export function importSessionsJson(srcPath: string): number {
  const data = JSON.parse(readFileSync(srcPath, 'utf8'))
  const items: ImportedSession[] = Array.isArray(data) ? data : (data.sessions ?? [])
  const existing = listSessions()
  const byName = new Map(existing.map((s) => [s.name, s.id]))
  const pendingJumps: { id: string; jump: string }[] = []
  let count = 0
  for (const item of items) {
    if (typeof item.host !== 'string' || typeof item.username !== 'string' || !item.host || !item.username) continue
    const port = validPort(item.port)
    const name = typeof item.name === 'string' && item.name ? item.name : `${item.username}@${item.host}`
    // Повторный импорт того же файла не должен плодить дубли
    if (existing.some((s) => s.name === name && sameTarget(s, { host: item.host!, port, username: item.username! }))) continue
    const saved = saveSession({
      id: '',
      name,
      folder: typeof item.folder === 'string' ? item.folder : '',
      host: item.host,
      port,
      username: item.username,
      authType: item.authType === 'key' || item.authType === 'agent' ? item.authType : 'password',
      keyPath: typeof item.keyPath === 'string' ? item.keyPath : undefined,
      agentForward: item.agentForward === true,
      tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : undefined
    })
    byName.set(saved.name, saved.id)
    if (typeof item.jump === 'string' && item.jump) pendingJumps.push({ id: saved.id, jump: item.jump })
    count++
  }
  // Второй проход: бастионы могут идти в файле позже ссылающихся на них сессий
  for (const { id, jump } of pendingJumps) {
    const jumpId = byName.get(jump)
    const session = listSessions().find((s) => s.id === id)
    if (jumpId && session && jumpId !== id) saveSession({ ...session, jumpSessionId: jumpId })
  }
  return count
}

interface Block {
  alias: string
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
}

function unquote(value: string): string {
  const v = value.trim()
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
}

function expandHome(value: string): string {
  return value.replace(/^~(?=[/\\]|$)/, homedir())
}

/** Файлы для Include: относительные пути — от ~/.ssh, поддерживаются маски * и ? в имени. */
function includeFiles(pattern: string, baseDir: string): string[] {
  const full = expandHome(unquote(pattern))
  const path = isAbsolute(full) ? full : join(baseDir, full)
  const dir = dirname(path)
  const mask = basename(path)
  if (!/[*?]/.test(mask)) return existsSync(path) ? [path] : []
  if (!existsSync(dir)) return []
  const re = new RegExp(`^${mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return readdirSync(dir)
    .filter((name) => re.test(name))
    .sort()
    .map((name) => join(dir, name))
    .filter((file) => statSync(file).isFile())
}

function parseSshConfig(path: string, blocks: Block[], seen: Set<string>, depth = 0): void {
  if (depth > 5 || seen.has(path)) return
  seen.add(path)
  const baseDir = join(homedir(), '.ssh')
  let current: Block | null = null
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // Поддерживаются обе формы: «Keyword value» и «Keyword=value»
    const m = line.match(/^(\S+?)\s*(?:=|\s)\s*(.+)$/)
    if (!m) continue
    const keyword = m[1].toLowerCase()
    const value = m[2].trim()
    if (keyword === 'host') {
      // Берём первый конкретный алиас; паттерны с масками (*, ?) и отрицания пропускаем
      const alias = value.split(/\s+/).map(unquote).find((a) => a && !/[*?!]/.test(a))
      current = alias ? { alias } : null
      if (current) blocks.push(current)
    } else if (keyword === 'match') {
      // Условные блоки не относятся к предыдущему Host — их параметры не должны к нему прилипать
      current = null
    } else if (keyword === 'include') {
      for (const pattern of value.split(/\s+/)) {
        for (const file of includeFiles(pattern, baseDir)) parseSshConfig(file, blocks, seen, depth + 1)
      }
    } else if (current) {
      if (keyword === 'hostname') current.hostName ??= unquote(value)
      else if (keyword === 'user') current.user ??= unquote(value)
      else if (keyword === 'port') current.port ??= validPort(value)
      else if (keyword === 'identityfile') current.identityFile ??= expandHome(unquote(value))
      else if (keyword === 'proxyjump') current.proxyJump ??= unquote(value)
    }
  }
}

/** Разбор ~/.ssh/config: Host / HostName / User / Port / IdentityFile / ProxyJump / Include. */
export function importSshConfig(srcPath: string): number {
  const blocks: Block[] = []
  parseSshConfig(srcPath, blocks, new Set())
  const existing = listSessions()
  const idByAlias = new Map<string, string>()
  let count = 0
  for (const b of blocks) {
    const target = { host: b.hostName ?? b.alias, port: b.port ?? 22, username: b.user ?? 'root' }
    const duplicate = existing.find((s) => sameTarget(s, target) && (s.name === b.alias || s.folder === 'ssh-config'))
    if (duplicate) {
      idByAlias.set(b.alias, duplicate.id)
      continue
    }
    const saved = saveSession({
      id: '',
      name: b.alias,
      folder: 'ssh-config',
      ...target,
      authType: b.identityFile ? 'key' : 'agent',
      keyPath: b.identityFile
    })
    idByAlias.set(b.alias, saved.id)
    count++
  }
  // ProxyJump: первый хоп цепочки, если это алиас из того же файла или уже сохранённая сессия
  for (const b of blocks) {
    if (!b.proxyJump || b.proxyJump.toLowerCase() === 'none') continue
    const hop = b.proxyJump.split(',')[0].trim()
    const hopAlias = hop.replace(/^[^@]+@/, '').replace(/:\d+$/, '')
    const jumpId =
      idByAlias.get(hop) ??
      idByAlias.get(hopAlias) ??
      listSessions().find((s) => s.name === hopAlias || s.host === hopAlias)?.id
    const selfId = idByAlias.get(b.alias)
    const self = selfId ? listSessions().find((s) => s.id === selfId) : undefined
    if (jumpId && self && jumpId !== self.id && !self.jumpSessionId) saveSession({ ...self, jumpSessionId: jumpId })
  }
  return count
}
