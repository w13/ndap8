// Cross-implementation proofs: JS <-> the Python reference, both directions.
//   node test/crosscheck.mjs [--quick]
// Interchange format is the 16-bit WAV (what really travels between peers).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as N from '../src/ndap.js';
import { PY, PYDIR, EXAMPLES } from './paths.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, 'ndap_ref.py');
const work = mkdtempSync(join(tmpdir(), 'ndap-cross-'));
const quick = process.argv.includes('--quick');

async function ref(...args) {
  const { stdout } = await run('python3', ['-I', '-B', REF, PYDIR, ...args.map(String)],
                               { maxBuffer: 1 << 26, timeout: 20 * 60 * 1000 });
  return JSON.parse(stdout.trim().split('\n').pop());
}

// ---- payloads
const enc = new TextEncoder();
const pySrc = new Uint8Array(readFileSync(PY));
const poem = enc.encode(`Mary had a little lamb,
Its fleece was white as snow;
And everywhere that Mary went,
The lamb was sure to go.

It followed her to school one day,
That was against the rule;
It made the children laugh and play
To see a lamb at school.
`);
const PAYLOADS = [
  ['empty', new Uint8Array(0)],
  ['poem', poem],
  ['py1500', pySrc.slice(0, 1500)],
  ['py9000', pySrc.slice(0, 9000)],
];
if (!quick) {   // extra: incompressible 9,000 bytes (zlib "stored" path, many segments)
  let s = 12345; const r = new Uint8Array(9000);
  for (let i = 0; i < r.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; r[i] = s >>> 24; }
  PAYLOADS.push(['rand9000', r]);
}

let failures = 0, n = 0;
const rows = [];
const check = (ok, label, extra = '') => {
  n++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

function lsbDiff(a, b) {            // max LSB difference between two float sample arrays
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(Math.round((a[i] - b[i]) * 32767)));
  return m;
}

async function simplexCase(mode, name, payload, idx) {
  const tag = `${mode}-${name}`;
  const session = 0x1000 + idx;
  const pf = join(work, `${tag}.payload`), pyWav = join(work, `${tag}.py.wav`), jsWav = join(work, `${tag}.js.wav`);
  const pyOut = join(work, `${tag}.py.out`);
  writeFileSync(pf, payload);
  const log = [];
  // Python encode (async) while JS encodes
  const pEnc = ref('encode', mode, pf, pyWav, session);
  let t = performance.now();
  const jsAudio = N.encode_adaptive(payload, mode, { session_id: session });
  const tJsEnc = performance.now() - t;
  writeFileSync(jsWav, N.write_wav(jsAudio));
  await pEnc;
  // sample-level encoder parity
  const pyAudio = N.read_wav(new Uint8Array(readFileSync(pyWav)));
  const jsBack = N.read_wav(new Uint8Array(readFileSync(jsWav)));
  const lsb = lsbDiff(pyAudio, jsBack);
  // Python -> JS
  t = performance.now();
  let d1 = null, e1 = '';
  try { d1 = N.decode_adaptive(pyAudio); } catch (e) { e1 = e.message; }
  const tJsDec = performance.now() - t;
  // JS -> Python
  t = performance.now();
  const r2 = await ref('decode', jsWav, pyOut);
  const tPyDec = performance.now() - t;
  const d2 = r2.ok ? new Uint8Array(readFileSync(pyOut)) : null;
  return { tag, bytes: payload.length, secs: pyAudio.length / 48000, lsb,
           pyToJs: d1 !== null && N.bytesEqual(d1, payload), e1,
           jsToPy: d2 !== null && N.bytesEqual(d2, payload), e2: r2.error ?? '',
           tJsEnc, tJsDec, tPyDec };
}

// ---- simplex matrix (3 concurrent workers)
const jobs = [];
let k = 0;
for (const mode of ['A', 'B', 'C']) for (const [name, p] of PAYLOADS) jobs.push([mode, name, p, k++]);
console.log(`simplex: ${jobs.length} cases (modes A/B/C x ${PAYLOADS.length} payloads), both directions`);
const results = [];
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < jobs.length) { const j = jobs[next++]; results.push(await simplexCase(...j)); }
}));
results.sort((a, b) => a.tag.localeCompare(b.tag));
for (const r of results) {
  check(r.pyToJs, `${r.tag} (${r.bytes} B, ${r.secs.toFixed(1)} s)  Python encode -> JS decode  byte-exact`, `${r.tJsDec.toFixed(0)} ms ${r.e1}`);
  check(r.jsToPy, `${r.tag}  JS encode -> Python decode  byte-exact`, `py ${r.tPyDec.toFixed(0)} ms ${r.e2}`);
  check(r.lsb <= 1, `${r.tag}  JS-encoded WAV == Python-encoded WAV (<=1 LSB)`, `max ${r.lsb} LSB, JS encode ${r.tJsEnc.toFixed(0)} ms`);
}

// ---- duplex, both directions
console.log('\nduplex:');
const duplexSets = [['B', poem, pySrc.slice(0, 1500)]];
if (!quick) duplexSets.push(['A', poem, poem.slice(0, 120)], ['C', poem.slice(0, 60), poem.slice(100, 160)]);
let di = 0;
for (const [mode, a, b] of duplexSets) {
  const tag = `duplex-${mode}`;
  const sa = 0x2000 + di, sb = 0x2100 + di; di++;
  const fa = join(work, `${tag}.a`), fb = join(work, `${tag}.b`);
  const pyWav = join(work, `${tag}.py.wav`), jsWav = join(work, `${tag}.js.wav`);
  writeFileSync(fa, a); writeFileSync(fb, b);
  const pEnc = ref('dencode', mode, fa, fb, pyWav, sa, sb);
  let t = performance.now();
  const mix = N.encode_duplex(a, b, mode, { session_a: sa, session_b: sb });
  const tEnc = performance.now() - t;
  writeFileSync(jsWav, N.write_wav(mix));
  await pEnc;
  const pyAudio = N.read_wav(new Uint8Array(readFileSync(pyWav)));
  // Python -> JS
  t = performance.now();
  let ok1 = false, e1 = '';
  try { const [ra, rb] = N.decode_duplex(pyAudio, null, mode); ok1 = N.bytesEqual(ra, a) && N.bytesEqual(rb, b); } catch (e) { e1 = e.message; }
  const tDec = performance.now() - t;
  // JS -> Python
  const oa = join(work, `${tag}.a.out`), ob = join(work, `${tag}.b.out`);
  const r2 = await ref('ddecode', mode, jsWav, oa, ob);
  const ok2 = r2.ok && N.bytesEqual(new Uint8Array(readFileSync(oa)), a) && N.bytesEqual(new Uint8Array(readFileSync(ob)), b);
  check(ok1, `${tag} (${a.length}+${b.length} B)  Python encode -> JS decode  both directions byte-exact`, `${tDec.toFixed(0)} ms ${e1}`);
  check(ok2, `${tag}  JS encode -> Python decode  both directions byte-exact`, `JS encode ${tEnc.toFixed(0)} ms ${r2.error ?? ''}`);
  const lsb = lsbDiff(pyAudio, N.read_wav(new Uint8Array(readFileSync(jsWav))));
  check(lsb <= 1, `${tag}  JS duplex mix == Python duplex mix (<=1 LSB)`, `max ${lsb} LSB`);
}

// ---- analyzer parity
console.log('\nanalyzer:');
for (const variant of ['plain', 'pad']) {
  const f = join(work, `snd-${variant}.wav`);
  await ref('sounding', f, variant);
  const x = N.read_wav(new Uint8Array(readFileSync(f)));
  const t = performance.now();
  const jsAna = N.analyze_channel(x);
  const ms = performance.now() - t;
  const pyAna = await ref('analyze', f);
  let dev = 0;
  for (const m of ['A', 'B', 'C']) for (const key of Object.keys(pyAna[m])) dev = Math.max(dev, Math.abs(jsAna[m][key] - pyAna[m][key]));
  let devSnr = 0;
  jsAna.snr_db.forEach((v, i) => { devSnr = Math.max(devSnr, Math.abs(v - pyAna.snr_db[i])); });
  jsAna.c_snr_db.forEach((v, i) => { devSnr = Math.max(devSnr, Math.abs(v - pyAna.c_snr_db[i])); });
  check(jsAna.recommendation === 'A' && pyAna.recommendation === 'A',
        `clean Python sounding (${variant}) -> JS analyzer recommends 'A'`,
        `js=${jsAna.recommendation} py=${pyAna.recommendation}, ${ms.toFixed(0)} ms`);
  check(dev < 1e-6 * Math.max(1, Math.abs(pyAna.A.p10_snr_db)) || dev < 1e-3,
        `analyzer features match Python (${variant})`, `max |dev| feats ${dev.toExponential(2)}, per-tone SNR dB ${devSnr.toExponential(2)}; p10_A js ${jsAna.A.p10_snr_db.toFixed(2)} py ${pyAna.A.p10_snr_db.toFixed(2)} dB`);
}
// JS-generated sounding -> Python analyzer
{
  const f = join(work, 'snd-js.wav');
  writeFileSync(f, N.write_wav(N.sounding_burst()));
  const pyAna = await ref('analyze', f);
  check(pyAna.recommendation === 'A', "JS sounding_burst() -> Python analyzer recommends 'A'", `py=${pyAna.recommendation}`);
}

// ---- the shipped poem clip decodes in JS
{
  const x = N.read_wav(new Uint8Array(readFileSync(join(EXAMPLES, 'ndap8-sample.wav'))));
  const t = performance.now();
  let d = null, e = '';
  try { d = N.decode_adaptive(x); } catch (err) { e = err.message; }
  check(d !== null && N.bytesEqual(d, poem.slice(0, d.length)) && d.length === 233, 'examples/ndap8-sample.wav (poem clip) decodes in JS',
        `${(performance.now() - t).toFixed(0)} ms ${e}`);
}

rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${n} cross-checks FAILED` : `\nALL ${n} CROSS-CHECKS PASSED`);
process.exit(failures ? 1 : 0);
