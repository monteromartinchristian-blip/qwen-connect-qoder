/**
 * Línea de estado con el saldo de Qoder.
 *
 * Qwen Code no permite que una extensión dibuje paneles: la superficie
 * persistente que sí existe es `ui.statusLine`, un comando local cuyo stdout se
 * pinta en el pie. Este módulo produce esa línea con una caché corta para no
 * martillear la ruta de facturación y para que el refresco sea instantáneo.
 *
 * No llama al modelo: solo hace un GET a la ruta de consumo.
 *
 * @module qwen-connect-qoder/statusline
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir, writePrivate } from './config.js'
import { fetchUsage } from './usage.js'

/** Cuánto vale una línea cacheada. */
export const STATUSLINE_TTL_MS = 60 * 1000

/** Ruta del caché de la línea. */
export function statusLineCachePath(env = process.env) {
  return join(homeDir(env), 'statusline.json')
}

/**
 * Texto de la línea a partir del consumo ya normalizado.
 *
 * @param {object|undefined} usage
 * @param {{ regionName?: string, now?: number }} [options]
 * @returns {string}
 */
export function formatStatusLine(usage, options = {}) {
  const name = options.regionName ?? 'Qoder'
  if (usage === undefined || usage === null) return `${name}: sin datos de consumo`
  const quota = usage.addOnQuota ?? usage.userQuota
  if (quota === undefined) return `${name}: sin cuota publicada`
  const percent = Math.round((Number(quota.percentage) || 0) * 100)
  const parts = [`${name} ${quota.remaining}/${quota.total}`]
  if (usage.isQuotaExceeded === true) parts.push('¡cuota agotada!')
  else parts.push(`${percent}% usado`)
  const checkin = usage.checkin
  if (checkin?.active === true) parts.push(checkin.todayCheckedIn ? 'check-in hecho' : 'check-in disponible')
  return parts.join(' · ')
}

/** Lee la última línea buena, si la hay. */
function readCache(env) {
  const path = statusLineCachePath(env)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed?.line !== 'string' || !Number.isFinite(parsed?.at)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Construye la línea, desde caché o leyendo el consumo.
 *
 * Un fallo de red no rompe el pie: se devuelve la última línea buena con un
 * sufijo `(?)`, y si no hay ninguna, un texto corto que dice qué pasa.
 *
 * @param {{ env?: NodeJS.ProcessEnv, credentials: import('./credentials.js').CredentialStore,
 *   regions: object[], now?: number }} options
 * @returns {Promise<{ line: string, cached: boolean }>}
 */
export async function buildStatusLine(options) {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const cached = readCache(env)
  if (cached !== undefined && now - cached.at < STATUSLINE_TTL_MS) {
    return { line: cached.line, cached: true }
  }
  const region = options.regions[0]
  if (region === undefined) return { line: 'Qoder: sin regiones configuradas', cached: false }
  try {
    const credential = await options.credentials.get(region)
    if (credential === undefined) return { line: `${region.displayName}: sin sesión`, cached: false }
    const usage = await fetchUsage(region, credential, AbortSignal.timeout(4000))
    const line = formatStatusLine(usage, { regionName: region.displayName })
    try {
      writePrivate(statusLineCachePath(env), `${JSON.stringify({ at: now, line })}\n`)
    } catch {
      // Un caché que no se puede escribir solo cuesta una lectura más.
    }
    return { line, cached: false }
  } catch (error) {
    if (cached !== undefined) return { line: `${cached.line} (?)`, cached: true }
    return { line: `${region.displayName}: sin conexión`, cached: false }
  }
}
