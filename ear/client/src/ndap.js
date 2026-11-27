// NDAP-8 — JavaScript port of the Python reference implementation
// (protocols/ndap.py, protocol version 8, the adaptive profile).
//
// Single ES module, zero dependencies, no node: imports — it runs
// unchanged under Node and in a Cloudflare Worker. Function names
// mirror the Python module (snake_case kept on purpose). Samples are
// Float64Array, byte strings are Uint8Array, and the WAV codec works
// on byte arrays (file I/O belongs to the caller).
//
// Things the Python gets from libraries and this module therefore
// carries itself:
//   * zlib — a bit-exact port of zlib 1.3's level-9 deflate. This is
//     NOT optional: section lengths are derived from the compressed
//     size, so a deflate that merely produces a valid stream (e.g.
//     Node's Chromium-fork zlib, which emits different lengths than
//     stock zlib) breaks cross-implementation segment chaining.
//   * CRC-32, CRC-16/HQX, Adler-32, SHA-256/HMAC.
//   * complex arithmetic and the least-squares detector (normal
//     equations on the conjugate-augmented basis, Gauss-Jordan).

export const SR = 48000;

// ------------------------------------------------------------ byte helpers
function concatBytes(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toHex(b) {
  let s = "";
  for (const v of b) s += v.toString(16).padStart(2, "0");
  return s;
}

function be16(v) { return Uint8Array.of((v >>> 8) & 255, v & 255); }
function be32(v) { return Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
function rd16(b, o) { return (b[o] << 8) | b[o + 1]; }
function rd32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
const pmod = (a, m) => ((a % m) + m) % m;

// round half to even (numpy.round on floats)
function roundHalfEven(x) {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) return r - 1;
  return r;
}

// ------------------------------------------------------------ checksums
const _CRC_T = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  _CRC_T[n] = c >>> 0;
}

export function crc32(d) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < d.length; i++) c = _CRC_T[(c ^ d[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function adler32(d) {
  let a = 1, b = 0;
  for (let i = 0; i < d.length; i++) {
    a = (a + d[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// binascii.crc_hqx(data, 0xFFFF): CRC-CCITT, poly 0x1021, MSB first.
function _crc16(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}
export { _crc16 };

// SHA-256 / HMAC-SHA256 (constants derived, not typed in)
const _SHA_K = new Uint32Array(64);
const _SHA_H0 = new Uint32Array(8);
(() => {
  const primes = [];
  for (let n = 2; primes.length < 64; n++) {
    let p = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; }
    if (p) primes.push(n);
  }
  const frac = (v) => Math.floor((v - Math.floor(v)) * 4294967296) >>> 0;
  for (let i = 0; i < 64; i++) _SHA_K[i] = frac(Math.cbrt(primes[i]));
  for (let i = 0; i < 8; i++) _SHA_H0[i] = frac(Math.sqrt(primes[i]));
})();

export function sha256(msg) {
  const h = Uint32Array.from(_SHA_H0);
  const l = msg.length;
  const padLen = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(padLen);
  m.set(msg);
  m[l] = 0x80;
  const bits = l * 8;
  m.set(be32(Math.floor(bits / 4294967296)), padLen - 8);
  m.set(be32(bits >>> 0), padLen - 4);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = rd32(m, off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + _SHA_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) out.set(be32(h[i]), 4 * i);
  return out;
}

export function hmac_sha256(key, msg) {
  if (key.length > 64) key = sha256(key);
  const k = new Uint8Array(64);
  k.set(key);
  const ipad = k.map((v) => v ^ 0x36);
  const opad = k.map((v) => v ^ 0x5c);
  return sha256(concatBytes(opad, sha256(concatBytes(ipad, msg))));
}

// ------------------------------------------------------------ zlib (deflate level 9, inflate)
// Bit-exact port of zlib 1.3 deflate at level 9 (deflate_slow,
// good 32 / lazy 258 / nice 258 / chain 4096), memLevel 8, default
// strategy, single Z_FINISH call — i.e. Python's zlib.compress(d, 9).
// Verified byte-for-byte against CPython's zlib in test/zlib-exact.mjs.
// Inputs are limited to < 32506 bytes (no window slide is modelled);
// NDAP chunks are at most a few KB.

const _EXTRA_LBITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const _EXTRA_DBITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const _EXTRA_BLBITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
const _BL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const L_CODES = 286, D_CODES = 30, BL_CODES = 19, HEAP_SIZE = 573, MAX_BITS = 15;
const END_BLOCK = 256, LITERALS = 256;

function bi_reverse(code, len) {
  let res = 0;
  do { res |= code & 1; code >>>= 1; res <<= 1; } while (--len > 0);
  return res >>> 1;
}

function gen_codes(codes, lens, max_code, bl_count) {
  const next = new Int32Array(MAX_BITS + 1);
  let code = 0;
  for (let bits = 1; bits <= MAX_BITS; bits++) {
    code = (code + bl_count[bits - 1]) << 1;
    next[bits] = code;
  }
  for (let n = 0; n <= max_code; n++) {
    const l = lens[n];
    if (l === 0) continue;
    codes[n] = bi_reverse(next[l]++, l);
  }
}

const _ZT = (() => {
  const base_length = new Int32Array(29), length_code = new Uint8Array(256);
  let length = 0, code, n;
  for (code = 0; code < 28; code++) {
    base_length[code] = length;
    for (n = 0; n < (1 << _EXTRA_LBITS[code]); n++) length_code[length++] = code;
  }
  length_code[length - 1] = code;
  const base_dist = new Int32Array(30), dist_code = new Uint8Array(512);
  let dist = 0;
  for (code = 0; code < 16; code++) {
    base_dist[code] = dist;
    for (n = 0; n < (1 << _EXTRA_DBITS[code]); n++) dist_code[dist++] = code;
  }
  dist >>= 7;
  for (; code < D_CODES; code++) {
    base_dist[code] = dist << 7;
    for (n = 0; n < (1 << (_EXTRA_DBITS[code] - 7)); n++) dist_code[256 + dist++] = code;
  }
  const bl_count = new Int32Array(MAX_BITS + 1);
  const sl_len = new Int32Array(L_CODES + 2), sl_code = new Int32Array(L_CODES + 2);
  n = 0;
  while (n <= 143) { sl_len[n++] = 8; bl_count[8]++; }
  while (n <= 255) { sl_len[n++] = 9; bl_count[9]++; }
  while (n <= 279) { sl_len[n++] = 7; bl_count[7]++; }
  while (n <= 287) { sl_len[n++] = 8; bl_count[8]++; }
  gen_codes(sl_code, sl_len, L_CODES + 1, bl_count);
  const sd_len = new Int32Array(D_CODES).fill(5), sd_code = new Int32Array(D_CODES);
  for (n = 0; n < D_CODES; n++) sd_code[n] = bi_reverse(n, 5);
  return { base_length, length_code, base_dist, dist_code,
           static_l: { len: sl_len, code: sl_code },
           static_d: { len: sd_len, code: sd_code } };
})();

const d_code = (dist) => (dist < 256 ? _ZT.dist_code[dist] : _ZT.dist_code[256 + (dist >>> 7)]);

function newTree(size) {
  return { freq: new Int32Array(size), code: new Int32Array(size),
           len: new Int32Array(size), dad: new Int32Array(size), max_code: 0 };
}

export function zlib_compress(data) {
  const n = data.length;
  if (n >= 32768 - 262) throw new RangeError("zlib_compress: input too large for the exact-zlib port");
  const WSIZE = 32768, WMASK = WSIZE - 1, MIN_LOOKAHEAD = 262, MAX_DIST = WSIZE - MIN_LOOKAHEAD;
  const HASH_MASK = (1 << 15) - 1, HASH_SHIFT = 5, TOO_FAR = 4096;
  const GOOD = 32, MAX_LAZY = 258, NICE = 258, MAX_CHAIN = 4096;
  const win = new Uint8Array(n + 258 + 16);
  win.set(data);
  const head = new Int32Array(HASH_MASK + 1), prev = new Int32Array(WSIZE);

  // ---- bit output
  const out = [0x78, 0xDA];
  let bitbuf = 0, bitcnt = 0;
  const send_bits = (v, l) => {
    bitbuf |= v << bitcnt; bitcnt += l;
    while (bitcnt >= 8) { out.push(bitbuf & 255); bitbuf >>>= 8; bitcnt -= 8; }
  };
  const bi_windup = () => { if (bitcnt > 0) out.push(bitbuf & 255); bitbuf = 0; bitcnt = 0; };

  // ---- trees
  const dyn_l = newTree(HEAP_SIZE), dyn_d = newTree(2 * D_CODES + 1), bl_t = newTree(2 * BL_CODES + 1);
  const heap = new Int32Array(HEAP_SIZE), depth = new Uint8Array(HEAP_SIZE);
  const bl_count = new Int32Array(MAX_BITS + 1);
  let heap_len = 0, heap_max = 0, opt_len = 0, static_len = 0;
  const symD = new Uint16Array(16383), symL = new Uint8Array(16383);
  let sym_next = 0;
  const l_desc = { tree: dyn_l, stree: _ZT.static_l, extra: _EXTRA_LBITS, base: LITERALS + 1, elems: L_CODES, maxlen: MAX_BITS };
  const d_desc = { tree: dyn_d, stree: _ZT.static_d, extra: _EXTRA_DBITS, base: 0, elems: D_CODES, maxlen: MAX_BITS };
  const bl_desc = { tree: bl_t, stree: null, extra: _EXTRA_BLBITS, base: 0, elems: BL_CODES, maxlen: 7 };

  const init_block = () => {
    dyn_l.freq.fill(0, 0, L_CODES); dyn_d.freq.fill(0, 0, D_CODES); bl_t.freq.fill(0, 0, BL_CODES);
    dyn_l.freq[END_BLOCK] = 1;
    opt_len = static_len = 0; sym_next = 0;
  };

  const smaller = (t, a, b) => t.freq[a] < t.freq[b] || (t.freq[a] === t.freq[b] && depth[a] <= depth[b]);
  const pqdownheap = (t, k) => {
    const v = heap[k];
    let j = k << 1;
    while (j <= heap_len) {
      if (j < heap_len && smaller(t, heap[j + 1], heap[j])) j++;
      if (smaller(t, v, heap[j])) break;
      heap[k] = heap[j]; k = j; j <<= 1;
    }
    heap[k] = v;
  };

  const gen_bitlen = (desc) => {
    const t = desc.tree, stree = desc.stree, extra = desc.extra, base = desc.base;
    const max_code = desc.tree.max_code, max_length = desc.maxlen;
    let overflow = 0, h, nn, m, bits, xbits, f;
    bl_count.fill(0);
    t.len[heap[heap_max]] = 0;
    for (h = heap_max + 1; h < HEAP_SIZE; h++) {
      nn = heap[h];
      bits = t.len[t.dad[nn]] + 1;
      if (bits > max_length) { bits = max_length; overflow++; }
      t.len[nn] = bits;
      if (nn > max_code) continue;
      bl_count[bits]++;
      xbits = 0;
      if (nn >= base) xbits = extra[nn - base];
      f = t.freq[nn];
      opt_len += f * (bits + xbits);
      if (stree) static_len += f * (stree.len[nn] + xbits);
    }
    if (overflow === 0) return;
    do {
      bits = max_length - 1;
      while (bl_count[bits] === 0) bits--;
      bl_count[bits]--; bl_count[bits + 1] += 2; bl_count[max_length]--;
      overflow -= 2;
    } while (overflow > 0);
    for (bits = max_length; bits !== 0; bits--) {
      nn = bl_count[bits];
      while (nn !== 0) {
        m = heap[--h];
        if (m > max_code) continue;
        if (t.len[m] !== bits) { opt_len += (bits - t.len[m]) * t.freq[m]; t.len[m] = bits; }
        nn--;
      }
    }
  };

  const build_tree = (desc) => {
    const t = desc.tree, stree = desc.stree, elems = desc.elems;
    let nn, m, max_code = -1, node;
    heap_len = 0; heap_max = HEAP_SIZE;
    for (nn = 0; nn < elems; nn++) {
      if (t.freq[nn] !== 0) { heap[++heap_len] = max_code = nn; depth[nn] = 0; } else t.len[nn] = 0;
    }
    while (heap_len < 2) {
      node = heap[++heap_len] = (max_code < 2 ? ++max_code : 0);
      t.freq[node] = 1; depth[node] = 0; opt_len--;
      if (stree) static_len -= stree.len[node];
    }
    t.max_code = max_code;
    for (nn = heap_len >> 1; nn >= 1; nn--) pqdownheap(t, nn);
    node = elems;
    do {
      nn = heap[1]; heap[1] = heap[heap_len--]; pqdownheap(t, 1);
      m = heap[1];
      heap[--heap_max] = nn; heap[--heap_max] = m;
      t.freq[node] = t.freq[nn] + t.freq[m];
      depth[node] = (depth[nn] >= depth[m] ? depth[nn] : depth[m]) + 1;
      t.dad[nn] = t.dad[m] = node;
      heap[1] = node++;
      pqdownheap(t, 1);
    } while (heap_len >= 2);
    heap[--heap_max] = heap[1];
    gen_bitlen(desc);
    gen_codes(t.code, t.len, max_code, bl_count);
  };

  const scan_tree = (t, max_code) => {
    let prevlen = -1, nextlen = t.len[0], count = 0, max_count = 7, min_count = 4, curlen;
    if (nextlen === 0) { max_count = 138; min_count = 3; }
    t.len[max_code + 1] = 0xffff;
    for (let nn = 0; nn <= max_code; nn++) {
      curlen = nextlen; nextlen = t.len[nn + 1];
      if (++count < max_count && curlen === nextlen) continue;
      else if (count < min_count) bl_t.freq[curlen] += count;
      else if (curlen !== 0) { if (curlen !== prevlen) bl_t.freq[curlen]++; bl_t.freq[16]++; }
      else if (count <= 10) bl_t.freq[17]++;
      else bl_t.freq[18]++;
      count = 0; prevlen = curlen;
      if (nextlen === 0) { max_count = 138; min_count = 3; }
      else if (curlen === nextlen) { max_count = 6; min_count = 3; }
      else { max_count = 7; min_count = 4; }
    }
  };

  const send_code = (c, t) => send_bits(t.code[c], t.len[c]);
  const send_tree = (t, max_code) => {
    let prevlen = -1, nextlen = t.len[0], count = 0, max_count = 7, min_count = 4, curlen;
    if (nextlen === 0) { max_count = 138; min_count = 3; }
    for (let nn = 0; nn <= max_code; nn++) {
      curlen = nextlen; nextlen = t.len[nn + 1];
      if (++count < max_count && curlen === nextlen) continue;
      else if (count < min_count) { do { send_code(curlen, bl_t); } while (--count !== 0); }
      else if (curlen !== 0) {
        if (curlen !== prevlen) { send_code(curlen, bl_t); count--; }
        send_code(16, bl_t); send_bits(count - 3, 2);
      } else if (count <= 10) { send_code(17, bl_t); send_bits(count - 3, 3); }
      else { send_code(18, bl_t); send_bits(count - 11, 7); }
      count = 0; prevlen = curlen;
      if (nextlen === 0) { max_count = 138; min_count = 3; }
      else if (curlen === nextlen) { max_count = 6; min_count = 3; }
      else { max_count = 7; min_count = 4; }
    }
  };

  const build_bl_tree = () => {
    scan_tree(dyn_l, l_desc.tree.max_code);
    scan_tree(dyn_d, d_desc.tree.max_code);
    build_tree(bl_desc);
    let max_blindex;
    for (max_blindex = BL_CODES - 1; max_blindex >= 3; max_blindex--) {
      if (bl_t.len[_BL_ORDER[max_blindex]] !== 0) break;
    }
    opt_len += 3 * (max_blindex + 1) + 5 + 5 + 4;
    return max_blindex;
  };

  const compress_block = (lt, dt) => {
    for (let i = 0; i < sym_next; i++) {
      let dist = symD[i], lc = symL[i];
      if (dist === 0) send_code(lc, lt);
      else {
        let code = _ZT.length_code[lc];
        send_code(code + LITERALS + 1, lt);
        let extra = _EXTRA_LBITS[code];
        if (extra !== 0) { lc -= _ZT.base_length[code]; send_bits(lc, extra); }
        dist--;
        code = d_code(dist);
        send_code(code, dt);
        extra = _EXTRA_DBITS[code];
        if (extra !== 0) { dist -= _ZT.base_dist[code]; send_bits(dist, extra); }
      }
    }
    send_code(END_BLOCK, lt);
  };

  const flush_block = (buf_start, stored_len, last) => {
    build_tree(l_desc); build_tree(d_desc);
    const max_blindex = build_bl_tree();
    let opt_lenb = (opt_len + 3 + 7) >>> 3;
    const static_lenb = (static_len + 3 + 7) >>> 3;
    if (static_lenb <= opt_lenb) opt_lenb = static_lenb;
    if (stored_len + 4 <= opt_lenb && buf_start >= 0) {
      send_bits(last, 3);                       // STORED_BLOCK << 1 | last
      bi_windup();
      out.push(stored_len & 255, (stored_len >>> 8) & 255, ~stored_len & 255, (~stored_len >>> 8) & 255);
      for (let i = 0; i < stored_len; i++) out.push(win[buf_start + i]);
    } else if (static_lenb === opt_lenb) {
      send_bits((1 << 1) + last, 3);
      compress_block(_ZT.static_l, _ZT.static_d);
    } else {
      send_bits((2 << 1) + last, 3);
      const lcodes = l_desc.tree.max_code + 1, dcodes = d_desc.tree.max_code + 1, blcodes = max_blindex + 1;
      send_bits(lcodes - 257, 5); send_bits(dcodes - 1, 5); send_bits(blcodes - 4, 4);
      for (let rank = 0; rank < blcodes; rank++) send_bits(bl_t.len[_BL_ORDER[rank]], 3);
      send_tree(dyn_l, lcodes - 1);
      send_tree(dyn_d, dcodes - 1);
      compress_block(dyn_l, dyn_d);
    }
    init_block();
    if (last) bi_windup();
  };

  const tally_lit = (c) => {
    symD[sym_next] = 0; symL[sym_next++] = c;
    dyn_l.freq[c]++;
    return sym_next === 16383;
  };
  const tally_dist = (dist, lc) => {
    symD[sym_next] = dist; symL[sym_next++] = lc;
    dist--;
    dyn_l.freq[_ZT.length_code[lc] + LITERALS + 1]++;
    dyn_d.freq[d_code(dist)]++;
    return sym_next === 16383;
  };

  // ---- deflate_slow
  let strstart = 0, lookahead = n, block_start = 0, ins_h = 0;
  let match_length = 2, prev_length = 2, match_start = 0, prev_match = 0, match_available = 0;
  if (n >= 1) ins_h = win[0];
  if (n >= 2) ins_h = ((ins_h << HASH_SHIFT) ^ win[1]) & HASH_MASK;
  init_block();

  const insert_string = (str) => {
    ins_h = ((ins_h << HASH_SHIFT) ^ win[str + 2]) & HASH_MASK;
    const h = head[ins_h];
    prev[str & WMASK] = h;
    head[ins_h] = str;
    return h;
  };

  const longest_match = (cur_match) => {
    let chain = MAX_CHAIN, best_len = prev_length, nice = NICE;
    const scan = strstart;
    const limit = strstart > MAX_DIST ? strstart - MAX_DIST : 0;
    let scan_end1 = win[scan + best_len - 1], scan_end = win[scan + best_len];
    if (prev_length >= GOOD) chain >>= 2;
    if (nice > lookahead) nice = lookahead;
    do {
      const m = cur_match;
      if (win[m + best_len] !== scan_end || win[m + best_len - 1] !== scan_end1 ||
          win[m] !== win[scan] || win[m + 1] !== win[scan + 1]) continue;
      let p = 3;
      while (p < 258 && win[scan + p] === win[m + p]) p++;
      const len = p;
      if (len > best_len) {
        match_start = cur_match; best_len = len;
        if (len >= nice) break;
        scan_end1 = win[scan + best_len - 1]; scan_end = win[scan + best_len];
      }
    } while ((cur_match = prev[cur_match & WMASK]) > limit && --chain !== 0);
    return best_len <= lookahead ? best_len : lookahead;
  };

  for (;;) {
    if (lookahead === 0) break;
    let hash_head = 0;
    if (lookahead >= 3) hash_head = insert_string(strstart);
    prev_length = match_length; prev_match = match_start;
    match_length = 2;
    if (hash_head !== 0 && prev_length < MAX_LAZY && strstart - hash_head <= MAX_DIST) {
      match_length = longest_match(hash_head);
      if (match_length <= 5 && (match_length === 3 && strstart - match_start > TOO_FAR)) match_length = 2;
    }
    if (prev_length >= 3 && match_length <= prev_length) {
      const max_insert = strstart + lookahead - 3;
      const bflush = tally_dist(strstart - 1 - prev_match, prev_length - 3);
      lookahead -= prev_length - 1;
      prev_length -= 2;
      do {
        if (++strstart <= max_insert) insert_string(strstart);
      } while (--prev_length !== 0);
      match_available = 0; match_length = 2; strstart++;
      if (bflush) { flush_block(block_start, strstart - block_start, 0); block_start = strstart; }
    } else if (match_available) {
      const bflush = tally_lit(win[strstart - 1]);
      if (bflush) { flush_block(block_start, strstart - block_start, 0); block_start = strstart; }
      strstart++; lookahead--;
    } else {
      match_available = 1; strstart++; lookahead--;
    }
  }
  if (match_available) { tally_lit(win[strstart - 1]); match_available = 0; }
  flush_block(block_start, strstart - block_start, 1);
  const ad = adler32(data);
  out.push((ad >>> 24) & 255, (ad >>> 16) & 255, (ad >>> 8) & 255, ad & 255);
  return Uint8Array.from(out);
}

// Inflate (puff-style). Verifies the zlib header and Adler-32 like
// zlib.decompress; trailing bytes after the stream are ignored.
export function zlib_decompress(buf) {
  if (buf.length < 6) throw new Error("zlib: incomplete or truncated stream");
  if (((buf[0] << 8) | buf[1]) % 31 !== 0 || (buf[0] & 15) !== 8 || (buf[0] >> 4) > 7) throw new Error("zlib: incorrect header check");
  if (buf[1] & 0x20) throw new Error("zlib: preset dictionary not supported");
  let pos = 2, bitbuf = 0, bitcnt = 0;
  const out = [];
  const bits = (need) => {
    let v = bitbuf;
    while (bitcnt < need) {
      if (pos >= buf.length) throw new Error("zlib: incomplete or truncated stream");
      v |= buf[pos++] << bitcnt; bitcnt += 8;
    }
    bitbuf = v >>> need; bitcnt -= need;
    return v & ((1 << need) - 1);
  };
  const mk = (lengths, n) => {
    const count = new Int32Array(16), symbol = new Int32Array(n), offs = new Int32Array(16);
    for (let i = 0; i < n; i++) count[lengths[i]]++;
    for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
    for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbol[offs[lengths[i]]++] = i;
    return { count, symbol };
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error("zlib: invalid code");
  };
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const codes = (lh, dh) => {
    for (;;) {
      let sym = decode(lh);
      if (sym < 256) out.push(sym);
      else if (sym === 256) return;
      else {
        sym -= 257;
        if (sym >= 29) throw new Error("zlib: invalid literal/length code");
        const len = LBASE[sym] + bits(_EXTRA_LBITS[sym]);
        const ds = decode(dh);
        if (ds >= 30) throw new Error("zlib: invalid distance code");
        const dist = DBASE[ds] + bits(_EXTRA_DBITS[ds]);
        if (dist > out.length) throw new Error("zlib: invalid distance too far back");
        for (let i = 0; i < len; i++) out.push(out[out.length - dist]);
      }
    }
  };
  let fixedL = null, fixedD = null;
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;
      if (pos + 4 > buf.length) throw new Error("zlib: incomplete or truncated stream");
      const len = buf[pos] | (buf[pos + 1] << 8), nlen = buf[pos + 2] | (buf[pos + 3] << 8);
      pos += 4;
      if (len !== (~nlen & 0xffff)) throw new Error("zlib: invalid stored block lengths");
      if (pos + len > buf.length) throw new Error("zlib: incomplete or truncated stream");
      for (let i = 0; i < len; i++) out.push(buf[pos + i]);
      pos += len;
    } else if (type === 1) {
      if (!fixedL) {
        const l = new Int32Array(288);
        for (let i = 0; i < 144; i++) l[i] = 8;
        for (let i = 144; i < 256; i++) l[i] = 9;
        for (let i = 256; i < 280; i++) l[i] = 7;
        for (let i = 280; i < 288; i++) l[i] = 8;
        fixedL = mk(l, 288);
        fixedD = mk(new Int32Array(30).fill(5), 30);
      }
      codes(fixedL, fixedD);
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw new Error("zlib: too many length or distance symbols");
      const lengths = new Int32Array(320);
      for (let i = 0; i < ncode; i++) lengths[_BL_ORDER[i]] = bits(3);
      const lencode = mk(lengths.slice(0, 19), 19);
      let idx = 0;
      const ll = new Int32Array(nlen + ndist);
      while (idx < nlen + ndist) {
        let sym = decode(lencode);
        if (sym < 16) ll[idx++] = sym;
        else {
          let len = 0, rep;
          if (sym === 16) { if (idx === 0) throw new Error("zlib: invalid bit length repeat"); len = ll[idx - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (idx + rep > nlen + ndist) throw new Error("zlib: invalid bit length repeat");
          while (rep--) ll[idx++] = len;
        }
      }
      codes(mk(ll.slice(0, nlen), nlen), mk(ll.slice(nlen), ndist));
    } else throw new Error("zlib: invalid block type");
  } while (!last);
  bitbuf = 0; bitcnt = 0;
  if (pos + 4 > buf.length) throw new Error("zlib: incomplete or truncated stream");
  const data = Uint8Array.from(out);
  if (rd32(buf, pos) !== adler32(data)) throw new Error("zlib: incorrect data check");
  return data;
}

// ------------------------------------------------------------ WAV IO
// 48 kHz mono 16-bit WAV, on byte arrays (callers do the file I/O).

export function write_wav(samples) {
  const n = samples.length;
  const out = new Uint8Array(44 + 2 * n);
  const dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, "RIFF"); dv.setUint32(4, 36 + 2 * n, true); tag(8, "WAVE");
  tag(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag(36, "data"); dv.setUint32(40, 2 * n, true);
  for (let i = 0; i < n; i++) {
    let v = samples[i] * 32767;
    v = v !== v ? 0 : Math.trunc(Math.min(32767, Math.max(-32768, v)));   // astype(int16) truncates
    dv.setInt16(44 + 2 * i, v, true);
  }
  return out;
}

export function read_wav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let o = 12, fmt = null, data = null;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    let size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true),
              rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === "data") {
      size = Math.min(size, bytes.length - body);
      data = { off: body, size };
      break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt/data chunk");
  if (fmt.rate !== SR || fmt.channels !== 1) throw new Error("need 48 kHz mono WAV");
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error("need 16-bit PCM WAV");
  const n = data.size >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(data.off + 2 * i, true) / 32767.0;
  return out;
}

// ------------------------------------------------------------ Reed-Solomon codec
// GF(256), primitive polynomial 0x11D.
const _EXP = new Uint8Array(512);
const _LOG = new Int32Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    _EXP[i] = x; _LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) _EXP[i] = _EXP[i - 255];
}

const _mul = (a, b) => (a === 0 || b === 0 ? 0 : _EXP[_LOG[a] + _LOG[b]]);
function _div(a, b) {
  if (b === 0) throw new Error("GF division by zero");
  return a === 0 ? 0 : _EXP[pmod(_LOG[a] - _LOG[b], 255)];
}
const _pow = (a, p) => (a === 0 ? 0 : _EXP[pmod(_LOG[a] * p, 255)]);

function _poly_mul_hi(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    if (a) for (let j = 0; j < q.length; j++) if (q[j]) r[i + j] ^= _mul(a, q[j]);
  }
  return r;
}

function _poly_eval_hi(p, x) {
  let y = 0;
  for (let i = 0; i < p.length; i++) y = _mul(y, x) ^ p[i];
  return y;
}

const _gen_cache = new Map();
function _rs_gen(nsym) {
  if (!_gen_cache.has(nsym)) {
    let g = [1];
    for (let i = 0; i < nsym; i++) g = _poly_mul_hi(g, [1, _pow(2, i)]);
    _gen_cache.set(nsym, g);
  }
  return _gen_cache.get(nsym);
}

export function rs_encode(msg, nsym) {
  const gen = _rs_gen(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef) for (let j = 0; j < gen.length; j++) out[i + j] ^= _mul(gen[j], coef);
  }
  out.set(msg);
  return out;
}

function _syndromes(msg, nsym) {
  const s = [];
  const m = Array.from(msg);
  for (let i = 0; i < nsym; i++) s.push(_poly_eval_hi(m, _pow(2, i)));
  return s;
}

function _berlekamp_massey(synd) {
  let lam = [1], B = [1], L = 0, m = 1, b = 1;
  for (let n = 0; n < synd.length; n++) {
    let d = synd[n];
    for (let j = 1; j <= L; j++) d ^= _mul(lam[j], synd[n - j]);
    if (d === 0) m++;
    else if (2 * L <= n) {
      const T = lam.slice();
      const coef = _div(d, b);
      const need = B.length + m;
      while (lam.length < need) lam.push(0);
      for (let i = 0; i < B.length; i++) lam[i + m] ^= _mul(coef, B[i]);
      L = n + 1 - L; B = T; b = d; m = 1;
    } else {
      const coef = _div(d, b);
      const need = B.length + m;
      while (lam.length < need) lam.push(0);
      for (let i = 0; i < B.length; i++) lam[i + m] ^= _mul(coef, B[i]);
      m++;
    }
  }
  lam = lam.slice(0, L + 1);
  while (lam.length < L + 1) lam.push(0);
  return [lam, L];
}

function _solve_magnitudes(Xs, synd, L) {
  const n = L;
  const A = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let k = 0; k < n; k++) row.push(_pow(Xs[k], i));
    row.push(synd[i]);
    A.push(row);
  }
  for (let col = 0; col < n; col++) {
    let piv = -1;
    for (let r = col; r < n; r++) if (A[r][col] !== 0) { piv = r; break; }
    if (piv < 0) throw new Error("RS: singular magnitude system");
    [A[col], A[piv]] = [A[piv], A[col]];
    const inv = _div(1, A[col][col]);
    A[col] = A[col].map((v) => _mul(v, inv));
    for (let r = 0; r < n; r++) {
      if (r !== col && A[r][col] !== 0) {
        const f = A[r][col];
        A[r] = A[r].map((a, i) => a ^ _mul(f, A[col][i]));
      }
    }
  }
  return A.map((row) => row[n]);
}

export function rs_decode(codeword, nsym) {
  const msg = Array.from(codeword);
  const n = msg.length;
  const synd = _syndromes(msg, nsym);
  if (Math.max(...synd) === 0) return Uint8Array.from(msg.slice(0, n - nsym));
  const [lam, L] = _berlekamp_massey(synd);
  if (L < 1 || L > (nsym >> 1)) throw new Error("RS: error count out of range");
  const err_exp = [];
  for (let e = 0; e < n; e++) {
    const z = _pow(2, -e);
    let y = 0;
    for (let i = lam.length - 1; i >= 0; i--) y = _mul(y, z) ^ lam[i];
    if (y === 0) err_exp.push(e);
  }
  if (err_exp.length !== L) throw new Error("RS: locator root count mismatch");
  const Xs = err_exp.map((e) => _pow(2, e));
  const Ys = _solve_magnitudes(Xs, synd, L);
  for (let i = 0; i < L; i++) msg[n - 1 - err_exp[i]] ^= Ys[i];
  if (Math.max(..._syndromes(msg, nsym)) !== 0) throw new Error("RS: correction failed verification");
  return Uint8Array.from(msg.slice(0, n - nsym));
}

// ------------------------------------------------------------ convolutional codec
export const CODE_GENS = [0o171, 0o165, 0o133];   // rate 1/3, K=7
export const K_TAIL = 6;
const _PARITY = Array.from({ length: 128 }, (_, x) => {
  let c = 0;
  for (let v = x; v; v >>= 1) c ^= v & 1;
  return c;
});

const _TABLES = new Map();
function _tables(gens) {
  const key = gens.join(",");
  if (!_TABLES.has(key)) {
    const nout = gens.length;
    const out = new Int8Array(nout * 64 * 2);
    for (let r = 0; r < 64; r++) {
      for (let u = 0; u < 2; u++) {
        const v = (u << 6) | r;
        for (let o = 0; o < nout; o++) out[(o * 64 + r) * 2 + u] = _PARITY[v & gens[o]];
      }
    }
    _TABLES.set(key, out);
  }
  return _TABLES.get(key);
}

export function conv_encode(bits, gens = CODE_GENS) {
  const outT = _tables(gens);
  const nout = gens.length;
  const nb = bits.length;
  const res = new Uint8Array(nout * (nb + K_TAIL));
  let reg = 0, i = 0;
  for (let t = 0; t < nb + K_TAIL; t++) {
    const u = t < nb ? (bits[t] ? 1 : 0) : 0;
    for (let o = 0; o < nout; o++) res[i++] = outT[(o * 64 + reg) * 2 + u];
    reg = ((u << 5) | (reg >> 1)) & 0x3F;
  }
  return res;
}

export function viterbi_decode(llrs, n_info_bits, gens = CODE_GENS) {
  const outT = _tables(gens);
  const nout = gens.length;
  const nsteps = n_info_bits + K_TAIL;
  if (llrs.length !== nsteps * nout) throw new Error("viterbi: llr length mismatch");
  const signs = [];
  for (let o = 0; o < nout; o++) {
    const s = new Float64Array(128);
    for (let k = 0; k < 128; k++) s[k] = 2.0 * outT[o * 128 + k] - 1.0;
    signs.push(s);
  }
  let metric = new Float64Array(64).fill(-1e18);
  let nm = new Float64Array(64);
  metric[0] = 0.0;
  const decisions = new Uint8Array(nsteps * 64);
  const bm = new Float64Array(128);
  for (let t = 0; t < nsteps; t++) {
    for (let k = 0; k < 128; k++) {
      let v = signs[0][k] * llrs[t * nout];
      for (let o = 1; o < nout; o++) v = v + signs[o][k] * llrs[t * nout + o];
      bm[k] = v;
    }
    for (let s = 0; s < 64; s++) {
      const u = s >> 5, r0 = (s & 0x1F) << 1, r1 = r0 | 1;
      const c0 = metric[r0] + bm[r0 * 2 + u];
      const c1 = metric[r1] + bm[r1 * 2 + u];
      if (c1 > c0) { nm[s] = c1; decisions[t * 64 + s] = r1; } else { nm[s] = c0; decisions[t * 64 + s] = r0; }
    }
    const tmp = metric; metric = nm; nm = tmp;
  }
  const bits = new Uint8Array(nsteps);
  let state = 0;
  for (let t = nsteps - 1; t >= 0; t--) {
    bits[t] = state >> 5;
    state = decisions[t * 64 + state];
  }
  return bits.slice(0, n_info_bits);
}

function _permute(bits, P) {
  const L = bits.length;
  const out = new bits.constructor(L);
  for (let i = 0; i < L; i++) out[(i * P) % L] = bits[i];
  return out;
}

function _unpermute(bits, P) {
  const L = bits.length;
  const out = new bits.constructor(L);
  for (let i = 0; i < L; i++) out[i] = bits[(i * P) % L];
  return out;
}

function _data_perm_P(L) {
  let P = 257;
  while (gcd(P, L) !== 1) P += 2;
  return P;
}

function packbits(bits) {
  const out = new Uint8Array((bits.length + 7) >> 3);
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

function unpackbits(bytes) {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = (bytes[i] >> (7 - k)) & 1;
  return out;
}

// ------------------------------------------------------------ small numeric helpers
function median(a) {
  const s = Float64Array.from(a).sort();
  const n = s.length;
  if (n === 0) return NaN;
  return n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function percentile(a, q) {            // numpy linear interpolation
  const s = Float64Array.from(a).sort();
  const n = s.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * (q / 100);
  const lo = Math.floor(pos), hi = Math.min(lo + 1, n - 1);
  const t = pos - lo;
  const d = s[hi] - s[lo];
  return t >= 0.5 ? s[hi] - d * (1 - t) : s[lo] + d * t;
}

// ------------------------------------------------------------ complex detector (least squares)
// Detector rows = first N rows of pinv([B | conj(B)]) for the windowed
// basis B (sym x N). Computed with the normal equations
// (G = B2^H B2, Gauss-Jordan with partial pivoting); the detector
// matrices' condition numbers are <= ~91, so the squared conditioning
// (~8e3) leaves ~1e-12 relative error — measured in PORT-REPORT.md.

function _hann_tukey(sym) {
  const win = new Float64Array(sym).fill(1);
  const r = Math.trunc(0.25 * sym / 2);
  if (r > 0) {
    for (let i = 0; i < r; i++) win[i] = 0.5 - 0.5 * Math.cos(Math.PI * i / r);
    for (let i = 0; i < r; i++) win[sym - r + i] = win[r - 1 - i];
  }
  return win;
}

const _DET_CACHE = new Map();
function _detector(sym, freqs, win, Ere, Eim) {
  const N = freqs.length;
  const key = `${sym}|${Array.from(freqs).join(",")}`;
  const hit = _DET_CACHE.get(key);
  if (hit) return hit;
  const M = 2 * N;
  // B2 (sym x M), t-major
  const Br = new Float64Array(sym * M), Bi = new Float64Array(sym * M);
  for (let t = 0; t < sym; t++) {
    for (let k = 0; k < N; k++) {
      const re = win[t] * Ere[t * N + k], im = win[t] * Eim[t * N + k];
      Br[t * M + k] = re; Bi[t * M + k] = im;
      Br[t * M + N + k] = re; Bi[t * M + N + k] = -im;
    }
  }
  // G = B2^H B2  (Hermitian), augmented with identity for Gauss-Jordan
  const W = 2 * M;
  const Ar = new Float64Array(M * W), Ai = new Float64Array(M * W);
  for (let a = 0; a < M; a++) {
    for (let b = a; b < M; b++) {
      let sr = 0, si = 0;
      for (let t = 0; t < sym; t++) {
        const ar = Br[t * M + a], ai = -Bi[t * M + a], br = Br[t * M + b], bi = Bi[t * M + b];
        sr += ar * br - ai * bi;
        si += ar * bi + ai * br;
      }
      Ar[a * W + b] = sr; Ai[a * W + b] = si;
      if (a !== b) { Ar[b * W + a] = sr; Ai[b * W + a] = -si; }
    }
    Ar[a * W + M + a] = 1;
  }
  for (let col = 0; col < M; col++) {
    let piv = col, best = -1;
    for (let r = col; r < M; r++) {
      const mag = Ar[r * W + col] ** 2 + Ai[r * W + col] ** 2;
      if (mag > best) { best = mag; piv = r; }
    }
    if (!(best > 0)) throw new Error("detector: singular basis");
    if (piv !== col) {
      for (let c = 0; c < W; c++) {
        let tmp = Ar[col * W + c]; Ar[col * W + c] = Ar[piv * W + c]; Ar[piv * W + c] = tmp;
        tmp = Ai[col * W + c]; Ai[col * W + c] = Ai[piv * W + c]; Ai[piv * W + c] = tmp;
      }
    }
    const pr = Ar[col * W + col] / best, pi = -Ai[col * W + col] / best;   // 1/pivot
    for (let c = 0; c < W; c++) {
      const xr = Ar[col * W + c], xi = Ai[col * W + c];
      Ar[col * W + c] = xr * pr - xi * pi;
      Ai[col * W + c] = xr * pi + xi * pr;
    }
    for (let r = 0; r < M; r++) {
      if (r === col) continue;
      const fr = Ar[r * W + col], fi = Ai[r * W + col];
      if (fr === 0 && fi === 0) continue;
      for (let c = 0; c < W; c++) {
        const cr = Ar[col * W + c], ci = Ai[col * W + c];
        Ar[r * W + c] -= fr * cr - fi * ci;
        Ai[r * W + c] -= fr * ci + fi * cr;
      }
    }
  }
  // PINV[k][t] = sum_m Ginv[k][m] * conj(B2[t][m]),  k < N
  const Pr = new Float64Array(N * sym), Pi = new Float64Array(N * sym);
  for (let k = 0; k < N; k++) {
    for (let t = 0; t < sym; t++) {
      let sr = 0, si = 0;
      for (let m = 0; m < M; m++) {
        const gr = Ar[k * W + M + m], gi = Ai[k * W + M + m];
        const br = Br[t * M + m], bi = -Bi[t * M + m];
        sr += gr * br - gi * bi;
        si += gr * bi + gi * br;
      }
      Pr[k * sym + t] = sr; Pi[k * sym + t] = si;
    }
  }
  const det = { N, sym, re: Pr, im: Pi };
  if (_DET_CACHE.size >= 24) _DET_CACHE.delete(_DET_CACHE.keys().next().value);
  _DET_CACHE.set(key, det);
  return det;
}

// ------------------------------------------------------------ tone layouts
const PENTA_SEMI = [0, 3, 5, 7, 10];
export const PENTA = Float64Array.from({ length: 20 }, (_, k) =>
  220.0 * 2 ** ((PENTA_SEMI[k % 5] + 12 * Math.floor(k / 5)) / 12));
export const PENTA_GAINS = Float64Array.from(PENTA, (f) => (f < 1600 ? 1.0 : 0.55));

function _grid_freqs(lo, hi, step) {
  const n = Math.round((hi - lo) / step) + 1;
  return Float64Array.from({ length: n }, (_, i) => lo + step * i);
}

export class Cfg {
  constructor(name, freqs, gains, sym, bits = null) {
    this.name = name;
    this.freqs = Float64Array.from(freqs);
    this.gains = Float64Array.from(gains);
    this.sym = Math.trunc(sym);
    this.bits = bits !== null ? Array.from(bits) : new Array(this.freqs.length).fill(3);
    this._basis = null;
  }
  get ntones() { return this.freqs.length; }
  get bits_per_sym() { return this.bits.reduce((a, b) => a + b, 0); }

  // (win, E, detector): Tukey window, synthesis basis E (sym x N,
  // t-major, Ere/Eim) and the detector (pseudoinverse rows).
  basis() {
    if (this._basis === null) {
      const N = this.ntones, sym = this.sym;
      const win = _hann_tukey(sym);
      const Ere = new Float64Array(sym * N), Eim = new Float64Array(sym * N);
      for (let t = 0; t < sym; t++) {
        for (let k = 0; k < N; k++) {
          const ang = 2 * Math.PI * (t * this.freqs[k]) / SR;
          Ere[t * N + k] = Math.cos(ang); Eim[t * N + k] = Math.sin(ang);
        }
      }
      this._basis = { win, Ere, Eim, det: null };
    }
    return this._basis;
  }
  detector() {
    const b = this.basis();
    if (b.det === null) b.det = _detector(this.sym, this.freqs, b.win, b.Ere, b.Eim);
    return b.det;
  }
  sub(idx) {
    idx = Array.from(idx);
    return new Cfg(`${this.name}[${idx.length}t]`, idx.map((i) => this.freqs[i]),
                   idx.map((i) => this.gains[i]), this.sym, idx.map((i) => this.bits[i]));
  }
}

export const A_LAYOUT = new Cfg("grid200@5ms", _grid_freqs(400, 8000, 200), new Array(39).fill(1), 240);

// ------------------------------------------------------------ layout machinery
function _gray_tables(w) {
  const n = 1 << w;
  const g = Array.from({ length: n }, (_, v) => v ^ (v >> 1));
  const inv = new Array(n).fill(0);
  g.forEach((s, v) => { inv[s] = v; });
  return [g, inv];
}

export const PREAMBLE = 6;

function _preamble_phases(cfg) {
  const N = cfg.ntones;
  const rows = new Float64Array(PREAMBLE * N);
  for (let k = 0; k < N; k++) {
    const phi = ((5 * k) % 8) * (Math.PI / 4);
    const pat = (k % 8) * (Math.PI / 4);
    for (let r = 0; r < PREAMBLE; r++) rows[r * N + k] = phi + (r >= 3 ? pat : 0);
  }
  return rows;
}

function _pre_rows(cfg, style, n) {
  if (style === "pattern") return { rows: _preamble_phases(cfg), n: PREAMBLE };
  const N = cfg.ntones;
  const rows = new Float64Array(n * N);
  for (let r = 0; r < n; r++) for (let k = 0; k < N; k++) rows[r * N + k] = ((5 * k) % 8) * (Math.PI / 4);
  return { rows, n };
}

// bits -> stream of bytes from decoded values (nrows x ntones)
function _values_to_stream(vals, cfg) {
  const { n, data } = vals;
  const bps = cfg.bits_per_sym;
  const bits = new Uint8Array(n * bps);
  let off = 0;
  for (let j = 0; j < cfg.ntones; j++) {
    const w = cfg.bits[j];
    for (let r = 0; r < n; r++) {
      const v = data[r * cfg.ntones + j];
      for (let i = 0; i < w; i++) bits[r * bps + off + i] = (v >> (w - 1 - i)) & 1;
    }
    off += w;
  }
  return packbits(bits);
}

const PREAMBLE_SYMS = PREAMBLE;

function _onset_candidates(x, sym) {
  const L = x.length;
  const cs = new Float64Array(L + 1);
  for (let i = 0; i < L; i++) cs[i + 1] = cs[i] + x[i] * x[i];
  const step = Math.max(1, Math.floor(sym / 4));
  const last = L - PREAMBLE * sym;
  const span = PREAMBLE * sym;
  const n = last >= 0 ? Math.floor(last / step) + 1 : 0;
  if (n === 0) throw new Error("attempt to get argmax of an empty sequence");
  const contrast = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * step;
    const after = cs[Math.min(o + span, L)] - cs[o];
    const before = cs[o] - cs[Math.max(o - span, 0)];
    contrast[i] = (after - before) / (after + before + 1e-12);
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => contrast[a] - contrast[b] || a - b).reverse();
  const cands = [];
  for (const idx of order) {
    if (contrast[idx] <= 0) break;
    const off = idx * step;
    if (cands.every((c) => Math.abs(off - c) >= sym)) cands.push(off);
    if (cands.length >= 12) break;
  }
  if (cands.length === 0) {
    let bi = 0;
    for (let i = 1; i < n; i++) if (contrast[i] > contrast[bi]) bi = i;
    cands.push(bi * step);
  }
  return cands;
}

// ------------------------------------------------------------ tone sets
export const GRID100 = Float64Array.from({ length: 77 }, (_, i) => 400.0 + 100.0 * i);
export const GRID200 = Float64Array.from({ length: 39 }, (_, i) => 400.0 + 200.0 * i);
const A_TONE_IDX = Array.from(GRID200, (f) => roundHalfEven((f - 400) / 100));

// ------------------------------------------------------------ modes (data)
export const MODES = {
  A: { name: "A", grid: A_LAYOUT.freqs, gains: Array.from(A_LAYOUT.gains), active: A_LAYOUT.sym,
       guard: 0, bits: 3, code: "rs", rs_data: 239, rs_nsym: 16, seg_cap: 3400 },
  B: { name: "B", grid: GRID100, gains: new Array(77).fill(1.0), active: 480, guard: 480,
       bits: 2, code: "rs", rs_data: 191, rs_nsym: 64, seg_cap: 1050 },
  C: { name: "C", grid: GRID200, gains: new Array(39).fill(1.0), active: 960, guard: 480,
       bits: 2, code: "conv", rs_data: 0, rs_nsym: 0, seg_cap: 105 },
};

export function _sel_cfg(mc, mask, half = null) {
  const idx = half === null ? Array.from({ length: mc.grid.length }, (_, i) => i) : Array.from(half);
  const sel = idx.filter((i) => mask[i]);
  const cfg = new Cfg(`ndap8-${mc.name}`, sel.map((i) => mc.grid[i]), sel.map((i) => mc.gains[i]),
                      mc.active, new Array(sel.length).fill(mc.bits));
  return [cfg, sel];
}

function _full_cfg(mc) {
  return new Cfg(`ndap8-${mc.name}-full`, mc.grid, mc.gains, mc.active, new Array(mc.grid.length).fill(mc.bits));
}

// ------------------------------------------------------------ sounding
const SND1_SYM = 480, SND1_N = 8;
const SND2_ACT = 960, SND2_GRD = 480, SND2_N = 4;
const SND1_LEN = SND1_SYM * SND1_N;
const SND2_LEN = (SND2_ACT + SND2_GRD) * SND2_N;
export const SND_LEN = SND1_LEN + SND2_LEN;
const _snd1_cfg = new Cfg("snd100", GRID100, new Array(77).fill(1), SND1_SYM, new Array(77).fill(0));
const _snd2_cfg = new Cfg("snd200", GRID200, new Array(39).fill(1), SND2_ACT, new Array(39).fill(0));

function _snd_phases(ntones, nrows) {
  const phi = new Float64Array(nrows * ntones), pat = new Float64Array(ntones);
  for (let k = 0; k < ntones; k++) {
    const base = ((5 * k) % 8) * (Math.PI / 4);
    pat[k] = (k % 8) * (Math.PI / 4);
    for (let r = 0; r < nrows; r++) phi[r * ntones + k] = base + r * pat[k];
  }
  return { phi, pat };
}
const _snd1_phases = () => _snd_phases(77, SND1_N);
const _snd2_phases = () => _snd_phases(39, SND2_N);

// real(coeffs @ E.T) * win, for unit-magnitude coefficients exp(1j*phi)
// on the tone subset idx (others zero).
function _snd_rows(cfg, phi, nrows, idx) {
  const { win, Ere, Eim } = cfg.basis();
  const N = cfg.ntones, sym = cfg.sym;
  const out = new Float64Array(nrows * sym);
  for (let r = 0; r < nrows; r++) {
    const cr = new Float64Array(N), ci = new Float64Array(N);
    for (const k of idx) { cr[k] = Math.cos(phi[r * N + k]); ci[k] = Math.sin(phi[r * N + k]); }
    for (let t = 0; t < sym; t++) {
      let s = 0;
      for (let k = 0; k < N; k++) s += cr[k] * Ere[t * N + k] - ci[k] * Eim[t * N + k];
      out[r * sym + t] = s * win[t];
    }
  }
  return out;
}

function _normalize(audio) {
  let peak = 0;
  for (let i = 0; i < audio.length; i++) { const a = Math.abs(audio[i]); if (a > peak) peak = a; }
  if (peak > 0) { const g = 0.85 / peak; for (let i = 0; i < audio.length; i++) audio[i] *= g; }
  return audio;
}

export function _sounding_audio(idx1 = null, idx2 = null) {
  if (idx1 === null) idx1 = Array.from({ length: 77 }, (_, i) => i);
  if (idx2 === null) idx2 = Array.from({ length: 39 }, (_, i) => i);
  const a1 = _snd_rows(_snd1_cfg, _snd1_phases().phi, SND1_N, idx1);
  const sig2 = _snd_rows(_snd2_cfg, _snd2_phases().phi, SND2_N, idx2);
  const audio = new Float64Array(SND_LEN);
  audio.set(a1);
  const slot = SND2_ACT + SND2_GRD;
  for (let i = 0; i < SND2_N; i++) audio.set(sig2.subarray(i * SND2_ACT, (i + 1) * SND2_ACT), SND1_LEN + i * slot);
  return _normalize(audio);
}

export function sounding_burst() { return _sounding_audio(); }

// ------------------------------------------- shared signal primitives
// Projection onto the augmented detector. Returns {n, ntones, re, im}.
export function _slots_coeffs(samples, cfg, guard, start, nsym = null) {
  const det = cfg.detector();
  const N = cfg.ntones, sym = cfg.sym, slot = sym + guard;
  if (start < 0) start = Math.max(0, samples.length + start);
  const xlen = Math.max(0, samples.length - start);
  let n = Math.ceil(xlen / slot);               // a truncated last slot is zero-completed
  if (nsym !== null) n = Math.min(n, nsym);
  if (n <= 0) return { n: 0, ntones: N, re: new Float64Array(0), im: new Float64Array(0) };
  const re = new Float64Array(n * N), im = new Float64Array(n * N);
  const tmp = new Float64Array(sym);
  const { re: Pr, im: Pi } = det;
  for (let i = 0; i < n; i++) {
    const base = start + i * slot;
    let xs, xo;
    if (base + sym <= samples.length) { xs = samples; xo = base; }
    else {
      tmp.fill(0);
      for (let t = 0; t < sym && base + t < samples.length; t++) tmp[t] = samples[base + t];
      xs = tmp; xo = 0;
    }
    for (let k = 0; k < N; k++) {
      let sr = 0, si = 0;
      const o = k * sym;
      for (let t = 0; t < sym; t++) {
        const v = xs[xo + t];
        sr += v * Pr[o + t];
        si += v * Pi[o + t];
      }
      re[i * N + k] = sr; im[i * N + k] = si;
    }
  }
  return { n, ntones: N, re, im };
}

// wrapped phase differences between consecutive rows -> Float64Array((n-1)*N)
function _dphi(co) {
  const { n, ntones: N, re, im } = co;
  const nd = Math.max(0, n - 1);
  const out = new Float64Array(nd * N);
  for (let r = 0; r < nd; r++) {
    for (let k = 0; k < N; k++) {
      const p1 = Math.atan2(im[(r + 1) * N + k], re[(r + 1) * N + k]);
      const p0 = Math.atan2(im[r * N + k], re[r * N + k]);
      const d = p1 - p0;
      out[r * N + k] = Math.atan2(Math.sin(d), Math.cos(d));
    }
  }
  return out;
}

export function _values_from_coeffs(coeffs, cfg, pre_rows) {
  const N = cfg.ntones;
  const dphi = _dphi(coeffs);
  const nd = dphi.length / N || 0;
  const vals = new Int32Array(nd * N);
  for (let j = 0; j < N; j++) {
    const w = cfg.bits[j];
    if (w === 0) continue;
    const [, inv] = _gray_tables(w);
    const M = 1 << w;
    for (let r = 0; r < nd; r++) {
      const step = pmod(roundHalfEven(dphi[r * N + j] / (2 * Math.PI / M)), M);
      vals[r * N + j] = inv[step];
    }
  }
  const skip = Math.min(nd, Math.max(0, pre_rows - 1));
  return { n: nd - skip, data: vals.subarray(skip * N) };
}

// per-diff, per-tone bit LLRs for 2-bit tones: Float64Array(nd*N*2)
export function _qpsk_llrs(coeffs) {
  const { n, ntones: N, re, im } = coeffs;
  const dphi = _dphi(coeffs);
  const nd = Math.max(0, n - 1);
  const out = new Float64Array(nd * N * 2);
  const centers = [0.0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
  const val_of_step = [0, 1, 3, 2];
  const mags = new Float64Array(N), p = new Float64Array(4), ll = new Float64Array(4);
  for (let r = 0; r < nd; r++) {
    for (let k = 0; k < N; k++) mags[k] = Math.hypot(re[(r + 1) * N + k], im[(r + 1) * N + k]);
    const med = median(mags) + 1e-12;
    for (let k = 0; k < N; k++) {
      const kappa = Math.min(12.0, Math.max(0.25, 2.0 * mags[k] / med));
      let mx = -Infinity;
      for (let c = 0; c < 4; c++) { ll[c] = kappa * Math.cos(dphi[r * N + k] - centers[c]); if (ll[c] > mx) mx = ll[c]; }
      for (let c = 0; c < 4; c++) p[c] = Math.exp(ll[c] - mx);
      for (let b = 0; b < 2; b++) {
        const shift = 1 - b;
        let s1 = 0, s0 = 0;
        for (let c = 0; c < 4; c++) { if (((val_of_step[c] >> shift) & 1) === 1) s1 += p[c]; else s0 += p[c]; }
        out[(r * N + k) * 2 + b] = Math.log((s1 + 1e-12) / (s0 + 1e-12));
      }
    }
  }
  return { nd, ntones: N, data: out };
}

function _llrs_to_chan(llrs, cfg, pre_rows, coded_len) {
  const { nd, ntones: N, data } = llrs;
  const skip = Math.min(nd, Math.max(0, pre_rows - 1));
  const rows = nd - skip;
  const bps = cfg.bits_per_sym;
  const flat = new Float64Array(rows * bps);
  let off = 0;
  for (let j = 0; j < N; j++) {
    const w = cfg.bits[j];
    for (let r = 0; r < rows; r++) for (let b = 0; b < w; b++) flat[r * bps + off + b] = data[((skip + r) * N + j) * 2 + b];
    off += w;
  }
  return flat.slice(0, coded_len);
}

function _synth_steps(steps, nsym, cfg, guard, pre_style, pre_n, win, Ere, Eim) {
  const N = cfg.ntones;
  const { rows: pre, n: npre } = _pre_rows(cfg, pre_style, pre_n);
  const total = npre + nsym;
  const phases = new Float64Array(total * N);
  phases.set(pre);
  const last = pre.subarray((npre - 1) * N, npre * N);
  const cum = new Float64Array(N);
  for (let s = 0; s < nsym; s++) {
    for (let k = 0; k < N; k++) {
      cum[k] += steps[s * N + k] * (2 * Math.PI / (1 << cfg.bits[k]));
      phases[(npre + s) * N + k] = last[k] + cum[k];
    }
  }
  const slot = cfg.sym + guard;
  const audio = new Float64Array(total * slot);
  const cr = new Float64Array(N), ci = new Float64Array(N);
  for (let i = 0; i < total; i++) {
    for (let k = 0; k < N; k++) { cr[k] = cfg.gains[k] * Math.cos(phases[i * N + k]); ci[k] = cfg.gains[k] * Math.sin(phases[i * N + k]); }
    for (let t = 0; t < cfg.sym; t++) {
      let s = 0;
      for (let k = 0; k < N; k++) s += cr[k] * Ere[t * N + k] - ci[k] * Eim[t * N + k];
      audio[i * slot + t] = s * win[t];
    }
  }
  return _normalize(audio);
}

// bit array -> {n, data} Gray step indices, tone-major per symbol, MSB first
function _steps_from_bits(bits, cfg) {
  const bps = cfg.bits_per_sym, N = cfg.ntones;
  const nsym = Math.ceil(bits.length / bps);
  const padded = new Uint8Array(nsym * bps);
  padded.set(bits);
  const data = new Int32Array(nsym * N);
  let off = 0;
  for (let j = 0; j < N; j++) {
    const w = cfg.bits[j];
    const [g] = _gray_tables(w);
    for (let r = 0; r < nsym; r++) {
      let v = 0;
      for (let i = 0; i < w; i++) v = (v << 1) | padded[r * bps + off + i];
      data[r * N + j] = g[v];
    }
    off += w;
  }
  return { n: nsym, data };
}

function _modulate_g(stream, cfg, guard, pre_style = "pattern", pre_n = PREAMBLE) {
  const { win, Ere, Eim } = cfg.basis();
  const st = _steps_from_bits(unpackbits(stream), cfg);
  return _synth_steps(st.data, st.n, cfg, guard, pre_style, pre_n, win, Ere, Eim);
}

function _modulate_bits_g(bits, cfg, guard, pre_n = PREAMBLE) {
  const { win, Ere, Eim } = cfg.basis();
  const st = _steps_from_bits(bits, cfg);
  return _synth_steps(st.data, st.n, cfg, guard, "pattern", pre_n, win, Ere, Eim);
}

// ------------------------------------------------- framing (one RS layer)
const HDR_DATA = 9, HDR_NSYM = 16;
const HDR_LEN = HDR_DATA + HDR_NSYM;
const CHUNK = 400;
const STRIDE = CHUNK + HDR_LEN;
const FLAG_COMPRESSED = 0x01;

export function _frame_rs(stored, flags, blk_data, blk_nsym) {
  const crc = crc32(stored);
  const body = concatBytes(stored, be32(crc));
  const blocks = [];
  for (let i = 0; i < body.length; i += blk_data) {
    const chunk = new Uint8Array(blk_data);
    chunk.set(body.subarray(i, i + blk_data));
    blocks.push(rs_encode(chunk, blk_nsym));
  }
  const nb = blocks.length;
  const stream = new Uint8Array(255 * nb);
  let p = 0;
  for (let i = 0; i < 255; i++) for (let b = 0; b < nb; b++) stream[p++] = blocks[b][i];
  const hdr = concatBytes(Uint8Array.of(0x4e, 0x38), be32(stored.length), be16(nb), Uint8Array.of(flags));
  const hdr_enc = rs_encode(hdr, HDR_NSYM);
  const parts = [];
  for (let i = 0; i < stream.length; i += CHUNK) { parts.push(hdr_enc); parts.push(stream.subarray(i, i + CHUNK)); }
  return concatBytes(...parts);
}

function _read_header_rs(stream, off) {
  let cand;
  try { cand = rs_decode(stream.subarray(off, off + HDR_LEN), HDR_NSYM); } catch (e) { return null; }
  if (cand.length === HDR_DATA && cand[0] === 0x4e && cand[1] === 0x38) {
    const slen = rd32(cand, 2), nb = rd16(cand, 6), flags = cand[8];
    if (slen < 10_000_000 && nb > 0 && nb < 10000 && (flags & ~FLAG_COMPRESSED) === 0) return [slen, nb, flags];
  }
  return null;
}

export function _unframe_rs(stream, blk_data, blk_nsym) {
  let hdr = null;
  for (let off = 0; off < Math.max(1, stream.length - HDR_LEN); off += STRIDE) {
    hdr = _read_header_rs(stream, off);
    if (hdr !== null) break;
  }
  if (hdr === null) throw new Error("payload header unrecoverable");
  const [slen, nb, flags] = hdr;
  const parts = [];
  let have = 0, pos = 0;
  while (pos + HDR_LEN <= stream.length && have < nb * 255) {
    pos += HDR_LEN;
    const piece = stream.subarray(pos, pos + CHUNK);
    parts.push(piece); have += piece.length;
    pos += CHUNK;
  }
  const data = concatBytes(...parts).subarray(0, nb * 255);
  if (data.length < nb * 255) throw new Error("payload stream truncated");
  const blocks = Array.from({ length: nb }, () => new Uint8Array(255));
  let idx = 0;
  for (let i = 0; i < 255; i++) for (let b = 0; b < nb; b++) blocks[b][i] = data[idx++];
  const bodyParts = blocks.map((blk) => rs_decode(blk, blk_nsym));
  const body = concatBytes(...bodyParts);
  const stored = body.slice(0, slen);
  if (body.length < slen + 4) throw new Error("unpack requires a buffer of 4 bytes");
  const crc_stored = rd32(body, slen);
  if (crc32(stored) !== crc_stored) throw new Error("CRC-32 mismatch after RS decode");
  return [stored, flags];
}

export function _stored_of(chunk) {
  const comp = zlib_compress(chunk);
  if (comp.length < chunk.length) return [comp, FLAG_COMPRESSED];
  return [chunk, 0];
}

function _unstored_of(stored, flags) {
  return flags & FLAG_COMPRESSED ? zlib_decompress(stored) : stored;
}

// ------------------------------------------------- section codec (pipeline)
export function _conv_info(chunk) {
  const [stored, flags] = _stored_of(chunk);
  const info = concatBytes(Uint8Array.of(flags), stored);
  return concatBytes(info, be32(crc32(info)));
}

export function _seg_stored_len(mc, chunk) {
  if (mc.code === "conv") return _conv_info(chunk).length;
  return chunk.length;
}

export function _encode_section(mc, chunk, mask, sub_cfg = null) {
  const cfg = sub_cfg !== null ? sub_cfg : _sel_cfg(mc, mask)[0];
  if (mc.code === "rs") {
    const [stored, flags] = _stored_of(chunk);
    const stream = _frame_rs(stored, flags, mc.rs_data, mc.rs_nsym);
    return _modulate_g(stream, cfg, mc.guard);
  }
  const info = _conv_info(chunk);
  let coded = conv_encode(unpackbits(info), CODE_GENS);
  coded = _permute(coded, _data_perm_P(coded.length));
  return _modulate_bits_g(coded, cfg, mc.guard);
}

function _cols(co, col_idx) {
  const { n, ntones: N, re, im } = co;
  const M = col_idx.length;
  const r2 = new Float64Array(n * M), i2 = new Float64Array(n * M);
  for (let r = 0; r < n; r++) for (let j = 0; j < M; j++) { r2[r * M + j] = re[r * N + col_idx[j]]; i2[r * M + j] = im[r * N + col_idx[j]]; }
  return { n, ntones: M, re: r2, im: i2 };
}

export function _decode_section(mc, samples, start, seglen, mask, chan = null) {
  let proj, col_idx, cfg;
  if (chan !== null) [proj, col_idx, cfg] = chan;
  else { cfg = _sel_cfg(mc, mask)[0]; proj = cfg; col_idx = null; }
  if (mc.code === "rs") {
    let coeffs = _slots_coeffs(samples, proj, mc.guard, start);
    if (col_idx !== null) coeffs = _cols(coeffs, col_idx);
    const vals = _values_from_coeffs(coeffs, cfg, PREAMBLE);
    const stream = _values_to_stream(vals, cfg);
    const [stored, flags] = _unframe_rs(stream, mc.rs_data, mc.rs_nsym);
    return _unstored_of(stored, flags);
  }
  const info_len = seglen;
  const coded_len = CODE_GENS.length * (info_len * 8 + 6);
  const nsym = PREAMBLE + Math.ceil(coded_len / cfg.bits_per_sym) + 2;
  let coeffs = _slots_coeffs(samples, proj, mc.guard, start, nsym);
  if (col_idx !== null) coeffs = _cols(coeffs, col_idx);
  const llrs = _qpsk_llrs(coeffs);
  const chan_llr = _llrs_to_chan(llrs, cfg, PREAMBLE, coded_len);
  if (chan_llr.length < coded_len) throw new Error("segment truncated");
  const coded = _unpermute(chan_llr, _data_perm_P(coded_len));
  const info = packbits(viterbi_decode(coded, info_len * 8, CODE_GENS));
  if (info.length < 4) throw new Error("unpack requires a buffer of 4 bytes");
  const body = info.subarray(0, info.length - 4);
  if (rd32(info, info.length - 4) !== crc32(body)) throw new Error("CRC-32 mismatch after Viterbi decode");
  if (body.length < 1) throw new Error("index out of range");
  return _unstored_of(body.subarray(1), body[0]);
}

export function _section_samples(mc, chunk, seglen, mask, chan = null) {
  const bps = chan !== null ? chan[2].bits_per_sym : _sel_cfg(mc, mask)[0].bits_per_sym;
  let nbits;
  if (mc.code === "rs") {
    const [stored, flags] = _stored_of(chunk);
    nbits = _frame_rs(stored, flags, mc.rs_data, mc.rs_nsym).length * 8;
  } else nbits = CODE_GENS.length * (seglen * 8 + 6);
  const nsyms = PREAMBLE + Math.ceil(nbits / bps);
  return nsyms * (mc.active + mc.guard);
}

// ------------------------------------------------------------ mini-header
export const VERSION = 8;
export const MINI_INFO = 31;
const MINI_GENS = CODE_GENS;
const MINI_CODED_BITS = MINI_GENS.length * (MINI_INFO * 8 + 6);     // 762
const FLAG_FINAL = 0x01;
const FLAG_TOKEN = 0x02;
const MINI_SYM = 960, MINI_GUARD = 240, MINI_PRE = 3;
const _mini_cfg = new Cfg("mini", PENTA, PENTA_GAINS, MINI_SYM, new Array(20).fill(2));

function _mini_len(cfg = _mini_cfg) {
  const data_syms = Math.ceil(MINI_CODED_BITS / cfg.bits_per_sym);
  return (MINI_PRE + data_syms) * (MINI_SYM + MINI_GUARD);
}
export const MINI_LEN = _mini_len();

function _mask_bytes(mask) {
  const out = new Uint8Array(10);
  mask.forEach((m, i) => { if (m) out[i >> 3] |= 1 << (7 - (i % 8)); });
  return out;
}

function _mask_from_bytes(mode, raw) {
  const n = { A: 39, B: 77, C: 39 }[mode];
  if (mode === "A") return new Array(n).fill(1);
  return Array.from({ length: n }, (_, i) => ((raw[i >> 3] >> (7 - (i % 8))) & 1 ? 1 : 0));
}

export function _hmac_digest(session, payload_crc32, secret) {
  return hmac_sha256(secret, concatBytes(be16(session), be32(payload_crc32)));
}

export function house_token(session, payload_crc32, secret) {
  return _hmac_digest(session, payload_crc32, secret).slice(0, 6);
}

export function check_phrase(session, payload_crc32, secret, digits = 4) {
  const d = _hmac_digest(session, payload_crc32, secret);
  let n = 0n;
  for (let i = 6; i < 14; i++) n = (n << 8n) | BigInt(d[i]);
  return (n % 10n ** BigInt(digits)).toString().padStart(digits, "0");
}

export function _mini_info_bytes(mode, session, idx, total, seglen, mask,
                                 final = false, token = null, next_speaker = 0) {
  const flags = (final ? FLAG_FINAL : 0) | (token ? FLAG_TOKEN : 0) | ((next_speaker & 0x03) << 2);
  const raw = concatBytes(
    Uint8Array.of(0x4e, 0x38), Uint8Array.of(VERSION), Uint8Array.of({ A: 0, B: 1, C: 2 }[mode]),
    be16(session), Uint8Array.of(idx, total), Uint8Array.of(flags), be32(seglen),
    _mask_bytes(mask), token ? token : new Uint8Array(6));
  if (raw.length !== MINI_INFO - 2) throw new Error(`mini-header length ${raw.length}`);
  return concatBytes(raw, be16(_crc16(raw)));
}

export function _mini_parse(raw) {
  if (raw.length !== MINI_INFO || raw[0] !== 0x4e || raw[1] !== 0x38) return null;
  if (rd16(raw, 29) !== _crc16(raw.subarray(0, 29))) return null;
  if (raw[2] !== VERSION) return null;
  const mode = { 0: "A", 1: "B", 2: "C" }[raw[3]];
  if (mode === undefined) return null;
  const seglen = rd32(raw, 9);
  if (seglen >= 10_000_000) return null;
  const flags = raw[8];
  return { mode, version: raw[2], session: rd16(raw, 4), index: raw[6], total: raw[7], seglen,
           flags, final: !!(flags & FLAG_FINAL), next_speaker: (flags >> 2) & 0x03,
           token: flags & FLAG_TOKEN ? raw.slice(23, 29) : null,
           mask: _mask_from_bytes(mode, raw.subarray(13, 23)) };
}

export function _mini_encode(mode, session, idx, total, seglen, mask, cfg = _mini_cfg,
                             final = false, token = null, next_speaker = 0) {
  const info = _mini_info_bytes(mode, session, idx, total, seglen, mask, final, token, next_speaker);
  let coded = conv_encode(unpackbits(info), MINI_GENS);
  coded = _permute(coded, _data_perm_P(coded.length));
  const { win, Ere, Eim } = cfg.basis();
  const st = _steps_from_bits(coded, cfg);
  return _synth_steps(st.data, st.n, cfg, MINI_GUARD, "flat", MINI_PRE, win, Ere, Eim);
}

export function _mini_decode_scored(samples, start, cfg = _mini_cfg, full_cfg = null, col_idx = null) {
  const data_syms = Math.ceil(MINI_CODED_BITS / cfg.bits_per_sym);
  const proj_cfg = full_cfg !== null ? full_cfg : cfg;
  let coeffs = _slots_coeffs(samples, proj_cfg, MINI_GUARD, start, MINI_PRE + data_syms);
  if (coeffs.n < MINI_PRE + data_syms) return [null, 0.0];
  if (col_idx !== null) coeffs = _cols(coeffs, col_idx);
  const llrs = _qpsk_llrs(coeffs);
  const chan = _llrs_to_chan(llrs, cfg, MINI_PRE, MINI_CODED_BITS);
  let score = 0;
  if (chan.length) { let s = 0; for (const v of chan) s += Math.abs(v); score = s / chan.length; }
  const coded = _unpermute(chan, _data_perm_P(MINI_CODED_BITS));
  const info = viterbi_decode(coded, MINI_INFO * 8, MINI_GENS);
  return [_mini_parse(packbits(info)), score];
}

export function _mini_decode(samples, start, cfg = _mini_cfg, full_cfg = null, col_idx = null) {
  return _mini_decode_scored(samples, start, cfg, full_cfg, col_idx)[0];
}

// ------------------------------------------------------------ analysis
function _tone_feats(snr_db, rel_gain) {
  const s = [], g = [];
  for (let i = 0; i < snr_db.length; i++) if (!Number.isNaN(snr_db[i])) { s.push(snr_db[i]); g.push(rel_gain[i]); }
  if (s.length === 0) throw new Error("zero-size array to reduction operation minimum which has no identity");
  return {
    median_snr_db: median(s),
    p10_snr_db: percentile(s, 10),
    min_rel_gain: Math.min(...g),
    frac_below_6db: s.filter((v) => v < 6.0).length / s.length,
    frac_below_0db: s.filter((v) => v < 0.0).length / s.length,
  };
}

function _phase_feats(co, phases, nrows, ncolsPh, idx) {
  const n = co.n, N = co.ntones;
  const K = idx.length;
  const snr_db = new Float64Array(K), rel = new Float64Array(K), gains = new Float64Array(K);
  for (let a = 0; a < K; a++) {
    const k = idx[a];
    const zr = new Float64Array(n), zi = new Float64Array(n);
    let hr = 0, hi = 0;
    for (let r = 0; r < n; r++) {
      const ph = -phases[r * ncolsPh + k];
      const c = Math.cos(ph), s = Math.sin(ph);
      const cr = co.re[r * N + k], ci = co.im[r * N + k];
      zr[r] = cr * c - ci * s; zi[r] = cr * s + ci * c;
      hr += zr[r]; hi += zi[r];
    }
    hr /= n; hi /= n;
    let resid = 0;
    for (let r = 0; r < n; r++) resid += (zr[r] - hr) ** 2 + (zi[r] - hi) ** 2;
    resid /= n;
    const gain = Math.hypot(hr, hi);
    gains[a] = gain;
    const snr = gain ** 2 / Math.max(resid, 1e-15);
    snr_db[a] = 10 * Math.log10(Math.max(snr, 1e-12));
  }
  const med = median(gains);
  for (let a = 0; a < K; a++) rel[a] = gains[a] / (med + 1e-15);
  return [snr_db, rel];
}

export function _analyze_at(samples, start, idx1 = null, idx2 = null) {
  if (idx1 === null) idx1 = Array.from({ length: 77 }, (_, i) => i);
  if (idx2 === null) idx2 = Array.from({ length: 39 }, (_, i) => i);
  const c1 = _slots_coeffs(samples, _snd1_cfg, 0, start, SND1_N);
  if (c1.n < SND1_N) throw new Error("recording too short for a sounding");
  const [s1, g1] = _phase_feats(c1, _snd1_phases().phi, SND1_N, 77, idx1);
  const full_snr = new Float64Array(77).fill(NaN), full_gain = new Float64Array(77).fill(NaN);
  idx1.forEach((k, a) => { full_snr[k] = s1[a]; full_gain[k] = g1[a]; });
  const c2 = _slots_coeffs(samples, _snd2_cfg, SND2_GRD, start + SND1_LEN, SND2_N);
  if (c2.n < SND2_N) throw new Error("recording too short for sounding phase 2");
  const [s2, g2] = _phase_feats(c2, _snd2_phases().phi, SND2_N, 39, idx2);
  const c_snr = new Float64Array(39).fill(NaN), c_gain = new Float64Array(39).fill(NaN);
  idx2.forEach((k, a) => { c_snr[k] = s2[a]; c_gain[k] = g2[a]; });
  const pick = (arr) => A_TONE_IDX.map((i) => arr[i]);
  const ana = {
    snr_db: full_snr, rel_gain: full_gain, c_snr_db: c_snr, c_rel_gain: c_gain,
    A: _tone_feats(pick(full_snr), pick(full_gain)),
    B: _tone_feats(full_snr, full_gain),
    C: _tone_feats(c_snr, c_gain),
  };
  ana.recommendation = recommend_mode(ana);
  return ana;
}

export const THR_P10 = { A: 16.0, B: -12.0, C: 5.0 };
export const B_IMPAIRED_MEDIAN_DB = 25.0;
export const B_IMPAIRED_MAX_TONES = 47;

export function recommend_mode(ana) {
  if (ana.A.p10_snr_db >= THR_P10.A) return "A";
  if (ana.B.p10_snr_db >= THR_P10.B) return "B";
  if (ana.C.p10_snr_db >= THR_P10.C) return "C";
  return "USE_NDAP6";
}

// ascending argsort, NaN last (numpy); ties by index (numpy's default
// sort is unstable, so exact-tie order is the one place this may differ)
function argsort(a) {
  return Array.from({ length: a.length }, (_, i) => i).sort((i, j) => {
    const x = a[i], y = a[j];
    const nx = Number.isNaN(x), ny = Number.isNaN(y);
    if (nx || ny) return nx === ny ? i - j : nx ? 1 : -1;
    return x - y || i - j;
  });
}

export function mask_from_analysis(ana, mode) {
  if (mode === "A") return new Array(39).fill(1);
  let snr, gain, floor;
  if (mode === "B") { snr = ana.snr_db; gain = ana.rel_gain; floor = 2.0; }
  else { snr = ana.c_snr_db; gain = ana.c_rel_gain; floor = 0.0; }
  const n = snr.length;
  let bad = Array.from({ length: n }, (_, i) => snr[i] < floor || gain[i] < 0.25);
  const max_bad = Math.trunc(0.40 * n);
  const score = () => Array.from({ length: n }, (_, i) => snr[i] + 20 * Math.log10(Math.max(gain[i], 1e-3)));
  if (bad.filter(Boolean).length > max_bad) {
    const order = argsort(score());
    const keep = new Array(n).fill(false);
    const k = Math.ceil(0.60 * n);
    for (const i of order.slice(order.length - k)) keep[i] = true;
    bad = keep.map((v) => !v);
  }
  if (mode === "B") {
    const finite = Array.from(snr).filter((v) => !Number.isNaN(v));
    if (median(finite) < B_IMPAIRED_MEDIAN_DB) {
      const active = bad.filter((b) => !b).length;
      if (active > B_IMPAIRED_MAX_TONES) {
        const order = argsort(score());
        const act = order.filter((i) => !bad[i]);
        for (const i of act.slice(0, active - B_IMPAIRED_MAX_TONES)) bad[i] = true;
      }
    }
  }
  return bad.map((b) => (b ? 0 : 1));
}

// --- Ear hardening patch (the ONLY deviation from the conformance-proven
// codec; mirrors _degenerate_analysis()/analyze_channel() in the Python
// reference, protocols/ndap.py): degenerate input — silence, empty, too
// short, pure DC — must never throw; it yields an analysis whose
// recommendation is USE_NDAP6.
export function _degenerate_analysis() {
  const nanFeats = () => ({
    median_snr_db: NaN, p10_snr_db: NaN, min_rel_gain: NaN,
    frac_below_6db: NaN, frac_below_0db: NaN,
  });
  return {
    snr_db: new Float64Array(77).fill(NaN), rel_gain: new Float64Array(77).fill(NaN),
    c_snr_db: new Float64Array(39).fill(NaN), c_rel_gain: new Float64Array(39).fill(NaN),
    A: nanFeats(), B: nanFeats(), C: nanFeats(),
    recommendation: "USE_NDAP6", degenerate: true,
  };
}

export function analyze_channel(samples) {
  try {
    if (samples === null || samples === undefined || samples.length === 0) {
      return _degenerate_analysis();
    }
    if (samples.length < SND_LEN) return _degenerate_analysis();
    // Silence / pure DC / near-zero variance cannot contain a sounding.
    let peak = 0, sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
      sum += samples[i];
    }
    if (!(peak > 1e-9)) return _degenerate_analysis();
    const mean = sum / samples.length;
    let varSum = 0;
    for (let i = 0; i < samples.length; i++) {
      const d = samples[i] - mean;
      varSum += d * d;
    }
    if (!(varSum / samples.length > 1e-12)) return _degenerate_analysis();
    const off = _find_sounding_offset(samples);
    return _analyze_at(samples, off);
  } catch (e) {
    return _degenerate_analysis();
  }
}

// ------------------------------------------------------------ finder
export function _sounding_score(samples, off, idx1 = null) {
  if (idx1 === null) idx1 = Array.from({ length: 77 }, (_, i) => i);
  const co = _slots_coeffs(samples, _snd1_cfg, 0, off, SND1_N);
  if (co.n < SND1_N) return -1.0;
  const { pat } = _snd1_phases();
  const N = co.ntones;
  let sum = 0, cnt = 0;
  const prevPh = new Float64Array(idx1.length);
  idx1.forEach((k, a) => { prevPh[a] = Math.atan2(co.im[k], co.re[k]); });
  for (let r = 1; r < SND1_N; r++) {
    idx1.forEach((k, a) => {
      const ph = Math.atan2(co.im[r * N + k], co.re[r * N + k]);
      const d = ph - prevPh[a];
      const dphi = Math.atan2(Math.sin(d), Math.cos(d));
      sum += Math.cos(dphi - pat[k]); cnt++;
      prevPh[a] = ph;
    });
  }
  return sum / cnt;
}

export function _refined_candidates(samples, idx1 = null) {
  const x = samples;
  if (x.length < SND_LEN + MINI_LEN) return [0];
  const cands = _onset_candidates(x, SND1_SYM);
  const scored = [];
  for (const cand of cands) {
    const lo = Math.max(0, cand - SND1_SYM);
    const hi = Math.min(x.length - SND1_LEN, cand + SND1_SYM);
    if (hi < lo) continue;
    let loc_off = cand, loc_sc = -2.0;
    for (let off = lo; off <= hi; off += 8) {
      const sc = _sounding_score(x, off, idx1);
      if (sc > loc_sc) { loc_sc = sc; loc_off = off; }
    }
    for (let off = Math.max(lo, loc_off - 8); off <= Math.min(hi, loc_off + 8); off++) {
      const sc = _sounding_score(x, off, idx1);
      if (sc > loc_sc) { loc_sc = sc; loc_off = off; }
    }
    scored.push([loc_sc, loc_off]);
  }
  scored.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const out = [];
  for (const [, off] of scored) if (out.every((o) => Math.abs(off - o) >= SND1_SYM)) out.push(off);
  return out.length ? out : [0];
}

export function _find_sounding_offset(samples, idx1 = null) {
  return _refined_candidates(samples, idx1)[0];
}

function _seg0_check(x, sec_start, mini, chan = null) {
  try {
    _decode_section(MODES[mini.mode], x, sec_start, mini.seglen, mini.mask, chan);
    return true;
  } catch (e) { return false; }
}

function _refine_start(x, off, mini, mini_cfg, full_cfg = null, col_idx = null, chan = null) {
  const mini_len = _mini_len(mini_cfg);
  const good = [];
  for (let delta = -64; delta < 65; delta += 4) {
    const cand = off + delta;
    if (cand < 0) continue;
    if (_seg0_check(x, cand + SND_LEN + mini_len, mini, chan)) good.push(delta);
  }
  if (!good.length) return [off, mini];
  const delta = good[Math.floor(good.length / 2)];
  if (delta === 0) return [off, mini];
  const m2 = _mini_decode(x, off + delta + SND_LEN, mini_cfg, full_cfg, col_idx);
  if (m2 === null || m2.index !== 0) return [off, mini];
  return [off + delta, m2];
}

function _find_burst(samples, mini_cfg = _mini_cfg, full_cfg = null, col_idx = null) {
  const x = samples;
  for (const off of _refined_candidates(x)) {
    const mini = _mini_decode(x, off + SND_LEN, mini_cfg, full_cfg, col_idx);
    if (mini !== null && mini.index === 0) return _refine_start(x, off, mini, mini_cfg, full_cfg);
  }
  throw new Error("no NDAP-8 burst found (mini-header unrecoverable)");
}

// ------------------------------------------------------------ segmentation
export class SegmentError extends Error {
  constructor(message, failed, ok, mode = null, session = null) {
    super(message);
    this.name = "SegmentError";
    this.failed = failed; this.ok = ok; this.mode = mode; this.session = session;
  }
}

export function _split_work(data, mc) {
  const work = concatBytes(data, be32(crc32(data)));
  const out = [];
  for (let i = 0; i < work.length; i += mc.seg_cap) out.push(work.slice(i, i + mc.seg_cap));
  return out;
}

function _resync_mini(x, from_off, session, want_idx, mini_cfg, full_cfg = null, col_idx = null, span = 4 * SR) {
  const step = 120;
  const last = Math.min(x.length - _mini_len(mini_cfg), from_off + span);
  let off = from_off;
  while (off <= last) {
    const mini = _mini_decode(x, off, mini_cfg, full_cfg, col_idx);
    if (mini !== null && mini.index >= want_idx && (session === null || mini.session === session)) {
      let best_off = off, best_mini = mini, best_sc = -1.0;
      for (let cand = Math.max(0, off - 360); cand < off + 361; cand += 60) {
        const [m2, sc] = _mini_decode_scored(x, cand, mini_cfg, full_cfg, col_idx);
        if (m2 !== null && m2.index === mini.index && m2.session === mini.session && sc > best_sc) {
          best_off = cand; best_mini = m2; best_sc = sc;
        }
      }
      return [best_off, best_mini];
    }
    off += step;
  }
  return null;
}

function _walk_segments(x, start, mini0, mini_cfg = _mini_cfg, full_cfg = null, col_idx = null, chan = null) {
  const mode = mini0.mode, mc = MODES[mode], session = mini0.session, total = mini0.total;
  const mask = mini0.mask, token0 = mini0.token;
  let final_seen = false;
  const segments = [];
  const chunks = new Map();
  const mini_len = _mini_len(mini_cfg);
  let off = start + SND_LEN, mini = mini0, idx = 0;
  while (idx < total) {
    if (mini === null || mini.index !== idx) {
      const found = _resync_mini(x, off, session, idx, mini_cfg, full_cfg, col_idx);
      if (found === null) {
        for (let j = idx; j < total; j++) segments.push({ index: j, ok: false, error: "mini-header not found" });
        break;
      }
      [off, mini] = found;
      for (let j = idx; j < mini.index; j++) segments.push({ index: j, ok: false, error: "skipped (resync)" });
      idx = mini.index;
    }
    if (mini.session !== session || mini.mode !== mode || !bytesEqual(mini.token, token0)) {
      for (let j = idx; j < total; j++) segments.push({ index: j, ok: false, error: "session/mode/token changed mid-burst" });
      break;
    }
    if (mini.index === total - 1 && mini.final) final_seen = true;
    const sec_start = off + mini_len;
    try {
      const chunk = _decode_section(mc, x, sec_start, mini.seglen, mask, chan);
      segments.push({ index: idx, ok: true, error: null });
      chunks.set(idx, chunk);
      off = sec_start + _section_samples(mc, chunk, mini.seglen, mask, chan);
    } catch (e) {
      segments.push({ index: idx, ok: false, error: `${e.name}: ${e.message}` });
      idx += 1; mini = null; off = sec_start;
      continue;
    }
    idx += 1;
    if (idx < total) mini = _mini_decode(x, off, mini_cfg, full_cfg, col_idx);
  }
  const failed = segments.filter((s) => !s.ok).map((s) => s.index);
  const ok = segments.filter((s) => s.ok).map((s) => s.index);
  const rep = { ok: false, data: null, mode, session, segments, failed_segments: failed,
                ok_segments: ok, error: null, version: mini0.version, next_speaker: mini0.next_speaker,
                final_seen, house_token: token0, house_token_ok: null };
  if (failed.length) { rep.error = `segments failed: [${failed.join(", ")}]`; return rep; }
  const parts = [];
  for (let i = 0; i < total; i++) parts.push(chunks.get(i));
  const work = concatBytes(...parts);
  if (work.length < 4) { rep.error = "full-message CRC-32 mismatch"; return rep; }
  const data = work.slice(0, work.length - 4);
  if (rd32(work, work.length - 4) !== crc32(data)) { rep.error = "full-message CRC-32 mismatch"; return rep; }
  rep.ok = true; rep.data = data;
  return rep;
}

// ------------------------------------------------------------ public API
function randomSession() {
  const b = new Uint8Array(2);
  globalThis.crypto.getRandomValues(b);
  return (b[0] << 8) | b[1];
}

// opts: { analysis, session_id, house_secret, next_speaker }
export function encode_adaptive(data, mode, opts = {}) {
  const { analysis = null, house_secret = null, next_speaker = 0 } = opts;
  let { session_id = null } = opts;
  if (!(mode in MODES)) throw new Error(`unknown mode '${mode}'`);
  const mc = MODES[mode];
  const mask = analysis !== null ? mask_from_analysis(analysis, mode) : new Array(mc.grid.length).fill(1);
  if (session_id === null) session_id = randomSession();
  const token = house_secret !== null ? house_token(session_id, crc32(data), house_secret) : null;
  const chunks = _split_work(data, mc);
  const parts = [_sounding_audio()];
  chunks.forEach((chunk, i) => {
    parts.push(_mini_encode(mode, session_id, i, chunks.length, _seg_stored_len(mc, chunk), mask,
                            _mini_cfg, i === chunks.length - 1, token, next_speaker));
    parts.push(_encode_section(mc, chunk, mask));
  });
  return concatFloat(parts);
}

function concatFloat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float64Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function encode_auto(data, sounding_samples) {
  const ana = analyze_channel(sounding_samples);
  const mode = ana.recommendation;
  if (mode === "USE_NDAP6") return [null, mode];
  return [encode_adaptive(data, mode, { analysis: ana }), mode];
}

export function decode_adaptive_report(samples, start = null, house_secret = null) {
  const x = samples instanceof Float64Array ? samples : Float64Array.from(samples);
  let mini0;
  if (start === null) [start, mini0] = _find_burst(x);
  else {
    mini0 = _mini_decode(x, start + SND_LEN);
    if (mini0 === null || mini0.index !== 0) throw new Error("mini-header unrecoverable at given start");
  }
  const rep = _walk_segments(x, start, mini0);
  if (rep.ok && house_secret !== null && rep.house_token) {
    const expect = house_token(rep.session, crc32(rep.data), house_secret);
    rep.house_token_ok = bytesEqual(expect, rep.house_token);
  }
  return rep;
}

export function decode_adaptive(samples, start = null) {
  const rep = decode_adaptive_report(samples, start);
  if (!rep.ok) throw new SegmentError(rep.error || "decode failed", rep.failed_segments, rep.ok_segments, rep.mode, rep.session);
  return rep.data;
}

export const decode_auto = decode_adaptive;
export const encode_fast = encode_adaptive;
export const decode_fast = decode_adaptive;

// ------------------------------------------------------------ duplex
const _half_idx = (n, which) => { const r = []; for (let i = which; i < n; i += 2) r.push(i); return r; };

function _duplex_chan(which) {
  const idx = _half_idx(20, which);
  const mini_cfg = new Cfg(`mini-h${which}`, idx.map((i) => PENTA[i]), idx.map((i) => PENTA_GAINS[i]),
                           MINI_SYM, new Array(10).fill(2));
  return [mini_cfg, idx];
}

function _duplex_payload_chan(mc, which, mask) {
  const full = _full_cfg(mc);
  const [sub, sel] = _sel_cfg(mc, mask, _half_idx(mc.grid.length, which));
  return [full, sel, sub];
}

// opts: { analysis_a, analysis_b, session_a, session_b, house_secret, next_speaker }
export function encode_duplex(data_a, data_b, mode = "B", opts = {}) {
  const { analysis_a = null, analysis_b = null, house_secret = null, next_speaker = 0 } = opts;
  if (!(mode in MODES)) throw new Error(`unknown mode '${mode}'`);
  const mc = MODES[mode];
  const outs = [];
  for (const [which, data, ana, sess0] of [[0, data_a, analysis_a, opts.session_a ?? null],
                                           [1, data_b, analysis_b, opts.session_b ?? null]]) {
    const snd = _sounding_audio(_half_idx(77, which), _half_idx(39, which));
    const [mini_cfg] = _duplex_chan(which);
    const mask = ana !== null ? mask_from_analysis(ana, mode) : new Array(mc.grid.length).fill(1);
    const sess = sess0 !== null ? sess0 : randomSession();
    const token = house_secret !== null ? house_token(sess, crc32(data), house_secret) : null;
    const sub = _duplex_payload_chan(mc, which, mask)[2];
    const chunks = _split_work(data, mc);
    const parts = [snd];
    chunks.forEach((chunk, i) => {
      parts.push(_mini_encode(mode, sess, i, chunks.length, _seg_stored_len(mc, chunk), mask, mini_cfg,
                              i === chunks.length - 1, token, next_speaker));
      parts.push(_encode_section(mc, chunk, mask, sub));
    });
    outs.push(concatFloat(parts));
  }
  const n = Math.max(outs[0].length, outs[1].length);
  const mix = new Float64Array(n);
  for (let i = 0; i < outs[0].length; i++) mix[i] += outs[0][i];
  for (let i = 0; i < outs[1].length; i++) mix[i] += outs[1][i];
  return _normalize(mix);
}

export function decode_duplex(samples, start = null, mode = "B") {
  const x = samples instanceof Float64Array ? samples : Float64Array.from(samples);
  if (!(mode in MODES)) throw new Error(`unknown mode '${mode}'`);
  const mc = MODES[mode];
  if (start === null) {
    start = _find_sounding_offset(x, _half_idx(77, 0));
    const [mc0, ci0] = _duplex_chan(0);
    const m0 = _mini_decode(x, start + SND_LEN, mc0, _mini_cfg, ci0);
    if (m0 !== null && m0.index === 0 && m0.mode === mode) {
      const chan0 = _duplex_payload_chan(mc, 0, m0.mask);
      [start] = _refine_start(x, start, m0, mc0, _mini_cfg, ci0, chan0);
    }
  }
  const results = [];
  for (const which of [0, 1]) {
    const [mini_cfg, col_idx] = _duplex_chan(which);
    const mini0 = _mini_decode(x, start + SND_LEN, mini_cfg, _mini_cfg, col_idx);
    if (mini0 === null || mini0.index !== 0) throw new SegmentError(`duplex direction ${which}: mini-header unrecoverable`, [], [], mode, null);
    if (mini0.mode !== mode) throw new SegmentError(`duplex direction ${which}: announces mode ${mini0.mode}, session is ${mode}`, [], [], mode, null);
    const chan = _duplex_payload_chan(mc, which, mini0.mask);
    const rep = _walk_segments(x, start, mini0, mini_cfg, _mini_cfg, col_idx, chan);
    if (!rep.ok) throw new SegmentError(`duplex direction ${which}: ${rep.error}`, rep.failed_segments, rep.ok_segments, mode, rep.session);
    results.push(rep.data);
  }
  return [results[0], results[1]];
}

// internals exported for the test suites
export { _mini_cfg, _full_cfg, _permute, _unpermute, _data_perm_P, unpackbits, packbits };
