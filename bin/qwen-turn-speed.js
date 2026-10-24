#!/usr/bin/env node
/**
 * Línea de velocidad por turno, para cualquier proveedor.
 *
 * Se instala como hook `Stop` de Qwen Code: recibe por stdin el JSON del evento
 * (con `session_id`) y responde `{"systemMessage": "…"}`, que el cliente pinta
 * al terminar el turno.
 *
 * Los datos salen del registro local que Qwen ya escribe para su panel de
 * consumo (`~/.qwen/usage/token-usage-AAAA-MM.jsonl`): cada petición guarda
 * `outputTokens` y `apiDurationMs`, suficientes para la velocidad real. No hay
 * ninguna llamada de red ni al modelo.
 *
 * @module qwen-connect-qoder/turn-speed
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Ruta del registro mensual de consumo de Qwen Code. */
export function usageLogPath(now = new Date(), env = process.env) {
  const home = env.QWEN_HOME ?? join(homedir(), '.qwen')
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return join(home, 'usage', `token-usage-${month}.jsonl`)
}

/** Formatea un recuento grande: 20.3M, 14.2k, 987. */
export function formatCount(value) {
  if (!Number.isFinite(value)) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

/**
 * Resume las peticiones de una sesión.
 *
 * @param {Array<object>} entries registros del log.
 * @param {string} sessionId
 * @returns {{ requests: number, inputTokens: number, outputTokens: number, cachedTokens: number,
 *   totalTokens: number, durationMs: number }}
 */
export function summarizeSession(entries, sessionId) {
  const summary = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, durationMs: 0 }
  for (const entry of entries) {
    if (entry?.sessionId !== sessionId) continue
    summary.requests += 1
    summary.inputTokens += Number(entry.inputTokens) || 0
    summary.outputTokens += Number(entry.outputTokens) || 0
    summary.cachedTokens += Number(entry.cachedTokens) || 0
    summary.totalTokens += Number(entry.totalTokens) || 0
    summary.durationMs += Number(entry.apiDurationMs) || 0
  }
  return summary
}

/**
 * Construye la línea visible.
 *
 * La velocidad es la media de la sesión (tokens de salida entre tiempo de API),
 * que es la misma cuenta que muestra el panel de consumo. Sin duración no se
 * inventa una cifra: se omite.
 *
 * @param {ReturnType<typeof summarizeSession>} summary
 * @returns {string|undefined}
 */
export function formatSpeedLine(summary) {
  if (summary.requests === 0) return undefined
  const parts = []
  if (summary.durationMs > 0) {
    const speed = summary.outputTokens / (summary.durationMs / 1000)
    parts.push(`${speed >= 100 ? Math.round(speed) : speed.toFixed(1)} tok/s`)
  }
  if (summary.totalTokens > 0) parts.push(`${formatCount(summary.totalTokens)} tok`)
  if (summary.inputTokens > 0) parts.push(`caché ${Math.round((summary.cachedTokens / summary.inputTokens) * 100)}%`)
  parts.push(`${summary.requests} ${summary.requests === 1 ? 'petición' : 'peticiones'}`)
  return `⏱ ${parts.join(' · ')}`
}

/** Lee stdin completo. */
async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** Punto de entrada cuando se ejecuta como hook. */
async function main() {
  let input
  try {
    input = JSON.parse(await readStdin())
  } catch {
    return
  }
  const sessionId = typeof input?.session_id === 'string' ? input.session_id : ''
  if (sessionId.length === 0) return
  const path = usageLogPath()
  if (!existsSync(path)) return
  let entries = []
  try {
    entries = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter((entry) => entry !== undefined)
  } catch {
    return
  }
  const line = formatSpeedLine(summarizeSession(entries, sessionId))
  if (line === undefined) return
  process.stdout.write(`${JSON.stringify({ systemMessage: line })}\n`)
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch(() => {
    // Un hook nunca debe romper el turno.
    process.exit(0)
  })
}
