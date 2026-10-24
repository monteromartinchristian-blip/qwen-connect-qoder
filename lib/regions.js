/**
 * Las dos ediciones de Qoder.
 *
 * Qoder CN y Qoder internacional son cuentas, credenciales y gateways
 * distintos; se tratan como regiones independientes para que un equipo con
 * ambas instaladas pueda usar las dos a la vez sin que una tape a la otra.
 */

/**
 * Nombres de llavero candidatos en macOS.
 *
 * Electron deriva el nombre del servicio de `app.getName()` (p. ej.
 * `Qoder App Safe Storage`), pero el nombre del producto, el del bundle y el
 * que elige el propio código no siempre coinciden, así que se prueban varios
 * en orden y gana el primero que exista.
 *
 * @param {string[]} appNames nombres de aplicación conocidos para la región.
 * @returns {Array<{ service: string, account?: string }>}
 */
function macKeychainCandidates(appNames) {
  const candidates = []
  for (const app of appNames) {
    candidates.push({ service: `${app} App Safe Storage`, account: `${app} App Key` })
    candidates.push({ service: `${app} App Safe Storage` })
    candidates.push({ service: `${app} Safe Storage`, account: app })
    candidates.push({ service: `${app} Safe Storage` })
  }
  return candidates
}

/** Descripción de una región. */
export const REGIONS = [
  {
    id: 'qoder',
    mode: 'global',
    displayName: 'Qoder',
    // 0.3.x+ guarda la sesión en `com.<vendor>.app.stable/auth.v1.dat`; los
    // nombres antiguos siguen listados para quien no haya actualizado.
    newAppNames: ['com.qoder.app.stable'],
    appNames: ['Qoder', 'QoderWork'],
    baseUrl: 'https://api3.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
    patEnvNames: ['QODER_API_KEY', 'QODER_PERSONAL_ACCESS_TOKEN', 'QODER_PAT'],
    keychain: macKeychainCandidates(['Qoder', 'Qoder App']),
  },
  {
    id: 'qoder-cn',
    mode: 'cn',
    displayName: 'Qoder CN',
    newAppNames: ['com.qodercn.app.stable'],
    appNames: ['QoderCN', 'Qoder CN', 'QoderWork CN'],
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
    patEnvNames: ['QODERCN_API_KEY', 'QODERCN_PERSONAL_ACCESS_TOKEN', 'QODERCN_PAT'],
    keychain: macKeychainCandidates(['Qoder CN', 'QoderCN', 'Qoder Work CN']),
  },
]

/** Busca una región por id; `undefined` si no existe. */
export function regionById(id) {
  return REGIONS.find((region) => region.id === id)
}
