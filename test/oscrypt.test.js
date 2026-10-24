import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import {
  decryptOscrypt,
  decryptOscryptAny,
  deriveLinuxKey,
  deriveMacKey,
} from '../lib/oscrypt.js'

/** Blob OSCrypt CBC como el que escribe Electron en macOS. */
function cbcBlob(plaintext, password) {
  const key = deriveMacKey(password)
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext, 'utf8'), cipher.final()])
}

/** Blob OSCrypt GCM como el que escribe Electron en Windows. */
function gcmBlob(plaintext, key) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), nonce, body, cipher.getAuthTag()])
}

test('la clave de macOS se deriva con PBKDF2-SHA1, sal saltysalt y 1003 iteraciones', () => {
  const key = deriveMacKey('contraseña')
  // Cálculo independiente, con parámetros escritos a mano.
  const expected = pbkdf2Sync('contraseña', 'saltysalt', 1003, 16, 'sha1')
  assert.equal(key.length, 16)
  assert.equal(key.toString('hex'), expected.toString('hex'))
  assert.notEqual(
    key.toString('hex'),
    pbkdf2Sync('contraseña', 'saltysalt', 1004, 16, 'sha1').toString('hex'),
    'las iteraciones importan',
  )
})

test('descifra un blob CBC de macOS', () => {
  const plaintext = JSON.stringify({ schemaVersion: 1, token: 'dt-abc', user: { id: 'u1' } })
  const blob = cbcBlob(plaintext, 'clave-del-llavero')
  assert.equal(decryptOscrypt(blob, deriveMacKey('clave-del-llavero'), { mode: 'cbc' }), plaintext)
})

test('una contraseña equivocada no devuelve texto: el relleno no valida', () => {
  const blob = cbcBlob('secreto', 'correcta')
  assert.equal(decryptOscrypt(blob, deriveMacKey('incorrecta'), { mode: 'cbc' }), undefined)
})

test('descifra un blob GCM de Windows y detecta un tag manipulado', () => {
  const key = randomBytes(32)
  const blob = gcmBlob('{"token":"dt-x"}', key)
  assert.equal(decryptOscrypt(blob, key, { mode: 'gcm' }), '{"token":"dt-x"}')
  const broken = Buffer.from(blob)
  broken[broken.length - 1] ^= 0xff
  assert.equal(decryptOscrypt(broken, key, { mode: 'gcm' }), undefined)
})

test('rechaza blobs que no empiezan por v10 o son demasiado cortos', () => {
  const key = deriveMacKey('x')
  assert.equal(decryptOscrypt(Buffer.from('v11abc'), key, { mode: 'cbc' }), undefined)
  assert.equal(decryptOscrypt(Buffer.alloc(4), key, { mode: 'cbc' }), undefined)
  assert.equal(decryptOscrypt(Buffer.from('v10'), key, { mode: 'cbc' }), undefined)
})

test('prueba los esquemas en orden y dice cuál funcionó', () => {
  const cbcKey = deriveMacKey('llavero')
  const blob = cbcBlob('{"a":1}', 'llavero')
  assert.deepEqual(decryptOscryptAny(blob, { gcmKey: randomBytes(32), cbcKey }), {
    text: '{"a":1}',
    scheme: 'cbc',
  })
  assert.equal(decryptOscryptAny(blob, { gcmKey: randomBytes(32) }), undefined)
})

test('la clave de Linux con la constante peanuts se deriva con una iteración', () => {
  const key = deriveLinuxKey()
  assert.equal(key.length, 16)
  assert.equal(key.toString('hex'), deriveLinuxKey('peanuts', 1).toString('hex'))
  assert.notEqual(key.toString('hex'), deriveLinuxKey('peanuts', 2).toString('hex'))
})
