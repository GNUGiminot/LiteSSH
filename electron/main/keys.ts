import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { utils } from 'ssh2'
import { insertKey, listKeys, getKeyRow, deleteKey, type KeyRow } from './db'
import { encryptSecret, decryptSecret } from './vault'
import type { KeyInfo } from '@shared/types'

function rowToInfo(r: KeyRow): KeyInfo {
  return { id: r.id, name: r.name, algo: r.algo, publicKey: r.public_key, createdAt: r.created_at }
}

export function keysList(): KeyInfo[] {
  return listKeys().map(rowToInfo)
}

export function keysDelete(id: string): void {
  deleteKey(id)
}

export function keyPrivatePem(id: string): string {
  const row = getKeyRow(id)
  if (!row) throw new Error('Ключ не найден')
  return decryptSecret(row.private_enc)
}

/** Публичная строка в формате authorized_keys из приватного PEM. */
function publicLineFromPem(pem: string, comment: string): { line: string; type: string } {
  const parsed = utils.parseKey(pem)
  if (parsed instanceof Error) throw parsed
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  const wire = key.getPublicSSH()
  return { line: `${key.type} ${Buffer.from(wire).toString('base64')} ${comment}`.trim(), type: key.type }
}

// ssh2 не разбирает PKCS8, поэтому: RSA → PKCS1 PEM, ECDSA → SEC1 PEM,
// Ed25519 → формат openssh-key-v1 (Node его не эмитит — собираем вручную).

function sshString(b: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(b.length)
  return Buffer.concat([len, b])
}

function ed25519ToOpenSSH(privateKey: KeyObject, publicKey: KeyObject, comment: string): string {
  // raw-байты — фиксированные хвосты DER-структур SPKI/PKCS8 для ed25519
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const pub = spki.subarray(spki.length - 32)
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
  const seed = pkcs8.subarray(pkcs8.length - 32)

  const keyType = Buffer.from('ssh-ed25519')
  const pubBlob = Buffer.concat([sshString(keyType), sshString(pub)])
  const check = randomBytes(4)
  let priv = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(Buffer.from(comment))
  ])
  const padLen = (8 - (priv.length % 8)) % 8
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1))])

  const one = Buffer.alloc(4)
  one.writeUInt32BE(1)
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    one,
    sshString(pubBlob),
    sshString(priv)
  ])
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`
}

export function keysGenerate(name: string, algo: string): KeyInfo {
  let pem: string
  if (algo === 'ed25519') {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    pem = ed25519ToOpenSSH(privateKey, publicKey, name.replace(/\s+/g, '-') || 'litessh')
  } else if (algo === 'rsa2048' || algo === 'rsa4096') {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: algo === 'rsa4096' ? 4096 : 2048
    })
    pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
  } else if (algo === 'ecdsa') {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    pem = privateKey.export({ type: 'sec1', format: 'pem' }) as string
  } else {
    throw new Error(`Неизвестный алгоритм: ${algo}`)
  }
  const comment = name.replace(/\s+/g, '-') || 'litessh'
  const { line } = publicLineFromPem(pem, comment)
  const row: KeyRow = {
    id: randomUUID(),
    name: name || comment,
    algo,
    public_key: line,
    private_enc: encryptSecret(pem),
    created_at: Date.now()
  }
  insertKey(row)
  return rowToInfo(row)
}

export function keysImport(filePath: string, name: string, passphrase?: string): KeyInfo {
  const raw = readFileSync(filePath, 'utf8')
  const parsed = utils.parseKey(raw, passphrase)
  if (parsed instanceof Error) {
    if (/passphrase|decrypt/i.test(parsed.message)) throw new Error('NEED_PASSPHRASE')
    throw new Error(`Не удалось разобрать ключ: ${parsed.message}`)
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  const wire = key.getPublicSSH()
  const line = `${key.type} ${Buffer.from(wire).toString('base64')} ${name.replace(/\s+/g, '-')}`
  // Храним исходное содержимое файла: его ssh2 гарантированно разберёт снова.
  // Если ключ защищён passphrase — он остаётся защищённым, passphrase задаётся в сессии.
  const row: KeyRow = {
    id: randomUUID(),
    name,
    algo: key.type,
    public_key: line,
    private_enc: encryptSecret(raw),
    created_at: Date.now()
  }
  insertKey(row)
  return rowToInfo(row)
}

export function keysExportPrivate(id: string, destPath: string): void {
  writeFileSync(destPath, keyPrivatePem(id), { encoding: 'utf8' })
}

/** Shell-скрипт добавления публичного ключа в authorized_keys с правильными правами. */
export function deployScript(publicLine: string): string {
  const line = publicLine.replace(/'/g, '')
  return [
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    `grep -qxF '${line}' ~/.ssh/authorized_keys || echo '${line}' >> ~/.ssh/authorized_keys`,
    'chmod 600 ~/.ssh/authorized_keys',
    'echo LITESSH_DEPLOY_OK'
  ].join(' && ')
}
