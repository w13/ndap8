// NDAP-8 rev 8.1 proofs for the JS port: correlation acquisition, slow-envelope
// normalization and the Expression Layer, against the Python reference.
//   node test/rev81.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as N from '../src/ndap.js';
import { PYDIR, CONF } from './paths.mjs';

const run = promisify(execFile);
const REF = join(dirname(fileURLToPath(import.meta.url)), 'ndap_ref.py');
const work = mkdtempSync(join(tmpdir(), 'ndap-rev81-'));
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
const PAY = new TextEncoder().encode('Rev 8.1 cross-check: bookends, prosody, noise and a purr envelope.');
const dec = (x) => { try { return N.decode_adaptive_report(x); } catch (e) { return { ok: false, error: e.message }; } };

console.log(`implementation revision ${N.IMPL_VERSION}`);
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

console.log('\nCorrelation acquisition and envelope (Python-built stressed WAVs -> JS):');
const cases = [
  ['padded + AWGN 5 dB', 'awgn', 'C', 5],
  ['25 Hz envelope 0.6-1.0', 'env', 'A', 0],
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

console.log('\nLegacy vectors still decode through the new receiver:');
for (const mode of ['A', 'B', 'C']) {
  const x = wavIn(join(CONF, `golden-${mode}.wav`));
  const r = dec(x);
  check(r.ok && r.acquisition === 'xcorr', `golden-${mode}.wav decodes via correlation acquisition`, `start ${r.start}`);
}

console.log('\nStrict mini-header (rev 8.1):');
{
  const forge = (idx, total) => {
    const raw = N._mini_info_bytes('A', 0x1234, idx, total, 10, new Array(39).fill(1));
    return N._mini_parse(raw);
  };
  check(forge(0, 1) !== null && forge(2, 3) !== null, 'valid index/count parse');
  check(forge(0, 0) === null && forge(3, 3) === null && forge(5, 2) === null, 'impossible index/count rejected (CRC-valid but nonsensical)');
}

console.log("\nEar interoperability (the Ear's embedded 8.0 JS codec, imported read-only):");
{
  const earPath = join(PYDIR, 'ear', 'client', 'src', 'ndap.js');
  if (existsSync(earPath)) {
    const EAR = await import(earPath);
    for (const mode of ['A', 'C']) {
      const burst = EAR.encode_adaptive(PAY, mode, { session_id: 21 });
      let a = false, b = false;
      try { a = N.bytesEqual(EAR.decode_adaptive(N.add_expression(burst)), PAY); } catch (e) { /* loud failure */ }
      try { b = N.bytesEqual(N.decode_adaptive(burst), PAY); } catch (e) { /* loud failure */ }
      check(a, `${mode}: Ear (8.0) codec decodes an expression-wrapped burst`);
      check(b, `${mode}: 8.1 receiver decodes a burst encoded by the Ear's codec`);
    }
  } else console.log('  (ear/ not present; skipped)');
}

rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${n} rev-8.1 checks FAILED` : `\nALL ${n} REV-8.1 CHECKS PASSED`);
process.exit(failures ? 1 : 0);
