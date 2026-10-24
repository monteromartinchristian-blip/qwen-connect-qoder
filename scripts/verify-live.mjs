#!/usr/bin/env node
/**
 * Verificación viva del puente contra el gateway real de Qoder.
 *
 * No forma parte de `npm test`: toca la red, consume cupo de la cuenta y
 * depende de que Qwen Code esté instalado. Comprueba, en orden:
 *
 *   1. el puente responde en loopback con su bearer;
 *   2. `/v1/models` publica el catálogo;
 *   3. un turno simple devuelve contenido;
 *   4. un turno con herramientas produce `tool_calls`;
 *   5. el turno siguiente, con el resultado de la herramienta, cierra con texto.
 *
 * Uso: node scripts/verify-live.mjs [--model qoder/qfmodel]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const modelFlag = args.indexOf('--model')
const MODEL = modelFlag >= 0 ? args[modelFlag + 1] : 'qoder/qfmodel'

const config = JSON.parse(readFileSync(join(homedir(), '.qwen-connect-qoder', 'bridge.json'), 'utf8'))
const results = []

function record(check, status, detail) {
  results.push({ check, status, detail })
  console.log(`${status.padEnd(5)} ${check.padEnd(28)} ${detail}`)
}

async function post(body, { attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    })
    if (response.status === 503 && attempt < attempts) {
      const hint = Number(response.headers.get('retry-after') ?? 5)
      const waitMs = Math.min(Math.max(hint, 1), 20) * 1000
      console.log(`      · cola de Qoder, reintento en ${waitMs / 1000}s`)
      await response.text()
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      continue
    }
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status} — ${text.slice(0, 300)}`)
    return JSON.parse(text)
  }
  throw new Error('sin respuesta tras los reintentos')
}

const tool = {
  type: 'function',
  function: {
    name: 'run_shell',
    description: 'Ejecuta un comando de shell y devuelve su salida',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}

try {
  const health = await fetch(`http://127.0.0.1:${config.port}/healthz`, {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(3000),
  })
  if (!health.ok) throw new Error(`healthz HTTP ${health.status}`)
  const payload = await health.json()
  record('puente responde', 'PASS', `127.0.0.1:${config.port} · ${payload.models} modelos`)

  const models = await fetch(`http://127.0.0.1:${config.port}/v1/models`, {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(5000),
  })
  const list = await models.json()
  const ids = (list.data ?? []).map((entry) => entry.id)
  if (ids.length === 0) throw new Error('/v1/models no publica modelos')
  record('catálogo', 'PASS', `${ids.length} modelos · ${ids.slice(0, 3).join(', ')}…`)
  if (!ids.includes(MODEL)) throw new Error(`el modelo ${MODEL} no está en el catálogo`)

  const simple = await post({
    model: MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'Responde solo con la palabra: hola' }],
  })
  const simpleText = simple.choices?.[0]?.message?.content ?? ''
  if (simpleText.trim().length === 0) throw new Error('turno simple sin contenido')
  record('turno simple', 'PASS', `${JSON.stringify(simpleText.slice(0, 40))} · ${simple.usage?.total_tokens ?? '?'} tokens`)

  const first = await post({
    model: MODEL,
    stream: false,
    messages: [{ role: 'user', content: 'Usa la herramienta run_shell para ejecutar `uname -s`. No lo respondas de memoria.' }],
    tools: [tool],
  })
  const calls = first.choices?.[0]?.message?.tool_calls ?? []
  if (calls.length === 0) throw new Error('el modelo no pidió la herramienta')
  record('tool_calls', 'PASS', `${calls[0].function.name}(${calls[0].function.arguments.slice(0, 60)})`)

  const second = await post({
    model: MODEL,
    stream: false,
    messages: [
      { role: 'user', content: 'Usa la herramienta run_shell para ejecutar `uname -s`. No lo respondas de memoria.' },
      { role: 'assistant', content: '', tool_calls: calls },
      { role: 'tool', tool_call_id: calls[0].id, content: 'Darwin' },
    ],
    tools: [tool],
  })
  const finalText = second.choices?.[0]?.message?.content ?? ''
  if (finalText.trim().length === 0) throw new Error('el segundo turno no cerró con texto')
  record('bucle de herramientas', 'PASS', JSON.stringify(finalText.slice(0, 80)))

  console.log('\nVEREDICTO: PASS — el puente habla con Qoder y el bucle de herramientas cierra.')
} catch (error) {
  record('verificación', 'FAIL', String(error?.message ?? error))
  console.log('\nVEREDICTO: FAIL — revisa el detalle anterior.')
  process.exitCode = 1
}
