// Minimal WebSocket server (RFC 6455) using only Node built-ins.
// Supports text frames, ping/pong, close. Enough for a game server.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024; // players only send short messages

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.open = true;
    this.alive = true;
    sock.setNoDelay(true);
    sock.on('data', (d) => this._onData(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }

  send(obj) {
    if (!this.open) return;
    const data = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
    this._frame(0x1, data);
  }

  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code);
    this._frame(0x8, b);
    this.sock.end();
    this._closed();
  }

  ping() { this._frame(0x9, Buffer.alloc(0)); }

  _frame(opcode, data) {
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.sock.write(Buffer.concat([header, data])); } catch { this._closed(); }
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      if (len > MAX_PAYLOAD || !masked) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this._frame(0xA, payload); continue; }
      if (opcode === 0xA) { this.alive = true; continue; }
      if (opcode === 0x0 || opcode === 0x1) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          let msg;
          try { msg = JSON.parse(text); } catch { continue; }
          this.emit('message', msg);
        }
      }
    }
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
}

// Attach to an http.Server. onConnect(socket, req) is called for each new connection.
function attach(server, path, onConnect) {
  const sockets = new Set();
  server.on('upgrade', (req, sock) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      sock.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const ws = new Socket(sock);
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    onConnect(ws, req);
  });
  // Heartbeat: drop dead connections
  const timer = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.alive) { ws.sock.destroy(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 30000);
  timer.unref();
  return sockets;
}

module.exports = { attach };
