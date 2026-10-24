/**
 * Obtención de la credencial de Qoder.
 *
 * La app de escritorio guarda la sesión en un sobre OSCrypt
 * (`<userData>/auth.v1.dat` desde 0.3.x, o una fila de `state.vscdb` en las
 * versiones antiguas). La clave del sobre la protege el llavero del sistema:
 * DPAPI en Windows, Llavero en macOS, libsecret en Linux.
 *
 * Nada de este módulo escribe en los ficheros de Qoder: el almacén se abre en
 * solo lectura y la contraseña del llavero solo se usa en memoria.
 *
 * @module qwen-connect-qoder/credentials
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { promisify } from 'node:util'
import { createDecipheriv } from 'node:crypto'
import {
  decryptOscrypt,
  deriveLinuxKey,
  deriveMacKey,
} from './oscrypt.js'

const execFileAsync = promisify(execFile)

/** Claves del almacén VS Code antiguo. */
const USER_INFO_KEY = 'secret://aicoding.auth.userInfo'

/** Ruta absoluta del binario del Llavero: `security` por PATH es secuestrable. */
const SECURITY_BIN = '/usr/bin/security'
/** Ruta absoluta de `secret-tool` en Linux. */
const SECRET_TOOL_BIN = '/usr/bin/secret-tool'
/** Tiempo máximo de una consulta al llavero. */
const KEYCHAIN_TIMEOUT_MS = 10000

/** Raíz de datos de aplicación por plataforma (Electron `userData`). */
export function appDataRootFor(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return env.APPDATA ?? ''
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  const xdg = env.XDG_CONFIG_HOME
  return typeof xdg === 'string' && xdg.length > 0 ? xdg : join(home, '.config')
}

/** Identidad barata de un fichero, para invalidar cachés cuando cambia. */
function fileIdentity(path) {
  try {
    const stats = statSync(path)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return undefined
  }
}

/** Ejecuta un binario y devuelve su stdout sin el salto final. */
async function run(bin, args, options = {}) {
  const { stdout } = await execFileAsync(bin, args, {
    timeout: KEYCHAIN_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    ...options,
  })
  return stdout.replace(/\r?\n$/, '')
}

/**
 * Contraseña de Electron en el Llavero de macOS.
 *
 * @param {{ service: string, account?: string }} candidate
 * @returns {Promise<string|undefined>}
 */
async function macKeychainPassword(candidate) {
  const args = ['find-generic-password', '-s', candidate.service]
  if (typeof candidate.account === 'string' && candidate.account.length > 0) {
    args.push('-a', candidate.account)
  }
  args.push('-w')
  try {
    const password = await run(SECURITY_BIN, args)
    return password.length > 0 ? password : undefined
  } catch {
    return undefined
  }
}

/**
 * Contraseña de libsecret en Linux.
 *
 * @param {string} appName
 * @returns {Promise<string|undefined>}
 */
async function linuxSecretPassword(appName) {
  for (const attributes of [['application', appName], ['application', appName.toLowerCase()]]) {
    try {
      const password = await run(SECRET_TOOL_BIN, ['lookup', ...attributes])
      if (password.length > 0) return password
    } catch {
      // Sin libsecret, sin sesión D-Bus o sin entrada: se prueba la siguiente.
    }
  }
  return undefined
}

/**
 * Clave OSCrypt de un directorio de aplicación.
 *
 * @param {string} appDir directorio `userData` de la app.
 * @param {object} region descriptor de la región.
 * @param {{ platform?: NodeJS.Platform, log?: (msg: string) => void }} [options]
 * @returns {Promise<{ key: Buffer, scheme: 'gcm'|'cbc', source: string }|undefined>}
 */
export async function oscryptKeyFor(appDir, region, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const key = await dpapiKeyFor(appDir)
    return key === undefined ? undefined : { key, scheme: 'gcm', source: 'dpapi' }
  }
  if (platform === 'darwin') {
    for (const candidate of region.keychain ?? []) {
      const password = await macKeychainPassword(candidate)
      if (password === undefined) continue
      return { key: deriveMacKey(password), scheme: 'cbc', source: `keychain:${candidate.service}` }
    }
    return undefined
  }
  for (const appName of [...(region.newAppNames ?? []), ...(region.appNames ?? [])]) {
    const password = await linuxSecretPassword(appName)
    if (password !== undefined) {
      return { key: deriveLinuxKey(password, 1), scheme: 'cbc', source: 'libsecret' }
    }
  }
  // Sin llavero, Chromium cae en la constante pública `peanuts`. No es un
  // secreto: cualquiera que lea el fichero puede descifrarlo, y por eso este
  // camino se marca como tal en el diagnóstico.
  return { key: deriveLinuxKey(), scheme: 'cbc', source: 'peanuts' }
}

/**
 * Clave de 32 bytes envuelta en DPAPI (Windows).
 *
 * @param {string} appDir
 * @returns {Promise<Buffer|undefined>}
 */
async function dpapiKeyFor(appDir) {
  const statePath = join(appDir, 'Local State')
  if (!existsSync(statePath)) return undefined
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const encoded = state?.os_crypt?.encrypted_key
    if (typeof encoded !== 'string' || encoded.length === 0) return undefined
    const raw = Buffer.from(encoded, 'base64')
    if (raw.length <= 5) return undefined
    const { key } = await dpapiUnprotect(raw.subarray(5))
    return key
  } catch {
    return undefined
  }
}

const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QoderDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct B { public int cbData; public IntPtr pbData; }
  [DllImport("Crypt32.dll", SetLastError=true)]
  static extern bool CryptUnprotectData(ref B i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref B o);
  [DllImport("Kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  public static byte[] U(byte[] data) {
    B i = new B(); i.cbData = data.Length; i.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, i.pbData, data.Length);
    B o = new B();
    try {
      if (!CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o))
        throw new Exception("DPAPI error " + Marshal.GetLastWin32Error());
      byte[] r = new byte[o.cbData]; Marshal.Copy(o.pbData, r, 0, o.cbData); return r;
    } finally { Marshal.FreeHGlobal(i.pbData); if (o.pbData != IntPtr.Zero) LocalFree(o.pbData); }
  }
}
'@
$in = [Convert]::FromBase64String($env:QODER_CIPHER_B64)
$out = [QoderDpapi]::U($in)
[Console]::Out.Write([Convert]::ToBase64String($out))
`

/**
 * Desenvuelve un blob DPAPI delegando en PowerShell.
 *
 * Node no trae binding de DPAPI. El texto cifrado viaja por variable de
 * entorno y el resultado vuelve por stdout; no se escribe ningún secreto a
 * disco.
 *
 * @param {Buffer} cipher
 * @returns {Promise<{ key: Buffer }>}
 */
async function dpapiUnprotect(cipher) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const env = {}
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'PATH', 'USERPROFILE']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  env.QODER_CIPHER_B64 = cipher.toString('base64')
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT],
    { timeout: 30000, windowsHide: true, env },
  )
  const key = Buffer.from(stdout.trim(), 'base64')
  if (key.length !== 32) throw new Error(`DPAPI devolvió ${key.length} bytes, se esperaban 32`)
  return { key }
}

/** Id de máquina al que Qoder ata la sesión. */
function machineIdFor(appDir, fallback) {
  for (const name of ['auth.machine-id', 'machineid', 'machineId']) {
    const path = join(appDir, name)
    if (!existsSync(path)) continue
    const value = readFileSync(path, 'utf8').trim()
    if (value.length > 0) return value
  }
  return fallback
}

/**
 * Lee `auth.v1.dat` y devuelve el registro de credencial.
 *
 * @param {object} region
 * @param {string} appDir
 * @param {{ key: Buffer, scheme: 'gcm'|'cbc' }} oscrypt
 * @returns {object|undefined}
 */
export function readNewCredential(region, appDir, oscrypt) {
  const file = join(appDir, 'auth.v1.dat')
  if (!existsSync(file)) return undefined
  const plain = decryptOscrypt(readFileSync(file), oscrypt.key, { mode: oscrypt.scheme })
  if (plain === undefined) return undefined
  let session
  try {
    session = JSON.parse(plain)
  } catch {
    return undefined
  }
  if (session === null || typeof session !== 'object') return undefined
  if (typeof session.token !== 'string' || session.token.length === 0) return undefined
  const user = session.user !== null && typeof session.user === 'object' ? session.user : {}
  const userID = typeof user.id === 'string' ? user.id : ''
  if (userID.length === 0) return undefined
  const expiresAt = Date.parse(session.expiresAt)
  const refreshTokenExpiresAt = Date.parse(session.refreshTokenExpiresAt)
  return {
    region: region.id,
    appDir,
    appName: basename(appDir),
    userID,
    name: typeof user.name === 'string' ? user.name : '',
    email: typeof user.email === 'string' ? user.email : '',
    token: session.token,
    refreshToken: typeof session.refreshToken === 'string' ? session.refreshToken : '',
    refreshTokenExpiresAt: Number.isFinite(refreshTokenExpiresAt) ? refreshTokenExpiresAt : 0,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    expired: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt <= Date.now() : false,
    machineID: machineIdFor(appDir, `qwen-connect-qoder-${region.id}`),
    source: 'app',
  }
}

/**
 * Lee el almacén VS Code antiguo (`state.vscdb`).
 *
 * `node:sqlite` es experimental en Node 22 y estable en 24+; si el módulo no
 * está disponible esta ruta simplemente no se intenta.
 *
 * @param {object} region
 * @param {string} appDir
 * @param {{ key: Buffer, scheme: 'gcm'|'cbc' }} oscrypt
 * @returns {Promise<object|undefined>}
 */
async function readLegacyCredential(region, appDir, oscrypt) {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return undefined
  }
  for (const fileName of ['state.vscdb', 'state.vscdb.backup']) {
    const dbPath = join(appDir, 'User', 'globalStorage', fileName)
    if (!existsSync(dbPath)) continue
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(USER_INFO_KEY)
      if (row === undefined || row.value === null || row.value === undefined) continue
      const raw = row.value instanceof Uint8Array ? Buffer.from(row.value) : Buffer.from(String(row.value))
      let blob = raw
      const text = raw.toString('utf8')
      if (text.startsWith('{') && text.includes('"type":"Buffer"')) {
        try {
          blob = Buffer.from(JSON.parse(text).data)
        } catch {
          continue
        }
      }
      const plain = decryptOscrypt(blob, oscrypt.key, { mode: oscrypt.scheme })
      if (plain === undefined) continue
      const userInfo = JSON.parse(plain)
      if (typeof userInfo?.token !== 'string' || userInfo.token.length === 0) continue
      if (typeof userInfo.id !== 'string' || userInfo.id.length === 0) continue
      const expiresAt = Number(userInfo.expireTime)
      return {
        region: region.id,
        appDir,
        appName: basename(appDir),
        userID: userInfo.id,
        name: typeof userInfo.name === 'string' ? userInfo.name : '',
        email: typeof userInfo.email === 'string' ? userInfo.email : '',
        token: userInfo.token,
        refreshToken: typeof userInfo.refreshToken === 'string' ? userInfo.refreshToken : '',
        refreshTokenExpiresAt: Number(userInfo.refreshTokenExpireTime) || 0,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
        expired: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt <= Date.now() : false,
        machineID: machineIdFor(appDir, `qwen-connect-qoder-${region.id}`),
        source: 'app',
      }
    } catch {
      // Fila ilegible o base de datos bloqueada: se prueba la copia de respaldo.
    } finally {
      try {
        db?.close()
      } catch {
        // Ya cerrada.
      }
    }
  }
  return undefined
}

/** Credencial a partir de un PAT en el entorno (vía documentada por Qoder). */
export function loadEnvCredential(region, env = process.env) {
  for (const name of region.patEnvNames) {
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        region: region.id,
        appDir: '',
        appName: name,
        userID: '',
        name: '',
        email: '',
        token: value.trim(),
        refreshToken: '',
        refreshTokenExpiresAt: 0,
        expiresAt: 0,
        expired: false,
        machineID: `qwen-connect-qoder-${region.id}`,
        source: 'env-pat',
      }
    }
  }
  return undefined
}

/**
 * Busca la credencial de una región en todos los diseños conocidos.
 *
 * @param {object} region
 * @param {string} appDataRoot
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ credential?: object, status: 'ok'|'expired'|'needs-app'|'signed-out', reason?: string }>}
 */
export async function loadCredential(region, appDataRoot, options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  let sawApp = false
  let lastReason

  for (const appName of [...(region.newAppNames ?? []), ...(region.appNames ?? [])]) {
    const appDir = join(appDataRoot, appName)
    if (!existsSync(appDir)) continue
    sawApp = true
    const oscrypt = await oscryptKeyFor(appDir, region, { platform })
    if (oscrypt === undefined) {
      lastReason = lastReason ?? `no se pudo abrir la clave del llavero para ${appName}`
      continue
    }
    const credential = readNewCredential(region, appDir, oscrypt)
    if (credential !== undefined) {
      return { credential, status: credential.expired ? 'expired' : 'ok' }
    }
    const legacy = await readLegacyCredential(region, appDir, oscrypt)
    if (legacy !== undefined) {
      return { credential: legacy, status: legacy.expired ? 'expired' : 'ok' }
    }
    lastReason = lastReason ?? `la sesión de ${appName} no se pudo descifrar`
  }

  const envCredential = loadEnvCredential(region, env)
  if (envCredential !== undefined) return { credential: envCredential, status: 'ok' }

  if (sawApp) return { status: 'needs-app', reason: lastReason ?? 'la app está instalada pero no se pudo leer la sesión' }
  return { status: 'signed-out', reason: 'no hay app de Qoder instalada para esta región' }
}

/**
 * Caché de credenciales con relectura.
 *
 * El token lo refresca la app en su propio fichero; este caché solo evita
 * descifrar en cada petición y se invalida cuando el fichero cambia o cuando
 * el gateway rechaza la sesión.
 */
export class CredentialStore {
  /**
   * @param {object} options
   * @param {object[]} options.regions regiones a considerar.
   * @param {string} [options.appDataRoot] raíz de datos de aplicación.
   * @param {NodeJS.Platform} [options.platform]
   * @param {NodeJS.ProcessEnv} [options.env]
   */
  constructor(options = {}) {
    this.regions = options.regions ?? []
    this.appDataRoot = options.appDataRoot ?? appDataRootFor()
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.entries = new Map()
  }

  /** Identidad del fichero de sesión de una región, si existe. */
  identityFor(region) {
    for (const appName of [...(region.newAppNames ?? []), ...(region.appNames ?? [])]) {
      const appDir = join(this.appDataRoot, appName)
      for (const file of ['auth.v1.dat', join('User', 'globalStorage', 'state.vscdb')]) {
        const path = join(appDir, file)
        if (!existsSync(path)) continue
        return { identity: fileIdentity(path), appDir }
      }
    }
    return { identity: undefined, appDir: undefined }
  }

  /**
   * Credencial de una región, leyendo de disco solo cuando hace falta.
   *
   * @param {object} region
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<object|undefined>}
   */
  async get(region, options = {}) {
    const current = this.entries.get(region.id)
    const { identity } = this.identityFor(region)
    if (options.force !== true && current !== undefined && current.identity === identity) {
      return current.credential
    }
    const result = await loadCredential(region, this.appDataRoot, {
      platform: this.platform,
      env: this.env,
    })
    if (result.credential !== undefined) {
      this.entries.set(region.id, { identity, credential: result.credential })
      return result.credential
    }
    this.entries.delete(region.id)
    return undefined
  }

  /** Descarta la credencial cacheada (tras un rechazo del gateway). */
  invalidate(regionId) {
    this.entries.delete(regionId)
  }

  /** Estado legible de cada región, sin material de credencial. */
  async describe() {
    const rows = []
    for (const region of this.regions) {
      const result = await loadCredential(region, this.appDataRoot, {
        platform: this.platform,
        env: this.env,
      })
      const credential = result.credential
      rows.push({
        region: region.id,
        displayName: region.displayName,
        status: result.status,
        reason: result.reason,
        source: credential?.source,
        name: credential?.name,
        email: credential?.email,
        expiresAt: credential?.expiresAt,
        appName: credential?.appName,
      })
    }
    return rows
  }
}
