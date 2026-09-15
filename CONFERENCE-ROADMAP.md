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
| Phase 2 streaming | IN PROGRESS — adaptive API SHIPPED (9527619: qov_set_quality/qov_drop_reference in C+TS+C#, corpus case adaptive_quality_yuv420_lossy, spec v3.6 §4.1); QOV-S v2.0 spec SHIPPED (350f0d4, amended: carrier-agnostic core — any protocol over TCP/UDP can carry it via the two-channel model; Classic TCP+UDP binding continues, C# reference upgraded to the 20-byte v2.0 header); REMAINING: session-control completion (HELLO/REPORT/NACK), NACK+FEC implementation, receive path freeze+refresh-band wait, demo 1:1 call app |
| Phase 3 audio | NOT STARTED — 16 kHz speech mode, Opus flag |
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