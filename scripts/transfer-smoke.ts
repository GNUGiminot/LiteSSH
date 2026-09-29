import { strict as assert } from 'assert'
import { createHash } from 'crypto'
import { promises as fsp, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client, Server, utils, type SFTPWrapper } from 'ssh2'
import { transferGetFile, transferPutFile } from '../electron/main/ssh/sftp-manager'

const { OPEN_MODE, STATUS_CODE } = utils.sftp
const files = new Map<string, Buffer>()
const handles = new Map<number, { path: string }>()
let nextHandle = 1
let writesInFlight = 0
let maxWritesInFlight = 0

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function getHandle(handle: Buffer): { path: string } | undefined {
  if (handle.length !== 4) return undefined
  return handles.get(handle.readUInt32BE(0))
}

async function main(): Promise<void> {
  const hostKey = readFileSync(join(process.cwd(), 'node_modules/ssh2/test/fixtures/ssh_host_rsa_key'))
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (context) => context.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('sftp', (acceptSftp) => {
          const stream = acceptSftp()
          stream.on('OPEN', (requestId, path, flags) => {
            if (!files.has(path) || (flags & OPEN_MODE.TRUNC)) files.set(path, Buffer.alloc(0))
            const id = nextHandle++
            handles.set(id, { path })
            const handle = Buffer.alloc(4)
            handle.writeUInt32BE(id, 0)
            stream.handle(requestId, handle)
          })
          stream.on('WRITE', (requestId, handle, offset, data) => {
            const open = getHandle(handle)
            if (!open) return stream.status(requestId, STATUS_CODE.FAILURE)
            writesInFlight++
            maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight)
            const delay = 1 + ((Math.floor(offset / 32768) * 7) % 17)
            setTimeout(() => {
              const previous = files.get(open.path) ?? Buffer.alloc(0)
              const required = offset + data.length
              const next = required > previous.length ? Buffer.alloc(required) : Buffer.from(previous)
              previous.copy(next)
              data.copy(next, offset)
              files.set(open.path, next)
              writesInFlight--
              stream.status(requestId, STATUS_CODE.OK)
            }, delay)
          })
          stream.on('READ', (requestId, handle, offset, length) => {
            const open = getHandle(handle)
            const file = open ? files.get(open.path) : undefined
            if (!file) return stream.status(requestId, STATUS_CODE.FAILURE)
            if (offset >= file.length) return stream.status(requestId, STATUS_CODE.EOF)
            const data = file.subarray(offset, Math.min(offset + length, file.length))
            const delay = 1 + ((Math.floor(offset / 32768) * 11) % 13)
            setTimeout(() => stream.data(requestId, data), delay)
          })
          stream.on('CLOSE', (requestId, handle) => {
            if (handle.length === 4) handles.delete(handle.readUInt32BE(0))
            stream.status(requestId, STATUS_CODE.OK)
          })
          stream.on('STAT', (requestId, path) => {
            const file = files.get(path)
            if (!file) return stream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
            stream.attrs(requestId, { size: file.length, mode: 0o100644, atime: 0, mtime: 0 })
          })
          stream.on('REMOVE', (requestId, path) => {
            if (!files.delete(path)) return stream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
            stream.status(requestId, STATUS_CODE.OK)
          })
          stream.on('RENAME', (requestId, oldPath, newPath) => {
            const file = files.get(oldPath)
            if (!file) return stream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
            files.delete(oldPath)
            files.set(newPath, file)
            stream.status(requestId, STATUS_CODE.OK)
          })
          stream.on('FSETSTAT', (requestId, handle, attrs) => {
            const open = getHandle(handle)
            const previous = open ? files.get(open.path) : undefined
            if (!open || !previous || typeof attrs.size !== 'number') {
              return stream.status(requestId, STATUS_CODE.FAILURE)
            }
            const resized = Buffer.alloc(attrs.size)
            previous.copy(resized, 0, 0, Math.min(previous.length, resized.length))
            files.set(open.path, resized)
            stream.status(requestId, STATUS_CODE.OK)
          })
        })
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
    client.connect({ host: '127.0.0.1', port: address.port, username: 'test', password: 'test' })
  })
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)))
  const workDir = await fsp.mkdtemp(join(tmpdir(), 'litessh-transfer-'))
  try {
    const source = join(workDir, 'source.bin')
    const download = join(workDir, 'download.bin')
    const resumedDownload = join(workDir, 'resumed.bin')
    const payload = Buffer.allocUnsafe(8 * 1024 * 1024 + 123)
    for (let index = 0; index < payload.length; index++) payload[index] = (index * 31 + 17) & 255
    await fsp.writeFile(source, payload)

    let uploaded = 0
    await transferPutFile(sftp, source, '/upload.bin', payload.length, (done) => { uploaded = done }, () => false, false)
    assert.equal(uploaded, payload.length)
    assert.equal(digest(files.get('/upload.bin')!), digest(payload))
    assert(!files.has('/.upload.bin.litessh-part'))

    let downloaded = 0
    await transferGetFile(sftp, '/upload.bin', download, payload.length, (done) => { downloaded = done }, () => false, false)
    assert.equal(downloaded, payload.length)
    assert.equal(digest(await fsp.readFile(download)), digest(payload))

    const resumeOffset = 1024 * 1024 + 19
    files.set('/.resume.bin.litessh-part', payload.subarray(0, resumeOffset))
    await transferPutFile(sftp, source, '/resume.bin', payload.length, () => undefined, () => false, true)
    assert.equal(digest(files.get('/resume.bin')!), digest(payload))

    await fsp.writeFile(join(workDir, '.resumed.bin.litessh-part'), payload.subarray(0, resumeOffset))
    await transferGetFile(sftp, '/upload.bin', resumedDownload, payload.length, () => undefined, () => false, true)
    assert.equal(digest(await fsp.readFile(resumedDownload)), digest(payload))

    assert(maxWritesInFlight > 1, `expected pipelining, got ${maxWritesInFlight}`)
    assert(maxWritesInFlight <= 16, `window exceeded: ${maxWritesInFlight}`)
    process.stdout.write(`TRANSFER_SMOKE_OK bytes=${payload.length} maxWrites=${maxWritesInFlight}\n`)
  } finally {
    sftp.end()
    client.end()
    server.close()
    await fsp.rm(workDir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
