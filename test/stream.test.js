import test from 'node:test'
import assert from 'node:assert/strict'
import {
  authHeaders,
  CUSTOM_ALPHABET,
  encodeBody,
  STD_ALPHABET,
  streamChat,
} from '../lib/upstream.js'
import { regionById } from '../lib/regions.js'

const REGION = regionById('qoder')
const CREDENTIAL = { userID: 'u1', token: 'dt-token', name: 'N', email: 'e@x', machineID: 'm1' }

/** Respuesta SSE a partir de frames ya construidos. */
function sse(frames, status = 200, headers = {}) {
  const body = frames
    .map((frame) => (typeof frame === 'string' ? frame : JSON.stringify(frame)))
    .map((frame) => (frame === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${frame}\n\n`))
    .join('')
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

/** Envuelve un chunk OpenAI en el sobre de Qoder (body como cadena JSON). */
function envelope(chunk) {
  return { body: JSON.stringify(chunk) }
}

/** Deshace `encodeBody` para comprobar lo que viajó al gateway. */
function decodeBody(encoded) {
  const text = Buffer.from(encoded).toString('latin1')
  const third = Math.floor(text.length / 3)
  const rotated = text.slice(text.length - third) + text.slice(third, text.length - third) + text.slice(0, third)
  const std = [...rotated].map((char) => (char === '$' ? '=' : STD_ALPHABET[CUSTOM_ALPHABET.indexOf(char)])).join('')
  return Buffer.from(std, 'base64').toString('utf8')
}

/** Sustituye `fetch` durante una prueba. */
async function withFetch(fn, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return fn(url, options, calls.length)
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const REQUEST = {
  model: 'qmodel_38max',
  messages: [{ role: 'user', content: 'hola' }],
  tools: [],
  enableThinking: true,
  alwaysThinking: false,
  reasoningEffort: 'low',
}

test('streamChat firma, codifica y traduce el sobre SSE', async () => {
  await withFetch(
    () => sse([
      envelope({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ho' }, finish_reason: null }] }),
      envelope({ choices: [{ index: 0, delta: { content: 'la' }, finish_reason: null }] }),
      envelope({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
      envelope({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ]),
    async (calls) => {
      const chunks = []
      for await (const chunk of streamChat(REGION, CREDENTIAL, REQUEST)) chunks.push(chunk)
      assert.equal(chunks.length, 4)
      assert.equal(chunks[0].choices[0].delta.content, 'ho')
      assert.equal(chunks[1].choices[0].delta.content, 'la')
      assert.equal(chunks[2].usage.total_tokens, 3)
      assert.equal(chunks[3].choices[0].finish_reason, 'stop')

      // Lo que viajó al gateway: cabeceras COSY y cuerpo codificado reversible.
      const [call] = calls
      assert.match(call.url, /agent_chat_generation/)
      assert.match(call.options.headers.Authorization, /^Bearer COSY\./)
      assert.equal(call.options.headers['X-Model-Key'], 'qmodel_38max')
      const body = JSON.parse(decodeBody(call.options.body))
      assert.equal(body.model_config.key, 'qmodel_38max')
      assert.equal(body.parameters.enable_thinking, true)
      assert.equal(body.parameters.reasoning_effort, 'low')
      assert.equal(body.messages[0].content, 'hola')
      assert.equal(body.stream, true)
    },
  )
})

test('un modelo que siempre piensa omite enable_thinking', async () => {
  await withFetch(
    () => sse([envelope({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] }), '[DONE]']),
    async (calls) => {
      for await (const _chunk of streamChat(REGION, CREDENTIAL, {
        ...REQUEST,
        enableThinking: false,
        alwaysThinking: true,
      })) {
        // consumir
      }
      const body = JSON.parse(decodeBody(calls[0].options.body))
      assert.equal('enable_thinking' in body.parameters, false)
    },
  )
})

test('el cupo diario en un frame no se convierte en cola', async () => {
  await withFetch(
    () => sse([envelope({ code: '110', message: 'Billing daily count exceeded', retryAfterSeconds: 7350 })]),
    async (calls) => {
      await assert.rejects(
        async () => {
          for await (const _chunk of streamChat(REGION, CREDENTIAL, REQUEST)) {
            // consumir
          }
        },
        (error) => error.dailyLimit === true && error.retryable === false,
      )
      assert.equal(calls.length, 1, 'no debe reintentarse')
    },
  )
})

test('un 503 con Retry-After se reintenta y termina bien', async () => {
  await withFetch(
    (_url, _options, attempt) => (attempt === 1
      ? new Response('busy', { status: 503, headers: { 'retry-after': '0' } })
      : sse([envelope({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]'])),
    async (calls) => {
      const chunks = []
      for await (const chunk of streamChat(REGION, CREDENTIAL, REQUEST)) chunks.push(chunk)
      assert.equal(chunks[0].choices[0].delta.content, 'ok')
      assert.equal(calls.length, 2)
    },
  )
})

test('un 403 con 10605 anidado se clasifica como cola y se reintenta', async () => {
  const nested = JSON.stringify({ code: '10605', message: JSON.stringify({ isQueued: true, retryAfterSeconds: 1 }) })
  await withFetch(
    (_url, _options, attempt) => (attempt === 1
      ? new Response(nested, { status: 403 })
      : sse([envelope({ choices: [{ index: 0, delta: { content: 'ya' }, finish_reason: 'stop' }] }), '[DONE]'])),
    async (calls) => {
      const chunks = []
      for await (const chunk of streamChat(REGION, CREDENTIAL, REQUEST)) chunks.push(chunk)
      assert.equal(chunks[0].choices[0].delta.content, 'ya')
      assert.equal(calls.length, 2, 'la cola se espera y se reintenta, no se reporta como rechazo')
    },
  )
})

test('una respuesta vacía es un error, no un turno en blanco', async () => {
  await withFetch(
    () => sse([]),
    async () => {
      await assert.rejects(
        async () => {
          for await (const _chunk of streamChat(REGION, CREDENTIAL, REQUEST)) {
            // consumir
          }
        },
        /respuesta vacía/,
      )
    },
  )
})

test('authHeaders no mete el token en claro en ninguna cabecera', () => {
  const url = 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1'
  const headers = authHeaders(Buffer.alloc(0), url, CREDENTIAL)
  assert.ok(!JSON.stringify(headers).includes('dt-token'))
  assert.equal(headers['Cosy-User'], 'u1')
  assert.ok(encodeBody(Buffer.from('x')).length > 0)
})
