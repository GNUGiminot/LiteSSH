import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { listSessions, saveSession } from './db'
import type { SessionProfile } from '@shared/types'

export function exportSessionsJson(destPath: string): number {
  const sessions = listSessions().map((s) => ({
    name: s.name,
    folder: s.folder,
    host: s.host,
    port: s.port,
    username: s.username,
    authType: s.authType,
    keyPath: s.keyPath
    // секреты намеренно не экспортируются
  }))
  writeFileSync(destPath, JSON.stringify({ litessh: 1, sessions }, null, 2), 'utf8')
  return sessions.length
}

export function importSessionsJson(srcPath: string): number {
  const data = JSON.parse(readFileSync(srcPath, 'utf8'))
  const items: Partial<SessionProfile>[] = Array.isArray(data) ? data : (data.sessions ?? [])
  let count = 0
  for (const item of items) {
    if (!item.host || !item.username) continue
    saveSession({
      id: '',
      name: item.name || `${item.username}@${item.host}`,
      folder: item.folder ?? '',
      host: item.host,
      port: item.port || 22,
      username: item.username,
      authType: item.authType === 'key' || item.authType === 'agent' ? item.authType : 'password',
      keyPath: item.keyPath
    })
    count++
  }
  return count
}

/** Разбор ~/.ssh/config: Host / HostName / User / Port / IdentityFile. */
export function importSshConfig(srcPath: string): number {
  const text = readFileSync(srcPath, 'utf8')
  interface Block {
    alias: string
    hostName?: string
    user?: string
    port?: number
    identityFile?: string
  }
  const blocks: Block[] = []
  let current: Block | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(.+)$/)
    if (!m) continue
    const keyword = m[1].toLowerCase()
    const value = m[2].trim()
    if (keyword === 'host') {
      // паттерны с масками (*, ?) пропускаем — это не конкретные хосты
      const alias = value.split(/\s+/)[0]
      current = /[*?]/.test(alias) ? null : { alias }
      if (current) blocks.push(current)
    } else if (current) {
      if (keyword === 'hostname') current.hostName = value
      else if (keyword === 'user') current.user = value
      else if (keyword === 'port') current.port = parseInt(value, 10) || 22
      else if (keyword === 'identityfile')
        current.identityFile = value.replace(/^~(?=[/\\])/, homedir())
    }
  }
  let count = 0
  for (const b of blocks) {
    const host = b.hostName ?? b.alias
    saveSession({
      id: '',
      name: b.alias,
      folder: 'ssh-config',
      host,
      port: b.port ?? 22,
      username: b.user ?? 'root',
      authType: b.identityFile ? 'key' : 'agent',
      keyPath: b.identityFile
    })
    count++
  }
  return count
}
