/**
 * Protocolo de Qoder.
 *
 * Qoder no es un endpoint compatible con OpenAI, así que hay que reproducir
 * tres mecanismos:
 *
 * 1. **Cabeceras firmadas COSY.** Cada petición al gateway lleva cabeceras
 *    `Cosy-*` y un `Authorization: Bearer COSY.<…>`. La firma es un MD5 sobre
 *    el payload en base64, la clave AES envuelta con RSA, el timestamp, el
 *    cuerpo y la ruta firmada.
 * 2. **Cuerpo con base64 permutado.** El flag `Encode=1` de la query significa
 *    que el JSON se codifica en base64, se traduce carácter a carácter por un
 *    alfabeto permutado y el resultado se rota por tercios.
 * 3. **SSE de doble sobre.** Cada frame `data:` es un objeto envolvente cuyo
 *    campo `body` es a su vez una cadena JSON con el chunk estilo OpenAI.
 *
 * Las constantes son hechos del protocolo recuperados del cliente; no son
 * configuración.
 *
 * @module qwen-connect-qoder/upstream
 */
import crypto from 'node:crypto'
import { classifyUpstreamError, ProtocolShapeChangedError } from './errors.js'

/** Clave pública con la que el gateway espera la clave AES de cada petición. */
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** Revisión del protocolo COSY que sirve el gateway. */
const COSY_VERSION = '1.1.38'
/** Tipo de cliente que espera el gateway para un cliente CLI. */
const CLIENT_TYPE = '5'
/** Tipo de máquina que espera el gateway. */
const MACHINE_TYPE = '5'
/** Política de datos de un cliente que no consiente. */
const DATA_POLICY = 'disagree'
/** Revisión del protocolo de login. */
const LOGIN_VERSION = 'v2'

/**
 * Presupuesto total de espera de una cola de Qoder, en milisegundos.
 *
 * El gateway responde `10605` con `retryAfterSeconds` y el cliente oficial
 * espera. Si esa espera se deja al cliente (Qwen Code reintenta con su propia
 * política, que ignora la pista), una cola larga agota los reintentos y el
 * turno falla tras varios minutos de reintentos en vano.
 *
 * 240 s sale de una medición en esta máquina: con una cuenta que admite un
 * turno a la vez, el siguiente turno esperó ~198 s antes de arrancar. Esperar
 * dentro del puente deja ese turno en un 200; devolver 503 lo convierte en
 * reintentos del cliente. El valor sigue por debajo del timeout de 600 s que
 * declara la configuración publicada en Qwen Code.
 */
export const QUEUE_WAIT_BUDGET_MS = 240000
/** Espera máxima de un solo tramo. */
export const QUEUE_WAIT_MAX_SLEEP_MS = 30000
/** Espera mínima cuando el gateway no da pista. */
export const QUEUE_WAIT_MIN_SLEEP_MS = 1000

/** Tiempo máximo de una tentativa antes de considerarla fallida. */
const ATTEMPT_TIMEOUT_MS = 60000

/** Alfabeto base64 permutado que se usa con `Encode=1`. */
export const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
/** Alfabeto base64 estándar, mapeado posicionalmente al anterior. */
export const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const ENCODE_TABLE = (() => {
  const table = new Uint8Array(256)
  for (let i = 0; i < table.length; i++) table[i] = i
  for (let i = 0; i < STD_ALPHABET.length; i++) {
    table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i)
  }
  table['='.charCodeAt(0)] = '$'.charCodeAt(0)
  return table
})()

/** Espera cancelable; se resuelve antes (sin lanzar) si la señal aborta. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, Math.max(0, ms))
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Cadena de sistema operativo que anuncia el cliente.
 *
 * @type {string}
 */
export const MACHINE_OS =
  process.platform === 'win32'
    ? process.arch === 'arm64'
      ? 'aarch64_windows'
      : 'x86_64_windows'
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'aarch64_darwin'
        : 'x86_64_darwin'
      : process.arch === 'arm64'
        ? 'aarch64_linux'
        : 'x86_64_linux'

/**
 * Codifica un cuerpo como exige `Encode=1`: base64, traducción por el
 * alfabeto permutado y rotación por tercios (el último tercio va primero).
 *
 * @param {Buffer|string} plaintext
 * @returns {Buffer}
 */
export function encodeBody(plaintext) {
  const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)
  const std = bytes.toString('base64')
  const n = std.length
  const third = Math.floor(n / 3)
  const out = Buffer.allocUnsafe(n)
  let dst = 0
  for (let i = n - third; i < n; i++) out[dst++] = ENCODE_TABLE[std.charCodeAt(i)]
  for (let i = third; i < n - third; i++) out[dst++] = ENCODE_TABLE[std.charCodeAt(i)]
  for (let i = 0; i < third; i++) out[dst++] = ENCODE_TABLE[std.charCodeAt(i)]
  return out
}

/** AES-128-CBC con la clave haciendo de IV, en base64. */
function aesEncryptCBCBase64(plaintext, keyString) {
  const key = Buffer.from(keyString)
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key)
  return cipher.update(plaintext, 'utf8', 'base64') + cipher.final('base64')
}

/**
 * Ruta que cubre la firma: la ruta de la petición sin el prefijo `/algo`, que
 * el gateway enruta antes de verificar.
 *
 * @param {string} url
 * @returns {string}
 */
export function signaturePath(url) {
  let path = new URL(url).pathname
  if (path.startsWith('/algo')) path = path.slice('/algo'.length)
  return path
}

/**
 * Cabeceras autenticadas de una petición al gateway.
 *
 * @param {Buffer} body bytes exactos que se enviarán (ya codificados).
 * @param {string} url URL absoluta.
 * @param {{ userID: string, token: string, name?: string, email?: string, machineID: string }} credential
 * @returns {Record<string, string>}
 */
export function authHeaders(body, url, credential) {
  const aesKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const infoB64 = aesEncryptCBCBase64(
    JSON.stringify({
      uid: credential.userID,
      security_oauth_token: credential.token,
      name: credential.name ?? '',
      aid: '',
      email: credential.email ?? '',
    }),
    aesKey,
  )
  const cosyKey = crypto
    .publicEncrypt(
      { key: QODER_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(aesKey),
    )
    .toString('base64')

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const payloadB64 = Buffer.from(
    JSON.stringify({
      version: 'v1',
      requestId: crypto.randomUUID(),
      info: infoB64,
      cosyVersion: COSY_VERSION,
      ideVersion: '',
    }),
  ).toString('base64')

  const path = signaturePath(url)
  const bodyBytes = body ?? Buffer.alloc(0)
  const sig = crypto
    .createHash('md5')
    .update(payloadB64)
    .update('\n')
    .update(cosyKey)
    .update('\n')
    .update(timestamp)
    .update('\n')
    .update(bodyBytes)
    .update('\n')
    .update(path)
    .digest('hex')

  const machineID = credential.machineID
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': credential.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': COSY_VERSION,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': MACHINE_TYPE,
    'Cosy-Machineos': MACHINE_OS,
    'Cosy-Clienttype': CLIENT_TYPE,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': crypto.createHash('md5').update(bodyBytes).digest('hex'),
    'Cosy-Bodylength': String(bodyBytes.length),
    'Cosy-Sigpath': path,
    'Cosy-Data-Policy': DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': LOGIN_VERSION,
    'X-Request-Id': crypto.randomUUID(),
  }
}

/** URL del catálogo de modelos de la cuenta. */
export function modelListUrl(region) {
  return `${region.baseUrl}algo/api/v2/model/list?Encode=1`
}

/** URL del endpoint de chat en streaming. */
export function chatUrl(region) {
  return `${region.baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
}

/** URL del perfil de la cuenta. */
export function userInfoUrl(region) {
  return `${region.openApiUrl}/api/v1/userinfo`
}

/** Cabeceras que la propia app envía al host OpenAPI. */
export function openApiHeaders(credential) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
  }
}

/** Parsea un cuerpo JSON, informando del content-type cuando falla. */
async function readJson(response, context) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    const contentType = response.headers.get('content-type') ?? 'sin content-type'
    throw new Error(`${context}: la respuesta no es JSON válido (${contentType}) — ${text.slice(0, 300)}`)
  }
}

/**
 * Comprueba que la respuesta del catálogo tenga la forma esperada.
 *
 * @param {unknown} data cuerpo 200 ya parseado.
 * @param {object} [region]
 * @returns {Array<object>} grupo `chat` sin normalizar.
 * @throws {ProtocolShapeChangedError} si el sobre cambió.
 */
export function readModelCatalogShape(data, region = { displayName: 'Qoder' }) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ProtocolShapeChangedError(
      `el nivel superior es ${Array.isArray(data) ? 'un array' : typeof data}, no un sobre de grupos`,
    )
  }
  if (!('chat' in data)) {
    throw new ProtocolShapeChangedError(
      `no hay grupo \`chat\`; grupos presentes: ${Object.keys(data).slice(0, 12).join(', ') || '(ninguno)'}`,
    )
  }
  const chat = data.chat
  if (!Array.isArray(chat)) {
    throw new ProtocolShapeChangedError(`\`chat\` es ${chat === null ? 'null' : typeof chat}, no un array`)
  }
  return chat
}

/**
 * Descarga y normaliza el catálogo de modelos de la cuenta.
 *
 * La respuesta viene agrupada por superficie de producto (`chat`, `developer`,
 * `quest`, …). Solo `chat` responde en la ruta `agent_common`.
 *
 * @param {object} region
 * @param {object} credential
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<object>>}
 */
export async function fetchModels(region, credential, signal) {
  const url = modelListUrl(region)
  const headers = authHeaders(Buffer.alloc(0), url, credential)
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
    redirect: 'error',
    signal,
  })
  if (!response.ok) {
    throw new Error(`Qoder model list failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
  }
  const data = await readJson(response, 'Qoder model list')
  const chat = readModelCatalogShape(data, region)
  const models = []
  for (const entry of chat) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.key !== 'string' || entry.key.length === 0) continue
    if (entry.enable === false) continue
    if (typeof entry.display_name !== 'string' || entry.display_name.length === 0) continue

    const config = entry.thinking_config
    const efforts = config?.enabled?.efforts
    // `efforts` es un objeto indexado por nivel, no un array. `disabled` solo
    // existe en los modelos que permiten apagar el pensamiento; los que no lo
    // permiten rechazan `enable_thinking: false` con provider_error 1210, así
    // que el flag debe omitirse para ellos.
    const effortLevels = efforts !== null && typeof efforts === 'object' ? Object.keys(efforts) : []
    const supportsEffort = effortLevels.length > 0
    const canDisableThinking = config?.disabled !== undefined

    // `context_config` publica las ventanas seleccionables; la marcada
    // `is_default` es la que arranca la app. No hay techo de salida publicado.
    const windows = entry.context_config
    const contextOptions = []
    let defaultContextWindow = 0
    if (windows !== null && typeof windows === 'object') {
      for (const value of Object.values(windows)) {
        const tokens = Number(value?.token_count)
        if (!Number.isFinite(tokens) || tokens <= 0) continue
        contextOptions.push(tokens)
        if (value?.is_default === true) defaultContextWindow = tokens
      }
      contextOptions.sort((left, right) => left - right)
    }
    if (defaultContextWindow === 0) defaultContextWindow = Number(entry.max_input_tokens) || 0

    models.push({
      key: entry.key,
      name: entry.display_name,
      isVL: entry.is_vl === true,
      isReasoning: entry.is_reasoning === true || config !== undefined,
      supportsEffort,
      alwaysThinking: supportsEffort && !canDisableThinking,
      effortLevels,
      defaultContextWindow,
      contextOptions,
      maxInputTokens: Number(entry.max_input_tokens) || 0,
      isDefault: entry.is_default === true,
      isFree: entry.is_free === true,
    })
  }
  return models
}

/**
 * Perfil de la cuenta firmada.
 *
 * @returns {Promise<{ userID: string, name: string, email: string }>}
 */
export async function fetchUserInfo(region, credential, signal) {
  const response = await fetch(userInfoUrl(region), {
    method: 'GET',
    headers: openApiHeaders(credential),
    redirect: 'error',
    signal,
  })
  if (!response.ok) {
    throw new Error(`Qoder userinfo failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
  }
  const data = await readJson(response, 'Qoder userinfo')
  const body = data?.data ?? data
  return {
    userID: String(body?.id ?? body?.user_id ?? ''),
    name: String(body?.name ?? body?.nickname ?? ''),
    email: String(body?.email ?? ''),
  }
}

/** Cola que se puede esperar. */
class QueueRejection extends Error {
  constructor(retryAfterSeconds, detail) {
    super(
      `Qoder está ocupado — la petición quedó en cola` +
        `${retryAfterSeconds > 0 ? ` (reintento en ~${retryAfterSeconds}s)` : ''}`,
    )
    this.name = 'QueueRejection'
    this.retryable = true
    this.retryAfterSeconds = retryAfterSeconds
    this.upstreamDetail = detail
  }
}

/** El cupo diario de facturación está gastado. */
class DailyLimitRejection extends Error {
  constructor(detail, retryAfterSeconds = 0) {
    super(
      `El cupo diario de peticiones de Qoder para esta cuenta está agotado` +
        `${retryAfterSeconds > 0 ? ` — se reinicia en unas ${Math.round(retryAfterSeconds / 3600)} h` : ''}. ` +
        'Esperar dentro de la sesión no sirve; el precio de valle (22:00–08:00 Asia/Shanghai) ' +
        'y el registro diario siguen funcionando.',
    )
    this.name = 'DailyLimitRejection'
    this.retryable = false
    this.dailyLimit = true
    this.retryAfterSeconds = retryAfterSeconds
    this.upstreamDetail = detail
  }
}

/**
 * Cuánto esperar antes de reintentar una cola, o `undefined` si no procede.
 *
 * @param {unknown} error
 * @param {number} waitedMs
 * @param {number} attempt índice 1-based.
 * @returns {number|undefined}
 */
export function queueWaitFor(error, waitedMs, attempt) {
  if (error?.retryable !== true) return undefined
  const remaining = QUEUE_WAIT_BUDGET_MS - waitedMs
  if (remaining <= 0) return undefined
  const hinted = Number(error.retryAfterSeconds) > 0 ? Number(error.retryAfterSeconds) * 1000 : QUEUE_WAIT_MIN_SLEEP_MS
  const GRACE_ATTEMPTS = 3
  const escalated = attempt > GRACE_ATTEMPTS ? QUEUE_WAIT_MIN_SLEEP_MS * 2 ** Math.min(attempt - GRACE_ATTEMPTS, 8) : 0
  const target = Math.max(hinted, escalated) * (0.75 + Math.random() * 0.5)
  const clamped = Math.max(QUEUE_WAIT_MIN_SLEEP_MS, Math.min(target, QUEUE_WAIT_MAX_SLEEP_MS))
  return Math.min(clamped, remaining)
}

/** Construye la frase legible de un fallo que no es cola. */
function failureMessage(failure, region, status, statusText) {
  if (failure.kind === 'sign-in-expired') {
    return (
      `La sesión de ${region.displayName} ya no es válida — abre la app de ${region.displayName} ` +
      `para volver a entrar` +
      `${status !== undefined ? ` (HTTP ${status}: ${failure.detail})` : ` (upstream ${failure.code || 'error'}: ${failure.detail})`}`
    )
  }
  if (status === 401 || status === 403) {
    return (
      `${region.displayName} fue rechazado por Qoder — comprueba que esta cuenta puede usar este modelo ` +
      `(HTTP ${status}: ${failure.detail})`
    )
  }
  if (status !== undefined) {
    return `Qoder chat failed: HTTP ${status} ${statusText ?? ''} — ${failure.detail}`
  }
  return `Error del upstream de Qoder${failure.code !== '' ? ` ${failure.code}` : ''}${failure.detail.length > 0 ? `: ${failure.detail}` : ''}`
}

/** Parsea una cadena que debería contener un objeto JSON. */
function tryJsonObject(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Desenvuelve el sobre de error hasta su nivel más profundo.
 *
 * Qoder anida el problema real: un código de transporte envuelve un `message`
 * que es a su vez una cadena JSON, que envuelve otro código, y el descriptor
 * de cola queda abajo. Leer solo el primer nivel reporta un `403` pelado y
 * esconde tanto el código real (`10605`) como la pista de reintento.
 *
 * @returns {{ code: string, detail: string }}
 */
function unwrapFailure(chunk) {
  let code = ''
  let detail = ''
  let node = chunk
  let descended = false

  for (let depth = 0; depth < 8; depth++) {
    if (!isPlainObject(node)) break
    const levelCode = node.errorCode ?? node.code
    if (typeof levelCode === 'string' && levelCode.length > 0) code = levelCode
    else if (typeof levelCode === 'number' && Number.isFinite(levelCode)) code = String(levelCode)
    const message = node.message ?? node.errorMessage
    if (typeof message === 'string' && message.length > 0) detail = message

    const nested = isPlainObject(node.details) ? node.details : isPlainObject(node.error) ? node.error : undefined
    const next = nested ?? (typeof message === 'string' ? tryJsonObject(message) : undefined)
    if (next === undefined) break
    node = next
    descended = true
  }

  if (descended && isPlainObject(node) && typeof node.message !== 'string') {
    detail = JSON.stringify(node)
  }
  return { code, detail }
}

/** Clasifica un frame y devuelve el fallo, o `undefined` si es un chunk. */
function readFailure(chunk, fallbackCode = '') {
  if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) return undefined
  const hasCode = chunk.code != null || chunk.errorCode != null
  const hasMessage =
    (typeof chunk.message === 'string' && chunk.message.length > 0) ||
    (typeof chunk.errorMessage === 'string' && chunk.errorMessage.length > 0)
  if (!hasCode && !hasMessage && fallbackCode === '') return undefined
  const { code, detail } = unwrapFailure(chunk)
  const effective = code !== '' ? code : fallbackCode
  const kind = classifyUpstreamError(chunk, effective, detail)
  return { kind: kind.kind, retryAfterSeconds: kind.retryAfterSeconds ?? 0, code: effective, detail }
}

/**
 * Normaliza la lista de mensajes al vocabulario que acepta Qoder.
 *
 * Acepta la forma OpenAI (la que envía Qwen Code: `tool_calls` en el asistente
 * y `role: "tool"` con `tool_call_id` para el resultado) y la forma nativa de
 * DSH, para que la función siga sirviendo a un llamador directo. Perder
 * cualquiera de las dos rompe el bucle de herramientas en el segundo turno,
 * que es lo más importante que tiene que hacer bien esta traducción.
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function toQoderMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue

    if (message.role === 'system' || message.role === 'developer') {
      out.push({ role: 'system', content: textOf(message.content) })
      continue
    }

    if (message.role === 'user') {
      const parts = []
      let hasImage = false
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'text') parts.push({ type: 'text', text: block.text ?? '' })
          else if (block?.type === 'image_url' || block?.type === 'image') {
            const url = block.image_url?.url ?? (typeof block.data === 'string'
              ? `data:${block.mimeType ?? 'image/png'};base64,${block.data}`
              : undefined)
            if (url !== undefined) {
              hasImage = true
              parts.push({ type: 'image_url', image_url: { url } })
            }
          }
        }
      }
      out.push({ role: 'user', content: hasImage ? parts : textOf(message.content) })
      continue
    }

    if (message.role === 'assistant') {
      let text = ''
      const toolCalls = []
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (call == null || typeof call !== 'object') continue
          const id = call.id
          if (typeof id !== 'string' || id.length === 0) {
            throw new Error('toQoderMessages: un tool_call del asistente no tiene id; el bucle de herramientas no puede emparejar el resultado')
          }
          const name = call.function?.name ?? call.name
          if (typeof name !== 'string' || name.length === 0) {
            throw new Error(`toQoderMessages: el tool_call "${id}" no tiene nombre de función; el gateway no puede despacharlo`)
          }
          toolCalls.push({
            id,
            type: 'function',
            function: {
              name,
              arguments:
                typeof call.function?.arguments === 'string'
                  ? call.function.arguments
                  : JSON.stringify(call.function?.arguments ?? call.arguments ?? {}),
            },
          })
        }
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'text') text += block.text ?? ''
          else if (block?.type === 'toolCall') {
            if (typeof block.id !== 'string' || block.id.length === 0) {
              throw new Error('toQoderMessages: un bloque toolCall no tiene id; el bucle de herramientas no puede emparejar el resultado')
            }
            if (typeof block.name !== 'string' || block.name.length === 0) {
              throw new Error(`toQoderMessages: el toolCall "${block.id}" no tiene nombre de función`)
            }
            toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) } })
          }
        }
      } else {
        text = textOf(message.content)
      }
      const entry = { role: 'assistant', content: text }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      out.push(entry)
      continue
    }

    if (message.role === 'toolResult' || message.role === 'tool') {
      const toolCallId = message.toolCallId ?? message.tool_call_id
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        throw new Error('toQoderMessages: un mensaje de resultado de herramienta no tiene tool_call_id')
      }
      out.push({ role: 'tool', tool_call_id: toolCallId, content: textOf(message.content) })
    }
  }
  return out
}

/** Aplana un contenido a texto plano. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block?.type === 'text') text += block.text ?? ''
  }
  return text
}

/**
 * Normaliza definiciones de herramientas al esquema de funciones.
 *
 * @param {Array<object>|undefined} tools
 * @returns {Array<object>}
 */
export function toQoderTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools.map((tool, index) => {
    if (tool?.function != null && typeof tool.function === 'object') {
      const name = tool.function.name
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`toQoderTools: la herramienta ${index} no tiene nombre; el gateway no puede registrarla`)
      }
      return {
        type: 'function',
        function: {
          name,
          description: tool.function.description ?? '',
          parameters: tool.function.parameters ?? { type: 'object', properties: {} },
        },
      }
    }
    const name = tool?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`toQoderTools: la herramienta ${index} no tiene nombre`)
    }
    return {
      type: 'function',
      function: {
        name,
        description: tool?.description ?? '',
        parameters: tool?.parameters ?? { type: 'object', properties: {} },
      },
    }
  })
}

/**
 * Un turno de chat, en streaming.
 *
 * Emite objetos en el vocabulario de chunks de OpenAI
 * (`{ choices: [{ delta, finish_reason }] }`, `{ usage }`) para que el puente
 * los reenvíe sin conocer el sobre de Qoder.
 *
 * @param {object} region
 * @param {object} credential
 * @param {{ model: string, messages: object[], tools?: object[], maxTokens?: number,
 *   enableThinking?: boolean, alwaysThinking?: boolean, reasoningEffort?: string,
 *   sessionId?: string }} request
 * @param {AbortSignal} [signal]
 * @yields {object}
 */
export async function* streamChat(region, credential, request, signal) {
  const model = request.model
  const recordID = crypto.randomUUID()
  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')
  const lastText = typeof lastUser?.content === 'string' ? lastUser.content : ''

  // Un modelo que siempre piensa responde `enable_thinking: false` con un
  // `provider_error` 1210, así que para esos el flag se omite por completo.
  // `max_tokens` solo viaja cuando el llamador lo pide: inventar un número
  // reintroduce la truncación que la omisión evita (razonamiento y respuesta
  // comparten ese presupuesto arriba).
  const parameters = {}
  if (Number.isSafeInteger(request.maxTokens) && request.maxTokens > 0) {
    parameters.max_tokens = request.maxTokens
  }
  if (request.enableThinking === true) {
    parameters.enable_thinking = true
    if (typeof request.reasoningEffort === 'string' && request.reasoningEffort.length > 0) {
      parameters.reasoning_effort = request.reasoningEffort
    }
  } else if (request.alwaysThinking !== true) {
    parameters.enable_thinking = false
  }

  const body = {
    request_id: crypto.randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: request.sessionId ?? `qwen-${crypto.randomUUID()}`,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    // El upstream ignora un `system` de nivel superior; lo que respeta es un
    // mensaje `role: system` al principio de la lista.
    system: '',
    messages: request.messages,
    tools: request.tools ?? [],
    parameters,
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: model, is_reasoning: request.enableThinking === true },
        originalContent: lastText,
      },
      features: [],
      text: lastText,
    },
    model_config: { key: model, source: 'system', is_reasoning: request.enableThinking === true },
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: crypto.randomUUID(),
      name: lastText.slice(0, 30),
      begin_at: Date.now(),
    },
  }

  const url = chatUrl(region)
  const bodyBytes = encodeBody(Buffer.from(JSON.stringify(body)))

  /** Abre una tentativa y devuelve su flujo de frames. */
  async function* readFrames(response) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let streamDone = false
    try {
      while (!streamDone) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload.length === 0) continue
          if (payload === '[DONE]') {
            streamDone = true
            break
          }

          // El frame es un sobre cuyo `body` es a su vez JSON; unos pocos
          // frames llevan el chunk en línea, así que se aceptan ambas formas.
          let envelope
          try {
            envelope = JSON.parse(payload)
          } catch {
            continue
          }
          let chunk = envelope
          if (typeof envelope?.body === 'string') {
            try {
              chunk = JSON.parse(envelope.body)
            } catch {
              continue
            }
          } else if (envelope?.body !== undefined && typeof envelope.body === 'object') {
            chunk = envelope.body
          }
          if (chunk?.choices !== undefined || (chunk?.usage !== undefined && chunk.usage !== null)) {
            yield chunk
            continue
          }

          const failure = readFailure(chunk)
          if (failure === undefined) continue
          // Antes que la rama de cola a propósito: el cupo diario llega CON
          // marcas de cola y un Retry-After de horas, y no debe reintentarse.
          if (failure.kind === 'daily-limit') throw new DailyLimitRejection(failure.detail, failure.retryAfterSeconds)
          if (failure.kind === 'rate-limit') throw new QueueRejection(failure.retryAfterSeconds, failure.detail)
          const message = failureMessage(failure, region)
          const error = new Error(message)
          if (failure.kind === 'sign-in-expired') error.signInExpired = true
          throw error
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // Ya cerrado.
      }
    }
  }

  /** Envía una petición; lanza en fallos terminales y devuelve el flujo abierto. */
  async function openAttempt() {
    let response
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'identity',
      'X-Model-Key': model,
      'X-Model-Source': 'system',
      ...authHeaders(bodyBytes, url, credential),
    }
    // El plazo cubre solo el saludo hasta las cabeceras: el cuerpo devuelto
    // vive más allá de este ámbito y no debe quedar armado durante el stream.
    const deadline = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
    const attemptSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    try {
      response = await fetch(url, { method: 'POST', headers, body: bodyBytes, redirect: 'error', signal: attemptSignal })
    } catch (error) {
      if (signal?.aborted) throw error
      if (deadline.aborted) {
        throw new QueueRejection(0, `sin cabeceras de respuesta en ${Math.round(ATTEMPT_TIMEOUT_MS / 1000)}s`)
      }
      const cause = error?.cause
      const code = cause?.code ?? error?.code ?? ''
      if (
        code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE' ||
        code === 'ENOTFOUND' || code === 'UND_ERR_SOCKET' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' ||
        error?.message?.includes?.('fetch failed')
      ) {
        throw new QueueRejection(0, `red: ${cause?.message ?? error?.message ?? error}`)
      }
      throw error
    }

    if (!response.ok) {
      const text = (await response.text()).slice(0, 500)
      if (response.status === 429 || response.status >= 500) {
        let retryAfter = 0
        const header = response.headers.get('retry-after')
        if (header !== null) {
          const seconds = Number(header)
          if (Number.isFinite(seconds) && seconds > 0) retryAfter = seconds
          else {
            const date = Date.parse(header)
            if (Number.isFinite(date)) retryAfter = Math.max(0, Math.ceil((date - Date.now()) / 1000))
          }
        }
        throw new QueueRejection(retryAfter, `HTTP ${response.status} — ${text}`)
      }
      const failure = readFailure({ code: String(response.status), message: text }, String(response.status))
      if (failure === undefined) {
        throw new Error(`Qoder chat failed: HTTP ${response.status} ${response.statusText} — ${text}`)
      }
      if (failure.kind === 'daily-limit') throw new DailyLimitRejection(failure.detail, failure.retryAfterSeconds)
      if (failure.kind === 'rate-limit') throw new QueueRejection(failure.retryAfterSeconds, failure.detail)
      const message = failureMessage(failure, region, response.status, response.statusText)
      const error = new Error(message)
      if (failure.kind === 'sign-in-expired') error.signInExpired = true
      throw error
    }
    if (response.body === null) throw new Error('Qoder chat no devolvió cuerpo')
    return response
  }

  let waitedMs = 0
  for (let attempt = 1; ; attempt++) {
    let stream
    let first
    // Todo lo que cuesta una tentativa —saludo, primer frame y espera— se
    // carga al presupuesto, no solo el sueño.
    const attemptStartedAt = Date.now()
    try {
      stream = readFrames(await openAttempt())
      // Se extrae el primer frame antes de comprometerse con la respuesta, para
      // que un rechazo de cola aparezca aquí y no a mitad del stream.
      first = await stream.next()
    } catch (error) {
      waitedMs += Date.now() - attemptStartedAt
      const queueWaitMs = queueWaitFor(error, waitedMs, attempt)
      if (queueWaitMs === undefined) throw error
      if (signal?.aborted) throw error
      await sleep(queueWaitMs, signal)
      waitedMs += queueWaitMs
      continue
    }
    waitedMs += Date.now() - attemptStartedAt

    if (first.done === true) {
      throw new Error(`${region.displayName} devolvió una respuesta vacía`)
    }

    try {
      yield first.value
      for (;;) {
        const step = await stream.next()
        if (step.done === true) break
        yield step.value
      }
    } finally {
      await stream.return(undefined).catch(() => {})
    }
    return
  }
}
