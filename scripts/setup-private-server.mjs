#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
const domain = process.argv[2] || ''
if (!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes('.') || domain.includes('..') || isIP(domain)) {
  console.error('Usage: node scripts/setup-private-server.mjs ava.your-domain.com')
  process.exit(1)
}
const content = `AVA_DOMAIN=${domain}\nAVA_ACCESS_TOKEN=${randomBytes(32).toString('hex')}\nAVA_MAX_UPLOAD_MB=100\nAVA_IOS_BACKEND_URL=https://${domain}\n`
try {
  await writeFile('.env', content, { flag: 'wx', mode: 0o600 })
  console.log('Created private .env configuration. The access code stays in that file; do not publish it or paste it into chat.')
} catch (error) {
  console.error(error.code === 'EEXIST' ? '.env already exists; it was not changed.' : 'Could not create private server configuration.')
  process.exitCode = 1
}
