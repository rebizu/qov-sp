# QOV Benchmarks

Measured **2026-09-16** on the shipped spec v3.8 codec (Phase 3.5: order-0
adaptive range coder enabled on DCT chunks). Raw numbers live in
`qov-analysis-tools/scoreboard-*.json`; this document is the readable
summary and the repro recipe.

## Fixture & method

- **Source:** 30 s of real webcam footage (`qov-analysis-tools/corpus-real/cam720.mkv`,
  FFV1 1280x720@30), scaled to 320x240@24 RGBA — the QOV call demo settings.
- **QOV stream settings:** yuv420, quality 60, motion + intra-DCT keyframes +
  rolling refresh bands, range coder on (LZ4 off), keyframe every 120 frames,
  mono 16 kHz speech audio on its own capture clock.
- **Quality metric:** SSIM (All), computed in the **RGBA domain** against the
  identical decoded source frames for every format — QOV, x264 and AV1 rows
  are directly comparable. (Some x264 rows in older scoreboards used the
  yuv domain and are marked.)
- **Wire math:** exact QOV-S datagram mode — 1180 B fragments, 20 B headers,
  XOR parity per FEC group (`bench_bandwidth.py`).
- **Speed:** C reference (`qov.h`) compiled `-O2`, single thread. QOV decode
  includes a per-frame SHA-256 hash; ffmpeg decode is multithreaded with
  hand-tuned asm. Take the speed columns as architecture, not
  nanosecond, comparisons.

## 1. Call bandwidth (QOV-S, measured)

| stream | Phase 3 (LZ4) | v3.8 (range coder) | delta |
|---|---:|---:|---:|
| video 320x240@24 q60 | 557.0 kbps | **453.5 kbps** | −18.6% |
| call media (video + QOA speech) | 626.0 kbps | 522.5 kbps | −16.5% |
| wire, FEC off (NACK only) | 647.5 kbps | **541.9 kbps** | −16.3% |
| wire, FEC 1:4 | 662.5 kbps | **544.2 kbps** | −17.9% |
| wire, FEC 1:3 | 860.6 kbps | 645.7 kbps | −25.0% |

The range coder is lossless on the quantized stream: decoded pixels are
bit-identical to the LZ4 path (conformance-verified across the TS, C and C#
implementations), so the entire column is free quality.

FEC 1:3 improves the most because parity is charged per packet group;
smaller video chunks change the packet-count economics, not just the bytes.

**Speech codec options** (added in Phase 3 / 3.5):

| audio codec | media | wire (single-packet chunks) |
|---|---:|---:|
| QOA speech mono 16 kHz (format default) | 69.0 kbps | ~72 kbps |
| QOA music mono 48 kHz | 207.0 kbps | ~212 kbps |
| QOA music stereo 48 kHz | 387.0 kbps | ~396 kbps |
| Opus speech 16 kHz (demo, WebCodecs) | ~24 kbps | ~36 kbps |

QOA bitrates are content-independent (fixed-size frames). A voice+video
call with the Opus demo path lands around **~490 kbps wire with FEC on**.

**Silence suppression** (Phase 3.6, demo-level, Opus path): chunks whose
20 ms window sits under ~-48 dBFS RMS are dropped at output, with a
keep-alive chunk every ~400 ms; the encoder itself is never starved, so
post-silence packets stay glitch-free. Browser-verified with a live
mic: 88-92% of chunks suppressed in a quiet room — audio wire drops
from ~36 kbps to ~4 kbps (6 packets/s × ~90 B) while the guest plays
exactly what is sent with zero decoder errors. QOA has no silence
mechanism by design (fixed-rate format; the Opus path supersedes it).

## 2. Speed (C reference, single thread)

| stage | LZ4 | range coder |
|---|---:|---:|
| encode (720 frames + 1875 audio chunks) | 180 fps | 163 fps |
| decode (same stream, incl. per-frame SHA-256) | ~309 fps | **263 fps** |

Still >10x realtime in both directions at call settings. This was the
design constraint of the entropy work: lighter format, no speed tax that
matters.

## 3. Quality ladder (quality knob verified working)

An earlier note claimed q60 == q80 "saturates" at 320x240 — that was a
harness artifact (the q80 run predated the harness quality argument and
silently re-encoded at q60; see `scoreboard-format-comparison.json`).

| quality | bitrate | SSIM (RGBA) |
|---|---:|---:|
| q60 (demo default) | 453.5 kbps | 0.809 |
| q80 | 619.0 kbps | 0.845 |
| q95 | 1141.4 kbps | 0.880 |

## 4. QOV vs x264 / AV1 (same footage, same SSIM domain, all re-measured today)

| format | settings | bitrate | SSIM (RGBA) |
|---|---|---:|---:|
| QOV | q60 demo settings | 453.5 kbps | 0.809 |
| QOV | q80 | 619.0 kbps | 0.845 |
| QOV | q95 | 1141.4 kbps | 0.880 |
| x264 | veryfast crf44 | 6.4 kbps | 0.774 |
| x264 | veryfast crf40 | **8.1 kbps** | **0.833** |
| x264 | veryfast crf32 | 16.7 kbps | 0.917 |
| x264 | veryfast crf26 | 34.3 kbps | 0.952 |
| SVT-AV1 | preset 10 crf50 | 28.1 kbps | 0.958 |

**Reading it honestly:**

- At nearly matched quality (x264 crf40 SSIM 0.833 vs QOV q60 0.809),
  x264 needs **8.1 kbps where QOV needs 453.5** — a ~55x compression gap.
- At SSIM ~0.95, x264 is 34.3 kbps and AV1 28.1 kbps; QOV has no row
  there at 320x240 (q95 tops out at 0.880) and would cost multiples more.
- Decode speed goes the other way: QOV decodes 263 fps single-threaded
  *including hashing*; x264/AV1 decode is multithreaded asm. QOV's pitch
  is not compression efficiency — it is the QOI philosophy: one-header C
  codec, integer math, one-pass deterministic decode, three bit-exact
  reference implementations, zero license encumbrance.

## 5. Why there is no more (measured)

Phase 3.5's Tier-2 ideas were built or probed and closed with numbers
(`CONFERENCE-ROADMAP.md`):

- **MV median-delta prediction:** MV+refresh sections are 25–30% of raw
  video bytes, but coding them as Exp-Golomb deltas measured −10% raw /
  **+0.3% after the range coder** — the adaptive byte model already codes
  zero-heavy MV maps below the entropy of predicted deltas. Reverted.
- **Order-1 contexts:** gzip -9 applied on top of the range-coded DCT
  payloads recovers **0.0%**. The order-0 model is at the byte-level
  entropy floor of this layout.

Going further (CABAC-class coding, B-frames, rate-distortion search)
would break the speed/simplicity contract the format exists for.

## Reproduce

```bash
cd qov-analysis-tools
gcc -O2 -std=c99 -w -ffp-contract=off -I.. bench_stream.c ../qov.h -lm -o .build-tmp/bench_stream

# encode the 30 s fixture into QOV streams (argv: W H FPS frames audio_rate
# audio_ch quality range motion refresh); run twice, range 0 and 1
ffmpeg -t 30 -i corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
       -f rawvideo -pix_fmt rgba - | .build-tmp/bench_stream 320 240 24 720 16000 1 60 0 \
       > range_before.bin 2> range_before.txt
ffmpeg -t 30 -i corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
       -f rawvideo -pix_fmt rgba - | .build-tmp/bench_stream 320 240 24 720 16000 1 60 1 \
       > range_after.bin 2> range_after.txt

python3 bench_range_compare.py range_before.bin range_before.txt \
                               range_after.bin  range_after.txt   # wire table + scoreboard
python3 bench_bandwidth.py range_after.bin range_after.txt 24 30 16000 1  # per-config table

# x264 / AV1 rows (same source frames):
ffmpeg -t 30 -i corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
       -f rawvideo -pix_fmt rgba -s 320x240 -r 24 -i cam.raw
ffmpeg -f rawvideo -pix_fmt rgba -s 320x240 -r 24 -i cam.raw \
       -c:v libx264 -preset veryfast -crf 40 -pix_fmt yuv420p out.mkv
ffmpeg -i out.mkv -f rawvideo -pix_fmt rgba -s 320x240 -r 24 -i cam.raw \
       -lavfi "[0]format=rgba[a];[1]format=rgba[b];[a][b]ssim" -f null -
```

See also: `qov-analysis-tools/README.md` (conformance suite),
`CONFERENCE-ROADMAP.md` (what was tried and why the format is shaped
this way).
