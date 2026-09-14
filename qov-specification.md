# QOV (Quite OK Video) Format Specification

**Version:** 3.2 (Unified)
**Date:** September 2026
**Based on:** QOI (Quite OK Image) and QOA (Quite OK Audio)

---

## Overview

QOV is a simple, fast video format designed for real-time performance and ease of implementation. It supports a spectrum of use cases from strictly lossless, fast-decode scenarios to highly compressed lossy video.

**Key Features:**
- **Fast Decoding**: Designed for CPU-based decoding without specialized hardware.
- **Simplicity**: Reference decoder implementation in ~500-1000 lines of Code.
- **Flexibility**:
    - **Lossless Mode**: RGB/RGBA or YUV 4:4:4/4:2:2/4:2:0.
    - **Lossy Mode**: 10-50x compression with configurable quality (Quantization, DCT).
- **Streaming**: Unknown length streams with sync markers.

---

## 1. File Header

The file starts with a 24-byte (v1/v2) or 32-byte (v3 lossy) header.

### 1.1 Header Layout

```
Offset  Size  Name            Description
──────────────────────────────────────────────────────────────
0       4     magic           Magic bytes "qovf" (0x716f7666)
4       1     version         Format version (0x01=Small, 0x02=Large, 0x03=Lossy)
5       1     flags           Feature flags (bitfield)
6       2     width           Video width (1-65535), big-endian
8       2     height          Video height (1-65535), big-endian
10      2     frame_rate_num  Frame rate numerator, big-endian
12      2     frame_rate_den  Frame rate denominator, big-endian
14      4     total_frames    Total frame count (0 = unknown/streaming)
18      1     audio_channels  Audio channels (0 = no audio, 1-8)
19      3     audio_rate      Audio sample rate (0-16777215 Hz), big-endian
22      1     colorspace      Color space identifier
23      1     quality         Quality level (0-100). 0=Lossless, 100=Near-lossless.
```

**Extended Header (Version 0x03 only):**
If `version` is `0x03`, the header is 32 bytes long.

```
Offset  Size  Name            Description
──────────────────────────────────────────────────────────────
24      1     y_quant_base    Y plane base quantization (1-64 or 0 to derive)
25      1     uv_quant_base   UV plane base quantization (1-64 or 0 to derive)
26      1     temporal_thresh Temporal similarity threshold (0-32 or 0 to derive)
27      1     dct_qp_base     Base QP for DCT blocks (0-51 or 0 to derive)
28      4     reserved        Must be 0x00000000
```

### 1.2 Versions

```
Value  Name            Description
────────────────────────────────────────────────────────────
0x01   QOV_V1          16-bit chunk sizes, strictly lossless.
0x02   QOV_V2          32-bit chunk sizes, strictly lossless.
0x03   QOV_V3          32-bit chunk sizes, supports lossy features.
```

### 1.3 Flags Byte (Bitfield)

```
Bit  Name           Description
────────────────────────────────────────────────────────────
0    HAS_ALPHA      Frames include alpha channel
1    HAS_MOTION     Motion vectors enabled for P/B-frames
2    HAS_INDEX      Index table present at end of file
3    HAS_BFRAMES    B-frames present (requires decode reordering)
4    ENHANCED_COMP  Enhanced compression mode (slower decode)
5    LOSSY_MODE     Lossy encoding enabled (Version 0x03+)
6    DCT_ENABLED    DCT block encoding available (Version 0x03+)
7    Reserved       Must be 0
```

### 1.4 Colorspace Byte

```
Value  Name       Description
────────────────────────────────────────────────────────────
0x00   SRGB       sRGB, 8-bit RGB (QOI compatible)
0x01   SRGBA      sRGB + Alpha, 8-bit RGBA
0x02   LINEAR     Linear RGB, 8-bit
0x03   LINEAR_A   Linear RGBA, 8-bit
0x10   YUV420     YCbCr 4:2:0, 8-bit (best compression)
0x11   YUV422     YCbCr 4:2:2, 8-bit
0x12   YUV444     YCbCr 4:4:4, 8-bit
0x13   YUVA420    YCbCr 4:2:0 + Alpha, 8-bit
```

---

## 2. Chunk Structure

All chunks share a common header format.

**Version 0x01 (8-byte header):**
`chunk_size` is 16-bit. Max chunk size 65KB.

**Version 0x02 / 0x03 (10-byte header):**
`chunk_size` is 32-bit. Supports large frames (>65KB).

```
Offset  Size  Name         Description
──────────────────────────────────────────────────────────────
0       1     chunk_type   Chunk type identifier
1       1     chunk_flags  Chunk-specific flags
2       4     chunk_size   Size of data after header, big-endian (32-bit)
6       4     timestamp    Timestamp in microseconds, big-endian
```

### 2.1 Chunk Type IDs

```
Value  Name      Description
────────────────────────────────────────────────────────────
0x00   SYNC      Sync marker (streaming recovery point)
0x01   KEYFRAME  I-frame (complete image)
0x02   PFRAME    P-frame (references previous frame)
0x03   BFRAME    B-frame (bidirectional reference)
0x10   AUDIO     Audio data (QOA-based)
0xF0   INDEX     Seek index table
0xFF   END       End of stream marker
```

### 2.2 Chunk Flags & Compression

```
Bit  Name        Description
────────────────────────────────────────────────────────────
0    YUV_MODE    Frame uses YUV plane-based encoding (0x01)
1    HAS_MOTION  Frame includes motion vectors (0x02)
4    COMPRESSED  Chunk data is LZ4 compressed (0x10)
5    DCT_BLOCKS  Frame uses DCT block encoding (0x20) - NEW in v3
6    ADAPTIVE_Q  Per-block adaptive quantization (0x40) - NEW in v3
```

**LZ4 Compression (Bit 4):**
If set, the payload strictly follows `[uncompressed_size (4 bytes)] + [LZ4 block]`.

---

## 3. Video Opcodes & Encoding Modes

QOV supports multiple encoding "modes" depending on the Flags and Chunk settings.

### 3.1 RGB Mode (QOI-Compatible)
Used when Colorspace is RGB/RGBA and `YUV_MODE` bit is **0**.

```
Byte Range   Name           Structure
──────────────────────────────────────────────────────────────
0x00-0x3F    QOV_OP_INDEX   | 00 | index (6 bits) |
                            Hash: (r*3 + g*5 + b*7 + a*11) % 64

0x40-0x7F    QOV_OP_DIFF    | 01 | dr (2) | dg (2) | db (2) |
                            Bias: 2

0x80-0xBF    QOV_OP_LUMA    | 10 | dg (6 bits) |
                            | dr-dg (4) | db-dg (4) |

0xC0-0xFD    QOV_OP_RUN     | 11 | run (6 bits) |
                            Run length 1-62

0xFE         QOV_OP_RGB     | 11111110 | r | g | b |
0xFF         QOV_OP_RGBA    | 11111111 | r | g | b | a |
```

### 3.2 YUV Mode (Plane-Based)
Used when `YUV_MODE` bit is **1**. Planes (Y, U, V, A) are encoded sequentially.

```
Byte Range   Name            Structure
──────────────────────────────────────────────────────────────
0x00-0x3F    QOV_YUV_INDEX   | 00 | index (6 bits) |
                             Hash: (value * 3) % 64

0x40-0x4F    QOV_YUV_DIFF    | 0100 | d (4 bits) |
                             Bias: 8

0x80-0xBF    QOV_YUV_LUMA    | 10 | d (6 bits) |
                             Bias: 32

0xC0-0xFD    QOV_YUV_RUN     | 11 | run (6 bits) |

0xFE         QOV_YUV_FULL    | 11111110 | value |
```

**CRITICAL Implementation Note:**
The 64-entry index cache MUST be initialized to **-1** (not 0) at the start of each keyframe in YUV mode. This prevents conflict with the value 0.

**Index cache semantics (normative):**
- `INDEX` is pure retrieval: the cache is updated **only** by `DIFF`/`LUMA`/`FULL`
  (each writes `cache[(value * 3) % 64] = value`). A conforming encoder never
  emits `INDEX` for a slot it did not populate first, and a cached value is
  never invalidated by being read. Reference decoders re-store the retrieved
  value after `INDEX`; this is a no-op on valid streams and only pins the
  behavior of the uninitialized-slot fallback (emit neutral 128).
- Unlike the YUV P-frame coder (§3.3), the keyframe coder has no `SKIP_LONG`
  opcode, so byte `0x00` = `INDEX[0]` is **valid** here. Since the hash of
  value 0 is slot 0, keyframe `INDEX[0]` always refers to the value 0.

### 3.3 Temporal Opcodes (P-frames)

**RGB P-frames (No Motion Vectors):**
```
0xC0-0xFD    QOV_OP_SKIP       | 11 | count (6 bits) |
0x00         QOV_OP_SKIP_LONG  | 00000000 | count (16b) |
0x40-0x7F    QOV_OP_TDIFF      | 01 | dr | dg | db |
0x80-0xBF    QOV_OP_TLUMA      | 10 | dg | dr-dg | db-dg |
```

**YUV P-frames:**
```
0xC0-0xFD    QOV_YUV_SKIP      | 11 | count (6 bits) |
0x00         QOV_YUV_SKIP_LONG | 00000000 | count (16b) |
0x01-0x3F    QOV_YUV_INDEX     | 00 | index (6b) | (Index 0 FORBIDDEN)
0x40-0x4F    QOV_YUV_TDIFF     | 0100 | d (4b) |
0x80-0xBF    QOV_YUV_TLUMA     | 10 | d (6b) |
0xFE         QOV_YUV_FULL      | 11111110 | value |
```
*Note: In YUV P-frames, `0x00` is `SKIP_LONG`. Therefore `INDEX[0]` cannot be used and must be encoded as `FULL`.*

### 3.4 Lossy Extensions (Version 0x03)

If `LOSSY_MODE` is enabled, additional opcodes are available. The opcodes
defined in this section (0x50-0x53, 0x58-0x59) take **precedence** over the
base opcode ranges of §3.3 when the corresponding feature is in use
(DCT_BLOCKS chunk flag for 0x50-0x53; lossy encoding for 0x58-0x59).

#### 3.4.1 Lossy Skip (Similarity)
Allows skipping pixels that are "close enough" to the reference frame.

```
0x58         QOV_OP_SKIP_SIMILAR      | 01011000 | count | threshold |
                                      Skip count pixels where diff <= threshold

0x59         QOV_OP_SKIP_SIMILAR_LONG | 01011001 | count (16b) | threshold |
```

#### 3.4.2 DCT Block Encoding
Enabled via `DCT_BLOCKS` chunk flag. Operates on 8x8 blocks.

```
0x50        QOV_OP_DCT_Y      | 01010000 | [DCT Data]
0x51        QOV_OP_DCT_UV     | 01010001 | [DCT Data]
0x52        QOV_OP_DCT_SKIP   | 01010010 | count |
                              Skip ‘count’ 8x8 blocks (copy from ref)
0x53        QOV_OP_DCT_ZERO   | 01010011 | count |
                              ‘count’ blocks have zero residual (use MV only)
```

**DCT Data Format:**
1.  `qp_delta` (1 byte): `| 0 | delta (7 bits, bias 64) |`
2.  `DC_coeff` (2 bytes): 16-bit signed, big-endian.
3.  `AC_coeffs`: Run-Level encoded.
    - Pair: `| run (4b) | level_size (4b) |` + `level` (1-4 bytes).
    - `0x00`: EOB (End of Block).
    - `0xF0`: Zero run of 16.

**Normative details:**
- All multi-byte coefficients (the 2-byte DC and every AC `level`) are
  **big-endian two's complement** integers of `level_size` bytes.
- The `count` operand of `QOV_OP_DCT_SKIP` and `QOV_OP_DCT_ZERO` is
  **1 byte** (1-255).
- In a DCT P-frame, the planes appear in **Y, U, V** order (then A if
  present). Blocks of each plane are signaled with that plane's opcode
  (`0x50` for Y, `0x51` for U and V).
- Plane geometry follows the header colorspace (§2.1), with odd sizes
  rounded up: 4:2:0 and YUVA420 chroma planes are ⌈width/2⌉ × ⌈height/2⌉,
  4:2:2 chroma is ⌈width/2⌉ × height, and 4:4:4 chroma is width × height.
  The alpha plane, when present, uses luma dimensions (width × height)
  and the luma quantizer.
- `DCT_BLOCKS` and `COMPRESSED` (§2.2) are independent: a DCT chunk may
  be stored LZ4-compressed or raw.
- The coefficient scan order (zigzag), the quantization tables, and the
  QP-to-scalefactor mapping are **implementation-defined**: they are not
  part of this specification and encoder/decoder must agree on them out
  of band. Files written by an independent implementation may not decode
  correctly even when the byte format above is followed.

---

## 4. Lossy Quality & Quantization

In Lossy Mode (v3), pixel data can be quantized *before* encoding.

### 4.1 Quality Levels (0-100)

The parameters below are **derived, not stored**: they are computed from the
`quality` byte with the normative formula in §6.2 (integer division, truncation
toward zero). This table is informational.

| Quality | Y Quant | UV Quant | Temporal Thresh | DCT QP | Typical Ratio |
|---------|---------|----------|-----------------|--------|---------------|
| 100     | 1       | 2        | 0               | 0      | 1.5-3x        |
| 85      | 2       | 5        | 1               | 8      | 3-6x          |
| 50      | 7       | 14       | 4               | 26     | 12-20x        |
| 30      | 9       | 19       | 5               | 36     | 20-35x        |

If header bytes 24-27 are zero, the decoder derives these parameters from the `quality` byte (byte 23) using §6.2.

### 4.2 Pixel Quantization (Simple Mode)
Pixels are converted to YUV internally, quantized, and converted back to RGB (or left as YUV planes) before standard QOV encoding.

---

## 5. Frame & Packet Reference

### 5.1 Keyframe (I-Frame)
- **Header**: Type `0x01`.
- **Data**: Full pixel data.
- **YUV Order**: Y Plane, then U Plane, then V Plane.
- **End Marker**: `0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01`.

### 5.2 P-Frame
- **Header**: Type `0x02`.
- **Bits**:
    - Bit 1 (`HAS_MOTION`): If set, the payload **starts with a Motion Vector
      Block**, followed by the normal P-frame opcode stream.
- **Motion Vector Block** (syntax):
    - `block_size_id` (1 byte): 0=8x8, 1=16x16, 2=32x32.
    - `mv_count` (2 bytes, big-endian).
    - `vectors` (2 bytes each): `mv_x` (1 byte, signed), `mv_y` (1 byte, signed).
- **Motion compensation semantics (normative, v3.2):**
    - The block grid covers the frame in row-major order from block (0,0):
      `grid_width = ceil(width / B)`, `grid_height = ceil(height / B)`, with
      `B` the selected block size. The first `mv_count` grid blocks carry the
      written vectors in row-major order; **every grid block after `mv_count`
      defaults to vector (0, 0)**.
    - The vectors define the effective P-frame reference: for each block, the
      predictor is the previous frame (or plane) copied from
      `(x + mv_x, y + mv_y)`, with source coordinates **clamped** to the frame
      borders (never wrapped). All P-frame coding — skip runs, TDIFF/TLUMA
      deltas, SKIP_SIMILAR, and DCT residual blocks — then applies against
      this compensated reference exactly as it would against the previous
      frame itself.
    - **Chroma planes** (YUV modes) use the luma vector field at chroma
      resolution: the chroma-grid block containing chroma pixel (cx, cy) uses
      the luma vector of the luma block containing the corresponding luma
      pixel, shifted per subsampled axis with an arithmetic shift:
      `mv_c = mv_luma >> 1` — both axes for 4:2:0/YUVA420, horizontal only
      for 4:2:2, unchanged for 4:4:4. The alpha plane uses luma vectors at
      luma resolution.
    - Vectors are **integer-pel** with range ±127 pixels. Half-pel vectors
      are reserved for a future extension (no flag is defined in v3.2).
    - Decoders MUST honor all three `block_size_id` values. v3.2 encoders
      emit `block_size_id = 1` (16x16).
    - The MV block appears **at most once per chunk**, before all pixel and
      plane streams. Header flag `HAS_MOTION` (bit 3) declares that a file
      uses motion vectors; individual P-frames still choose per chunk via
      chunk flag bit 1.

### 5.3 Audio (QOA)
- **Header**: Type `0x10`.
- **Format**: A standard QOA frame as defined by the QOA specification.
- **Structure**: `[frame header (8b: channels (1b), sample_rate (3b), samples_per_channel (2b), frame_size (2b), all big-endian)]` + `[LMS State (16b per channel)]` + `[Slices (8b per slice per channel, interleaved per channel)]`.

### 5.4 Sync Marker
- **Header**: Type `0x00`, Size 8.
- **Content**: `"QOVS" (4 bytes)` + `frame_number (4 bytes)`.

### 5.5 Index Table
- **Header**: Type `0xF0`.
- **Location**: End of file, immediately before the END chunk.
- **Content**: `entry_count (4 bytes)` followed by `entry_count` entries of `[frame_num (4b), offset (8b), timestamp (4b)]` (16 bytes each) for all keyframes.

---

## 6. Pseudocode Reference

### 6.1 Generic Decoder Loop

```c
// Simplified Main Loop
while (p < file_size) {
    chunk_type = data[p];
    chunk_flags = data[p+1];
    chunk_size = read_u32(data + p + 2); // Assume v2/v3
    
    // Header parsing...
    
    if (chunk_flags & COMPRESSED) {
        // Payload: [uncompressed_size (4 bytes, big-endian)] + [LZ4 block].
        // The uncompressed_size field is INCLUDED in chunk_size.
        uncompressed_size = read_u32(data + p + 10);
        payload = lz4_decompress(data + p + 14, uncompressed_size);
    } else {
        payload = data + p + 10;
    }
    
    switch (chunk_type) {
        case KEYFRAME: decode_keyframe(payload, chunk_flags); break;
        case PFRAME:   decode_pframe(payload, chunk_flags); break;
        case AUDIO:    decode_audio(payload); break;
        // ...
    }
}
```

### 6.2 Lossy Parameter Derivation

```c
void derive_lossy_params(int quality, lossy_params_t* params) {
    // 0-100 quality mapping
    params->y_quant = CLAMP(1 + (100 - quality) / 8, 1, 64);
    params->uv_quant = CLAMP(2 + (100 - quality) / 4, 1, 64);
    params->temporal_thresh = CLAMP((100 - quality) / 12, 0, 32);
    params->dct_qp = CLAMP(51 - (quality * 51 / 100), 0, 51);
}
```

### 6.3 Lossy Skip Logic (P-Frames)

```c
// Within encode loop:
if (lossy_mode) {
    if (abs(c.r - r.r) <= threshold &&
        abs(c.g - r.g) <= threshold &&
        abs(c.b - r.b) <= threshold &&
        abs(c.a - r.a) <= threshold/2) {
            // Count as "similar" -> Increment Skip Counter
            // Note: Decoder just copies ref pixel, so "visual" error accumulates
            continue; 
    }
}
```

---

## License

This specification is placed in the public domain.

---

## Changelog

### 3.2 (September 2026)
- §5.2: motion vectors are now normative. Defined the MV block placement at
  the start of a MOTION P-frame payload, the row-major block grid with
  implicit (0,0) vectors after `mv_count`, clamped border handling, the
  compensated-reference rule for all P-frame opcodes (including SKIP_SIMILAR
  and DCT residuals), chroma derivation (`mv_c = mv_luma >> 1` per subsampled
  axis), integer-pel vectors in the range ±127, and the division of roles
  between the `HAS_MOTION` header flag (file-wide) and chunk flag bit 1
  (per P-frame).

### 3.1 (September 2026) — Errata
- §4.1: quality parameter table corrected to match the normative §6.2
  derivation (the previous table contradicted it, most severely for DCT QP);
  §6.2 marked as normative.
- §6.1: decoder pseudocode fixed to skip the 4-byte `uncompressed_size`
  field before LZ4 decompression, consistent with §2.2.
- §5.5: documented the `entry_count` field and the index position relative
  to the END chunk.
- §5.3: audio chunk structure corrected to the real QOA frame layout
  (8-byte frame header, LMS state, interleaved slices).
- §3.4: added opcode precedence over the base §3.3 ranges; §3.4.2 added
  normative byte order for coefficients, `count` operand width, DCT plane
  ordering, and declared zigzag/quantization implementation-defined.
- §3.4.2: specified DCT plane geometry per colorspace (chroma derived
  from the header colorspace, alpha at luma dimensions with the luma
  quantizer) and clarified that `DCT_BLOCKS` and `COMPRESSED` are
  independent, i.e. DCT chunks may be stored uncompressed.
