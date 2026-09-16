#!/usr/bin/env python3
"""Structured P-frame stacked-call benchmark (spec v3.9 section 3.4.6).

Runs: full 320x240 and letterbox 256x192 (padded to 320x240) encodes of the
same footage, v1 vs structured grammar, then computes exact QOV-S wire
numbers with plain audio and with type-0x03 batched audio (datagrams of
<=1180 B payload: 10-byte batch chunk header + [u16 len][chunk] per member;
speech cadence -> 8 chunks per datagram). Wire math per bench_bandwidth.py;
audio packets never join FEC groups (same as the v3.6 scoreboard).

Prerequisites (four bench_stream runs, argv[11] = structured):
  ffmpeg -t 30 -i corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
         -f rawvideo -pix_fmt rgba - | .build/bench_stream 320 240 24 720 16000 1 60 1 1 1 0 \
         > .build-tmp/pf_full_v1.bin 2> .build-tmp/pf_full_v1.txt
  # ... argv[11]=1 -> pf_full_st.*, letterbox pipeline:
  #   -vf scale=256:192,pad=320:240:32:24  ->  pf_lb_v1.* / pf_lb_st.*

Usage:
  python3 bench_structured_stack.py
"""
import json
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from bench_bandwidth import media_chunks, wire_bytes, QOV_CLI, TOOLS as T2  # noqa: E402

SECONDS = 30.0
BATCH_PAYLOAD_CAP = 1180
BATCH_CHUNK_HDR = 10  # the type-0x03 batch chunk's own header
RUNS = [("full 320x240 v1", "pf_full_v1"),
        ("full 320x240 structured", "pf_full_st"),
        ("letterbox 256x192 v1", "pf_lb_v1"),
        ("letterbox 256x192 structured", "pf_lb_st")]


def video_bytes(stats_path):
    per = [l.split() for l in Path(stats_path).read_text().splitlines()
           if l and l[0].isdigit()]
    return sum(int(f[1]) for f in per) + sum(int(f[3]) for f in per)


def split_chunks(parts):
    chunks, media_bytes = media_chunks(parts)
    video_sync = [(t, s) for t, s in chunks if t != 0x10]
    audio = [s for t, s in chunks if t == 0x10]
    return video_sync, audio, media_bytes


def batched_audio_wire(audio_sizes):
    """Type-0x03 datagrams: payload = 10 B batch chunk header + sum(2 + len).
    One fragment per datagram (<=1180), one packet per datagram, no FEC."""
    wire = 0
    packets = 0
    payload = BATCH_CHUNK_HDR
    for s in audio_sizes:
        entry = 2 + s
        if payload + entry > BATCH_PAYLOAD_CAP:
            wire += 20 + payload
            packets += 1
            payload = BATCH_CHUNK_HDR
        payload += entry
    if payload > BATCH_CHUNK_HDR:
        wire += 20 + payload
        packets += 1
    return wire, packets


def measure(tag):
    parts = Path(T2 / ".build-tmp" / f"{tag}.bin").read_bytes()
    stats = T2 / ".build-tmp" / f"{tag}.txt"
    video_sync, audio_sizes, media_bytes = split_chunks(parts)

    header = parts[media_bytes:media_bytes + 32]
    assert header[:4] == b"qovf", "header not found"
    f = T2 / ".build" / f"pf_check_{tag}.qov"
    f.write_bytes(header + parts[:media_bytes] + parts[media_bytes + 32:])
    dec = subprocess.run([str(QOV_CLI), "decode", str(f)], capture_output=True, text=True)
    assert dec.returncode == 0, f"{tag}: decode failed: {dec.stderr[-300:]}"
    info = json.loads(dec.stdout)

    v = video_bytes(stats)
    wv_off, video_pkts, _ = wire_bytes(video_sync, 0)
    wv_14, _, _ = wire_bytes(video_sync, 4)
    wa_plain, ap_plain = sum(20 + s for s in audio_sizes), len(audio_sizes)
    wa_batch, ap_batch = batched_audio_wire(audio_sizes)
    kb = lambda b: b * 8 / SECONDS / 1000
    return {
        "video kbps": round(kb(v), 1),
        "media kbps": round(kb(media_bytes), 1),
        "wire plain FEC off kbps": round(kb(wv_off + wa_plain), 1),
        "wire batched FEC off kbps": round(kb(wv_off + wa_batch), 1),
        "wire batched FEC 1:4 kbps": round(kb(wv_14 + wa_batch), 1),
        "packets per second plain": round((video_pkts + ap_plain) / SECONDS, 1),
        "packets per second batched": round((video_pkts + ap_batch) / SECONDS, 1),
        "audio chunks": len(audio_sizes),
        "decode": {"frames": info["frames"], "audio_chunks": info["audioFrames"]},
    }


def main() -> int:
    rows = {}
    for label, tag in RUNS:
        rows[label] = measure(tag)
        r = rows[label]
        print(f"{label:<32} video {r['video kbps']:7.1f} kbps | wire plain {r['wire plain FEC off kbps']:7.1f}"
              f" | batched {r['wire batched FEC off kbps']:7.1f} (fec14 {r['wire batched FEC 1:4 kbps']:7.1f})"
              f" | pkts/s {r['packets per second plain']:6.1f} -> {r['packets per second batched']:6.1f}"
              f" | decode {r['decode']['frames']}f/{r['decode']['audio_chunks']}a OK")
    fv, fs = rows["full 320x240 v1"], rows["full 320x240 structured"]
    lv, ls = rows["letterbox 256x192 v1"], rows["letterbox 256x192 structured"]
    print(f"\nstructured delta, video: full {fv['video kbps']} -> {fs['video kbps']} kbps"
          f" ({(fs['video kbps'] / fv['video kbps'] - 1) * 100:+.1f}%),"
          f" letterbox {lv['video kbps']} -> {ls['video kbps']} kbps"
          f" ({(ls['video kbps'] / lv['video kbps'] - 1) * 100:+.1f}%)")
    print(f"stacked best (letterbox+structured, batched, fec off): {ls['wire batched FEC off kbps']} kbps,"
          f" fec 1:4 {ls['wire batched FEC 1:4 kbps']} kbps")

    out = T2 / "scoreboard-phase3.9-call.json"
    out.write_text(json.dumps({
        "comment": "Phase 3.9 structured P-frame stacked-call benchmark: v1 vs structured grammar (chunk flag "
                   "0x04) at call settings (320x240@24 q60 yuv420 motion+ikf+refresh, range coder, keyframe "
                   "every 120, mono 16 kHz speech), full frame and letterbox 256x192 step-down rung input. "
                   "Wire math per bench_bandwidth.py; batched audio groups QOA chunks into type-0x03 datagrams "
                   "of <=1180 B payload (8 chunks each for speech cadence), no FEC on audio. Reproduce with "
                   "bench_stream.c (argv[11]) + bench_structured_stack.py.",
        "settings": {"fps": 24.0, "seconds": 30.0, "audio_rate": 16000, "audio_ch": 1},
        "rows": rows,
    }, indent=1))
    print(f"wrote {out.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
