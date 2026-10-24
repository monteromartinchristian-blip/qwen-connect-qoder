import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyModels,
  modelEntryFor,
  removeModels,
  writeSettings,
} from '../lib/qwen-settings.js'

const BASE_URL = 'http://127.0.0.1:17872/v1'
const MODEL = {
  id: 'qoder/qmodel_38max',
  name: 'Qoder · Qwen3.8-Max',
  region: 'qoder',
  isReasoning: true,
  alwaysThinking: false,
  effortLevels: ['xhigh', 'low', 'medium'],
  contextWindow: 200000,
  vision: true,
}

test('modelEntryFor declara esfuerzos, visión y contexto', () => {
  const entry = modelEntryFor(MODEL, { baseUrl: BASE_URL })
  assert.equal(entry.id, 'qoder/qmodel_38max')
  assert.equal(entry.baseUrl, BASE_URL)
  assert.equal(entry.wireApi, 'chat-completions')
  assert.deepEqual(entry.capabilities.reasoning, {
    profile: 'openai-effort',
    efforts: ['low', 'medium', 'xhigh'],
    defaultEffort: 'low',
  })
  assert.equal(entry.capabilities.vision, true)
  assert.equal(entry.generationConfig.contextWindowSize, 200000)
  assert.equal(entry.generationConfig.maxRetries, 1)
})

test('un modelo sin razonamiento no declara capacidad de razonamiento', () => {
  const entry = modelEntryFor({ ...MODEL, isReasoning: false, effortLevels: [] }, { baseUrl: BASE_URL })
  assert.equal(entry.capabilities?.reasoning, undefined)
})

test('las entradas del puente se añaden sin tocar otros proveedores', () => {
  const settings = {
    $version: 4,
    general: { outputLanguage: 'Spanish (Spain)' },
    modelProviders: {
      openai: [{ id: 'meta/muse-spark-1.3', baseUrl: 'https://otro/v1', envKey: 'OTRA' }],
    },
    env: { OTRA: 'x' },
  }
  const { settings: next, added, removed } = applyModels(settings, [MODEL], { baseUrl: BASE_URL, token: 'tk' })
  assert.equal(added, 1)
  assert.equal(removed, 0)
  assert.equal(next.modelProviders.openai.length, 2)
  assert.equal(next.modelProviders.openai[0].id, 'meta/muse-spark-1.3')
  assert.equal(next.modelProviders.openai[1].id, 'qoder/qmodel_38max')
  assert.equal(next.env.QWEN_QODER_API_KEY, 'tk')
  assert.equal(next.general.outputLanguage, 'Spanish (Spain)')
  // El documento original no se muta.
  assert.equal(settings.modelProviders.openai.length, 1)
})

test('reaplicar es idempotente y sustituye las entradas viejas del puente', () => {
  const first = applyModels({ $version: 4 }, [MODEL], { baseUrl: BASE_URL, token: 'tk' }).settings
  first.modelProviders.openai.push({ id: 'qoder/qfmodel', baseUrl: BASE_URL, envKey: 'X' })
  const second = applyModels(first, [MODEL], { baseUrl: BASE_URL, token: 'tk' })
  assert.equal(second.removed, 2)
  assert.equal(second.settings.modelProviders.openai.filter((entry) => entry.id.startsWith('qoder/')).length, 1)
})

test('removeModels retira solo lo del puente y su clave', () => {
  const base = applyModels(
    { modelProviders: { openai: [{ id: 'otro', baseUrl: 'https://otro/v1' }] } },
    [MODEL],
    { baseUrl: BASE_URL, token: 'tk' },
  ).settings
  const { settings, removed } = removeModels(base, { baseUrl: BASE_URL })
  assert.equal(removed, 1)
  assert.deepEqual(settings.modelProviders.openai.map((entry) => entry.id), ['otro'])
  assert.equal(settings.env.QWEN_QODER_API_KEY, undefined)
})

test('writeSettings es atómico, 0600 y solo hace copia si cambia', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qcq-settings-'))
  try {
    const path = join(dir, 'settings.json')
    const doc = { $version: 4, env: { A: 'b' } }
    const first = writeSettings(path, doc)
    assert.equal(first.changed, true)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).env.A, 'b')

    const second = writeSettings(path, doc)
    assert.equal(second.changed, false)
    assert.equal(second.backup, undefined)

    const third = writeSettings(path, { ...doc, env: { A: 'c' } })
    assert.equal(third.changed, true)
    assert.ok(third.backup !== undefined)
    assert.equal(JSON.parse(readFileSync(third.backup, 'utf8')).env.A, 'b')

    writeFileSync(path, '{ corrupto', 'utf8')
    // Un JSON corrupto no se pisa a ciegas desde `applyModels`, pero escribir un
    // documento válido sí debe poder recuperar el fichero.
    assert.equal(writeSettings(path, doc).changed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
