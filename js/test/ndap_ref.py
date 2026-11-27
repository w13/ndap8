#!/usr/bin/env python3
"""Thin driver around the Python reference (ndap.py, repository root) for the
JS cross-check. The reference is imported read-only; run with
`python3 -I -B` so no bytecode is written beside it.

  ndap_ref.py <ndap-dir> encode  <mode> <payload> <out.wav> <session>
  ndap_ref.py <ndap-dir> decode  <in.wav> <out.bin>
  ndap_ref.py <ndap-dir> dencode <mode> <a.bin> <b.bin> <out.wav> <sess_a> <sess_b>
  ndap_ref.py <ndap-dir> ddecode <mode> <in.wav> <a_out.bin> <b_out.bin>
  ndap_ref.py <ndap-dir> sounding <out.wav> [pad]
  ndap_ref.py <ndap-dir> analyze <in.wav>
Each prints one JSON line.
"""
import sys, json
sys.path.insert(0, sys.argv[1])
import numpy as np
import ndap


def main():
    cmd, a = sys.argv[2], sys.argv[3:]
    if cmd == "encode":
        data = open(a[1], "rb").read()
        ndap.write_wav(a[2], ndap.encode_adaptive(data, a[0], session_id=int(a[3])))
        print(json.dumps({"ok": True}))
    elif cmd == "decode":
        rep = ndap.decode_adaptive_report(ndap.read_wav(a[0]))
        if rep["ok"]:
            open(a[1], "wb").write(rep["data"])
        print(json.dumps({"ok": rep["ok"], "mode": rep["mode"], "error": rep["error"],
                          "failed": rep["failed_segments"]}))
    elif cmd == "dencode":
        da, db = open(a[1], "rb").read(), open(a[2], "rb").read()
        ndap.write_wav(a[3], ndap.encode_duplex(da, db, a[0], session_a=int(a[4]),
                                                session_b=int(a[5])))
        print(json.dumps({"ok": True}))
    elif cmd == "ddecode":
        x = ndap.read_wav(a[1])
        try:
            ra, rb = ndap.decode_duplex(x, mode=a[0])
            open(a[2], "wb").write(ra)
            open(a[3], "wb").write(rb)
            print(json.dumps({"ok": True}))
        except ndap.SegmentError as e:
            print(json.dumps({"ok": False, "error": str(e), "failed": e.failed}))
    elif cmd == "sounding":
        s = ndap.sounding_burst()
        if len(a) > 1 and a[1] == "pad":     # 0.3 s lead-in, 0.8 s tail, faint noise
            rng = np.random.default_rng(5)
            s = np.concatenate([np.zeros(14400), s, np.zeros(38400)])
            s = s + rng.normal(0, 1e-4, len(s))
        ndap.write_wav(a[0], s)
        print(json.dumps({"ok": True}))
    elif cmd == "analyze":
        ana = ndap.analyze_channel(ndap.read_wav(a[0]))
        out = {"recommendation": ana["recommendation"]}
        for m in "ABC":
            out[m] = ana[m]
        out["snr_db"] = [None if np.isnan(v) else float(v) for v in ana["snr_db"]]
        out["c_snr_db"] = [None if np.isnan(v) else float(v) for v in ana["c_snr_db"]]
        print(json.dumps(out))
    else:
        sys.exit("bad command")


main()
