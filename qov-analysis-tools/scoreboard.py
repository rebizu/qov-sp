#!/usr/bin/env python3
"""QOV scoreboard (Phase 0 of the conference roadmap).

Measures one or more source sequences and appends before/after rows to a
baseline JSON. For each source it reports, per QOV quality and per x264 CRF:

  bitrate_kbps      encoded size / duration
  ssim_all          mean SSIM vs the source (ffmpeg ssim filter, yuv444p)
  enc_ms_per_frame  wall time per frame (QOV: c/bench.exe; x264: whole ffmpeg run)
  dec_ms_per_frame  QOV incremental decoder / ffmpeg decode wall time
  blocks_skip/coded QOV encoder 8x8 decision tally (Rule Zero gate 3)

Plus codec line counts (Rule Zero gate 1) recorded once per run.

Usage:
  python scoreboard.py SOURCE [SOURCE...] [--name NAME] [--out FILE]
      [--qualities 40,60,80] [--crfs 32,36,40] [--kf 300] [--frames N]
      [--motion] [--lz4] [--cs yuv420|srgb]

No merge without before/after rows — see AGENTS.md / the roadmap.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BENCH = os.path.join(REPO, "c", "bench.exe")
DEFAULT_OUT = os.path.join(HERE, "scoreboard-baseline.json")

TS_CODEC_FILES = [
    "src/qov-types.ts", "src/qov-encoder.ts", "src/qov-decoder.ts",
    "src/qov-streaming-decoder.ts", "src/dct.ts", "src/motion.ts",
    "src/lz4.ts", "src/color-utils.ts", "src/qoa.ts",
]


def die(msg):
    print(f"scoreboard: ERROR: {msg}", file=sys.stderr)
    sys.exit(2)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def find_bench():
    if not os.path.exists(BENCH):
        die(f"{BENCH} missing — build with: gcc -O2 -ffp-contract=off -o c/bench.exe c/bench.c "
            "(export PATH=/c/msys64/mingw64/bin:$PATH first, gcc fails silently otherwise; "
            "-ffp-contract=off is required for bit-exact parity with TS)")
    return BENCH


def probe(path):
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height,r_frame_rate,duration,nb_frames",
             "-show_entries", "format=duration",
             "-of", "json", path])
    if r.returncode != 0:
        die(f"ffprobe failed for {path}: {r.stderr.strip()}")
    info = json.loads(r.stdout)
    st = info["streams"][0]
    num, den = st["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    dur = float(st.get("duration") or info.get("format", {}).get("duration") or 0)
    if dur <= 0:
        die(f"no duration for {path}; trim/copy the source so ffprobe sees one")
    frames = int(st.get("nb_frames") or round(dur * fps))
    return int(st["width"]), int(st["height"]), fps, dur, frames


def pipe_frames(src, bench_args, w, h, frames):
    """ffmpeg decodes src to raw RGBA on stdout, piped straight into bench."""
    ff = ["ffmpeg", "-v", "error", "-i", src, "-frames:v", str(frames),
          "-f", "rawvideo", "-pix_fmt", "rgba", "-"]
    b = [BENCH, "encode", "--w", str(w), "--h", str(h),
         "--frames", str(frames)] + bench_args
    p_ff = subprocess.Popen(ff, stdout=subprocess.PIPE)
    p_b = subprocess.Popen(b, stdin=p_ff.stdout, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True)
    p_ff.stdout.close()
    out, err = p_b.communicate()
    if p_b.returncode != 0:
        die(f"bench encode failed: {err.strip()}")
    return json.loads(out)


def decode_qov(qov_path, raw_path):
    r = run([BENCH, "decode", "--in", qov_path, "--rawout", raw_path])
    if r.returncode != 0:
        die(f"bench decode failed: {r.stderr.strip()}")
    return json.loads(r.stdout)


def decode_any(src, raw_path, w, h, frames):
    t0 = time.perf_counter()
    r = run(["ffmpeg", "-v", "error", "-i", src, "-frames:v", str(frames),
             "-f", "rawvideo", "-pix_fmt", "rgba", "-y", raw_path])
    if r.returncode != 0:
        die(f"ffmpeg decode failed: {r.stderr.strip()}")
    ms = (time.perf_counter() - t0) * 1000.0
    return {"frames": frames, "decodeMs": ms, "msPerFrame": ms / frames}


def ssim_all(decoded_raw, src, w, h, fps, frames):
    r = run(["ffmpeg", "-v", "info", "-f", "rawvideo", "-pix_fmt", "rgba",
             "-s", f"{w}x{h}", "-r", f"{fps}", "-i", decoded_raw,
             "-i", src, "-frames:v", str(frames), "-filter_complex",
             "[0]format=yuv444p[a];[1]format=yuv444p[b];[a][b]ssim",
             "-f", "null", "-"])
    m = re.search(r"SSIM.*All:([0-9.]+)", r.stderr)
    if not m:
        die(f"ssim parse failed: {r.stderr[-400:]}")
    return float(m.group(1))


def line_counts():
    rows = {}
    rows["qov.h"] = sum(1 for _ in open(os.path.join(REPO, "qov.h"), encoding="utf-8", errors="replace"))
    ts_total = 0
    for f in TS_CODEC_FILES:
        p = os.path.join(REPO, f)
        n = sum(1 for _ in open(p, encoding="utf-8", errors="replace")) if os.path.exists(p) else 0
        rows[f] = n
        ts_total += n
    rows["ts_codec_total"] = ts_total
    return rows


def measure_qov(src, name, w, h, fps, dur, frames, args):
    rows = []
    for q in args.qualities:
        tag = f"{name}_q{q:03d}"
        qov_path = os.path.join(args.work, tag + ".qov")
        raw_path = os.path.join(args.work, tag + ".rgba")
        bench_args = ["--quality", str(q), "--kf", str(args.kf), "--cs", args.cs,
                      "--in", "-", "--out", qov_path]
        if args.motion:
            bench_args.append("--motion")
        if args.lz4:
            bench_args.append("--lz4")
        if args.refresh:
            bench_args.append("--refresh")
        if args.ikf:
            bench_args.append("--ikf")
        if args.eg:
            bench_args.append("--eg")
        enc = pipe_frames(src, bench_args, w, h, frames)
        dec = decode_qov(qov_path, raw_path)
        ssim = ssim_all(raw_path, src, w, h, fps, dec["frames"])
        os.remove(raw_path)
        rows.append({
            "name": name, "codec": "qov", "setting": f"quality={q}",
            "colorspace": args.cs, "motion": bool(args.motion), "lz4": bool(args.lz4),
            "refresh": bool(args.refresh), "ikf": bool(args.ikf), "eg": bool(args.eg),
            "frames": dec["frames"],
            "size_bytes": enc["bytes"],
            # bitrate must use the encoded span (frames/fps), not the source
            # duration, so capped runs stay comparable
            "bitrate_kbps": round(enc["bytes"] * 8 / (dec["frames"] / fps) / 1000.0, 1),
            "ssim_all": ssim,
            "enc_ms_per_frame": round(enc["msPerFrame"], 3),
            "dec_ms_per_frame": round(dec["msPerFrame"], 3),
            "blocks_skip": enc["stats"]["blocksSkip"],
            "blocks_coded": enc["stats"]["blocksCoded"],
        })
        print(f"  qov quality={q}: {rows[-1]['bitrate_kbps']} kbps, "
              f"ssim {ssim}, enc {rows[-1]['enc_ms_per_frame']} ms/f, "
              f"dec {rows[-1]['dec_ms_per_frame']} ms/f")
    return rows


def measure_x264(src, name, w, h, fps, dur, frames, args):
    rows = []
    for crf in args.crfs:
        tag = f"{name}_crf{crf:02d}"
        mp4 = os.path.join(args.work, tag + ".mp4")
        raw_path = os.path.join(args.work, tag + ".rgba")
        t0 = time.perf_counter()
        r = run(["ffmpeg", "-v", "error", "-y", "-i", src, "-frames:v", str(frames),
                 "-c:v", "libx264", "-preset", "ultrafast", "-crf", str(crf),
                 "-pix_fmt", "yuv420p", "-an", mp4])
        if r.returncode != 0:
            die(f"x264 encode failed: {r.stderr.strip()}")
        enc_ms = (time.perf_counter() - t0) * 1000.0
        size = os.path.getsize(mp4)
        dec = decode_any(mp4, raw_path, w, h, frames)
        ssim = ssim_all(raw_path, src, w, h, fps, frames)
        os.remove(raw_path)
        rows.append({
            "name": name, "codec": "x264-ultrafast", "setting": f"crf={crf}",
            "frames": frames, "size_bytes": size,
            "bitrate_kbps": round(size * 8 / (frames / fps) / 1000.0, 1),
            "ssim_all": ssim,
            "enc_ms_per_frame": round(enc_ms / frames, 3),
            "dec_ms_per_frame": round(dec["msPerFrame"], 3),
        })
        print(f"  x264 crf={crf}: {rows[-1]['bitrate_kbps']} kbps, "
              f"ssim {ssim}, enc {rows[-1]['enc_ms_per_frame']} ms/f")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+")
    ap.add_argument("--name", default=None, help="sequence name (default: file stem)")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--work", default=os.path.join(HERE, "scoreboard-work"))
    ap.add_argument("--qualities", default="40,60,80")
    ap.add_argument("--crfs", default="28,32,36")
    ap.add_argument("--kf", type=int, default=300)
    ap.add_argument("--frames", type=int, default=0, help="cap frames (0 = all)")
    ap.add_argument("--motion", action="store_true")
    ap.add_argument("--lz4", action="store_true")
    ap.add_argument("--refresh", action="store_true", help="enable PR6 intra refresh bands")
    ap.add_argument("--ikf", action="store_true", help="enable PR3 intra DCT keyframes")
    ap.add_argument("--eg", action="store_true", help="enable PR5 Exp-Golomb coefficient coding")
    ap.add_argument("--cs", default="yuv420", choices=["yuv420", "srgb"])
    args = ap.parse_args()
    args.qualities = [int(x) for x in args.qualities.split(",")]
    args.crfs = [int(x) for x in args.crfs.split(",")]
    find_bench()
    os.makedirs(args.work, exist_ok=True)

    baseline = {"rows": [], "meta": {}}
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as f:
            baseline = json.load(f)
        baseline.setdefault("rows", [])
        baseline.setdefault("meta", {})

    baseline["meta"]["lines"] = line_counts()
    baseline["meta"]["generated"] = time.strftime("%Y-%m-%dT%H:%M:%S")

    all_rows = []
    for src in args.sources:
        if not os.path.exists(src):
            die(f"source not found: {src}")
        name = args.name or os.path.splitext(os.path.basename(src))[0]
        w, h, fps, dur, total = probe(src)
        frames = min(total, args.frames) if args.frames else total
        print(f"[{name}] {w}x{h} @ {fps:.2f} fps, {frames} frames "
              f"({dur:.1f} s), cs={args.cs}")
        all_rows += measure_qov(src, name, w, h, fps, dur, frames, args)
        all_rows += measure_x264(src, name, w, h, fps, dur, frames, args)

    key = lambda r: (r["name"], r["codec"], r["setting"])
    baseline["rows"] = sorted([r for r in baseline["rows"] if key(r) not in {key(n) for n in all_rows}] + all_rows,
                              key=key)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(baseline, f, indent=2)
    print(f"scoreboard: {len(all_rows)} rows written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
