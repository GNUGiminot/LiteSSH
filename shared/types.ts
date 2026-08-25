export type AuthType = 'password' | 'key' | 'agent'

export interface SessionProfile {
  id: string
  name: string
  folder: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** Путь к файлу ключа ИЛИ ссылка на ключ из менеджера: "vault:<keyId>" */
  keyPath?: string
  /** Plaintext password/passphrase — present only in transit renderer -> main on save. */
  password?: string
  passphrase?: string
  /** True if an encrypted password is stored for this session (never the password itself). */
  hasPassword?: boolean
  /** True if an encrypted key passphrase is stored for this session. */
  hasPassphrase?: boolean
  /** id другой сессии-бастиона (ProxyJump) */
  jumpSessionId?: string
  /** Проброс SSH-агента (ForwardAgent) */
  agentForward?: boolean
  /** Метки для группировки/поиска */
  tags?: string[]
  createdAt?: number
  lastUsed?: number
}

export interface HostMetrics {
  ok: boolean
  cpu: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  load: [number, number, number]
  uptime: number
  cores: number
  hostname: string
}

export interface KnownHost {
  host: string
  port: number
  keyType: string
  fingerprint: string
  addedAt: number
}

export type TunnelType = 'local' | 'remote' | 'dynamic'

export interface TunnelConfig {
  id: string
  sessionId: string
  type: TunnelType
  srcHost: string
  srcPort: number
  dstHost: string
  dstPort: number
  autostart: boolean
}

export interface TunnelState {
  id: string
  sessionId: string
  type: TunnelType
  srcHost: string
  srcPort: number
  dstHost: string
  dstPort: number
  running: boolean
  error?: string
  conns: number
  bytesIn: number
  bytesOut: number
}

export interface QuickConnectProfile {
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  keyPath?: string
  passphrase?: string
}

export interface ConnectRequest {
  sessionId?: string
  profile?: QuickConnectProfile
  size?: { cols: number; rows: number }
  /** id попытки — для анимации стадий подключения */
  attemptId?: string
}

export type ConnectStage = 'connect' | 'hostkey' | 'auth' | 'shell'
export type StageStatus = 'active' | 'done' | 'error'

export interface ConnectProgress {
  attemptId: string
  stage: ConnectStage
  status: StageStatus
  error?: string
}

export interface ConnectResult {
  ok: boolean
  termId?: string
  title?: string
  error?: string
}

export interface HostKeyPrompt {
  requestId: string
  host: string
  port: number
  keyType: string
  fingerprint: string
  /** True when the server presented a DIFFERENT key than the one stored (possible MITM). */
  changed: boolean
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  isLink?: boolean
  size: number
  mtime: number
  /** rwxr-xr-x — только для удалённых файлов */
  perms?: string
  mode?: number
}

export interface ListResult {
  ok: boolean
  path?: string
  entries?: FileEntry[]
  error?: string
}

export type TransferStatus = 'active' | 'done' | 'error' | 'cancelled'

export interface TransferInfo {
  id: string
  name: string
  direction: 'upload' | 'download'
  total: number
  done: number
  status: TransferStatus
  error?: string
  /** Прерванную передачу можно возобновить (докачать) */
  canResume?: boolean
}

export interface KeyInfo {
  id: string
  name: string
  algo: string
  publicKey: string
  createdAt: number
}

export interface Snippet {
  id: string
  name: string
  command: string
}

export interface ScriptPreset {
  id: string
  name: string
  category: string
  body: string
}

/** Результат показа сохранённых секретов сессии. */
export interface RevealResult {
  ok: boolean
  error?: string
  password?: string
  passphrase?: string
}

export interface OpResult {
  ok: boolean
  error?: string
  [k: string]: unknown
}

export interface LiteSSHApi {
  platform: string
  sessions: {
    list(): Promise<SessionProfile[]>
    save(profile: SessionProfile): Promise<SessionProfile>
    remove(id: string): Promise<void>
    /** Расшифровать сохранённые секреты сессии для показа пользователю. */
    reveal(id: string): Promise<RevealResult>
    exportJson(): Promise<OpResult>
    importJson(): Promise<OpResult>
    importSshConfig(): Promise<OpResult>
  }
  ssh: {
    connect(req: ConnectRequest): Promise<ConnectResult>
    /** Открыть ещё один shell на существующем соединении (split view) */
    split(sourceTermId: string): Promise<ConnectResult>
    write(termId: string, data: string): void
    resize(termId: string, cols: number, rows: number): void
    close(termId: string): void
    isLogging(termId: string): Promise<boolean>
    toggleLog(termId: string): Promise<OpResult & { logging?: boolean }>
  }
  term: {
    onData(cb: (termId: string, data: Uint8Array) => void): () => void
    onExit(cb: (termId: string, message?: string) => void): () => void
    onProgress(cb: (p: ConnectProgress) => void): () => void
  }
  hostkey: {
    onPrompt(cb: (prompt: HostKeyPrompt) => void): () => void
    respond(requestId: string, accept: boolean): void
  }
  sftp: {
    open(termId: string): Promise<ListResult>
    list(termId: string, path: string): Promise<ListResult>
    mkdir(termId: string, path: string): Promise<OpResult>
    rename(termId: string, from: string, to: string): Promise<OpResult>
    remove(termId: string, path: string, isDir: boolean): Promise<OpResult>
    chmod(termId: string, path: string, mode: string): Promise<OpResult>
    upload(termId: string, localPaths: string[], remoteDir: string): Promise<OpResult>
    download(
      termId: string,
      items: { path: string; isDir: boolean }[],
      localDir: string
    ): Promise<OpResult>
    read(
      termId: string,
      path: string
    ): Promise<OpResult & { base64?: string; size?: number; truncated?: boolean }>
    write(termId: string, path: string, base64: string): Promise<OpResult>
  }
  snippets: {
    list(): Promise<Snippet[]>
    save(s: { id?: string; name: string; command: string }): Promise<Snippet>
    remove(id: string): Promise<void>
  }
  history: {
    add(command: string): void
    list(): Promise<{ command: string; ts: number }[]>
    clear(): Promise<void>
  }
  scripts: {
    list(): Promise<ScriptPreset[]>
    save(s: { id?: string; name: string; category: string; body: string }): Promise<ScriptPreset>
    remove(id: string): Promise<void>
    /** Загрузить тело скрипта во временный файл на сервере; возвращает путь для запуска. */
    upload(termId: string, body: string): Promise<OpResult & { path?: string }>
  }
  tunnels: {
    list(sessionId: string): Promise<TunnelConfig[]>
    save(t: Omit<TunnelConfig, 'id'> & { id?: string }): Promise<TunnelConfig>
    remove(id: string): Promise<void>
    start(termId: string, tunnelId: string): Promise<OpResult>
    stop(tunnelId: string): void
    states(): Promise<TunnelState[]>
    onState(cb: (states: TunnelState[]) => void): () => void
  }
  rdp: {
    /** Поднять эфемерный туннель на :dstPort сервера и запустить системный RDP-клиент (Windows). */
    open(termId: string, dstHost?: string, dstPort?: number): Promise<OpResult & { port?: number; manual?: boolean }>
  }
  pty: {
    spawn(shell: string, size: { cols: number; rows: number }): Promise<ConnectResult>
    write(ptyId: string, data: string): void
    resize(ptyId: string, cols: number, rows: number): void
    close(ptyId: string): void
    shells(): Promise<{ label: string; cmd: string }[]>
    onData(cb: (ptyId: string, data: string) => void): () => void
    onExit(cb: (ptyId: string) => void): () => void
  }
  fs: {
    home(): Promise<string>
    list(path: string): Promise<ListResult>
    mkdir(path: string): Promise<OpResult>
    rename(from: string, to: string): Promise<OpResult>
    remove(path: string): Promise<OpResult>
    reveal(path: string): void
  }
  transfer: {
    cancel(id: string): void
    resume(id: string): Promise<OpResult>
    onUpdate(cb: (info: TransferInfo) => void): () => void
  }
  keys: {
    list(): Promise<KeyInfo[]>
    generate(opts: { name: string; algo: string }): Promise<OpResult>
    importKey(path: string, passphrase?: string): Promise<OpResult>
    remove(id: string): Promise<void>
    exportPrivate(id: string): Promise<OpResult>
    deploy(keyId: string, sessionId: string): Promise<OpResult>
  }
  knownHosts: {
    list(): Promise<KnownHost[]>
    remove(host: string, port: number, keyType: string): Promise<void>
  }
  metrics: {
    get(termId: string): Promise<OpResult & Partial<HostMetrics>>
  }
  vault: {
    state(): Promise<{ mode: 'keychain' | 'master'; locked: boolean }>
    setup(password: string): Promise<OpResult>
    unlock(password: string): Promise<OpResult>
    lock(): Promise<void>
    disable(password: string): Promise<OpResult>
  }
  dialog: {
    pickKeyFile(): Promise<string | null>
  }
  newWindow(): void
  setTitlebarTheme(dark: boolean): void
  openExternal(url: string): void
  getPathForFile(file: File): string
}
