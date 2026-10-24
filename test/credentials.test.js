import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv } from 'node:crypto'
import {
  appDataRootFor,
  CredentialStore,
  loadCredential,
  loadEnvCredential,
  readNewCredential,
} from '../lib/credentials.js'
import { deriveLinuxKey, deriveMacKey } from '../lib/oscrypt.js'
import { REGIONS, regionById } from '../lib/regions.js'

function macBlob(plaintext, password) {
  const key = deriveMacKey(password)
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext, 'utf8'), cipher.final()])
}

function linuxBlob(plaintext) {
  const cipher = createCipheriv('aes-128-cbc', deriveLinuxKey(), Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext, 'utf8'), cipher.final()])
}

function session(overrides = {}) {
  return {
    schemaVersion: 1,
    token: 'dt-token',
    refreshToken: 'drt-token',
    expiresAt: '2030-01-01T00:00:00Z',
    refreshTokenExpiresAt: '2031-01-01T00:00:00Z',
    user: { id: 'user-1', name: 'Nombre', email: 'correo@example.com' },
    ...overrides,
  }
}

/** Crea `<root>/<app>/auth.v1.dat` con el blob dado. */
function makeAppDir(root, name, blob, machineID = 'maquina-1') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.v1.dat'), blob)
  writeFileSync(join(dir, 'auth.machine-id'), machineID)
  return dir
}

test('la raíz de datos de aplicación sigue la convención de cada plataforma', () => {
  assert.equal(appDataRootFor('darwin', {}, '/Users/x'), '/Users/x/Library/Application Support')
  assert.equal(appDataRootFor('win32', { APPDATA: 'C:\\Datos' }, 'C:\\Users\\x'), 'C:\\Datos')
  assert.equal(appDataRootFor('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/x'), '/cfg')
  assert.equal(appDataRootFor('linux', {}, '/home/x'), '/home/x/.config')
  assert.equal(appDataRootFor('win32', {}, 'C:\\'), '')
})

test('lee auth.v1.dat y proyecta la sesión', () => {
  const root = mkdtempSync(join(tmpdir(), 'qcq-'))
  try {
    const dir = makeAppDir(root, 'com.qoder.app.stable', macBlob(JSON.stringify(session()), 'pw'))
    const credential = readNewCredential(regionById('qoder'), dir, {
      key: deriveMacKey('pw'),
      scheme: 'cbc',
    })
    assert.equal(credential.userID, 'user-1')
    assert.equal(credential.email, 'correo@example.com')
    assert.equal(credential.token, 'dt-token')
    assert.equal(credential.machineID, 'maquina-1')
    assert.equal(credential.expired, false)
    assert.equal(credential.source, 'app')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('una sesión caducada se marca como tal', () => {
  const root = mkdtempSync(join(tmpdir(), 'qcq-'))
  try {
    const blob = macBlob(JSON.stringify(session({ expiresAt: '2020-01-01T00:00:00Z' })), 'pw')
    const dir = makeAppDir(root, 'com.qoder.app.stable', blob)
    const credential = readNewCredential(regionById('qoder'), dir, { key: deriveMacKey('pw'), scheme: 'cbc' })
    assert.equal(credential.expired, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('un blob ilegible no produce credencial', () => {
  const root = mkdtempSync(join(tmpdir(), 'qcq-'))
  try {
    const dir = makeAppDir(root, 'com.qoder.app.stable', Buffer.from('v10basura'), 'm')
    assert.equal(readNewCredential(regionById('qoder'), dir, { key: deriveMacKey('pw'), scheme: 'cbc' }), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('el PAT del entorno es la alternativa cuando no hay app', () => {
  const credential = loadEnvCredential(regionById('qoder'), { QODER_PAT: 'pat-123' })
  assert.equal(credential.token, 'pat-123')
  assert.equal(credential.source, 'env-pat')
  assert.equal(loadEnvCredential(regionById('qoder'), {}), undefined)
  assert.equal(loadEnvCredential(regionById('qoder-cn'), { QODERCN_PAT: 'pat-cn' }).token, 'pat-cn')
})

test('sin app ni PAT la región queda sin sesión', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qcq-'))
  try {
    const result = await loadCredential(regionById('qoder'), root, { env: {}, platform: 'darwin' })
    assert.equal(result.status, 'signed-out')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('la app instalada pero ilegible se distingue de «sin sesión»', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qcq-'))
  try {
    mkdirSync(join(root, 'com.qoder.app.stable'), { recursive: true })
    const result = await loadCredential(regionById('qoder'), root, { env: {}, platform: 'darwin' })
    assert.equal(result.status, 'needs-app')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('en Linux, sin llavero, se usa la clave pública peanuts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qcq-'))
  try {
    makeAppDir(root, 'com.qoder.app.stable', linuxBlob(JSON.stringify(session())), 'm-linux')
    const result = await loadCredential(regionById('qoder'), root, { env: {}, platform: 'linux' })
    assert.equal(result.status, 'ok')
    assert.equal(result.credential.machineID, 'm-linux')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('el caché reutiliza la credencial mientras el fichero no cambia y la relee al cambiar', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qcq-'))
  try {
    const dir = makeAppDir(root, 'com.qoder.app.stable', linuxBlob(JSON.stringify(session())))
    const store = new CredentialStore({
      regions: [regionById('qoder')],
      appDataRoot: root,
      platform: 'linux',
      env: {},
    })
    const first = await store.get(regionById('qoder'))
    const second = await store.get(regionById('qoder'))
    assert.equal(first, second, 'la segunda lectura sale del caché')

    writeFileSync(join(dir, 'auth.v1.dat'), linuxBlob(JSON.stringify(session({ token: 'dt-nuevo-token' }))))
    const third = await store.get(regionById('qoder'))
    assert.notEqual(third, first, 'un fichero nuevo invalida la entrada')
    assert.equal(third.token, 'dt-nuevo-token')

    store.invalidate('qoder')
    const fourth = await store.get(regionById('qoder'))
    assert.notEqual(fourth, third)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('describe() no incluye material de credencial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qcq-'))
  try {
    makeAppDir(root, 'com.qoder.app.stable', linuxBlob(JSON.stringify(session())))
    const store = new CredentialStore({
      regions: [regionById('qoder')],
      appDataRoot: root,
      platform: 'linux',
      env: {},
    })
    const [row] = await store.describe()
    assert.equal(row.status, 'ok')
    const text = JSON.stringify(row)
    assert.ok(!text.includes('dt-token'))
    assert.ok(!text.includes('drt-token'))
    assert.equal(row.email, 'correo@example.com')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cada región declara sus propios nombres de app', () => {
  assert.deepEqual(REGIONS.map((region) => region.id), ['qoder', 'qoder-cn'])
  assert.ok(REGIONS[0].newAppNames.includes('com.qoder.app.stable'))
  assert.ok(REGIONS[1].newAppNames.includes('com.qodercn.app.stable'))
})
