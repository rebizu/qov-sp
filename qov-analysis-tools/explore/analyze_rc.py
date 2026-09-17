#!/usr/bin/env python3
"""BANDWIDTH-EXPLORATION §1: analyze one bench_rc run (kbps, regulation,
SSIM mean + worst 2 s window, quality trace)."""
import json
import re
import subprocess
import sys
import os

WORK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    ".build-tmp", "explore")


def ssim_series(qov_path, frames=720, ref="cam320.raw"):
    rgba = qov_path.replace(".qov", ".rgba")
    subprocess.run([os.path.join(WORK, "bench_decode"), "decode",
                    "--in", qov_path, "--rawout", rgba],
                   check=True, capture_output=True)
    r = subprocess.run(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                        "-s", "320x240", "-r", "24", "-i", rgba,
                        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "320x240",
                        "-r", "24", "-i", os.path.join(WORK, ref),
                        "-frames:v", str(frames), "-filter_complex",
                        "[0]format=yuv444p[a];[1]format=yuv444p[b];[a][b]ssim,metadata=print:file=-",
                        "-f", "null", "-"], capture_output=True, text=True)
    vals = [float(m) for m in re.findall(r"lavfi\.ssim\.All=([0-9.]+)", r.stdout)]
    os.remove(rgba)
    # the ssim filter flushes one extra stats line past -frames:v at EOF
    if len(vals) < frames:
        sys.exit(f"ssim frames {len(vals)} < {frames}")
    vals = vals[:frames]
    return vals


def main():
    tag = sys.argv[1]
    target = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    ref = sys.argv[3] if len(sys.argv) > 3 else "cam320.raw"
    nframes = int(sys.argv[4]) if len(sys.argv) > 4 else 720
    frames, vbytes_, qs = [], [], []
    for line in open(os.path.join(WORK, f"{tag}.txt")):
        p = line.split()
        if len(p) == 5 and p[0].isdigit():
            frames.append(int(p[0])); vbytes_.append(int(p[1])); qs.append(int(p[4]))
        elif line.startswith("DONE"):
            done = dict(kv.split("=") for kv in line.split()[1:])
    total_v = int(done["video"])
    kbps = round(total_v * 8 / 30 / 1000, 1)
    v = vbytes_
    p2a = round(max(v) / (sum(v) / len(v)), 2)
    row = {"tag": tag, "target": target, "video_kbps": kbps,
           "peak_to_avg": p2a,
           "q_min": min(qs), "q_max": max(qs), "q_changes":
           sum(1 for a, b in zip(qs, qs[1:]) if a != b)}
    if target > 0:
        row["regulation_err_pct"] = round((sum(v[48:]) / len(v[48:]) - target * 1000 / 8 / 24) /
                                          (target * 1000 / 8 / 24) * 100, 1)
    qov = os.path.join(WORK, f"{tag}.qov")
    d = open(os.path.join(WORK, f"{tag}.bin"), "rb").read()
    pos = 0
    while pos + 10 <= len(d) and d[pos:pos + 4] != b"qovf":
        pos += 10 + int.from_bytes(d[pos + 2:pos + 6], "big")
    open(qov, "wb").write(d[pos:pos + 32] + d[:pos] + d[pos + 32:])
    vals = ssim_series(qov, nframes, ref)
    w = 48
    row["ssim_all"] = round(sum(vals) / len(vals), 4)
    row["ssim_worst2s"] = round(min(sum(vals[i:i + w]) / w for i in range(len(vals) - w)), 4)
    row["ssim_first_half"] = round(sum(vals[:len(vals) // 2]) / (len(vals) // 2), 4)
    row["ssim_second_half"] = round(sum(vals[len(vals) // 2:]) / (len(vals) - len(vals) // 2), 4)
    os.remove(os.path.join(WORK, f"{tag}.bin"))
    os.remove(qov)
    with open(os.path.join(WORK, "rc_rows.jsonl"), "a") as f:
        f.write(json.dumps(row) + "\n")
    print(json.dumps(row))


if __name__ == "__main__":
    main()
