import { safeStorage } from 'electron'
import { scryptSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'crypto'

// Два режима хранения секретов:
//  - 'keychain' (по умолчанию): OS keychain через Electron safeStorage (DPAPI/Keychain/libsecret).
//  - 'master': секреты шифруются ключом, выведенным из мастер-пароля (scrypt) + AES-256-GCM.
//    Ключ живёт только в памяти, пока хранилище разблокировано; при блокировке — стирается.
// Префиксы в БД: 'enc:'/'raw:' — keychain; 'mk:' — мастер-пароль. Оба сосуществуют при миграции.

export type VaultMode = 'keychain' | 'master'

const VERIFIER_TOKEN = 'LITESSH_VAULT_OK'

let mode: VaultMode = 'keychain'
let salt: Buffer | null = null
let masterKey: Buffer | null = null // выведенный ключ; null = заблокировано

export class VaultLockedError extends Error {
  constructor() {
    super('VAULT_LOCKED')
  }
}

function deriveKey(password: string, s: Buffer): Buffer {
  return scryptSync(password, s, 32, { N: 16384, r: 8, p: 1 })
}

// ---- keychain ----

function keychainEncrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64')
  }
  return 'raw:' + Buffer.from(plain, 'utf8').toString('base64')
}

function keychainDecrypt(stored: string): string {
  if (stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  }
  return Buffer.from(stored.slice(4), 'base64').toString('utf8')
}

// ---- master (AES-256-GCM) ----

function masterEncryptWith(key: Buffer, plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return 'mk:' + Buffer.concat([iv, tag, ct]).toString('base64')
}

function masterDecryptWith(key: Buffer, stored: string): string {
  const buf = Buffer.from(stored.slice(3), 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// ---- публичное API ----

export interface VaultMeta {
  mode: VaultMode
  salt?: string
  verifier?: string
}

/** Инициализация из сохранённой метаинформации (при старте приложения). */
export function loadVaultMeta(meta: { mode: string; salt?: string; verifier?: string } | null): void {
  if (meta?.mode === 'master' && meta.salt) {
    mode = 'master'
    salt = Buffer.from(meta.salt, 'hex')
    masterKey = null // стартуем заблокированными
  } else {
    mode = 'keychain'
    salt = null
    masterKey = null
  }
}

export function getMode(): VaultMode {
  return mode
}

export function isLocked(): boolean {
  return mode === 'master' && masterKey === null
}

/** Шифрование секрета текущим режимом. Бросает VaultLockedError, если мастер-режим заблокирован. */
export function encryptSecret(plain: string): string {
  if (mode === 'master') {
    if (!masterKey) throw new VaultLockedError()
    return masterEncryptWith(masterKey, plain)
  }
  return keychainEncrypt(plain)
}

/** Расшифровка секрета по его префиксу (mk: — мастер; enc:/raw: — keychain). */
export function decryptSecret(stored: string): string {
  if (stored.startsWith('mk:')) {
    if (!masterKey) throw new VaultLockedError()
    return masterDecryptWith(masterKey, stored)
  }
  if (stored.startsWith('enc:') || stored.startsWith('raw:')) return keychainDecrypt(stored)
  return stored
}

/** Разблокировка мастер-паролем: проверяет по verifier и держит ключ в памяти. */
export function unlock(password: string, verifier: string): boolean {
  if (mode !== 'master' || !salt) return true
  const key = deriveKey(password, salt)
  try {
    const token = masterDecryptWith(key, verifier)
    if (Buffer.byteLength(token) === Buffer.byteLength(VERIFIER_TOKEN) &&
        timingSafeEqual(Buffer.from(token), Buffer.from(VERIFIER_TOKEN))) {
      masterKey = key
      return true
    }
  } catch {
    /* неверный пароль → GCM-ошибка */
  }
  return false
}

export function lock(): void {
  masterKey = null
}

/**
 * Готовит переход на мастер-пароль: генерирует соль/ключ/verifier, включает режим и разблокирует.
 * Возвращает мету для сохранения. Перешифровку существующих секретов делает вызывающий код.
 */
export function prepareMaster(password: string): VaultMeta {
  const s = randomBytes(16)
  const key = deriveKey(password, s)
  const verifier = masterEncryptWith(key, VERIFIER_TOKEN)
  salt = s
  masterKey = key
  mode = 'master'
  return { mode: 'master', salt: s.toString('hex'), verifier }
}

/** Возврат к keychain (после перешифровки секретов вызывающим кодом). */
export function disableMaster(): void {
  mode = 'keychain'
  salt = null
  masterKey = null
}

/** Разово перешифровать один хранимый секрет в текущий режим (для миграции). */
export function reencryptOne(stored: string | null): string | null {
  if (!stored) return stored
  return encryptSecret(decryptSecret(stored))
}

/** Перешифровать секрет обратно в keychain (используется при отключении мастер-пароля). */
export function toKeychain(stored: string | null): string | null {
  if (!stored) return stored
  return keychainEncrypt(decryptSecret(stored))
}
