import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStatusLine, formatStatusLine, STATUSLINE_TTL_MS } from '../lib/statusline.js'
import { applyStatusLine, isOwnStatusLine, removeStatusLine } from '../lib/qwen-settings.js'
import { regionById } from '../lib/regions.js'

const USAGE = {
  userType: 'personal_standard',
  addOnQuota: { total: 400, used: 344, remaining: 56, percentage: 0.86, unit: 'credits' },
  userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
  dedicatedPackages: [],
  campaigns: [],
  checkin: { active: true, todayCheckedIn: false, amount: 100, unit: 'credits' },
  isQuotaExceeded: false,
}

const CAMPAIGNS = {
  claimable: false,
  campaigns: [
    {
      campaignId: 'claim-1',
      campaignKey: 'act-1',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'PENDING',
      startAt: 1_700_000_000,
      endAt: 4_000_000_000,
      benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
      placements: [{ type: 'USAGE', content: { en: { title: 'Claim 100 Credits' } } }],
    },
  ],
}

/** Respuesta del gateway según la ruta. */
function gatewayResponse(url) {
  const body = String(url).includes('/campaigns') ? CAMPAIGNS : USAGE
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('la línea muestra saldo, porcentaje y estado del registro', () => {
  assert.equal(
    formatStatusLine(USAGE, { regionName: 'Qoder' }),
    'Qoder 56/400 · 86% usado · check-in disponible',
  )
  assert.equal(
    formatStatusLine({ ...USAGE, checkin: { active: true, todayCheckedIn: true } }),
    'Qoder 56/400 · 86% usado · check-in hecho',
  )
  assert.equal(
    formatStatusLine({ ...USAGE, isQuotaExceeded: true }),
    'Qoder 56/400 · ¡cuota agotada! · check-in disponible',
  )
  assert.equal(formatStatusLine({ ...USAGE, checkin: { active: false, todayCheckedIn: false } }), 'Qoder 56/400 · 86% usado')
  assert.match(formatStatusLine(undefined), /sin datos/)
})

test('sin cuota publicada lo dice en vez de inventar un cero', () => {
  assert.match(formatStatusLine({ userQuota: undefined, addOnQuota: undefined }), /sin cuota/)
})

test('la caché evita otra lectura dentro del TTL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qcq-status-'))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    calls += 1
    return gatewayResponse(url)
  }
  try {
    const env = { QWEN_QODER_HOME: home }
    const credentials = { get: async () => ({ token: 't', userID: 'u', machineID: 'm' }) }
    const regions = [regionById('qoder')]
    const first = await buildStatusLine({ env, credentials, regions, now: 1000 })
    assert.equal(first.cached, false)
    assert.equal(first.line, 'Qoder 56/400 · 86% usado · check-in disponible')
    const callsAfterFirst = calls

    const second = await buildStatusLine({ env, credentials, regions, now: 1000 + STATUSLINE_TTL_MS - 1 })
    assert.equal(second.cached, true)
    assert.equal(second.line, first.line)
    assert.equal(calls, callsAfterFirst, 'dentro del TTL no se vuelve a llamar')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(home, { recursive: true, force: true })
  }
})

test('si la red falla se devuelve la última línea buena marcada', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qcq-status-'))
  const originalFetch = globalThis.fetch
  try {
    const env = { QWEN_QODER_HOME: home }
    const credentials = { get: async () => ({ token: 't' }) }
    const regions = [regionById('qoder')]
    globalThis.fetch = async (url) => gatewayResponse(url)
    await buildStatusLine({ env, credentials, regions, now: 1000 })

    globalThis.fetch = async () => {
      throw new Error('sin red')
    }
    const stale = await buildStatusLine({ env, credentials, regions, now: 1000 + STATUSLINE_TTL_MS + 1 })
    assert.equal(stale.cached, true)
    assert.match(stale.line, /\(\?\)$/)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(home, { recursive: true, force: true })
  }
})

test('la línea de estado no pisa una que haya puesto el usuario', () => {
  const mine = { ui: { statusLine: { type: 'command', command: 'date' } } }
  const skipped = applyStatusLine(mine, '"node" "/ruta/qwen-qoder.js" statusline')
  assert.equal(skipped.applied, false)
  assert.equal(skipped.settings.ui.statusLine.command, 'date')

  const applied = applyStatusLine({ ui: { theme: 'Qwen Dark' } }, '"node" "/ruta/qwen-qoder.js" statusline')
  assert.equal(applied.applied, true)
  assert.equal(applied.settings.ui.theme, 'Qwen Dark')
  assert.equal(applied.settings.ui.statusLine.refreshInterval, 60)
  assert.equal(isOwnStatusLine(applied.settings.ui.statusLine), true)

  // Reaplicar no duplica nada y retirar solo borra la nuestra.
  const again = applyStatusLine(applied.settings, '"node" "/ruta/qwen-qoder.js" statusline')
  assert.deepEqual(again.settings.ui.statusLine, applied.settings.ui.statusLine)
  const removed = removeStatusLine(again.settings)
  assert.equal(removed.removed, true)
  assert.equal(removed.settings.ui.statusLine, undefined)
  assert.equal(removeStatusLine(mine).removed, false)
})
