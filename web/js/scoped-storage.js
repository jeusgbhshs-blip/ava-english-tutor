import { normalizeBackendOrigin } from './backend.js'

const namespaceVersion = 'ava.native.storage.v1:'
const installations = new WeakMap()

/** A Storage-shaped view of one Ava service. Unscoped and other-service data stay untouched. */
export function createScopedStorage(storage, origin) {
  const normalized = normalizeBackendOrigin(origin)
  const prefix = `${namespaceVersion}${encodeURIComponent(normalized)}:`
  if (!storage || !['getItem', 'setItem', 'removeItem', 'key'].every(method => typeof storage[method] === 'function')) {
    throw new Error('设备存储不可用，无法隔离学习记录')
  }
  const scopedKeys = () => {
    const keys = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key)
    }
    return keys
  }
  return Object.freeze({
    get length() { return scopedKeys().length },
    getItem(key) { return storage.getItem(prefix + String(key)) },
    setItem(key, value) { storage.setItem(prefix + String(key), String(value)) },
    removeItem(key) { storage.removeItem(prefix + String(key)) },
    key(index) {
      const key = scopedKeys()[Number(index) >>> 0]
      return key === undefined ? null : key.slice(prefix.length)
    },
    clear() {
      for (const key of scopedKeys()) storage.removeItem(key)
    },
  })
}

/** Install before any learning module imports. Failure must stop startup, never expose shared data. */
export function installScopedStorage(target, origin) {
  try {
    const storage = installations.get(target) || target.localStorage
    const scoped = createScopedStorage(storage, origin)
    // Check the underlying storage before replacing the accessor; some devices deny reads entirely.
    void scoped.length
    Object.defineProperty(target, 'localStorage', { configurable: true, enumerable: true, get: () => scoped })
    if (target.localStorage !== scoped) throw new Error('无法替换设备存储入口')
    installations.set(target, storage)
    return scoped
  } catch (cause) {
    throw new Error('无法安全隔离此服务的学习记录，请重新打开应用或检查设备存储权限', { cause })
  }
}
