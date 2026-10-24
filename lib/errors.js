/**
 * Lectura de los marcos de error de Qoder.
 *
 * Los códigos que llegan aquí significan cosas muy distintas y confundirlos
 * manda al usuario a mirar su cuenta por lo que en realidad es una cola:
 *
 * - **105 / TOKEN_EXPIRE** — la sesión ya no vale. Nada funcionará hasta que
 *   se vuelva a iniciar sesión en la app de Qoder.
 * - **10605** — la petición quedó en cola o limitada. El cuerpo trae
 *   `retryAfterSeconds` y `serviceAvailable`, así que es transitorio.
 * - **110** — el cupo diario de facturación está gastado. Se recupera, pero no
 *   esperando dentro de la sesión: se reinicia al cambiar el día, y el gateway
 *   lo acompaña de un `Retry-After` medido en HORAS. Tratarlo como cola produce
 *   una espera inútil de dos horas.
 * - **cambio de forma del protocolo** — no es un rechazo sino un sobre que este
 *   código ya no reconoce; se eleva aparte como `ProtocolShapeChangedError`.
 *
 * Las coincidencias exactas de código deciden primero; el marcador de cola solo
 * actúa como respaldo y solo cuando concurren al menos dos marcas, para que un
 * error de autenticación que lleve `retryAfterSeconds` no se lea como cola.
 */

/** Campos del descriptor de cola; dos cualesquiera marcan una cola. */
const QUEUE_MARKERS = ['"queueType"', '"retryAfterSeconds"', '"isQueued"', '"serviceAvailable"']

function queueMarkerCount(text) {
  let count = 0
  for (const marker of QUEUE_MARKERS) {
    if (text.includes(marker)) count += 1
  }
  return count
}

/**
 * Extrae `retryAfterSeconds` de un payload de cola, descendiendo por los
 * sobres anidados en cadenas JSON.
 *
 * @param {string} text
 * @returns {number} segundos, o 0 cuando no se puede leer.
 */
function queueSeconds(text) {
  let node = text
  for (let depth = 0; depth < 4; depth++) {
    let parsed
    try {
      parsed = JSON.parse(node)
    } catch {
      return 0
    }
    if (parsed === null || typeof parsed !== 'object') return 0
    const seconds = Number(parsed.retryAfterSeconds)
    if (Number.isFinite(seconds) && seconds > 0) return seconds
    if (typeof parsed.message !== 'string') return 0
    node = parsed.message
  }
  return 0
}

/**
 * Clasifica un error del gateway.
 *
 * @param {unknown} chunk marco desenvuelto, o `{ code, message }` sintético.
 * @param {string|number} code código efectivo.
 * @param {string} detail texto más específico encontrado.
 * @returns {{ kind: 'daily-limit'|'rate-limit'|'sign-in-expired'|'upstream', retryAfterSeconds?: number }}
 */
export function classifyUpstreamError(chunk, code, detail) {
  const text = String(detail ?? '')
  const normalized = String(code ?? '').replace(/^["']|["']$/g, '')
  // El cupo diario va ANTES que cualquier forma de cola: el gateway lo manda
  // con un `Retry-After` en horas y el respaldo de marcadores lo convertiría
  // en una espera de dos minutos que no arregla nada.
  if (normalized === '110' || /billing daily count|daily count exceeded|daily limit/i.test(text)) {
    return { kind: 'daily-limit', retryAfterSeconds: queueSeconds(text) }
  }
  if (normalized === '10605') {
    return { kind: 'rate-limit', retryAfterSeconds: queueSeconds(text) }
  }
  if (/Login expired|TOKEN_EXPIRE|token is not active/i.test(text) || normalized === '105') {
    return { kind: 'sign-in-expired' }
  }
  if (queueMarkerCount(text) >= 2) {
    return { kind: 'rate-limit', retryAfterSeconds: queueSeconds(text) }
  }
  return { kind: 'upstream' }
}

/**
 * ¿Este fallo significa que la credencial en caché quedó obsoleta?
 *
 * La app de Qoder es quien refresca el token en su propio almacén; cuando el
 * gateway lo rechaza, la sesión nueva ya está en disco y solo hace falta
 * volver a leerla. Sin esto la entrada vieja se queda cacheada y todo responde
 * 401 hasta reiniciar el proceso.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isStaleCredentialError(error) {
  if (error?.signInExpired === true) return true
  return /sign-in is no longer valid|sign-in-expired/i.test(String(error?.message ?? ''))
}

/**
 * Una respuesta que no es un fallo pero tampoco es el protocolo.
 *
 * Este proyecto clona un protocolo privado sin contrato ni versión: la forma
 * más probable de romperse no es un rechazo, sino un 200 con un sobre que ya
 * no se reconoce. Antes de esta clase, eso llegaba como «0 modelos»,
 * indistinguible de una cuenta que de verdad no tiene ninguno.
 */
export class ProtocolShapeChangedError extends Error {
  /** @param {string} detail qué se recibió, en términos accionables. */
  constructor(detail) {
    super(
      `Qoder respondió con una forma que este puente no reconoce (${detail}) — ` +
        'la API del cliente ha cambiado y el puente necesita actualizarse',
    )
    this.name = 'ProtocolShapeChangedError'
    this.protocolShapeChanged = true
    this.retryable = false
    this.detail = detail
  }
}

/** @param {unknown} error */
export function isProtocolShapeChangedError(error) {
  return error?.protocolShapeChanged === true
}
