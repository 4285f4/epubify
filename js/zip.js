/* ============================================================
 * zip.js — 极简 ZIP 写入器（EPUB OCF 规范兼容）
 * 零依赖：deflate 走浏览器原生 CompressionStream('deflate-raw')
 * 不支持时降级为 STORED（不压缩），仍可正常阅读
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- CRC32 ---------- */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(buf) {
    var c = -1;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  /* ---------- 原生 deflate ---------- */
  var HAS_DEFLATE = typeof CompressionStream !== 'undefined';
  var DEFLATE_OK = HAS_DEFLATE;
  try {
    // 部分环境声明了 CompressionStream 但不认 deflate-raw
    if (HAS_DEFLATE) new CompressionStream('deflate-raw');
  } catch (e) {
    DEFLATE_OK = false;
  }

  function deflateRaw(bytes) {
    if (!DEFLATE_OK) return Promise.resolve(null);
    var cs = new CompressionStream('deflate-raw');
    var writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Response(cs.readable).arrayBuffer().then(function (ab) {
      return new Uint8Array(ab);
    });
  }

  /* ---------- DOS 时间 ---------- */
  function dosDateTime(d) {
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  /* ---------- 二进制写入辅助 ---------- */
  function Writer() {
    this.chunks = [];
    this.length = 0;
  }
  Writer.prototype.u16 = function (v) {
    var b = new Uint8Array(2);
    b[0] = v & 0xFF; b[1] = (v >>> 8) & 0xFF;
    this.push(b);
  };
  Writer.prototype.u32 = function (v) {
    var b = new Uint8Array(4);
    b[0] = v & 0xFF; b[1] = (v >>> 8) & 0xFF; b[2] = (v >>> 16) & 0xFF; b[3] = (v >>> 24) & 0xFF;
    this.push(b);
  };
  Writer.prototype.push = function (b) {
    this.chunks.push(b);
    this.length += b.length;
  };
  Writer.prototype.blob = function (type) {
    return new Blob(this.chunks, { type: type || 'application/octet-stream' });
  };

  /* ---------- ZipWriter ---------- */
  function ZipWriter() {
    this.items = [];      // 中央目录记录
    this.local = [];      // 本地文件头 + 数据
    this.offset = 0;
  }

  /**
   * @param {string} name  归档内路径
   * @param {Uint8Array|string} data
   * @param {object} opt   { store: true 强制不压缩 }
   */
  ZipWriter.prototype.add = function (name, data, opt) {
    opt = opt || {};
    var self = this;
    var nameBytes = new TextEncoder().encode(name);
    var raw = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    var crc = crc32(raw);
    var now = dosDateTime(new Date());

    return (opt.store || !DEFLATE_OK ? Promise.resolve(null) : deflateRaw(raw)).then(function (comp) {
      // 压缩反而变大时改用 STORED
      var useDeflate = !!comp && comp.length < raw.length;
      var payload = useDeflate ? comp : raw;
      var method = useDeflate ? 8 : 0;

      var w = new Writer();
      w.u32(0x04034b50);            // local file header
      w.u16(20);                    // version needed
      w.u16(0x0800);                // flags: UTF-8 文件名
      w.u16(method);
      w.u16(now.time);
      w.u16(now.date);
      w.u32(crc);
      w.u32(payload.length);
      w.u32(raw.length);
      w.u16(nameBytes.length);
      w.u16(0);                     // extra len —— 必须为 0，EPUB 对 mimetype 条目有此要求
      w.push(nameBytes);
      w.push(payload);

      self.local.push(w);
      self.items.push({
        name: nameBytes,
        crc: crc,
        compSize: payload.length,
        rawSize: raw.length,
        method: method,
        offset: self.offset,
        time: now.time,
        date: now.date
      });
      self.offset += w.length;
      return payload.length;
    });
  };

  ZipWriter.prototype.generate = function () {
    var cd = new Writer();
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      cd.u32(0x02014b50);           // central directory header
      cd.u16(20);                   // version made by
      cd.u16(20);                   // version needed
      cd.u16(0x0800);
      cd.u16(it.method);
      cd.u16(it.time);
      cd.u16(it.date);
      cd.u32(it.crc);
      cd.u32(it.compSize);
      cd.u32(it.rawSize);
      cd.u16(it.name.length);
      cd.u16(0);                    // extra
      cd.u16(0);                    // comment
      cd.u16(0);                    // disk number
      cd.u16(0);                    // internal attrs
      cd.u32(0);                    // external attrs
      cd.u32(it.offset);
      cd.push(it.name);
    }

    var eocd = new Writer();
    eocd.u32(0x06054b50);
    eocd.u16(0);
    eocd.u16(0);
    eocd.u16(this.items.length);
    eocd.u16(this.items.length);
    eocd.u32(cd.length);
    eocd.u32(this.offset);
    eocd.u16(0);

    var parts = [];
    for (var j = 0; j < this.local.length; j++) parts.push(this.local[j].blob());
    parts.push(cd.blob());
    parts.push(eocd.blob());
    return new Blob(parts, { type: 'application/epub+zip' });
  };

  global.EasyZip = {
    ZipWriter: ZipWriter,
    crc32: crc32,
    hasDeflate: function () { return DEFLATE_OK; }
  };
})(typeof self !== 'undefined' ? self : this);
