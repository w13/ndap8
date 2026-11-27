// Repository-relative locations for the test suite: js/test/ sits
// two levels below the repository root, which holds the Python
// reference (ndap.py), the conformance vectors and the examples.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PY = join(ROOT, 'ndap.py');          // the Python reference (read-only)
export const PYDIR = ROOT;
export const CONF = join(ROOT, 'conformance');
export const EXAMPLES = join(ROOT, 'examples');
export const SPEC = join(ROOT, 'SPEC.md');
export const PYTHON = 'python3';
