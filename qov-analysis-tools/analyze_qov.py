#!/usr/bin/env python3
"""
QOV File Analysis Tool
Structural validation for QOV (Quite OK Video) files per qov-specification.md
(v3.2). Supports v1/v2/v3 headers, 8/10-byte chunk headers, the LZ4
uncompressed-size prefix, chunk flag names, and INDEX table layout.

Importable API:
    from analyze_qov import walk_file
    result = walk_file("file.qov")   # -> {"header": {...}, "chunks": [...],
                                     #     "summary": {...}, "issues": [...]}
"""

import sys
import struct
from typing import List, Optional

CHUNK_NAMES = {
    0x00: "SYNC",
    0x01: "KEYFRAME",
    0x02: "PFRAME",
    0x03: "BFRAME",
    0x10: "AUDIO",
    0xF0: "INDEX",
    0xFF: "END",
}

COLORSPACE_NAMES = {
    0x00: "sRGB", 0x01: "sRGBA", 0x02: "Linear", 0x03: "LinearA",
    0x10: "YUV420", 0x11: "YUV422", 0x12: "YUV444", 0x13: "YUVA420",
}

FLAG_NAMES = {0x01: "HAS_ALPHA", 0x02: "HAS_MOTION", 0x04: "HAS_INDEX",
              0x08: "EXP_GOLOB", 0x10: "INTRA_REFRESH", 0x20: "LOSSY_MODE",
              0x40: "DCT_ENABLED", 0x80: "INTRA_DCT_KF"}

CHUNK_FLAG_NAMES = [(0x01, "YUV"), (0x02, "MOTION"), (0x04, "STRUCTURED"),
                    (0x08, "RANGE"), (0x10, "COMPRESSED"),
                    (0x20, "DCT_BLOCKS"), (0x40, "EXP_GOLOB"),
                    (0x80, "REFRESH_BAND")]

VALID_COLORSPACES = {0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13}


def _u16be(data: bytes, off: int) -> int:
    return (data[off] << 8) | data[off + 1]


def _u32be(data: bytes, off: int) -> int:
    return (data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]


def flag_names(flags: int) -> List[str]:
    return [name for bit, name in FLAG_NAMES.items() if flags & bit]


def chunk_flag_names(flags: int) -> List[str]:
    return [name for bit, name in CHUNK_FLAG_NAMES if flags & bit]


def parse_header(data: bytes) -> tuple:
    """Parse the v1/v2/v3 header. Returns (header_dict, issues)."""
    issues: List[str] = []
    h: dict = {}
    if len(data) < 24:
        issues.append(f"file too small for header ({len(data)} < 24 bytes)")
        return h, issues

    magic = data[0:4].decode("ascii", errors="ignore")
    version = data[4]
    flags = data[5]
    h = {
        "magic": magic, "version": version, "flags": flags,
        "width": _u16be(data, 6), "height": _u16be(data, 8),
        "fps_num": _u16be(data, 10), "fps_den": _u16be(data, 12),
        "total_frames": _u32be(data, 14),
        "audio_channels": data[18],
        "audio_rate": (data[19] << 16) | (data[20] << 8) | data[21],
        "colorspace": data[22],
        "flags_named": flag_names(flags),
        "colorspace_name": COLORSPACE_NAMES.get(data[22], f"0x{data[22]:02x}"),
    }
    h["header_size"] = 32 if version == 0x03 else 24

    if magic != "qovf":
        issues.append(f"invalid magic: {magic!r}")
    if version not in (0x01, 0x02, 0x03):
        issues.append(f"invalid version: 0x{version:02x}")
    if h["width"] == 0 or h["height"] == 0 or h["width"] > 65535 or h["height"] > 65535:
        issues.append(f"invalid dimensions: {h['width']}x{h['height']}")
    if h["fps_den"] == 0:
        issues.append("invalid frame rate: denominator is 0")
    if h["audio_channels"] > 8:
        issues.append(f"invalid audio_channels: {h['audio_channels']}")
    if h["colorspace"] not in VALID_COLORSPACES:
        issues.append(f"invalid colorspace: 0x{h['colorspace']:02x}")
    quality_byte = data[23]
    if flags & 0x20:
        h["quality_byte"] = quality_byte  # lossy: this byte is the quality level
    elif quality_byte != 0:
        issues.append(f"quality byte 23 is not 0 in a lossless file: 0x{quality_byte:02x}")

    if version == 0x03:
        if len(data) < 32:
            issues.append("v3 file too small for 32-byte header")
            return h, issues
        lossy = bool(flags & 0x20)
        h["lossy"] = {
            "quality": data[24],
            "y_quant_base": data[25],
            "uv_quant_base": data[26],
            "temporal_thresh": data[27],
            "dct_qp_base": data[28],
            "lossy_flag_set": lossy,
        }
        if not lossy:
            issues.append("v3 header without LOSSY_MODE flag")
        if any(data[29:33]):
            issues.append("v3 reserved bytes 29-32 are not zero")
    return h, issues


def walk_file(path: str, limit: Optional[int] = None) -> dict:
    """Walk a .qov file and return its structure without printing.

    Returns {"header": dict, "chunks": list, "summary": dict, "issues": list}.
    """
    with open(path, "rb") as f:
        data = f.read()

    result: dict = {"file_size": len(data), "chunks": [], "issues": []}
    header, issues = parse_header(data)
    result["header"] = header
    result["issues"].extend(issues)
    if issues and header.get("magic") != "qovf":
        result["summary"] = {"valid": False}
        return result

    pos = header["header_size"]
    version = header["version"]
    hdr_len = 10 if version >= 0x02 else 8  # v1: type, flags, u16 size, u32 ts

    type_counts: dict = {}
    frames = keyframes = pframes = 0
    motion_chunks = dct_chunks = compressed_chunks = audio_chunks = 0
    saw_end = False
    last_frame_ts = -1
    ts_warnings = 0

    while pos + hdr_len <= len(data):
        ctype = data[pos]
        cflags = data[pos + 1]
        if hdr_len == 8:
            csize = _u16be(data, pos + 2)
            pts = _u32be(data, pos + 4)
        else:
            csize = _u32be(data, pos + 2)
            pts = _u32be(data, pos + 6)

        entry = {
            "offset": pos, "type": ctype,
            "name": CHUNK_NAMES.get(ctype, f"UNKNOWN(0x{ctype:02x})"),
            "flags": cflags,
            "flag_names": chunk_flag_names(cflags),
            "size": csize, "timestamp": pts,
        }

        # LZ4-compressed frame chunks carry a 4-byte BE uncompressed size
        if cflags & 0x10 and ctype in (0x01, 0x02, 0x03):
            payload = pos + hdr_len
            if csize < 4 or payload + csize > len(data):
                result["issues"].append(
                    f"chunk at 0x{pos:x}: compressed size {csize} out of bounds")
            else:
                entry["uncompressed_size"] = _u32be(data, payload)
        elif cflags & 0x10:
            entry["uncompressed_size"] = None  # compressed non-frame chunk: unexpected
            result["issues"].append(
                f"chunk at 0x{pos:x}: COMPRESSED flag on non-frame chunk")

        if cflags & 0x02:
            motion_chunks += 1
        if cflags & 0x20:
            dct_chunks += 1
        if cflags & 0x10:
            compressed_chunks += 1

        if ctype == 0x00:  # SYNC
            payload = data[pos + hdr_len: pos + hdr_len + csize]
            if csize != 8 or payload[:4] != b"QOVS":
                result["issues"].append(f"SYNC at 0x{pos:x}: bad payload")
        elif ctype in (0x01, 0x02, 0x03):
            frames += 1
            if ctype == 0x01:
                keyframes += 1
            elif ctype == 0x02:
                pframes += 1
            if csize == 0 or csize > (1 << 30):
                result["issues"].append(f"frame chunk at 0x{pos:x}: size {csize}")
        elif ctype == 0x10:
            audio_chunks += 1
        elif ctype == 0xF0:  # INDEX: u32 count + 16-byte entries
            payload = pos + hdr_len
            end = pos + hdr_len + csize
            if csize < 4 or payload + csize > len(data):
                result["issues"].append(f"INDEX at 0x{pos:x}: size out of bounds")
            else:
                count = _u32be(data, payload)
                need = 4 + count * 16
                entry["index_entries"] = count
                if need != csize:
                    result["issues"].append(
                        f"INDEX at 0x{pos:x}: count {count} implies {need} bytes, chunk says {csize}")
                else:
                    bad_offsets = 0
                    for i in range(count):
                        off = _u32be(data, payload + 4 + i * 16 + 8)
                        if off >= len(data):
                            bad_offsets += 1
                    if bad_offsets:
                        result["issues"].append(
                            f"INDEX at 0x{pos:x}: {bad_offsets} offset(s) beyond file size")
        elif ctype == 0xFF:  # END
            saw_end = True
            if csize != 0 or cflags != 0 or pts != 0:
                result["issues"].append(f"END at 0x{pos:x}: non-zero header fields")
            if data[-8:] != bytes([0, 0, 0, 0, 0, 0, 0, 1]):
                result["issues"].append("file does not end with the 8-byte end pattern")

        if last_frame_ts >= 0 and ctype in (0x01, 0x02, 0x03) and pts < last_frame_ts:
            ts_warnings += 1
        if ctype in (0x01, 0x02, 0x03):
            last_frame_ts = pts

        type_counts[entry["name"]] = type_counts.get(entry["name"], 0) + 1
        result["chunks"].append(entry)

        pos += hdr_len + csize
        if ctype == 0xFF:
            break
        if limit is not None and len(result["chunks"]) >= limit:
            break

    if not saw_end:
        result["issues"].append("no END chunk (walk ended without type 0xFF)")

    if pos < len(data) and saw_end:
        # END chunk was the last: trailing bytes are the 8-byte pattern
        pass

    result["summary"] = {
        "chunk_count": len(result["chunks"]),
        "type_counts": type_counts,
        "frames": frames,
        "keyframes": keyframes,
        "pframes": pframes,
        "motion_chunks": motion_chunks,
        "dct_chunks": dct_chunks,
        "compressed_chunks": compressed_chunks,
        "audio_chunks": audio_chunks,
        "has_end": saw_end,
        "timestamp_regressions": ts_warnings,
        "valid": len(result["issues"]) == 0,
    }
    return result


class QovAnalyzer:
    """CLI wrapper around walk_file (kept for standalone use)."""

    def __init__(self, filename: str, limit: Optional[int] = None):
        self.filename = filename
        self.limit = limit
        self.result = None

    def analyze(self) -> bool:
        print(f"=== Analyzing {self.filename} ===")
        try:
            self.result = walk_file(self.filename, self.limit)
        except FileNotFoundError:
            print(f"File not found: {self.filename}")
            return False
        except Exception as e:  # noqa: BLE001 - CLI boundary
            print(f"Error analyzing file: {e}")
            return False

        h = self.result["header"]
        print(f"File size: {self.result['file_size']} bytes")
        if h:
            print(f"Version: 0x{h['version']:02x}  Colorspace: {h.get('colorspace_name')}")
            print(f"Dimensions: {h['width']}x{h['height']}  FPS: {h['fps_num']}/{h['fps_den']}")
            print(f"Flags: 0x{h['flags']:02x} ({', '.join(h['flags_named']) or 'none'})")
            if "lossy" in h:
                print(f"Lossy: quality={h['lossy']['quality']} yQuant={h['lossy']['y_quant_base']} "
                      f"uvQuant={h['lossy']['uv_quant_base']} dctQp={h['lossy']['dct_qp_base']}")

        s = self.result["summary"]
        print(f"\nChunks: {s['chunk_count']}  "
              f"(frames={s['frames']} keyframes={s['keyframes']} motion={s['motion_chunks']} "
              f"dct={s['dct_chunks']} lz4={s['compressed_chunks']} audio={s['audio_chunks']})")
        for name, count in sorted(s["type_counts"].items()):
            print(f"  {name}: {count}")

        if self.result["issues"]:
            print(f"\nFILE IS INVALID — {len(self.result['issues'])} issue(s):")
            for issue in self.result["issues"]:
                print(f"  - {issue}")
            return False
        print("\nFILE IS VALID")
        return True


def main():
    args = [a for a in sys.argv[1:] if a != "--limit"]
    limit = None
    if "--limit" in sys.argv:
        i = sys.argv.index("--limit")
        limit = int(sys.argv[i + 1])
    if not args:
        print("Usage: python analyze_qov.py <filename.qov> [--limit N]")
        print("\nStructural validation per qov-specification.md (v1/v2/v3).")
        sys.exit(1)

    ok = QovAnalyzer(args[0], limit).analyze()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
