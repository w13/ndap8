# NDAP-8 — JavaScript implementation

`src/ndap.js` is a complete implementation of NDAP-8 (see
`../SPEC.md`) as a single ES module with zero dependencies and no
platform imports. It runs unchanged in browsers, Cloudflare
Workers and Node.js (developed and verified on Node 24).

It is byte-compatible with the Python implementation at the
repository root: the two implementations encode and decode each
other's output exactly, including simultaneous two-direction
(duplex) bursts, and encoded WAV files are sample-identical.

## Tests

From this directory, with the Python reference available
(Python 3 + numpy):

    npm test

runs three suites:

- `test/conformance.mjs` — the golden, correctable-burst and
  beyond-capacity vectors from `../conformance/` decode exactly
  as specified (broken vectors fail loudly, never silently).
- `test/zlib-exact.mjs` — the compression layer is byte-identical
  to stock zlib level 9 (989 cases). Because burst lengths derive
  from the compressed size, the compressor is a bit-exact port of
  zlib 1.3 deflate rather than the platform's built-in; it accepts
  inputs under 32,506 bytes, far above the protocol's largest
  chunk.
- `test/crosscheck.mjs` — 60 cross-implementation checks against
  the Python reference, both directions, all three modes, plus
  analyzer parity.

## Notes

- Channel analysis never throws on unusable input (silence, an
  empty or too-short recording, pure DC): it returns a degenerate
  analysis whose recommendation is `USE_NDAP6`, matching the
  Python behaviour.
- Decode of a burst takes on the order of one to two seconds in
  Node; most of that time is the burst search.
