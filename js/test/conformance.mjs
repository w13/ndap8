// NDAP-8 conformance proofs for the JS port (spec §18 / Appendix B).
//   node test/conformance.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as N from '../src/ndap.js';
import { CONF } from './paths.mjs';

const MODES = ['A', 'B', 'C'];
// Tolerances (measured values are reported; see PORT-REPORT.md).
//  * vs JSON, projecting the JS-encoded float audio: the JSON holds 6-decimal
//    roundings, so the floor is 5e-7 plus numerics.
//  * vs JSON, projecting the golden WAV: the WAV is int16-quantized while the
//    JSON was taken from the float audio, so the floor is quantization noise.
const TOL_FLOAT = 1e-6;
const TOL_WAV = 5e-5;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const wav = (name) => N.read_wav(new Uint8Array(readFileSync(join(CONF, name))));
const hex = N.toHex;

function constellation(audio, mode) {
  const mc = N.MODES[mode];
  const [cfg] = N._sel_cfg(mc, new Array(mc.grid.length).fill(1));
  const sec = N.SND_LEN + N.MINI_LEN;
  const co = N._slots_coeffs(audio, cfg, mc.guard, sec, 2);
  const rows = {};
  for (const r of [0, 1]) {
    rows[`row${r}`] = Array.from({ length: co.ntones }, (_, k) => [co.re[r * co.ntones + k], co.im[r * co.ntones + k]]);
  }
  return rows;
}

function maxDev(got, want) {
  let m = 0;
  for (const row of ['row0', 'row1']) {
    got[row].forEach((z, k) => { m = Math.max(m, Math.abs(z[0] - want[row][k][0]), Math.abs(z[1] - want[row][k][1])); });
  }
  return m;
}

const summary = {};
for (const mode of MODES) {
  console.log(`\n=== mode ${mode} ===`);
  const J = JSON.parse(readFileSync(join(CONF, `golden-${mode}.json`), 'utf8'));
  const payload = new TextEncoder().encode(J.payload_text);
  const mc = N.MODES[mode];
  const S = (summary[mode] = {});

  // 1. golden decodes byte-exact
  const golden = wav(`golden-${mode}.wav`);
  let t0 = performance.now();
  let data = null, err = null;
  try { data = N.decode_adaptive(golden); } catch (e) { err = e; }
  S.golden_ms = performance.now() - t0;
  check(data !== null && sha(data) === J.payload_sha256 && N.bytesEqual(data, payload),
        'golden decodes byte-exact (sha256 matches)', `${S.golden_ms.toFixed(0)} ms${err ? ' ' + err.message : ''}`);

  // 2. framing / header intermediates
  const chunks = N._split_work(payload, mc);
  const chunk = chunks[0];
  check(chunks.length === 1 && chunk.length === J.segment0_chunk_len, 'segment-0 chunk length', `${chunk.length}`);
  const mini = N._mini_info_bytes(mode, J.session_id, 0, 1, N._seg_stored_len(mc, chunk), new Array(mc.grid.length).fill(1), true);
  check(hex(mini) === J.segment0_mini_info_bytes_hex, 'mini-header info bytes');
  if (mc.code === 'rs') {
    const [stored, flags] = N._stored_of(chunk);
    const stream = N._frame_rs(stored, flags, mc.rs_data, mc.rs_nsym);
    check(stored.length === J.segment0_stored_len, 'stored length (zlib-exact)', `${stored.length}`);
    check(hex(stream.subarray(0, 64)) === J.segment0_framed_stream_first64_hex, 'framed stream first 64 bytes');
    check(hex(stream.subarray(0, 25)) === J.segment0_first_header_block_hex, 'first RS(25,9) header block');
  } else {
    const info = N._conv_info(chunk);
    check(hex(info) === J.segment0_info_bytes_hex, 'mode C info bytes');
    let coded = N.conv_encode(N.unpackbits(info), N.CODE_GENS);
    coded = N._permute(coded, N._data_perm_P(coded.length));
    check(Array.from(coded.subarray(0, 256)).join('') === J.segment0_coded_bits_first256, 'first 256 coded bits');
  }

  // 3. PHY intermediates: constellation rows 0-1, from (a) the JS encoder's
  //    float audio and (b) the golden WAV.
  const enc = N.encode_adaptive(payload, mode, { session_id: J.session_id });
  const devF = maxDev(constellation(enc, mode), J.constellation_segment0);
  const devW = maxDev(constellation(golden, mode), J.constellation_segment0);
  S.dev_float = devF; S.dev_wav = devW;
  check(devF <= TOL_FLOAT, 'constellation rows 0-1 vs JSON (JS-encoded float audio)', `max |dev| = ${devF.toExponential(3)} (tol ${TOL_FLOAT})`);
  check(devW <= TOL_WAV, 'constellation rows 0-1 vs JSON (golden WAV samples)', `max |dev| = ${devW.toExponential(3)} (tol ${TOL_WAV})`);

  // 4. encoder parity with the golden WAV (sample-level)
  const reEnc = N.read_wav(N.write_wav(enc));
  let maxLsb = 0, diffs = 0;
  if (reEnc.length === golden.length) {
    for (let i = 0; i < golden.length; i++) {
      const d = Math.abs(Math.round((reEnc[i] - golden[i]) * 32767));
      if (d) diffs++;
      if (d > maxLsb) maxLsb = d;
    }
  } else maxLsb = Infinity;
  S.enc_lsb = maxLsb; S.enc_diffs = diffs;
  check(reEnc.length === golden.length && maxLsb <= 1, 'JS-encoded WAV equals the golden WAV (<= 1 LSB)',
        `len ${reEnc.length}/${golden.length}, max |diff| = ${maxLsb} LSB, ${diffs} samples differ`);

  // 5. corrupt decodes EXACTLY
  t0 = performance.now();
  let cdata = null, cerr = null;
  try { cdata = N.decode_adaptive(wav(`corrupt-${mode}.wav`)); } catch (e) { cerr = e; }
  S.corrupt_ms = performance.now() - t0;
  check(cdata !== null && sha(cdata) === J.payload_sha256, `corrupt (${J.corrupt_burst.burst_len_samples}-sample burst) decodes byte-exact`,
        `${S.corrupt_ms.toFixed(0)} ms${cerr ? ' ' + cerr.message : ''}`);

  // 6. broken fails LOUDLY, never wrong bytes
  const bw = wav(`broken-${mode}.wav`);
  t0 = performance.now();
  let threw = false, wrong = false;
  try { const d = N.decode_adaptive(bw); wrong = d !== null; } catch (e) { threw = e instanceof N.SegmentError || e instanceof Error; }
  let repOk = null, repData = 'x';
  try { const rep = N.decode_adaptive_report(bw); repOk = rep.ok; repData = rep.data; } catch (e) { repOk = false; repData = null; }
  S.broken_ms = performance.now() - t0;
  check(threw && !wrong, 'broken: decode_adaptive throws', `${S.broken_ms.toFixed(0)} ms`);
  check(repOk === false && repData === null, 'broken: report ok=false, data=null');
}

console.log('\n=== summary ===');
for (const m of MODES) {
  const s = summary[m];
  console.log(`mode ${m}: golden decode ${s.golden_ms.toFixed(0)} ms | corrupt ${s.corrupt_ms.toFixed(0)} ms | broken ${s.broken_ms.toFixed(0)} ms | ` +
              `constellation max dev: float ${s.dev_float.toExponential(2)}, wav ${s.dev_wav.toExponential(2)} | enc vs golden: ${s.enc_diffs} samples differ, max ${s.enc_lsb} LSB`);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CONFORMANCE CHECKS PASSED');
process.exit(failures ? 1 : 0);
