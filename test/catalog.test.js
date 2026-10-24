import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog, toCatalogEntry } from '../lib/catalog.js'
import { regionById } from '../lib/regions.js'

/** Respuesta de catálogo mínima con la forma real del gateway. */
function catalogResponse(chat) {
  return new Response(JSON.stringify({ chat }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const RAW_MODEL = {
  key: 'qmodel_38max',
  display_name: 'Qwen3.8-Max',
  enable: true,
  is_vl: true,
  is_reasoning: true,
  is_default: true,
  max_input_tokens: 200000,
  context_config: { '200K': { token_count: 200000, is_default: true } },
  thinking_config: { enabled: { efforts: { low: {}, medium: {}, xhigh: {} } } },
}

test('toCatalogEntry prefija el id con la región y anuncia la ventana mayor', () => {
  const entry = toCatalogEntry(
    {
      key: 'qmodel_38max',
      name: 'Qwen3.8-Max',
      isVL: true,
      isReasoning: true,
      alwaysThinking: false,
      effortLevels: ['low', 'medium'],
      defaultContextWindow: 200000,
      contextOptions: [200000, 400000, 1000000],
      maxInputTokens: 200000,
      isDefault: true,
      isFree: false,
    },
    regionById('qoder'),
  )
  assert.equal(entry.id, 'qoder/qmodel_38max')
  assert.equal(entry.upstreamKey, 'qmodel_38max')
  assert.equal(entry.name, 'Qoder · Qwen3.8-Max')
  assert.equal(entry.vision, true)
  assert.equal(entry.alwaysThinking, false)
  assert.equal(entry.contextWindow, 1000000, 'se anuncia la ventana máxima publicada')
})

test('un modelo con una sola ventana conserva ese valor', () => {
  const entry = toCatalogEntry(
    {
      key: 'efficient',
      name: 'Efficient',
      isVL: false,
      isReasoning: false,
      effortLevels: [],
      defaultContextWindow: 200000,
      contextOptions: [200000],
      maxInputTokens: 200000,
    },
    regionById('qoder'),
  )
  assert.equal(entry.contextWindow, 200000)
})

test('el catálogo se refresca desde el gateway y se guarda en disco', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qcq-catalog-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => catalogResponse([RAW_MODEL, { key: 'oculto', display_name: 'X', enable: false }])
  try {
    const credentials = { get: async () => ({ token: 't', userID: 'u', machineID: 'm' }) }
    const catalog = new Catalog({
      regions: [regionById('qoder')],
      credentials,
      env: { QWEN_QODER_HOME: home },
    })
    const result = await catalog.refreshIfNeeded({ force: true })
    assert.equal(result.error, undefined)
    assert.equal(catalog.list().length, 1)
    assert.equal(catalog.list()[0].id, 'qoder/qmodel_38max')
    assert.equal(catalog.list()[0].effortLevels.join(','), 'low,medium,xhigh')

    // Otra instancia lee la copia del disco sin llamar al gateway.
    globalThis.fetch = async () => {
      throw new Error('no debería llamarse')
    }
    const second = new Catalog({ regions: [regionById('qoder')], credentials, env: { QWEN_QODER_HOME: home } })
    assert.equal(second.list().length, 1)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(home, { recursive: true, force: true })
  }
})

test('un fallo de red conserva la última copia buena y lo reporta', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qcq-catalog-'))
  const originalFetch = globalThis.fetch
  try {
    const credentials = { get: async () => ({ token: 't' }) }
    globalThis.fetch = async () => catalogResponse([RAW_MODEL])
    const catalog = new Catalog({ regions: [regionById('qoder')], credentials, env: { QWEN_QODER_HOME: home } })
    await catalog.refreshIfNeeded({ force: true })
    assert.equal(catalog.list().length, 1)

    globalThis.fetch = async () => new Response('boom', { status: 500 })
    const result = await catalog.refreshIfNeeded({ force: true })
    assert.ok(result.error.includes('500'))
    assert.equal(catalog.list().length, 1, 'los modelos ya conocidos sobreviven')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(home, { recursive: true, force: true })
  }
})

test('una región sin credencial no aporta modelos pero no rompe el refresco', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qcq-catalog-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => catalogResponse([RAW_MODEL])
  try {
    const credentials = { get: async () => undefined }
    const catalog = new Catalog({ regions: [regionById('qoder')], credentials, env: { QWEN_QODER_HOME: home } })
    const result = await catalog.refreshIfNeeded({ force: true })
    assert.equal(catalog.list().length, 0)
    assert.match(result.error, /credencial/)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(home, { recursive: true, force: true })
  }
})
