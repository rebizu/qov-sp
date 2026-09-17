# QOV Bandwidth Exploration — rate control, perceptual knobs, rungs

Question: after v3.9 the byte layout is at its measured floor (see
`BENCHMARKS.md` §5 and `PFRAME-EXPLORATION.md` §4). What is left inside the
QOI philosophy is **sending less data, not coding the same data harder**.
This plan covers the three remaining levers, in the order they were proposed:

1. **Rate control** — target a bandwidth, not a fixed quality (encoder policy, no spec change)
2. **Perceptual knob sweep** — `temporal_thresh`, AC dead-zone, block-skip threshold (encoder-side constants)
3. **Adaptation rungs** — a 160×120 bottom rung + content-driven frame skip (app/ladder layer)

> **STATUS (SHIPPED 2026-09-17):** §2 and §3a adopted and shipped; §1 kept
> as plumbing; §3b closed.
>
> | item | verdict | numbers (cam720, q60, call settings) |
> |---|---|---|
> | §2 knobs | **SHIPPED as spec v3.11** (dz 1.0 + skip slope ×16, all three encoders) | 260.1 → 197.9 kbps (−23.9%) at SSIM −0.0082; corpus regenerated, conformance GREEN 51×8 |
> | §1 rate control | **KEEP as ladder plumbing** — gate not met on this fixture | regulates −0.8..+6.4%; wash vs best static on homogeneous webcam; burst probe: −15.8% bits with calm-half SSIM unchanged (0.9290 vs 0.9288) |
> | §3a rungs | **SHIPPED** (160×120 stage 2 in TS/C# ladders + call demo) | rung wire 169.5 kbps FEC off / 169.9 at 1:3, ~87 pkt/s; at ~150 kbps 256×192 beats full-frame q40 (0.9185 vs 0.9142) |
> | §3b frame skip | **CLOSED dead end** (pre-registered) | 2/720 near-static frames = 0.2%; at 16.7% drop the frames still cost ~1.1 kB each — framerate cut, not redundancy |
>
> Shipping also exposed and fixed a pre-existing C# encoder defect (partial
> 8×8 blocks were not zero-padded — cs_encode parity broke on
> `odd_dims_yuv420_lossy_dct` at HEAD; TS's blockBuf comment documents the
> requirement) and a stale version assertion in `EncoderTests` (expected
> v2 after the v3.10 single-version flip). Selftest, 45/45 xunit and the
> review suite are green; the dropReference psnr floor moved 20 → 18 with
> the v3.11 constants.
>
> Full rows: `qov-analysis-tools/scoreboard-explore.json`. Drivers:
> `qov-analysis-tools/explore/` (`sweep_knobs.py`, `bench_rc.c`,
> `analyze_rc.py`, `fs_sad.c`). Raw run artifacts under
> `qov-analysis-tools/.build-tmp/explore/` (not tracked).
> BENCHMARKS.md §1d carries the readable summary.

Original plan text follows unchanged.

## Ground rules

- Prototypes live on scratch copies under
  `qov-analysis-tools/.build-tmp/` (the `pframe-explore/.work/` pattern).
  `master`'s `qov.h`, TS and C# encoders are untouched until a gate passes.
- Fixture and method identical to `BENCHMARKS.md`: 30 s of cam720 →
  320×240@24 RGBA, call settings (yuv420, motion + intra-DCT keyframes +
  refresh bands, range coder, structured P-frames), SSIM in the RGBA domain
  against the same decoded source frames for every row.
- Adoption gate per item: **≥5% average bitrate at ≤0.01 average SSIM cost**,
  or ≥+0.01 SSIM at matched bits (the roadmap's ≥5% rule; q60→q80 is
  0.809→0.845, so 0.01 SSIM is a small, defensible spend). Negative results
  are recorded here as measured dead ends, not silently dropped.
- Decoders are untouched by all three items, so old files keep decoding
  regardless of outcome. Only *shipping* a knob changes decoded pixels and
  triggers the 3-encoder parity + corpus regen flow (`npm run corpus
  --force`, review the manifest diff).
- Known fixture limitation: cam720 is webcam content. The knob sweep's
  conclusions may not transfer to sharp screen content (the multi-mode intra
  probe showed directional modes only pay off there). Re-check on a screen
  fixture before shipping any knob.

## Baseline to beat (cam720, call settings, from BENCHMARKS.md §1c)

| row | video kbps | wire (batched) | SSIM |
|---|---:|---:|---:|
| full 320×240, structured, q60 | 260.1 | 338.6 | 0.809 |
| letterbox 256×192 rung, structured, q60 | 197.2 | 274.0 | 0.809 (content region) |

## 1. Rate control (bitrate-targeted quality)

**Premise.** Quality is static q60 today. A call wants a *bandwidth target*;
static quality pays peak-price bytes all the time and spikes on motion
bursts. The v3.6 mid-stream quality change (`qov_set_quality`, qov.h:3448;
per-plane `qp_delta` in the structured grammar) already carries quality
changes in the bitstream — a controller is pure caller policy.

**Design constraints (philosophy).** No lookahead (explicitly rejected as
philosophy-breaking in the roadmap): the controller sees only *past* emitted
bytes, decides at frame granularity, integer-ish math, ~30 lines. Sketch:
EMA-smooth the per-frame video bytes from `bench_stream`'s stderr feed,
`err = target_bpf − ema`, step q by ±1 every N frames with a floor (q30) and
ceiling (q80), minimum dwell of ~4 frames between steps. Design note: frames
where every block skips show no bitrate response to a quality drop — the
dwell period absorbs this; do not chase unresponsive frames.

**Synergy.** `temporal_thresh` derives from quality ((100−q)/12, qov.h:3455),
so lowering quality automatically tightens similarity skips; the controller
gets skip-aggressiveness for free.

**Prototype.** Fork `bench_stream.c` → `bench_rc.c`: extra argv `target_kbps`
(0 = off), per-frame `qov_set_quality`, log `frame vbytes quality` to stderr.
No `qov.h` changes at all.

**Run matrix.**

| run | config |
|---|---|
| static anchors | q40 / q50 / q60 / q70 / q80, controller off |
| controlled | targets 150 / 200 / 250 / 300 kbps video |

**Metrics.** Achieved kbps and regulation error (±% of target after warmup);
average SSIM; *worst 2-second-window* SSIM (does the controller tank the
scene cut worse than static quality, or does static quality overpay
everywhere else); peak-to-average vbytes. Reference point for the ladder
comparison: the demo's existing policy is ±10 quality steps at most 1/s on
network REPORTs (`qov-adaptation.ts:161-184`) — run one row emulating that
step policy against the same budget to show what finer control buys.

**Gate.** At matched average bitrate: ≥+0.01 average SSIM **and** ≥+0.02
worst-window SSIM vs the best static anchor; or at matched average SSIM:
≥5% fewer bits. Regulation within ±10% of target after the first second.

**If adopted.** Nothing in the format — caller policy, same tier as the
adaptation ladder. Optionally a tiny shared helper (`qov_rate_ctl` in C +
`rateController` in TS/C# mirrors) used by the call demo; spec gets at most
a SHOULD note in §4.1. Cheapest adoption of the three.

## 2. Perceptual knob sweep

**Premise.** `PFRAME-EXPLORATION.md` §4 names this as the remaining lever.
Three encoder-side constants control how aggressively blocks are skipped:

| knob | current value | location (qov.h) |
|---|---|---|
| temporal similarity skip | `temporal_thresh = (100−q)/12` → 3 at q60 | 2637, 3455; applied at 2887-2948 (simple) and 3267 (DCT) |
| AC dead-zone | `−0.75 < prod < 0.75` → 0 | 3022 |
| DCT block-skip threshold | `diff < 32 + dct_qp*8` | 3110, 3144, 3195 |

All three are encoder-side normative rules (spec §3.4.2/§3.4.3): changing
them changes which residual is coded, not how anything is decoded.

**Method.** Patch the constants on a scratch `qov.h` (the
`pframe-explore/make_*.py` patch-script pattern), coordinate sweep at fixed
q60 from the baseline:

1. `temporal_thresh`: fixed 3 (current) → 5 → 8 → 12.
2. dead-zone width: 0.75 → 1.0 → 1.5 → 2.0.
3. block-skip: slope ×8 → ×12 → ×16; base 32 → 64.
4. best pair combined, then best triple.

Each run: video kbps, SSIM (RGBA), skip/coded block tally (bench_stream
already prints `blocks_skip`/`blocks_coded`). Keep per-run decoded frames
for eyeballing: the failure mode of a big `temporal_thresh` is frozen/ghosty
regions between refresh-band passes — SSIM may understate it, so the sweep
report includes 3–4 decoded PNGs per candidate at a motion-heavy second.

**Gate.** Per the ground rules; also a hard sanity check that the refresh
cycle visibly repaints (no permanent freeze artifacts) on the best
candidate.

**If adopted.** New constant values in the three encoders (C/TS/C# must stay
bit-identical — these rules exist for multi-encoder parity), spec §3.4.2
text updated, corpus regen via the approval flow. No decoder changes.

## 3. Adaptation rungs + content-driven frame skip

### 3a. 160×120 bottom rung

**Premise.** The 256×192 rung was the single biggest wire cut (−25.6%
video at identical content quality). A smaller bottom rung extends the
ladder for starved channels; smaller chunks also improve the FEC/packet
economics (BENCHMARKS §1b: at rung size, 1:3 parity is ~free).

**Method.** No prototype code needed — `bench_stream` already takes W H:

- `160 120` run, same call settings, q60; wire math via `bench_bandwidth.py`
  (expect most P-frames to fit one 1180 B packet).
- Quality for resolution trade at matched bits: `256 192` at q75/q85 vs
  `160 120` at q60 when both land near the same kbps.
- SSIM: decode, upscale to 320×240, content-region SSIM vs the source
  (same method as BENCHMARKS §1b — ignore whole-frame numbers, the black
  border reads low).

**If adopted.** A second downscale stage in `QovAdaptationController`
(`qov-adaptation.ts` + `QovAdaptation.cs`) and the letterbox path in
`call.ts`. App layer only; no format change. Gate: meaningful step between
rungs (each rung should roughly halve the remaining deficit), content-region
SSIM within ~0.01 of the full-frame rung.

### 3b. Content-driven frame skip

**Premise.** Skip *capture-side* frames when nothing moves, independent of
network state. Expectation from the byte math: a fully static frame already
codes to a near-empty skip chain (~tens of bytes), so the ceiling is low —
this is explored to be closed with numbers, like the Phase 3.5 dead ends.

**Method.** Harness variant that computes inter-frame SAD and drops frames
under threshold (timestamps make this decoder-legal; chunks carry µs
timestamps). Sweep threshold for {0%, ~20%, ~40%} dropped frames on cam720;
report kbps vs drop% and the SSIM-over-time floor.

**Gate (to ship):** ≥5% average bitrate on the fixture **and** no visible
cadence stutter in the decoded frame sequence. Pre-registered expectation:
below gate → recorded as measured dead end.

## Sequencing and effort

| order | item | why this order | effort |
|---|---|---|---|
| 1 | §2 knobs | cheapest (constant sweep on scratch qov.h); must land first so the controller rides tuned constants | ~1 day |
| 2 | §1 rate control | biggest expected lever; pure harness code; stacks on §2 | ~1 day |
| 3 | §3a rung | independent measurements, ladder sketch | ~½ day |
| 4 | §3b frame skip | expected fast close | ~½ day |

## Deliverables

- `qov-analysis-tools/scoreboard-explore-knobs.json`, `-rc.json`, `-rung.json`
- A §1d/§1e/§6 update to `BENCHMARKS.md` with the measured tables (or dead-end
  notes, same as §5)
- This doc's STATUS header updated with adopt/reject + numbers per item
- If adopted: per-item shipping checklist (spec text, 3-impl constants or
  ladder rows, `npm run corpus --force` with reviewed manifest diff)

## Repro

```bash
cd qov-analysis-tools
mkdir -p .build-tmp && cd .build-tmp

# baseline / static anchors (controller off)
gcc -O2 -std=c99 -w -ffp-contract=off -I.. ../bench_stream.c ../qov.h -lm -o bench_stream
ffmpeg -t 30 -i ../corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
  -f rawvideo -pix_fmt rgba - | ./bench_stream 320 240 24 720 16000 1 60 1 1 1 1 \
  > q60.bin 2> q60.txt
python3 ../bench_bandwidth.py q60.bin q60.txt 24 30 16000 1

# knobs: scratch qov.h with patched constants (pframe-explore pattern)
mkdir -p kn && cp ../qov.h kn/ && cp ../bench_stream.c kn/
python3 ../explore/make_knob_patch.py --deadzone 1.5 --skip-slope 12   # to be written
gcc -O2 -std=c99 -w -ffp-contract=off -Ikn kn/bench_stream.c kn/qov.h -lm -o bench_knob

# rate control: bench_rc.c fork (extra argv target_kbps, logs quality)
gcc -O2 -std=c99 -w -ffp-contract=off -I.. ../explore/bench_rc.c ../qov.h -lm -o bench_rc
ffmpeg -t 30 -i ../corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
  -f rawvideo -pix_fmt rgba - | ./bench_rc 320 240 24 720 16000 1 60 1 1 1 1 220 \
  > rc220.bin 2> rc220.txt

# 160x120 rung
ffmpeg -t 30 -i ../corpus-real/cam720.mkv -vf scale=160:120 -r 24 \
  -f rawvideo -pix_fmt rgba - | ./bench_stream 160 120 24 720 16000 1 60 1 1 1 1 \
  > rung.bin 2> rung.txt
python3 ../bench_bandwidth.py rung.bin rung.txt 24 30 16000 1

# SSIM rows: scoreboard.py decode+ssim plumbing (RGBA domain, same source frames)
python3 ../scoreboard.py ../corpus-real/cam720.mkv --qualities 40,50,60,70,80
```
