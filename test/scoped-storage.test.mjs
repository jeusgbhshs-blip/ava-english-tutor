import test from 'node:test'
import assert from 'node:assert/strict'
import { createScopedStorage, installScopedStorage } from '../web/js/scoped-storage.js'

function memoryStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(String(key)) ?? null },
    setItem(key, value) { values.set(String(key), String(value)) },
    removeItem(key) { values.delete(String(key)) },
    clear() { values.clear() },
  }
}

test('native storage: different service addresses cannot read or overwrite each other’s learner records', () => {
  const raw = memoryStorage()
  const first = createScopedStorage(raw, 'https://first.example')
  const second = createScopedStorage(raw, 'https://second.example')
  first.setItem('ava.mobile.profile', 'first learner')
  assert.equal(second.getItem('ava.mobile.profile'), null)
  second.setItem('ava.mobile.profile', 'second learner')
  assert.equal(first.getItem('ava.mobile.profile'), 'first learner')
  assert.equal(second.getItem('ava.mobile.profile'), 'second learner')
  second.removeItem('ava.mobile.profile')
  assert.equal(first.getItem('ava.mobile.profile'), 'first learner')
  assert.equal(second.getItem('ava.mobile.profile'), null)
})

test('native storage: normalized equivalent origins reuse records while distinct ports remain isolated', () => {
  const raw = memoryStorage()
  createScopedStorage(raw, ' HTTPS://AVA.EXAMPLE:443/ ').setItem('progress', 'lesson 6')
  assert.equal(createScopedStorage(raw, 'https://ava.example').getItem('progress'), 'lesson 6')
  assert.equal(createScopedStorage(raw, 'https://ava.example:8443').getItem('progress'), null)
  for (const origin of ['', 'https://ava.example/path', 'http://ava.example', 'https://user:pass@ava.example']) {
    assert.throws(() => createScopedStorage(raw, origin))
  }
})

test('native storage: legacy and other-service records are excluded from key/length and survive scoped clear', () => {
  const raw = memoryStorage()
  raw.setItem('legacy-profile', 'legacy learner')
  const first = createScopedStorage(raw, 'https://first.example')
  const second = createScopedStorage(raw, 'https://second.example')
  second.setItem('other-profile', 'second learner')
  first.setItem('profile', 'first learner')
  first.setItem('progress', 'lesson 3')
  first.setItem('', 'empty key is valid')
  assert.equal(first.getItem('legacy-profile'), null)
  assert.equal(first.length, 3)
  assert.deepEqual([first.key(0), first.key(1), first.key(2)], ['profile', 'progress', ''])
  assert.equal(first.key(3), null)
  assert.equal(first.key(-1), null)
  first.clear()
  assert.equal(first.length, 0)
  assert.equal(first.getItem('profile'), null)
  assert.equal(raw.getItem('legacy-profile'), 'legacy learner')
  assert.equal(second.getItem('other-profile'), 'second learner')
  assert.equal(raw.length, 2)
})

test('native storage: keys and values retain Storage string coercion', () => {
  const first = createScopedStorage(memoryStorage(), 'https://ava.example')
  first.setItem(7, 42)
  first.setItem(null, false)
  assert.equal(first.getItem('7'), '42')
  assert.equal(first.getItem(null), 'false')
  first.removeItem(7)
  assert.equal(first.getItem('7'), null)
})

test('native storage: switching the installed view never nests namespaces and reconnecting restores records', () => {
  const raw = memoryStorage()
  raw.setItem('old-unscoped', 'keep')
  const target = { localStorage: raw }
  installScopedStorage(target, 'https://first.example')
  target.localStorage.setItem('profile', 'first learner')
  installScopedStorage(target, 'https://second.example')
  assert.equal(target.localStorage.getItem('profile'), null)
  target.localStorage.setItem('profile', 'second learner')
  installScopedStorage(target, 'https://first.example')
  assert.equal(target.localStorage.getItem('profile'), 'first learner')
  assert.equal(target.localStorage.length, 1)
  assert.equal(raw.getItem('old-unscoped'), 'keep')
  assert.equal(raw.length, 3)
})

test('native storage: denied browser storage and immutable accessors fail closed', () => {
  const denied = {}
  Object.defineProperty(denied, 'localStorage', { get() { throw new Error('Access denied') } })
  assert.throws(() => installScopedStorage(denied, 'https://ava.example'), /无法安全隔离/)
  const immutable = {}
  const raw = memoryStorage()
  Object.defineProperty(immutable, 'localStorage', { value: raw, configurable: false })
  assert.throws(() => installScopedStorage(immutable, 'https://ava.example'), /无法安全隔离/)
  assert.equal(immutable.localStorage, raw)
  assert.equal(raw.length, 0)
})

test('native storage: quota/read failures propagate instead of writing to shared storage', () => {
  const quotaError = new Error('Quota exceeded')
  const raw = memoryStorage()
  const scoped = createScopedStorage({ ...raw, setItem() { throw quotaError } }, 'https://ava.example')
  assert.throws(() => scoped.setItem('progress', 'lesson 4'), error => error === quotaError)
  assert.equal(raw.length, 0)
  const unavailable = memoryStorage()
  Object.defineProperty(unavailable, 'length', { get() { throw new Error('Read denied') } })
  const target = { localStorage: unavailable }
  assert.throws(() => installScopedStorage(target, 'https://ava.example'), /无法安全隔离/)
  assert.equal(target.localStorage, unavailable)
})
