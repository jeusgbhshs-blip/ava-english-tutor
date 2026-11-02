/**
 * 零依赖 WebSocket 服务器（RFC6455 最小实现）。
 * 仅监听本机，用于浏览器 ↔ 本地服务的实时语音桥。
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

function acceptKey(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

/** 一个已建立的 WebSocket 连接 */
export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.destroyed = false;
    this.alive = true;

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish('closed'));
    socket.on('error', () => this.#finish('error'));
    socket.on('end', () => this.#finish('end'));

    this.pingTimer = setInterval(() => {
      if (this.destroyed) return;
      try {
        this.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
      } catch {
        this.#finish('ping-error');
      }
    }, 25_000);
    this.pingTimer.unref?.();
  }

  #finish(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.pingTimer);
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.emit('close', reason);
  }

  #onData(chunk) {
    if (this.destroyed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      let offset = 0;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let headerLen = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        headerLen = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) {
          this.close(1009, 'frame too large');
          return;
        }
        length = Number(big);
        headerLen = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.close(1009, 'frame too large');
        return;
      }
      const maskLen = masked ? 4 : 0;
      const total = headerLen + maskLen + length;
      if (this.buffer.length < total) return;

      let payload = this.buffer.subarray(headerLen + maskLen, total);
      if (masked) {
        const mask = this.buffer.subarray(headerLen, headerLen + 4);
        const out = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      this.buffer = this.buffer.subarray(total);

      if (opcode === 0x8) {
        this.close(1000, '');
        return;
      }
      if (opcode === 0x9) {
        this.#write(encodeFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) {
        this.alive = true;
        continue;
      }
      if (opcode === 0x0) {
        if (!this.fragments) continue;
        this.fragments.bytes += payload.length;
        if (this.fragments.bytes > MAX_FRAME_BYTES) {
          this.fragments = null;
          this.close(1009, 'message too large');
          return;
        }
        this.fragments.chunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments.chunks);
          const isBinary = this.fragments.isBinary;
          this.fragments = null;
          this.#emitMessage(full, isBinary);
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        const isBinary = opcode === 0x2;
        if (!fin) {
          this.fragments = { isBinary, chunks: [payload], bytes: payload.length };
        } else {
          this.#emitMessage(payload, isBinary);
        }
      }
    }
  }

  #emitMessage(payload, isBinary) {
    if (isBinary) {
      this.emit('message', payload, true);
    } else {
      this.emit('message', payload.toString('utf8'), false);
    }
  }

  #write(frame) {
    if (this.destroyed) return false;
    try {
      return this.socket.write(frame);
    } catch {
      this.#finish('write-error');
      return false;
    }
  }

  /** 发送 JSON 文本帧 */
  sendText(objOrString) {
    const text = typeof objOrString === 'string' ? objOrString : JSON.stringify(objOrString);
    return this.#write(encodeFrame(0x1, text));
  }

  /** 发送二进制帧 */
  sendBinary(buf) {
    return this.#write(encodeFrame(0x2, buf));
  }

  close(code = 1000, reason = '') {
    if (this.destroyed) return;
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      this.socket.write(encodeFrame(0x8, payload));
    } catch {
      /* ignore */
    }
    setTimeout(() => this.#finish('closing'), 60).unref?.();
  }

  destroy() {
    this.#finish('destroyed');
  }
}

/**
 * 给 http.Server 挂载 WebSocket 路由。
 * @param {import('node:http').Server} httpServer
 * @param {string} path 例如 '/ws/voice'
 * @param {(conn: WsConnection, req: import('node:http').IncomingMessage) => void} onConnection
 */
export function attachWsServer(httpServer, path, onConnection, authorize = () => true) {
  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const key = req.headers['sec-websocket-key'];
      const upgrade = String(req.headers.upgrade || '').toLowerCase();
      if (url.pathname !== path || !key || upgrade !== 'websocket') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!authorize(req)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
      if (head && head.length) socket.unshift(head);
      const conn = new WsConnection(socket);
      onConnection(conn, req);
    } catch {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });
}

export default { attachWsServer, WsConnection };
