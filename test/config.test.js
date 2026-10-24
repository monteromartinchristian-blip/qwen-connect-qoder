import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureConfig, baseUrlFor, DEFAULT_PORT, homeDir, readConfig } from '../lib/config.js'
import { plistBody, LABEL } from '../lib/service.js'

test('la configuración se crea con permisos privados y es estable', () => {
  const home = mkdtempSync(join(tmpdir(), 'qcq-config-'))
  try {
    const env = { QWEN_QODER_HOME: home }
    assert.equal(homeDir(env), home)
    const first = ensureConfig({ env })
    assert.equal(first.port, DEFAULT_PORT)
    assert.ok(first.token.length >= 40)
    assert.equal(statSync(join(home, 'bridge.json')).mode & 0o777, 0o600)

    const second = ensureConfig({ env })
    assert.equal(second.token, first.token, 'el bearer sobrevive a un reinicio')

    const rotated = ensureConfig({ env, rotateToken: true })
    assert.notEqual(rotated.token, first.token)

    assert.equal(readConfig(env).port, DEFAULT_PORT)
    assert.equal(baseUrlFor(17872), 'http://127.0.0.1:17872/v1')
    assert.match(readFileSync(join(home, 'bridge.json'), 'utf8'), /"regions"/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('un bridge.json corrupto se trata como ausente', () => {
  const home = mkdtempSync(join(tmpdir(), 'qcq-config-'))
  try {
    const env = { QWEN_QODER_HOME: home }
    ensureConfig({ env })
    writeFileSync(join(home, 'bridge.json'), '{ roto')
    assert.equal(readConfig(env), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('el plist arranca el puente con el nodo absoluto y el puerto', () => {
  const body = plistBody({ node: '/usr/local/bin/node', script: '/ruta/bin/qwen-qoder.js', port: 17872, log: '/tmp/log' })
  assert.match(body, new RegExp(`<string>${LABEL}</string>`))
  assert.match(body, /<string>\/usr\/local\/bin\/node<\/string>/)
  assert.match(body, /<string>serve<\/string>/)
  assert.match(body, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(body, /<key>SuccessfulExit<\/key><false\/>/)
})
