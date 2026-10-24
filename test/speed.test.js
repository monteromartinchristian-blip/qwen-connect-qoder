import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCount, formatSpeedLine, summarizeSession } from '../bin/qwen-turn-speed.js'
import { applySpeedHook, hasSpeedHook, removeSpeedHook } from '../lib/qwen-settings.js'

const ENTRIES = [
  { sessionId: 's1', inputTokens: 1000, outputTokens: 200, cachedTokens: 900, totalTokens: 1200, apiDurationMs: 2000 },
  { sessionId: 's1', inputTokens: 2000, outputTokens: 300, cachedTokens: 1900, totalTokens: 2300, apiDurationMs: 3000 },
  { sessionId: 'otra', inputTokens: 999, outputTokens: 999, cachedTokens: 0, totalTokens: 1998, apiDurationMs: 1000 },
]

test('el resumen suma solo la sesión pedida', () => {
  assert.deepEqual(summarizeSession(ENTRIES, 's1'), {
    requests: 2,
    inputTokens: 3000,
    outputTokens: 500,
    cachedTokens: 2800,
    totalTokens: 3500,
    durationMs: 5000,
  })
  assert.equal(summarizeSession(ENTRIES, 'desconocida').requests, 0)
})

test('la línea muestra velocidad media, tokens y caché', () => {
  const line = formatSpeedLine(summarizeSession(ENTRIES, 's1'))
  assert.equal(line, '⏱ 100 tok/s · 3.5k tok · caché 93% · 2 peticiones')
})

test('sin duración no se inventa una velocidad', () => {
  const line = formatSpeedLine({
    requests: 1,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    totalTokens: 15,
    durationMs: 0,
  })
  assert.equal(line, '⏱ 15 tok · caché 0% · 1 petición')
})

test('sin peticiones no hay línea', () => {
  assert.equal(formatSpeedLine(summarizeSession([], 's1')), undefined)
})

test('formatCount abrevia millones y miles', () => {
  assert.equal(formatCount(20_300_000), '20.3M')
  assert.equal(formatCount(14_700), '15k')
  assert.equal(formatCount(987), '987')
  assert.equal(formatCount(Number.NaN), '0')
})

test('el hook se instala sin tocar otros hooks y se retira solo el nuestro', () => {
  const settings = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'echo otro' }] },
      ],
    },
  }
  const command = '"/opt/homebrew/bin/node" "/ruta/qwen-turn-speed.js"'
  const applied = applySpeedHook(settings, command)
  assert.equal(hasSpeedHook(applied.settings), true)
  assert.equal(applied.settings.hooks.Stop.length, 2)
  assert.equal(applied.settings.hooks.Stop[0].hooks[0].command, 'echo otro')
  // Idempotente.
  const again = applySpeedHook(applied.settings, command)
  assert.equal(again.settings.hooks.Stop.length, 2)

  const removed = removeSpeedHook(again.settings)
  assert.equal(removed.removed, true)
  assert.equal(hasSpeedHook(removed.settings), false)
  assert.equal(removed.settings.hooks.Stop.length, 1)
  assert.equal(removeSpeedHook(removed.settings).removed, false)
})

test('sin hooks previos el retiro no crea una clave vacía problemática', () => {
  const removed = removeSpeedHook({ env: {} })
  assert.equal(removed.removed, false)
  assert.equal(removed.settings.env.A, undefined)
})
