/**
 * Ensamblaje del puente en la configuración de Qwen Code.
 *
 * Qwen Code descubre los modelos en `~/.qwen/settings.json` →
 * `modelProviders.openai[]`. Este módulo añade, actualiza y retira las entradas
 * del puente sin tocar nada más: conserva claves desconocidas, otros
 * proveedores y el orden existente, y solo hace copia de seguridad cuando el
 * contenido cambia de verdad.
 *
 * @module qwen-connect-qoder/qwen-settings
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { ENV_KEY } from './config.js'
import { REGION_PREFIX } from './catalog.js'

/** Niveles de esfuerzo que Qwen Code acepta, de menor a mayor. */
const EFFORT_RANK = ['low', 'medium', 'high', 'xhigh', 'max']
/** Nivel por defecto cuando el modelo ofrece `low`. */
const PREFERRED_EFFORT = 'low'
/** Timeout de una petición completa (la cola de Qoder puede tardar). */
const REQUEST_TIMEOUT_MS = 600000
/** Timeout de inactividad del stream (la cola puede callar un rato). */
const STREAM_IDLE_TIMEOUT_MS = 600000

/** Ruta por defecto de la configuración de Qwen Code. */
export function qwenSettingsPath(env = process.env) {
  return join(env.QWEN_HOME ?? join(homedir(), '.qwen'), 'settings.json')
}

/** Lee un JSON, o `undefined` si no existe o no se puede parsear. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Nivel de esfuerzo por defecto de un modelo.
 *
 * @param {string[]} efforts
 * @returns {string|undefined}
 */
export function defaultEffortFor(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  if (efforts.includes(PREFERRED_EFFORT)) return PREFERRED_EFFORT
  return EFFORT_RANK.find((level) => efforts.includes(level)) ?? efforts[0]
}

/**
 * Construye la entrada `ModelConfig` de un modelo del catálogo.
 *
 * @param {object} model entrada del catálogo.
 * @param {{ baseUrl: string, envKey?: string }} options
 * @returns {object}
 */
export function modelEntryFor(model, options) {
  const envKey = options.envKey ?? ENV_KEY
  const capabilities = {}
  if (model.vision === true) capabilities.vision = true
  if (model.isReasoning === true && Array.isArray(model.effortLevels) && model.effortLevels.length > 0) {
    const efforts = EFFORT_RANK.filter((level) => model.effortLevels.includes(level))
    const usable = efforts.length > 0 ? efforts : model.effortLevels
    capabilities.reasoning = {
      profile: 'openai-effort',
      efforts: usable,
      defaultEffort: defaultEffortFor(usable),
    }
  }
  const generationConfig = {
    timeout: REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    maxRetries: 1,
  }
  if (model.contextWindow > 0) generationConfig.contextWindowSize = model.contextWindow
  return {
    id: model.id,
    name: model.name,
    baseUrl: options.baseUrl,
    envKey,
    wireApi: 'chat-completions',
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    generationConfig,
  }
}

/** Prefijos de id que pertenecen a este puente. */
function ownPrefixes() {
  return Object.values(REGION_PREFIX)
}

/** ¿Esta entrada la puso el puente? */
export function isOwnEntry(entry, baseUrl) {
  if (entry === null || typeof entry !== 'object') return false
  if (typeof entry.id === 'string' && ownPrefixes().some((prefix) => entry.id.startsWith(`${prefix}/`))) return true
  return typeof baseUrl === 'string' && entry.baseUrl === baseUrl
}

/**
 * Mezcla las entradas del puente en un documento de ajustes.
 *
 * Es una función pura para poder probarla sin tocar el disco.
 *
 * @param {object} settings documento actual (se copia).
 * @param {object[]} models catálogo.
 * @param {{ baseUrl: string, envKey?: string, token: string }} options
 * @returns {{ settings: object, added: number, removed: number }}
 */
export function applyModels(settings, models, options) {
  const envKey = options.envKey ?? ENV_KEY
  const doc = settings === null || typeof settings !== 'object' ? {} : structuredClone(settings)
  doc.modelProviders = doc.modelProviders !== null && typeof doc.modelProviders === 'object' ? doc.modelProviders : {}
  const existing = Array.isArray(doc.modelProviders.openai) ? doc.modelProviders.openai : []
  const kept = existing.filter((entry) => !isOwnEntry(entry, options.baseUrl))
  const removed = existing.length - kept.length
  const added = models.map((model) => modelEntryFor(model, { baseUrl: options.baseUrl, envKey }))
  doc.modelProviders.openai = [...kept, ...added]
  doc.env = doc.env !== null && typeof doc.env === 'object' ? doc.env : {}
  doc.env[envKey] = options.token
  return { settings: doc, added: added.length, removed }
}

/**
 * Retira las entradas del puente y su clave de entorno.
 *
 * @param {object} settings
 * @param {{ baseUrl?: string }} [options]
 * @returns {{ settings: object, removed: number }}
 */
export function removeModels(settings, options = {}) {
  const doc = settings === null || typeof settings !== 'object' ? {} : structuredClone(settings)
  let removed = 0
  const providers = doc.modelProviders
  if (providers !== null && typeof providers === 'object' && Array.isArray(providers.openai)) {
    const kept = providers.openai.filter((entry) => !isOwnEntry(entry, options.baseUrl))
    removed = providers.openai.length - kept.length
    providers.openai = kept
  }
  if (doc.env !== null && typeof doc.env === 'object' && Object.hasOwn(doc.env, ENV_KEY)) {
    delete doc.env[ENV_KEY]
  }
  return { settings: doc, removed }
}

/**
 * Escribe los ajustes de forma atómica, con copia de seguridad si cambian.
 *
 * @param {string} path
 * @param {object} doc
 * @returns {{ changed: boolean, backup?: string }}
 */
export function writeSettings(path, doc) {
  const body = `${JSON.stringify(doc, null, 2)}\n`
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  if (previous === body) return { changed: false }
  mkdirSync(dirname(path), { recursive: true })
  let backup
  if (previous !== undefined) {
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(path, backup)
  }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  chmodSync(path, 0o600)
  return { changed: true, backup }
}

/**
 * Instala (o actualiza) los modelos del puente en Qwen Code.
 *
 * @param {{ path?: string, models: object[], baseUrl: string, token: string, env?: NodeJS.ProcessEnv }} options
 */
export function installIntoQwen(options) {
  const path = options.path ?? qwenSettingsPath(options.env)
  const current = readJson(path) ?? { $version: 4 }
  const { settings, added, removed } = applyModels(current, options.models, {
    baseUrl: options.baseUrl,
    token: options.token,
  })
  const write = writeSettings(path, settings)
  return { path, added, removed, ...write }
}

/**
 * Retira los modelos del puente de Qwen Code.
 *
 * @param {{ path?: string, baseUrl?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function uninstallFromQwen(options = {}) {
  const path = options.path ?? qwenSettingsPath(options.env)
  const current = readJson(path)
  if (current === undefined) return { path, removed: 0, changed: false }
  const { settings, removed } = removeModels(current, { baseUrl: options.baseUrl })
  const write = writeSettings(path, settings)
  return { path, removed, ...write }
}
