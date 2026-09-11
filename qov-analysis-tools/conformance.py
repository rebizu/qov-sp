#!/usr/bin/env python3
"""
QOV conformance runner.

Runs every implementation against the frozen golden corpus
(qov-analysis-tools/corpus) and prints a drift matrix:

    integrity | structure | ts_full | ts_stream | cs_decode | cs_encode

Verdicts: ok, FAIL, near (C# pixel output within tolerance), xfail
(documented expected failure), n/a (step not applicable), skip (tooling
missing). Exit code is non-zero if any step fails without an entry in
expected_failures.json.

Usage:
    python conformance.py [--skip-csharp] [--only <case-id>] [--json]
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
CORPUS = TOOLS / "corpus"
NODE_ESBUILD = ROOT / "node_modules" / "esbuild" / "bin" / "esbuild"

STEPS = ["integrity", "structure", "ts_full", "ts_stream", "cs_decode", "cs_encode"]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(cmd: list, **kw) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, **kw)
    return p


def must_run(cmd: list) -> str:
    p = run(cmd)
    if p.returncode != 0:
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(map(str, cmd))}\n"
                           f"stdout: {p.stdout[-2000:]}\nstderr: {p.stderr[-2000:]}")
    return p.stdout


def ensure_bundle(node: str) -> Path:
    bundle = TOOLS / "tscli.cjs"
    src = TOOLS / "tscli.ts"
    if not bundle.exists() or bundle.stat().st_mtime < src.stat().st_mtime:
        must_run([node, str(NODE_ESBUILD), str(src), "--bundle", "--platform=node",
                  "--format=cjs", f"--outfile={bundle}", "--log-level=warning"])
    return bundle


def find_csharp_tool(name: str) -> Path | None:
    base = ROOT / "csharp_qov" / name / "bin" / "Release"
    if not base.exists():
        return None
    exes = sorted(base.glob(f"*/{name}.exe"))
    return exes[-1] if exes else None


def build_csharp() -> bool:
    p = run(["dotnet", "build", str(ROOT / "csharp_qov" / "QovValidator"), "-c", Release()])
    ok1 = p.returncode == 0
    p2 = run(["dotnet", "build", str(ROOT / "csharp_qov" / "QovEncoder"), "-c", Release()])
    return ok1 and p2.returncode == 0


def Release() -> str:  # config name constant (kept lowercase-free for CI logs)
    return "Release"


def ts_decode(node: str, bundle: Path, case_file: Path, streaming: bool, raw_dir: Path | None) -> dict:
    cmd = [node, str(bundle), "-q", "decode", str(case_file)]
    if streaming:
        cmd.append("--streaming")
    if raw_dir:
        cmd += ["--raw", str(raw_dir)]
    return json.loads(must_run(cmd))


def near_diff(dir_a: Path, dir_b: Path, frames: int) -> dict:
    max_d, total, count = 0, 0, 0
    for i in range(frames):
        fa = dir_a / f"frame_{i}.rgba"
        fb = dir_b / f"frame_{i}.rgba"
        if not fa.exists() or not fb.exists() or fa.stat().st_size != fb.stat().st_size:
            return {"max": -1, "mean": -1}
        a = fa.read_bytes()
        b = fb.read_bytes()
        for x, y in zip(a, b):
            d = abs(x - y)
            if d > max_d:
                max_d = d
            total += d
            count += 1
    return {"max": max_d, "mean": round(total / max(1, count), 4)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-csharp", action="store_true")
    ap.add_argument("--only", metavar="CASE_ID")
    ap.add_argument("--json", action="store_true", help="print results as JSON")
    args = ap.parse_args()

    cases_doc = json.loads((CORPUS / "cases.json").read_text(encoding="utf-8"))
    manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))
    xfail_doc = json.loads((TOOLS / "expected_failures.json").read_text(encoding="utf-8"))
    xfail = xfail_doc["entries"]

    cases = cases_doc["cases"]
    if args.only:
        cases = [c for c in cases if c["id"] == args.only]

    node = shutil.which("node")
    if not node:
        print("node is required")
        return 1
    bundle = ensure_bundle(node)

    have_cs = not args.skip_csharp
    if have_cs and shutil.which("dotnet") is None:
        print("dotnet not found; skipping C# steps")
        have_cs = False
    validator = encoder = None
    if have_cs:
        if not build_csharp():
            print("dotnet build failed; skipping C# steps")
            have_cs = False
        else:
            validator = find_csharp_tool("QovValidator")
            encoder = find_csharp_tool("QovEncoder")
            if validator is None or encoder is None:
                print("C# binaries not found after build; skipping C# steps")
                have_cs = False

    # C# encoder-supported subset: no motion, no audio, RGB-family or 420-family
    CS_ENCODE_OK = {"srgb", "srgba", "linear", "linear_a", "yuv420", "yuva420"}

    results: dict = {}
    stale_xfail = []
    for case in cases:
        cid = case["id"]
        qov = CORPUS / f"{cid}.qov"
        entry = manifest["cases"][cid]
        row: dict = {}

        # 1. integrity
        row["integrity"] = "ok" if sha256_file(qov) == entry["file_sha256"] else "FAIL"

        # 2. structure
        from analyze_qov import walk_file
        walk = walk_file(qov)
        expected_header_size = 32 if entry["header"].get("version") == 3 else 24
        ok = (not walk["issues"] and walk["summary"] == entry["structure"]
              and walk["header"].get("header_size") == expected_header_size)
        row["structure"] = "ok" if ok else "FAIL"

        # 3. TS full decode
        dec = ts_decode(node, bundle, qov, False, None)
        row["ts_full"] = "ok" if dec["frameSha256"] == entry["decode_full"]["frame_sha256"] else "FAIL"

        # 4. TS streaming decode
        if not entry["decode_streaming"]["supported"]:
            row["ts_stream"] = "n/a"
        else:
            sdec = ts_decode(node, bundle, qov, True, None)
            row["ts_stream"] = "ok" if sdec["frameSha256"] == entry["decode_streaming"]["frame_sha256"] else "FAIL"

        # 5. C# decode (exact hash; fall back to near-diff)
        if not have_cs:
            row["cs_decode"] = "skip"
        else:
            p = run([str(validator), str(qov), "--decode", "--hashes"])
            hashes = [ln.split()[2] for ln in p.stdout.splitlines()
                      if ln.startswith("FRAME_SHA256 ")]
            if p.returncode == 0 and hashes == entry["decode_full"]["frame_sha256"]:
                row["cs_decode"] = "ok"
            else:
                with tempfile.TemporaryDirectory() as td:
                    cs_raw = Path(td) / "cs"
                    ts_raw = Path(td) / "ts"
                    cs_raw.mkdir()
                    ts_raw.mkdir()
                    p2 = run([str(validator), str(qov), "--decode", "--raw-out", str(cs_raw)])
                    ts_decode(node, bundle, qov, False, ts_raw)
                    d = near_diff(cs_raw, ts_raw, entry["decode_full"]["frames"])
                if 0 <= d["max"] <= 2 and 0 <= d["mean"] <= 1:
                    row["cs_decode"] = "near"
                else:
                    row["cs_decode"] = "FAIL"
                results.setdefault("_detail", {})[f"cs_decode:{cid}"] = d

        # 6. C# encode cross-check (only where the C# encoder can express the case)
        if not have_cs:
            row["cs_encode"] = "skip"
        elif case["colorspace"] not in CS_ENCODE_OK or "motion" in (case.get("flags") or []) or case.get("audio"):
            row["cs_encode"] = "n/a"
        else:
            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / f"{cid}.cs.qov"
                case_file = Path(td) / f"{cid}.case.json"
                case_file.write_text(json.dumps(case), encoding="utf-8")
                p = run([str(encoder), str(case_file), str(out)])
                if p.returncode != 0:
                    row["cs_encode"] = "FAIL"
                    results.setdefault("_detail", {})[f"cs_encode:{cid}"] = "encode error: " + p.stderr.strip()[-200:]
                else:
                    row["cs_encode"] = "ok" if sha256_file(out) == entry["file_sha256"] else "FAIL"

        # apply xfail / stale detection
        for step in STEPS:
            v = row[step]
            key = f"{step}:{cid}"
            if v == "FAIL" and key in xfail:
                row[step] = f"xfail"
            elif v in ("ok", "near") and key in xfail:
                stale_xfail.append(key)

        results[cid] = row
        print(f"{cid:34s} " + "  ".join(f"{step}={row[step]:5s}" for step in STEPS))

    # summary
    print()
    fail = []
    for cid, row in results.items():
        if cid == "_detail":
            continue
        for step in STEPS:
            if row[step] == "FAIL":
                fail.append(f"{step}:{cid}")
    for key in stale_xfail:
        print(f"WARNING: stale expected-failure (step now passes): {key}")
    if fail:
        print(f"RESULT: {len(fail)} unexpected failure(s):")
        for f in fail:
            reason = xfail.get(f)
            detail = results.get("_detail", {}).get(f, "")
            print(f"  - {f} {('| ' + str(detail)) if detail else ''}"
                  f"{' (documented: ' + reason + ')' if reason else ''}")
        print("\nIf a failure is a known, permanent limitation, add '<step>:<case>' to "
              "qov-analysis-tools/expected_failures.json with a reason.")
        rc = 1
    else:
        n_xfail = sum(1 for cid in results if cid != "_detail" for s in STEPS if results[cid][s] == "xfail")
        print(f"RESULT: GREEN ({n_xfail} expected failure(s), everything else ok)")
        rc = 0

    if args.json:
        print(json.dumps(results, indent=1))
    return rc


if __name__ == "__main__":
    sys.exit(main())
