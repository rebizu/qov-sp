#!/usr/bin/env python3
"""Phase 3 bandwidth benchmark (spec v3.7 section 5.3 + qov-streaming-spec).

Measures the wire bandwidth of a QOV-S call stream built from REAL webcam
footage (corpus-real/cam720.mkv, FFV1 1280x720@30) encoded at the demo
settings (320x240@24, yuv420, q60, motion + intra-DCT keyframes + intra
refresh, LZ4, keyframe every 120) plus mono 16 kHz speech audio.

Usage:
  ffmpeg -t 30 -i corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
         -f rawvideo -pix_fmt rgba - | .build/bench_stream 320 240 24 720 16000 1 \
         > parts.bin 2> stats.txt
  python3 bench_bandwidth.py parts.bin stats.txt 24 30 16000 1

parts.bin layout (bench_stream.c): [media chunks][header(32)][index+END].
Outputs the bandwidth table and writes scoreboard-phase3-audio.json.
"""
import json
import math
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
QOV_CLI = TOOLS / ".build" / "qov_cli.exe"
FRAG = 1180          # max fragment payload, spec section 3
HDR = 20             # QOV-S packet header
CHUNK_HDR = 10       # QOV chunk header
QOA_CHUNK = CHUNK_HDR + 8 + 16 + 13 * 8  # 138 B: mono QOA frame chunk


def media_chunks(parts: bytes):
    """Walk the leading chunk stream -> [(type, total_chunk_bytes)]."""
    out, pos = [], 0
    while pos + CHUNK_HDR <= len(parts):
        t = parts[pos]
        size = int.from_bytes(parts[pos + 2:pos + 6], "big")
        if t not in (0x00, 0x01, 0x02, 0x03, 0x10):
            break  # reached the trailing file header
        if pos + CHUNK_HDR + size > len(parts):
            break
        out.append((t, CHUNK_HDR + size))
        pos += CHUNK_HDR + size
    return out, pos


def wire_bytes(chunks, fec_group: int):
    """Exact QOV-S datagram-mode wire bytes for the measured chunk stream.

    Per chunk (one frame): fragments of <=1180 payload + 20-byte header.
    XOR parity per full group of same-frame packets: one packet of
    (max member bytes) per group — computed exactly per chunk. Audio and
    sync chunks are single-packet frames and never form a group.
    """
    wire = 0
    packets = 0
    parity = 0
    for t, size in chunks:
        n = max(1, math.ceil(size / FRAG))
        pkts = [HDR + min(FRAG, size - i * FRAG) for i in range(n)]
        wire += sum(pkts)
        packets += n
        if t != 0x10 and fec_group in (3, 4):
            for g in range(len(pkts) // fec_group):
                grp = pkts[g * fec_group:(g + 1) * fec_group]
                p = max(grp) + HDR
                wire += p
                parity += p
    return wire, packets, parity


def main() -> int:
    parts_path, stats_path = sys.argv[1], sys.argv[2]
    fps, seconds = float(sys.argv[3]), float(sys.argv[4])
    audio_rate, audio_ch = int(sys.argv[5]), int(sys.argv[6])
    parts = Path(parts_path).read_bytes()
    per_frame = [l.split() for l in Path(stats_path).read_text().splitlines()
                 if l and l[0].isdigit()]

    rows, lines = {}, []

    def row(label, value, note=""):
        lines.append(f"{label:<44} {value:>12}  {note}")
        rows[label] = value

    # ---- reassemble and decode-verify the stream
    chunks, media_bytes = media_chunks(parts)
    header = parts[media_bytes:media_bytes + 32]
    if header[:4] != b"qovf":
        print("FATAL: header not at end of chunk stream", file=sys.stderr)
        return 1
    tail = parts[media_bytes + 32:]
    stream_file = TOOLS / ".build" / "bench_stream.qov"
    stream_file.write_bytes(header + parts[:media_bytes] + tail)
    dec = subprocess.run([str(QOV_CLI), "decode", str(stream_file)],
                         capture_output=True, text=True)
    if dec.returncode != 0:
        print("FATAL: assembled stream does not decode\n" + dec.stderr, file=sys.stderr)
        return 1
    info = json.loads(dec.stdout)
    lines.append(f"stream decode check: {info['frames']} video frames, "
                 f"{info['audioFrames']} audio chunks decoded - OK")
    lines.append("")

    # ---- video (measured, includes sync chunks)
    v = sum(int(f[1]) for f in per_frame) + sum(int(f[3]) for f in per_frame)
    row("video 320x240@24 q60 (measured)", f"{v * 8 / seconds / 1000:.1f} kbps",
        f"{v} B over {seconds:.0f}s")

    # ---- audio configurations (QOA frames are fixed-size: content-independent)
    for label, rate, ch in [("speech mono 16 kHz", 16000, 1),
                            ("music mono 48 kHz", 48000, 1),
                            ("music stereo 48 kHz", 48000, 2)]:
        qoa_frame = 8 + 16 * ch + math.ceil(256 / 20) * 8 * ch
        chunk = CHUNK_HDR + qoa_frame
        cps = rate / 256
        kbps = chunk * cps * 8 / 1000
        raw = rate * ch * 16 / 1000
        row(f"audio {label}", f"{kbps:.1f} kbps",
            f"{chunk} B x {cps:.1f}/s vs raw PCM {raw:.0f} kbps ({kbps / raw * 100:.0f}%)")

    # ---- audio as measured in the stream (sample-clock cadence)
    audio_chunks_n = sum(1 for t, _ in chunks if t == 0x10)
    a_bytes = sum(s for t, s in chunks if t == 0x10)
    a_cps = audio_chunks_n / seconds
    a_kbps = a_bytes * 8 / seconds / 1000
    expect_cps = audio_rate / 256 / 1  # mono
    row("audio speech mono 16 kHz (measured)", f"{a_kbps:.1f} kbps",
        f"{audio_chunks_n} chunks, {a_cps:.1f}/s (expect {expect_cps:.1f}/s)")

    # ---- call total (measured video + measured speech)
    row("call media (video + speech 16k)", f"{v * 8 / seconds / 1000 + a_kbps:.1f} kbps",
        f"video {v * 8 / seconds / 1000:.1f} + audio {a_kbps:.1f}")

    # ---- QOV-S wire (exact, over the measured chunk stream incl. audio)
    media_bytes_total = media_bytes
    lines.append("")
    for label, grp in [("wire FEC off (NACK only)", 0),
                       ("wire FEC 1:4", 4), ("wire FEC 1:3", 3)]:
        w, pkts, parity = wire_bytes(chunks, grp)
        overhead = (w - media_bytes_total) / media_bytes_total * 100
        row(label, f"{w * 8 / seconds / 1000:.1f} kbps",
            f"{pkts} pkt (~{pkts / seconds:.0f}/s), "
            f"parity {parity * 8 / seconds / 1000:.1f} kbps, +{overhead:.1f}%")

    print("\n".join(lines))

    out = TOOLS / "scoreboard-phase3-audio.json"
    out.write_text(json.dumps({
        "comment": "Phase 3 audio bandwidth benchmark. 30s of real webcam footage "
                   "(corpus-real/cam720.mkv) at call settings (320x240@24 q60 yuv420 "
                   "motion+ikf+refresh+lz4, keyframe every 120) + mono 16 kHz speech. "
                   "Wire = QOV-S datagram mode (1180 B fragments, 20 B headers, XOR "
                   "FEC per qov-streaming-spec section 5.2), computed exactly from "
                   "the measured chunk size distribution. QOA bitrates are "
                   "content-independent (fixed-size frames). Reproduce with "
                   "bench_stream.c + bench_bandwidth.py.",
        "settings": {"fps": fps, "seconds": seconds, "audio_rate": audio_rate,
                     "audio_ch": audio_ch, "video_bytes": v,
                     "media_chunks": len(chunks)},
        "rows": rows,
    }, indent=1) + "\n")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
