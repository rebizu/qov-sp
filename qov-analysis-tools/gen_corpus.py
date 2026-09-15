#!/usr/bin/env python3
"""
Generate the golden QOV corpus from corpus/cases.json using the TypeScript
codec (via tscli.ts, esbuild-bundled for Node).

The corpus is FROZEN: committed .qov files + manifest.json act as approval
tests. Intentional output changes require `gen_corpus.py --force` and the
manifest diff gets reviewed like any other approval.

Usage:
    python gen_corpus.py             # generate missing corpus (fails if it exists)
    python gen_corpus.py --force     # regenerate everything
    python gen_corpus.py --only <id> # (re)generate one case (implies --force for that case)
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
CORPUS = TOOLS / "corpus"
NODE_ESBUILD = ROOT / "node_modules" / "esbuild" / "bin" / "esbuild"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def esbuild_cmd(node: str) -> list:
    """npm ships node_modules/esbuild/bin/esbuild as a JS shim on Windows but
    as the native ELF binary on POSIX; node can only run the former. Peek at
    the magic bytes so both machines bundle the same way."""
    try:
        with open(NODE_ESBUILD, "rb") as f:
            magic = f.read(4)
    except OSError:
        magic = b""
    if os.name != "nt" and (magic[:4] == b"\x7fELF" or magic[:2] == b"#!"):
        return [str(NODE_ESBUILD)]
    return [node, str(NODE_ESBUILD)]


def run(cmd: list, **kw) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, **kw)
    if p.returncode != 0:
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(map(str, cmd))}\n"
                           f"stdout: {p.stdout[-2000:]}\nstderr: {p.stderr[-2000:]}")
    return p.stdout


def ensure_bundle(node: str, force: bool) -> Path:
    bundle = TOOLS / "tscli.cjs"
    src = TOOLS / "tscli.ts"
    # the bundle pulls in all of src/, so a stale check must cover every
    # imported module, not just the entry point
    deps = [src] + list((Path(__file__).resolve().parent.parent / "src").glob("*.ts"))
    newest = max(p.stat().st_mtime for p in deps)
    if force or not bundle.exists() or bundle.stat().st_mtime < newest:
        run([*esbuild_cmd(node), str(src),
             "--bundle", "--platform=node", "--format=cjs",
             f"--outfile={bundle}", "--log-level=warning"])
    return bundle


def encode_case(node: str, bundle: Path, case: dict, out: Path, tmp: Path) -> dict:
    """Encode one case; returns manifest entry. Encodes twice to prove determinism."""
    case_file = tmp / f"case_{case['id']}.json"
    case_file.write_text(json.dumps(case), encoding="utf-8")

    out_a = tmp / f"{case['id']}.a.qov"
    out_b = tmp / f"{case['id']}.b.qov"
    run([node, str(bundle), "-q", "encode", str(case_file), str(out_a)])
    run([node, str(bundle), "-q", "encode", str(case_file), str(out_b)])

    hash_a, hash_b = sha256_file(out_a), sha256_file(out_b)
    if hash_a != hash_b:
        raise RuntimeError(f"case {case['id']}: encoder is not deterministic")

    # structural walk + decode with both TS decoders.
    # The streaming decoder handles lossless opcodes AND lossy DCT blocks;
    # full==streaming equality is required for every case.
    from analyze_qov import walk_file  # noqa: E402 - repo-local module
    walk = walk_file(out_a)

    dec_full = json.loads(run([node, str(bundle), "-q", "decode", str(out_a)]))
    dec_stream = json.loads(run([node, str(bundle), "-q", "decode", str(out_a), "--streaming"]))
    stream_supported = True

    if stream_supported and dec_full["frameSha256"] != dec_stream["frameSha256"]:
        raise RuntimeError(f"case {case['id']}: full and streaming decoders disagree")

    entry = {
        "file_sha256": hash_a,
        "file_size": out_a.stat().st_size,
        "header": dec_full["header"],
        "structure": walk["summary"],
        "structure_issues": walk["issues"],
        "decode_full": {"frames": dec_full["frames"], "frame_sha256": dec_full["frameSha256"],
                        "audio_frames": dec_full["audioFrames"],
                        "audio_pcm_sha256": dec_full.get("audioPcmSha256"),
                        "audio_samples": dec_full.get("audioSamples", 0)},
        "decode_streaming": {"supported": stream_supported,
                             "frames": dec_stream["frames"], "frame_sha256": dec_stream["frameSha256"]},
        "expect": case.get("expect", {}),
        "generator": {"implementation": "ts", "case": case},
    }

    shutil.copyfile(out_a, out)
    return entry


def main() -> int:
    force = "--force" in sys.argv
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]

    cases_doc = json.loads((CORPUS / "cases.json").read_text(encoding="utf-8"))
    cases = cases_doc["cases"]
    if only:
        cases = [c for c in cases if c["id"] == only]
        if not cases:
            print(f"no case with id {only!r}")
            return 1

    manifest_path = CORPUS / "manifest.json"
    manifest = {"comment": "Frozen golden corpus. Regenerate with gen_corpus.py --force (approval test).",
                "cases": {}}
    if manifest_path.exists():
        if not force and not only:
            print(f"{manifest_path} already exists. Regenerating requires --force.")
            return 1
        if only:
            # --only updates one entry in place, keeping the rest of the
            # manifest intact (the additive-corpus workflow)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    node = shutil.which("node")
    if not node:
        print("node is required (for esbuild/tscli)")
        return 1
    bundle = ensure_bundle(node, force)

    tmp = CORPUS / ".tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        for case in cases:
            out = CORPUS / f"{case['id']}.qov"
            if out.exists() and not force and not only:
                print(f"refusing to overwrite {out.name} without --force")
                return 1
            entry = encode_case(node, bundle, case, out, tmp)
            manifest["cases"][case["id"]] = entry
            s = entry["structure"]
            print(f"{case['id']}: {entry['file_size']} bytes, {entry['decode_full']['frames']} frames, "
                  f"chunks={s['chunk_count']} motion={s['motion_chunks']} dct={s['dct_chunks']} "
                  f"lz4={s['compressed_chunks']} audio={s['audio_chunks']} "
                  f"struct_issues={len(entry['structure_issues'])}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"\nwrote {manifest_path} with {len(manifest['cases'])} case(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
