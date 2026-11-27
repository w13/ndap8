#!/usr/bin/env python3
"""NDAP — Narrowband Data-over-Audio Protocol: the consolidated
final implementation (protocol version 8, the adaptive profile,
implementation revision 8.2 — a clean-slate wire format; it neither
decodes nor is decoded by 8.0/8.1, and says so loudly: see
RevisionError).

This single module is the whole NDAP-8 reference implementation
— no other imports from the project, nothing to keep in step.
It senses the room and runs at the fastest mode that survives
it — "very fast or just fast" — and says so when no mode
does. The full specification — written to be implementable
from the document alone — is SPEC.md.

Author: Waqqas Hanafi

Architecture (one pipeline, modes as data):

    [SOUNDING][SEGMENT 0][SEGMENT 1] ... [SEGMENT n-1]
    SEGMENT i = [MINI-HEADER i][PAYLOAD SECTION i]

- MODES is a table of ModeCfg entries (tone grid, symbol and
  guard lengths, bits per tone, code type and rate, segment
  cap, gains). A single section codec (_encode_section /
  _decode_section) is parameterized by the entry; there are
  no per-mode code paths. The shared machinery — the RS codec,
  the rate-1/3 convolutional codec, the framing/interleave/
  CRC layer, and the augmented [B|conj(B)] projection
  detector — each exists exactly once, in this file.
- SOUNDING (0.2 s): phase 1 = 8 symbols x 10 ms on the 77-tone
  100 Hz grid (400-8000 Hz), known phase pattern, no guard,
  rectangular window (rev 8.2) —
  the findable preamble and the A/B channel probe. Phase 2 =
  4 symbols at Mode C's own timing (20 ms + 10 ms guard) on
  the 39-tone 200 Hz grid — the C probe. analyze_channel() is
  one pure function of a samples array: per-tone gains and
  residual interference -> per-tone effective SINR per phase,
  plus a recommended mode (fastest whose 10th-percentile
  per-tone SINR clears its threshold; thresholds include a
  3 dB safety margin — spec §5). Below C: 'USE_NDAP6'.
- SEGMENTATION: the payload (plus a CRC-32 trailer over the
  original data) is split into segments of at most ~2 s of
  audio each, so the channel only has to stay coherent for
  ~2 s at a time and a mid-burst fade costs segments, not the
  message. The decoder reports exactly which segments failed;
  a wrong decode surfaces as failure, never as wrong bytes.
  The mode is fixed at burst start — a one-way burst has no
  backchannel. Compression is per segment and resets with
  the mode: a zlib stream never spans segments or modes.
- MINI-HEADER (0.575 s simplex): 31 info bytes — magic 'N8',
  wire-REVISION byte (0x82; any other value on a CRC-valid header
  raises RevisionError), mode, 16-bit random SESSION ID (a
  never-intentionally-repeated nonce; keeps simultaneous
  sessions in one room from cross-decoding), segment index,
  segment count, flags (FINAL-segment bit, house-token-
  present bit, 2-bit NEXT-SPEAKER field), segment chunk
  length, the session tone mask, an OPTIONAL 6-byte house
  token (HMAC-SHA256 truncated — origin authentication only,
  never required to decode, off by default), CRC-16 — on
  the 20 pentatonic tones, DQPSK, 25 ms slots,
  protected by the rate-1/3 convolutional codec with
  soft-decision Viterbi and a stride interleave. FLOOR
  CONTROL: bursts are exchanged as recordings, not live
  conversation; a burst is complete only when a segment
  carrying the FINAL flag has decoded — the floor is then
  free, and NEXT-SPEAKER says whose it is. (Contention
  arbitration is out of scope — spec §9.)
- PAYLOAD SECTION per segment, by mode:
  A "very fast" — the maximum-speed layout: grid200 (39
     tones), 5 ms rectangular symbols, no guard, differential
     8-PSK, shortened RS(.,.-16).
  B "fast" — grid100 (77 tones), 10 ms rectangular symbols +
     10 ms guard, differential QPSK, shortened RS(.,.-32),
     per-tone selection.
  C "sturdy" — the sounding-passing subset of grid200
     (up to 39 tones), 20 ms symbols + 10 ms guard,
     differential QPSK with soft LLRs into the rate-1/3
     convolutional code + stride interleave.
  The RS modes send SHORTENED blocks (only the data actually
  present plus parity) and the mini-header carries each
  section's exact stored length, so every section is bounded.
- Per-tone selection (modes B/C; any mode takes an explicit
  tone_mask from a sender that knows its channel): tones the
  sounding shows as interfered or deeply faded are excluded
  from the session's tone set; the mask travels in every
  mini-header; excluded capacity is lost, not reassigned.
- Full duplex (all modes): FDD interleaved split of every
  section, each direction a complete adaptive burst on its
  half of the tones; decoding projects the full tone set and
  splits columns afterwards.

API:
  audio, mode = encode_auto(data, sounding_samples)
  audio = encode_adaptive(data, mode, analysis=None, ..., tone_mask=None)
  data  = decode_adaptive(samples, start=None)   (raises SegmentError)
  data  = decode_auto(samples, start=None)       (alias)
  rep   = decode_adaptive_report(samples, start=None, house_secret=None)
  rec   = sounding_burst()
  ana   = analyze_channel(samples)
  mode  = recommend_mode(ana)
  mix   = encode_duplex(data_a, data_b, mode='B')
  a, b  = decode_duplex(samples, mode='B')
  encode_fast / decode_fast are aliases of the adaptive
  entry points.

CLI:
  python3 ndap.py encode "text" out.wav [A|B|C]
  python3 ndap.py decode in.wav
  python3 ndap.py sounding out.wav
  python3 ndap.py analyze in.wav
  python3 ndap.py auto sounding.wav "text" out.wav
"""
import sys, os, math, struct, wave, zlib, binascii, hashlib, hmac
import contextvars
from dataclasses import dataclass
import numpy as np

SR = 48000

# Implementation/document revision. The on-air revision byte (WIRE_REV,
# see the mini-header) is a separate wire-level constant. 8.2 is a
# clean-slate break: it does not decode, and is not decoded by, 8.0/8.1.
__version__ = "8.2.0"

# ------------------------------------------------------------ WAV IO
# 48 kHz mono 16-bit WAV read/write — the file
# format for burst exchange.

def write_wav(path: str, samples) -> None:
    pcm = np.clip(np.asarray(samples) * 32767, -32768, 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def read_wav(path: str):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SR and w.getnchannels() == 1, "need 48 kHz mono WAV"
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(float) / 32767.0


# ------------------------------------------------------------ Reed-Solomon codec
# The RS codec over GF(256) (primitive polynomial
# 0x11D): one implementation, used by the payload framing
# and the repeated header blocks.

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _mul(a, b):
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _div(a, b):
    if b == 0:
        raise ZeroDivisionError("GF division by zero")
    return 0 if a == 0 else _EXP[(_LOG[a] - _LOG[b]) % 255]


def _pow(a, p):
    if a == 0:
        return 0
    return _EXP[(_LOG[a] * p) % 255]


def _poly_mul_hi(p, q):
    """Multiply polynomials given highest-degree-first (for encoding)."""
    r = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        if a:
            for j, b in enumerate(q):
                if b:
                    r[i + j] ^= _mul(a, b)
    return r


def _poly_eval_hi(p, x):
    y = 0
    for c in p:
        y = _mul(y, x) ^ c
    return y


def _rs_gen(nsym):
    g = [1]
    for i in range(nsym):
        g = _poly_mul_hi(g, [1, _pow(2, i)])
    return g


def rs_encode(msg: bytes, nsym: int) -> bytes:
    gen = _rs_gen(nsym)
    out = list(msg) + [0] * nsym
    for i in range(len(msg)):
        coef = out[i]
        if coef:
            for j in range(len(gen)):
                out[i + j] ^= _mul(gen[j], coef)
    return bytes(msg) + bytes(out[len(msg):])


def _syndromes(msg, nsym):
    """S_i = r(alpha^i), i = 0..nsym-1, ascending list."""
    return [_poly_eval_hi(list(msg), _pow(2, i)) for i in range(nsym)]


def _berlekamp_massey(synd):
    """Ascending-coefficient convention. Returns (Lambda, L):
    Lambda(z) = 1 + l1 z + ... + lL z^L, the error locator."""
    lam = [1]
    B = [1]
    L = 0
    m = 1
    b = 1
    for n in range(len(synd)):
        # discrepancy d = S_n + sum_{j=1..L} lam_j * S_{n-j}
        d = synd[n]
        for j in range(1, L + 1):
            d ^= _mul(lam[j], synd[n - j])
        if d == 0:
            m += 1
        elif 2 * L <= n:
            T = lam[:]
            # lam -= (d/b) * z^m * B
            coef = _div(d, b)
            need = len(B) + m
            if len(lam) < need:
                lam += [0] * (need - len(lam))
            for i in range(len(B)):
                lam[i + m] ^= _mul(coef, B[i])
            L = n + 1 - L
            B = T
            b = d
            m = 1
        else:
            coef = _div(d, b)
            need = len(B) + m
            if len(lam) < need:
                lam += [0] * (need - len(lam))
            for i in range(len(B)):
                lam[i + m] ^= _mul(coef, B[i])
            m += 1
    lam = lam[:L + 1] + [0] * max(0, L + 1 - len(lam))
    return lam, L


def _solve_magnitudes(Xs, synd, L):
    """Solve sum_k Y_k * X_k^i = S_i (i=0..L-1) over GF(256)."""
    n = L
    A = [[_pow(Xs[k], i) for k in range(n)] + [synd[i]] for i in range(n)]
    for col in range(n):
        piv = None
        for r in range(col, n):
            if A[r][col] != 0:
                piv = r
                break
        if piv is None:
            raise ValueError("RS: singular magnitude system")
        A[col], A[piv] = A[piv], A[col]
        inv = _div(1, A[col][col])
        A[col] = [_mul(v, inv) for v in A[col]]
        for r in range(n):
            if r != col and A[r][col] != 0:
                f = A[r][col]
                A[r] = [a ^ _mul(f, c) for a, c in zip(A[r], A[col])]
    return [A[i][n] for i in range(n)]


def rs_decode(codeword: bytes, nsym: int) -> bytes:
    msg = list(codeword)
    n = len(msg)
    synd = _syndromes(msg, nsym)
    if max(synd) == 0:
        return bytes(msg[:n - nsym])
    lam, L = _berlekamp_massey(synd)
    if L < 1 or L > nsym // 2:
        raise ValueError("RS: error count out of range")
    # Chien search: error with exponent e (position p = n-1-e) iff Lambda(alpha^-e) == 0
    err_exp = []
    for e in range(n):
        z = _pow(2, -e)
        y = 0
        for c in reversed(lam):
            y = _mul(y, z) ^ c
        if y == 0:
            err_exp.append(e)
    if len(err_exp) != L:
        raise ValueError("RS: locator root count mismatch")
    Xs = [_pow(2, e) for e in err_exp]
    Ys = _solve_magnitudes(Xs, synd, L)
    for e, Y in zip(err_exp, Ys):
        msg[n - 1 - e] ^= Y
    if max(_syndromes(msg, nsym)) != 0:
        raise ValueError("RS: correction failed verification")
    return bytes(msg[:n - nsym])


# ------------------------------------------------------------ convolutional codec
# Rate-1/3 convolutional code (constraint length 7,
# generators 171/165/133 octal) with soft-decision
# Viterbi decoding, plus the stride permutations and
# CRC-16 the mini-header and Mode C are built on.

CODE_GENS = (0o171, 0o165, 0o133)   # rate 1/3, K=7 (see SPEC.md)
K_TAIL = 6                     # zero-tail length (K-1)
_PARITY = [bin(x).count("1") & 1 for x in range(128)]


def _conv_tables(gens):
    nout = len(gens)
    out = np.zeros((nout, 64, 2), dtype=np.int8)
    for r in range(64):
        for u in range(2):
            v = (u << 6) | r
            for o, g in enumerate(gens):
                out[o, r, u] = _PARITY[v & g]
    return out


_TABLES = {}


def _tables(gens):
    if gens not in _TABLES:
        _TABLES[gens] = _conv_tables(gens)
    return _TABLES[gens]


def conv_encode(bits, gens=CODE_GENS):
    """bits: 0/1 array WITHOUT tail; 6 zero tail bits are appended
    here. Returns the coded bit array, len = nout * (len(bits) + 6)."""
    out_t = _tables(gens)
    nout = len(gens)
    reg = 0
    res = np.empty(nout * (len(bits) + K_TAIL), dtype=np.uint8)
    i = 0
    for u in list(bits) + [0] * K_TAIL:
        u = int(u)
        for o in range(nout):
            res[i] = out_t[o, reg, u]
            i += 1
        reg = ((u << 5) | (reg >> 1)) & 0x3F
    return res


# predecessor index helpers for the Viterbi trellis (state = register)
_S = np.arange(64)
_U_OF_NEXT = (_S >> 5).astype(np.int64)
_R0 = ((_S & 0x1F) << 1).astype(np.int64)
_R1 = (_R0 | 1).astype(np.int64)


def viterbi_decode(llrs, n_info_bits, gens=CODE_GENS):
    """llrs: soft values, positive = bit 1 more likely, laid out as
    consecutive steps of len(gens) values (generator order). n_info_bits
    counts the info bits WITHOUT the 6 tail bits. Returns the decoded
    info bits as a uint8 array. Correlation (max-sum) decoding."""
    out_t = _tables(gens)
    nout = len(gens)
    nsteps = n_info_bits + K_TAIL
    ll = np.asarray(llrs, dtype=float).reshape(nsteps, nout)
    signs = [2.0 * out_t[o].astype(float) - 1.0 for o in range(nout)]
    metric = np.full(64, -1e18)
    metric[0] = 0.0
    decisions = np.empty((nsteps, 64), dtype=np.uint8)
    for t in range(nsteps):
        bm = signs[0] * ll[t, 0]
        for o in range(1, nout):
            bm = bm + signs[o] * ll[t, o]
        cand = metric[:, None] + bm            # cand[r, u]
        c0 = cand[_R0, _U_OF_NEXT]
        c1 = cand[_R1, _U_OF_NEXT]
        pick1 = c1 > c0
        metric = np.where(pick1, c1, c0)
        decisions[t] = np.where(pick1, _R1, _R0).astype(np.uint8)
    bits = np.empty(nsteps, dtype=np.uint8)
    state = 0                                  # zero-tail: end state 0
    for t in range(nsteps - 1, -1, -1):
        bits[t] = state >> 5
        state = int(decisions[t, state])
    return bits[:n_info_bits]


def _permute(bits, P):
    """out[i*P mod L] = bits[i]. Works for hard bits and soft values."""
    L = len(bits)
    idx = (np.arange(L, dtype=np.int64) * P) % L
    out = np.empty_like(bits)
    out[idx] = bits
    return out


def _unpermute(bits, P):
    """Inverse of _permute: orig[i] = permuted[(i*P) mod L]."""
    L = len(bits)
    idx = (np.arange(L, dtype=np.int64) * P) % L
    return bits[idx]


def _data_perm_P(L):
    """Deterministic stride derived from the bit length alone, so the
    encoder and decoder always agree."""
    P = 257
    while math.gcd(P, L) != 1:
        P += 2
    return P


def _crc16(data: bytes) -> int:
    return binascii.crc_hqx(data, 0xFFFF)

# ------------------------------------------------------------ tone layouts
# The tone sets and the one layout class, each defined
# exactly once. PENTA is the pentatonic grid (20 tones,
# A minor, 220 Hz to ~3.1 kHz, top-octave gain taper) — home of
# the mini-header. A_LAYOUT is the maximum-speed layout
# (uniform orthogonal grid, 400-8000 Hz at 200 Hz spacing,
# 5 ms symbols): Mode A's grid.
PENTA_SEMI = [0, 3, 5, 7, 10]  # A minor pentatonic
PENTA = np.array([220.0 * 2 ** ((PENTA_SEMI[k % 5] + 12 * (k // 5)) / 12)
                  for k in range(20)])
PENTA_GAINS = np.array([1.0 if f < 1600 else 0.55 for f in PENTA])


def _grid_freqs(lo, hi, step):
    n = int(round((hi - lo) / step)) + 1
    return lo + step * np.arange(n, dtype=float)


class Cfg:
    """One tone layout + symbol duration + per-tone bit widths."""

    def __init__(self, name, freqs, gains, sym, bits=None, taper=0.25):
        self.name = name
        self.taper = float(taper)
        self.freqs = np.asarray(freqs, dtype=float)
        self.gains = np.asarray(gains, dtype=float)
        self.sym = int(sym)
        self.bits = list(bits) if bits is not None else [3] * len(self.freqs)
        self._basis_cache = None

    @property
    def ntones(self):
        return len(self.freqs)

    @property
    def bits_per_sym(self):
        return sum(self.bits)

    def basis(self):
        """(win, E, B, PINV): Tukey window, synthesis basis, windowed
        basis, and the pseudoinverse of the conjugate-augmented
        detector matrix [B | conj(B)] — all at this cfg's symbol
        size. The augmented matrix is what detection actually uses:
        a real signal is exactly a combination of the 2N windowed
        exponentials, so the projection recovers each tone's
        coefficient (halved) with the negative-frequency images
        fitted instead of leaking into the phases."""
        if self._basis_cache is None:
            t = np.arange(self.sym)
            win = np.ones(self.sym)
            r = int(self.taper * self.sym / 2)
            if r > 0:
                win[:r] = 0.5 - 0.5 * np.cos(np.pi * np.arange(r) / r)
                win[-r:] = win[:r][::-1]
            E = np.exp(2j * np.pi * np.outer(t, self.freqs) / SR)
            B = win[:, None] * E
            B2 = np.hstack([B, np.conj(B)])
            self._basis_cache = (win, E, B2, np.linalg.pinv(B2))
        return self._basis_cache

    def cond(self):
        """Condition number of the (augmented) detector matrix."""
        _, _, B2, _ = self.basis()
        s = np.linalg.svd(B2, compute_uv=False)
        return float(s[0] / s[-1])

    def sub(self, idx):
        """Sub-layout on a subset of tone indices (duplex halves)."""
        idx = list(idx)
        return Cfg(f"{self.name}[{len(idx)}t]", self.freqs[idx],
                   self.gains[idx], self.sym, [self.bits[i] for i in idx],
                   self.taper)


# Rev 8.2: the detector window is rectangular (taper 0) for the dense
# layouts. A Tukey taper breaks the orthogonality of tones spaced at
# exactly 1/T, and the augmented projection then amplifies noise by its
# condition number (measured, rev 8.1: cond 32 for A, 91 for B -> ~10 dB
# and ~17 dB of lost noise margin: the dominant part of the 8.1 A/B floor).
A_LAYOUT = Cfg("grid200@5ms", _grid_freqs(400, 8000, 200), np.ones(39), 240,
               taper=0.0)


# ------------------------------------------------------------ layout machinery
# Gray tables, the payload preamble pattern, and the shared
# bit-packing and onset-finding helpers used by the detector
# and the burst finder.

def _gray_tables(w):
    g = [v ^ (v >> 1) for v in range(1 << w)]      # value -> step index
    inv = [0] * (1 << w)
    for v, s in enumerate(g):
        inv[s] = v
    return g, inv


def _schroeder(n, sign=1.0):
    """Schroeder phases for n equal-amplitude tones: a flat-spectrum
    multisine with a low crest factor (a chirp-like sweep through the
    whole band once per symbol). Every deterministic symbol in the
    format uses these, because the burst is peak-normalized: a high-
    crest preamble would set the scale and pin the data symbols
    10 dB or more below the speaker's headroom (measured on rev 8.1:
    preamble/sounding crest 19-25 dB, data 12-15 dB)."""
    k = np.arange(n)
    return sign * np.pi * k * k / max(n, 1)


def _preamble_phases(cfg):
    """(PREAMBLE, ntones) absolute phases of the payload-section
    preamble: one low-crest reference symbol (rev 8.2; 8.1 spent six
    symbols on a pattern preamble)."""
    return np.tile(_schroeder(cfg.ntones), (PREAMBLE, 1))


def _values_to_stream(vals, cfg: Cfg) -> bytes:
    bits = np.empty((len(vals), cfg.bits_per_sym), dtype=np.uint8)
    off = 0
    for j, w in enumerate(cfg.bits):
        for i in range(w):
            bits[:, off + i] = (vals[:, j] >> (w - 1 - i)) & 1
        off += w
    return np.packbits(bits.reshape(-1)).tobytes()


# ------------------------------------------------------------ tone sets
GRID100 = 400.0 + 100.0 * np.arange(77)      # sounding ph.1 + mode B
GRID200 = 400.0 + 200.0 * np.arange(39)      # sounding ph.2, modes A/C
# PENTA — the mini-header tone set — is defined with the
# layouts above (the pentatonic grid).
A_TONE_IDX = [int(round((f - 400) / 100)) for f in GRID200]  # in GRID100

# ------------------------------------------------------------ modes (data)
PREAMBLE = 1                       # payload-section preamble symbols


@dataclass(frozen=True)
class ModeCfg:
    name: str
    grid: np.ndarray               # candidate tone frequencies (Hz)
    gains: tuple                   # per-tone gains over the grid
    active: int                    # active window, samples
    guard: int                     # guard interval, samples
    bits: int                      # bits per tone (3=8-PSK, 2=QPSK)
    code: str                      # 'rs' | 'conv'
    rs_data: int                   # RS block data bytes (code='rs')
    rs_nsym: int                   # RS parity symbols (code='rs')
    seg_cap: int                   # raw work-chunk cap, bytes
    taper: float = 0.25            # detector/synthesis window taper
    scan_step: int = 16            # start-refinement step, samples


MODES = {
    # A is the maximum-speed layout (grid200 at 5 ms), defined
    # once above as A_LAYOUT.
    "A": ModeCfg("A", A_LAYOUT.freqs, tuple(A_LAYOUT.gains),
                 A_LAYOUT.sym, 0, 3, "rs", 239, 16, 3400, 0.0, 4),
    # B: RS(255,223) (8.1: RS(255,191)) — with the orthogonal detector
    # nsym 32 survives as far as nsym 64 did (measured, SPEC s14), and
    # the freed parity is ~17 % more payload per second.
    "B": ModeCfg("B", GRID100, (1.0,) * 77, 480, 480, 2, "rs",
                 223, 32, 1200, 0.0, 16),
    "C": ModeCfg("C", GRID200, (1.0,) * 39, 960, 480, 2, "conv",
                 0, 0, 105, 0.25, 16),
}


def _sel_cfg(mc: ModeCfg, mask, half=None):
    """The Cfg for the tones this session uses: the mode grid,
    optionally restricted to a duplex half (global indices),
    minus the masked-out tones. Returns (cfg, global indices)."""
    idx = list(range(len(mc.grid))) if half is None else list(half)
    sel = [i for i in idx if mask[i]]
    cfg = Cfg(f"ndap8-{mc.name}", [mc.grid[i] for i in sel],
              [mc.gains[i] for i in sel], mc.active,
              bits=[mc.bits] * len(sel), taper=mc.taper)
    return cfg, sel


def _full_cfg(mc: ModeCfg) -> Cfg:
    """The mode's complete grid as one Cfg (joint projection
    for duplex decoding)."""
    return Cfg(f"ndap8-{mc.name}-full", list(mc.grid), list(mc.gains),
               mc.active, bits=[mc.bits] * len(mc.grid), taper=mc.taper)


# ------------------------------------------------------------ sounding
SND1_SYM, SND1_N = 480, 8                    # 8 x 10 ms, no guard
SND2_ACT, SND2_GRD, SND2_N = 960, 480, 4     # 4 x (20 ms + 10 ms)
SND1_LEN = SND1_SYM * SND1_N                 # 3840
SND2_LEN = (SND2_ACT + SND2_GRD) * SND2_N    # 5760
SND_LEN = SND1_LEN + SND2_LEN                # 9600 samples = 0.2 s
_snd1_cfg = Cfg("snd100", GRID100, np.ones(77), SND1_SYM, bits=[0] * 77,
                taper=0.0)
_snd2_cfg = Cfg("snd200", GRID200, np.ones(39), SND2_ACT, bits=[0] * 39)


# Sounding chirp-sign sequences: each symbol is an up (+1) or down (-1)
# Schroeder chirp. Non-periodic sign patterns give the correlation
# finder one unambiguous peak (autocorrelation sidelobes <= ~1/7 for
# phase 1) while every symbol stays low-crest. Known phases per tone
# per symbol are all the channel probe needs.
SND1_SIGNS = (1, 1, 1, -1, -1, 1, -1, 1)
SND2_SIGNS = (1, 1, -1, 1)


def _snd1_phases():
    return np.stack([_schroeder(77, sg) for sg in SND1_SIGNS])


def _snd2_phases():
    return np.stack([_schroeder(39, sg) for sg in SND2_SIGNS])


def _sounding_audio(idx1=None, idx2=None):
    """Sounding on subsets of the grids (duplex halves)."""
    win1, E1, _, _ = _snd1_cfg.basis()
    phi1 = _snd1_phases()
    if idx1 is None:
        idx1 = list(range(77))
    coeffs = np.zeros((SND1_N, 77), dtype=complex)
    coeffs[:, idx1] = np.exp(1j * phi1[:, idx1])
    a1 = (np.real(coeffs @ E1.T) * win1[None, :]).reshape(-1)
    win2, E2, _, _ = _snd2_cfg.basis()
    phi2 = _snd2_phases()
    if idx2 is None:
        idx2 = list(range(39))
    coeffs2 = np.zeros((SND2_N, 39), dtype=complex)
    coeffs2[:, idx2] = np.exp(1j * phi2[:, idx2])
    sig2 = np.real(coeffs2 @ E2.T) * win2[None, :]
    a2 = np.zeros(SND2_LEN)
    slot = SND2_ACT + SND2_GRD
    for i in range(SND2_N):
        a2[i * slot:i * slot + SND2_ACT] = sig2[i]
    audio = np.concatenate([a1, a2])
    peak = np.max(np.abs(audio))
    return audio * (0.85 / peak) if peak > 0 else audio


def sounding_burst() -> np.ndarray:
    return _sounding_audio()


# ------------------------------------------- shared signal primitives
# The one projection detector, the one modulator, the one set
# of Gray/LLR helpers. Everything above this line and below it
# uses these and only these.

def _slots_coeffs(samples, cfg: Cfg, guard: int, start: int, nsym=None):
    """Project every slot's active window with the augmented
    [B | conj(B)] detector (float64 least squares). Returns
    (nsym, ntones) complex coefficients."""
    _, _, _, PINV = cfg.basis()
    x = np.asarray(samples, dtype=float)[start:]
    slot = cfg.sym + guard
    # Complete a truncated final slot with zeros: when the found
    # start is a few samples late, the last symbol of the last
    # segment would otherwise be dropped whole, which kills a
    # convolutional code's tail (measured: mode C's final
    # segment failing in every room channel while segments 0-13
    # passed). A few missing tail samples cost the projection
    # almost nothing; a missing symbol costs the segment.
    if len(x) % slot:
        x = np.concatenate([x, np.zeros(slot - len(x) % slot)])
    n = len(x) // slot
    if nsym is not None:
        n = min(n, nsym)
    if n <= 0:
        return np.empty((0, cfg.ntones), dtype=complex)
    segs = np.stack([x[i * slot:i * slot + cfg.sym] for i in range(n)])
    if _ENV_NORM.get():
        segs = _divide_envelope(segs, cfg, slot)
    return (segs @ PINV.T)[:, :cfg.ntones]


# --- slow-envelope normalization (NDAP-8 rev 8.1) -------------------
# Phone AGC, a tremolo, or a deliberate slow "purr" multiplies the
# burst by a slowly varying gain. The data is differential phase, so
# it survives most of that, but the gain ripple inside a symbol
# window bends the least-squares projection. After sync the
# receiver can estimate the gain from the burst itself and divide it
# out. Estimation is slot-aware (it measures only the active
# windows, never the silent guards) and runs on the same slot grid
# the detector uses, so it needs no extra side information.
_ENV_NORM = contextvars.ContextVar("ndap_env_norm", default=False)
ENV_SUB = 240                       # sub-window length: 5 ms
ENV_GAIN_LIMITS = (0.35, 2.5)       # clamp vs the burst's median gain


def _divide_envelope(segs, cfg: Cfg, slot: int):
    """segs: (n, sym) active windows of consecutive slots. Returns
    segs divided by a smoothed per-sample gain envelope. The gain
    is measured in ~5 ms sub-windows (power, corrected for the
    detector window's taper), smoothed over three neighbours
    (~15 ms), and interpolated linearly between sub-window centres
    (across the guards). The result is scaled so the burst's median
    gain is 1: only the ripple is removed, not the level."""
    n, sym = segs.shape
    m = max(1, int(round(sym / ENV_SUB)))
    sub = sym // m
    win = cfg.basis()[0]
    wpow = (win[:m * sub] ** 2).reshape(m, sub).mean(axis=1)    # taper
    pw = (segs[:, :m * sub] ** 2).reshape(n, m, sub).mean(axis=2) / wpow
    g = np.sqrt(np.maximum(pw.reshape(-1), 1e-18))
    cen = (np.arange(n)[:, None] * slot + (np.arange(m)[None, :] + 0.5)
           * sub).reshape(-1)
    if len(g) >= 3:
        gp = np.concatenate([[g[0]], g, [g[-1]]])
        g = 0.25 * gp[:-2] + 0.5 * gp[1:-1] + 0.25 * gp[2:]
    med = float(np.median(g))
    if not med > 0:
        return segs
    g = np.clip(g / med, *ENV_GAIN_LIMITS)
    pos = (np.arange(n)[:, None] * slot + np.arange(sym)[None, :] + 0.5)
    env = np.interp(pos.reshape(-1), cen, g).reshape(n, sym)
    return segs / env


def _values_from_coeffs(coeffs, cfg: Cfg, pre_rows: int):
    """Hard per-symbol data values from coefficients: phase
    differences, Gray-decoded. Drops the first pre_rows-1 diffs
    (the preamble-internal ones)."""
    phases = np.angle(coeffs)
    dphi = np.angle(np.exp(1j * (phases[1:] - phases[:-1])))
    vals = np.empty((len(dphi), cfg.ntones), dtype=int)
    for j, w in enumerate(cfg.bits):
        if w == 0:
            continue
        _, inv = _gray_tables(w)
        steps = np.round(dphi[:, j] / (2 * np.pi / (1 << w))).astype(int) % (1 << w)
        vals[:, j] = [inv[s] for s in steps]
    return vals[pre_rows - 1:]


def _qpsk_llrs(coeffs):
    """Per-diff, per-tone bit LLRs for 2-bit (QPSK) tones.
    Returns (ndiff, ntones, 2): [..., 0] = high bit, [..., 1] =
    low bit of the Gray value. kappa per tone from the
    coefficient magnitude relative to the symbol's median
    magnitude — a within-burst reliability proxy (documented
    heuristic, shared by the mini-header and Mode C)."""
    phases = np.angle(coeffs)
    dphi = np.angle(np.exp(1j * (phases[1:] - phases[:-1])))
    mags = np.abs(coeffs[1:])
    med = np.median(mags, axis=1, keepdims=True) + 1e-12
    kappa = np.clip(2.0 * mags / med, 0.25, 12.0)
    centers = np.array([0.0, np.pi / 2, np.pi, 3 * np.pi / 2])
    val_of_step = np.array([0, 1, 3, 2])    # step -> Gray value (w=2)
    ll = kappa[:, :, None] * np.cos(dphi[:, :, None] - centers[None, None, :])
    ll = ll - ll.max(axis=2, keepdims=True)
    p = np.exp(ll)
    out = np.empty((len(dphi), coeffs.shape[1], 2))
    for b in range(2):
        shift = 1 - b                       # bit0 = high bit (v>>1)
        mask1 = ((val_of_step >> shift) & 1) == 1
        s1 = p[:, :, mask1].sum(axis=2)
        s0 = p[:, :, ~mask1].sum(axis=2)
        out[:, :, b] = np.log((s1 + 1e-12) / (s0 + 1e-12))
    return out


def _llrs_to_chan(llrs, cfg: Cfg, pre_rows: int, coded_len: int):
    """Assemble channel LLRs in stream order from _qpsk_llrs
    output: drops preamble diffs, flattens tone-major."""
    data = llrs[pre_rows - 1:]
    bits_llr = np.empty((len(data), cfg.bits_per_sym))
    off = 0
    for j, w in enumerate(cfg.bits):
        bits_llr[:, off:off + w] = data[:, j, :w]
        off += w
    return bits_llr.reshape(-1)[:coded_len]


def _pre_rows(cfg: Cfg, style: str, n: int):
    if style == "pattern":
        return _preamble_phases(cfg)
    k = np.arange(cfg.ntones)
    phi = ((5 * k) % 8) * (np.pi / 4)
    return np.tile(phi, (n, 1))


def _synth_steps(steps, cfg: Cfg, guard: int, pre_style, pre_n, win, E):
    """steps: (nsym, ntones) Gray step indices per data symbol.
    Synthesizes preamble + differentially encoded data into
    slots of cfg.sym + guard samples, peak-normalized to 0.85."""
    pre = _pre_rows(cfg, pre_style, pre_n)
    dphi = steps * (2 * np.pi / (1 << np.array(cfg.bits)))[None, :]
    phases = np.vstack([pre, pre[-1:] + np.cumsum(dphi, axis=0)])
    coeffs = cfg.gains * np.exp(1j * phases)
    sig = np.real(coeffs @ E.T) * win[None, :]
    slot = cfg.sym + guard
    audio = np.zeros(len(phases) * slot)
    for i in range(len(phases)):
        audio[i * slot:i * slot + cfg.sym] = sig[i]
    peak = np.max(np.abs(audio))
    return audio * (0.85 / peak) if peak > 0 else audio


def _steps_from_bits(bits, cfg: Cfg):
    """Pack a bit array into (nsym, ntones) Gray step indices,
    tone-major per symbol, MSB-first per tone."""
    bps = cfg.bits_per_sym
    pad = (-len(bits)) % bps
    if pad:
        bits = np.concatenate([bits, np.zeros(pad, dtype=np.uint8)])
    symbits = bits.reshape(-1, bps)
    steps = np.empty((len(symbits), cfg.ntones), dtype=int)
    off = 0
    for j, w in enumerate(cfg.bits):
        g, _ = _gray_tables(w)
        col = symbits[:, off:off + w]
        v = np.zeros(len(symbits), dtype=int)
        for i in range(w):
            v = (v << 1) | col[:, i].astype(int)
        steps[:, j] = [g[x] for x in v]
        off += w
    return steps


def _modulate_g(stream: bytes, cfg: Cfg, guard: int, pre_style="pattern",
                pre_n=PREAMBLE):
    """Differential modulation of a byte stream with a guard
    interval (pattern preamble of pre_n symbols)."""
    win, E, _, _ = cfg.basis()
    bits = np.unpackbits(np.frombuffer(stream, dtype=np.uint8))
    steps = _steps_from_bits(bits, cfg)
    return _synth_steps(steps, cfg, guard, pre_style, pre_n, win, E)


def _modulate_bits_g(bits, cfg: Cfg, guard: int, pre_n=PREAMBLE):
    """As _modulate_g but the input is a raw bit array (the
    convolutional-coded stream is not byte-aligned)."""
    win, E, _, _ = cfg.basis()
    steps = _steps_from_bits(np.asarray(bits, dtype=np.uint8), cfg)
    return _synth_steps(steps, cfg, guard, "pattern", pre_n, win, E)


# ------------------------------------------------- framing (one RS layer)
# Rev 8.2: shortened, evenly split RS blocks. The framed body
# (stored bytes + CRC-32) is cut into nb = ceil(len / blk_data)
# equal blocks of k = ceil(len / nb) data bytes (the last one
# zero-padded to k INSIDE the codeword and the padding is part of the
# codeword — only k + nsym bytes per block are transmitted). 8.1 always
# sent full 255-byte blocks, so an 80-byte message paid for ~250.
HDR_DATA, HDR_NSYM = 9, 16                 # header RS(25,9)
HDR_LEN = HDR_DATA + HDR_NSYM
CHUNK = 400
STRIDE = CHUNK + HDR_LEN
FLAG_COMPRESSED = 0x01
MAX_STORED = 1 << 20                       # sanity cap on a stored length


def _rs_plan(slen: int, blk_data: int):
    """(nb, k): block count and per-block data length for a stored
    length of slen bytes (+4 CRC-32 bytes)."""
    total = slen + 4
    nb = -(-total // blk_data)
    return nb, -(-total // nb)


def _rs_stream_len(slen: int, blk_data: int, blk_nsym: int) -> int:
    """Bytes in the framed RS stream (blocks + repeated headers)."""
    nb, k = _rs_plan(slen, blk_data)
    body = nb * (k + blk_nsym)
    return body + HDR_LEN * (-(-body // CHUNK))


def _frame_rs(stored: bytes, flags: int, blk_data: int,
              blk_nsym: int) -> bytes:
    """Framing: CRC-32 over the stored bytes, shortened RS blocks,
    byte interleaving across blocks, and an RS(25,9) header (magic
    'N8', stored length, block count, flags) repeated before every
    CHUNK of the interleaved stream."""
    crc = zlib.crc32(stored) & 0xFFFFFFFF
    body = stored + struct.pack(">I", crc)
    nb, k = _rs_plan(len(stored), blk_data)
    body = body + b"\x00" * (nb * k - len(body))
    blocks = [rs_encode(body[i * k:(i + 1) * k], blk_nsym)
              for i in range(nb)]
    stream = bytearray()
    for i in range(k + blk_nsym):
        for b in range(nb):
            stream.append(blocks[b][i])
    hdr = (b"N8" + struct.pack(">I", len(stored)) + struct.pack(">H", nb)
           + bytes([flags]))
    hdr_enc = rs_encode(hdr, HDR_NSYM)
    out = bytearray()
    for i in range(0, len(stream), CHUNK):
        out += hdr_enc
        out += stream[i:i + CHUNK]
    return bytes(out)


def _read_header_rs(stream: bytes, off: int, blk_data: int):
    try:
        cand = rs_decode(stream[off:off + HDR_LEN], HDR_NSYM)
    except Exception:
        return None
    if len(cand) == HDR_DATA and cand[:2] == b"N8":
        slen = struct.unpack(">I", cand[2:6])[0]
        nb = struct.unpack(">H", cand[6:8])[0]
        flags = cand[8]
        if slen < MAX_STORED and flags & ~FLAG_COMPRESSED == 0 and \
                nb == _rs_plan(slen, blk_data)[0]:
            return slen, nb, flags
    return None


def _unframe_rs(stream: bytes, blk_data: int, blk_nsym: int,
                expect_slen: int = None):
    hdr = None
    for off in range(0, max(1, len(stream) - HDR_LEN), STRIDE):
        hdr = _read_header_rs(stream, off, blk_data)
        if hdr is not None:
            break
    if hdr is None:
        raise ValueError("payload header unrecoverable")
    slen, nb, flags = hdr
    if expect_slen is not None and slen != expect_slen:
        raise ValueError("payload header disagrees with the mini-header")
    _, k = _rs_plan(slen, blk_data)
    n = k + blk_nsym
    data = bytearray()
    pos = 0
    while pos + HDR_LEN <= len(stream) and len(data) < nb * n:
        pos += HDR_LEN
        data += stream[pos:pos + CHUNK]
        pos += CHUNK
    data = bytes(data[:nb * n])
    if len(data) < nb * n:
        raise ValueError("payload stream truncated")
    blocks = [bytearray(n) for _ in range(nb)]
    idx = 0
    for i in range(n):
        for b in range(nb):
            blocks[b][i] = data[idx]
            idx += 1
    body = bytearray()
    for blk in blocks:
        body.extend(rs_decode(bytes(blk), blk_nsym))
    stored = bytes(body[:slen])
    crc_stored = struct.unpack(">I", bytes(body[slen:slen + 4]))[0]
    if (zlib.crc32(stored) & 0xFFFFFFFF) != crc_stored:
        raise ValueError("CRC-32 mismatch after RS decode")
    if any(body[slen + 4:]):
        raise ValueError("non-zero block padding after RS decode")
    return stored, flags


def _stored_of(chunk: bytes):
    """The compression rule: zlib-9 stored only if
    smaller. Returns (stored, flags). Deterministic — the
    decoder recomputes section lengths from decoded chunks.
    Compression is per segment and resets with the mode: a
    zlib stream never spans segments or modes."""
    comp = zlib.compress(chunk, 9)
    if len(comp) < len(chunk):
        return comp, FLAG_COMPRESSED
    return chunk, 0


def _unstored_of(stored: bytes, flags: int) -> bytes:
    if flags & FLAG_COMPRESSED:
        return zlib.decompress(stored)
    return stored


# ------------------------------------------------- section codec (pipeline)
def _conv_info(chunk: bytes) -> bytes:
    """Mode C's coded unit: flags byte + stored bytes + CRC-32."""
    stored, flags = _stored_of(chunk)
    info = bytes([flags]) + stored
    return info + struct.pack(">I", zlib.crc32(info) & 0xFFFFFFFF)


def _seg_stored_len(mc: ModeCfg, chunk: bytes) -> int:
    """The length the mini-header reports for this segment: the
    exact number of stored bytes the section carries (rev 8.2 — in
    8.1 RS modes reported the raw chunk length). Both section kinds
    are therefore bounded: the receiver knows the section's exact
    length in samples from the mini-header alone."""
    if mc.code == "conv":
        return len(_conv_info(chunk))
    return len(_stored_of(chunk)[0])


def _section_nbits(mc: ModeCfg, seglen: int) -> int:
    """Channel bits in a section carrying `seglen` stored bytes."""
    if mc.code == "rs":
        return 8 * _rs_stream_len(seglen, mc.rs_data, mc.rs_nsym)
    return len(CODE_GENS) * (seglen * 8 + 6)


def _encode_section(mc: ModeCfg, chunk: bytes, mask, sub_cfg=None
                    ) -> np.ndarray:
    cfg = sub_cfg if sub_cfg is not None else _sel_cfg(mc, mask)[0]
    if mc.code == "rs":
        stored, flags = _stored_of(chunk)
        stream = _frame_rs(stored, flags, mc.rs_data, mc.rs_nsym)
        return _modulate_g(stream, cfg, mc.guard)
    info = _conv_info(chunk)
    bits = np.unpackbits(np.frombuffer(info, dtype=np.uint8))
    coded = conv_encode(bits, CODE_GENS)
    coded = _permute(coded, _data_perm_P(len(coded)))
    return _modulate_bits_g(coded, cfg, mc.guard)


def _decode_section(mc: ModeCfg, samples, start: int, seglen: int,
                    mask, chan=None) -> bytes:
    """chan (duplex) = (full_cfg, col_idx, sub_cfg): projection
    is onto the FULL tone set, columns sliced afterwards."""
    if chan is not None:
        proj, col_idx, cfg = chan
    else:
        cfg = _sel_cfg(mc, mask)[0]
        proj, col_idx = cfg, None
    nbits = _section_nbits(mc, seglen)
    ndata = -(-nbits // cfg.bits_per_sym)
    if mc.code == "rs":
        coeffs = _slots_coeffs(samples, proj, mc.guard, start,
                               PREAMBLE + ndata)
        if col_idx is not None:
            coeffs = coeffs[:, list(col_idx)]
        vals = _values_from_coeffs(coeffs, cfg, PREAMBLE)
        stream = _values_to_stream(vals, cfg)
        stored, flags = _unframe_rs(stream, mc.rs_data, mc.rs_nsym, seglen)
        return _unstored_of(stored, flags)
    coded_len = nbits
    coeffs = _slots_coeffs(samples, proj, mc.guard, start,
                           PREAMBLE + ndata + 2)
    if col_idx is not None:
        coeffs = coeffs[:, list(col_idx)]
    llrs = _qpsk_llrs(coeffs)
    chan_llr = _llrs_to_chan(llrs, cfg, PREAMBLE, coded_len)
    if len(chan_llr) < coded_len:
        raise ValueError("segment truncated")
    coded = _unpermute(chan_llr, _data_perm_P(coded_len))
    info = np.packbits(viterbi_decode(coded, seglen * 8,
                                      CODE_GENS)).tobytes()
    body, crc_b = info[:-4], info[-4:]
    if struct.unpack(">I", crc_b)[0] != (zlib.crc32(body) & 0xFFFFFFFF):
        raise ValueError("CRC-32 mismatch after Viterbi decode")
    return _unstored_of(body[1:], body[0])


ALIGN_SYMS = 64                    # data symbols the alignment metric uses
ALIGN_RADIUS = 8                   # per-section timing search, samples


def _align_error(mc: ModeCfg, samples, start: int, mask, chan=None) -> float:
    """Timing-alignment metric for a section start: the mean squared
    distance of the measured differential phases to their nearest
    constellation points over the section's first ALIGN_SYMS data
    symbols. It has a sharp minimum at the true alignment (measured:
    Mode A's decode plateau is only ~+-3 samples wide, 8.2 SPEC s13)
    and needs no decode, so it also serves as the per-section
    re-alignment that tracks clock drift."""
    if chan is not None:
        proj, col_idx, cfg = chan
    else:
        cfg = _sel_cfg(mc, mask)[0]
        proj, col_idx = cfg, None
    co = _slots_coeffs(samples, proj, mc.guard, start,
                       PREAMBLE + ALIGN_SYMS)
    if col_idx is not None:
        co = co[:, list(col_idx)]
    if len(co) < 3:
        return float("inf")
    ph = np.angle(co)
    dp = np.angle(np.exp(1j * (ph[1:] - ph[:-1])))
    step = 2 * np.pi / (2.0 ** np.array(cfg.bits))
    err = dp - np.round(dp / step[None, :]) * step[None, :]
    return float(np.mean(err ** 2))


def _align_offset(mc: ModeCfg, samples, start: int, mask, chan=None,
                  radius: int = ALIGN_RADIUS) -> int:
    """Best timing correction in [-radius, radius] for a section that
    should start at `start` (ties go to the smallest correction)."""
    best, best_d = None, 0
    for d in sorted(range(-radius, radius + 1), key=abs):
        if start + d < 0:
            continue
        e = _align_error(mc, samples, start + d, mask, chan)
        if best is None or e < best - 1e-12:
            best, best_d = e, d
    return best_d


def _section_samples(mc: ModeCfg, seglen: int, mask, chan=None) -> int:
    """Exact section length in samples. In duplex the section
    was encoded on the direction's sub-grid (fewer bits per
    symbol -> more symbols), so bits/symbol comes from the
    channel's sub-config, not the full session grid — using
    the full grid here lands the next segment's mini-header
    early (found the hard way: duplex B, segment 1)."""
    bps = chan[2].bits_per_sym if chan is not None \
        else _sel_cfg(mc, mask)[0].bits_per_sym
    nsyms = PREAMBLE + -(-_section_nbits(mc, seglen) // bps)
    return nsyms * (mc.active + mc.guard)


# ------------------------------------------------------------ mini-header
# A separate seam: these functions know the mini-header's byte
# layout and its own pentatonic physical layer, nothing about
# the payload pipeline's internals.
# Wire-format revision marker (rev 8.2). Byte 2 of every mini-header,
# after the magic 'N8'. A clean-slate break: 8.0/8.1 carried 8 here.
# Future incompatible revisions MUST change this byte and keep the
# magic/revision/CRC placement, so that a receiver can name the mismatch
# instead of mis-decoding (see RevisionError).
WIRE_REV = 0x82
MINI_INFO = 31                     # fixed for all modes/segments
MINI_GENS = CODE_GENS        # rate-1/3 convolutional codec
MINI_CODED_BITS = len(MINI_GENS) * (MINI_INFO * 8 + 6)     # 762
FLAG_FINAL = 0x01                  # set on the last segment only
FLAG_TOKEN = 0x02                  # house token field is present
# flags bits 2-3: NEXT-SPEAKER (0=unspecified/contention, 1-3 houses)
MINI_SYM, MINI_GUARD = 960, 240    # 20 ms active + 5 ms guard
MINI_PRE = 3
_mini_cfg = Cfg("mini", PENTA, PENTA_GAINS, MINI_SYM, bits=[2] * 20)


def _mini_len(cfg=_mini_cfg) -> int:
    data_syms = -(-MINI_CODED_BITS // cfg.bits_per_sym)
    return (MINI_PRE + data_syms) * (MINI_SYM + MINI_GUARD)


MINI_LEN = _mini_len()             # 27600 samples = 0.575 s (simplex)


def _mask_bytes(mask) -> bytes:
    out = bytearray(10)
    for i, m in enumerate(mask):
        if m:
            out[i // 8] |= 1 << (7 - i % 8)
    return bytes(out)


def _mask_from_bytes(mode: str, raw: bytes):
    n = {"A": 39, "B": 77, "C": 39}[mode]
    return [1 if (raw[i // 8] >> (7 - i % 8)) & 1 else 0 for i in range(n)]


def _hmac_digest(session: int, payload_crc32: int, secret: bytes) -> bytes:
    return hmac.new(secret,
                    struct.pack(">H", session)
                    + struct.pack(">I", payload_crc32),
                    hashlib.sha256).digest()


def house_token(session: int, payload_crc32: int, secret: bytes) -> bytes:
    """Truncated HMAC binding a burst to a house holding the
    shared secret: HMAC-SHA256(key=secret, msg=session_id_be16
    || payload_crc32_be32)[0:6]. Authentication of origin only
    — anyone with the spec can decode the clip; only a
    secret-holder can produce a token that verifies. The
    secret is never in the spec or the clip; it is exchanged
    out of band. The session ID is a never-intentionally-
    repeated random nonce; receivers keep a seen-session log
    per house as the replay mitigation (verbatim replay stays
    a known residual risk — see the spec)."""
    return _hmac_digest(session, payload_crc32, secret)[:6]


def check_phrase(session: int, payload_crc32: int, secret: bytes,
                 digits: int = 4) -> str:
    """Human-verifiable freshness phrase (payload convention,
    not a PHY field): decimal digits derived from the same
    HMAC — bytes 6..13 of the digest as a big-endian integer,
    modulo 10^digits, zero-padded. Spoken or typed at the
    start of the payload text so a human listener can check
    freshness against the receiving house's own computation."""
    d = _hmac_digest(session, payload_crc32, secret)
    n = int.from_bytes(d[6:14], "big") % (10 ** digits)
    return str(n).zfill(digits)


def _mini_info_bytes(mode: str, session: int, idx: int, total: int,
                     seglen: int, mask, final: bool = False,
                     token: bytes = None, next_speaker: int = 0) -> bytes:
    flags = (FLAG_FINAL if final else 0) | (FLAG_TOKEN if token else 0) \
        | ((next_speaker & 0x03) << 2)
    raw = bytearray()
    raw += b"N8"
    raw += bytes([WIRE_REV])
    raw += bytes([{"A": 0, "B": 1, "C": 2}[mode]])
    raw += struct.pack(">H", session)
    raw += bytes([idx, total])
    raw += bytes([flags])
    raw += struct.pack(">I", seglen)
    raw += _mask_bytes(mask)
    raw += token if token else b"\x00" * 6
    raw = bytes(raw)
    assert len(raw) == MINI_INFO - 2, len(raw)
    return raw + struct.pack(">H", _crc16(raw))


def _mini_parse(raw: bytes):
    if len(raw) != MINI_INFO or raw[:2] != b"N8":
        return None
    if struct.unpack(">H", raw[29:31])[0] != _crc16(raw[:29]):
        return None
    if raw[2] != WIRE_REV:
        # the magic and CRC-16 both passed, so this is a genuine header
        # of another revision: say so, never mis-decode, never shrug.
        raise RevisionError(raw[2])
    mode = {0: "A", 1: "B", 2: "C"}.get(raw[3])
    if mode is None:
        return None
    seglen = struct.unpack(">I", raw[9:13])[0]
    if seglen >= MAX_STORED:
        return None
    if raw[7] == 0 or raw[6] >= raw[7]:
        return None            # impossible segment index/count
    flags = raw[8]
    if flags & 0xF0 or (flags & FLAG_TOKEN) == 0 and any(raw[23:29]):
        return None            # reserved flag bits / stray token bytes
    return {"mode": mode, "version": raw[2], "wire_rev": raw[2],
            "session": struct.unpack(">H", raw[4:6])[0],
            "index": raw[6], "total": raw[7], "seglen": seglen,
            "flags": flags, "final": bool(flags & FLAG_FINAL),
            "next_speaker": (flags >> 2) & 0x03,
            "token": raw[23:29] if flags & FLAG_TOKEN else None,
            "mask": _mask_from_bytes(mode, raw[13:23])}


def _mini_encode(mode: str, session: int, idx: int, total: int,
                 seglen: int, mask, cfg=_mini_cfg, final: bool = False,
                 token: bytes = None, next_speaker: int = 0) -> np.ndarray:
    info = _mini_info_bytes(mode, session, idx, total, seglen, mask,
                            final=final, token=token,
                            next_speaker=next_speaker)
    bits = np.unpackbits(np.frombuffer(info, dtype=np.uint8))
    coded = conv_encode(bits, MINI_GENS)
    coded = _permute(coded, _data_perm_P(len(coded)))
    win, E, _, _ = cfg.basis()
    steps = _steps_from_bits(coded, cfg)
    return _synth_steps(steps, cfg, MINI_GUARD, "flat", MINI_PRE, win, E)


def _mini_decode_scored(samples, start: int, cfg=_mini_cfg, full_cfg=None,
                        col_idx=None):
    """Returns (parsed mini-header dict or None, soft score).
    The soft score is the mean |LLR| of the mini's coded bits.
    With full_cfg/col_idx (duplex), projection is onto the
    FULL tone set and this direction's columns are sliced
    afterwards — a subset-only projection cannot span the
    other direction's tones."""
    data_syms = -(-MINI_CODED_BITS // cfg.bits_per_sym)
    proj_cfg = full_cfg if full_cfg is not None else cfg
    coeffs = _slots_coeffs(samples, proj_cfg, MINI_GUARD, start,
                           MINI_PRE + data_syms)
    if len(coeffs) < MINI_PRE + data_syms:
        return None, 0.0
    if col_idx is not None:
        coeffs = coeffs[:, list(col_idx)]
    llrs = _qpsk_llrs(coeffs)
    chan = _llrs_to_chan(llrs, cfg, MINI_PRE, MINI_CODED_BITS)
    score = float(np.mean(np.abs(chan))) if len(chan) else 0.0
    coded = _unpermute(chan, _data_perm_P(MINI_CODED_BITS))
    info = viterbi_decode(coded, MINI_INFO * 8, MINI_GENS)
    return _mini_parse(np.packbits(info).tobytes()), score


def _mini_decode(samples, start: int, cfg=_mini_cfg, full_cfg=None,
                 col_idx=None):
    """Returns the parsed mini-header dict, or None (CRC-gated)."""
    parsed, _ = _mini_decode_scored(samples, start, cfg, full_cfg, col_idx)
    return parsed


# ------------------------------------------------------------ analysis
# One pure function of a samples array: used identically by
# the sender-side API and by every test.
def _tone_feats(snr_db, rel_gain):
    s = np.asarray(snr_db, dtype=float)
    g = np.asarray(rel_gain, dtype=float)
    ok = ~np.isnan(s)
    s, g = s[ok], g[ok]
    if s.size == 0:
        # No usable tone (degenerate recording): clearly degenerate
        # figures, which can never clear a threshold.
        return {k: float("nan") for k in (
            "median_snr_db", "p10_snr_db", "min_rel_gain",
            "frac_below_6db", "frac_below_0db")}
    return {
        "median_snr_db": float(np.median(s)),
        "p10_snr_db": float(np.percentile(s, 10)),
        "min_rel_gain": float(np.min(g)),
        "frac_below_6db": float(np.mean(s < 6.0)),
        "frac_below_0db": float(np.mean(s < 0.0)),
    }


def _phase_feats(coeffs, phases, idx):
    z = coeffs[:, idx] * np.exp(-1j * phases[:, idx])
    H = z.mean(axis=0)
    resid = (np.abs(z - H[None, :]) ** 2).mean(axis=0)
    gain = np.abs(H)
    snr = gain ** 2 / np.maximum(resid, 1e-15)
    snr_db = 10 * np.log10(np.maximum(snr, 1e-12))
    rel = gain / (np.median(gain) + 1e-15)
    return snr_db, rel


def _analyze_at(samples, start: int, idx1=None, idx2=None):
    """Per-tone channel estimates from the sounding at `start`.
    idx1/idx2: GRID100 / GRID200 indices this sounding carries
    (duplex halves); default all."""
    if idx1 is None:
        idx1 = list(range(77))
    if idx2 is None:
        idx2 = list(range(39))
    c1 = _slots_coeffs(samples, _snd1_cfg, 0, start, SND1_N)
    if len(c1) < SND1_N:
        raise ValueError("recording too short for a sounding")
    phi1 = _snd1_phases()
    s1, g1 = _phase_feats(c1, phi1, idx1)
    full_snr = np.full(77, np.nan)
    full_gain = np.full(77, np.nan)
    full_snr[idx1] = s1
    full_gain[idx1] = g1
    c2 = _slots_coeffs(samples, _snd2_cfg, SND2_GRD, start + SND1_LEN, SND2_N)
    phi2 = _snd2_phases()
    if len(c2) < SND2_N:
        raise ValueError("recording too short for sounding phase 2")
    s2, g2 = _phase_feats(c2, phi2, idx2)
    c_snr = np.full(39, np.nan)
    c_gain = np.full(39, np.nan)
    c_snr[idx2] = s2
    c_gain[idx2] = g2
    ana = {
        "snr_db": full_snr, "rel_gain": full_gain,
        "c_snr_db": c_snr, "c_rel_gain": c_gain,
        "A": _tone_feats(full_snr[A_TONE_IDX], full_gain[A_TONE_IDX]),
        "B": _tone_feats(full_snr, full_gain),
        "C": _tone_feats(c_snr, c_gain),
    }
    ana["recommendation"] = recommend_mode(ana)
    return ana


# Mode-selection thresholds on the 10th-percentile per-tone
# sounding SINR. These are EFFECTIVE thresholds: break points plus a
# 3 dB safety margin (see spec §5).
# Rev 8.2 re-based A's and B's thresholds on the orthogonal detector
# and the louder low-crest sounding: in flat white noise the sounding's
# p10 reads about (burst SNR + 8) dB, and the whole-burst break points
# measured 11 dB (A) and 7.5 dB (B) SNR (SPEC §14), i.e. readings of
# ~19 and ~15.5; plus 3 dB: A = 22, B = 18. C is carried over from 8.1
# UNCHANGED (5): it is the last resort before USE_NDAP6, its AWGN break
# is ~-2 dB SNR (reading ~8), so 5 is lenient rather than margined.
# CALIBRATION CAVEAT: AWGN only. The 8.1 room-channel readings behind
# the old values (A=16, B=-12, C=5) are not in the tree and were not
# re-measured, so the selector's behaviour in echoey rooms is open work
# (CHANGELOG 8.2.0). The direction of the change is the safe one: B is
# no longer recommended in noise where it measurably fails.
THR_P10 = {"A": 22.0, "B": 18.0, "C": 5.0}


def recommend_mode(ana) -> str:
    """Fastest mode whose p10 per-tone sounding SINR clears its
    threshold (thresholds include the 3 dB design-review margin)."""
    if ana["A"]["p10_snr_db"] >= THR_P10["A"]:
        return "A"
    if ana["B"]["p10_snr_db"] >= THR_P10["B"]:
        return "B"
    if ana["C"]["p10_snr_db"] >= THR_P10["C"]:
        return "C"
    return "USE_NDAP6"


def mask_from_analysis(ana, mode: str):
    """Per-tone selection for modes B/C: exclude tones whose
    sounding SINR is under the floor or whose relative gain
    shows a deep fade, but never more than 40% of the set. (8.1's
    "impaired B caps at 47 tones" rule is gone: it compensated for the
    ill-conditioned 8.1 detector — 77-tone B now passes flat 18 dB
    noise 3/3.) Mode A takes every tone; a sender that KNOWS its channel
    is band-limited may still pass its own mask to the encoder."""
    if mode == "A":
        return [1] * 39
    if mode == "B":
        snr, gain, floor = ana["snr_db"], ana["rel_gain"], 2.0
    else:
        snr, gain, floor = ana["c_snr_db"], ana["c_rel_gain"], 0.0
    n = len(snr)
    bad = (snr < floor) | (gain < 0.25)
    max_bad = int(0.40 * n)
    if bad.sum() > max_bad:
        score = snr + 20 * np.log10(np.maximum(gain, 1e-3))
        order = np.argsort(score)
        keep = np.zeros(n, dtype=bool)
        keep[order[-int(math.ceil(0.60 * n)):]] = True
        bad = ~keep
    return [0 if b else 1 for b in bad]


def _degenerate_analysis() -> dict:
    """Analysis for a recording that cannot contain a sounding
    (empty, too short, silent garbage): NaN figures, and the
    honest recommendation — USE_NDAP6."""
    nan = float("nan")
    feats = _tone_feats([], [])
    return {
        "snr_db": np.full(77, nan), "rel_gain": np.full(77, nan),
        "c_snr_db": np.full(39, nan), "c_rel_gain": np.full(39, nan),
        "A": dict(feats), "B": dict(feats), "C": dict(feats),
        "recommendation": "USE_NDAP6", "degenerate": True,
    }


def analyze_channel(samples) -> dict:
    """Locate the sounding in a recording and analyze it. A
    recording that cannot hold a sounding (empty, too short,
    unusable) yields a degenerate analysis recommending
    USE_NDAP6 rather than an exception."""
    try:
        off = _find_sounding_offset(samples)
        return _analyze_at(samples, off)
    except (ValueError, IndexError):
        return _degenerate_analysis()


# ------------------------------------------------------------ finder
def _find_sounding_offset(samples, idx1=None) -> int:
    """Start of the sounding in a recording: the strongest normalized
    cross-correlation peak against the known sounding. Needs no mini-
    header after it (the analysis path works on a sounding-only
    recording). Raises ValueError when no peak clears the noise floor
    — analyze_channel turns that into the degenerate USE_NDAP6
    analysis. (idx1 is accepted for the duplex call sites; a duplex
    mix of both halves IS the full sounding, so the full template
    applies.)"""
    peaks = _ncc_peaks(samples, 1, tail=0)
    if not peaks:
        raise ValueError("no sounding found in the recording")
    return peaks[0][1]


def _seg0_check(x, sec_start: int, mini, chan=None) -> bool:
    """Does segment 0 decode (full RS/Viterbi + CRC) at this
    section start? The framed stream's first HEADER copy is
    NOT a sufficient check — its RS(25,9) tolerance plateau is
    ~+-96 samples wide, far wider than the payload body's
    ~+16 (measured); only the full segment decode measures the
    alignment the chain actually needs."""
    try:
        _decode_section(MODES[mini["mode"]], x, sec_start,
                        mini["seglen"], mini["mask"], chan)
        return True
    except Exception:
        return False


def _unguarded(mini) -> bool:
    return MODES[mini["mode"]].guard == 0


def _refine_start_checked(x, off: int, mini, mini_cfg, full_cfg=None,
                          col_idx=None, chan=None):
    """Refine a burst start against segment 0's own full
    decode. The sounding-correlation peak is blunt under babble
    and the mini soft score peaks at wrong offsets (measured on
    a living-room draw: both preferred +24 samples, where the
    payload's RS failed, over the exact start, where it
    passed). So: scan +-64 samples, keep the offsets where
    segment 0 fully decodes, and take the plateau centre. A
    constant start error persists through the whole segment
    chain, so this one refinement serves every segment.
    Returns (start, mini, verified): verified is True when
    segment 0's payload fully decoded somewhere in the scan."""
    mini_len = _mini_len(mini_cfg)
    good = []
    # Mode A's timing plateau is only ~+-5 samples wide (5 ms symbols,
    # no guard, 8-PSK; measured 8.2), so it is scanned in steps of 4;
    # the guarded modes' plateaus are >= +-60 samples, steps of 16.
    step = MODES[mini["mode"]].scan_step
    for delta in range(-64, 65, step):
        cand = off + delta
        if cand < 0:
            continue
        if _seg0_check(x, cand + SND_LEN + mini_len, mini, chan):
            good.append(delta)
    if not good:
        return off, mini, False
    delta = good[len(good) // 2]
    if _unguarded(mini):
        # unguarded mode (A): the plateau is only a few samples wide, so
        # its centre is a coarse guess — take the alignment metric's
        # minimum around it, provided segment 0 still decodes there.
        sec0 = off + delta + SND_LEN + mini_len
        d2 = _align_offset(MODES[mini["mode"]], x, sec0, mini["mask"], chan)
        if d2 and _seg0_check(x, sec0 + d2, mini, chan):
            delta += d2
    if delta == 0:
        return off, mini, True
    m2 = _mini_decode(x, off + delta + SND_LEN, mini_cfg, full_cfg,
                      col_idx)
    if m2 is None or m2["index"] != 0:
        return off, mini, True
    return off + delta, m2, True


def _refine_start(x, off: int, mini, mini_cfg, full_cfg=None,
                  col_idx=None, chan=None):
    """(start, mini) — see _refine_start_checked."""
    return _refine_start_checked(x, off, mini, mini_cfg, full_cfg,
                                 col_idx, chan)[:2]


# --- correlation acquisition (NDAP-8 rev 8.1; the idea — sync by
# normalized cross-correlation with an offset retry ladder — is
# credited to NDAP-8-P's receiver; this version correlates against
# the sounding NDAP-8 transmits — rev 8.2's low-crest chirp-sign
# sounding, whose sharp unambiguous peak is exact to the sample in
# clean and moderately noisy recordings).
ACQ_PEAKS = 6                      # correlation peaks tried, best first
ACQ_LADDER = (0, -8, 8, -16, 16, -32, 32, -64, 64, -128, 128, -240, 240)
ACQ_MIN_NCC = 0.02                 # below this a "peak" is just noise
_SND_REF = None


def _snd_reference():
    """The known sounding waveform, zero-mean and unit-norm (the
    template for the normalized cross-correlation)."""
    global _SND_REF
    if _SND_REF is None:
        r = _sounding_audio()
        r = r - np.mean(r)
        _SND_REF = r / np.linalg.norm(r)
    return _SND_REF


def _ncc_peaks(samples, n_peaks=ACQ_PEAKS, tail=None):
    """Normalized cross-correlation of the recording against the
    sounding template: ncc[k] = <x[k:k+L], ref> / ||x[k:k+L]||
    (the window mean is removed analytically). Returns up to
    n_peaks (ncc, offset) pairs, strongest first, at least one
    sounding-length apart."""
    x = np.asarray(samples, dtype=float)
    ref = _snd_reference()
    L = len(ref)
    tail = MINI_LEN if tail is None else tail
    if len(x) < L + tail:
        return []
    n = 1 << int(np.ceil(np.log2(len(x) + L)))
    c = np.fft.irfft(np.fft.rfft(x, n) * np.conj(np.fft.rfft(ref, n)), n)
    c = c[:len(x) - L + 1]
    cs = np.concatenate([[0.0], np.cumsum(x)])
    cs2 = np.concatenate([[0.0], np.cumsum(x * x)])
    s1 = cs[L:] - cs[:-L]
    s2 = cs2[L:] - cs2[:-L]
    var = np.maximum(s2 - s1 * s1 / L, 1e-12)   # ||x_w - mean||^2
    ncc = c / np.sqrt(var)                       # ref has zero mean
    # a burst must leave room for its mini-header after the sounding
    last = len(x) - L - tail
    if last < 0:
        return []
    ncc = ncc[:last + 1]
    out = []
    order = np.argsort(ncc)[::-1]
    for k in order:
        if ncc[k] < ACQ_MIN_NCC or len(out) >= n_peaks:
            break
        if all(abs(int(k) - o) >= SND1_SYM for _, o in out):
            out.append((float(ncc[k]), int(k)))
    return out


def _find_burst_xcorr(samples, mini_cfg=_mini_cfg, full_cfg=None,
                      col_idx=None):
    """Primary acquisition: correlation peaks, each tried at the
    ladder of small offsets. A mini-header validating is necessary
    but not sufficient — it tolerates start errors of 100+ samples
    that the payload does not — so each validating offset is
    refined against segment 0's own payload decode, and the ladder
    continues past offsets whose refinement window (+-64) is
    already covered until one verifies. If none verifies (the
    payload is lost in noise), the first validating candidate is
    returned so the caller can still report per-segment results.
    Work is bounded: ACQ_PEAKS x len(ACQ_LADDER) mini-header
    decodes and at most five refinement scans per peak."""
    x = np.asarray(samples, dtype=float)
    fallback = None
    for _, peak in _ncc_peaks(x):
        scanned = []
        for d in ACQ_LADDER:
            off = peak + d
            if off < 0 or off + SND_LEN + _mini_len(mini_cfg) > len(x):
                continue
            if any(abs(off - o) <= 56 for o in scanned):
                continue             # inside an already-scanned window
            mini = _mini_decode(x, off + SND_LEN, mini_cfg, full_cfg,
                                col_idx)
            if mini is None or mini["index"] != 0:
                continue
            scanned.append(off)
            st, m2, verified = _refine_start_checked(
                x, off, mini, mini_cfg, full_cfg, col_idx)
            if verified:
                return st, m2
            if fallback is None:
                fallback = (st, m2)
    if fallback is not None:
        return fallback
    raise ValueError("no NDAP-8 burst found (correlation acquisition)")


def _find_burst(samples, mini_cfg=_mini_cfg, full_cfg=None, col_idx=None):
    """Returns (start, mini_dict) for segment 0 by correlation
    acquisition. A burst that cannot announce itself fails loudly
    (ValueError; RevisionError for a foreign wire revision)."""
    return _find_burst_xcorr(samples, mini_cfg, full_cfg, col_idx)


# ------------------------------------------------------------ segmentation
class RevisionError(ValueError):
    """A CRC-valid NDAP-8 header announcing a wire revision this
    decoder does not speak. Raised loudly by every decode entry point
    — never a silent failure and never a mis-decode. Carries .rev
    (the byte found) and .expected."""

    def __init__(self, rev, expected=None):
        expected = WIRE_REV if expected is None else expected
        super().__init__(
            f"NDAP-8 wire revision 0x{rev:02x} is not supported by this "
            f"decoder (speaks 0x{expected:02x}, rev 8.2): format mismatch")
        self.rev = rev
        self.expected = expected


class SegmentError(ValueError):
    """Raised by decode_adaptive when any segment fails. Carries
    .failed (segment indices), .ok (indices), .mode, .session."""

    def __init__(self, message, failed, ok, mode=None, session=None):
        super().__init__(message)
        self.failed = failed
        self.ok = ok
        self.mode = mode
        self.session = session


def _split_work(data: bytes, mc: ModeCfg):
    """work = data + CRC-32(data) trailer, split into raw chunks
    under the mode's per-segment cap."""
    work = data + struct.pack(">I", zlib.crc32(data) & 0xFFFFFFFF)
    cap = mc.seg_cap
    return [work[i:i + cap] for i in range(0, len(work), cap)]


def _resync_mini(x, from_off: int, session, want_idx, mini_cfg,
                 full_cfg=None, col_idx=None, span=4 * SR):
    """Bounded scan for the next valid mini-header after a
    chaining break. The mini validates at small time shifts as
    well as at the true offset, so the first validating hit is
    refined over +-360 samples and the best soft score wins.
    Returns (offset, mini) or None."""
    step = 120
    last = min(len(x) - _mini_len(mini_cfg), from_off + span)
    off = from_off
    while off <= last:
        mini = _mini_decode(x, off, mini_cfg, full_cfg, col_idx)
        if mini is not None and mini["index"] >= want_idx and \
                (session is None or mini["session"] == session):
            best_off, best_mini, best_sc = off, mini, -1.0
            for cand in range(max(0, off - 360), off + 361, 60):
                m2, sc = _mini_decode_scored(x, cand, mini_cfg,
                                             full_cfg, col_idx)
                if m2 is not None and m2["index"] == mini["index"] and \
                        m2["session"] == mini["session"] and sc > best_sc:
                    best_off, best_mini, best_sc = cand, m2, sc
            return best_off, best_mini
        off += step
    return None


def _walk_segments(x, start: int, mini0, mini_cfg=_mini_cfg,
                   full_cfg=None, col_idx=None, chan=None):
    """Decode the segment chain starting at `start` (sounding
    start), given segment 0's validated mini-header. Returns a
    report dict; never raises for segment-level failures."""
    mode = mini0["mode"]
    mc = MODES[mode]
    session = mini0["session"]
    total = mini0["total"]
    mask = mini0["mask"]
    token0 = mini0["token"]
    final_seen = False
    segments = []
    chunks = {}
    mini_len = _mini_len(mini_cfg)
    off = start + SND_LEN
    mini = mini0
    idx = 0
    while idx < total:
        if mini is None or mini["index"] != idx:
            found = _resync_mini(x, off, session, idx, mini_cfg,
                                 full_cfg, col_idx)
            if found is None:
                for j in range(idx, total):
                    segments.append({"index": j, "ok": False,
                                     "error": "mini-header not found"})
                break
            off, mini = found
            for j in range(idx, mini["index"]):
                segments.append({"index": j, "ok": False,
                                 "error": "skipped (resync)"})
            idx = mini["index"]
        if mini["session"] != session or mini["mode"] != mode or \
                mini["token"] != token0:
            for j in range(idx, total):
                segments.append({"index": j, "ok": False,
                                 "error": "session/mode/token changed "
                                          "mid-burst"})
            break
        if mini["index"] == total - 1 and mini["final"]:
            final_seen = True
        sec_start = off + mini_len
        if mc.guard == 0:
            # clock drift tracking (8.2): re-align each unguarded section
            sec_start += _align_offset(mc, x, sec_start, mask, chan)
        try:
            chunk = _decode_section(mc, x, sec_start, mini["seglen"],
                                    mask, chan)
            segments.append({"index": idx, "ok": True, "error": None})
            chunks[idx] = chunk
            off = sec_start + _section_samples(mc, mini["seglen"], mask,
                                               chan)
        except Exception as e:
            segments.append({"index": idx, "ok": False,
                             "error": f"{type(e).__name__}: {e}"})
            # rev 8.2: the section length is known from the validated
            # mini-header, so the chain survives a failed section — the
            # next mini-header is expected exactly after it (the resync
            # scan still covers a bad guess).
            off = sec_start + _section_samples(mc, mini["seglen"], mask,
                                               chan)
            idx += 1
            mini = _mini_decode(x, off, mini_cfg, full_cfg, col_idx) \
                if idx < total else None
            continue
        idx += 1
        if idx < total:
            nxt = _mini_decode(x, off, mini_cfg, full_cfg, col_idx)
            mini = nxt
    failed = [s["index"] for s in segments if not s["ok"]]
    ok = [s["index"] for s in segments if s["ok"]]
    rep = {"ok": False, "data": None, "mode": mode, "session": session,
           "segments": segments, "failed_segments": failed,
           "ok_segments": ok, "error": None,
           "version": mini0["version"],
           "next_speaker": mini0["next_speaker"],
           "final_seen": final_seen, "house_token": token0,
           "house_token_ok": None}
    if failed:
        rep["error"] = f"segments failed: {failed}"
        return rep
    work = b"".join(chunks[i] for i in range(total))
    data, trailer = work[:-4], work[-4:]
    if struct.unpack(">I", trailer)[0] != (zlib.crc32(data) & 0xFFFFFFFF):
        rep["error"] = "full-message CRC-32 mismatch"
        return rep
    rep["ok"] = True
    rep["data"] = data
    return rep


# ------------------------------------------------------------ public API
def encode_adaptive(data: bytes, mode: str, analysis=None,
                    session_id=None, house_secret: bytes = None,
                    next_speaker: int = 0, tone_mask=None) -> np.ndarray:
    """Encode `data` as a complete NDAP-8 burst at an explicit
    mode ('A'|'B'|'C'). `analysis` (from analyze_channel) drives
    the per-tone mask; without it all tones are used. `tone_mask`
    (rev 8.2, any mode) is an explicit 0/1 list over the mode's grid
    for a sender that knows its channel (e.g. band-limited); it wins
    over `analysis`."""
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}")
    mc = MODES[mode]
    if tone_mask is not None:
        mask = [1 if m else 0 for m in tone_mask]
        if len(mask) != len(mc.grid) or not any(mask):
            raise ValueError("tone_mask must cover the mode's grid and "
                             "keep at least one tone")
    elif analysis is not None:
        mask = mask_from_analysis(analysis, mode)
    else:
        mask = [1] * len(mc.grid)
    if session_id is None:
        session_id = int.from_bytes(os.urandom(2), "big")
    token = None
    if house_secret is not None:
        token = house_token(session_id, zlib.crc32(data) & 0xFFFFFFFF,
                            house_secret)
    chunks = _split_work(data, mc)
    parts = [_sounding_audio()]
    for i, chunk in enumerate(chunks):
        parts.append(_mini_encode(mode, session_id, i, len(chunks),
                                  _seg_stored_len(mc, chunk), mask,
                                  final=(i == len(chunks) - 1), token=token,
                                  next_speaker=next_speaker))
        parts.append(_encode_section(mc, chunk, mask))
    return np.concatenate(parts)


def encode_auto(data: bytes, sounding_samples):
    """Analyze a recorded sounding and encode at the
    recommended mode. Returns (audio, mode); at the floor it
    returns (None, 'USE_NDAP6') — the honest answer for a room
    NDAP-8 cannot serve."""
    ana = analyze_channel(sounding_samples)
    mode = ana["recommendation"]
    if mode == "USE_NDAP6":
        return None, mode
    return encode_adaptive(data, mode, analysis=ana), mode


def _decode_attempt(x, start, norm: bool):
    """One full decode try at a fixed start: validate segment 0's
    mini-header, walk the chain. norm: divide the slow envelope out
    (see _divide_envelope)."""
    tok = _ENV_NORM.set(norm)
    try:
        mini0 = _mini_decode(x, start + SND_LEN)
        if mini0 is None or mini0["index"] != 0:
            raise ValueError("mini-header unrecoverable at given start")
        rep = _walk_segments(x, start, mini0)
        rep["start"] = start
        rep["envelope_normalized"] = norm
        return rep
    finally:
        _ENV_NORM.reset(tok)


def decode_adaptive_report(samples, start=None,
                           house_secret: bytes = None) -> dict:
    """Full decode with a per-segment report. If house_secret is
    given and the burst carries a house token, the report's
    'house_token_ok' says whether the token verifies against
    the reassembled payload's CRC-32. Verification is reported,
    never required: a burst decodes identically with no secret,
    a wrong secret, or no token.

    Receiver flow (rev 8.2), every step CRC-gated, first full
    success wins: (1) correlation acquisition, raw samples;
    (2) the same start with the slow envelope divided out. If
    nothing fully decodes, the attempt with the most good segments
    is reported (ok=False) — never wrong bytes. A CRC-valid header of
    another wire revision raises RevisionError. The report adds
    'start', 'acquisition' ('xcorr' | 'given') and
    'envelope_normalized'."""
    x = np.asarray(samples, dtype=float)
    best, first_err = None, None
    st = start if start is not None else _find_burst(x)[0]
    for norm in (False, True):
        try:
            rep = _decode_attempt(x, st, norm)
        except RevisionError:
            raise
        except ValueError as e:
            first_err = first_err or e
            continue
        rep["acquisition"] = "given" if start is not None else "xcorr"
        if rep["ok"]:
            best = rep
            break
        if best is None or len(rep["ok_segments"]) > \
                len(best["ok_segments"]):
            best = rep
    if best is None:
        raise first_err
    rep = best
    if rep["ok"] and house_secret is not None and rep["house_token"]:
        expect = house_token(rep["session"],
                             zlib.crc32(rep["data"]) & 0xFFFFFFFF,
                             house_secret)
        rep["house_token_ok"] = expect == rep["house_token"]
    return rep


def decode_adaptive(samples, start=None) -> bytes:
    rep = decode_adaptive_report(samples, start)
    if not rep["ok"]:
        raise SegmentError(rep["error"] or "decode failed",
                           rep["failed_segments"], rep["ok_segments"],
                           rep["mode"], rep["session"])
    return rep["data"]


# Aliases for the adaptive entry points.
decode_auto = decode_adaptive
encode_fast = encode_adaptive
decode_fast = decode_adaptive


# ------------------------------------------------------- expression layer
# Optional, sender-side, data-free (SPEC §19). Character lives in
# the layers that carry no data: a short whistle phrase BEFORE and
# AFTER the burst, and a gentle amplitude contour over it. The
# burst's own frequencies and timing are never touched — NDAP's data
# is differential phase over 5 ms symbols, so any common pitch glide
# or time warp of the burst destroys it (measured: every depth from
# 0.3 % to 1.0 % failed), while bookends and amplitude prosody
# decode byte-exact and score identically to a plain burst.
EXPR_PRE = ((660.0, 880.0, 0.14), (880.0, 1175.0, 0.16))    # rising "ready"
EXPR_POST = ((1175.0, 880.0, 0.14), (880.0, 587.0, 0.20))   # falling "done"
EXPR_LIMITS = {
    "prosody_depth_max": 0.40,     # gain never below 1 - depth (>= 0.60)
    "prosody_hz_max": 8.0,         # slow: phrase/word-scale, not tremolo
    "phrase_freq_hz": (200.0, 4000.0),
    "phrase_max_s": 1.5,           # each bookend
    "gap_min_s": 0.10,             # silence between bookend and burst
    "gap_max_s": 1.0,
    "bookend_level_max": 0.85,     # of the burst's own peak
}


def _whistle(phrase, level: float) -> np.ndarray:
    """phrase: iterable of (f_start_hz, f_end_hz, seconds) glides,
    phase-continuous, each note faded in/out over 12 ms."""
    out, ph = [], 0.0
    for f0, f1, dur in phrase:
        n = int(round(dur * SR))
        if n <= 0:
            continue
        f = np.linspace(f0, f1, n)
        phase = ph + 2 * np.pi * np.cumsum(f) / SR
        ph = float(phase[-1]) % (2 * np.pi)
        note = np.sin(phase)
        k = min(n // 2, int(0.012 * SR))
        if k > 0:
            ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(k) / k)
            note[:k] *= ramp
            note[-k:] *= ramp[::-1]
        out.append(note)
    return level * np.concatenate(out) if out else np.zeros(0)


def add_expression(samples, bookends: bool = True, pre=EXPR_PRE,
                   post=EXPR_POST, prosody_depth: float = 0.25,
                   prosody_hz: float = 2.0, prosody_phase: float = 0.0,
                   gap_s: float = 0.15, bookend_level: float = 0.6):
    """Wrap an encoded burst in the optional Expression Layer.

    - amplitude prosody: the burst is multiplied by the slow gain
      1 - depth*(0.5 - 0.5*cos(2*pi*hz*t + phase)); gain stays in
      [1 - depth, 1] (never above 1, so peak level is preserved).
    - bookends: `pre` whistled before the burst, `post` after, each
      separated from it by `gap_s` of silence; levels are relative
      to the burst's peak.
    There is deliberately NO parameter that warps the burst's
    frequency or time base — that is prohibited (SPEC §19).
    Returns a new array; the input burst's samples are only scaled.
    Any compliant rev 8.2 decoder decodes the result byte-exact."""
    L = EXPR_LIMITS
    if not 0.0 <= prosody_depth <= L["prosody_depth_max"]:
        raise ValueError("prosody_depth outside the Expression Layer limit")
    if not 0.0 <= prosody_hz <= L["prosody_hz_max"]:
        raise ValueError("prosody_hz outside the Expression Layer limit")
    if not L["gap_min_s"] <= gap_s <= L["gap_max_s"]:
        raise ValueError("gap_s outside the Expression Layer limit")
    if not 0.0 <= bookend_level <= L["bookend_level_max"]:
        raise ValueError("bookend_level outside the Expression Layer limit")
    x = np.asarray(samples, dtype=float)
    t = np.arange(len(x)) / SR
    gain = 1.0 - prosody_depth * (0.5 - 0.5 * np.cos(
        2 * np.pi * prosody_hz * t + prosody_phase))
    body = x * gain
    if not bookends:
        return body
    lo, hi = L["phrase_freq_hz"]
    peak = float(np.max(np.abs(x))) if len(x) else 1.0
    parts = []
    for phrase in (pre, post):
        total = sum(d for _, _, d in phrase)
        if total > L["phrase_max_s"] or any(
                not (lo <= f <= hi) for f0, f1, _ in phrase
                for f in (f0, f1)):
            raise ValueError("bookend phrase outside the Expression "
                             "Layer limits")
        parts.append(_whistle(phrase, bookend_level * peak))
    gap = np.zeros(int(round(gap_s * SR)))
    return np.concatenate([parts[0], gap, body, gap, parts[1]])


# ------------------------------------------------------------ duplex
def _half_idx(n, which):
    return list(range(which, n, 2))


def _duplex_chan(which: int):
    """(mini sub-cfg, pentatonic column indices) for one duplex
    direction."""
    idx = _half_idx(20, which)
    mini_cfg = Cfg(f"mini-h{which}", PENTA[idx],
                   PENTA_GAINS[idx], MINI_SYM, bits=[2] * 10)
    return mini_cfg, idx


def _duplex_payload_chan(mc: ModeCfg, which: int, mask):
    """(full_cfg, col_idx, sub_cfg) for joint projection of one
    direction's payload sections."""
    full = _full_cfg(mc)
    sub, sel = _sel_cfg(mc, mask, _half_idx(len(mc.grid), which))
    return full, sel, sub


def encode_duplex(data_a: bytes, data_b: bytes, mode: str = "B",
                  analysis_a=None, analysis_b=None,
                  session_a=None, session_b=None,
                  house_secret: bytes = None,
                  next_speaker: int = 0) -> np.ndarray:
    """Two adaptive bursts on interleaved tone halves, mixed.
    Each direction carries its own sounding (its halves of both
    grids), mini-headers (its half of PENTA) and payload."""
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}")
    mc = MODES[mode]
    outs = []
    for which, data, ana, sess in (
            (0, data_a, analysis_a, session_a),
            (1, data_b, analysis_b, session_b)):
        snd = _sounding_audio(_half_idx(77, which), _half_idx(39, which))
        mini_cfg, _ = _duplex_chan(which)
        if ana is not None:
            mask = mask_from_analysis(ana, mode)
        else:
            mask = [1] * len(mc.grid)
        if sess is None:
            sess = int.from_bytes(os.urandom(2), "big")
        token = None
        if house_secret is not None:
            token = house_token(sess, zlib.crc32(data) & 0xFFFFFFFF,
                                house_secret)
        _, _, sub = _duplex_payload_chan(mc, which, mask)
        chunks = _split_work(data, mc)
        parts = [snd]
        for i, chunk in enumerate(chunks):
            parts.append(_mini_encode(mode, sess, i, len(chunks),
                                      _seg_stored_len(mc, chunk), mask,
                                      mini_cfg,
                                      final=(i == len(chunks) - 1),
                                      token=token,
                                      next_speaker=next_speaker))
            parts.append(_encode_section(mc, chunk, mask, sub_cfg=sub))
        outs.append(np.concatenate(parts))
    n = max(len(outs[0]), len(outs[1]))
    mix = np.zeros(n)
    mix[:len(outs[0])] += outs[0]
    mix[:len(outs[1])] += outs[1]
    peak = np.max(np.abs(mix))
    return mix * (0.85 / peak) if peak > 0 else mix


def decode_duplex(samples, start=None, mode: str = "B"):
    """Returns (data_from_A, data_from_B). Raises SegmentError
    if either direction has failed segments."""
    x = np.asarray(samples, dtype=float)
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}")
    mc = MODES[mode]
    if start is None:
        start = _find_sounding_offset(x, _half_idx(77, 0))
        mc0, ci0 = _duplex_chan(0)
        m0 = _mini_decode(x, start + SND_LEN, mc0, full_cfg=_mini_cfg,
                          col_idx=ci0)
        if m0 is not None and m0["index"] == 0 and m0["mode"] == mode:
            chan0 = _duplex_payload_chan(mc, 0, m0["mask"])
            start, _ = _refine_start(x, start, m0, mc0, _mini_cfg, ci0,
                                     chan=chan0)
    results = []
    for which in (0, 1):
        mini_cfg, col_idx = _duplex_chan(which)
        mini0 = _mini_decode(x, start + SND_LEN, mini_cfg,
                             full_cfg=_mini_cfg, col_idx=col_idx)
        if mini0 is None or mini0["index"] != 0:
            raise SegmentError(
                f"duplex direction {which}: mini-header unrecoverable",
                [], [], mode, None)
        if mini0["mode"] != mode:
            raise SegmentError(
                f"duplex direction {which}: announces mode "
                f"{mini0['mode']}, session is {mode}", [], [], mode, None)
        chan = _duplex_payload_chan(mc, which, mini0["mask"])
        rep = _walk_segments(x, start, mini0, mini_cfg,
                             full_cfg=_mini_cfg, col_idx=col_idx,
                             chan=chan)
        if not rep["ok"]:
            raise SegmentError(
                f"duplex direction {which}: {rep['error']}",
                rep["failed_segments"], rep["ok_segments"], mode,
                rep["session"])
        results.append(rep["data"])
    return results[0], results[1]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: ndap.py encode|decode|sounding|analyze|auto ...")
    cmd = sys.argv[1]
    if cmd == "encode":
        mode = sys.argv[4] if len(sys.argv) > 4 else "A"
        write_wav(sys.argv[3], encode_adaptive(os.fsencode(sys.argv[2]), mode))
        print(f"encoded {len(sys.argv[2])} chars (mode {mode}) -> {sys.argv[3]}")
    elif cmd == "decode":
        sys.stdout.buffer.write(decode_adaptive(read_wav(sys.argv[2])))
        sys.stdout.buffer.flush()
    elif cmd == "sounding":
        write_wav(sys.argv[2], sounding_burst())
        print(f"sounding -> {sys.argv[2]}")
    elif cmd == "analyze":
        ana = analyze_channel(read_wav(sys.argv[2]))
        print("recommendation:", ana["recommendation"])
        for m in ("A", "B", "C"):
            print(f"  mode {m}: " + ", ".join(
                f"{k}={v:.2f}" for k, v in ana[m].items()))
    elif cmd == "auto":
        audio, mode = encode_auto(os.fsencode(sys.argv[3]),
                                  read_wav(sys.argv[2]))
        if audio is None:
            print("recommendation: USE_NDAP6 — not encoded")
        else:
            write_wav(sys.argv[4], audio)
            print(f"encoded at mode {mode} -> {sys.argv[4]}")
    else:
        sys.exit("usage: ndap.py encode|decode|sounding|analyze|auto ...")
