# P-frame format exploration (branch `explore/pframe-format`)

Question: can P-frames be made lighter by changing the **format** rather than
squeezing entropy — in a way that fits the QOI philosophy (simple, integer,
one-pass, deterministic, bit-exact)?

> **STATUS (shipped as spec v3.9):** the grammar below is implemented in
> all three reference implementations (C `qov.h`, TypeScript, C#) behind
> chunk flag `0x04`, covered by 6 new conformance cases, and enabled in
> the call demo. Implementation also exposed two pre-existing decoder
> defects — see "The two decoder bugs this shipped" at the end.

**TL;DR: yes.** A restructured P-frame grammar (chunk flag `0x04`) removes
~35% of P-frame bytes that were pure structure (per-block opcodes, per-block
qp deltas, skip-run tags) which the order-0 range coder cannot exploit.
Measured on the cam720 fixture at call settings:

| quality | P-frame bytes/frame v1 | v2 (flag 0x04) | delta |
|---|---|---|---|
| q30 | 1745.9 | 910.9 | **−47.8%** |
| q60 (call default) | 2316.3 | 1301.0 | **−43.8%** |
| q85 | 3590.1 | 2335.7 | **−34.9%** |

Decoded pixels are **bit-identical** to v1 in all cases (720/720 frames per
run), so SSIM/quality is unchanged by construction. At q60 the video payload
drops from ~451.5 to ~258.2 kbps (−42.8%, keyframes unchanged).

Everything below is measurement on scratch copies of `qov.h` under
`qov-analysis-tools/.build-tmp/` — `master` and the working tree are
untouched. Repro scripts are tracked in `qov-analysis-tools/pframe-explore/`.

## 1. Where do P-frame bytes actually go?

Method: every raw payload byte is tagged with its field category by walking
the payload grammar; the range coder accumulates the *ideal code length*
(−log2 of the adaptive model probability at encode time) per category. The
ideal-length total matches the actual RC output within 0.2%, so the split is
trustworthy. Fixture: cam720 30 s → 320×240@24, q60, motion + intra-DCT
keyframes + intra refresh + range coder, 714 P-frames.

| category | raw B/frame | RC B/frame | RC share |
|---|---|---|---|
| AC run/size bytes | 526.2 | 424.1 | 18.4% |
| block opcode (0x50/0x51) | 834.2 | 374.0 | 16.2% |
| skip runs (0x52 + count) | 489.1 | 365.8 | 15.9% |
| qp_delta byte | 834.2 | 332.6 | 14.4% |
| DC (u16) | 1668.4 | 323.7 | 14.0% |
| AC level bytes | 469.0 | 311.9 | 13.5% |
| EOB (0x00) | 834.2 | 107.6 | 4.7% |
| MV section | 579.7 | 65.3 | 2.8% |
| band + end marker | 9.0 | 2.6 | 0.1% |

The striking part: **op + qp_delta + EOB = 35.3%** of the RC'd payload, yet
these bytes carry (almost) no information — the opcode is constant within a
plane, the qp delta is always 0x40 when quality is static, the EOB is implied.
An order-0 byte model charges every symbol its *global frequency share*, so
"constant" fields still cost real bits. No entropy tweak can fix this; only
the grammar can.

Also confirmed: the MV section is 2.8% — MV prediction stays a dead end.

## 2. The structured P-frame (flag 0x04)

One free flag bit (`0x04`) switches the DCT P-frame payload to a grammar
where structure lives in the plane, not in every block:

```
[u8 band]              if REFRESH_BAND (unchanged)
[mv section]           if flag 0x02 (unchanged)
per plane (Y, U, V, [A]):
  u8 qp_delta          bias-64 vs header dct_qp — one per plane, not per block
  items, until the plane's block count is consumed:
    u8 run_count       blocks skipped before the next coded block;
                       255 = "255 skipped, the chain continues in the next
                       byte"; 0 = coded block follows immediately
    coded section      DC i16 (u16 BE), then AC pairs (u8 run<<4|size with
                       `size` level bytes, 0xF0 = +16 zero run), terminated
                       by u8 0x00 — no opcode, no qp byte
  the plane's final chain byte is always < 255 (0 when the plane ends on a
  coded block), which terminates the plane without any end marker
```

Decoder walk per plane: read qp_delta, then `{ read chain; if plane done
break; read bare coded section }`. The decoder gets **simpler** — the
`op_type` matching and per-block qp parsing disappear; plane identity comes
from section order (which the decoder already assumes), quality from one
byte per plane. Mid-stream quality changes work *better* than v1: the
per-plane qp byte carries them explicitly (v1 spread them over every block).

Philosophy audit: integer math only, one forward pass, raster order,
deterministic, bit-exact across implementations (the prototype round-trips
through the same C decoder used by the conformance suite). The decoder is
strictly less code than v1.

## 3. Measured dead ends (do not build these)

- **Quantized-DC left-neighbour prediction** (stacked on v2): +50 B/frame
  (−43.8% → −41.7%). At the byte level, absolute DCs model better than
  deltas — a u16 delta's sign spreads mass over two symbol regions
  (−1 → 0xFF 0xFF, +1 → 0x00 0x01), while 80% of absolute DCs are exactly
  zero. Same family of result as the earlier MV median-delta (+0.3%) and
  order-1-context (0.0%) findings: this payload prefers absolutes.
- **Exp-Golomb coefficients under the range coder**: v1 P-frames go
  2316.3 → 2530.4 B/frame (+9.2%) with flag 0x40 on. Bit-packing raises
  per-byte entropy, which is precisely what a byte-level order-0 RC cannot
  reclaim. EG stays off for range-coded streams.
- End-marker removal under v2: the 8-byte payload end marker costs ~1.6 B/f
  RC'd — not worth touching the chunk contract.

## 4. What remains after v2

Post-v2 raw composition at q60 (encoder-side counters): chains 837.2,
DC 1668.4, AC run/size 526.2, AC levels 469.0, EOB 834.2, qp 6.0 — i.e.
essentially pure coefficient data plus run positions. The next lever would
be coefficient tokenization, but the entropy-floor work in BENCHMARKS.md
(gzip recovers 0.0% from RC'd payloads) says the remaining bytes are close to
their byte-level floor. Format exploration is done; what is left belongs to
perceptual tuning (skip threshold, dead zone), not byte layout.

## 5. Shipping checklist (if adopted as spec v3.9)

- C `qov.h`: the prototype diff (~120 lines, opt-in `pframe_v2` param).
- TS: `qov-encoder.ts` + `qov-decoder.ts`/`qov-streaming.ts` grammar mirror.
- C#: `QovEncoder`/`QovDecoder` mirror + streaming tests.
- Spec: new §3.4.6 + changelog, flag `0x04` documented; same rollout
  discipline as the range coder (sender emits only to peers that advertise
  the flag; flag is opt-in so old streams stay byte-identical).
- Conformance: default-off means existing corpus cases are untouched; add
  new flag-on corpus cases via the approval flow (`npm run corpus --force`).
- Wire note: at q60 a v2 P-frame chunk (~1314 B with chunk header) still
  spans 2 QOV-S packets at the 1180 B fragment cap — the win is bytes, not
  packet count.

## 6. The two decoder bugs this shipped

Profiling against a checker-pattern corpus case surfaced two pre-existing
decoder defects in **both** grammars, present identically in C, TypeScript
and C#:

1. **EOB swallowed at zigzag 63.** The coefficient-section EOB is written
   unconditionally, but the decoder AC loop `while (k < 64)` exits early
   when the last coded AC lands exactly on zigzag index 63 — leaving the
   EOB to be eaten as the next item. The plane desynchronizes; with busy
   content (checker at q50) this fired constantly. Conformance missed it
   because the manifest froze each implementation's own decode.
   Fix: the AC loop runs until the EOB is consumed (run-overshoot keeps
   its defensive break).
2. **255-chain accumulation.** The structured skip chain treats 255 as
   "255 skipped, chain continues"; all three decoders applied only the
   final byte's count and dropped every earlier 255. Static-content tests
   masked it (wrong skip fills still copy identical pixels); a new
   256x256 all-skip case and C# test now cover it. Fix: accumulate every
   chain byte.

Both fixes are decoder-side only — encoded bytes are unchanged — and are
documented normatively in spec §3.4.6. The 6 pre-existing corpus cases
whose decode hashes moved were regenerated as the approval event.

## 7. Repro

```bash
cd qov-analysis-tools/pframe-explore
mkdir -p .work && cp ../../qov.h .work/ && cd .work
python3 ../make_prof.py && gcc -O2 -std=c99 -w -ffp-contract=off -I. \
  -o prof ../prof.c -lm
ffmpeg -t 30 -i ../corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
  -f rawvideo -pix_fmt rgba - | ./prof 320 240 24 720 60     # section 1 table

python3 ../make_v2.py && python3 ../countpatch.py
gcc -O2 -std=c99 -w -ffp-contract=off -I. -o v2prof ../v2prof.c -lm
ffmpeg -t 30 -i ../corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
  -f rawvideo -pix_fmt rgba - | ./v2prof 320 240 24 720 60    # section 2 table
```

Caveat: `make_prof.py`'s v2 payload re-tagger desyncs on v2 streams
(measurement-only tooling, does not affect the codec); v2's composition in
section 4 comes from encoder-side counters, and all headline numbers come
from the encoder/decoder pair itself (chunk sizes + decoded-pixel hashes).
