import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  authHeaders,
  CUSTOM_ALPHABET,
  encodeBody,
  MACHINE_OS,
  QUEUE_WAIT_BUDGET_MS,
  queueWaitFor,
  readModelCatalogShape,
  signaturePath,
  STD_ALPHABET,
  toQoderMessages,
  toQoderTools,
} from '../lib/upstream.js'
import { classifyUpstreamError, isStaleCredentialError, ProtocolShapeChangedError } from '../lib/errors.js'

const CREDENTIAL = {
  userID: 'usuario-1',
  token: 'dt-token',
  name: 'Nombre',
  email: 'correo@example.com',
  machineID: 'maquina-1',
}

test('encodeBody produce exactamente la permutación documentada', () => {
  const plain = Buffer.from(JSON.stringify({ hola: 'mundo', n: 42 }))
  // Implementación de referencia, escrita con slices en vez de índices.
  const std = plain.toString('base64')
  const third = Math.floor(std.length / 3)
  const rotated = std.slice(std.length - third) + std.slice(third, std.length - third) + std.slice(0, third)
  const expected = [...rotated]
    .map((char) => (char === '=' ? '$' : CUSTOM_ALPHABET[STD_ALPHABET.indexOf(char)]))
    .join('')
  assert.equal(encodeBody(plain).toString('latin1'), expected)
  assert.equal(encodeBody(plain).length, std.length)
})

test('encodeBody es reversible con la tabla inversa', () => {
  const plain = Buffer.from('{"model":"x","stream":true}')
  const encoded = encodeBody(plain).toString('latin1')
  const third = Math.floor(encoded.length / 3)
  // Deshacer la rotación: el original es C + B + A, donde la salida fue A + B + C.
  const rotatedBack =
    encoded.slice(encoded.length - third) +
    encoded.slice(third, encoded.length - third) +
    encoded.slice(0, third)
  const std = [...rotatedBack]
    .map((char) => (char === '$' ? '=' : STD_ALPHABET[CUSTOM_ALPHABET.indexOf(char)]))
    .join('')
  assert.equal(Buffer.from(std, 'base64').toString('utf8'), plain.toString('utf8'))
})

test('signaturePath quita el prefijo /algo', () => {
  assert.equal(signaturePath('https://api3.qoder.sh/algo/api/v2/model/list?Encode=1'), '/api/v2/model/list')
  assert.equal(signaturePath('https://api3.qoder.sh/api/v2/model/list'), '/api/v2/model/list')
})

test('la firma COSY cubre payload, clave, fecha, cuerpo y ruta', () => {
  const body = encodeBody(Buffer.from('{"a":1}'))
  const url = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1'
  const headers = authHeaders(body, url, CREDENTIAL)
  const cosy = headers.Authorization.replace(/^Bearer COSY\./, '')
  const separator = cosy.lastIndexOf('.')
  const payload = cosy.slice(0, separator)
  const signature = cosy.slice(separator + 1)
  const expected = createHash('md5')
    .update(payload)
    .update('\n')
    .update(headers['Cosy-Key'])
    .update('\n')
    .update(headers['Cosy-Date'])
    .update('\n')
    .update(body)
    .update('\n')
    .update('/api/v2/service/pro/sse/agent_chat_generation')
    .digest('hex')
  assert.equal(signature, expected)
  assert.equal(headers['Cosy-User'], 'usuario-1')
  assert.equal(headers['Cosy-Bodylength'], String(body.length))
  assert.equal(headers['Cosy-Bodyhash'], createHash('md5').update(body).digest('hex'))
  assert.equal(headers['Cosy-Machineos'], MACHINE_OS)
  assert.equal(headers['Cosy-Sigpath'], '/api/v2/service/pro/sse/agent_chat_generation')
  // El token real de Qoder viaja cifrado dentro del payload, no en claro.
  assert.ok(!JSON.stringify(headers).includes('dt-token'))
  const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  assert.equal(decoded.version, 'v1')
  assert.ok(decoded.info.length > 0)
})

test('toQoderMessages colapsa system/developer y conserva el bucle de herramientas', () => {
  const messages = [
    { role: 'system', content: 'eres un agente' },
    { role: 'developer', content: [{ type: 'text', text: 'reglas' }] },
    { role: 'user', content: 'hola' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"uname"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'Darwin' },
  ]
  const out = toQoderMessages(messages)
  assert.deepEqual(out[0], { role: 'system', content: 'eres un agente' })
  assert.deepEqual(out[1], { role: 'system', content: 'reglas' })
  assert.deepEqual(out[2], { role: 'user', content: 'hola' })
  assert.equal(out[3].tool_calls[0].id, 'call-1')
  assert.equal(out[3].tool_calls[0].function.arguments, '{"command":"uname"}')
  assert.deepEqual(out[4], { role: 'tool', tool_call_id: 'call-1', content: 'Darwin' })
})

test('toQoderMessages convierte imágenes a image_url y no pierde el texto', () => {
  const out = toQoderMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'mira' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ])
  assert.equal(out[0].content[0].text, 'mira')
  assert.equal(out[0].content[1].image_url.url, 'data:image/png;base64,AAAA')
})

test('un tool_call sin id es un error explícito, no un mensaje a medias', () => {
  assert.throws(
    () => toQoderMessages([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'x' } }] }]),
    /no tiene id/,
  )
  assert.throws(
    () => toQoderMessages([{ role: 'tool', content: 'x' }]),
    /tool_call_id/,
  )
})

test('toQoderTools acepta la forma OpenAI y la forma simple', () => {
  const openai = toQoderTools([
    { type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object' } } },
  ])
  assert.equal(openai[0].function.name, 'a')
  const simple = toQoderTools([{ name: 'b', description: 'd2', parameters: { type: 'object', properties: {} } }])
  assert.equal(simple[0].function.name, 'b')
  assert.deepEqual(toQoderTools(undefined), [])
  assert.throws(() => toQoderTools([{ description: 'sin nombre' }]), /no tiene nombre/)
})

test('el clasificador distingue cupo diario, cola, sesión caducada y desconocido', () => {
  assert.equal(classifyUpstreamError({}, '110', 'Billing daily count exceeded').kind, 'daily-limit')
  assert.equal(classifyUpstreamError({}, '10605', 'queued').kind, 'rate-limit')
  assert.equal(classifyUpstreamError({}, '105', 'TOKEN_EXPIRE').kind, 'sign-in-expired')
  assert.equal(classifyUpstreamError({}, '500', 'Login expired').kind, 'sign-in-expired')
  const queue = classifyUpstreamError({}, '9', '{"isQueued":false,"retryAfterSeconds":7,"serviceAvailable":true}')
  assert.equal(queue.kind, 'rate-limit')
  assert.equal(queue.retryAfterSeconds, 7)
  assert.equal(classifyUpstreamError({}, '999', 'algo raro').kind, 'upstream')
})

test('el cupo diario gana a la cola aunque el mensaje traiga marcas de cola', () => {
  const payload = JSON.stringify({ message: JSON.stringify({ isQueued: false, retryAfterSeconds: 7350, serviceAvailable: false }) })
  const result = classifyUpstreamError({}, '110', payload)
  assert.equal(result.kind, 'daily-limit')
  assert.equal(result.retryAfterSeconds, 7350)
})

test('isStaleCredentialError reconoce la marca y el texto', () => {
  assert.equal(isStaleCredentialError({ signInExpired: true }), true)
  assert.equal(isStaleCredentialError(new Error('sign-in is no longer valid')), true)
  assert.equal(isStaleCredentialError(new Error('otra cosa')), false)
})

test('el presupuesto de cola nunca se pasa de lo que queda', () => {
  const error = { retryable: true, retryAfterSeconds: 30 }
  assert.equal(queueWaitFor(error, 0, 1) <= 30000, true)
  assert.equal(queueWaitFor(error, QUEUE_WAIT_BUDGET_MS - 500, 1) <= 500, true)
  assert.equal(queueWaitFor(error, QUEUE_WAIT_BUDGET_MS + 1000, 1), undefined)
  assert.equal(queueWaitFor({ retryable: false }, 0, 1), undefined)
})

test('un sobre de catálogo desconocido se eleva como cambio de protocolo', () => {
  assert.throws(() => readModelCatalogShape({ models: [] }), ProtocolShapeChangedError)
  assert.throws(() => readModelCatalogShape([]), /no es un sobre|sobre de grupos|array/)
  assert.deepEqual(readModelCatalogShape({ chat: [] }), [])
})
