// The zlib port must reproduce CPython's zlib.compress(d, 9) byte for
// byte: NDAP derives section lengths from the compressed size.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { zlib_compress, zlib_decompress, toHex } from '../src/ndap.js';
import { PY, PYTHON, SPEC } from './paths.mjs';

const py = `
import sys, json, zlib, random
random.seed(7)
src = open(sys.argv[1],'rb').read()
cases = []
for cap in (105, 400, 1050, 3400):
    for i in range(0, min(len(src), 40000), cap):
        cases.append(src[i:i+cap])
words = open(sys.argv[2],'rb').read()
for cap in (105, 400, 1050, 3400):
    for i in range(0, min(len(words), 40000), cap):
        cases.append(words[i:i+cap])
for n in (0,1,2,3,4,5,10,100,257,258,259,1000,3404):
    cases.append(bytes(random.randrange(256) for _ in range(n)))          # incompressible
    cases.append(bytes(random.randrange(4) for _ in range(n)))            # low entropy
    cases.append(b'a'*n)                                                  # long runs
    cases.append((b'abcabcabd'*(n//9+1))[:n])                             # periodic
for n in (500, 5000, 20000, 32000):
    cases.append(bytes(random.choice(b'etaoin shrdlu') for _ in range(n)))
out = [[c.hex(), zlib.compress(c, 9).hex()] for c in cases]
json.dump(out, sys.stdout)
`;
const r = spawnSync(PYTHON, ['-I', '-c', py, PY, process.argv[2] ?? SPEC],
                    { maxBuffer: 1 << 28 });
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
const cases = JSON.parse(r.stdout.toString());
let bad = 0, lenDiff = 0;
for (const [inHex, outHex] of cases) {
  const inp = Uint8Array.from(Buffer.from(inHex, 'hex'));
  const got = toHex(zlib_compress(inp));
  if (got !== outHex) { bad++; if (got.length !== outHex.length) lenDiff++; }
  const back = zlib_decompress(Uint8Array.from(Buffer.from(outHex, 'hex')));
  if (toHex(back) !== inHex) { console.error('inflate mismatch'); bad++; }
}
console.log(`zlib-exact: ${cases.length} cases, ${bad} mismatches (${lenDiff} length mismatches)`);
process.exit(bad ? 1 : 0);
