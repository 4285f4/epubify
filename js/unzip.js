/* ============================================================
 * unzip.js — 最小 ZIP 读取器（EPUB 解包用）
 * 只依赖浏览器原生的 DecompressionStream('deflate-raw')
 * ============================================================ */
(function (global) {
  'use strict';

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  /** 从末尾向前找 End of Central Directory（允许文件尾部有附加数据） */
  function findEOCD(b) {
    var stop = Math.max(0, b.length - 65557 - 22);
    for (var i = b.length - 22; i >= stop; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
        return i;
      }
    }
    return -1;
  }

  function decodeName(bytes, utf8Flag) {
    // 绝大多数 EPUB 用 UTF-8；未置位时也优先按 UTF-8 尝试，失败再退回 latin1
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  }

  async function inflateRaw(raw) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 DecompressionStream，无法解压 EPUB');
    }
    var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  function ZipReader(bytes) {
    this.bytes = bytes;
    this.entries = [];
    this._parse();
  }

  ZipReader.prototype._parse = function () {
    var b = this.bytes;
    var eocd = findEOCD(b);
    if (eocd < 0) throw new Error('不是有效的 ZIP/EPUB 文件');

    var count = u16(b, eocd + 10);
    var cdOffset = u32(b, eocd + 16);
    if (cdOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 格式');

    var pos = cdOffset;
    for (var i = 0; i < count; i++) {
      if (u32(b, pos) !== 0x02014b50) break;
      var flags = u16(b, pos + 8);
      var method = u16(b, pos + 10);
      var compSize = u32(b, pos + 20);
      var uncompSize = u32(b, pos + 24);
      var nameLen = u16(b, pos + 28);
      var extraLen = u16(b, pos + 30);
      var commentLen = u16(b, pos + 32);
      var localOff = u32(b, pos + 42);

      var name = decodeName(b.subarray(pos + 46, pos + 46 + nameLen), flags & 0x800);
      this.entries.push({
        name: name,
        method: method,
        compSize: compSize,
        size: uncompSize,
        localOffset: localOff
      });
      pos += 46 + nameLen + extraLen + commentLen;
    }
  };

  ZipReader.prototype.has = function (name) {
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].name === name) return true;
    }
    return false;
  };

  ZipReader.prototype.names = function () {
    return this.entries.map(function (e) { return e.name; });
  };

  /** 按名称读取条目，返回 Uint8Array */
  ZipReader.prototype.read = async function (name) {
    var e = null;
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].name === name) { e = this.entries[i]; break; }
    }
    if (!e) throw new Error('包里找不到：' + name);

    var b = this.bytes;
    var lh = e.localOffset;
    if (u32(b, lh) !== 0x04034b50) throw new Error('ZIP 结构异常：' + name);

    var nameLen = u16(b, lh + 26);
    var extraLen = u16(b, lh + 28);
    var dataStart = lh + 30 + nameLen + extraLen;
    var raw = b.subarray(dataStart, dataStart + e.compSize);

    if (e.method === 0) return raw;             // STORED
    if (e.method === 8) return inflateRaw(raw); // DEFLATE
    throw new Error('不支持的压缩方式 ' + e.method + '：' + name);
  };

  /** 按名称读取并解码为字符串 */
  ZipReader.prototype.readText = async function (name) {
    var bytes = await this.read(name);
    return new TextDecoder('utf-8').decode(bytes);
  };

  global.EasyUnzip = {
    open: function (arrayBuffer) {
      return new ZipReader(new Uint8Array(arrayBuffer));
    },
    ZipReader: ZipReader
  };
})(typeof self !== 'undefined' ? self : this);
