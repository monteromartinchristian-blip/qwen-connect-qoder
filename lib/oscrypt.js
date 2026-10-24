/**
 * OSCrypt: el sobre con el que Electron guarda secretos en disco.
 *
 * Formato del blob: `v10` + cuerpo. En Windows el cuerpo es
 * `nonce(12) || ciphertext || tag(16)` con AES-256-GCM y la clave va envuelta
 * en DPAPI. En macOS el cuerpo es texto cifrado con AES-128-CBC y relleno
 * PKCS#7, la clave se deriva con PBKDF2-HMAC-SHA1 (sal `saltysalt`, 1003
 * iteraciones) a partir de la contraseña que Electron guarda en el Llavero, y
 * el IV son 16 espacios. En Linux Chromium usa la misma CBC con la contraseña
 * de libsecret o, si no hay ninguna, la constante `peanuts`.
 *
 * @module qwen-connect-qoder/oscrypt
 */
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'

/** Sal fija que usa Chromium en macOS y Linux. */
export const CHROMIUM_SALT = 'saltysalt'
/** Iteraciones de la derivación en macOS. */
export const MAC_ITERATIONS = 1003
/** Longitud de clave en macOS/Linux (AES-128). */
export const MAC_KEY_BYTES = 16
/** Contraseña de reserva de Chromium en Linux cuando no hay llavero. */
export const LINUX_FALLBACK_PASSWORD = 'peanuts'

/**
 * Deriva la clave AES-128-CBC de macOS a partir de la contraseña del Llavero.
 *
 * @param {string} password contraseña del elemento «<App> Safe Storage».
 * @returns {Buffer} 16 bytes.
 */
export function deriveMacKey(password) {
  return pbkdf2Sync(password, CHROMIUM_SALT, MAC_ITERATIONS, MAC_KEY_BYTES, 'sha1')
}

/**
 * Deriva la clave AES-128-CBC de Linux.
 *
 * @param {string} [password] contraseña de libsecret, o `peanuts`.
 * @param {number} [iterations] 1 para la constante de Chromium.
 * @returns {Buffer} 16 bytes.
 */
export function deriveLinuxKey(password = LINUX_FALLBACK_PASSWORD, iterations = 1) {
  return pbkdf2Sync(password, CHROMIUM_SALT, iterations, MAC_KEY_BYTES, 'sha1')
}

/**
 * Descifra un blob OSCrypt.
 *
 * @param {Buffer} blob bytes tal cual están en disco, con el prefijo `v10`.
 * @param {Buffer} key clave de 16 (CBC) o 32 (GCM) bytes.
 * @param {{ mode?: 'gcm'|'cbc', iv?: Buffer }} [options]
 * @returns {string|undefined} el texto plano, o `undefined` si no autentica.
 */
export function decryptOscrypt(blob, key, options = {}) {
  if (!Buffer.isBuffer(blob)) return undefined
  const mode = options.mode ?? (key.length === 32 ? 'gcm' : 'cbc')
  if (blob.subarray(0, 3).toString('latin1') !== 'v10') return undefined
  const body = blob.subarray(3)
  try {
    if (mode === 'gcm') {
      if (body.length < 12 + 16) return undefined
      const nonce = body.subarray(0, 12)
      const tag = body.subarray(body.length - 16)
      const ciphertext = body.subarray(12, body.length - 16)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    }
    // CBC: el IV es una constante en Chromium (16 espacios). `final()` valida
    // además el relleno PKCS#7, así que una clave equivocada no devuelve basura.
    const iv = options.iv ?? Buffer.alloc(16, 0x20)
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Descifra un blob probando, en orden, los esquemas conocidos.
 *
 * Se usa cuando el origen no dice con qué plataforma se escribió el blob (un
 * backup restaurado, una migración). Devuelve también qué esquema funcionó.
 *
 * @param {Buffer} blob
 * @param {{ gcmKey?: Buffer, cbcKey?: Buffer }} keys
 * @returns {{ text: string, scheme: 'gcm'|'cbc' }|undefined}
 */
export function decryptOscryptAny(blob, keys) {
  if (keys.gcmKey !== undefined) {
    const text = decryptOscrypt(blob, keys.gcmKey, { mode: 'gcm' })
    if (text !== undefined) return { text, scheme: 'gcm' }
  }
  if (keys.cbcKey !== undefined) {
    const text = decryptOscrypt(blob, keys.cbcKey, { mode: 'cbc' })
    if (text !== undefined) return { text, scheme: 'cbc' }
  }
  return undefined
}
