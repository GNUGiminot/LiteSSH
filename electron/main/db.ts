import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'fs'
import type { SessionProfile } from '@shared/types'
import { encryptSecret } from './vault'

let db: Database.Database | null = null

/**
 * Разовый бэкап БД при смене версии приложения (защита данных при переустановке/обновлении).
 * Хранит несколько последних копий в userData/backups; лишние удаляет.
 */
function backupOnVersionChange(database: Database.Database, dbPath: string): void {
  try {
    database.exec('CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    const cur = app.getVersion()
    const row = database.prepare("SELECT v FROM app_meta WHERE k = 'version'").get() as
      | { v: string }
      | undefined
    const prev = row?.v
    if (prev && prev !== cur) {
      // сливаем WAL в основной файл, затем копируем — копия консистентна
      database.pragma('wal_checkpoint(TRUNCATE)')
      const dir = join(app.getPath('userData'), 'backups')
      mkdirSync(dir, { recursive: true })
      copyFileSync(dbPath, join(dir, `litessh-${prev}-${Date.now()}.db`))
      // оставляем максимум 5 последних бэкапов
      const files = readdirSync(dir)
        .filter((f) => f.startsWith('litessh-') && f.endsWith('.db'))
        .sort()
      for (const f of files.slice(0, Math.max(0, files.length - 5))) {
        try {
          rmSync(join(dir, f))
        } catch {
          /* ignore */
        }
      }
    }
    database
      .prepare("INSERT INTO app_meta (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(cur)
  } catch {
    /* бэкап — лучшее усилие, не мешаем запуску */
  }
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = join(app.getPath('userData'), 'litessh.db')
    const existed = existsSync(dbPath)
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    // Долговечность: полный fsync на коммит и немедленное слияние старого WAL
    // в основной файл при старте — чтобы данные не жили только в -wal (риск потери
    // при переустановке/kill процесса).
    db.pragma('synchronous = FULL')
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* при первом создании WAL ещё нет — не критично */
    }
    if (existed) backupOnVersionChange(db, dbPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT '',
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'password',
        key_path TEXT,
        password_enc TEXT,
        passphrase_enc TEXT,
        jump_session_id TEXT,
        agent_forward INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_used INTEGER
      );
      CREATE TABLE IF NOT EXISTS known_hosts (
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        key_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (host, port, key_type)
      );
      CREATE TABLE IF NOT EXISTS tunnels (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        src_host TEXT NOT NULL DEFAULT '127.0.0.1',
        src_port INTEGER NOT NULL,
        dst_host TEXT NOT NULL DEFAULT '',
        dst_port INTEGER NOT NULL DEFAULT 0,
        autostart INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snippets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scripts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        algo TEXT NOT NULL,
        public_key TEXT NOT NULL,
        private_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `)
    // миграции для БД, созданных в более ранних версиях
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'jump_session_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN jump_session_id TEXT')
    }
    if (!cols.some((c) => c.name === 'agent_forward')) {
      db.exec('ALTER TABLE sessions ADD COLUMN agent_forward INTEGER NOT NULL DEFAULT 0')
    }
    if (!cols.some((c) => c.name === 'tags')) {
      db.exec("ALTER TABLE sessions ADD COLUMN tags TEXT NOT NULL DEFAULT ''")
    }
  }
  return db
}

/** Корректно закрывает БД при выходе: сливает WAL в основной файл (защита данных). */
export function closeDb(): void {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
  } catch {
    /* ignore */
  }
  db = null
}

interface SessionRow {
  id: string
  name: string
  folder: string
  host: string
  port: number
  username: string
  auth_type: string
  key_path: string | null
  password_enc: string | null
  passphrase_enc: string | null
  jump_session_id: string | null
  agent_forward: number
  tags: string
  created_at: number
  last_used: number | null
}

function rowToProfile(r: SessionRow): SessionProfile {
  return {
    id: r.id,
    name: r.name,
    folder: r.folder,
    host: r.host,
    port: r.port,
    username: r.username,
    authType: r.auth_type as SessionProfile['authType'],
    keyPath: r.key_path ?? undefined,
    hasPassword: !!r.password_enc,
    hasPassphrase: !!r.passphrase_enc,
    jumpSessionId: r.jump_session_id ?? undefined,
    agentForward: !!r.agent_forward,
    tags: r.tags ? r.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    createdAt: r.created_at,
    lastUsed: r.last_used ?? undefined
  }
}

export function listSessions(): SessionProfile[] {
  const rows = getDb()
    .prepare('SELECT * FROM sessions ORDER BY folder, name COLLATE NOCASE')
    .all() as SessionRow[]
  return rows.map(rowToProfile)
}

export function getSessionRow(id: string): SessionRow | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
}

export function saveSession(p: SessionProfile): SessionProfile {
  const d = getDb()
  const existing = p.id ? getSessionRow(p.id) : undefined
  const id = existing ? p.id : p.id || randomUUID()
  // password === undefined keeps the stored secret; a string (incl. '') replaces it
  const passwordEnc =
    p.password === undefined
      ? (existing?.password_enc ?? null)
      : p.password
        ? encryptSecret(p.password)
        : null
  const passphraseEnc =
    p.passphrase === undefined
      ? (existing?.passphrase_enc ?? null)
      : p.passphrase
        ? encryptSecret(p.passphrase)
        : null
  d.prepare(
    `INSERT INTO sessions (id, name, folder, host, port, username, auth_type, key_path, password_enc, passphrase_enc, jump_session_id, agent_forward, tags, created_at, last_used)
     VALUES (@id, @name, @folder, @host, @port, @username, @auth_type, @key_path, @password_enc, @passphrase_enc, @jump_session_id, @agent_forward, @tags, @created_at, @last_used)
     ON CONFLICT(id) DO UPDATE SET
       name=@name, folder=@folder, host=@host, port=@port, username=@username,
       auth_type=@auth_type, key_path=@key_path, password_enc=@password_enc, passphrase_enc=@passphrase_enc,
       jump_session_id=@jump_session_id, agent_forward=@agent_forward, tags=@tags`
  ).run({
    id,
    name: p.name || `${p.username}@${p.host}`,
    folder: p.folder ?? '',
    host: p.host,
    port: p.port || 22,
    username: p.username,
    auth_type: p.authType,
    key_path: p.keyPath ?? null,
    password_enc: passwordEnc,
    passphrase_enc: passphraseEnc,
    jump_session_id: p.jumpSessionId ?? null,
    agent_forward: p.agentForward ? 1 : 0,
    tags: (p.tags ?? []).map((t) => t.trim()).filter(Boolean).join(','),
    created_at: existing?.created_at ?? Date.now(),
    last_used: existing?.last_used ?? null
  })
  return rowToProfile(getSessionRow(id)!)
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function touchSession(id: string): void {
  getDb().prepare('UPDATE sessions SET last_used = ? WHERE id = ?').run(Date.now(), id)
}

export interface KeyRow {
  id: string
  name: string
  algo: string
  public_key: string
  private_enc: string
  created_at: number
}

export function listKeys(): KeyRow[] {
  return getDb().prepare('SELECT * FROM keys ORDER BY name COLLATE NOCASE').all() as KeyRow[]
}

export function getKeyRow(id: string): KeyRow | undefined {
  return getDb().prepare('SELECT * FROM keys WHERE id = ?').get(id) as KeyRow | undefined
}

export function insertKey(row: KeyRow): void {
  getDb()
    .prepare(
      'INSERT INTO keys (id, name, algo, public_key, private_enc, created_at) VALUES (@id, @name, @algo, @public_key, @private_enc, @created_at)'
    )
    .run(row)
}

export function deleteKey(id: string): void {
  getDb().prepare('DELETE FROM keys WHERE id = ?').run(id)
}

export interface SnippetRow {
  id: string
  name: string
  command: string
  created_at: number
}

export function listSnippets(): SnippetRow[] {
  return getDb().prepare('SELECT * FROM snippets ORDER BY name COLLATE NOCASE').all() as SnippetRow[]
}

export function saveSnippet(s: { id?: string; name: string; command: string }): SnippetRow {
  const id = s.id || randomUUID()
  getDb()
    .prepare(
      `INSERT INTO snippets (id, name, command, created_at) VALUES (@id, @name, @command, @created_at)
       ON CONFLICT(id) DO UPDATE SET name=@name, command=@command`
    )
    .run({ id, name: s.name, command: s.command, created_at: Date.now() })
  return getDb().prepare('SELECT * FROM snippets WHERE id = ?').get(id) as SnippetRow
}

export function deleteSnippet(id: string): void {
  getDb().prepare('DELETE FROM snippets WHERE id = ?').run(id)
}

// ---- vault meta ----

export function getVaultMeta(): { mode: string; salt?: string; verifier?: string } | null {
  const rows = getDb().prepare('SELECT k, v FROM vault_meta').all() as { k: string; v: string }[]
  if (!rows.length) return null
  const m = Object.fromEntries(rows.map((r) => [r.k, r.v]))
  if (!m.mode) return null
  return { mode: m.mode, salt: m.salt, verifier: m.verifier }
}

export function setVaultMeta(meta: { mode: string; salt?: string; verifier?: string }): void {
  const db = getDb()
  const up = db.prepare('INSERT INTO vault_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
  const tx = db.transaction(() => {
    up.run('mode', meta.mode)
    up.run('salt', meta.salt ?? '')
    up.run('verifier', meta.verifier ?? '')
  })
  tx()
}

export function clearVaultMeta(): void {
  getDb().prepare('DELETE FROM vault_meta').run()
}

/** Перешифровать все хранимые секреты функцией transform (для смены режима хранилища). */
export function reencryptSecrets(transform: (stored: string | null) => string | null): void {
  const db = getDb()
  const tx = db.transaction(() => {
    const sessions = db.prepare('SELECT id, password_enc, passphrase_enc FROM sessions').all() as {
      id: string
      password_enc: string | null
      passphrase_enc: string | null
    }[]
    const updS = db.prepare('UPDATE sessions SET password_enc = ?, passphrase_enc = ? WHERE id = ?')
    for (const s of sessions) {
      updS.run(transform(s.password_enc), transform(s.passphrase_enc), s.id)
    }
    const keys = db.prepare('SELECT id, private_enc FROM keys').all() as {
      id: string
      private_enc: string
    }[]
    const updK = db.prepare('UPDATE keys SET private_enc = ? WHERE id = ?')
    for (const k of keys) {
      updK.run(transform(k.private_enc), k.id)
    }
  })
  tx()
}

// ---- scripts (пресеты) ----

export interface ScriptRow {
  id: string
  name: string
  category: string
  body: string
  created_at: number
}

export function listScripts(): ScriptRow[] {
  return getDb()
    .prepare('SELECT * FROM scripts ORDER BY category, name COLLATE NOCASE')
    .all() as ScriptRow[]
}

export function saveScript(s: { id?: string; name: string; category: string; body: string }): ScriptRow {
  const id = s.id || randomUUID()
  getDb()
    .prepare(
      `INSERT INTO scripts (id, name, category, body, created_at) VALUES (@id, @name, @category, @body, @created_at)
       ON CONFLICT(id) DO UPDATE SET name=@name, category=@category, body=@body`
    )
    .run({ id, name: s.name, category: s.category, body: s.body, created_at: Date.now() })
  return getDb().prepare('SELECT * FROM scripts WHERE id = ?').get(id) as ScriptRow
}

export function deleteScript(id: string): void {
  getDb().prepare('DELETE FROM scripts WHERE id = ?').run(id)
}

export function addHistory(command: string): void {
  const cmd = command.trim()
  if (!cmd || cmd.length > 2000) return
  const db = getDb()
  const last = db.prepare('SELECT command FROM history ORDER BY id DESC LIMIT 1').get() as
    | { command: string }
    | undefined
  if (last?.command === cmd) return // не дублируем подряд идущие
  db.prepare('INSERT INTO history (command, ts) VALUES (?, ?)').run(cmd, Date.now())
  // держим не больше 1000 последних команд
  db.prepare(
    'DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 1000)'
  ).run()
}

export function listHistory(limit = 300): { command: string; ts: number }[] {
  return getDb()
    .prepare('SELECT command, ts FROM history ORDER BY id DESC LIMIT ?')
    .all(limit) as { command: string; ts: number }[]
}

export function clearHistory(): void {
  getDb().prepare('DELETE FROM history').run()
}

export interface TunnelRow {
  id: string
  session_id: string
  type: string
  src_host: string
  src_port: number
  dst_host: string
  dst_port: number
  autostart: number
  created_at: number
}

export function listTunnels(sessionId?: string): TunnelRow[] {
  const db = getDb()
  return (
    sessionId
      ? db.prepare('SELECT * FROM tunnels WHERE session_id = ? ORDER BY created_at').all(sessionId)
      : db.prepare('SELECT * FROM tunnels ORDER BY created_at').all()
  ) as TunnelRow[]
}

export function getTunnelRow(id: string): TunnelRow | undefined {
  return getDb().prepare('SELECT * FROM tunnels WHERE id = ?').get(id) as TunnelRow | undefined
}

export function saveTunnel(t: Omit<TunnelRow, 'created_at'> & { created_at?: number }): TunnelRow {
  const id = t.id || randomUUID()
  getDb()
    .prepare(
      `INSERT INTO tunnels (id, session_id, type, src_host, src_port, dst_host, dst_port, autostart, created_at)
       VALUES (@id, @session_id, @type, @src_host, @src_port, @dst_host, @dst_port, @autostart, @created_at)
       ON CONFLICT(id) DO UPDATE SET type=@type, src_host=@src_host, src_port=@src_port,
         dst_host=@dst_host, dst_port=@dst_port, autostart=@autostart`
    )
    .run({ ...t, id, created_at: t.created_at ?? Date.now() })
  return getTunnelRow(id)!
}

export function deleteTunnel(id: string): void {
  getDb().prepare('DELETE FROM tunnels WHERE id = ?').run(id)
}

export function getKnownHostKey(host: string, port: number, keyType: string): string | undefined {
  const row = getDb()
    .prepare('SELECT fingerprint FROM known_hosts WHERE host = ? AND port = ? AND key_type = ?')
    .get(host, port, keyType) as { fingerprint: string } | undefined
  return row?.fingerprint
}

export function saveKnownHostKey(host: string, port: number, keyType: string, fingerprint: string): void {
  getDb()
    .prepare(
      `INSERT INTO known_hosts (host, port, key_type, fingerprint, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(host, port, key_type) DO UPDATE SET fingerprint = excluded.fingerprint, added_at = excluded.added_at`
    )
    .run(host, port, keyType, fingerprint, Date.now())
}

export interface KnownHostRow {
  host: string
  port: number
  key_type: string
  fingerprint: string
  added_at: number
}

export function listKnownHosts(): KnownHostRow[] {
  return getDb()
    .prepare('SELECT * FROM known_hosts ORDER BY host, port')
    .all() as KnownHostRow[]
}

export function deleteKnownHost(host: string, port: number, keyType: string): void {
  getDb()
    .prepare('DELETE FROM known_hosts WHERE host = ? AND port = ? AND key_type = ?')
    .run(host, port, keyType)
}
