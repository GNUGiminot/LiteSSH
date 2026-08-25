import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  ConnectProgress,
  ConnectRequest,
  ConnectResult,
  HostKeyPrompt,
  KeyInfo,
  ListResult,
  LiteSSHApi,
  OpResult,
  RevealResult,
  SessionProfile,
  TransferInfo,
  TunnelState
} from '@shared/types'

function subscribe<Args extends unknown[]>(
  channel: string,
  cb: (...args: Args) => void
): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as Args))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: LiteSSHApi = {
  platform: process.platform,
  sessions: {
    list: (): Promise<SessionProfile[]> => ipcRenderer.invoke('sessions:list'),
    save: (profile: SessionProfile): Promise<SessionProfile> =>
      ipcRenderer.invoke('sessions:save', profile),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', id),
    reveal: (id: string): Promise<RevealResult> => ipcRenderer.invoke('sessions:reveal', id),
    exportJson: (): Promise<OpResult> => ipcRenderer.invoke('sessions:export'),
    importJson: (): Promise<OpResult> => ipcRenderer.invoke('sessions:import'),
    importSshConfig: (): Promise<OpResult> => ipcRenderer.invoke('sessions:import-ssh-config')
  },
  ssh: {
    connect: (req: ConnectRequest): Promise<ConnectResult> =>
      ipcRenderer.invoke('ssh:connect', req),
    split: (sourceTermId): Promise<ConnectResult> => ipcRenderer.invoke('ssh:split', sourceTermId),
    write: (termId, data) => ipcRenderer.send('term:write', termId, data),
    resize: (termId, cols, rows) => ipcRenderer.send('term:resize', termId, cols, rows),
    close: (termId) => ipcRenderer.send('term:close', termId),
    isLogging: (termId): Promise<boolean> => ipcRenderer.invoke('term:is-logging', termId),
    toggleLog: (termId) => ipcRenderer.invoke('term:toggle-log', termId)
  },
  term: {
    onData: (cb) => subscribe<[string, Uint8Array]>('term:data', cb),
    onExit: (cb) => subscribe<[string, string | undefined]>('term:exit', cb),
    onProgress: (cb) => subscribe<[ConnectProgress]>('ssh:progress', cb)
  },
  hostkey: {
    onPrompt: (cb) => subscribe<[HostKeyPrompt]>('hostkey:prompt', cb),
    respond: (requestId, accept) => ipcRenderer.send('hostkey:respond', requestId, accept)
  },
  sftp: {
    open: (termId): Promise<ListResult> => ipcRenderer.invoke('sftp:open', termId),
    list: (termId, path): Promise<ListResult> => ipcRenderer.invoke('sftp:list', termId, path),
    mkdir: (termId, path): Promise<OpResult> => ipcRenderer.invoke('sftp:mkdir', termId, path),
    rename: (termId, from, to): Promise<OpResult> =>
      ipcRenderer.invoke('sftp:rename', termId, from, to),
    remove: (termId, path, isDir): Promise<OpResult> =>
      ipcRenderer.invoke('sftp:remove', termId, path, isDir),
    chmod: (termId, path, mode): Promise<OpResult> =>
      ipcRenderer.invoke('sftp:chmod', termId, path, mode),
    upload: (termId, localPaths, remoteDir): Promise<OpResult> =>
      ipcRenderer.invoke('sftp:upload', termId, localPaths, remoteDir),
    download: (termId, items, localDir): Promise<OpResult> =>
      ipcRenderer.invoke('sftp:download', termId, items, localDir),
    read: (termId, path) => ipcRenderer.invoke('sftp:read', termId, path),
    write: (termId, path, base64): Promise<OpResult> =>
      ipcRenderer.invoke('sftp:write', termId, path, base64)
  },
  snippets: {
    list: () => ipcRenderer.invoke('snippets:list'),
    save: (s) => ipcRenderer.invoke('snippets:save', s),
    remove: (id): Promise<void> => ipcRenderer.invoke('snippets:delete', id)
  },
  history: {
    add: (command) => ipcRenderer.send('history:add', command),
    list: () => ipcRenderer.invoke('history:list'),
    clear: (): Promise<void> => ipcRenderer.invoke('history:clear')
  },
  scripts: {
    list: () => ipcRenderer.invoke('scripts:list'),
    save: (s) => ipcRenderer.invoke('scripts:save', s),
    remove: (id): Promise<void> => ipcRenderer.invoke('scripts:delete', id),
    upload: (termId, body) => ipcRenderer.invoke('scripts:upload', termId, body)
  },
  tunnels: {
    list: (sessionId) => ipcRenderer.invoke('tunnels:list', sessionId),
    save: (t) => ipcRenderer.invoke('tunnels:save', t),
    remove: (id): Promise<void> => ipcRenderer.invoke('tunnels:delete', id),
    start: (termId, tunnelId): Promise<OpResult> =>
      ipcRenderer.invoke('tunnels:start', termId, tunnelId),
    stop: (tunnelId) => ipcRenderer.send('tunnels:stop', tunnelId),
    states: () => ipcRenderer.invoke('tunnels:states'),
    onState: (cb) => subscribe<[TunnelState[]]>('tunnel:state', cb)
  },
  rdp: {
    open: (termId, dstHost, dstPort) => ipcRenderer.invoke('rdp:open', termId, dstHost, dstPort)
  },
  pty: {
    spawn: (shell, size): Promise<ConnectResult> => ipcRenderer.invoke('pty:spawn', shell, size),
    write: (ptyId, data) => ipcRenderer.send('pty:write', ptyId, data),
    resize: (ptyId, cols, rows) => ipcRenderer.send('pty:resize', ptyId, cols, rows),
    close: (ptyId) => ipcRenderer.send('pty:close', ptyId),
    shells: () => ipcRenderer.invoke('pty:shells'),
    onData: (cb) => subscribe<[string, string]>('pty:data', cb),
    onExit: (cb) => subscribe<[string]>('pty:exit', cb)
  },
  fs: {
    home: (): Promise<string> => ipcRenderer.invoke('fs:home'),
    list: (path): Promise<ListResult> => ipcRenderer.invoke('fs:list', path),
    mkdir: (path): Promise<OpResult> => ipcRenderer.invoke('fs:mkdir', path),
    rename: (from, to): Promise<OpResult> => ipcRenderer.invoke('fs:rename', from, to),
    remove: (path): Promise<OpResult> => ipcRenderer.invoke('fs:remove', path),
    reveal: (path) => ipcRenderer.send('fs:reveal', path)
  },
  transfer: {
    cancel: (id) => ipcRenderer.send('transfer:cancel', id),
    resume: (id): Promise<OpResult> => ipcRenderer.invoke('transfer:resume', id),
    onUpdate: (cb) => subscribe<[TransferInfo]>('transfer:update', cb)
  },
  keys: {
    list: (): Promise<KeyInfo[]> => ipcRenderer.invoke('keys:list'),
    generate: (opts): Promise<OpResult> => ipcRenderer.invoke('keys:generate', opts),
    importKey: (path, passphrase): Promise<OpResult> =>
      ipcRenderer.invoke('keys:import-file', path, passphrase),
    remove: (id): Promise<void> => ipcRenderer.invoke('keys:delete', id),
    exportPrivate: (id): Promise<OpResult> => ipcRenderer.invoke('keys:export-private', id),
    deploy: (keyId, sessionId): Promise<OpResult> =>
      ipcRenderer.invoke('keys:deploy', keyId, sessionId)
  },
  knownHosts: {
    list: () => ipcRenderer.invoke('known-hosts:list'),
    remove: (host, port, keyType): Promise<void> =>
      ipcRenderer.invoke('known-hosts:delete', host, port, keyType)
  },
  metrics: {
    get: (termId) => ipcRenderer.invoke('metrics:get', termId)
  },
  vault: {
    state: () => ipcRenderer.invoke('vault:state'),
    setup: (password): Promise<OpResult> => ipcRenderer.invoke('vault:setup', password),
    unlock: (password): Promise<OpResult> => ipcRenderer.invoke('vault:unlock', password),
    lock: (): Promise<void> => ipcRenderer.invoke('vault:lock'),
    disable: (password): Promise<OpResult> => ipcRenderer.invoke('vault:disable', password)
  },
  dialog: {
    pickKeyFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-key')
  },
  newWindow: () => ipcRenderer.send('window:new'),
  setTitlebarTheme: (dark: boolean) => ipcRenderer.send('window:overlay', dark),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', api)
