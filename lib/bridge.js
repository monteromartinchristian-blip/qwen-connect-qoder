/**
 * El puente: un endpoint OpenAI-compatible en loopback que habla Qoder.
 *
 * Qwen Code sabe hablar OpenAI, no COSY ni SSE de doble sobre. En vez de
 * enseñarle el protocolo de Qoder, este módulo levanta un servidor privado en
 * `127.0.0.1` que recibe `/v1/chat/completions` y `/v1/models`, firma cada
 * petición hacia el gateway y devuelve SSE de OpenAI.
 *
 * El servidor exige un bearer aleatorio por instalación (se comparte con Qwen
 * Code por `settings.json`), valida que `Host` y `Origin` sean de loopback y no
 * expone el token de Qoder al cliente.
 *
 * @module qwen-connect-qoder/bridge
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isStaleCredentialError } from './errors.js'
import { streamChat, toQoderMessages, toQoderTools } from './upstream.js'
import { claimDailyBenefit, fetchUsage } from './usage.js'
import { regionById } from './regions.js'
import { defaultEffortFor } from './qwen-settings.js'

/** Cuerpo máximo aceptado (imágenes en base64 incluidas). */
const MAX_BODY_BYTES = 20 * 1024 * 1024
/** Máximo de `Retry-After` que se anuncia, en segundos. */
const RETRY_AFTER_MAX_SECONDS = 20

/** ¿El `Host` apunta a loopback? */
function hostIsLoopback(host) {
  if (typeof host !== 'string') return false
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/** ¿El `Origin` es de loopback? */
function originIsLoopback(origin) {
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

/** Lee el cuerpo de la petición con tope de tamaño. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        settled = true
        reject(Object.assign(new Error('el cuerpo supera los 20 MiB'), { tooLarge: true }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/** Escribe una respuesta JSON. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Escribe una respuesta de error con la forma de OpenAI. */
function sendError(res, status, type, message, extraHeaders = {}) {
  sendJson(res, status, { error: { message, type, code: type } })
  void extraHeaders
}

/** Escribe un frame SSE. */
function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

/** `Retry-After` de un fallo reintentable, o `undefined`. */
function retryAfterHeader(error) {
  const seconds = Number(error?.retryAfterSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return String(Math.min(Math.max(Math.ceil(seconds), 1), RETRY_AFTER_MAX_SECONDS))
}

/**
 * Decide si el llamador pidió razonamiento.
 *
 * Sin nada explícito, un modelo de razonamiento se trata como pensante en vez
 * de apagarlo en silencio; un modelo que no razona manda `false` para que el
 * gateway no invente el flag.
 *
 * @param {object} body
 * @param {object|undefined} entry
 */
export function resolveThinking(body, entry) {
  if (typeof body?.reasoning_effort === 'string' && body.reasoning_effort.length > 0) {
    return body.reasoning_effort !== 'off' && body.reasoning_effort !== 'none'
  }
  if (body?.thinking !== undefined) return body.thinking !== false && body.thinking !== 'off'
  return entry?.isReasoning === true
}

/** Acumula un chunk en el mensaje final (peticiones sin streaming). */
function absorb(chunk, content, toolCalls, setFinish) {
  const choice = chunk?.choices?.[0]
  if (choice === undefined) return
  const delta = choice.delta ?? choice.message ?? {}
  if (typeof delta.content === 'string') content.push(delta.content)
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      const index = call.index ?? 0
      const current = toolCalls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (call.id) current.id = call.id
      if (call.function?.name) current.function.name = call.function.name
      if (call.function?.arguments) current.function.arguments += call.function.arguments
      toolCalls.set(index, current)
    }
  }
  if (choice.finish_reason) setFinish(choice.finish_reason)
}

/**
 * Arranca el puente.
 *
 * @param {object} options
 * @param {{ token: string, port: number, regions: string[] }} options.config
 * @param {object[]} options.regions regiones habilitadas.
 * @param {import('./credentials.js').CredentialStore} options.credentials
 * @param {import('./catalog.js').Catalog} options.catalog
 * @param {(message: string, error?: unknown) => void} [options.log]
 * @param {Function} [options.runChat] inyectable para pruebas.
 * @returns {{ ready: Promise<void>, port: () => number, baseUrl: () => string, close: () => Promise<void> }}
 */
export function createBridge(options) {
  const { config, regions, credentials, catalog, log = () => {} } = options
  const runChat = options.runChat ?? streamChat
  const expected = Buffer.from(config.token)

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`fallo interno: ${error?.stack ?? error}`)
      if (!res.headersSent) sendError(res, 500, 'internal_error', String(error?.message ?? error))
      else res.end()
    })
  })

  const ready = new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  server.listen(config.port, '127.0.0.1')

  const port = () => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('el puente no tiene dirección de escucha')
    return address.port
  }

  /** Compara el bearer en tiempo constante. */
  function bearerOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = Buffer.from(match[1])
    if (presented.length !== expected.length) return false
    return timingSafeEqual(presented, expected)
  }

  async function handle(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      sendError(res, 403, 'host_not_allowed', 'la cabecera Host debe nombrar la interfaz de loopback')
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      sendError(res, 403, 'origin_not_allowed', 'el Origin debe ser de loopback')
      return
    }
    if (!bearerOk(req)) {
      sendError(res, 401, 'unauthorized', 'falta el bearer o no es válido')
      return
    }
    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
      sendJson(res, 200, {
        ok: true,
        port: port(),
        models: catalog.list().length,
        fetchedAt: catalog.fetchedAt,
        error: catalog.lastError,
      })
      return
    }
    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
      await catalog.refreshIfNeeded()
      sendJson(res, 200, {
        object: 'list',
        data: catalog.list().map((model) => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: model.region,
        })),
      })
      return
    }
    if (req.method === 'GET' && (url === '/catalog' || url === '/catalog/')) {
      sendJson(res, 200, {
        fetchedAt: catalog.fetchedAt,
        error: catalog.lastError,
        models: catalog.list(),
      })
      return
    }
    if (req.method === 'GET' && (url === '/usage' || url.startsWith('/usage?'))) {
      const only = new URL(url, 'http://127.0.0.1').searchParams.get('region')
      sendJson(res, 200, { regions: await usageRows(only ?? undefined) })
      return
    }
    if (req.method === 'GET' && (url === '/account' || url.startsWith('/account?'))) {
      const only = new URL(url, 'http://127.0.0.1').searchParams.get('region')
      sendJson(res, 200, { regions: await accountRows(only ?? undefined) })
      return
    }
    if (req.method === 'POST' && (url === '/checkin' || url === '/checkin/')) {
      await checkin(req, res)
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
      await chatCompletions(req, res)
      return
    }
    sendError(res, 404, 'not_found', `no existe la ruta ${req.method} ${url}`)
  }

  /** Regiones a consultar, filtradas por `?region=`. */
  function selectedRegions(only) {
    if (typeof only !== 'string' || only.length === 0) return regions
    return regions.filter((region) => region.id === only)
  }

  /**
   * Ejecuta una lectura con la credencial de una región y normaliza el fallo.
   *
   * Un error de sesión invalida el caché para que la siguiente petición relea
   * el fichero de la app, igual que hace el camino de chat.
   */
  async function withCredential(region, read) {
    let credential
    try {
      credential = await credentials.get(region)
    } catch (error) {
      return { region: region.id, displayName: region.displayName, status: 'error', error: String(error?.message ?? error) }
    }
    if (!credential) return { region: region.id, displayName: region.displayName, status: 'not_signed_in' }
    try {
      return { region: region.id, displayName: region.displayName, status: 'ok', ...(await read(credential)) }
    } catch (error) {
      if (isStaleCredentialError(error)) credentials.invalidate(region.id)
      return { region: region.id, displayName: region.displayName, status: 'error', error: String(error?.message ?? error) }
    }
  }

  /** Consumo y registro diario por región. */
  async function usageRows(only) {
    const rows = []
    for (const region of selectedRegions(only)) {
      rows.push(
        await withCredential(region, async (credential) => {
          const usage = await fetchUsage(region, credential)
          return usage === undefined ? { status: 'no_data' } : usage
        }),
      )
    }
    return rows
  }

  /** Identidad y plan por región, sin material de credencial. */
  async function accountRows(only) {
    const rows = []
    for (const region of selectedRegions(only)) {
      rows.push(
        await withCredential(region, async (credential) => {
          const usage = await fetchUsage(region, credential)
          return {
            name: credential.name,
            email: credential.email,
            source: credential.source,
            appName: credential.appName,
            expiresAt: credential.expiresAt,
            expired: credential.expired === true,
            userType: usage?.userType || '',
            isQuotaExceeded: usage?.isQuotaExceeded === true,
          }
        }),
      )
    }
    return rows
  }

  /** Registro diario: cambia estado en la cuenta, así que solo por POST. */
  async function checkin(req, res) {
    let body = {}
    try {
      const raw = await readBody(req)
      body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'))
    } catch (error) {
      if (error?.tooLarge === true) {
        sendError(res, 413, 'payload_too_large', 'el cuerpo supera los 20 MiB')
        return
      }
      sendError(res, 400, 'invalid_request', `el cuerpo no es JSON: ${String(error)}`)
      return
    }
    const rows = []
    for (const region of selectedRegions(body?.region)) {
      rows.push(
        await withCredential(region, async (credential) => {
          const result = await claimDailyBenefit(region, credential)
          return result
        }),
      )
    }
    sendJson(res, 200, { regions: rows })
  }

  async function chatCompletions(req, res) {
    let body
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'))
    } catch (error) {
      if (error?.tooLarge === true) {
        sendError(res, 413, 'payload_too_large', 'el cuerpo supera los 20 MiB')
        return
      }
      sendError(res, 400, 'invalid_request', `el cuerpo no es JSON: ${String(error)}`)
      return
    }

    const entry = catalog.find(body?.model)
    if (entry === undefined) {
      sendError(res, 404, 'model_not_found', `el modelo "${body?.model}" no está en el catálogo del puente`)
      return
    }
    const region = regionById(entry.region)
    if (region === undefined) {
      sendError(res, 502, 'region_unknown', `la región ${entry.region} ya no está configurada`)
      return
    }

    let credential
    try {
      credential = await credentials.get(region)
    } catch (error) {
      sendError(res, 502, 'credential_error', String(error?.message ?? error))
      return
    }
    if (!credential) {
      sendError(res, 401, 'not_signed_in', `${region.displayName} no tiene sesión legible en esta máquina`)
      return
    }

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const enableThinking = resolveThinking(body, entry)
    const explicitEffort =
      typeof body?.reasoning_effort === 'string' && body.reasoning_effort.length > 0 && enableThinking
        ? body.reasoning_effort
        : undefined
    const request = {
      model: entry.upstreamKey,
      messages: toQoderMessages(body.messages ?? []),
      tools: toQoderTools(body.tools),
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      enableThinking,
      alwaysThinking: entry.alwaysThinking === true,
      reasoningEffort: enableThinking ? explicitEffort ?? defaultEffortFor(entry.effortLevels) : undefined,
    }

    const wantStream = body?.stream !== false
    let iterator
    let first
    try {
      iterator = runChat(region, credential, request, controller.signal)
      first = await iterator.next()
    } catch (error) {
      if (isStaleCredentialError(error)) credentials.invalidate(region.id)
      log(`${region.displayName} falló: ${error?.message ?? error}`)
      if (error?.retryable === true) {
        const headers = retryAfterHeader(error)
        if (headers !== undefined) res.setHeader('Retry-After', headers)
        sendError(res, 503, 'rate_limit', String(error?.message ?? error))
        return
      }
      if (error?.dailyLimit === true) {
        sendError(res, 429, 'daily_limit_exceeded', String(error?.message ?? error))
        return
      }
      if (error?.protocolShapeChanged === true) {
        sendError(res, 502, 'protocol_shape_changed', String(error?.message ?? error))
        return
      }
      sendError(res, 502, 'upstream_error', String(error?.message ?? error))
      return
    }

    const displayModel = entry.id
    if (!wantStream) {
      const content = []
      const toolCalls = new Map()
      let finish = 'stop'
      let usage
      for (let step = first; !step.done; step = await iterator.next()) {
        if (step.value?.usage !== undefined && step.value.usage !== null) usage = step.value.usage
        absorb(step.value, content, toolCalls, (value) => {
          finish = value
        })
      }
      const message = { role: 'assistant', content: content.join('') }
      if (toolCalls.size > 0) message.tool_calls = [...toolCalls.values()]
      sendJson(res, 200, {
        id: `chatcmpl-${randomBytes(8).toString('hex')}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: displayModel,
        choices: [{ index: 0, message, finish_reason: finish }],
        ...(usage !== undefined ? { usage } : {}),
      })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const id = `chatcmpl-${randomBytes(8).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)
    let sentRole = false
    try {
      for (let step = first; !step.done; step = await iterator.next()) {
        const chunk = step.value
        // El consumo de tokens llega en su propio frame, con `choices: []` y un
        // `usage` de nivel superior: hay que reenviarlo antes del filtro de
        // elecciones, que lo descartaría.
        if (chunk?.usage !== undefined && chunk.usage !== null) {
          writeSse(res, {
            id,
            object: 'chat.completion.chunk',
            created,
            model: displayModel,
            choices: [],
            usage: chunk.usage,
          })
        }
        const choice = chunk?.choices?.[0]
        if (choice === undefined) continue
        const delta = choice.delta ?? choice.message ?? {}
        const out = { role: 'assistant' }
        if (typeof delta.content === 'string' && delta.content.length > 0) out.content = delta.content
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning.length > 0) out.reasoning_content = reasoning
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) out.tool_calls = delta.tool_calls
        const finish = choice.finish_reason
        if (!sentRole) sentRole = true
        else if (Object.keys(out).length === 1 && finish === undefined) continue
        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model: displayModel,
          choices: [{ index: 0, delta: out, finish_reason: finish ?? null }],
        })
      }
    } catch (error) {
      // Nunca cerrar con [DONE] un stream roto: eso diría que la respuesta
      // terminó bien y el cliente mostraría media respuesta como completa.
      if (isStaleCredentialError(error)) credentials.invalidate(region.id)
      log(`stream roto (${region.displayName}): ${error?.message ?? error}`)
      const retryable = error?.retryable === true
      const kind = retryable ? 'rate_limit' : error?.dailyLimit === true ? 'daily_limit_exceeded' : 'upstream_error'
      res.write(`data: ${JSON.stringify({ error: { message: String(error?.message ?? error), type: kind, code: kind } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }

  let closed = false
  let closedPromise
  return {
    ready,
    port,
    baseUrl: () => `http://127.0.0.1:${port()}`,
    close: () => {
      if (closed) return closedPromise
      closed = true
      closedPromise = new Promise((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else resolve()
        })
      })
      return closedPromise
    },
  }
}

/** Regiones habilitadas según la configuración, en orden. */
export function enabledRegions(config) {
  const ids = Array.isArray(config.regions) && config.regions.length > 0 ? config.regions : ['qoder']
  return ids.map((id) => regionById(id)).filter((region) => region !== undefined)
}
