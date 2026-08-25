import { ipcMain, BrowserWindow, dialog } from 'electron'
import { homedir } from 'os'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import {
  listSessions,
  saveSession,
  deleteSession,
  touchSession,
  getSessionRow
} from './db'
import {
  decryptSecret,
  getMode,
  isLocked,
  prepareMaster,
  unlock as vaultUnlock,
  lock as vaultLock,
  disableMaster,
  reencryptOne,
  toKeychain
} from './vault'
import {
  getVaultMeta,
  setVaultMeta,
  clearVaultMeta,
  reencryptSecrets
} from './db'
import {
  connect,
  writeTerm,
  resizeTerm,
  closeTerm,
  respondHostKey,
  execOnProfile,
  openExtraShell,
  type ConnectProfile
} from './ssh/connection-manager'
import {
  listRemote,
  sftpMkdir,
  sftpRename,
  sftpRemove,
  sftpChmod,
  sftpReadFile,
  sftpWriteFile,
  upload,
  download,
  cancelTransfer,
  resumeTransfer
} from './ssh/sftp-manager'
import {
  listSnippets,
  saveSnippet,
  deleteSnippet,
  listTunnels,
  saveTunnel,
  deleteTunnel,
  listKnownHosts,
  deleteKnownHost,
  addHistory,
  listHistory,
  clearHistory,
  listScripts,
  saveScript,
  deleteScript,
  type TunnelRow
} from './db'
import {
  startTunnel,
  stopTunnel,
  stopTunnelsForTerm,
  tunnelStates,
  autostartTunnels,
  startEphemeralLocal
} from './ssh/tunnel-manager'
import { spawn } from 'child_process'
import { onTermClosed, startLogging, stopLogging, isLogging } from './ssh/connection-manager'
import { getHostMetrics } from './metrics'
import {
  spawnPty,
  writePty,
  resizePty,
  closePty,
  availableShells
} from './pty-manager'
import type { TunnelConfig, TunnelType } from '@shared/types'
import * as localFs from './local-fs'
import {
  keysList,
  keysGenerate,
  keysImport,
  keysDelete,
  keysExportPrivate,
  keyPrivatePem,
  deployScript
} from './keys'
import { exportSessionsJson, importSessionsJson, importSshConfig } from './sessions-io'
import type {
  ConnectRequest,
  ConnectResult,
  OpResult,
  RevealResult,
  SessionProfile
} from '@shared/types'

const SessionSchema = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  folder: z.string().default(''),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  authType: z.enum(['password', 'key', 'agent']),
  keyPath: z.string().optional(),
  password: z.string().optional(),
  passphrase: z.string().optional(),
  jumpSessionId: z.string().optional(),
  agentForward: z.boolean().optional(),
  tags: z.array(z.string()).optional()
})

const TunnelSchema = z.object({
  id: z.string().optional(),
  sessionId: z.string().min(1),
  type: z.enum(['local', 'remote', 'dynamic']),
  srcHost: z.string().default('127.0.0.1'),
  srcPort: z.number().int().min(1).max(65535),
  dstHost: z.string().default(''),
  dstPort: z.number().int().min(0).max(65535).default(0),
  autostart: z.boolean().default(false)
})

function profileFromSession(sessionId: string, visited: Set<string> = new Set()): ConnectProfile {
  if (visited.has(sessionId)) throw new Error('Циклическая цепочка бастионов')
  visited.add(sessionId)
  const row = getSessionRow(sessionId)
  if (!row) throw new Error('Сессия не найдена')
  const profile: ConnectProfile = {
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type as ConnectProfile['authType'],
    keyPath: row.key_path ?? undefined,
    password: row.password_enc ? decryptSecret(row.password_enc) : undefined,
    passphrase: row.passphrase_enc ? decryptSecret(row.passphrase_enc) : undefined,
    agentForward: !!row.agent_forward
  }
  // Ключ из менеджера ключей вместо файла
  if (profile.keyPath?.startsWith('vault:')) {
    profile.privateKeyPem = keyPrivatePem(profile.keyPath.slice(6))
    profile.keyPath = undefined
  }
  // ProxyJump через сессию-бастион (поддерживается цепочка, с защитой от циклов)
  if (row.jump_session_id && row.jump_session_id !== sessionId) {
    profile.jump = profileFromSession(row.jump_session_id, visited)
  }
  return profile
}

function rowToTunnelConfig(r: TunnelRow): TunnelConfig {
  return {
    id: r.id,
    sessionId: r.session_id,
    type: r.type as TunnelType,
    srcHost: r.src_host,
    srcPort: r.src_port,
    dstHost: r.dst_host,
    dstPort: r.dst_port,
    autostart: !!r.autostart
  }
}

function ok(extra?: Record<string, unknown>): OpResult {
  return { ok: true, ...extra }
}

function err(e: unknown): OpResult {
  return { ok: false, error: (e as Error).message ?? String(e) }
}

async function guard<T extends Record<string, unknown> | void>(
  fn: () => T | Promise<T>
): Promise<OpResult> {
  try {
    const extra = await fn()
    return ok(extra ?? undefined)
  } catch (e) {
    return err(e)
  }
}

export function registerIpc(): void {
  // остановка туннелей при закрытии несущей SSH-сессии
  onTermClosed((termId) => stopTunnelsForTerm(termId))

  // ---- sessions ----
  ipcMain.handle('sessions:list', (): SessionProfile[] => listSessions())
  ipcMain.handle('sessions:save', (_e, raw: unknown): SessionProfile => {
    return saveSession(SessionSchema.parse(raw) as SessionProfile)
  })
  ipcMain.handle('sessions:delete', (_e, id: string): void => {
    deleteSession(String(id))
  })

  // Показ сохранённого пароля/passphrase — секреты уходят в renderer только по
  // явному запросу пользователя и только для конкретной сессии.
  ipcMain.handle('sessions:reveal', (_e, id: string): RevealResult => {
    if (isLocked()) return { ok: false, error: 'Хранилище заблокировано мастер-паролем' }
    const row = getSessionRow(String(id))
    if (!row) return { ok: false, error: 'Сессия не найдена' }
    try {
      return {
        ok: true,
        password: row.password_enc ? decryptSecret(row.password_enc) : undefined,
        passphrase: row.passphrase_enc ? decryptSecret(row.passphrase_enc) : undefined
      }
    } catch (e) {
      return { ok: false, error: `Не удалось расшифровать: ${(e as Error).message}` }
    }
  })

  ipcMain.handle('sessions:export', async (e): Promise<OpResult> => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showSaveDialog(win, {
      title: 'Экспорт сессий',
      defaultPath: join(homedir(), 'litessh-sessions.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    return guard(() => ({ count: exportSessionsJson(res.filePath!) }))
  })

  ipcMain.handle('sessions:import', async (e): Promise<OpResult> => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showOpenDialog(win, {
      title: 'Импорт сессий (JSON)',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    return guard(() => ({ count: importSessionsJson(res.filePaths[0]) }))
  })

  ipcMain.handle('sessions:import-ssh-config', async (e): Promise<OpResult> => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showOpenDialog(win, {
      title: 'Импорт из OpenSSH config',
      defaultPath: join(homedir(), '.ssh', 'config'),
      properties: ['openFile', 'showHiddenFiles']
    })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    return guard(() => ({ count: importSshConfig(res.filePaths[0]) }))
  })

  // ---- ssh / terminal ----
  ipcMain.handle('ssh:connect', async (e, req: ConnectRequest): Promise<ConnectResult> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: 'Окно не найдено' }
    try {
      const profile = req.sessionId
        ? profileFromSession(req.sessionId)
        : (req.profile as ConnectProfile)
      if (!profile?.host || !profile?.username) {
        return { ok: false, error: 'Не заданы хост или имя пользователя' }
      }
      const size = req.size ?? { cols: 80, rows: 24 }
      const { termId, title } = await connect(win, profile, size, req.attemptId)
      if (req.sessionId) {
        touchSession(req.sessionId)
        autostartTunnels(termId, req.sessionId)
      }
      return { ok: true, termId, title }
    } catch (e2) {
      return { ok: false, error: (e2 as Error).message ?? String(e2) }
    }
  })

  ipcMain.handle('ssh:split', async (_e, sourceTermId: string): Promise<ConnectResult> => {
    try {
      const { termId } = await openExtraShell(String(sourceTermId), { cols: 100, rows: 30 })
      return { ok: true, termId }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.on('term:write', (_e, termId: string, data: string) => writeTerm(termId, data))
  ipcMain.on('term:resize', (_e, termId: string, cols: number, rows: number) =>
    resizeTerm(termId, cols, rows)
  )
  ipcMain.on('term:close', (_e, termId: string) => closeTerm(termId))

  ipcMain.handle('term:is-logging', (_e, termId: string): boolean => isLogging(String(termId)))
  ipcMain.handle('term:toggle-log', async (e, termId: string): Promise<OpResult> => {
    const id = String(termId)
    if (isLogging(id)) {
      stopLogging(id)
      return { ok: true, logging: false }
    }
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showSaveDialog(win, {
      title: 'Файл журнала сессии',
      defaultPath: join(homedir(), `litessh-${new Date().toISOString().slice(0, 10)}.log`),
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    return guard(() => {
      startLogging(id, res.filePath!)
      return { logging: true }
    })
  })

  ipcMain.on('hostkey:respond', (_e, requestId: string, accept: boolean) =>
    respondHostKey(String(requestId), !!accept)
  )

  ipcMain.handle('known-hosts:list', () =>
    listKnownHosts().map((r) => ({
      host: r.host,
      port: r.port,
      keyType: r.key_type,
      fingerprint: r.fingerprint,
      addedAt: r.added_at
    }))
  )
  ipcMain.handle('known-hosts:delete', (_e, host: string, port: number, keyType: string): void =>
    deleteKnownHost(String(host), Number(port), String(keyType))
  )

  ipcMain.handle('metrics:get', (_e, termId: string) =>
    guard(async () => ({ ...(await getHostMetrics(String(termId))) }))
  )

  // ---- sftp ----
  ipcMain.handle('sftp:open', (_e, termId: string) => guard(() => listRemote(termId, '.')))
  ipcMain.handle('sftp:list', (_e, termId: string, path: string) =>
    guard(() => listRemote(termId, path))
  )
  ipcMain.handle('sftp:mkdir', (_e, termId: string, path: string) =>
    guard(() => sftpMkdir(termId, path))
  )
  ipcMain.handle('sftp:rename', (_e, termId: string, from: string, to: string) =>
    guard(() => sftpRename(termId, from, to))
  )
  ipcMain.handle('sftp:remove', (_e, termId: string, path: string, isDir: boolean) =>
    guard(() => sftpRemove(termId, path, isDir))
  )
  ipcMain.handle('sftp:chmod', (_e, termId: string, path: string, mode: string) =>
    guard(() => sftpChmod(termId, path, mode))
  )
  ipcMain.handle(
    'sftp:upload',
    (e, termId: string, localPaths: string[], remoteDir: string) => {
      const win = BrowserWindow.fromWebContents(e.sender)!
      return guard(() => upload(win, termId, localPaths, remoteDir))
    }
  )
  ipcMain.handle(
    'sftp:download',
    (e, termId: string, items: { path: string; isDir: boolean }[], localDir: string) => {
      const win = BrowserWindow.fromWebContents(e.sender)!
      return guard(() => download(win, termId, items, localDir))
    }
  )
  ipcMain.on('transfer:cancel', (_e, id: string) => cancelTransfer(String(id)))
  ipcMain.handle('transfer:resume', (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    return guard(() => resumeTransfer(win, String(id)))
  })

  ipcMain.handle('sftp:read', (_e, termId: string, path: string) =>
    guard(() => sftpReadFile(termId, path))
  )
  ipcMain.handle('sftp:write', (_e, termId: string, path: string, base64: string) =>
    guard(() => sftpWriteFile(termId, path, base64))
  )

  // ---- snippets ----
  ipcMain.handle('snippets:list', () => listSnippets())
  ipcMain.handle('snippets:save', (_e, s: { id?: string; name: string; command: string }) =>
    saveSnippet({ id: s.id, name: String(s.name), command: String(s.command) })
  )
  ipcMain.handle('snippets:delete', (_e, id: string): void => deleteSnippet(String(id)))

  // ---- vault (мастер-пароль) ----
  ipcMain.handle('vault:state', () => ({ mode: getMode(), locked: isLocked() }))
  ipcMain.handle('vault:setup', (_e, password: string): OpResult => {
    if (getMode() === 'master') return { ok: false, error: 'Мастер-пароль уже включён' }
    if (!password || password.length < 4) return { ok: false, error: 'Пароль слишком короткий' }
    try {
      const meta = prepareMaster(String(password)) // режим master + ключ в памяти
      reencryptSecrets(reencryptOne) // keychain → master
      setVaultMeta(meta)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('vault:unlock', (_e, password: string): OpResult => {
    const meta = getVaultMeta()
    if (!meta?.verifier) return { ok: false, error: 'Хранилище не настроено' }
    return vaultUnlock(String(password), meta.verifier)
      ? { ok: true }
      : { ok: false, error: 'Неверный мастер-пароль' }
  })
  ipcMain.handle('vault:lock', (): void => vaultLock())
  ipcMain.handle('vault:disable', (_e, password: string): OpResult => {
    if (getMode() !== 'master') return { ok: true }
    const meta = getVaultMeta()
    if (isLocked() && !(meta?.verifier && vaultUnlock(String(password), meta.verifier))) {
      return { ok: false, error: 'Неверный мастер-пароль' }
    }
    try {
      reencryptSecrets(toKeychain) // master → keychain (ключ ещё в памяти)
      disableMaster()
      clearVaultMeta()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ---- история команд ----
  ipcMain.on('history:add', (_e, command: string) => addHistory(String(command)))
  ipcMain.handle('history:list', () => listHistory())
  ipcMain.handle('history:clear', (): void => clearHistory())

  // ---- скрипты (пресеты) ----
  ipcMain.handle('scripts:list', () =>
    listScripts().map((r) => ({ id: r.id, name: r.name, category: r.category, body: r.body }))
  )
  ipcMain.handle('scripts:save', (_e, s: { id?: string; name: string; category: string; body: string }) => {
    const r = saveScript({
      id: s.id,
      name: String(s.name),
      category: String(s.category ?? ''),
      body: String(s.body ?? '')
    })
    return { id: r.id, name: r.name, category: r.category, body: r.body }
  })
  ipcMain.handle('scripts:delete', (_e, id: string): void => deleteScript(String(id)))
  ipcMain.handle('scripts:upload', async (_e, termId: string, body: string) => {
    // Пишем скрипт во временный файл на сервере — запуск одной командой избегает
    // построчной вставки (не ломается на sudo/heredoc, ловится exit-код).
    const path = `/tmp/litessh-${randomUUID().slice(0, 8)}.sh`
    return guard(async () => {
      await sftpWriteFile(String(termId), path, Buffer.from(String(body), 'utf8').toString('base64'))
      return { path }
    })
  })

  // ---- tunnels ----
  ipcMain.handle('tunnels:list', (_e, sessionId: string) =>
    listTunnels(String(sessionId)).map(rowToTunnelConfig)
  )
  ipcMain.handle('tunnels:save', (_e, raw: unknown) => {
    const t = TunnelSchema.parse(raw)
    return rowToTunnelConfig(
      saveTunnel({
        id: t.id ?? '',
        session_id: t.sessionId,
        type: t.type,
        src_host: t.srcHost,
        src_port: t.srcPort,
        dst_host: t.dstHost,
        dst_port: t.dstPort,
        autostart: t.autostart ? 1 : 0
      })
    )
  })
  ipcMain.handle('tunnels:delete', (_e, id: string): void => {
    stopTunnel(String(id))
    deleteTunnel(String(id))
  })
  ipcMain.handle('tunnels:start', (_e, termId: string, tunnelId: string) =>
    startTunnel(String(termId), String(tunnelId))
  )
  ipcMain.on('tunnels:stop', (_e, tunnelId: string) => stopTunnel(String(tunnelId)))
  ipcMain.handle('tunnels:states', () => tunnelStates())

  // ---- Remote Desktop over SSH (RDP в один клик) ----
  ipcMain.handle(
    'rdp:open',
    async (_e, termId: string, dstHost?: string, dstPort?: number): Promise<OpResult & { port?: number; manual?: boolean }> => {
      try {
        const port = await startEphemeralLocal(
          String(termId),
          dstHost || '127.0.0.1',
          Number(dstPort) || 3389
        )
        if (process.platform === 'win32') {
          // Родной клиент Windows, наведённый на локальный конец туннеля
          spawn('mstsc.exe', [`/v:127.0.0.1:${port}`], { detached: true, stdio: 'ignore' }).unref()
          return { ok: true, port }
        }
        // macOS/Linux: универсального CLI-клиента нет — отдаём порт, пользователь подключится сам
        return { ok: true, port, manual: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  // ---- локальные терминалы (node-pty) ----
  ipcMain.handle('pty:shells', () => availableShells())
  ipcMain.handle(
    'pty:spawn',
    (e, shell: string, size: { cols: number; rows: number }): ConnectResult => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return { ok: false, error: 'Окно не найдено' }
      try {
        const { ptyId } = spawnPty(win, String(shell), size)
        return { ok: true, termId: ptyId, title: 'local' }
      } catch (e2) {
        return { ok: false, error: (e2 as Error).message }
      }
    }
  )
  ipcMain.on('pty:write', (_e, ptyId: string, data: string) => writePty(ptyId, data))
  ipcMain.on('pty:resize', (_e, ptyId: string, cols: number, rows: number) =>
    resizePty(ptyId, cols, rows)
  )
  ipcMain.on('pty:close', (_e, ptyId: string) => closePty(ptyId))

  // ---- local fs ----
  ipcMain.handle('fs:home', () => localFs.home())
  ipcMain.handle('fs:list', (_e, path: string) => guard(() => localFs.listLocal(path)))
  ipcMain.handle('fs:mkdir', (_e, path: string) => guard(() => localFs.mkdirLocal(path)))
  ipcMain.handle('fs:rename', (_e, from: string, to: string) =>
    guard(() => localFs.renameLocal(from, to))
  )
  ipcMain.handle('fs:remove', (_e, path: string) => guard(() => localFs.removeLocal(path)))
  ipcMain.on('fs:reveal', (_e, path: string) => localFs.reveal(path))

  // ---- keys ----
  ipcMain.handle('keys:list', () => keysList())
  ipcMain.handle('keys:generate', (_e, opts: { name: string; algo: string }) =>
    guard(() => ({ key: keysGenerate(String(opts.name), String(opts.algo)) }))
  )
  ipcMain.handle('keys:import-file', (_e, path: string, passphrase?: string) =>
    guard(() => ({ key: keysImport(String(path), basename(String(path)), passphrase) }))
  )
  ipcMain.handle('keys:delete', (_e, id: string): void => keysDelete(String(id)))
  ipcMain.handle('keys:export-private', async (e, id: string): Promise<OpResult> => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showSaveDialog(win, {
      title: 'Сохранить приватный ключ',
      defaultPath: join(homedir(), '.ssh', 'id_litessh')
    })
    if (res.canceled || !res.filePath) return { ok: false }
    return guard(() => keysExportPrivate(String(id), res.filePath!))
  })
  ipcMain.handle('keys:deploy', async (e, keyId: string, sessionId: string): Promise<OpResult> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: 'Окно не найдено' }
    try {
      const key = keysList().find((k) => k.id === keyId)
      if (!key) return { ok: false, error: 'Ключ не найден' }
      const profile = profileFromSession(sessionId)
      const { code, stdout, stderr } = await execOnProfile(win, profile, deployScript(key.publicKey))
      if (code === 0 && stdout.includes('LITESSH_DEPLOY_OK')) return { ok: true }
      return { ok: false, error: stderr || `Команда завершилась с кодом ${code}` }
    } catch (e2) {
      return err(e2)
    }
  })

  // ---- misc ----
  ipcMain.handle('dialog:pick-key', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите приватный SSH-ключ',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })
}
