/**
 * Arranque automático del puente en macOS (LaunchAgent).
 *
 * Sin esto, el puente solo vive mientras alguien tenga una terminal abierta y
 * Qwen Code fallaría con «connection refused» tras reiniciar. El agente es de
 * usuario, arranca al iniciar sesión y se reinicia si se cae.
 *
 * @module qwen-connect-qoder/service
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Etiqueta del LaunchAgent. */
export const LABEL = 'com.qwen-connect-qoder.bridge'

/** Ruta del plist del agente. */
export function plistPath(home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

/** Ruta del log del agente. */
export function logPath(home = homedir()) {
  return join(home, 'Library', 'Logs', 'qwen-connect-qoder.log')
}

/** Escapa texto para un plist XML. */
function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Genera el contenido del plist.
 *
 * @param {{ node: string, script: string, log?: string, port?: number }} options
 * @returns {string}
 */
export function plistBody(options) {
  const log = options.log ?? logPath()
  const args = [options.node, options.script, 'serve']
  if (Number.isInteger(options.port)) args.push('--port', String(options.port))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}

/** Ejecuta `launchctl`, tolerando que el servicio no exista todavía. */
function launchctl(args) {
  return execFileSync('/bin/launchctl', args, { stdio: 'pipe' }).toString()
}

/**
 * Instala y arranca el agente.
 *
 * @param {{ node?: string, script: string, port?: number, home?: string, load?: boolean }} options
 */
export function installService(options) {
  const home = options.home ?? homedir()
  const node = options.node ?? process.execPath
  const path = plistPath(home)
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  mkdirSync(join(home, 'Library', 'Logs'), { recursive: true })
  writeFileSync(path, plistBody({ node, script: options.script, log: logPath(home), port: options.port }), {
    mode: 0o644,
  })
  if (options.load === false) return { path, loaded: false }
  const domain = `gui/${process.getuid()}`
  try {
    launchctl(['bootout', `${domain}/${LABEL}`])
  } catch {
    // No estaba cargado: es el caso normal en la primera instalación.
  }
  launchctl(['bootstrap', domain, path])
  try {
    launchctl(['kickstart', '-k', `${domain}/${LABEL}`])
  } catch {
    // `bootstrap` con RunAtLoad ya lo arranca; kickstart es solo un empujón.
  }
  return { path, loaded: true }
}

/**
 * Descarga y elimina el agente.
 *
 * @param {{ home?: string }} [options]
 */
export function uninstallService(options = {}) {
  const home = options.home ?? homedir()
  const path = plistPath(home)
  const domain = `gui/${process.getuid()}`
  let loaded = false
  try {
    launchctl(['bootout', `${domain}/${LABEL}`])
    loaded = true
  } catch {
    // No estaba cargado.
  }
  if (existsSync(path)) rmSync(path, { force: true })
  return { path, removed: true, loaded }
}

/** ¿Está el plist instalado? */
export function serviceInstalled(home = homedir()) {
  return existsSync(plistPath(home))
}
