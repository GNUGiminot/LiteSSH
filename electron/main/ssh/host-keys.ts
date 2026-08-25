import { createHash } from 'crypto'

/** SSH public keys are wire-encoded as: uint32 length + algorithm name + key material. */
export function parseKeyType(key: Buffer): string {
  try {
    const len = key.readUInt32BE(0)
    if (len > 0 && len < 64) return key.subarray(4, 4 + len).toString('ascii')
  } catch {
    /* fall through */
  }
  return 'unknown'
}

/** OpenSSH-style SHA256 fingerprint: base64 without trailing '='. */
export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}
