#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFile(path.join(root, p), 'utf8')
const config = JSON.parse(await read('capacitor.config.json'))
assert.equal(config.server?.url, undefined, 'Release app must load bundled code, not a remote website')
assert.equal(config.server?.hostname, 'localhost', 'iOS microphone origin must remain capacitor://localhost without a port')
assert.equal(config.loggingBehavior, 'none', 'Native bridge logs must not print access tokens')
const project = await read('ios/App/App.xcodeproj/project.pbxproj')
const versions = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(m => Number(m[1]))
assert(versions.length && versions.every(version => version >= 16), 'Web APIs require iOS16+')
for (const file of ['AvaSecureStorePlugin.swift', 'AvaBridgeViewController.swift', 'PrivacyInfo.xcprivacy']) {
  assert(project.includes(file), `${file} is not in the Xcode project`)
  await access(path.join(root, 'ios/App/App', file))
}
assert((await read('ios/App/App/SceneDelegate.swift')).includes('rootViewController = AvaBridgeViewController()'), 'Scene must instantiate the custom bridge')
assert((await read('ios/App/App/Info.plist')).includes('NSMicrophoneUsageDescription'), 'Missing microphone permission text')
assert((await read('ios/App/App/PrivacyInfo.xcprivacy')).includes('NSPrivacyTracking'), 'Missing privacy manifest')
for (const filename of ['index.html', 'settings.html', 'privacy.html']) {
  const html = await read(`dist-ios/${filename}`)
  if (filename !== 'privacy.html') assert(html.includes('native-bootstrap.js'), `Missing startup in ${filename}`)
  for (const match of html.matchAll(/(?:src|href)="(\.\/[^"?#]+)(?:\?[^"#]*)?"/g)) {
    await access(path.join(root, 'dist-ios', match[1]))
  }
}
const icon = await readFile(path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'))
assert.equal(icon.subarray(1, 4).toString(), 'PNG')
assert.equal(icon.readUInt32BE(16), 1024)
assert.equal(icon.readUInt32BE(20), 1024)
assert(![4, 6].includes(icon[25]), 'App icon must have no alpha channel')
const packaged = JSON.parse(await read('ios/App/App/capacitor.config.json'))
assert.equal(packaged.loggingBehavior, 'none', 'Run npm run ios:sync to refresh the native config')
assert((await read('ios/App/App/public/index.html')).includes('native-bootstrap.js?entry=mobile'), 'Bundled app must start at the mobile entry')
console.log('iOS packaging checks passed: assets, bridge registration, microphone text, icon, privacy manifest, minimum OS, no credential logging.')
console.log('This checks packaging only. An Xcode build and physical-device voice checks are still required.')
