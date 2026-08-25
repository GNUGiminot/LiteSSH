import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fsp, createReadStream, createWriteStream } from 'fs'
import { basename, dirname, join, posix, relative, sep } from 'path'
import type { SFTPWrapper } from 'ssh2'
import { getClient } from './connection-manager'
import type { FileEntry, TransferInfo } from '@shared/types'

const sftpMap = new Map<string, SFTPWrapper>()

export async function getSftp(termId: string): Promise<SFTPWrapper> {
  const existing = sftpMap.get(termId)
  if (existing) return existing
  const client = getClient(termId)
  if (!client) throw new Error('SSH-подключение не активно')
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
    client.sftp((err, s) => (err ? reject(err) : resolve(s)))
  )
  sftp.on('close', () => sftpMap.delete(termId))
  sftpMap.set(termId, sftp)
  return sftp
}

// -------- promisified sftp primitives --------

function readdir(sftp: SFTPWrapper, path: string) {
  return new Promise<{ filename: string; attrs: { size: number; mtime: number; mode: number } }[]>(
    (resolve, reject) => sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)))
  )
}
function realpath(sftp: SFTPWrapper, path: string) {
  return new Promise<string>((resolve, reject) =>
    sftp.realpath(path, (err, p) => (err ? reject(err) : resolve(p)))
  )
}
function mkdirRemote(sftp: SFTPWrapper, path: string) {
  return new Promise<void>((resolve, reject) =>
    sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
  )
}
function rmdirRemote(sftp: SFTPWrapper, path: string) {
  return new Promise<void>((resolve, reject) =>
    sftp.rmdir(path, (err) => (err ? reject(err) : resolve()))
  )
}
function unlinkRemote(sftp: SFTPWrapper, path: string) {
  return new Promise<void>((resolve, reject) =>
    sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
  )
}
function renameRemote(sftp: SFTPWrapper, from: string, to: string) {
  return new Promise<void>((resolve, reject) =>
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
  )
}
function chmodRemote(sftp: SFTPWrapper, path: string, mode: number) {
  return new Promise<void>((resolve, reject) =>
    sftp.chmod(path, mode, (err) => (err ? reject(err) : resolve()))
  )
}
// -------- listing --------

const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFLNK = 0xa000

function permString(mode: number): string {
  const chars = 'rwxrwxrwx'
  let out = ''
  for (let i = 0; i < 9; i++) {
    out += mode & (0b100000000 >> i) ? chars[i] : '-'
  }
  return out
}

export async function listRemote(termId: string, path: string): Promise<{ path: string; entries: FileEntry[] }> {
  const sftp = await getSftp(termId)
  const resolved = await realpath(sftp, path || '.')
  const raw = await readdir(sftp, resolved)
  const entries: FileEntry[] = raw.map((e) => {
    const fmt = e.attrs.mode & S_IFMT
    return {
      name: e.filename,
      path: posix.join(resolved, e.filename),
      isDir: fmt === S_IFDIR,
      isLink: fmt === S_IFLNK,
      size: e.attrs.size,
      mtime: e.attrs.mtime * 1000,
      mode: e.attrs.mode & 0o777,
      perms: permString(e.attrs.mode)
    }
  })
  return { path: resolved, entries }
}

export async function sftpMkdir(termId: string, path: string): Promise<void> {
  await mkdirRemote(await getSftp(termId), path)
}

export async function sftpRename(termId: string, from: string, to: string): Promise<void> {
  await renameRemote(await getSftp(termId), from, to)
}

export async function sftpChmod(termId: string, path: string, mode: string): Promise<void> {
  const parsed = parseInt(mode, 8)
  if (isNaN(parsed) || parsed < 0 || parsed > 0o7777) throw new Error('Неверный режим (ожидается октальный, например 644)')
  await chmodRemote(await getSftp(termId), path, parsed)
}

export async function sftpRemove(termId: string, path: string, isDir: boolean): Promise<void> {
  const sftp = await getSftp(termId)
  await removeRecursive(sftp, path, isDir)
}

async function removeRecursive(sftp: SFTPWrapper, path: string, isDir: boolean): Promise<void> {
  if (!isDir) {
    await unlinkRemote(sftp, path)
    return
  }
  const children = await readdir(sftp, path)
  for (const c of children) {
    const childPath = posix.join(path, c.filename)
    await removeRecursive(sftp, childPath, (c.attrs.mode & S_IFMT) === S_IFDIR)
  }
  await rmdirRemote(sftp, path)
}

// -------- чтение/запись файла для предпросмотра --------

const PREVIEW_LIMIT = 20 * 1024 * 1024 // 20 MB

export async function sftpReadFile(
  termId: string,
  path: string
): Promise<{ base64: string; size: number; truncated: boolean }> {
  const sftp = await getSftp(termId)
  const stat = await new Promise<{ size: number }>((resolve, reject) =>
    sftp.stat(path, (err, s) => (err ? reject(err) : resolve(s)))
  )
  if (stat.size > PREVIEW_LIMIT) {
    // читаем только начало для hex-превью больших файлов
    const buf = await readPartial(sftp, path, 64 * 1024)
    return { base64: buf.toString('base64'), size: stat.size, truncated: true }
  }
  const data = await new Promise<Buffer>((resolve, reject) =>
    sftp.readFile(path, (err, buf) => (err ? reject(err) : resolve(buf)))
  )
  return { base64: data.toString('base64'), size: stat.size, truncated: false }
}

function readPartial(sftp: SFTPWrapper, path: string, bytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, 'r', (err, handle) => {
      if (err) return reject(err)
      const buf = Buffer.alloc(bytes)
      sftp.read(handle, buf, 0, bytes, 0, (err2, bytesRead) => {
        sftp.close(handle, () => {
          if (err2) reject(err2)
          else resolve(buf.subarray(0, bytesRead))
        })
      })
    })
  })
}

export async function sftpWriteFile(termId: string, path: string, base64: string): Promise<void> {
  const sftp = await getSftp(termId)
  await new Promise<void>((resolve, reject) =>
    sftp.writeFile(path, Buffer.from(base64, 'base64'), (err) => (err ? reject(err) : resolve()))
  )
}

// -------- transfers --------

interface ActiveTransfer {
  info: TransferInfo
  cancelled: boolean
  win: BrowserWindow
  lastEmit: number
}

/** Описание передачи для возможности возобновления (докачки). */
interface Descriptor {
  termId: string
  direction: 'upload' | 'download'
  kind: 'file' | 'dir'
  /** upload: локальный путь-источник; download: удалённый путь-источник */
  src: string
  /** upload: удалённый путь-приёмник; download: локальный путь-приёмник */
  dst: string
  name: string
}

class Cancelled extends Error {}

const transfers = new Map<string, ActiveTransfer>()
const descriptors = new Map<string, Descriptor>()

export function cancelTransfer(id: string): void {
  const t = transfers.get(id)
  if (t) t.cancelled = true
}

function emit(t: ActiveTransfer, force = false): void {
  const now = Date.now()
  if (!force && now - t.lastEmit < 200) return
  t.lastEmit = now
  if (!t.win.isDestroyed()) t.win.webContents.send('transfer:update', t.info)
}

function newTransfer(
  win: BrowserWindow,
  id: string,
  name: string,
  direction: 'upload' | 'download'
): ActiveTransfer {
  const t: ActiveTransfer = {
    info: { id, name, direction, total: 0, done: 0, status: 'active' },
    cancelled: false,
    win,
    lastEmit: 0
  }
  transfers.set(id, t)
  emit(t, true)
  return t
}

function finishTransfer(t: ActiveTransfer, status: TransferInfo['status'], error?: string): void {
  t.info.status = status
  if (error) t.info.error = error
  // прерванную/сломанную передачу можно возобновить (докачать)
  t.info.canResume = status === 'error' || status === 'cancelled'
  emit(t, true)
  if (status === 'done') {
    descriptors.delete(t.info.id)
    setTimeout(() => transfers.delete(t.info.id), 60_000)
  }
}

function sftpSize(sftp: SFTPWrapper, path: string): Promise<number> {
  return new Promise((resolve) =>
    sftp.stat(path, (err, s) => resolve(err || !s ? 0 : s.size))
  )
}

async function localSize(path: string): Promise<number> {
  try {
    return (await fsp.stat(path)).size
  } catch {
    return 0
  }
}

/** Загрузка файла на сервер с докачкой: пишем начиная с текущего размера удалённого файла. */
function putFile(
  sftp: SFTPWrapper,
  local: string,
  remote: string,
  size: number,
  onProgress: (done: number) => void,
  isCancelled: () => boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    void sftpSize(sftp, remote).then((offset) => {
      if (offset >= size) {
        onProgress(size)
        return resolve()
      }
      const rs = createReadStream(local, { start: offset })
      const ws = sftp.createWriteStream(remote, { flags: offset > 0 ? 'a' : 'w' })
      let done = offset
      rs.on('data', (chunk: Buffer | string) => {
        done += chunk.length
        onProgress(done)
        if (isCancelled()) {
          rs.destroy()
          ws.end()
          reject(new Cancelled())
        }
      })
      rs.on('error', reject)
      ws.on('error', reject)
      ws.on('close', () => resolve())
      rs.pipe(ws)
    })
  })
}

/** Скачивание файла с докачкой: читаем удалённый начиная с текущего размера локального файла. */
function getFile(
  sftp: SFTPWrapper,
  remote: string,
  local: string,
  size: number,
  onProgress: (done: number) => void,
  isCancelled: () => boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    void localSize(local).then((offset) => {
      if (offset >= size && size > 0) {
        onProgress(size)
        return resolve()
      }
      const start = offset < size ? offset : 0
      const rs = sftp.createReadStream(remote, { start })
      const ws = createWriteStream(local, { flags: start > 0 ? 'a' : 'w' })
      let done = start
      rs.on('data', (chunk: Buffer | string) => {
        done += chunk.length
        onProgress(done)
        if (isCancelled()) {
          rs.destroy()
          ws.end()
          reject(new Cancelled())
        }
      })
      rs.on('error', reject)
      ws.on('error', reject)
      ws.on('finish', () => resolve())
      rs.pipe(ws)
    })
  })
}

/** Выполняет (или возобновляет) передачу по дескриптору, переиспользуя строку прогресса. */
async function runTransfer(
  sftp: SFTPWrapper,
  d: Descriptor,
  t: ActiveTransfer
): Promise<void> {
  t.cancelled = false
  t.info.status = 'active'
  t.info.error = undefined
  t.info.canResume = false
  emit(t, true)
  try {
    if (d.kind === 'file') {
      const size =
        d.direction === 'upload' ? (await fsp.stat(d.src)).size : await sftpSize(sftp, d.src)
      t.info.total = size
      emit(t, true)
      const onP = (done: number) => {
        t.info.done = done
        emit(t)
      }
      if (d.direction === 'upload') {
        await putFile(sftp, d.src, d.dst, size, onP, () => t.cancelled)
      } else {
        await fsp.mkdir(dirname(d.dst), { recursive: true })
        await getFile(sftp, d.src, d.dst, size, onP, () => t.cancelled)
      }
      t.info.done = size
    } else if (d.direction === 'upload') {
      const { files, dirs } = await walkLocal(d.src)
      t.info.total = files.reduce((s, f) => s + f.size, 0)
      emit(t, true)
      await ensureRemoteDir(sftp, d.dst)
      for (const dd of dirs) await ensureRemoteDir(sftp, posix.join(d.dst, dd.split(sep).join('/')))
      let base = 0
      for (const f of files) {
        const remoteFile = posix.join(d.dst, f.rel.split(sep).join('/'))
        await putFile(sftp, f.abs, remoteFile, f.size, (done) => {
          t.info.done = base + done
          emit(t)
        }, () => t.cancelled)
        base += f.size
        t.info.done = base
      }
    } else {
      const { files, dirs } = await walkRemote(sftp, d.src)
      t.info.total = files.reduce((s, f) => s + f.size, 0)
      emit(t, true)
      await fsp.mkdir(d.dst, { recursive: true })
      for (const dd of dirs) await fsp.mkdir(join(d.dst, dd.split('/').join(sep)), { recursive: true })
      let base = 0
      for (const f of files) {
        const localFile = join(d.dst, f.rel.split('/').join(sep))
        await getFile(sftp, f.abs, localFile, f.size, (done) => {
          t.info.done = base + done
          emit(t)
        }, () => t.cancelled)
        base += f.size
        t.info.done = base
      }
    }
    finishTransfer(t, 'done')
  } catch (e) {
    if (e instanceof Cancelled) finishTransfer(t, 'cancelled')
    else finishTransfer(t, 'error', (e as Error).message)
  }
}

export async function resumeTransfer(win: BrowserWindow, id: string): Promise<void> {
  const d = descriptors.get(id)
  const t = transfers.get(id)
  if (!d || !t) throw new Error('Передача недоступна для возобновления')
  const sftp = await getSftp(d.termId)
  void runTransfer(sftp, d, t)
}

async function walkLocal(root: string): Promise<{ files: { abs: string; rel: string; size: number }[]; dirs: string[] }> {
  const files: { abs: string; rel: string; size: number }[] = []
  const dirs: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        dirs.push(relative(root, abs))
        await walk(abs)
      } else if (e.isFile()) {
        const st = await fsp.stat(abs)
        files.push({ abs, rel: relative(root, abs), size: st.size })
      }
    }
  }
  await walk(root)
  return { files, dirs }
}

async function ensureRemoteDir(sftp: SFTPWrapper, path: string): Promise<void> {
  const parts = path.split('/').filter(Boolean)
  let cur = path.startsWith('/') ? '/' : ''
  for (const part of parts) {
    cur = cur === '' ? part : posix.join(cur, part)
    try {
      await mkdirRemote(sftp, cur)
    } catch {
      /* уже существует */
    }
  }
}

export async function upload(
  win: BrowserWindow,
  termId: string,
  localPaths: string[],
  remoteDir: string
): Promise<void> {
  const sftp = await getSftp(termId)
  for (const localPath of localPaths) {
    const name = basename(localPath)
    const isDir = (await fsp.stat(localPath)).isDirectory()
    const d: Descriptor = {
      termId,
      direction: 'upload',
      kind: isDir ? 'dir' : 'file',
      src: localPath,
      dst: posix.join(remoteDir, name),
      name
    }
    const t = newTransfer(win, randomUUID(), name, 'upload')
    descriptors.set(t.info.id, d)
    void runTransfer(sftp, d, t)
  }
}

async function walkRemote(
  sftp: SFTPWrapper,
  root: string
): Promise<{ files: { abs: string; rel: string; size: number }[]; dirs: string[] }> {
  const files: { abs: string; rel: string; size: number }[] = []
  const dirs: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(sftp, dir)
    for (const e of entries) {
      const abs = posix.join(dir, e.filename)
      if ((e.attrs.mode & S_IFMT) === S_IFDIR) {
        dirs.push(posix.relative(root, abs))
        await walk(abs)
      } else if ((e.attrs.mode & S_IFMT) !== S_IFLNK) {
        files.push({ abs, rel: posix.relative(root, abs), size: e.attrs.size })
      }
    }
  }
  await walk(root)
  return { files, dirs }
}

export async function download(
  win: BrowserWindow,
  termId: string,
  items: { path: string; isDir: boolean }[],
  localDir: string
): Promise<void> {
  const sftp = await getSftp(termId)
  for (const item of items) {
    const name = posix.basename(item.path)
    const d: Descriptor = {
      termId,
      direction: 'download',
      kind: item.isDir ? 'dir' : 'file',
      src: item.path,
      dst: join(localDir, name),
      name
    }
    const t = newTransfer(win, randomUUID(), name, 'download')
    descriptors.set(t.info.id, d)
    void runTransfer(sftp, d, t)
  }
}
