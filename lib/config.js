/**
 * Configuración local del puente.
 *
 * Todo vive en `~/.qwen-connect-qoder` (override con `QWEN_QODER_HOME`):
 * `bridge.json` con el puerto y el bearer que comparte con Qwen Code, y
 * `catalog.json` con la última copia buena del catálogo.
 *
 * @module qwen-connect-qoder/config
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Puerto por defecto del puente. */
export const DEFAULT_PORT = 17872
/** Nombre de la variable que Qwen Code usa como `envKey`. */
export const ENV_KEY = 'QWEN_QODER_API_KEY'

/** Directorio de datos del puente. */
export function homeDir(env = process.env) {
  const override = env.QWEN_QODER_HOME
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), '.qwen-connect-qoder')
}

/** Ruta del fichero de configuración. */
export function configPath(env = process.env) {
  return join(homeDir(env), 'bridge.json')
}

/** Ruta del catálogo cacheado. */
export function catalogPath(env = process.env) {
  return join(homeDir(env), 'catalog.json')
}

/**
 * Lee la configuración, o `undefined` si aún no existe.
 *
 * @returns {{ version: number, port: number, token: string, regions: string[] }|undefined}
 */
export function readConfig(env = process.env) {
  const path = configPath(env)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed?.token !== 'string' || parsed.token.length === 0) return undefined
    return {
      version: 1,
      port: Number.isInteger(parsed.port) ? parsed.port : DEFAULT_PORT,
      token: parsed.token,
      regions: Array.isArray(parsed.regions) ? parsed.regions : ['qoder'],
    }
  } catch {
    return undefined
  }
}

/**
 * Crea la configuración si falta y devuelve la vigente.
 *
 * El bearer es aleatorio por instalación: nada fuera de esta máquina puede
 * usar el puente como proxy, y el token real de Qoder nunca sale de él.
 *
 * @param {{ port?: number, regions?: string[], env?: NodeJS.ProcessEnv, rotateToken?: boolean }} [options]
 */
export function ensureConfig(options = {}) {
  const env = options.env ?? process.env
  const dir = homeDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const existing = readConfig(env)
  const port = options.port ?? (Number(env.QWEN_QODER_PORT) || existing?.port || DEFAULT_PORT)
  const regions = options.regions ?? existing?.regions ?? ['qoder']
  const token = options.rotateToken === true || existing === undefined
    ? randomBytes(32).toString('base64url')
    : existing.token
  const config = { version: 1, port, token, regions }
  const path = configPath(env)
  const body = `${JSON.stringify(config, null, 2)}\n`
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (previous !== body) writePrivate(path, body)
  return config
}

/** Escribe un fichero con permisos 0600 de forma atómica. */
export function writePrivate(path, body) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

/** Base URL que se declara a Qwen Code. */
export function baseUrlFor(port) {
  return `http://127.0.0.1:${port}/v1`
}
