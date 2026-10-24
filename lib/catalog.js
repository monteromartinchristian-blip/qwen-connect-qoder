/**
 * Catálogo de modelos de Qoder, en la forma que consume Qwen Code.
 *
 * Cada modelo lleva un id con prefijo de región (`qoder/…`, `qoder-cn/…`) para
 * que las dos ediciones convivan en el selector sin colisionar con los
 * proveedores que el usuario ya tenga configurados, y para que el puente sepa
 * a qué cuenta y a qué clave del upstream corresponde cada petición.
 *
 * @module qwen-connect-qoder/catalog
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { catalogPath, homeDir, writePrivate } from './config.js'
import { fetchModels } from './upstream.js'

/** Prefijo de id por región. */
export const REGION_PREFIX = {
  qoder: 'qoder',
  'qoder-cn': 'qoder-cn',
}

/** Cuánto vale una copia del catálogo antes de refrescarla. */
export const CATALOG_TTL_MS = 10 * 60 * 1000

/**
 * Proyecta un modelo del upstream a la entrada que usa el puente.
 *
 * @param {object} model modelo normalizado de `fetchModels`.
 * @param {object} region
 * @returns {object}
 */
export function toCatalogEntry(model, region) {
  const prefix = REGION_PREFIX[region.id] ?? region.id
  // El catálogo publica las ventanas seleccionables (200K/400K/1M). Se anuncia
  // la mayor: la elección de ventana es del cliente (el cuerpo de la petición
  // no lleva campo de contexto), así que limitarla a 200K solo hace que Qwen
  // compacte antes de lo necesario.
  const windows = Array.isArray(model.contextOptions) ? model.contextOptions.filter((value) => value > 0) : []
  const contextWindow = windows.length > 0
    ? Math.max(...windows)
    : model.defaultContextWindow || model.maxInputTokens || 0
  return {
    id: `${prefix}/${model.key}`,
    upstreamKey: model.key,
    name: `${region.displayName} · ${model.name}`,
    region: region.id,
    displayName: model.name,
    isReasoning: model.isReasoning === true,
    alwaysThinking: model.alwaysThinking === true,
    effortLevels: model.effortLevels ?? [],
    contextWindow,
    contextOptions: model.contextOptions ?? [],
    vision: model.isVL === true,
    isDefault: model.isDefault === true,
    isFree: model.isFree === true,
  }
}

/**
 * Catálogo con caché en disco y refresco en vuelo compartido.
 */
export class Catalog {
  /**
   * @param {object} options
   * @param {object[]} options.regions
   * @param {import('./credentials.js').CredentialStore} options.credentials
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.regions = options.regions
    this.credentials = options.credentials
    this.env = options.env ?? process.env
    this.log = options.log ?? (() => {})
    this.models = []
    this.fetchedAt = 0
    this.lastError = undefined
    this.pending = undefined
    this.loadFromDisk()
  }

  /** Carga la última copia buena del disco, si la hay. */
  loadFromDisk() {
    const path = catalogPath(this.env)
    if (!existsSync(path)) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(parsed?.models)) return
      this.models = parsed.models
      this.fetchedAt = Number(parsed.fetchedAt) || 0
    } catch {
      // Catálogo corrupto: se reconstruye en el próximo refresco.
    }
  }

  /** Persiste el catálogo actual (0600 en un directorio 0700). */
  saveToDisk() {
    const path = catalogPath(this.env)
    const body = `${JSON.stringify({ version: 1, fetchedAt: this.fetchedAt, models: this.models }, null, 2)}\n`
    writePrivate(path, body)
  }

  /** @returns {object[]} modelos actuales. */
  list() {
    return this.models
  }

  /** @param {string} id */
  find(id) {
    const direct = this.models.find((model) => model.id === id)
    if (direct !== undefined) return direct
    // Un id sin prefijo (o con el prefijo de la otra región) se acepta como
    // comodidad para llamadores directos, no como ruta normal de Qwen.
    return this.models.find((model) => model.upstreamKey === id)
  }

  /** ¿Hace falta refrescar? */
  isStale(now = Date.now()) {
    return this.models.length === 0 || now - this.fetchedAt >= CATALOG_TTL_MS
  }

  /**
   * Refresca si toca; las llamadas concurrentes comparten la misma promesa.
   *
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{ models: object[], error?: string }>}
   */
  async refreshIfNeeded(options = {}) {
    if (this.pending !== undefined) return this.pending
    if (options.force !== true && !this.isStale()) {
      return { models: this.models }
    }
    this.pending = this.refresh().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  /**
   * Lee el catálogo de todas las regiones con credencial.
   *
   * Un fallo de una región no borra los modelos ya conocidos de esa región: se
   * conserva la última copia buena y se registra el error. Un catálogo vacío
   * sí es un resultado (la cuenta no tiene modelos) y se persiste como tal.
   */
  async refresh() {
    const collected = []
    const errors = []
    let anyCredential = false
    for (const region of this.regions) {
      let credential
      try {
        credential = await this.credentials.get(region)
      } catch (error) {
        errors.push(`${region.displayName}: ${error?.message ?? error}`)
        continue
      }
      if (credential === undefined) continue
      anyCredential = true
      try {
        const models = await fetchModels(region, credential)
        for (const model of models) collected.push(toCatalogEntry(model, region))
      } catch (error) {
        errors.push(`${region.displayName}: ${error?.message ?? error}`)
        // Conserva lo que ya se sabía de esta región.
        for (const model of this.models) {
          if (model.region === region.id) collected.push(model)
        }
      }
    }
    if (!anyCredential && errors.length === 0) {
      errors.push('ninguna región tiene credencial legible')
    }
    // Solo se sustituye si hubo al menos una lectura; si todo falló se mantiene
    // la copia anterior y se informa del error, en vez de vaciar el selector.
    if (collected.length > 0 || errors.length === 0) {
      this.models = collected
      this.fetchedAt = Date.now()
      try {
        this.saveToDisk()
      } catch (error) {
        this.log(`no se pudo guardar el catálogo: ${error?.message ?? error}`)
      }
    }
    this.lastError = errors.length > 0 ? errors.join(' · ') : undefined
    return { models: this.models, error: this.lastError }
  }
}

/** Ruta del catálogo, expuesta para el diagnóstico. */
export function catalogFile(env = process.env) {
  return join(homeDir(env), 'catalog.json')
}
