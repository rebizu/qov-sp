# QOV Analysis Tools

Tools for validating and analyzing QOV files, plus the **golden corpus +
conformance runner** that keeps every implementation (TypeScript, C#) honest
against the same frozen test files.

## Conformance runner

```bash
python qov-analysis-tools/conformance.py            # full suite (needs node + dotnet)
python qov-analysis-tools/conformance.py --skip-csharp
python qov-analysis-tools/conformance.py --only <case-id>
```

The runner executes six steps per corpus case:

| Step         | What it does |
|--------------|--------------|
| `integrity`  | corpus file bytes match the manifest SHA-256 |
| `structure`  | `analyze_qov.walk_file()` finds no issues and the chunk summary matches the manifest |
| `ts_full`    | the TS full decoder reproduces the manifest's per-frame SHA-256 |
| `ts_stream`  | the TS streaming decoder reproduces them (`n/a` for lossy cases — it has no DCT path; the player routes those to the regular decoder) |
| `cs_decode`  | `QovValidator --decode --hashes` reproduces them; `near` = pixel output within tolerance (max ≤ 2, mean ≤ 1) instead of exact |
| `cs_encode`  | the parameterized C# generator encodes the same case byte-identically to the frozen file (`n/a` for motion/audio cases the C# encoder can't express) |

Exit code is non-zero on any failure **not** listed in `expected_failures.json`.
Verdicts: `ok` / `near` / `xfail` (documented) / `FAIL` / `n/a` / `skip`.

## The golden corpus (`corpus/`)

`cases.json` declares ~20 small cases (≤128×96, ≤6 frames) covering: RGB/sRGBA/linear
lossless (LZ4 on/off), all YUV colorspaces, v3 lossy DCT (LZ4 on/off, 4:2:2/4:4:4,
alpha), motion vectors (scroll, static canary, motion+DCT), QOA audio, and RGB
lossy quantization. `manifest.json` freezes each file's SHA-256, structure summary,
and per-frame decode hashes. `*.qov` files are committed.

**Frozen means frozen.** The corpus is an approval test: if an intentional codec
change alters output, run `python gen_corpus.py --force` and review the manifest
diff like any other test-approval. `gen_corpus.py` encodes every case twice and
refuses output that isn't deterministic.

Known documented gap: **v1 files (16-bit chunk sizes) are not in the corpus** —
neither existing encoder can emit them.

## Patterns and the shared LCG

The four deterministic patterns (`gradient`, `stripes`, `scroll16`, `noise`) are
implemented twice — `tscli.ts` and `csharp_qov/QovEncoder/Program.cs` — and must
stay bit-identical. The noise pattern uses a 31-bit LCG:

```
s = (s * 1103515245 + 12345) mod 2^31      // 32-bit wrapping multiply
byte = (s >> 16) & 0xff                    // unsigned shift
per-frame seed: s0 = 12345 + frame * 7919
```

Alpha-capable cases (sRGBA/linear_a/YUVA420) use a per-pixel moving alpha
`(x + frame * 8) & 0xff` so implementations that silently drop alpha fail loudly.

## Other tools

- `analyze_qov.py <file.qov> [--limit N]` — standalone structural validator
  (v1/v2/v3 headers, chunk walk, LZ4 size prefix, INDEX layout, SYNC/END
  payloads). `walk_file(path)` is importable.
- `tscli.ts` — Node CLI over the real `src/` codec: `encode <case.json> <out>`
  and `decode <file> [--streaming] [--raw <dir>]` (JSON report on stdout).
  Bundled on demand with the repo-local esbuild.

## Adding a case

1. Add an entry to `corpus/cases.json`.
2. `python gen_corpus.py --only <new-id>` (or `--force` for everything).
3. If a new implementation gap surfaces, add `<step>:<case-id>` to
   `expected_failures.json` **with the measured reason** — the runner warns
   about stale entries that start passing again.
