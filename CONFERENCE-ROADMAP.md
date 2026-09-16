# QOV Conference Roadmap — Execution Copy

> This is the approved plan ("QOI-Philosophy Edition", approved 2026-09-14),
> checked in so it travels with the repo. Execution status is kept at the top;
> the original plan text follows unchanged below.

## Execution status (2026-09-15)

| item | state |
|---|---|
| Phase 0 scoreboard | SHIPPED — commits c8c9761, 746d270, 9f33191; baseline in `qov-analysis-tools/scoreboard-baseline.json` (pre-PR2 rows) + `scoreboard-pr2.json`, `scoreboard-pr6.json`, `scoreboard-pr5.json` |
| Streaming DCT path | SHIPPED — d38b41c + a9ed0ea (expected_failures.json empty) |
| PR1 perceptual quant knob | DEMOTED with measured reason — weight 1+(u+v)/7 cost cam720 +11% bitrate at SSIM 0.865→0.578 (reference-drift amplification); do not revisit without an in-loop restore idea |
| PR2 dead-zone + QP-scaled skip | SHIPPED — 9514e85; cam720 q60 18733→10271 kbps |
| PR3 intra DCT keyframes (ikf) | SHIPPED — a67c83e; opt-in, keyframe −83.5% on camera; screen regression → opt-in |
| PR6 intra refresh bands | SHIPPED — b57e653; spec v3.4 §3.4.4; opt-in, cam −5.5% bitrate +0.083 SSIM, screen 19× → camera-only |
| PR5 Exp-Golomb (optional) | SHIPPED — 5582257; spec v3.5 §3.4.5; −13.6%/−20% at equal SSIM, corpus twins to −28% |
| PR4 half-pel refinement | SHIPPED — spec v3.6 §5.2; gate PASSED on real webcam footage (residual SSD −40%, SAD −14%; integer MC measured net-harmful on real footage, half-pel + full-SAD rescoring flips it net-positive); cam720 q60: −61.6% bitrate (11272→4331 kbps), SSIM 0.865→0.929, enc −32%, dec −44% (scoreboard-pr4.json); synthetic scroll corpus: motion cases −1.5%/−5.7%, refresh twins +1.5% |
| VLC plugin workstream | NOT STARTED — aenc QOA, mux total_frames, GUI seek; v4 compat rebuild after |
| Phase 2 streaming | IN PROGRESS — adaptive API SHIPPED (9527619: qov_set_quality/qov_drop_reference in C+TS+C#, corpus case adaptive_quality_yuv420_lossy, spec v3.6 §4.1); QOV-S v2.0 spec SHIPPED (350f0d4, amended: carrier-agnostic core — any protocol over TCP/UDP can carry it via the two-channel model; Classic TCP+UDP binding continues, C# reference upgraded to the 20-byte v2.0 header); v2.0 machinery SHIPPED in the C# Classic reference (219c88b: HELLO/CONFIG handshake, NACK retransmit + replay window, XOR FEC 1:4/1:3, playback-deadline reassembly with in-order watermark + phantom hole expiry, playback gate freeze/heal over the 12-band refresh cycle, adaptation ladder binding REPORTs to qov_set_quality/qov_drop_reference/frame-skip; 40 xunit cases incl. real-socket loopback tests); demo 1:1 call app SHIPPED (d76fa8b: call.html over the WebSocket binding + Node relay, browser-verified live with the feedback→knob loop — NACK/FEC counters, freeze-heal at 25% simulated loss, RTT ~1 ms; TS machinery port + selftest 19e8362). Phase 2 COMPLETE |
| Phase 3 audio | SHIPPED (15895b2: spec v3.7 §5.3 — 16 kHz mono speech mode (QOV_AUDIO_RATE_SPEECH, corpus case audio_speech_yuv420_lossy), AUDIO chunk codec flags with Opus bit 0x01 + graceful skip in all decoders, encoder passthrough APIs (encodeAudioOpus/qov_encode_audio_opus/EncodeAudioOpus), capture-clock semantics paragraph; corpus case opus_audio_yuv420_lossy proves the skip path byte-exactly; c87ab0f: QOA stereo over-read fix in TS/C# + audio_stereo_yuv420_lossy corpus case; 6a7c180: call-demo microphone — 16 kHz mono QOA over QOV-S with browser AEC/NS/AGC as the product-scope audio processing, unified video+audio media ordering in the receivers, browser-verified live with ~1 ms RTT) |
| Phase 4 v4 subtraction/freeze | NOT STARTED |

Conformance state: GREEN, 35 cases × 8 steps, expected_failures.json empty (verified
across all three implementations on Windows and Linux).
Spec version: 3.6. Remotes: push target is `rebizu` (github.com/rebizu/qov-sp), branch `master`.

---

# QOV Conference Roadmap — Full Plan (incl. VLC plugin workstream)

Philosophy locked: quite OK quality, speed + simplicity as the product. Rule Zero gates govern every PR. User decisions baked in: Exp-Golomb ships as **optional alternative** coding (decoder carries both paths, corpus gains both variants); VLC plugin is a first-class workstream.

## Phase 0 — Scoreboard (Week 1)

1. **Real-footage corpus** (~15 min webcam + screen share, 720p30/360p30) under `qov-analysis-tools/corpus-real/`. Capture via existing recorder UI or ffmpeg, whichever works; store raw frames + reference encodes. Separate from frozen conformance corpus.
2. **Verify ffmpeg CLI** on this machine (only C# GUI references it today). Prereq for x264 baseline + SSIM.
3. **`qov-analysis-tools/scoreboard.py`**: per sequence, per quality level — bitrate + SSIM vs `x264 --preset ultrafast` (ffmpeg ssim filter), encode/decode ms/frame (C `qov.h` harness binary), codec line counts, encoder decision tally (skip/copy/intra counts from encoder stats).
4. Commit baseline JSON. Rule: no merge without before/after scoreboard rows.

## Phase 1 — Six codec changes + hygiene (Weeks 2–5), each = conformance-gated PR

Repo reality corrections vs the proposal doc:
- `deriveLossyParams` lives in `src/qov-types.ts:165` (not encoder). Fixed JPEG tables × scale **already exist** (`src/dct.ts`, `src/qov-encoder.ts:752`). Item 1 = per-coefficient perceptual weighting only.
- Bitstream changes require: spec version note + all 3 impls (TS/C/C#) + `npm run corpus --force` with reviewed manifest diff.

Ordered PRs:
1. **Perceptual quant knob** — frequency-weighted coefficient scaling derived from `dctQp`, identical in TS/C/C#. Spec pins exact arithmetic (float-vs-double was a past parity trap; C decoder scale must match TS bit-for-bit — verify C uses same precision as spec'd). Decoder recomputes from header bytes 24–27, so mapping change is decoder-visible and must land atomically in all impls.
2. **Dead-zone AC quant + QP-scaled block-skip** — replaces hardcoded `diffSum < 64` (`src/qov-encoder.ts:713`, `QovEncoder.cs:1037`, `qov.h:2391`).
3. **DC-only intra prediction, keyframe blocks** — DC from left/top neighbor mean, residual down existing DCT path, no mode bits. Spec v3.3 + corpus regen.
4. **Half-pel refinement** — ~20 lines, **gated**: lands only if scoreboard shows justified residual-bit savings. Integer-pel fallback stays.
5. **Exp-Golomb, optional** — new chunk flag bit (0x40 DCT_EG; 0x01/0x02/0x10/0x20 taken). Encoder choice per DCT chunk; all decoders implement both codings. Corpus: every lossy case regenerated in both variants.
6. **Intra refresh** — one rolling intra band per P-frame. Note: current P-frame path has **no intra block mode**, so this needs a row-granularity signal in the P-frame chunk header (flag + band byte). Small new machinery; spec note + 3 impls. Depends on PR 3's intra path.

**Hygiene PRs (some first — they de-risk):**
- **Index-update unification (do early, latent bug):** TS full decoder keyframe path updates index table on INDEX (`src/qov-decoder.ts:454`); TS P-frame path + streaming decoder don't (`qov-decoder.ts:514`, `qov-streaming-decoder.ts:942`); C never updates (`qov.h:1335`). Conformance is green only because no corpus case exercises reuse. Add an INDEX-reuse corpus case first, then align all impls to whichever semantics the encoder actually requires.
- Streaming decoder gains **DCT path** — required for Phase 2 receive; retires all 8 `expected_failures.json` entries (all are `ts_stream` no-DCT).
- Spec: document INDEX slot-0 reservation (formalizes existing encoder avoidance; unify C's position-guard `qov.h:2120` with slot-guard), document pixel-domain vs DCT double-quantization interaction.
- Delete hot-path `console.log` (`qov-encoder.ts:487-490,1011,1015`, per-frame decoder logs); batch buffer writes with typed-array views.

## Phase 2 — Streaming (Weeks 4–8)

1. **Reconcile transports:** existing `qov-streaming-spec.md` drafts TCP+UDP. Amend/supersede to QUIC datagrams/WebTransport primary, WebSocket fallback. One packetization page: ≤1200-byte packets, seq + frame + fragment indices.
2. **`qov.h` adaptive API** (none exists today; quality is start-time only at `qov.h:2026`): `qov_set_quality`, `qov_drop_reference` (clears reference frame — new), `qov_encode_frame` exists. TS/C# mirror.
3. App-layer: NACK retransmit + XOR FEC (1:3–4), receiver report (loss%, RTT) → `set_quality`, adaptation by subtraction (frame skip / second smaller encoder / drop_reference).
4. Receive path: freeze last good frame + wait refresh band — runs on the now-DCT-capable streaming decoder.
5. Demo 1:1 call app (browser) with feedback→knob loop.

## Phase 3 — Audio (Weeks 6–10)

- QOA 16 kHz mono speech mode (rate constant; 3-byte audioRate field already supports it).
- New audio chunk flag for alternate codec (Opus). Audio chunk flags are always 0 today (`qov-encoder.ts:1400`); define bit, all demuxers skip unknown codecs gracefully.
- `webrtc-audio-processing` in app (product scope, not format). Document capture-clock semantics (one paragraph).

## Phase 3.5 — Lighter format (entropy coding, QOI-philosophy compatible)

Inserted before the v4 freeze: every item keeps the philosophy (single-header
integer math, one-pass decode, deterministic, bit-exact across TS/C/C#).
Measured on 30s of cam720 at demo settings: P-frames = 90% of video bytes;
LZ4 gets 2.2x on raw block data, but the order-0 entropy floor is 2.67x and
gzip-class reaches 5.4x — so there is real headroom inside the philosophy.
Rejected as philosophy-breaking: CABAC-class adaptive coding, B-frames,
R-D search loops, lookahead rate control.

Ordered PRs (each = conformance-gated, bit-exact x3):
1. ✅ **Order-0 adaptive range coder** — SHIPPED (spec v3.8 §2.1.1, chunk
   flag 0x08, `RANGE_CODING` param). Measured (30s cam720, call settings):
   video bytes −18.6% (557 → 454 kbps), call wire 647.5 → 541.9 kbps FEC
   off / 544.2 at FEC 1:4; encode 180 → 164 fps, decode 309 → 265 fps.
   Corpus case `range_motion_yuv420_lossy_dct`; conformance GREEN x3.
2. ✅ **Quality-knob floor fix** — CLOSED as not-a-bug (2026-09-16). The
   "q60==q80 saturates at 320x240" premise was a harness artifact: the
   original scoreboard row was measured before bench_stream.c accepted a
   quality argument, so both rows silently encoded at q60. Controlled
   re-measure (30s cam720, range coder): q60 453 kbps / SSIM 0.809, q80
   619 kbps / 0.845, q95 1141 kbps / 0.880. The §6.2 derivation bites
   correctly; no encoder change made. scoreboard-format-comparison.json
   corrected.
3. ✅ **Opus speech path in the call demo** — SHIPPED (d409f13). Codec
   selector: QOA default / Opus via WebCodecs AudioEncoder (20 ms frames,
   ~24 kbps) + spec 5.3 flag 0x01 passthrough; graceful QOA fallback and a
   platform AudioDecoder on the guest. Browser-verified: ~50 opus
   chunks/s each way, 0 skips, QOA path unchanged (~61/s).
4. ❌ **Skip-run opcodes + MV median-delta prediction** — CLOSED by
   measurement (2026-09-16), negative result. The premise was pre-PR1:
   MV+refresh sections are ~25-30% of video bytes raw (not single
   digits; MV map is up to 602 B/P-frame at 320x240), so the idea looked
   big. But median-delta Exp-Golomb MVs measure −10% RAW and +0.3% after
   the order-0 range coder: adaptive byte modeling already codes the
   zero-heavy MV bytes at ~2-4 bits, below the entropy of eg-coded
   deltas. Restructuring skip-runs falls to the same argument. The
   experiment was reverted; bench_stream.c keeps motion/refresh argv for
   re-measurement.
5. ❌ **Order-1 / per-plane contexts in the range coder** — CLOSED by
   measurement (2026-09-16), negative result. gzip -9 applied on top of
   the order-0 range-coded DCT payloads recovers 0.0%: the adaptive
   model has already extracted the byte-level entropy, so order-1
   contexts have nothing left to capture. The "zstd-class 40-50%"
   estimate was made before PR1 existed. Phase 3.5 is complete: the
   range coder took the headroom the Tier-2 items were targeting.

## Phase 3.6 — Bandwidth packaging (before the v4 freeze)

Post-PR1 there is no entropy headroom left (see 3.5 closures), so the
remaining wire savings come from what we send and how we package it, not
from coding harder. Baseline at call settings: 541.9 kbps wire FEC off
(453.5 video + 69.0 QOA speech + ~19 packet headers), 122 pkt/s. Target:
~350-400 kbps with all four items. Ordered by bandwidth-per-effort:

1. ✅ **Opus DTX / silence gating in the call demo** — SHIPPED. RMS gate
   at the AudioEncoder output (encoder always fed, so analysis state stays
   continuous; keep-alive every 20 windows ≈ 400 ms), checkbox toggle,
   suppressed counter in host stats. Browser-verified live: 88-92% of
   chunks suppressed in a quiet room, audio wire ~36 → ~4 kbps, guest
   plays exactly what is sent with 0 decoder errors. Platform `usedtx`
   not needed — output gating supersedes it (drops whole packets).
2. ✅ **QOV-S audio batching — packet type 0x03** — SHIPPED (spec v2.1
   §3.1). Sender-side default-on (opt-out via `audioBatching: false`);
   batch = one seq/one frame_id, flushed when full, before any video
   chunk, or explicitly. Receiver splits entries per frame_id and
   delivers in order; v2.0 receivers ignore the type. 61 chunks → 9
   packets in the selftest; loopback batch-loss NACK recovery green in
   TS + C# (42/42 xUnit). The batch-loss test exposed and fixed a latent
   phantom-hole bug: an upgraded hole kept its placeholder media types
   instead of adopting the retransmitted packet's — wrong delivery on
   any async network, TS included (its synchronous NACK loop masked it).
3. ✅ **Resolution step-down rung in the adaptation ladder** — SHIPPED.
   Ladder row: sustained deficit walks quality to the floor, two more
   deficit reports engage `DownscaleActive` (host letterboxes the camera
   into a centered 256x192 over black — border blocks are pure skips,
   content quality unchanged); recovery lifts it on the third clean
   report before quality climbs. Mirrored in qov-adaptation.ts +
   QovAdaptation.cs, wired in call.ts (camera + synthetic paths), stat
   row + log line in the demo. Unit-proven on both stacks (selftest +
   43/43 xUnit); healthy channels never engage it.
4. **Multi-mode intra prediction — PROTOTYPE GATE, adopt only on a real
   margin** (spec v3.9 candidate). Today's intra is DC-only
   (`qov__intra_pred`); it prices keyframes (6 per 30 s) and every refresh
   band block. Prototype in C only, behind a param, measuring on the cam720
   fixture: modes DC/H/V (+planar if cheap), encoder picks min-SAD, mode
   bitmap (2 bits/block, raster order) in the intra section. ADOPT GATE:
   ≥5% video bytes on the fixture — below that, document closed like the
   3.5 Tier-2 items and keep the flag budget clean (bit 0x04 is the only
   P-frame bit left). If adopted: spec v3.9, three bit-exact ports,
   corpus case, conformance, bench rows.

Rejected for this phase: true mid-stream resolution switching (needs a
header change; conflicts with the freeze goal), audio-FEC co-grouping with
video (batch packets already amortize the header; measure later if the
loss profile wants it), QOA silence chunks (Opus path supersedes it).

## Phase 4 — v4 subtraction release + spec freeze (Weeks 8–10)

- Remove `QOV_FLAG_HAS_BFRAMES`/`ENHANCED_COMP` from spec + `qov-types.ts:27-28` (ENHANCED_COMP was never even in `qov.h`).
- One-page opcode table; profile byte (Screen/RTC) in reserved header bytes 28–31; slot-0 reservation text.
- Freeze spec v4. Churn after freeze = complexity debt.

## VLC plugin workstream (parallel, per user request)

Plugin builds directly on `../qov.h` (`vlc-plugin/qov-demux.c:14`), so qov.h changes propagate on rebuild (`vlc-cache-gen.exe` per developer notes).
1. **Follow-ups from developer notes:** aenc QOA (audio encoder module for transcode), mux writes `total_frames` (fixes duration/seek reporting), GUI seek robustness.
2. **v4 compat pass:** rebuild against updated qov.h after Phases 1+4, re-run vlc-cache-gen, smoke-play a corpus list incl. intra-refresh + Exp-Golomb + speech-audio files, verify probe/demux still OK with profile byte and new audio flag (map Opus flag to correct ES FourCC).

## Gates & CI

- Every PR: `npm run conformance` green + scoreboard before/after rows.
- Line budget (gate 1, implementable form): script records current counts (qov.h 2758, encoder/decoder TS) as ratchet baseline; CI fails on +5% growth, ratchet down each release. Plan's absolute caps (500/1000/1200 per section) need section-mapping definition — ratchet is the enforceable version now.
- Weekend test: after spec v3.3 and v4, one fresh-eyes decoder attempt each.

## Risks

- float-vs-double DCT scale parity — spec pins arithmetic; conformance catches.
- INDEX-reuse semantics unknown until new corpus case runs — unification PR may flip in either direction.
- ffmpeg CLI availability unverified (Bash blocked in plan mode) — check first thing in Phase 0.
- 10-week solo timeline optimistic; phases already overlap, keep plugin + hygiene as slack fillers.

## Post-approval first actions

1. Save memory: conference roadmap includes VLC plugin workstream (user request).
2. Phase 0 kickoff: ffmpeg check, corpus capture plan, scoreboard script skeleton.