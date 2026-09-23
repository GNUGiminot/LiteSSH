import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { basename, dirname, join, posix, relative, sep } from 'path'
import type { OpenMode, SFTPWrapper } from 'ssh2'
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
function statRemote(sftp: SFTPWrapper, path: string) {
  return new Promise<{ size: number; mode: number }>((resolve, reject) =>
    sftp.stat(path, (err, stat) => (err ? reject(err) : resolve(stat)))
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
  resumeRequested: boolean
  win: BrowserWindow
  lastEmit: number
  abort?: () => void
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
class TransferStalled extends Error {}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

const transfers = new Map<string, ActiveTransfer>()
const descriptors = new Map<string, Descriptor>()
/** Один SFTP-канал обслуживает передачи последовательно, отдельно для каждой SSH-сессии. */
const transferQueues = new Map<string, string[]>()
const runningQueues = new Set<string>()
/** Как OpenSSH: окно параллельных запросов, каждый блок 32 KiB. */
const WINDOW_REQUESTS = 16
const TRANSFER_CHUNK_SIZE = 32 * 1024
const STALL_TIMEOUT_MS = 60_000
const safeRemoteOffsets = new Map<string, number>()
const safeLocalOffsets = new Map<string, number>()

export function listTransfers(): TransferInfo[] {
  return [...transfers.values()].map((transfer) => ({ ...transfer.info }))
}

export function cancelTransfer(id: string): void {
  const t = transfers.get(id)
  if (!t) return
  t.cancelled = true
  t.abort?.()
  if (t.info.status === 'queued') {
    const d = descriptors.get(id)
    if (d) {
      const queue = transferQueues.get(d.termId)
      const index = queue?.indexOf(id) ?? -1
      if (queue && index >= 0) queue.splice(index, 1)
    }
    finishTransfer(t, 'cancelled')
  }
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
  direction: 'upload' | 'download',
  localPath?: string
): ActiveTransfer {
  const t: ActiveTransfer = {
    info: { id, name, direction, total: 0, done: 0, status: 'queued', phase: 'queued', localPath },
    cancelled: false,
    resumeRequested: false,
    win,
    lastEmit: 0
  }
  transfers.set(id, t)
  emit(t, true)
  return t
}

function enqueueTransfer(d: Descriptor, t: ActiveTransfer, resume = false): void {
  t.cancelled = false
  t.resumeRequested = resume
  t.info.status = 'queued'
  t.info.phase = 'queued'
  t.info.error = undefined
  t.info.canResume = false
  t.info.startedAt = undefined
  t.info.currentFile = undefined
  t.info.fileIndex = undefined
  const queue = transferQueues.get(d.termId) ?? []
  queue.push(t.info.id)
  transferQueues.set(d.termId, queue)
  emit(t, true)
  void pumpTransferQueue(d.termId)
}

async function pumpTransferQueue(termId: string): Promise<void> {
  if (runningQueues.has(termId)) return
  runningQueues.add(termId)
  try {
    const queue = transferQueues.get(termId)
    while (queue?.length) {
      const id = queue.shift()!
      const d = descriptors.get(id)
      const t = transfers.get(id)
      if (!d || !t || t.cancelled) continue
      let transferSftp: SFTPWrapper | undefined
      try {
        const resume = t.resumeRequested
        t.resumeRequested = false
        transferSftp = await openTransferSftp(termId)
        await runTransfer(transferSftp, d, t, resume)
      } catch (e) {
        finishTransfer(t, 'error', (e as Error).message)
      } finally {
        t.abort = undefined
        transferSftp?.end()
      }
    }
    transferQueues.delete(termId)
  } finally {
    runningQueues.delete(termId)
    // Передача могла добавиться между последней проверкой и снятием флага.
    if (transferQueues.get(termId)?.length) void pumpTransferQueue(termId)
  }
}

function openTransferSftp(termId: string): Promise<SFTPWrapper> {
  const client = getClient(termId)
  if (!client) return Promise.reject(new Error('SSH-подключение не активно'))
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
}

function finishTransfer(t: ActiveTransfer, status: TransferInfo['status'], error?: string): void {
  t.info.status = status
  if (error) t.info.error = error
  // прерванную/сломанную передачу можно возобновить (докачать)
  t.info.canResume = status === 'error' || status === 'cancelled'
  emit(t, true)
  void appendTransferLog(t.info)
  if (status === 'done') {
    descriptors.delete(t.info.id)
    setTimeout(() => transfers.delete(t.info.id), 60_000)
  }
}

async function appendTransferLog(info: TransferInfo): Promise<void> {
  try {
    const logDir = join(app.getPath('userData'), 'logs')
    await fsp.mkdir(logDir, { recursive: true })
    const clean = (value: string | undefined) => (value ?? '').replace(/[\r\n\t]+/g, ' ')
    const line = [
      new Date().toISOString(),
      info.status,
      info.direction,
      clean(info.name),
      `${info.done}/${info.total}`,
      clean(info.currentFile),
      clean(info.error)
    ].join('\t') + '\n'
    await fsp.appendFile(join(logDir, 'transfers.log'), line, 'utf8')
  } catch {
    /* Диагностический журнал не должен ломать передачу. */
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
  isCancelled: () => boolean,
  resume: boolean
): Promise<void> {
  return transferPutFile(sftp, local, remote, size, onProgress, isCancelled, resume)
}

/** Скачивание файла с докачкой: читаем удалённый начиная с текущего размера локального файла. */
function getFile(
  sftp: SFTPWrapper,
  remote: string,
  local: string,
  size: number,
  onProgress: (done: number) => void,
  isCancelled: () => boolean,
  resume: boolean
): Promise<void> {
  return transferGetFile(sftp, remote, local, size, onProgress, isCancelled, resume)
}

function openRemote(sftp: SFTPWrapper, path: string, flags: OpenMode): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    sftp.open(path, flags, (error, handle) => error ? reject(error) : resolve(handle))
  )
}

function closeRemote(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000)
    sftp.close(handle, () => { clearTimeout(timer); resolve() })
  })
}

async function readRemote(sftp: SFTPWrapper, handle: Buffer, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const bytesRead = await new Promise<number>((resolve, reject) =>
      sftp.read(handle, buffer, offset, length - offset, position + offset, (error, bytes) =>
        error ? reject(error) : resolve(bytes)
      )
    )
    if (!bytesRead) throw new Error('Неожиданный конец файла на сервере')
    offset += bytesRead
  }
  return buffer
}

async function readLocal(handle: Awaited<ReturnType<typeof fsp.open>>, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset)
    if (!bytesRead) throw new Error('Неожиданный конец локального файла')
    offset += bytesRead
  }
  return buffer
}

async function writeLocal(handle: Awaited<ReturnType<typeof fsp.open>>, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset)
    if (!bytesWritten) throw new Error('Не удалось записать локальный файл')
    offset += bytesWritten
  }
}

function writeRemote(sftp: SFTPWrapper, handle: Buffer, buffer: Buffer, position: number): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.write(handle, buffer, 0, buffer.length, position, (error) => error ? reject(error) : resolve())
  )
}

function truncateRemote(sftp: SFTPWrapper, handle: Buffer, size: number): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.fsetstat(handle, { size }, (error) => error ? reject(error) : resolve())
  )
}

function stallGuard<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TransferStalled('Передача остановилась: сервер не подтверждает данные более 60 секунд')),
      STALL_TIMEOUT_MS
    )
    operation.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

function tryTruncateRemote(sftp: SFTPWrapper, handle: Buffer, size: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000)
    truncateRemote(sftp, handle, size).then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() }
    )
  })
}

function remotePartPath(remote: string): string {
  return posix.join(posix.dirname(remote), `.${posix.basename(remote)}.litessh-part`)
}

function localPartPath(local: string): string {
  return join(dirname(local), `.${basename(local)}.litessh-part`)
}

export async function transferPutFile(
  sftp: SFTPWrapper,
  local: string,
  remote: string,
  size: number,
  onProgress: (done: number) => void,
  isCancelled: () => boolean,
  resume: boolean
): Promise<void> {
  if (resume && await sftpSize(sftp, remote) === size) return onProgress(size)
  const part = remotePartPath(remote)
  const remoteSize = resume ? await sftpSize(sftp, part) : 0
  const rememberedOffset = safeRemoteOffsets.get(part)
  const offset = remoteSize <= size ? Math.min(remoteSize, rememberedOffset ?? remoteSize) : 0
  const localHandle = await fsp.open(local, 'r')
  let remoteHandle: Buffer | undefined
  let confirmed = offset
  try {
    remoteHandle = await stallGuard(openRemote(sftp, part, offset > 0 ? 'r+' : 'w'))
    if (remoteSize !== offset) await stallGuard(truncateRemote(sftp, remoteHandle, offset))
    let nextOffset = offset
    let failed = false
    const completed = new Map<number, number>()
    const markCompleted = (position: number, length: number) => {
      completed.set(position, length)
      while (completed.has(confirmed)) {
        const contiguous = completed.get(confirmed)!
        completed.delete(confirmed)
        confirmed += contiguous
      }
      safeRemoteOffsets.set(part, confirmed)
      onProgress(confirmed)
    }
    const worker = async () => {
      while (!failed && nextOffset < size) {
        if (isCancelled()) throw new Cancelled()
        const position = nextOffset
        const length = Math.min(TRANSFER_CHUNK_SIZE, size - position)
        nextOffset += length
        try {
          const buffer = await readLocal(localHandle, length, position)
          await stallGuard(writeRemote(sftp, remoteHandle!, buffer, position))
          markCompleted(position, buffer.length)
        } catch (error) {
          failed = true
          if (error instanceof TransferStalled) sftp.end()
          throw error
        }
      }
    }
    onProgress(confirmed)
    const results = await Promise.allSettled(Array.from(
      { length: Math.min(WINDOW_REQUESTS, Math.ceil((size - offset) / TRANSFER_CHUNK_SIZE)) },
      () => worker()
    ))
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected) throw rejected.reason
  } catch (error) {
    safeRemoteOffsets.set(part, confirmed)
    if (remoteHandle) await tryTruncateRemote(sftp, remoteHandle, confirmed)
    throw error
  } finally {
    await localHandle.close()
    if (remoteHandle) await closeRemote(sftp, remoteHandle)
  }
  if (isCancelled()) throw new Cancelled()
  const written = await sftpSize(sftp, part)
  if (written !== size) throw new Error(`Проверка размера не пройдена: записано ${written} из ${size} байт`)
  await unlinkRemote(sftp, remote).catch(() => undefined)
  await renameRemote(sftp, part, remote)
  safeRemoteOffsets.delete(part)
  onProgress(size)
}

export async function transferGetFile(
  sftp: SFTPWrapper,
  remote: string,
  local: string,
  size: number,
  onProgress: (done: number) => void,
  isCancelled: () => boolean,
  resume: boolean
): Promise<void> {
  if (resume && await localSize(local) === size && size > 0) return onProgress(size)
  const part = localPartPath(local)
  const localBytes = resume ? await localSize(part) : 0
  const rememberedOffset = safeLocalOffsets.get(part)
  const offset = localBytes <= size ? Math.min(localBytes, rememberedOffset ?? localBytes) : 0
  const remoteHandle = await stallGuard(openRemote(sftp, remote, 'r'))
  const localHandle = await fsp.open(part, offset > 0 ? 'r+' : 'w')
  let confirmed = offset
  try {
    if (localBytes !== offset) await localHandle.truncate(offset)
    let nextOffset = offset
    let failed = false
    const completed = new Map<number, number>()
    const markCompleted = (position: number, length: number) => {
      completed.set(position, length)
      while (completed.has(confirmed)) {
        const contiguous = completed.get(confirmed)!
        completed.delete(confirmed)
        confirmed += contiguous
      }
      safeLocalOffsets.set(part, confirmed)
      onProgress(confirmed)
    }
    const worker = async () => {
      while (!failed && nextOffset < size) {
        if (isCancelled()) throw new Cancelled()
        const position = nextOffset
        const length = Math.min(TRANSFER_CHUNK_SIZE, size - position)
        nextOffset += length
        try {
          const buffer = await stallGuard(readRemote(sftp, remoteHandle, length, position))
          await writeLocal(localHandle, buffer, position)
          markCompleted(position, buffer.length)
        } catch (error) {
          failed = true
          if (error instanceof TransferStalled) sftp.end()
          throw error
        }
      }
    }
    onProgress(confirmed)
    const results = await Promise.allSettled(Array.from(
      { length: Math.min(WINDOW_REQUESTS, Math.ceil((size - offset) / TRANSFER_CHUNK_SIZE)) },
      () => worker()
    ))
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected) throw rejected.reason
    await localHandle.sync()
  } catch (error) {
    safeLocalOffsets.set(part, confirmed)
    await localHandle.truncate(confirmed).catch(() => undefined)
    throw error
  } finally {
    await localHandle.close()
    await closeRemote(sftp, remoteHandle)
  }
  if (isCancelled()) throw new Cancelled()
  const downloaded = await localSize(part)
  if (downloaded !== size) throw new Error(`Проверка размера не пройдена: получено ${downloaded} из ${size} байт`)
  await fsp.rm(local, { force: true })
  await fsp.rename(part, local)
  safeLocalOffsets.delete(part)
  onProgress(size)
}

/** Выполняет (или возобновляет) передачу по дескриптору, переиспользуя строку прогресса. */
async function runTransfer(
  sftp: SFTPWrapper,
  d: Descriptor,
  t: ActiveTransfer,
  resume: boolean
): Promise<void> {
  t.cancelled = false
  t.info.status = 'active'
  t.info.phase = d.kind === 'dir' ? 'scanning' : 'transferring'
  if (d.kind === 'file') t.info.startedAt = Date.now()
  t.abort = () => sftp.end()
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
        try {
          await putFile(sftp, d.src, d.dst, size, onP, () => t.cancelled, resume)
        } catch (error) {
          throw new Error(`Не удалось загрузить «${d.name}»: ${errorMessage(error)}`)
        }
      } else {
        await fsp.mkdir(dirname(d.dst), { recursive: true })
        try {
          await getFile(sftp, d.src, d.dst, size, onP, () => t.cancelled, resume)
        } catch (error) {
          throw new Error(`Не удалось скачать «${d.name}»: ${errorMessage(error)}`)
        }
      }
      t.info.done = size
    } else if (d.direction === 'upload') {
      const { files, dirs } = await walkLocal(d.src)
      t.info.total = files.reduce((s, f) => s + f.size, 0)
      t.info.totalFiles = files.length
      t.info.phase = 'preparing'
      emit(t, true)
      await ensureRemoteDir(sftp, d.dst)
      for (const dd of dirs) await ensureRemoteDir(sftp, posix.join(d.dst, dd.split(sep).join('/')))
      let base = 0
      for (let index = 0; index < files.length; index++) {
        const f = files[index]
        if (t.cancelled) throw new Cancelled()
        t.info.phase = 'transferring'
        t.info.startedAt ??= Date.now()
        t.info.currentFile = f.rel
        t.info.fileIndex = index + 1
        emit(t, true)
        const remoteFile = posix.join(d.dst, f.rel.split(sep).join('/'))
        try {
          await putFile(sftp, f.abs, remoteFile, f.size, (done) => {
            t.info.done = base + done
            emit(t)
          }, () => t.cancelled, resume)
        } catch (error) {
          throw new Error(`Не удалось загрузить «${f.rel}»: ${errorMessage(error)}`)
        }
        base += f.size
        t.info.done = base
      }
    } else {
      const { files, dirs } = await walkRemote(sftp, d.src)
      t.info.total = files.reduce((s, f) => s + f.size, 0)
      t.info.totalFiles = files.length
      t.info.phase = 'preparing'
      emit(t, true)
      await fsp.mkdir(d.dst, { recursive: true })
      for (const dd of dirs) await fsp.mkdir(join(d.dst, dd.split('/').join(sep)), { recursive: true })
      let base = 0
      for (let index = 0; index < files.length; index++) {
        const f = files[index]
        if (t.cancelled) throw new Cancelled()
        t.info.phase = 'transferring'
        t.info.startedAt ??= Date.now()
        t.info.currentFile = f.rel
        t.info.fileIndex = index + 1
        emit(t, true)
        const localFile = join(d.dst, f.rel.split('/').join(sep))
        try {
          await getFile(sftp, f.abs, localFile, f.size, (done) => {
            t.info.done = base + done
            emit(t)
          }, () => t.cancelled, resume)
        } catch (error) {
          throw new Error(`Не удалось скачать «${f.rel}»: ${errorMessage(error)}`)
        }
        base += f.size
        t.info.done = base
      }
    }
    finishTransfer(t, 'done')
  } catch (e) {
    if (t.cancelled || e instanceof Cancelled) finishTransfer(t, 'cancelled')
    else finishTransfer(t, 'error', errorMessage(e))
  }
}

export async function resumeTransfer(win: BrowserWindow, id: string): Promise<void> {
  const d = descriptors.get(id)
  const t = transfers.get(id)
  if (!d || !t) throw new Error('Передача недоступна для возобновления')
  if (t.info.status === 'active' || t.info.status === 'queued') {
    throw new Error('Передача уже выполняется или ожидает в очереди')
  }
  t.win = win
  enqueueTransfer(d, t, true)
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
    } catch (error) {
      try {
        const stat = await statRemote(sftp, cur)
        if ((stat.mode & S_IFMT) === S_IFDIR) continue
      } catch {
        /* Ни каталога, ни успешного mkdir — возвращаем исходную понятную ошибку. */
      }
      throw new Error(`Не удалось создать каталог «${cur}»: ${errorMessage(error)}`)
    }
  }
}

export async function upload(
  win: BrowserWindow,
  termId: string,
  localPaths: string[],
  remoteDir: string
): Promise<void> {
  await getSftp(termId)
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
    enqueueTransfer(d, t)
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
  await getSftp(termId)
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
    const t = newTransfer(win, randomUUID(), name, 'download', d.dst)
    descriptors.set(t.info.id, d)
    enqueueTransfer(d, t)
  }
}
