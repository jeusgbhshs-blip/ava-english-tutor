import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import http from 'node:http';
import { isPublicAddress, validatePublicUrl, fetchPublicHtml } from '../lib/urlImport.js';

const publicAddress = { address: '93.184.216.34', family: 4 };
const publicLookup = async () => [publicAddress];

function responseRequest(pages, observed = []) {
  return (url, options) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const record = { url: url.href, headers: options.headers };
      options.lookup(url.hostname, { all: true }, (_error, addresses) => { record.addresses = addresses; });
      observed.push(record);
      const page = pages(url, observed.length);
      const res = Readable.from((page.chunks || [Buffer.from(page.body || '')]).map(x => Buffer.from(x)));
      res.statusCode = page.status || 200;
      res.headers = page.headers || { 'content-type': 'text/html' };
      req.emit('response', res);
    });
    return req;
  };
}

test('public IP policy rejects loopback, private, link-local, multicast, mapped private and reserved ranges', () => {
  for (const value of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '2001:2::1', '2002:7f00:1::1', '3fff::1', 'fe80::1%en0']) {
    assert.equal(isPublicAddress(value), false, value);
  }
  for (const value of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(value), true, value);
  }
});

test('URL validation rejects credentials, other schemes, numeric loopback and mixed public/private DNS answers', async () => {
  for (const value of ['file:///etc/passwd', 'ftp://example.com/a', 'https://user:pass@example.com/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://[::1]/a']) {
    await assert.rejects(validatePublicUrl(value, { lookup: publicLookup, allowPrivate: false }), /http|公开网页/);
  }
  await assert.rejects(validatePublicUrl('https://mixed.example/a', {
    allowPrivate: false, lookup: async () => [publicAddress, { address: '10.0.0.5', family: 4 }],
  }), /公开网页/);
});

test('the connection uses the vetted DNS address without resolving the host a second time', async () => {
  let resolutions = 0;
  const observed = [];
  const result = await fetchPublicHtml('https://safe.example/article', {
    allowPrivate: false,
    lookup: async () => { resolutions++; return resolutions === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }]; },
    requestImpl: responseRequest(() => ({ body: '<p>A public article.</p>' }), observed),
  });
  assert.equal(resolutions, 1);
  assert.deepEqual(observed[0].addresses, [publicAddress]);
  assert.equal(result.html, '<p>A public article.</p>');
  assert.equal(observed[0].headers['accept-encoding'], 'identity');
});

test('every redirect is revalidated and a private target is blocked before the next request', async () => {
  const observed = [];
  await assert.rejects(fetchPublicHtml('https://safe.example/article', {
    allowPrivate: false, lookup: publicLookup,
    requestImpl: responseRequest(() => ({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }), observed),
  }), /公开网页/);
  assert.equal(observed.length, 1);
});

test('redirect limits and unsupported content/encoding produce explicit failures', async () => {
  await assert.rejects(fetchPublicHtml('https://safe.example/start', {
    allowPrivate: false, lookup: publicLookup, maxRedirects: 2,
    requestImpl: responseRequest(() => ({ status: 302, headers: { location: '/again' } })),
  }), /重定向次数过多/);
  for (const headers of [{ 'content-type': 'application/pdf' }, { 'content-type': 'text/html', 'content-encoding': 'gzip' }]) {
    await assert.rejects(fetchPublicHtml('https://safe.example/page', {
      allowPrivate: false, lookup: publicLookup,
      requestImpl: responseRequest(() => ({ body: 'something', headers })),
    }), /文件上传|下载文件后上传/);
  }
});

test('body limits cover both announced and actual chunked response size', async () => {
  for (const page of [
    { headers: { 'content-type': 'text/html', 'content-length': '101' }, body: 'small body' },
    { chunks: [Buffer.alloc(70), Buffer.alloc(40)] },
  ]) {
    await assert.rejects(fetchPublicHtml('https://safe.example/page', {
      allowPrivate: false, lookup: publicLookup, maxBytes: 100,
      requestImpl: responseRequest(() => page),
    }), /网页内容太大/);
  }
});

test('the total deadline also bounds a DNS lookup that never finishes', async () => {
  await assert.rejects(fetchPublicHtml('https://slow.example/page', {
    allowPrivate: false, lookup: () => new Promise(() => {}), timeoutMs: 25,
  }), /超时/);
});

test('real HTTP loopback fixtures require explicit private-import opt-in and stalled bodies time out', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/slow') {
      res.write('<p>');
      const timer = setTimeout(() => res.end('Too slow.</p>'), 1000);
      res.on('close', () => clearTimeout(timer));
    } else res.end('<p>This is an isolated local test article.</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(fetchPublicHtml(url, { allowPrivate: false }), /公开网页/);
  assert.match((await fetchPublicHtml(url, { allowPrivate: true })).html, /isolated local test article/);
  await assert.rejects(fetchPublicHtml(url + '/slow', { allowPrivate: true, timeoutMs: 30 }), /超时/);
});
