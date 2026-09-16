#!/usr/bin/env python3
"""Compare LZ4 vs range-coder streams produced by bench_stream.c (spec v3.8).

Prerequisites — two bench_stream runs over the same footage, differing only
in the range flag (argv[8]):

  ffmpeg -t 30 -i corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
         -f rawvideo -pix_fmt rgba - | .build-tmp/bench_stream 320 240 24 720 16000 1 60 0 \
         > range_before.bin 2> range_before.txt
  # same again with argv[8]=1 for range_after.bin / range_after.txt

Usage:
  python3 bench_range_compare.py range_before.bin range_before.txt \
                                 range_after.bin  range_after.txt

Reports video-only and call-media sizes, exact QOV-S wire numbers for both
streams, and writes scoreboard-phase3.5-range.json.
"""
import json
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from bench_bandwidth import media_chunks, wire_bytes, QOV_CLI, TOOLS as T2  # noqa: E402

SECONDS = 30.0


def video_bytes(stats_path):
    """Video+sync bytes from bench_stream's per-frame stderr accounting."""
    per = [l.split() for l in Path(stats_path).read_text().splitlines()
           if l and l[0].isdigit()]
    return sum(int(f[1]) for f in per) + sum(int(f[3]) for f in per)


def measure(parts_path):
    parts = Path(parts_path).read_bytes()
    chunks, media_bytes = media_chunks(parts)
    rows = {"media kbps": media_bytes * 8 / SECONDS / 1000}
    for name, grp in [("fec_off", 0), ("fec14", 4), ("fec13", 3)]:
        w, pkts, parity = wire_bytes(chunks, grp)
        rows[name] = {"kbps": w * 8 / SECONDS / 1000,
                      "overhead_pct": (w - media_bytes) / media_bytes * 100}
    return rows, media_bytes


def decode_verify(parts_path, tag):
    parts = Path(parts_path).read_bytes()
    chunks, media_bytes = media_chunks(parts)
    header = parts[media_bytes:media_bytes + 32]
    assert header[:4] == b"qovf", "header not found (assembled layout: chunks+header+tail)"
    f = T2 / ".build" / f"range_check_{tag}.qov"
    f.write_bytes(header + parts[:media_bytes] + parts[media_bytes + 32:])
    dec = subprocess.run([str(QOV_CLI), "decode", str(f)], capture_output=True, text=True)
    assert dec.returncode == 0, f"decode failed: {dec.stderr[-400:]}"
    info = json.loads(dec.stdout)
    return info["frames"], info["audioFrames"]


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__)
        return 1
    b_rows, b_m = measure(sys.argv[1])
    a_rows, a_m = measure(sys.argv[3])
    b_v, a_v = video_bytes(sys.argv[2]), video_bytes(sys.argv[4])
    frames, audio = decode_verify(sys.argv[3], "after")

    print(f"decode check: {frames} video frames, {audio} audio chunks - OK")
    print(f"video-only  LZ4 -> range: {b_v:>9} -> {a_v:>9} B  ({(a_v - b_v) / b_v * 100:+.1f}%)")
    print(f"call media  LZ4 -> range: {b_m:>9} -> {a_m:>9} B  ({(a_m - b_m) / b_m * 100:+.1f}%)")
    for name in ("fec_off", "fec14", "fec13"):
        print(f"wire {name:<7}: {b_rows[name]['kbps']:7.1f} -> {a_rows[name]['kbps']:7.1f} kbps")

    out = T2 / "scoreboard-phase3.5-range.json"
    out.write_text(json.dumps({
        "comment": "Phase 3.5 PR1: order-0 adaptive range coder (spec v3.8 flag 0x08) replacing "
                   "LZ4 on DCT chunks. 30s real webcam footage (corpus-real/cam720.mkv), call "
                   "settings 320x240@24 q60 yuv420 motion+ikf+refresh, keyframe every 120, mono "
                   "16 kHz speech. Wire math identical to scoreboard-phase3-audio.json. "
                   "Reproduce with bench_stream.c + bench_range_compare.py.",
        "settings": {"fps": 24.0, "seconds": 30.0, "audio_rate": 16000, "audio_ch": 1},
        "decode_check": {"frames": frames, "audio_chunks": audio},
        "rows": {
            "video-only bytes LZ4": b_v,
            "video-only bytes range": a_v,
            "video-only reduction pct": round((b_v - a_v) / b_v * 100, 1),
            "call media bytes LZ4": b_m,
            "call media bytes range": a_m,
            "call media reduction pct": round((b_m - a_m) / b_m * 100, 1),
            "video-only kbps LZ4": round(b_v * 8 / SECONDS / 1000, 1),
            "video-only kbps range": round(a_v * 8 / SECONDS / 1000, 1),
            "wire FEC off kbps LZ4 -> range": [round(b_rows["fec_off"]["kbps"], 1), round(a_rows["fec_off"]["kbps"], 1)],
            "wire FEC 1:4 kbps LZ4 -> range": [round(b_rows["fec14"]["kbps"], 1), round(a_rows["fec14"]["kbps"], 1)],
            "wire FEC 1:3 kbps LZ4 -> range": [round(b_rows["fec13"]["kbps"], 1), round(a_rows["fec13"]["kbps"], 1)],
        },
    }, indent=1))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
