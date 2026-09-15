# QOV Developer Notes — Gotchas That Will Bite You

Machine-independent traps harvested from development. Read before touching the
codec or the analysis tooling. (VLC-specific traps live in `vlc-plugin/DEVELOPER.md`;
conformance workflow lives in `qov-analysis-tools/README.md`; the roadmap with
execution status lives in `CONFERENCE-ROADMAP.md`.)

## Toolchain

- **gcc fails silently** when `/c/msys64/mingw64/bin` is not on PATH: exit 1,
  empty stderr. `export PATH="/c/msys64/mingw64/bin:$PATH"` before every
  hand-built binary.
- **gcc flags are load-bearing for bit-exactness.** Always build `qov.h`
  code with `-ffp-contract=off`: gcc's default fast contraction rewrites the
  `a*b+c` chains in `qov_rgb_to_yuv_px` and shifts ±1 on knife-edge luma
  pixels (3 pixels of 12288 on the gradient case — enough to fail every
  c_encode hash). Symptom worth recognizing: c_decode passes (decoder
  math unaffected) while c_encode fails everywhere.
- **Missing link libs fall back silently.** On Linux, `c/main.c` needs
  `-lm` (`sin()`); MinGW links math implicitly. And `-lm` must come AFTER
  the source file — ld resolves left-to-right, so `gcc -lm main.c` still
  leaves `sin` undefined. Either way the gcc candidate in
  `conformance.py build_c()` fails to link and the runner quietly tries
  `zig cc` next — a *different* compiler, so the suite can go red from a
  toolchain substitution that never prints a warning. If C legs behave
  oddly on a new machine, first verify
  `qov-analysis-tools/.build/qov_cli.exe` was actually built by gcc.
- **esbuild's bin shim is platform-shaped**: on Windows
  `node_modules/esbuild/bin/esbuild` is a JS file you run *under node*; on
  POSIX npm puts the native ELF binary there and node refuses to execute
  it. `conformance.py` / `gen_corpus.py` peek at the magic bytes and pick
  the right invocation — keep that when adding new bundling code.
- **`python` vs `python3`**: the npm scripts try `python3` then `python`
  (`||` chains work in both npm shells). Debian/Ubuntu ships only
  `python3`; Windows only `python`.
- **Stale binaries are the recurring failure mode.** The conformance runner
  rebuilds its own tools, but these are manual and go stale after editing
  `qov.h` or `src/*.ts`:
  - `c/bench.exe` — what `scoreboard.py` actually runs (NOT `.build/bench.exe`).
    Symptom: before/after scoreboard rows come out *identical*.
  - `.build/qov_cli.exe` for smoke tests.
  - `qov-analysis-tools/tscli.cjs` — the esbuild bundle; `gen_corpus.py` /
    `conformance.py` rebuild it when any `src/*.ts` is newer, but a manual
    `node qov-analysis-tools/tscli.cjs` run uses whatever is on disk.
- **Windows stdin is text mode**: raw RGBA frames piped into `bench encode`
  break silently on `0x1A` bytes unless the C tool calls
  `_setmode(_fileno(stdin), _O_BINARY)` (bench.c and main.c already do — keep it
  when adding new C entry points).
- Background shells and some scripts start at the **repo root**, not the
  current directory — use absolute paths in scripts.

## Bit-exactness (triple implementation: C == TS == C#)

The conformance suite enforces byte-identical encodes and decode hashes across
all three implementations. Every one of these has caused a real divergence:

- **Banker's rounding**: TS `Math.round` rounds half up (mostly), C#
  `Math.Round` rounds half to even — use `ColorConversion.JsRound` in C#
  and `qov_round` in C; never the language-default round.
- **float vs double**: the quantizer scale `0.1 + qp * 0.1` and all
  coefficient products are computed in double. C floats silently truncate —
  write the casts explicitly.
- **Decoder plane add**: C must add as `(int)((double)plane + (double)block)`;
  `uint8 + float` promotes to float precision and diverges by ±1 on
  knife-edge pixels (symptom: a few chroma pixels off, only visible in later
  P-frames).
- **Per-pixel UV rounding happens before luminance weighting** in
  `rgbaToYuv420Planes` — rounding order is normative.
- **TS LZ4 hash** has a double-precision quirk — do not "clean it up".
- **Zigzag table layout**: TS `ZIGZAG[k]` is scan-index → natural, C
  `qov_zigzag[k]` the same; C# `Dct.ZigZag` likewise. Mixed conventions in
  older code were the source of a past bug.
- **C# ReadOnlySpan cannot be captured in a lambda** — copy the slice to a
  `byte[]` first (see the Exp-Golomb reader in `QovDecoder.cs`).
- When a divergence appears: instrument both encoders with env-gated traces,
  confirm decisions match, then byte-diff the chunk payloads. PR3's bug was a
  missing skip-flush found exactly this way.

## Bitstream/format facts that look like bugs

- Refresh band (v3.4) and Exp-Golomb (v3.5) are **opt-in** — header flag +
  chunk flag. Screen content regressed catastrophically when similar features
  were default-on (ikf: 360→2298 kbps; refresh bands: 441→8441 kbps on
  screen720). Keep them opt-in; the call app enables per track.
- Refresh bands: band skips are **prediction fills**, not reference copies, so
  a single SKIP run can straddle a band boundary — decoders must apply
  per-block semantics by row within a run.
- Exp-Golomb chunks decode to **identical pixels** as byte-coded chunks
  (pure re-entropy-coding) — a useful invariant when debugging.
- Skip runs in keyframe intra planes fill with the DC prediction; the encoder
  must flush pending skips before coded blocks (stream order is strict).

## Scoreboard / measurement

- Bitrate formula is `size_bytes * 8 / (frames / fps)` — never the source
  duration (capped runs under-report otherwise).
- `scoreboard-baseline.json` rows are **pre-PR2** (before the dead-zone).
  Honest before/after pairs need same-build OFF runs or the per-PR files
  (`scoreboard-pr2.json`, `scoreboard-pr5.json`, `scoreboard-pr6.json`).
- Add new bench flags to `scoreboard.py` **before** running with them —
  argparse fails fast, which is the only reason we did not silently measure
  the wrong thing for `--eg`.

## Repo hygiene

- Gitignored: `.build/`, `.zcode/`, `qov-analysis-tools/corpus-real/`
  (the 6-minute FFV1 real-footage corpus — re-capture with
  `qov-analysis-tools/capture_corpus.sh` on a new machine).
- `qov-motion-vectors.pptx` at the repo root is untracked on purpose.
- Corpus regen is an approval test: `npm run corpus -- --force`, then review
  the manifest diff — it must be **purely additive** unless the codec change
  intentionally alters output.
- Conformance state to protect: GREEN, all cases × 8 steps,
  `expected_failures.json` empty. The `cs_decode=near` entries on the two
  noise-pattern cases are pre-existing float-tolerance passes, not regressions.

## Session workflow (ZCode agents)

- Verify TS changes in the internal browser (dev server on 5173, player URL
  input, crafted `.qov` served from a reachable path), not just `tsc`.
- Conventional commits; reference spec sections in codec PRs.
