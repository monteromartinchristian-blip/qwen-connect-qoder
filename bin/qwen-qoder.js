#!/usr/bin/env node
/**
 * CLI del puente Qoder para Qwen Code.
 *
 *   qwen-qoder serve       Levanta el endpoint OpenAI-compatible.
 *   qwen-qoder install     Publica los modelos en ~/.qwen/settings.json y (en
 *                          macOS) deja el puente arrancando con la sesión.
 *   qwen-qoder models      Lista el catálogo de la cuenta.
 *   qwen-qoder doctor      Comprueba credencial, gateway, puente y ajustes.
 *   qwen-qoder status      Estado del puente en ejecución.
 *   qwen-qoder uninstall   Retira los modelos y el agente de arranque.
 *
 * @module qwen-connect-qoder/cli
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridge, enabledRegions } from '../lib/bridge.js'
import { Catalog } from '../lib/catalog.js'
import {
  baseUrlFor,
  DEFAULT_PORT,
  ENV_KEY,
  ensureConfig,
  homeDir,
  readConfig,
} from '../lib/config.js'
import { CredentialStore } from '../lib/credentials.js'
import { extensionInstalled, installExtension, removeExtension } from '../lib/extension.js'
import {
  applySpeedHook,
  hasSpeedHook,
  installIntoQwen,
  qwenSettingsPath,
  removeSpeedHook,
  statusLineCommand,
  uninstallFromQwen,
  writeSettings,
} from '../lib/qwen-settings.js'
import { buildStatusLine } from '../lib/statusline.js'
import { claimDailyBenefit, fetchUsage } from '../lib/usage.js'
import { installService, preferredNode, serviceInstalled, uninstallService } from '../lib/service.js'
import { REGIONS, regionById } from '../lib/regions.js'

const BIN_PATH = fileURLToPath(import.meta.url)
const TURN_SPEED_BIN = join(dirname(BIN_PATH), 'qwen-turn-speed.js')

/** Analiza `--clave valor`, `--clave=valor` y banderas booleanas. */
function parseArgs(argv) {
  const options = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const [name, inline] = token.slice(2).split('=')
    if (inline !== undefined) {
      options[name] = inline
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next
      i += 1
    } else {
      options[name] = true
    }
  }
  return { options, positional }
}

function numberOption(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Construye el conjunto de regiones y el catálogo sobre la configuración. */
function buildStack(config, options = {}) {
  const regions = enabledRegions(config)
  const credentials = new CredentialStore({ regions })
  const catalog = new Catalog({ regions, credentials })
  return { regions, credentials, catalog }
}

/** `serve`: levanta el puente y espera. */
async function serve(options) {
  const config = ensureConfig({
    port: numberOption(options.port, undefined),
    regions: typeof options.region === 'string' ? [options.region] : undefined,
  })
  const { regions, credentials, catalog } = buildStack(config)
  if (regions.length === 0) {
    console.error(`No hay regiones válidas en la configuración: ${config.regions.join(', ')}`)
    process.exitCode = 2
    return
  }
  const bridge = createBridge({ config, regions, credentials, catalog, log: logTo(stderrUnlessQuiet(options)) })
  await bridge.ready
  if (options.quiet !== true) {
    console.log(
      JSON.stringify({
        listening: bridge.baseUrl(),
        regions: regions.map((region) => region.id),
        models: catalog.list().length,
      }),
    )
  }
  // Calienta el catálogo sin bloquear el arranque: si el gateway tarda o falla,
  // el puente ya está sirviendo y `/v1/models` devolverá la copia en disco.
  catalog.refreshIfNeeded().catch((error) => logTo(true)(`catálogo: ${error?.message ?? error}`))
  const shutdown = async () => {
    await bridge.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/** Logger a stderr (para no contaminar el JSON de arranque). */
function logTo(enabled) {
  return enabled ? (message) => console.error(`qwen-qoder: ${message}`) : () => {}
}

function stderrUnlessQuiet(options) {
  return options.quiet !== true
}

/** `install`: catálogo, ajustes de Qwen y agente de arranque. */
async function install(options) {
  const config = ensureConfig({
    port: numberOption(options.port, undefined),
    regions: typeof options.region === 'string' ? [options.region] : undefined,
  })
  const { regions, credentials, catalog } = buildStack(config)
  const result = await catalog.refreshIfNeeded({ force: true })
  const models = catalog.list()
  if (models.length === 0) {
    console.error('No hay modelos que publicar.')
    if (result.error) console.error(`Motivo: ${result.error}`)
    const states = await credentials.describe()
    for (const state of states) {
      console.error(`  ${state.displayName}: ${state.status}${state.reason ? ` (${state.reason})` : ''}`)
    }
    process.exitCode = 1
    return
  }
  const baseUrl = baseUrlFor(config.port)
  const settings = installIntoQwen({
    models,
    baseUrl,
    token: config.token,
    path: typeof options.settings === 'string' ? options.settings : undefined,
    statusLineCommand: options['no-statusline'] === true ? undefined : statusLineCommand(preferredNode(), BIN_PATH),
  })
  let service
  if (process.platform === 'darwin' && options['no-service'] !== true) {
    service = installService({ script: BIN_PATH, port: config.port })
  }
  const extension = installExtension()
  console.log(`Modelos publicados: ${settings.added} (retirados ${settings.removed}) en ${settings.path}`)
  console.log(`Extensión de Qwen Code: ${extension.files} ficheros en ${extension.path}`)
  console.log(
    settings.statusLine?.applied === true
      ? `Barra de estado: saldo de Qoder en el pie (${statusLineCommand(preferredNode(), BIN_PATH)})`
      : `Barra de estado: no instalada${settings.statusLine?.reason ? ` · ${settings.statusLine.reason}` : ''}`,
  )
  console.log(`Endpoint: ${baseUrl}  ·  envKey: ${ENV_KEY}`)
  if (settings.changed) {
    console.log(settings.backup ? `Copia de los ajustes previos: ${settings.backup}` : 'Ajustes creados')
  } else {
    console.log('Los ajustes ya estaban al día (sin cambios)')
  }
  if (service !== undefined) {
    console.log(service.loaded ? `Agente de arranque cargado: ${service.path}` : `Agente escrito sin cargar: ${service.path}`)
  }
  console.log('Selecciona un modelo con /model dentro de Qwen Code (o -m qoder/<clave> en modo headless).')
}

/** `models`: imprime el catálogo. */
async function models(options) {
  const config = ensureConfig()
  const { catalog } = buildStack(config)
  const result = await catalog.refreshIfNeeded({ force: true })
  const list = catalog.list()
  if (options.json === true) {
    console.log(JSON.stringify({ fetchedAt: catalog.fetchedAt, error: result.error, models: list }, null, 2))
    return
  }
  if (list.length === 0) {
    console.log('No hay modelos.')
    if (result.error) console.log(`Motivo: ${result.error}`)
    process.exitCode = 1
    return
  }
  for (const model of list) {
    const flags = [
      model.isReasoning ? 'razona' : 'sin-razonamiento',
      model.alwaysThinking ? 'piensa-siempre' : '',
      model.effortLevels.length > 0 ? `esfuerzos:${model.effortLevels.join('/')}` : '',
      model.contextWindow > 0 ? `ctx:${model.contextWindow}` : '',
      model.vision ? 'visión' : '',
    ].filter(Boolean)
    console.log(`${model.id.padEnd(28)} ${model.displayName.padEnd(20)} ${flags.join(' ')}`)
  }
  if (result.error) console.log(`\nAviso: ${result.error}`)
}

/** Formatea un tramo de cuota para la terminal. */
function quotaLine(label, quota) {
  if (quota === undefined) return null
  const percent = Math.round(quota.percentage * 100)
  return `${label}: ${quota.remaining}/${quota.total} ${quota.unit} · ${percent}% usado`
}

/** `usage`: consumo real de cada región. */
async function usage(options) {
  const config = ensureConfig()
  const { regions, credentials } = buildStack(config)
  const rows = []
  for (const region of regions) {
    const credential = await credentials.get(region)
    if (!credential) {
      rows.push({ region: region.id, displayName: region.displayName, status: 'not_signed_in' })
      continue
    }
    try {
      const current = await fetchUsage(region, credential)
      rows.push({
        region: region.id,
        displayName: region.displayName,
        status: current === undefined ? 'no_data' : 'ok',
        account: { name: credential.name, email: credential.email },
        usage: current,
      })
    } catch (error) {
      rows.push({ region: region.id, displayName: region.displayName, status: 'error', error: String(error?.message ?? error) })
    }
  }
  if (options.json === true) {
    console.log(JSON.stringify({ regions: rows }, null, 2))
    return
  }
  for (const row of rows) {
    if (row.status !== 'ok') {
      console.log(`${row.displayName}: ${row.status}${row.error ? ` · ${row.error}` : ''}`)
      continue
    }
    const usage = row.usage
    console.log(`${row.displayName} · ${row.account.name} <${row.account.email}>  [${usage.userType || 'plan desconocido'}]`)
    for (const line of [
      quotaLine('  Cuota del plan', usage.userQuota),
      quotaLine('  Créditos add-on', usage.addOnQuota),
      ...usage.dedicatedPackages.map((pack) => quotaLine(`  ${pack.name || pack.id}`, pack)),
    ].filter((line) => line !== null)) {
      console.log(line)
    }
    if (usage.isQuotaExceeded) console.log('  ⚠ Cuota agotada: el gateway rechazará peticiones')
    const checkin = usage.checkin
    if (checkin?.active === true) {
      console.log(
        `  Registro diario: ${checkin.todayCheckedIn ? 'ya cobrado hoy' : 'disponible'} · ` +
          `${checkin.amount ?? '?'} ${checkin.unit ?? 'credits'}` +
          `${checkin.validDays ? ` · válido ${checkin.validDays} días` : ''}`,
      )
    } else {
      console.log('  Registro diario: sin ronda activa')
    }
    if (usage.campaigns.length > 0) {
      console.log(`  Campañas: ${usage.campaigns.map((campaign) => campaign.title || campaign.key).join(' · ')}`)
    }
  }
}

/** `checkin`: reclama la ronda diaria (única escritura sobre la cuenta). */
async function checkin(options) {
  const config = ensureConfig()
  const { regions, credentials } = buildStack(config)
  for (const region of regions) {
    const credential = await credentials.get(region)
    if (!credential) {
      console.log(`${region.displayName}: sin sesión`)
      continue
    }
    try {
      const result = await claimDailyBenefit(region, credential)
      if (result.claimed === true && result.replayed !== true) {
        console.log(`${region.displayName}: +${result.amount ?? 0} créditos`)
      } else if (result.replayed === true) {
        console.log(`${region.displayName}: la ronda de hoy ya estaba cobrada (sin cambios)`)
      } else {
        console.log(`${region.displayName}: ${result.reason ?? 'sin cambios'}`)
      }
    } catch (error) {
      console.error(`${region.displayName}: ${error?.message ?? error}`)
      process.exitCode = 1
    }
  }
  void options
}

/** `statusline`: una línea con el saldo para el pie de Qwen Code. */
async function statusline(options) {
  const config = ensureConfig()
  const { regions, credentials } = buildStack(config)
  const { line, cached } = await buildStatusLine({ credentials, regions })
  if (options.json === true) console.log(JSON.stringify({ line, cached }))
  else console.log(line)
}

/** `speedhook`: hook `Stop` que pinta la velocidad del turno. */
function speedhook(options) {
  const path = qwenSettingsPath()
  let doc = { $version: 4 }
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Sin ajustes previos se crea un documento mínimo.
  }
  if (options.status === true) {
    console.log(hasSpeedHook(doc) ? 'Hook de velocidad: activo' : 'Hook de velocidad: inactivo')
    return
  }
  if (options.off === true) {
    const { settings, removed } = removeSpeedHook(doc)
    if (removed) writeSettings(path, settings)
    console.log(removed ? 'Hook de velocidad retirado' : 'No estaba instalado')
    return
  }
  const command = `"${preferredNode()}" "${TURN_SPEED_BIN}"`
  const { settings } = applySpeedHook(doc, command)
  const write = writeSettings(path, settings)
  console.log(`Hook Stop instalado: ${command}`)
  console.log(
    write.changed ? `Ajustes actualizados${write.backup ? ` · copia: ${write.backup}` : ''}` : 'Los ajustes ya estaban al día',
  )
}

/** Consulta el puente local. */
async function bridgeHealth(config) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/healthz`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) return { running: true, status: response.status }
    return { running: true, status: response.status, body: await response.json() }
  } catch {
    return { running: false }
  }
}

/** `doctor`: comprobaciones no destructivas. */
async function doctor(options) {
  const checks = []
  const push = (name, status, detail) => checks.push({ check: name, status, detail })

  const major = Number(process.versions.node.split('.')[0])
  push('node', major >= 22 ? 'PASS' : 'FAIL', `v${process.versions.node} (se requiere ≥22.19)`)

  const config = readConfig() ?? ensureConfig()
  const { credentials, catalog, regions } = buildStack(config)
  push('regiones', regions.length > 0 ? 'PASS' : 'FAIL', regions.map((region) => region.id).join(', ') || 'ninguna')

  const states = await credentials.describe()
  for (const state of states) {
    const status = state.status === 'ok' ? 'PASS' : state.status === 'expired' ? 'FAIL' : 'BLOCKED'
    push(`credencial:${state.region}`, status, `${state.status}${state.name ? ` · ${state.name} <${state.email}>` : ''}${state.reason ? ` · ${state.reason}` : ''}`)
  }

  const catalogResult = await catalog.refreshIfNeeded({ force: true })
  push(
    'catálogo',
    catalog.list().length > 0 ? 'PASS' : 'FAIL',
    `${catalog.list().length} modelos${catalogResult.error ? ` · ${catalogResult.error}` : ''}`,
  )

  const health = await bridgeHealth(config)
  push(
    'puente',
    health.running ? 'PASS' : 'BLOCKED',
    health.running ? `escuchando en 127.0.0.1:${config.port}` : `no responde en 127.0.0.1:${config.port} (arráncalo con: qwen-qoder serve)`,
  )

  const settingsPath = qwenSettingsPath()
  let settingsCheck = { status: 'BLOCKED', detail: `no existe ${settingsPath}` }
  let hasStatusLine = false
  if (existsSync(settingsPath)) {
    try {
      const doc = JSON.parse(readFileSync(settingsPath, 'utf8'))
      const entries = Array.isArray(doc?.modelProviders?.openai) ? doc.modelProviders.openai : []
      const own = entries.filter((entry) => typeof entry?.id === 'string' && entry.id.startsWith('qoder'))
      const hasKey = typeof doc?.env?.[ENV_KEY] === 'string' && doc.env[ENV_KEY].length > 0
      hasStatusLine =
        typeof doc?.ui?.statusLine?.command === 'string' && doc.ui.statusLine.command.includes('qwen-qoder.js')
      settingsCheck = {
        status: own.length > 0 && hasKey ? 'PASS' : 'FAIL',
        detail: `${own.length} entradas del puente · envKey ${hasKey ? 'presente' : 'ausente'}`,
      }
    } catch (error) {
      settingsCheck = { status: 'FAIL', detail: `no se pudo leer: ${error?.message ?? error}` }
    }
  }
  push(
    'ajustes de Qwen',
    settingsCheck.status,
    settingsCheck.detail,
  )

  push(
    'barra de estado',
    hasStatusLine ? 'PASS' : 'BLOCKED',
    hasStatusLine ? 'saldo en el pie (ui.statusLine)' : 'no configurada (qwen-qoder install)',
  )

  push(
    'extensión',
    extensionInstalled() ? 'PASS' : 'BLOCKED',
    extensionInstalled()
      ? 'instalada en ~/.qwen/extensions/qwen-connect-qoder (comandos /qoder:* y herramientas qoder_*)'
      : 'no instalada (qwen-qoder install)',
  )

  push(
    'arranque automático',
    process.platform !== 'darwin' ? 'BLOCKED' : serviceInstalled() ? 'PASS' : 'BLOCKED',
    process.platform !== 'darwin'
      ? 'solo implementado en macOS'
      : serviceInstalled()
        ? 'LaunchAgent instalado'
        : 'sin LaunchAgent (qwen-qoder install)',
  )

  const failed = checks.filter((check) => check.status === 'FAIL')
  if (options.json === true) {
    console.log(JSON.stringify({ checks, failed: failed.length }, null, 2))
  } else {
    for (const check of checks) console.log(`${check.status.padEnd(7)} ${check.check.padEnd(24)} ${check.detail}`)
    console.log(`\n${failed.length === 0 ? 'Sin fallos.' : `${failed.length} comprobación(es) en FAIL.`}`)
  }
  if (failed.length > 0) process.exitCode = 1
}

/** `status`: estado del puente en ejecución. */
async function status(options) {
  const config = readConfig()
  if (config === undefined) {
    console.log('El puente no está instalado (no hay configuración). Ejecuta: qwen-qoder install')
    process.exitCode = 1
    return
  }
  const health = await bridgeHealth(config)
  const payload = {
    installed: true,
    home: homeDir(),
    port: config.port,
    regions: config.regions,
    baseUrl: baseUrlFor(config.port),
    running: health.running,
    health: health.body,
    service: serviceInstalled(),
  }
  if (options.json === true) console.log(JSON.stringify(payload, null, 2))
  else {
    console.log(`Puente: ${health.running ? 'en ejecución' : 'parado'} · 127.0.0.1:${config.port}`)
    console.log(`Regiones: ${config.regions.join(', ')}`)
    console.log(`Endpoint: ${baseUrlFor(config.port)}`)
    console.log(`Modelos en /healthz: ${health.body?.models ?? 'n/d'}`)
    console.log(`Arranque automático: ${payload.service ? 'instalado' : 'no instalado'}`)
  }
  if (!health.running) process.exitCode = 1
}

/** `uninstall`: retira ajustes, agente y, con `--purge`, los datos locales. */
async function uninstall(options) {
  const config = readConfig()
  const baseUrl = config === undefined ? undefined : baseUrlFor(config.port)
  const result = uninstallFromQwen({
    baseUrl,
    path: typeof options.settings === 'string' ? options.settings : undefined,
  })
  console.log(`Entradas retiradas de Qwen Code: ${result.removed}${result.changed ? ' (ajustes actualizados)' : ''}`)
  if (result.statusLineRemoved) console.log('Barra de estado retirada de los ajustes')
  const extension = removeExtension()
  console.log(extension.removed ? `Extensión retirada: ${extension.path}` : 'No había extensión instalada')
  if (process.platform === 'darwin') {
    const service = uninstallService()
    console.log(service.removed ? 'LaunchAgent retirado' : 'No había LaunchAgent')
  }
  if (options.purge === true) {
    rmSync(homeDir(), { recursive: true, force: true })
    console.log(`Datos locales borrados: ${homeDir()}`)
  }
}

/** Ayuda. */
function help() {
  console.log(`qwen-qoder — puente de modelos Qoder para Qwen Code

Uso:
  qwen-qoder serve [--port N] [--region qoder|qoder-cn] [--quiet]
  qwen-qoder install [--port N] [--region …] [--no-service] [--settings RUTA]
  qwen-qoder models [--json]
  qwen-qoder usage [--json]
  qwen-qoder checkin
  qwen-qoder statusline [--json]
  qwen-qoder speedhook [--status|--off]
  qwen-qoder doctor [--json]
  qwen-qoder status [--json]
  qwen-qoder uninstall [--purge] [--settings RUTA]

El puerto por defecto es ${DEFAULT_PORT}. La configuración vive en ~/.qwen-connect-qoder.
Regiones disponibles: ${REGIONS.map((region) => region.id).join(', ')}.`)
}

const { options, positional } = parseArgs(process.argv.slice(2))
const command = positional[0] ?? (options.help === true ? 'help' : 'help')
try {
  switch (command) {
    case 'serve':
      await serve(options)
      break
    case 'install':
      await install(options)
      break
    case 'models':
      await models(options)
      break
    case 'usage':
      await usage(options)
      break
    case 'checkin':
      await checkin(options)
      break
    case 'statusline':
      await statusline(options)
      break
    case 'speedhook':
      speedhook(options)
      break
    case 'doctor':
      await doctor(options)
      break
    case 'status':
      await status(options)
      break
    case 'uninstall':
      await uninstall(options)
      break
    case 'help':
    default:
      help()
      if (command !== 'help') process.exitCode = 2
  }
} catch (error) {
  console.error(`qwen-qoder: ${error?.stack ?? error}`)
  process.exitCode = 1
}
