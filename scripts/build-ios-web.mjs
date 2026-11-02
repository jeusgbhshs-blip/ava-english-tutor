#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { normalizeBackendOrigin } from '../web/js/backend.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'web')
const output = path.join(root, 'dist-ios')
const backendUrl = process.env.AVA_IOS_BACKEND_URL ? normalizeBackendOrigin(process.env.AVA_IOS_BACKEND_URL) : ''
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(web, output, { recursive: true, filter: source => !source.includes(`${path.sep}design-preview`) })
const configScript = '<script src="./js/app-config.js"></script>'
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' https: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'">`
const configurePage = html => html.replace('</head>', `${csp}\n${configScript}\n</head>`)
  .replaceAll('href="/mobile"', 'href="/index.html"')
const mobile = await readFile(path.join(web, 'mobile.html'), 'utf8')
const settings = await readFile(path.join(web, 'index.html'), 'utf8')
await writeFile(path.join(output, 'index.html'), configurePage(mobile))
await writeFile(path.join(output, 'settings.html'), configurePage(settings))
await writeFile(path.join(output, 'mobile.html'), configurePage(mobile))
await writeFile(path.join(output, 'js/app-config.js'), `globalThis.AVA_APP_CONFIG = ${JSON.stringify({ backendUrl }).replaceAll('<', '\\u003c')};\n`)
console.log(`iOS web assets prepared (${backendUrl ? 'HTTPS service preconfigured' : 'connect to your service at first launch'}).`)
