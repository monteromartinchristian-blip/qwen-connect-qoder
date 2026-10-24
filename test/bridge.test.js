import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createBridge } from '../lib/bridge.js'
import { regionById } from '../lib/regions.js'

const MODEL = {
  id: 'qoder/qmodel_38max',
  upstreamKey: 'qmodel_38max',
  name: 'Qoder · Qwen3.8-Max',
  region: 'qoder',
  isReasoning: true,
  alwaysThinking: false,
  effortLevels: ['low', 'medium', 'xhigh'],
  contextWindow: 200000,
  vision: true,
}

const CATALOG = {
  list: () => [MODEL],
  find: (id) => (id === MODEL.id ? MODEL : undefined),
  refreshIfNeeded: async () => ({ models: [MODEL] }),
  fetchedAt: 1,
  lastError: undefined,
}

async function* okChat() {
  yield { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }
  yield { choices: [{ index: 0, delta: { content: 'hola' }, finish_reason: null }] }
  yield {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"uname"}' } }] },
      finish_reason: null,
    }],
  }
  yield { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }
  yield { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
}

/** Arranca un puente con dobles de catálogo/credenciales/upstream. */
async function start(options = {}) {
  const invalidated = []
  const credentials = {
    get: options.getCredential ?? (async () => ({ token: 't', userID: 'u', machineID: 'm' })),
    invalidate: (regionId) => invalidated.push(regionId),
  }
  const bridge = createBridge({
    config: { token: 'secreto', port: 0, regions: ['qoder'] },
    regions: [regionById('qoder')],
    credentials,
    catalog: options.catalog ?? CATALOG,
    runChat: options.runChat ?? okChat,
    log: () => {},
  })
  await bridge.ready
  return { bridge, invalidated }
}

/** Petición con `Host` libre (fetch prohíbe fijar esa cabecera). */
function rawRequest(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Parte un cuerpo SSE en frames JSON. */
function frames(text) {
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => frame.slice(5).trim())
}

function chat(port, body, token = 'secreto') {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('sin bearer no se sirve nada', async () => {
  const { bridge } = await start()
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port()}/v1/models`)
    assert.equal(response.status, 401)
  } finally {
    await bridge.close()
  }
})

test('una cabecera Host que no es loopback se rechaza', async () => {
  const { bridge } = await start()
  try {
    const response = await rawRequest(bridge.port(), {
      path: '/v1/models',
      headers: { Host: 'evil.example.com', Authorization: 'Bearer secreto' },
    })
    assert.equal(response.status, 403)
    assert.match(response.body, /host_not_allowed/)
  } finally {
    await bridge.close()
  }
})

test('/healthz y /v1/models responden con el catálogo', async () => {
  const { bridge } = await start()
  try {
    const health = await fetch(`http://127.0.0.1:${bridge.port()}/healthz`, {
      headers: { Authorization: 'Bearer secreto' },
    })
    assert.equal(health.status, 200)
    const payload = await health.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.models, 1)

    const models = await fetch(`http://127.0.0.1:${bridge.port()}/v1/models`, {
      headers: { Authorization: 'Bearer secreto' },
    })
    const list = await models.json()
    assert.deepEqual(list.data.map((entry) => entry.id), ['qoder/qmodel_38max'])
  } finally {
    await bridge.close()
  }
})

test('el streaming traduce a SSE de OpenAI, incluido usage y tool_calls', async () => {
  const { bridge } = await start()
  try {
    const response = await chat(bridge.port(), {
      model: 'qoder/qmodel_38max',
      stream: true,
      messages: [{ role: 'user', content: 'hola' }],
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const text = await response.text()
    const parts = frames(text)
    assert.equal(parts.at(-1), '[DONE]')
    const chunks = parts.slice(0, -1).map((part) => JSON.parse(part))
    assert.equal(chunks[0].choices[0].delta.role, 'assistant')
    assert.ok(chunks.some((chunk) => chunk.choices[0]?.delta?.content === 'hola'))
    assert.ok(chunks.some((chunk) => chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.name === 'run_shell'))
    assert.ok(chunks.some((chunk) => chunk.usage?.total_tokens === 7))
    assert.ok(chunks.some((chunk) => chunk.choices[0]?.finish_reason === 'tool_calls'))
    assert.equal(chunks[0].model, 'qoder/qmodel_38max')
  } finally {
    await bridge.close()
  }
})

test('sin streaming se agrega el mensaje y las herramientas', async () => {
  const { bridge } = await start()
  try {
    const response = await chat(bridge.port(), {
      model: 'qoder/qmodel_38max',
      stream: false,
      messages: [{ role: 'user', content: 'hola' }],
    })
    const payload = await response.json()
    assert.equal(payload.choices[0].message.content, 'hola')
    assert.equal(payload.choices[0].message.tool_calls[0].id, 'c1')
    assert.equal(payload.usage.total_tokens, 7)
    assert.equal(payload.choices[0].finish_reason, 'tool_calls')
  } finally {
    await bridge.close()
  }
})

test('un modelo desconocido es 404, no un 502 del upstream', async () => {
  const { bridge } = await start()
  try {
    const response = await chat(bridge.port(), { model: 'qoder/no-existe', messages: [] })
    assert.equal(response.status, 404)
    assert.match((await response.json()).error.message, /no está en el catálogo/)
  } finally {
    await bridge.close()
  }
})

test('sin credencial la respuesta es 401 not_signed_in', async () => {
  const { bridge } = await start({ getCredential: async () => undefined })
  try {
    const response = await chat(bridge.port(), { model: MODEL.id, messages: [] })
    assert.equal(response.status, 401)
    assert.match((await response.json()).error.type, /not_signed_in/)
  } finally {
    await bridge.close()
  }
})

test('el cupo diario es 429 sin Retry-After y no se reintenta', async () => {
  async function* daily() {
    const error = new Error('cupo agotado')
    error.dailyLimit = true
    error.retryAfterSeconds = 7350
    throw error
    yield
  }
  const { bridge } = await start({ runChat: daily })
  try {
    const response = await chat(bridge.port(), { model: MODEL.id, messages: [] })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), null)
    assert.match((await response.json()).error.type, /daily_limit/)
  } finally {
    await bridge.close()
  }
})

test('una cola es 503 con Retry-After acotado', async () => {
  async function* queued() {
    const error = new Error('en cola')
    error.retryable = true
    error.retryAfterSeconds = 900
    throw error
    yield
  }
  const { bridge } = await start({ runChat: queued })
  try {
    const response = await chat(bridge.port(), { model: MODEL.id, messages: [] })
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '20')
  } finally {
    await bridge.close()
  }
})

test('una sesión caducada invalida la credencial cacheada', async () => {
  async function* expired() {
    const error = new Error('La sesión de Qoder ya no es válida — sign-in-expired')
    error.signInExpired = true
    throw error
    yield
  }
  const { bridge, invalidated } = await start({ runChat: expired })
  try {
    const response = await chat(bridge.port(), { model: MODEL.id, messages: [] })
    assert.equal(response.status, 502)
    assert.deepEqual(invalidated, ['qoder'])
  } finally {
    await bridge.close()
  }
})

test('un error a mitad del stream viaja como frame, sin cerrar con [DONE] limpio', async () => {
  async function* broken() {
    yield { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }
    throw new Error('se cortó')
  }
  const { bridge } = await start({ runChat: broken })
  try {
    const response = await chat(bridge.port(), { model: MODEL.id, messages: [], stream: true })
    const text = await response.text()
    const parts = frames(text)
    const errorFrame = parts.map((part) => (part === '[DONE]' ? undefined : JSON.parse(part))).find((chunk) => chunk?.error)
    assert.equal(errorFrame.error.type, 'upstream_error')
    assert.match(errorFrame.error.message, /se cortó/)
  } finally {
    await bridge.close()
  }
})
