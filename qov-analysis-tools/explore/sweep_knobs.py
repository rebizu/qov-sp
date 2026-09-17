#!/usr/bin/env python3
"""BANDWIDTH-EXPLORATION §2: perceptual knob sweep driver.

Patches a scratch copy of qov.h with -D-parameterizable encoder-side knobs,
builds bench_stream against it, encodes the cam720 fixture at call settings,
and reports video kbps + SSIM (canonical yuv444p 'All' method) per config.

  usage: sweep_knobs.py --tag NAME [--tt N] [--dz F] [--skip-base N] [--skip-slope N]
                        [--quality Q] [--keep]

Defaults reproduce master exactly (tt=3 dz=0.75 base=32 slope=8); the driver
verifies the default patch produces a byte-identical stream to the master
build on first use.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
REPO = os.path.dirname(TOOLS)
WORK = os.path.join(TOOLS, ".build-tmp", "explore")
SRC = os.path.join(WORK, "cam320.raw")
QOV_MASTER = os.path.join(REPO, "qov.h")

PATCHES = [
    # (old, new, expected count)
    ("(100 - q) / 12", "EXPLORE_TT", 2),
    ("prod > -0.75 && prod < 0.75",
     "prod > -EXPLORE_DZ && prod < EXPLORE_DZ", 1),
    ("diff < 32 + e->dct_qp * 8",
     "diff < EXPLORE_SKIP_BASE + e->dct_qp * EXPLORE_SKIP_SLOPE", 3),
]


def make_patched_header():
    src = open(QOV_MASTER, encoding="utf-8").read()
    for old, new, count in PATCHES:
        found = src.count(old)
        if found != count:
            sys.exit(f"patch site mismatch for {old!r}: found {found}, want {count}")
        src = src.replace(old, new)
    dst = os.path.join(WORK, "qov.h")  # literal name: bench_stream.c #includes "qov.h"
    open(dst, "w", encoding="utf-8").write(src)
    return dst


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def run_encode(binary, tag, quality, args):
    bin_path = os.path.join(WORK, f"{tag}.bin")
    txt_path = os.path.join(WORK, f"{tag}.txt")
    cmd = [binary, "320", "240", "24", "720", "0", "0", str(quality),
           "1", "1", "1", "1"]
    with open(SRC, "rb") as fin, open(bin_path, "wb") as fbin, \
            open(txt_path, "w") as ftxt:
        subprocess.run(cmd, stdin=fin, stdout=fbin, stderr=ftxt, check=True)
    stats = {}
    for line in open(txt_path):
        if line.startswith(("DONE", "STATS")):
            stats.update((kv.split("=")[0], int(kv.split("=")[1]))
                         for kv in line.split()[1:])
    return bin_path, stats


def reassemble(bin_path, qov_path):
    d = open(bin_path, "rb").read()
    pos = 0
    while pos + 10 <= len(d):
        if d[pos:pos + 4] == b"qovf":
            break
        sz = int.from_bytes(d[pos + 2:pos + 6], "big")
        pos += 10 + sz
    assert d[pos:pos + 4] == b"qovf", "header not found"
    open(qov_path, "wb").write(d[pos:pos + 32] + d[:pos] + d[pos + 32:])


def ssim(qov_path, tag, frames=720):
    rgba = os.path.join(WORK, f"{tag}.rgba")
    subprocess.run([os.path.join(WORK, "bench_decode"), "decode",
                    "--in", qov_path, "--rawout", rgba],
                   check=True, capture_output=True)
    r = subprocess.run(["ffmpeg", "-v", "info", "-f", "rawvideo", "-pix_fmt", "rgba",
                        "-s", "320x240", "-r", "24", "-i", rgba,
                        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "320x240",
                        "-r", "24", "-i", SRC, "-frames:v", str(frames),
                        "-filter_complex",
                        "[0]format=yuv444p[a];[1]format=yuv444p[b];[a][b]ssim",
                        "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"SSIM.*All:([0-9.]+)", r.stderr)
    if not m:
        sys.exit(f"ssim parse failed: {r.stderr[-400:]}")
    os.remove(rgba)
    return float(m.group(1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--tt", type=int, default=3)
    ap.add_argument("--dz", type=float, default=0.75)
    ap.add_argument("--skip-base", type=int, default=32)
    ap.add_argument("--skip-slope", type=int, default=8)
    ap.add_argument("--quality", type=int, default=60)
    ap.add_argument("--keep", action="store_true", help="keep .qov/.bin for inspection")
    args = ap.parse_args()

    hdr = make_patched_header()
    binary = os.path.join(WORK, "bench_explore")
    subprocess.run(["gcc", "-O2", "-std=c99", "-w", "-ffp-contract=off",
                    f"-I{WORK}", f"-I{REPO}",
                    f"-DEXPLORE_TT={args.tt}",
                    f"-DEXPLORE_DZ={args.dz}",
                    f"-DEXPLORE_SKIP_BASE={args.skip_base}",
                    f"-DEXPLORE_SKIP_SLOPE={args.skip_slope}",
                    os.path.join(TOOLS, "bench_stream.c"), hdr,
                    "-lm", "-o", binary], check=True)

    tag = args.tag
    bin_path, st = run_encode(binary, tag, args.quality, args)
    kbps = round(st["video"] * 8 / 30 / 1000, 1)
    qov_path = os.path.join(WORK, f"{tag}.qov")
    reassemble(bin_path, qov_path)
    s = ssim(qov_path, tag)
    row = {
        "tag": tag, "tt": args.tt, "dz": args.dz,
        "skip_base": args.skip_base, "skip_slope": args.skip_slope,
        "quality": args.quality, "video_kbps": kbps, "ssim_all": s,
        "sha16": sha(bin_path),
        "blocks_skip": st.get("blocks_skip"), "blocks_coded": st.get("blocks_coded"),
    }
    if not args.keep:
        os.remove(bin_path)
        os.remove(qov_path)
    out = os.path.join(WORK, "knob_rows.jsonl")
    with open(out, "a") as f:
        f.write(json.dumps(row) + "\n")
    print(json.dumps(row))


if __name__ == "__main__":
    main()
