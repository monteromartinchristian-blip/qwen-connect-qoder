#!/usr/bin/env node
/**
 * Servidor MCP de Qoder para Qwen Code.
 *
 * Habla JSON-RPC 2.0 por stdio (un objeto por línea) y no tiene dependencias:
 * el paquete se copia a `~/.qwen/extensions/qwen-connect-qoder` y debe arrancar
 * con el Node que encuentre `run-mcp.sh`.
 *
 * No lee credenciales: pide los datos al puente local, que es el único que
 * descifra el Llavero y el que habla con el gateway.
 *
 * Herramientas: `qoder_account`, `qoder_usage`, `qoder_models`, `qoder_checkin`.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const SERVER_INFO = { name: 'qoder', version: '0.2.0' }
const PROTOCOL_VERSION = '2024-11-05'
const CONFIG_PATH = join(process.env.QWEN_QODER_HOME ?? join(homedir(), '.qwen-connect-qoder'), 'bridge.json')

/** Error con mensaje para el usuario, no una traza. */
class ToolError extends Error {}

/** Lee puerto y bearer del puente. */
function bridgeConfig() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    throw new ToolError(
      'El puente de Qoder no está instalado. Ejecuta `qwen-qoder install` (o `qwen-qoder serve`) y vuelve a intentarlo.',
    )
  }
  if (typeof parsed?.token !== 'string' || parsed.token.length === 0) {
    throw new ToolError('La configuración del puente no tiene bearer; vuelve a ejecutar `qwen-qoder install`.')
  }
  return { port: Number(parsed.port) || 17872, token: parsed.token }
}

/** Petición al puente local. */
async function api(path, options = {}) {
  const { port, token } = bridgeConfig()
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new ToolError(
      `El puente de Qoder no responde en 127.0.0.1:${port}. Arráncalo con \`qwen-qoder serve\` ` +
        'o revisa el LaunchAgent `com.qwen-connect-qoder.bridge`.',
    )
  }
  const text = await response.text()
  if (!response.ok) throw new ToolError(`El puente respondió HTTP ${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/** Formatea una cuota. */
function quota(label, value) {
  if (value === undefined || value === null) return undefined
  const percent = Math.round((Number(value.percentage) || 0) * 100)
  return `${label}: ${value.remaining}/${value.total} ${value.unit} · ${percent}% usado`
}

/** Fecha corta en es-ES. */
function date(epochMs) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return undefined
  return new Date(epochMs).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** `qoder_account`: quién está conectado y con qué plan. */
async function accountText() {
  const { regions } = await api('/account')
  if (!Array.isArray(regions) || regions.length === 0) return 'No hay ninguna región de Qoder configurada.'
  const lines = []
  for (const row of regions) {
    if (row.status !== 'ok') {
      lines.push(`**${row.displayName}**: ${row.status}${row.error ? ` · ${row.error}` : ''}`)
      continue
    }
    lines.push(`**${row.displayName}** · ${row.name || 'sin nombre'} <${row.email || 'sin correo'}>`)
    lines.push(`- Plan: ${row.userType || 'desconocido'}`)
    lines.push(`- Sesión: ${row.source === 'env-pat' ? 'PAT del entorno' : `app (${row.appName})`}`)
    if (row.expiresAt) lines.push(`- Token válido hasta: ${date(row.expiresAt) ?? 'n/d'}`)
    if (row.isQuotaExceeded) lines.push('- ⚠ Cuota agotada: el gateway rechazará peticiones')
  }
  return lines.join('\n')
}

/** `qoder_usage`: consumo, paquetes, registro diario y campañas. */
async function usageText() {
  const { regions } = await api('/usage')
  if (!Array.isArray(regions) || regions.length === 0) return 'No hay ninguna región de Qoder configurada.'
  const blocks = []
  for (const row of regions) {
    if (row.status !== 'ok') {
      blocks.push(`**${row.displayName}**: ${row.status}${row.error ? ` · ${row.error}` : ''}`)
      continue
    }
    const lines = [`**${row.displayName}** · ${row.userType || 'plan desconocido'}`]
    const quotas = [
      quota('Cuota del plan', row.userQuota),
      quota('Créditos add-on', row.addOnQuota),
      ...(row.dedicatedPackages ?? []).map((pack) => quota(pack.name || pack.id, pack)),
    ].filter((line) => line !== undefined)
    if (quotas.length === 0) lines.push('- Sin cifras de cuota publicadas')
    for (const line of quotas) lines.push(`- ${line}`)
    if (row.isQuotaExceeded) lines.push('- ⚠ Cuota agotada')
    const checkin = row.checkin
    if (checkin?.active === true) {
      lines.push(
        `- Registro diario: ${checkin.todayCheckedIn ? 'ya cobrado hoy' : '**disponible**'} · ` +
          `${checkin.amount ?? '?'} ${checkin.unit ?? 'credits'}` +
          `${checkin.validDays ? ` (válido ${checkin.validDays} días)` : ''}`,
      )
    } else {
      lines.push('- Registro diario: sin ronda activa')
    }
    if (Array.isArray(row.campaigns) && row.campaigns.length > 0) {
      lines.push(`- Campañas: ${row.campaigns.map((campaign) => campaign.title || campaign.key).join(' · ')}`)
      const link = row.campaigns.find((campaign) => campaign.detailUrl)?.detailUrl
      if (link) lines.push(`- Detalle: ${link}`)
    }
    if (row.upgradeUrl) lines.push(`- Ampliar plan: ${row.upgradeUrl}`)
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

/** `qoder_models`: catálogo con capacidades. */
async function modelsText() {
  const { models, error } = await api('/catalog')
  if (!Array.isArray(models) || models.length === 0) {
    return `El catálogo está vacío${error ? `: ${error}` : '.'}`
  }
  const groups = new Map()
  for (const model of models) {
    const list = groups.get(model.region) ?? []
    list.push(model)
    groups.set(model.region, list)
  }
  const blocks = []
  for (const [region, list] of groups) {
    blocks.push(
      `**${region}** (${list.length})\n` +
        list
          .map((model) => {
            const flags = [
              model.alwaysThinking ? 'piensa siempre' : model.isReasoning ? 'razona' : 'sin razonamiento',
              model.effortLevels?.length ? `esfuerzos ${model.effortLevels.join('/')}` : '',
              model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k contexto` : '',
              model.vision ? 'visión' : '',
            ].filter(Boolean)
            return `- \`${model.id}\` — ${model.displayName} · ${flags.join(' · ')}`
          })
          .join('\n'),
    )
  }
  return blocks.join('\n\n')
}

/** `qoder_checkin`: reclama la ronda diaria. */
async function checkinText() {
  const { regions } = await api('/checkin', { method: 'POST', body: {} })
  const lines = []
  for (const row of regions ?? []) {
    if (row.status !== 'ok') {
      lines.push(`**${row.displayName}**: ${row.status}${row.error ? ` · ${row.error}` : ''}`)
      continue
    }
    if (row.claimed === true && row.replayed !== true) {
      lines.push(`**${row.displayName}**: cobrados ${row.amount ?? 0} créditos${row.expiresAt ? ` (caducan el ${date(row.expiresAt)})` : ''}`)
    } else if (row.replayed === true) {
      lines.push(`**${row.displayName}**: la ronda de hoy ya estaba cobrada; no se ha cobrado nada más`)
    } else {
      lines.push(`**${row.displayName}**: ${row.reason ?? 'sin cambios'}`)
    }
  }
  return lines.join('\n') || 'Sin regiones que reclamar.'
}

const TOOLS = [
  {
    name: 'qoder_account',
    description:
      'Muestra la cuenta de Qoder conectada (nombre, correo, plan, caducidad del token y si la cuota está agotada).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: accountText,
  },
  {
    name: 'qoder_usage',
    description:
      'Muestra el consumo real de Qoder: cuota del plan, créditos add-on, paquetes por modelo, estado del registro diario y campañas.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: usageText,
  },
  {
    name: 'qoder_models',
    description: 'Lista los modelos de Qoder disponibles en el puente, con contexto, razonamiento y visión.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: modelsText,
  },
  {
    name: 'qoder_checkin',
    description:
      'Reclama el registro diario de Qoder (100 créditos) si la ronda de hoy está sin cobrar. Cambia estado en la cuenta: úsalo solo cuando el usuario lo pida.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: checkinText,
  },
]

/** Responde a una petición JSON-RPC. */
async function handle(message) {
  const { id, method, params } = message
  const respond = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } })

  if (method === 'initialize') {
    return respond({
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined
  if (method === 'ping') return respond({})
  if (method === 'tools/list') {
    return respond({
      tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    })
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((entry) => entry.name === params?.name)
    if (tool === undefined) return fail(-32602, `herramienta desconocida: ${params?.name}`)
    try {
      const text = await tool.run()
      return respond({ content: [{ type: 'text', text }] })
    } catch (error) {
      const text = error instanceof ToolError ? error.message : String(error?.message ?? error)
      return respond({ content: [{ type: 'text', text }], isError: true })
    }
  }
  if (method === 'resources/list') return respond({ resources: [] })
  if (method === 'prompts/list') return respond({ prompts: [] })
  return fail(-32601, `método no soportado: ${method}`)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let pending = 0
let inputClosed = false

/** Sale solo cuando la entrada se cerró y no queda ninguna respuesta en vuelo. */
function maybeExit() {
  if (inputClosed && pending === 0) process.exit(0)
}

lines.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } })}\n`)
    return
  }
  pending += 1
  handle(message)
    .then((reply) => {
      if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`)
    })
    .catch((error) => {
      process.stderr.write(`qoder-mcp: ${error?.stack ?? error}\n`)
      if (message?.id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error?.message ?? error) } })}\n`,
        )
      }
    })
    .finally(() => {
      pending -= 1
      maybeExit()
    })
})
lines.on('close', () => {
  inputClosed = true
  maybeExit()
})
