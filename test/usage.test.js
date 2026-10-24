import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkinStateFrom,
  claimableCampaignOf,
  normalizeClaimResult,
  normalizeDedicatedPackage,
  normalizeQuotaBucket,
  toEpochMs,
} from '../lib/usage.js'

const CAMPAIGNS = {
  claimable: false,
  campaigns: [
    {
      campaignId: 'view-1',
      actionType: 'VIEW_DETAILS',
      claimStatus: 'CLAIMED',
      startAt: 1_700_000_000,
      endAt: 1_900_000_000,
      placements: [{ type: 'USAGE', content: { en: { title: 'Banner' } } }],
    },
    {
      campaignId: 'claim-1',
      campaignKey: 'act-1',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMED',
      startAt: 1_700_000_000,
      endAt: 1_900_000_000,
      benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
      placements: [{ type: 'USAGE', content: { es: { title: 'x' }, en: { title: 'Claim 100 Credits' } } }],
    },
  ],
}

test('toEpochMs acepta segundos, milisegundos y RFC 3339', () => {
  assert.equal(toEpochMs(1_700_000_000), 1_700_000_000_000)
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(toEpochMs('2026-10-24T00:00:00Z'), Date.parse('2026-10-24T00:00:00Z'))
  assert.equal(toEpochMs(undefined), undefined)
})

test('la cuota se normaliza y rechaza totales inútiles', () => {
  assert.deepEqual(normalizeQuotaBucket({ total: 400, used: 344 }), {
    total: 400,
    used: 344,
    remaining: 56,
    percentage: 0.86,
    unit: 'credits',
  })
  assert.equal(normalizeQuotaBucket({ total: 0 }), undefined)
  assert.equal(normalizeQuotaBucket(null), undefined)
})

test('los paquetes por modelo requieren id y total', () => {
  const pack = normalizeDedicatedPackage({ id: 'qwen', name: 'Qwen', total: 2000, used: 598, expiresAt: 1_800_000_000 })
  assert.equal(pack.remaining, 1402)
  assert.equal(pack.expiresAt, 1_800_000_000_000)
  assert.equal(normalizeDedicatedPackage({ id: '', total: 10 }), undefined)
  assert.equal(normalizeDedicatedPackage({ id: 'x', total: 0 }), undefined)
})

test('la campaña que paga se elige por actionType, no por estado', () => {
  const campaign = claimableCampaignOf(CAMPAIGNS, 1_800_000_000_000)
  assert.equal(campaign.campaignId, 'claim-1')
  assert.equal(claimableCampaignOf(CAMPAIGNS, 2_000_000_000_000), undefined, 'fuera de ventana no hay ronda')
  assert.equal(claimableCampaignOf({ campaigns: [] }), undefined)
})

test('el estado del registro distingue disponible de cobrado', () => {
  const pending = structuredClone(CAMPAIGNS)
  pending.campaigns[1].claimStatus = 'PENDING'
  assert.deepEqual(checkinStateFrom(pending, 1_800_000_000_000), {
    active: true,
    todayCheckedIn: false,
    amount: 100,
    unit: 'credits',
    validDays: 30,
    endsAt: 1_900_000_000_000,
  })
  assert.deepEqual(checkinStateFrom(CAMPAIGNS, 1_800_000_000_000), {
    active: true,
    todayCheckedIn: true,
    amount: 100,
    unit: 'credits',
    validDays: 30,
    endsAt: 1_900_000_000_000,
  })
  assert.deepEqual(checkinStateFrom({ campaigns: [] }), { active: false, todayCheckedIn: false })
})

test('un cobro repetido no inventa una ganancia', () => {
  const replayed = normalizeClaimResult({ replayed: true, status: 'CLAIMED', benefit: { amount: 100 } }, undefined)
  assert.equal(replayed.claimed, true)
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.amount, undefined, 'replayed no otorga nada')

  const fresh = normalizeClaimResult({ status: 'CLAIMED', benefit: { amount: 100 } }, undefined)
  assert.equal(fresh.amount, 100)
})
