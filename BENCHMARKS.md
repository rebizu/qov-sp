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

**Audio batching** (Phase 3.6, QOV-S spec v2.1 packet type 0x03):
consecutive audio chunks share one datagram (`[u16 len][chunk]` entries,
one seq/frame_id per batch), cutting speech from ~62 to ~8 audio
packets/s. Wire effect on the measured stream: QOA speech 84 → 71.3
kbps (−12.7), and on a real network another ~12 kbps from 54 fewer
IP/UDP headers per second. Verified in the selftest (61 chunks → 9
packets, order preserved, NACK recovers a lost batch whole) and live in
the demo; the fix it forced — phantom `frame_id` holes now adopt the
retransmitted packet's media type — closed a latent out-of-order
delivery bug on any async network.

## 1b. Phase 3.6 call configuration (measured 2026-09-16)

The three shipped knobs stack. Same fixture, same method as above; the
letterbox row is the step-down rung's actual encoder input (source
pre-scaled to 256x192, padded to 320x240), and "batched" groups speech
into type-0x03 datagrams of 8 chunks (spec v2.1 §3.1).

| call configuration | wire, FEC off | wire, FEC 1:4 | packets/s |
|---|---:|---:|---:|
| full 320x240, plain audio (Phase 3 baseline) | 541.9 kbps | 544.2 kbps | 122 |
| full 320x240, batched audio | 536.8 kbps | 539.1 kbps | 83 |
| letterbox rung, plain audio | 423.9 kbps | 425.8 kbps | 111 |
| letterbox rung, batched audio | **418.7 kbps** | **420.6 kbps** | **72** |

- The step-down rung cuts video bytes **−25.6%** (453.5 → 337.1 kbps)
  at identical content quality: content-region SSIM 0.8093 vs the
  full-frame 0.809 — the picture gets smaller, not worse. (Whole-frame
  SSIM on a letterboxed stream reads low purely from the zero-variance
  black border; ignore it.)
- Batching saves ~5 kbps of QOV-S header at speech cadence and ~38–50
  packets/s — on a real network another ~12 kbps of IP/UDP headers.
- With the Opus+DTX demo path (silence suppressed to ~6 keep-alive
  packets/s, measured), a quiet-room call is ~458 kbps wire, and
  ~341 kbps with the rung engaged — inside the ~350–400 kbps target
  from the Phase 3.6 plan.
- Small frames also change FEC economics: at letterbox size, 1:3 costs
  almost nothing (~2 kbps parity) because frames fit one packet.

Raw rows in `scoreboard-phase3.6-call.json`.

## 1c. Structured P-frames (v3.9, measured 2026-09-16)

The structured P-frame grammar (spec §3.4.6, chunk flag 0x04) removes the
per-block opcode, per-block qp delta and SKIP-tag bytes the order-0 range
coder cannot exploit — measured at ~35% of the RC'd payload (exact
byte-attribution profile, `qov-analysis-tools/pframe-explore/`). The
decoded pixels are bit-identical to the v1 grammar by construction; only
the framing changes.

| quality | P-frame bytes/frame v1 | structured | delta |
|---|---:|---:|---:|
| q30 | 1745.9 | 910.9 | −47.8% |
| q50 | 2009.7 | 1108.3 | −44.9% |
| q60 (call default) | 2316.3 | 1301.0 | **−43.8%** |
| q85 | 3590.1 | 2335.7 | −34.9% |

- Video payload at call settings: **451.5 → 258.2 kbps (−42.8%)**,
  keyframes unchanged. Stacked with the §1b rung + batching, the quiet
  call estimate drops to roughly ~230 kbps wire.
- SSIM is unchanged (identical pixels): 0.809 at q60.
- The 2% worst-case q85 gap vs lower qualities is the skip-run chains:
  high-quality frames code more blocks, so the per-block chain bytes are
  a bigger share.
- Measured speed (six runs per grammar, reproducible via
  `bench_speed.c`, see section 2): encode unchanged (~143–146 fps both
  grammars), decode **~285 → ~301 fps (+5%)** — the smaller range-coded
  payload and fewer grammar bytes make structured slightly faster to
  decode, with identical decoded pixels (checksum-verified).

### Stacked call configuration (all knobs on, measured 2026-09-16)

v1 vs structured grammar at identical settings, full frame and the
letterbox step-down rung input (256x192 padded to 320x240); "batched" is
the type-0x03 audio datagram model of section 1b (8 QOA chunks per
datagram). v1 rows reproduce the section 1b scoreboard within 0.1 kbps,
so the columns are directly comparable.

| call configuration | video | wire plain | wire batched | batched FEC 1:4 | packets/s plain -> batched |
|---|---:|---:|---:|---:|---:|
| full 320x240, v1 grammar | 453.5 | 541.9 | 534.8 | 537.1 | 121.8 -> 67.1 |
| full 320x240, structured | 260.1 | 345.8 | 338.6 | 340.6 | 103.9 -> 49.2 |
| letterbox rung, v1 grammar | 339.1 | 425.9 | 418.8 | 420.7 | 111.0 -> 56.3 |
| letterbox rung, structured | **197.2** | 281.1 | **274.0** | **276.0** | 93.3 -> **38.7** |

- The full stack (structured + rung + batching) lands at **274.0 kbps**
  wire, FEC off; 276.0 kbps with FEC 1:4 — **−49.4%** vs the Phase 3
  range-coder baseline (541.9) and **−57.7%** vs the LZ4 era (647.5),
  at identical content quality (SSIM 0.809; structured pixels are
  bit-identical).
- With the Opus+DTX quiet-room audio path (4.3 kbps measured in the
  demo) instead of continuous QOA speech, the stacked call is
  ~206 kbps wire.
- Packet rate also halves (93 -> 39/s at the rung): fewer datagrams is
  fewer IP/UDP headers on a real network and cheaper loss recovery.

Raw rows in `scoreboard-phase3.9-call.json`; reproduce with
`bench_stream.c` (argv[11]) + `bench_structured_stack.py`.

Format exploration history, the dead ends (DC delta prediction, Exp-Golomb
under the range coder) and the two decoder defects the work exposed (EOB
swallowed at zigzag 63; 255-chain accumulation) are documented in
`PFRAME-EXPLORATION.md`.

## 2. Speed (C reference, single thread)

| stage | LZ4 | range coder | range + structured (v3.9) |
|---|---:|---:|---:|
| encode (720 frames + 1875 audio chunks) | 180 fps | 163 fps | ~146 fps |
| decode (same stream, incl. per-frame checksum) | ~309 fps | 263 fps | **~301 fps** |

The structured column is from the reproducible `bench_speed.c` harness
(six invocations per grammar; its v1 pair measures ~143 fps encode /
~285 fps decode). That harness includes per-frame chunk extraction in
the timed encode loop, so its absolute numbers sit slightly below the
older LZ4/range rows — compare within a column pair, not across
harnesses.

Still >10x realtime in both directions at call settings. This was the
design constraint of the entropy work: lighter format, no speed tax that
matters — structured is ~5% faster to decode (smaller range-coded
payload, fewer grammar bytes) and encode-neutral.

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

A fourth probe, **multi-mode intra prediction** (best of DC/H/V per
block), measured +0.4% on the real fixture — DC prediction is already
near-optimal for webcam gradients. Going further (CABAC-class coding,
B-frames, rate-distortion search) would break the speed/simplicity
contract the format exists for.

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
