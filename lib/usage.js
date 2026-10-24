/**
 * Consumo, campañas y registro diario de la cuenta Qoder.
 *
 * Son las rutas que alimentan el panel «mi uso» del IDE. Se leen del host
 * OpenAPI con el token de la sesión; ninguna escribe salvo el registro diario,
 * que solo se ejecuta cuando el usuario lo pide.
 *
 * @module qwen-connect-qoder/usage
 */
import { openApiHeaders } from './upstream.js'

/** Tipo de campaña que reparte créditos. */
export const CLAIM_BENEFIT_ACTION = 'CLAIM_BENEFIT'
/** Estado de una ronda ya cobrada. */
export const CLAIMED_STATUS = 'CLAIMED'

/** Convierte segundos, milisegundos o RFC 3339 a epoch en milisegundos. */
export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && !value.includes('-')) return numeric > 1e12 ? numeric : numeric * 1000
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** URL del panel de uso (presentación) y de la cuota simple. */
function usagePresentationUrl(region) {
  return `${region.openApiUrl}/sash/api/v2/me/usage`
}
function usageUrl(region) {
  return `${region.openApiUrl}/api/v2/quota/usage`
}
function campaignsUrl(region) {
  return `${region.openApiUrl}/sash/api/v1/me/campaigns`
}
function claimCampaignUrl(region, campaignId) {
  return `${region.openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`
}

/** Parsea JSON informando del content-type cuando falla. */
async function readJson(response, context) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    const contentType = response.headers.get('content-type') ?? 'sin content-type'
    throw new Error(`${context}: la respuesta no es JSON válido (${contentType}) — ${text.slice(0, 200)}`)
  }
}

/** Normaliza un tramo de cuota a `{ total, used, remaining, percentage, unit }`. */
export function normalizeQuotaBucket(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const total = Number(value.total)
  const used = Number(value.used)
  if (!Number.isFinite(total) || total <= 0) return undefined
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0
  const remainingRaw = Number(value.remaining)
  const remaining = Number.isFinite(remainingRaw) ? Math.max(0, remainingRaw) : Math.max(0, total - safeUsed)
  const percentageRaw = Number(value.percentage)
  const percentage = Number.isFinite(percentageRaw)
    ? percentageRaw > 1
      ? percentageRaw / 100
      : percentageRaw
    : safeUsed / total
  return {
    total,
    used: safeUsed,
    remaining,
    percentage: Math.min(1, Math.max(0, percentage)),
    unit: typeof value.unit === 'string' && value.unit.length > 0 ? value.unit : 'credits',
  }
}

/** Normaliza un paquete de recursos dedicado a un modelo. */
export function normalizeDedicatedPackage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const total = Number(value.total)
  if (id === '' || !Number.isFinite(total) || total <= 0) return undefined
  const used = Number(value.used)
  const remainingRaw = Number(value.remaining)
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0
  const remaining = Number.isFinite(remainingRaw) ? Math.max(0, remainingRaw) : Math.max(0, total - safeUsed)
  const percentageRaw = Number(value.percentage)
  const percentage = Number.isFinite(percentageRaw)
    ? percentageRaw > 1
      ? percentageRaw / 100
      : percentageRaw
    : safeUsed / total
  const expiresAt = toEpochMs(value.expiresAt)
  return {
    id,
    name: typeof value.name === 'string' ? value.name : '',
    description: typeof value.description === 'string' ? value.description : '',
    total,
    used: safeUsed,
    remaining,
    percentage: Math.min(1, Math.max(0, percentage)),
    unit: typeof value.unit === 'string' && value.unit.length > 0 ? value.unit : 'credits',
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    available: value.available !== false,
  }
}

/** Lee las campañas activas de la cuenta. */
export async function readCampaigns(region, credential, signal) {
  const response = await fetch(campaignsUrl(region), {
    method: 'GET',
    headers: openApiHeaders(credential),
    redirect: 'error',
    signal,
  })
  if (!response.ok) throw new Error(`Qoder campaigns failed: HTTP ${response.status}`)
  return readJson(response, 'Qoder campaigns')
}

/** Proyecta las campañas a filas legibles. */
export function projectCampaignRows(payload) {
  const list = Array.isArray(payload?.campaigns) ? payload.campaigns : []
  const rows = []
  for (const campaign of list) {
    if (campaign === null || typeof campaign !== 'object') continue
    const placements = Array.isArray(campaign?.placements) ? campaign.placements : []
    const usage = placements.find((entry) => entry?.type === 'USAGE')
    if (usage === undefined) continue
    const content = usage.content?.zh ?? usage.content?.['zh-CN'] ?? usage.content?.en ?? {}
    const endsAt = toEpochMs(campaign.endAt)
    rows.push({
      key: String(campaign.campaignKey ?? campaign.campaignId ?? ''),
      title: typeof content.title === 'string' ? content.title : '',
      description: typeof content.description === 'string' ? content.description : '',
      detailUrl: typeof content.detailUrl === 'string' ? content.detailUrl : '',
      ...(endsAt !== undefined ? { endsAt } : {}),
    })
  }
  return rows
}

/** ¿La ventana de esta campaña está abierta ahora? */
function windowOpenAt(campaign, nowMs) {
  const startAt = toEpochMs(campaign?.startAt ?? campaign?.beginAt)
  const endAt = toEpochMs(campaign?.endAt)
  if (startAt !== undefined && nowMs < startAt) return false
  if (endAt !== undefined && nowMs > endAt) return false
  return true
}

/**
 * La campaña que paga y está abierta ahora mismo.
 *
 * `actionType` filtra la promoción de suscripción que la misma cuenta lleva y
 * que también dice `CLAIMED` sin tener beneficio; el estado decide si esta
 * ronda ya se cobró. El `claimable` de nivel superior no sirve: es `false`
 * tanto para «ya cobrado» como para «no hay ronda».
 */
export function claimableCampaignOf(payload, nowMs = Date.now()) {
  const list = payload?.campaigns
  if (!Array.isArray(list)) return undefined
  for (const campaign of list) {
    if (campaign === null || typeof campaign !== 'object') continue
    if (campaign.actionType !== CLAIM_BENEFIT_ACTION) continue
    if (!windowOpenAt(campaign, nowMs)) continue
    return campaign
  }
  return undefined
}

/** El beneficio que pagaría una campaña. */
export function benefitOf(campaign) {
  const benefit = campaign?.benefit
  if (benefit === null || typeof benefit !== 'object') return undefined
  const amount = Number(benefit.amount)
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const validityDays = Number(benefit.validity?.days)
  return {
    amount,
    kind: typeof benefit.kind === 'string' ? benefit.kind : 'CREDITS',
    ...(Number.isFinite(validityDays) && validityDays > 0 ? { validDays: validityDays } : {}),
  }
}

/**
 * Estado del registro diario a partir del mismo cuerpo de campañas.
 *
 * @returns {{ active: boolean, todayCheckedIn: boolean, amount?: number, unit?: string, validDays?: number, endsAt?: number }}
 */
export function checkinStateFrom(payload, nowMs = Date.now()) {
  const campaign = claimableCampaignOf(payload, nowMs)
  if (campaign === undefined) return { active: false, todayCheckedIn: false }
  const benefit = benefitOf(campaign)
  const endsAt = toEpochMs(campaign.endAt)
  return {
    active: true,
    todayCheckedIn: campaign.claimStatus === CLAIMED_STATUS,
    ...(benefit !== undefined
      ? {
          amount: benefit.amount,
          unit: benefit.kind === 'CREDITS' ? 'credits' : benefit.kind.toLowerCase(),
          ...(benefit.validDays !== undefined ? { validDays: benefit.validDays } : {}),
        }
      : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
  }
}

/** Normaliza la respuesta de un registro. */
export function normalizeClaimResult(payload, campaign) {
  const body = payload?.data !== null && typeof payload?.data === 'object' ? payload.data : payload
  const status = typeof body?.status === 'string' ? body.status : ''
  const replayed = body?.replayed === true
  const granted = status === CLAIMED_STATUS || replayed || body?.success === true
  const amountValue = Number(body?.benefit?.amount ?? benefitOf(campaign)?.amount)
  const expiresAt = toEpochMs(body?.expiresAt)
  return {
    claimed: granted,
    replayed,
    ...(!replayed && Number.isFinite(amountValue) && amountValue > 0 ? { amount: amountValue } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

/**
 * Reclama la ronda vigente.
 *
 * Vuelve a leer las campañas justo antes de reclamar: la ronda diaria cambia de
 * id cada día, así que un id recordado de una lectura anterior es de la ronda
 * pasada.
 */
export async function claimDailyBenefit(region, credential, signal) {
  const raw = await readCampaigns(region, credential, signal)
  const campaign = claimableCampaignOf(raw)
  if (campaign === undefined) {
    return { claimed: false, replayed: false, reason: 'no hay ronda de registro activa' }
  }
  if (campaign.claimStatus === CLAIMED_STATUS) {
    return { claimed: false, replayed: true, reason: 'la ronda de hoy ya estaba cobrada' }
  }
  const response = await fetch(claimCampaignUrl(region, campaign.campaignId ?? campaign.campaignKey), {
    method: 'POST',
    headers: { ...openApiHeaders(credential), 'Content-Type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Qoder check-in failed: HTTP ${response.status} ${text.slice(0, 200)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Qoder check-in: la respuesta no es JSON')
  }
  return { ...normalizeClaimResult(payload, campaign), reason: undefined }
}

/**
 * Lee el consumo de la cuenta.
 *
 * La ruta de presentación trae los paquetes por modelo; la de cuota es más
 * antigua y estrecha. Se intenta la primera y se cae a la segunda.
 *
 * @returns {object|undefined} `undefined` si ninguna de las dos respondió con datos.
 */
export async function fetchUsage(region, credential, signal) {
  const headers = openApiHeaders(credential)
  const read = async (url) => {
    const response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return readJson(response, 'Qoder usage')
  }

  let payload
  let source = 'presentation'
  try {
    payload = await read(usagePresentationUrl(region))
  } catch (error) {
    if (signal?.aborted) throw error
    source = 'quota'
    payload = await read(usageUrl(region))
  }

  const usage = payload?.qoderUsage ?? payload?.data ?? payload
  if (usage === null || typeof usage !== 'object') return undefined

  const userQuota = normalizeQuotaBucket(usage.user_quota ?? usage.userQuota)
  const addOnQuota = normalizeQuotaBucket(usage.add_on_quota ?? usage.addOnQuota)
  const rawPackages = usage.dedicated_resource_packages ?? usage.dedicatedResourcePackages
  const dedicatedPackages = Array.isArray(rawPackages)
    ? rawPackages.map(normalizeDedicatedPackage).filter((entry) => entry !== undefined)
    : []

  let campaigns = []
  let checkin
  try {
    const raw = await readCampaigns(region, credential, signal)
    campaigns = projectCampaignRows(raw)
    checkin = checkinStateFrom(raw)
  } catch (error) {
    if (signal?.aborted) throw error
  }

  const expiresAt = toEpochMs(usage.expires_at ?? usage.expiresAt)
  if (userQuota === undefined && addOnQuota === undefined && dedicatedPackages.length === 0) return undefined

  return {
    displayMode: typeof payload?.displayMode === 'string' ? payload.displayMode : 'qoder',
    userType: String(usage.user_type ?? usage.userType ?? ''),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    upgradeUrl: String(usage.upgrade_url ?? usage.upgradeUrl ?? ''),
    ...(userQuota !== undefined ? { userQuota } : {}),
    ...(addOnQuota !== undefined ? { addOnQuota } : {}),
    dedicatedPackages,
    campaigns,
    ...(checkin !== undefined ? { checkin } : {}),
    isQuotaExceeded: (usage.is_quota_exceeded ?? usage.isQuotaExceeded) === true,
    totalPercentage: Number(usage.total_usage_percentage ?? usage.totalUsagePercentage) || 0,
    source,
  }
}
