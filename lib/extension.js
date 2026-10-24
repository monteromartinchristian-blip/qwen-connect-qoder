/**
 * Instalación de la extensión de Qwen Code.
 *
 * Qwen Code descubre las extensiones en `~/.qwen/extensions/<name>/`. La
 * extensión es autosuficiente: su servidor MCP habla con el puente por HTTP y no
 * importa código del repositorio, así que copiarla (en vez de enlazarla) deja la
 * app funcionando aunque el repositorio se mueva.
 *
 * @module qwen-connect-qoder/extension
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Nombre con el que se registra la extensión. */
export const EXTENSION_NAME = 'qwen-connect-qoder'

/** Raíz de extensiones del perfil de Qwen Code. */
export function extensionsRoot(env = process.env) {
  return join(env.QWEN_HOME ?? join(homedir(), '.qwen'), 'extensions')
}

/** Directorio destino de la extensión. */
export function extensionTarget(env = process.env) {
  return join(extensionsRoot(env), EXTENSION_NAME)
}

/** Directorio de origen dentro del repositorio. */
export function sourceExtensionDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'extension')
}

/** ¿Está instalada? */
export function extensionInstalled(env = process.env) {
  return existsSync(join(extensionTarget(env), 'qwen-extension.json'))
}

/**
 * Copia la extensión al perfil de Qwen Code.
 *
 * @param {{ env?: NodeJS.ProcessEnv, source?: string }} [options]
 * @returns {{ path: string, files: number }}
 */
export function installExtension(options = {}) {
  const env = options.env ?? process.env
  const source = options.source ?? sourceExtensionDir()
  const target = extensionTarget(env)
  if (!existsSync(join(source, 'qwen-extension.json'))) {
    throw new Error(`no encuentro la extensión en ${source}`)
  }
  mkdirSync(extensionsRoot(env), { recursive: true, mode: 0o700 })
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  chmodSync(join(target, 'run-mcp.sh'), 0o755)
  return { path: target, files: countFiles(target) }
}

/** Retira la extensión. */
export function removeExtension(options = {}) {
  const env = options.env ?? process.env
  const target = extensionTarget(env)
  const existed = existsSync(target)
  rmSync(target, { recursive: true, force: true })
  return { path: target, removed: existed }
}

/** Cuenta ficheros, solo para el resumen de instalación. */
function countFiles(dir) {
  let total = 0
  const walk = (current) => {
    for (const entry of readdirSafe(current)) {
      if (entry.isDirectory()) walk(join(current, entry.name))
      else total += 1
    }
  }
  walk(dir)
  return total
}

/** `readdirSync` con tipos, tolerante a fallos. */
function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
