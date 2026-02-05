# QOV (Quite OK Video) Format Specification

**Version:** 3.0 (Unified)
**Date:** February 2026
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

If `LOSSY_MODE` is enabled, additional opcodes are available.

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

---

## 4. Lossy Quality & Quantization

In Lossy Mode (v3), pixel data can be quantized *before* encoding.

### 4.1 Quality Levels (0-100)

| Quality | Y Quant | UV Quant | Temporal Thresh | DCT QP | Typical Ratio |
|---------|---------|----------|-----------------|--------|---------------|
| 100     | 1       | 2        | 1               | 0      | 1.5-3x        |
| 85      | 3       | 6        | 2               | 20     | 3-6x          |
| 50      | 7       | 15       | 4               | 30     | 12-20x        |
| 30      | 10      | 25       | 6               | 38     | 20-35x        |

If header bytes 24-27 are zero, the decoder derives these parameters from the `quality` byte (byte 23).

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
    - Bit 1 (`HAS_MOTION`): If set, starts with Motion Vector Block.
- **Motion Vector Block**:
    - `block_size_id` (1 byte): 0=8x8, 1=16x16, 2=32x32.
    - `mv_count` (2 bytes).
    - `vectors` (2 bytes each): `mv_x` (1b), `mv_y` (1b).

### 5.3 Audio (QOA)
- **Header**: Type `0x10`.
- **Format**: Based on QOA specification.
- **Structure**: `[samples_per_channel (2b)]` + `[LMS State]` + `[Slices]`.

### 5.4 Sync Marker
- **Header**: Type `0x00`, Size 8.
- **Content**: `"QOVS" (4 bytes)` + `frame_number (4 bytes)`.

### 5.5 Index Table
- **Header**: Type `0xF0`.
- **Location**: End of file.
- **Content**: List of `[frame_num (4b), offset (8b), timestamp (4b)]` for all keyframes.

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
        // LZ4 Decompress payload first
        payload = lz4_decompress(data + p + 10, ...);
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
