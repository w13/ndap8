// NDAP-8 rev 8.2 proofs for the JS port, against the Python reference:
// clean-slate format parity, revision marker, tone mask on every mode,
// correlation acquisition + envelope normalization, strict validation,
// and the Expression Layer.
//   node test/rev82.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as N from '../src/ndap.js';
import { PYDIR, CONF } from './paths.mjs';

const run = promisify(execFile);
const REF = join(dirname(fileURLToPath(import.meta.url)), 'ndap_ref.py');
const work = mkdtempSync(join(tmpdir(), 'ndap-rev82-'));
async function ref(...args) {
  const { stdout } = await run('python3', ['-I', '-B', REF, PYDIR, ...args.map(String)],
                               { maxBuffer: 1 << 26, timeout: 20 * 60 * 1000 });
  return JSON.parse(stdout.trim().split('\n').pop());
}
let failures = 0, n = 0;
const check = (ok, label, extra = '') => {
  n++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};
const wavIn = (f) => N.read_wav(new Uint8Array(readFileSync(f)));
function lsbDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(Math.round((a[i] - b[i]) * 32767)));
  return m;
}
const PAY = new TextEncoder().encode('Rev 8.2 cross-check: bookends, prosody, noise and a purr envelope.');
const dec = (x) => { try { return N.decode_adaptive_report(x); } catch (e) { return { ok: false, error: e.message, err: e }; } };

console.log(`implementation revision ${N.IMPL_VERSION}, wire revision 0x${N.WIRE_REV.toString(16)}`);
check(N.IMPL_VERSION === '8.2.0' && N.WIRE_REV === 0x82, 'version constants');

console.log('\nExpression Layer (Python <-> JS):');
for (const mode of ['A', 'C']) {
  const pf = join(work, `p-${mode}.bin`), pyWav = join(work, `expr-${mode}.py.wav`), jsWav = join(work, `expr-${mode}.js.wav`);
  writeFileSync(pf, PAY);
  await ref('express', mode, pf, pyWav, 0x3100);
  const jsExpr = N.add_expression(N.encode_adaptive(PAY, mode, { session_id: 0x3100 }));
  writeFileSync(jsWav, N.write_wav(jsExpr));
  const pyAudio = wavIn(pyWav), jsAudio = wavIn(jsWav);
  check(lsbDiff(pyAudio, jsAudio) <= 1, `${mode}: JS add_expression == Python add_expression (<=1 LSB)`, `max ${lsbDiff(pyAudio, jsAudio)} LSB`);
  const r = dec(pyAudio);
  check(r.ok && N.bytesEqual(r.data, PAY), `${mode}: Python expression burst -> JS decode byte-exact`, `${r.acquisition}`);
  const out = join(work, `expr-${mode}.out`);
  const r2 = await ref('decode', jsWav, out);
  check(r2.ok && N.bytesEqual(new Uint8Array(readFileSync(out)), PAY), `${mode}: JS expression burst -> Python decode byte-exact`);
}
let threw = false;
try { N.add_expression(new Float64Array(10), { prosody_depth: 0.9 }); } catch (e) { threw = true; }
check(threw, 'add_expression refuses prosody outside the Expression Layer limits');

console.log('\nCorrelation acquisition, noise and envelope (Python-built stressed WAVs -> JS):');
const cases = [
  ['padded + AWGN 3 dB', 'awgn', 'C', 3],
  ['padded + AWGN 24 dB (8.1: 0/4)', 'awgn', 'A', 24],
  ['padded + AWGN 18 dB (8.1: 0/4)', 'awgn', 'B', 18],
  ['25 Hz envelope 0.6-1.0', 'env', 'A', 0],
  ['25 Hz envelope 0.6-1.0', 'env', 'B', 0],
  ['25 Hz envelope + AWGN 8 dB', 'env-awgn', 'C', 8],
];
for (const [label, kind, mode, snr] of cases) {
  const pf = join(work, 'p.bin'); writeFileSync(pf, PAY);
  const wf = join(work, `${kind}-${mode}.wav`);
  await ref('stress', kind, mode, pf, wf, 0x3200, snr);
  const x = wavIn(wf);
  const t = performance.now();
  const r = dec(x);
  const info = await ref('info', wf);
  check(r.ok && N.bytesEqual(r.data, PAY), `${mode}, ${label}: JS decode byte-exact`, `${r.acquisition}, ${(performance.now() - t).toFixed(0)} ms`);
  check(info.ok && r.start === info.start && r.acquisition === info.acquisition && r.envelope_normalized === info.norm,
        `${mode}, ${label}: JS and Python agree on start/acquisition/normalization`, `js start ${r.start}, py start ${info.start}`);
}

console.log('\nClock drift (rev 8.2: per-section re-alignment; Mode A, 2 segments):');
{
  let st = 777, big = new Uint8Array(4000);
  for (let i = 0; i < big.length; i++) { st = (Math.imul(st, 1103515245) + 12345) >>> 0; big[i] = st >>> 24; }
  const pf = join(work, 'big.bin'); writeFileSync(pf, big);
  for (const ppm of [60, -60]) {
    const wf = join(work, `drift-${ppm}.wav`);
    await ref('stress', 'drift', 'A', pf, wf, 0x3500, ppm);
    const r = dec(wavIn(wf));
    check(r.ok && N.bytesEqual(r.data, big) && r.segments.length === 2, `A, ${ppm > 0 ? '+' : ''}${ppm} ppm clock mismatch, 2 segments: JS decode byte-exact`,
          r.ok ? '' : r.error);
  }
}

console.log('\nGolden vectors decode through correlation acquisition:');
for (const mode of ['A', 'B', 'C']) {
  const x = wavIn(join(CONF, `golden-${mode}.wav`));
  const r = dec(x);
  check(r.ok && r.acquisition === 'xcorr', `golden-${mode}.wav decodes via correlation acquisition`, `start ${r.start}`);
}

console.log('\nWire revision marker (rev 8.2):');
{
  const raw = N._mini_info_bytes('A', 0x1234, 0, 1, 10, new Array(39).fill(1));
  const bad = Uint8Array.from(raw);
  bad[2] = 0x83;
  const crc = N._crc16(bad.subarray(0, 29));
  bad[29] = crc >> 8; bad[30] = crc & 255;
  let err = null;
  try { N._mini_parse(bad); } catch (e) { err = e; }
  check(err instanceof N.RevisionError && err.rev === 0x83 && err.expected === 0x82, 'CRC-valid foreign-revision header raises RevisionError');
  const bad2 = Uint8Array.from(bad); bad2[29] ^= 0xff;
  check(N._mini_parse(bad2) === null, 'foreign revision with a bad CRC is a plain reject');
  for (const rev of [0x08, 0x83]) {
    const pf = join(work, 'p.bin'); writeFileSync(pf, PAY);
    const wf = join(work, `foreign-${rev}.wav`);
    await ref('foreign', 'A', pf, wf, 0x3300, rev);
    const r = dec(wavIn(wf));
    check(!r.ok && r.err instanceof N.RevisionError && r.err.rev === rev, `Python burst announcing rev 0x${rev.toString(16).padStart(2, '0')} -> JS RevisionError (never wrong bytes)`);
  }
}

console.log('\nTone mask on every mode (rev 8.2: Mode A included):');
for (const mode of ['A', 'B', 'C']) {
  const mc = N.MODES[mode];
  const mask = Array.from(mc.grid, (f) => (f <= 4000 ? 1 : 0));
  const jsAudio = N.encode_adaptive(PAY, mode, { session_id: 0x3400, tone_mask: mask });
  const pf = join(work, 'p.bin'); writeFileSync(pf, PAY);
  const pyWav = join(work, `mask-${mode}.py.wav`), jsWav = join(work, `mask-${mode}.js.wav`);
  await ref('maskenc', mode, pf, pyWav, 0x3400, 4000);
  writeFileSync(jsWav, N.write_wav(jsAudio));
  const pyAudio = wavIn(pyWav);
  check(lsbDiff(pyAudio, wavIn(jsWav)) <= 1, `${mode}: masked JS burst == masked Python burst (<=1 LSB)`);
  const r = dec(pyAudio);
  check(r.ok && N.bytesEqual(r.data, PAY), `${mode}: masked Python burst -> JS decode byte-exact`);
}
{
  let t = false;
  try { N.encode_adaptive(PAY, 'A', { tone_mask: [1, 1, 1] }); } catch (e) { t = true; }
  check(t, 'tone_mask of the wrong length is refused');
}

console.log('\nStrict mini-header:');
{
  const forge = (idx, total, flags = 0) => {
    const raw = Uint8Array.from(N._mini_info_bytes('A', 0x1234, 0, 1, 10, new Array(39).fill(1)));
    raw[6] = idx; raw[7] = total; raw[8] = flags;
    const crc = N._crc16(raw.subarray(0, 29));
    raw[29] = crc >> 8; raw[30] = crc & 255;
    return N._mini_parse(raw);
  };
  check(forge(0, 1) !== null && forge(2, 3) !== null, 'valid index/count parse');
  check(forge(0, 0) === null && forge(3, 3) === null && forge(5, 2) === null, 'impossible index/count rejected (CRC-valid but nonsensical)');
  check(forge(0, 1, 0x10) === null && forge(0, 1, 0x80) === null, 'reserved flag bits rejected');
}

console.log('\nNo legacy surface remains:');
check(N._find_burst_legacy === undefined && N._refined_candidates === undefined && N._sounding_score === undefined,
      'the 8.0 finder (and its helpers) is gone from the JS port');

rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${n} rev-8.2 checks FAILED` : `\nALL ${n} REV-8.2 CHECKS PASSED`);
process.exit(failures ? 1 : 0);
