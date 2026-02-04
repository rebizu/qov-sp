# QOV Lossy Extension Specification

**Version:** 1.0
**Date:** February 2026
**Extends:** QOV Specification v1.0

---

## Overview

This document specifies the **lossy extension** to the QOV (Quite OK Video) format. The lossy mode provides significantly better compression ratios while maintaining the simplicity and speed that define QOV.

**Design Goals:**
- **10-50x compression** vs lossless QOV (quality dependent)
- **Configurable quality** from near-lossless to highly compressed
- **Backward compatible** - lossy files use same container structure
- **Simple implementation** - adds ~200-400 lines to reference decoder
- **Fast decode** - maintains QOV's decode-speed priority

---

## 1. Header Changes

### 1.1 Version Byte

Lossy QOV uses version `0x03` to indicate lossy capability:

```
Version  Description
────────────────────────────────────────────────────────────
0x01     Original QOV (16-bit chunk sizes, lossless)
0x02     Extended QOV (32-bit chunk sizes, lossless)
0x03     Lossy QOV (32-bit chunk sizes, lossy support)
```

### 1.2 Extended Flags Byte

```
Bit  Name           Description
────────────────────────────────────────────────────────────
0    HAS_ALPHA      Frames include alpha channel
1    HAS_MOTION     Motion vectors enabled
2    HAS_INDEX      Index table present
3    HAS_BFRAMES    B-frames present
4    ENHANCED_COMP  LZ4 compression enabled
5    LOSSY_MODE     Lossy encoding enabled (NEW)
6    DCT_ENABLED    DCT block encoding available (NEW)
7    Reserved       Must be 0
```

### 1.3 Quality Byte (Offset 23)

The reserved byte at offset 23 becomes the **quality level**:

```
Offset  Size  Name      Description
────────────────────────────────────────────────────────────
23      1     quality   Quality level (0-100, 100 = near-lossless)
                        Only meaningful when LOSSY_MODE flag is set
                        For lossless files, must be 0x00
```

### 1.4 Extended Header (Version 0x03, 32 bytes)

For advanced lossy features, version 0x03 extends the header:

```
Offset  Size  Name              Description
────────────────────────────────────────────────────────────
0       4     magic             "qovf" (0x716f7666)
4       1     version           0x03 (lossy capable)
5       1     flags             Feature flags with lossy bits
6       2     width             Video width, big-endian
8       2     height            Video height, big-endian
10      2     frame_rate_num    Frame rate numerator
12      2     frame_rate_den    Frame rate denominator
14      4     total_frames      Total frame count (0 = unknown)
18      1     audio_channels    Audio channels (0-8)
19      3     audio_rate        Audio sample rate, big-endian
22      1     colorspace        Color space identifier
23      1     quality           Quality level (0-100)
24      1     y_quant_base      Y plane base quantization (1-64)
25      1     uv_quant_base     UV plane base quantization (1-64)
26      1     temporal_thresh   Temporal similarity threshold (0-32)
27      1     dct_qp_base       Base QP for DCT blocks (0-51)
28      4     reserved          Must be 0x00000000
```

**Note:** For simpler lossy encoding, only `quality` (byte 23) is required.
Bytes 24-27 provide fine-grained control; if zero, derive from `quality`.

---

## 2. Quality Levels

### 2.1 Quality Presets

| Quality | Name           | Y Quant | UV Quant | Temporal | DCT QP | Typical Ratio |
|---------|----------------|---------|----------|----------|--------|---------------|
| 95-100  | Near-lossless  | 1-2     | 2-4      | 1        | N/A    | 1.5-3x        |
| 85-94   | High           | 2-4     | 4-8      | 2        | 18-22  | 3-6x          |
| 70-84   | Medium-High    | 4-6     | 8-12     | 3        | 22-28  | 6-12x         |
| 50-69   | Medium         | 6-8     | 12-20    | 4        | 28-34  | 12-20x        |
| 30-49   | Low            | 8-12    | 20-32    | 6        | 34-42  | 20-35x        |
| 0-29    | Very Low       | 12-16   | 32-48    | 8        | 42-51  | 35-50x        |

### 2.2 Deriving Parameters from Quality

When extended header fields (bytes 24-27) are zero, derive from quality:

```c
// Derive quantization parameters from quality (0-100)
void derive_lossy_params(int quality, lossy_params_t* params) {
    // Y plane quantization (preserve luminance detail)
    params->y_quant = 1 + (100 - quality) / 8;      // 1-13

    // UV plane quantization (can be more aggressive)
    params->uv_quant = 2 + (100 - quality) / 4;     // 2-27

    // Temporal similarity threshold for P-frames
    params->temporal_thresh = (100 - quality) / 12;  // 0-8

    // DCT quantization parameter (if DCT enabled)
    params->dct_qp = 51 - (quality * 51 / 100);      // 0-51

    // Clamp to valid ranges
    params->y_quant = CLAMP(params->y_quant, 1, 64);
    params->uv_quant = CLAMP(params->uv_quant, 1, 64);
    params->temporal_thresh = CLAMP(params->temporal_thresh, 0, 32);
    params->dct_qp = CLAMP(params->dct_qp, 0, 51);
}
```

---

## 3. Lossy Encoding Modes

### 3.1 Mode Overview

Lossy QOV supports three encoding modes, selectable per-chunk:

| Mode | Chunk Flag | Description | Best For |
|------|------------|-------------|----------|
| Quantized Pixel | 0x00 | Pre-quantized standard opcodes | Simple, fast |
| Quantized YUV | 0x01 | Quantized YUV plane encoding | Most content |
| DCT Block | 0x21 | 8x8 DCT transform blocks | Complex scenes |

### 3.2 Chunk Flags (Lossy Extension)

```
Bit  Name           Description
────────────────────────────────────────────────────────────
0    YUV_MODE       Frame uses YUV plane encoding
1    HAS_MOTION     Frame has motion vectors
2    Reserved       Must be 0
3    Reserved       Must be 0
4    COMPRESSED     LZ4 compressed
5    DCT_BLOCKS     Frame uses DCT block encoding (NEW)
6    ADAPTIVE_Q     Per-block adaptive quantization (NEW)
7    Reserved       Must be 0
```

---

## 4. Quantized Pixel Mode (Simplest)

### 4.1 Overview

The simplest lossy mode: quantize pixel values before encoding with standard opcodes.
Existing decoders can play these files without modification.

### 4.2 Quantization Process

**Encoder (before standard encoding):**
```c
void quantize_pixel(qov_rgba_t* pixel, int y_quant, int uv_quant) {
    // Convert to YUV for perceptual quantization
    int y  = (66 * pixel->r + 129 * pixel->g + 25 * pixel->b + 128) >> 8;
    int cb = (-38 * pixel->r - 74 * pixel->g + 112 * pixel->b + 128) >> 8;
    int cr = (112 * pixel->r - 94 * pixel->g - 18 * pixel->b + 128) >> 8;

    y = 16 + y;
    cb = 128 + cb;
    cr = 128 + cr;

    // Quantize (Y less, UV more)
    y = ((y / y_quant) * y_quant);
    cb = ((cb / uv_quant) * uv_quant);
    cr = ((cr / uv_quant) * uv_quant);

    // Convert back to RGB
    int c = y - 16;
    int d = cb - 128;
    int e = cr - 128;

    pixel->r = CLAMP((298 * c + 409 * e + 128) >> 8, 0, 255);
    pixel->g = CLAMP((298 * c - 100 * d - 208 * e + 128) >> 8, 0, 255);
    pixel->b = CLAMP((298 * c + 516 * d + 128) >> 8, 0, 255);
    // Alpha unchanged
}
```

### 4.3 Temporal Threshold for P-Frames

In lossy mode, P-frames can skip pixels that are "close enough":

```c
bool pixels_similar(qov_rgba_t a, qov_rgba_t b, int threshold) {
    return abs(a.r - b.r) <= threshold &&
           abs(a.g - b.g) <= threshold &&
           abs(a.b - b.b) <= threshold &&
           abs(a.a - b.a) <= (threshold / 2);  // Alpha more sensitive
}

// In P-frame encoder:
if (pixels_similar(current, reference, temporal_thresh)) {
    // Emit SKIP opcode (unchanged from reference)
    skip_count++;
} else {
    // Encode difference or full pixel
}
```

---

## 5. Quantized YUV Mode

### 5.1 Overview

Encode YUV planes with per-plane quantization. Best compression for most content.

### 5.2 Plane Quantization

```c
// Quantize a single plane value
uint8_t quantize_plane(uint8_t value, int quant_step, int plane_type) {
    // Round to nearest quantization level
    int quantized = ((value + quant_step/2) / quant_step) * quant_step;
    return CLAMP(quantized, 0, 255);
}

// Encode YUV frame with lossy quantization
void encode_yuv_lossy(encoder_t* enc, uint8_t* y, uint8_t* u, uint8_t* v,
                      int y_quant, int uv_quant) {
    // Quantize Y plane (less aggressive)
    for (int i = 0; i < y_size; i++) {
        y[i] = quantize_plane(y[i], y_quant, PLANE_Y);
    }

    // Quantize U plane (more aggressive)
    for (int i = 0; i < uv_size; i++) {
        u[i] = quantize_plane(u[i], uv_quant, PLANE_U);
    }

    // Quantize V plane (more aggressive)
    for (int i = 0; i < uv_size; i++) {
        v[i] = quantize_plane(v[i], uv_quant, PLANE_V);
    }

    // Encode with standard YUV opcodes
    encode_yuv_plane(enc, y, y_size);
    encode_yuv_plane(enc, u, uv_size);
    encode_yuv_plane(enc, v, uv_size);
}
```

### 5.3 Adaptive Quantization (Optional)

When ADAPTIVE_Q flag is set, quantization varies by region:

```c
// Compute local activity (edge detection)
int compute_activity(uint8_t* plane, int x, int y, int stride) {
    int center = plane[y * stride + x];
    int activity = 0;

    // Sobel-like edge detection
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) continue;
            int neighbor = plane[(y+dy) * stride + (x+dx)];
            activity += abs(center - neighbor);
        }
    }

    return activity;
}

// Adjust quantization based on activity
int adaptive_quant(int base_quant, int activity) {
    // High activity (edges) = less quantization
    // Low activity (flat areas) = more quantization
    if (activity > 100) return max(1, base_quant / 2);
    if (activity > 50) return base_quant;
    return base_quant * 3 / 2;
}
```

---

## 6. DCT Block Mode

### 6.1 Overview

For maximum compression, use 8x8 DCT transform blocks similar to JPEG/MPEG.
This mode provides 2-5x better compression than quantized pixel mode.

### 6.2 New Opcodes

```
Byte        Name              Structure
────────────────────────────────────────────────────────────
0x50        QOV_OP_DCT_Y      | 01010000 |
                              DCT block for Y plane
                              Followed by DCT data

0x51        QOV_OP_DCT_UV     | 01010001 |
                              DCT block for U or V plane
                              Followed by DCT data

0x52        QOV_OP_DCT_SKIP   | 01010010 | count |
                              Skip count DCT blocks (copy from ref)

0x53        QOV_OP_DCT_ZERO   | 01010011 | count |
                              count blocks are all-zero residual

0x54-0x5F   Reserved          Reserved for future DCT modes
```

### 6.3 DCT Block Data Format

```
DCT Block Structure:
────────────────────────────────────────────────────────────
Byte 0:     qp_delta (signed, -16 to +15 from base QP)
            | 0 | qp_delta (7 bits, bias 64) |

Bytes 1-2:  DC coefficient (16-bit signed, big-endian)

Bytes 3+:   AC coefficients (run-level encoded)
            Each AC pair:
              | run (4 bits) | level_size (4 bits) |
              | level (1-4 bytes based on level_size) |

            Special codes:
              run=0, level_size=0: End of block (EOB)
              run=15, level_size=0: Zero run of 16
```

### 6.4 DCT Implementation

```c
// Standard 8x8 DCT (can use fast integer approximation)
void dct_8x8(int16_t block[64]) {
    // Apply 1D DCT to rows
    for (int i = 0; i < 8; i++) {
        dct_1d(&block[i * 8]);
    }
    // Apply 1D DCT to columns
    for (int i = 0; i < 8; i++) {
        int16_t col[8];
        for (int j = 0; j < 8; j++) col[j] = block[j * 8 + i];
        dct_1d(col);
        for (int j = 0; j < 8; j++) block[j * 8 + i] = col[j];
    }
}

// Quantization matrix (can be scaled by QP)
const uint8_t QUANT_MATRIX[64] = {
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68,109,103, 77,
    24, 35, 55, 64, 81,104,113, 92,
    49, 64, 78, 87,103,121,120,101,
    72, 92, 95, 98,112,100,103, 99
};

// Quantize DCT coefficients
void quantize_dct(int16_t block[64], int qp) {
    int scale = 1 << (qp / 6);
    int offset = qp % 6;

    for (int i = 0; i < 64; i++) {
        int q = QUANT_MATRIX[i] * scale;
        block[i] = (block[i] + (block[i] > 0 ? q/2 : -q/2)) / q;
    }
}

// Zigzag scan order for run-length encoding
const uint8_t ZIGZAG[64] = {
     0,  1,  8, 16,  9,  2,  3, 10,
    17, 24, 32, 25, 18, 11,  4,  5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13,  6,  7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63
};
```

### 6.5 DCT Encoding Process

```c
void encode_dct_frame(encoder_t* enc, const uint8_t* pixels,
                      int width, int height, int qp) {
    // Convert to YUV
    uint8_t* y_plane = convert_to_y(pixels, width, height);
    uint8_t* u_plane = convert_to_u(pixels, width, height);
    uint8_t* v_plane = convert_to_v(pixels, width, height);

    // Process Y plane in 8x8 blocks
    int blocks_x = (width + 7) / 8;
    int blocks_y = (height + 7) / 8;

    for (int by = 0; by < blocks_y; by++) {
        for (int bx = 0; bx < blocks_x; bx++) {
            int16_t block[64];

            // Extract 8x8 block
            extract_block(y_plane, width, bx * 8, by * 8, block);

            // Subtract 128 (shift to signed)
            for (int i = 0; i < 64; i++) block[i] -= 128;

            // Apply DCT
            dct_8x8(block);

            // Quantize
            quantize_dct(block, qp);

            // Encode
            encode_dct_block(enc, block, QOV_OP_DCT_Y);
        }
    }

    // Process U and V planes (typically at half resolution for 4:2:0)
    // ... similar process with QOV_OP_DCT_UV
}
```

### 6.6 DCT Block Decoding

```c
void decode_dct_block(decoder_t* dec, int16_t block[64], int base_qp) {
    // Clear block
    memset(block, 0, sizeof(int16_t) * 64);

    // Read QP delta
    uint8_t qp_byte = read_u8(dec);
    int qp = base_qp + (qp_byte - 64);  // Bias of 64
    qp = CLAMP(qp, 0, 51);

    // Read DC coefficient
    block[0] = (int16_t)read_u16(dec);

    // Read AC coefficients (run-level)
    int pos = 1;
    while (pos < 64) {
        uint8_t rl = read_u8(dec);
        int run = (rl >> 4) & 0x0F;
        int level_size = rl & 0x0F;

        if (run == 0 && level_size == 0) {
            // End of block
            break;
        }

        if (run == 15 && level_size == 0) {
            // Zero run of 16
            pos += 16;
            continue;
        }

        // Skip zeros
        pos += run;
        if (pos >= 64) break;

        // Read level
        int32_t level = 0;
        for (int i = 0; i < level_size; i++) {
            level = (level << 8) | read_u8(dec);
        }
        // Sign extend if needed
        if (level_size > 0 && (level & (1 << (level_size * 8 - 1)))) {
            level |= ~((1 << (level_size * 8)) - 1);
        }

        block[ZIGZAG[pos]] = level;
        pos++;
    }

    // Dequantize
    dequantize_dct(block, qp);

    // Inverse DCT
    idct_8x8(block);

    // Add 128 back
    for (int i = 0; i < 64; i++) {
        block[i] = CLAMP(block[i] + 128, 0, 255);
    }
}
```

---

## 7. Temporal Lossy Encoding (P-Frames)

### 7.1 Extended Skip Opcodes

For lossy P-frames, introduce similarity-based skipping:

```
Byte Range   Name                Structure
────────────────────────────────────────────────────────────
0x58         QOV_OP_SKIP_SIMILAR | 01011000 | count | threshold |
                                 Skip count pixels within threshold
                                 of reference frame

0x59         QOV_OP_SKIP_SIMILAR_LONG
                                 | 01011001 | count_hi | count_lo | threshold |
                                 Skip 1-65535 similar pixels
```

### 7.2 Temporal Difference with Tolerance

```c
// Encode P-frame with lossy tolerance
void encode_pframe_lossy(encoder_t* enc, const qov_rgba_t* curr,
                         const qov_rgba_t* ref, int threshold) {
    size_t pixel_count = enc->width * enc->height;
    size_t similar_skip = 0;

    for (size_t px = 0; px < pixel_count; px++) {
        qov_rgba_t c = curr[px];
        qov_rgba_t r = ref[px];

        // Check if similar enough to skip
        if (abs(c.r - r.r) <= threshold &&
            abs(c.g - r.g) <= threshold &&
            abs(c.b - r.b) <= threshold &&
            abs(c.a - r.a) <= threshold / 2) {

            similar_skip++;

            // Flush if at limit or end
            if (similar_skip == 255 || px == pixel_count - 1) {
                if (similar_skip <= 62) {
                    write_u8(enc, 0xC0 | (similar_skip - 1));
                } else {
                    write_u8(enc, 0x59);  // SKIP_SIMILAR_LONG
                    write_u16(enc, similar_skip);
                    write_u8(enc, threshold);
                }
                similar_skip = 0;
            }
            continue;
        }

        // Flush pending skips
        if (similar_skip > 0) {
            // ... emit skip opcode
            similar_skip = 0;
        }

        // Encode changed pixel (quantized)
        qov_rgba_t quantized = quantize_for_diff(c, r, enc->quality);
        encode_pixel_diff(enc, quantized, r);
    }
}
```

### 7.3 Motion Compensation with Lossy Residuals

When motion vectors are enabled, residuals can be quantized:

```c
void encode_motion_block_lossy(encoder_t* enc,
                               const uint8_t* curr_block,
                               const uint8_t* ref_block,
                               int block_size,
                               int mv_x, int mv_y,
                               int quant) {
    // Compute residual
    int16_t residual[32*32];
    for (int i = 0; i < block_size * block_size; i++) {
        residual[i] = curr_block[i] - ref_block[i];
    }

    // Quantize residual
    for (int i = 0; i < block_size * block_size; i++) {
        residual[i] = (residual[i] / quant) * quant;
    }

    // Check if residual is negligible
    int energy = 0;
    for (int i = 0; i < block_size * block_size; i++) {
        energy += abs(residual[i]);
    }

    if (energy < block_size * quant) {
        // Skip residual, motion vector only
        encode_motion_vector(enc, mv_x, mv_y);
        write_u8(enc, 0x53);  // DCT_ZERO marker
    } else {
        // Encode motion vector + residual
        encode_motion_vector(enc, mv_x, mv_y);
        encode_residual_dct(enc, residual, block_size, quant);
    }
}
```

---

## 8. Decoder Implementation

### 8.1 Lossy Decoder Structure

```c
typedef struct {
    // Base QOV decoder fields
    qov_header_t header;
    qov_rgba_t   index[64];
    qov_rgba_t   prev_pixel;
    qov_rgba_t*  prev_frame;
    qov_rgba_t*  curr_frame;

    // Lossy extension fields
    bool         lossy_mode;
    int          quality;
    int          y_quant;
    int          uv_quant;
    int          temporal_thresh;
    int          dct_qp;

    // DCT decode buffers
    int16_t      dct_block[64];

} qov_lossy_decoder_t;
```

### 8.2 Header Parsing

```c
bool qov_decode_header_lossy(qov_lossy_decoder_t* dec,
                             const uint8_t* data, size_t size) {
    // Parse base header
    if (!qov_decode_header_base(&dec->header, data, size)) {
        return false;
    }

    // Check for lossy mode
    dec->lossy_mode = (dec->header.flags & 0x20) != 0;

    if (dec->lossy_mode) {
        dec->quality = data[23];

        // Version 0x03 extended header
        if (dec->header.version >= 0x03 && size >= 32) {
            dec->y_quant = data[24] > 0 ? data[24] : derive_y_quant(dec->quality);
            dec->uv_quant = data[25] > 0 ? data[25] : derive_uv_quant(dec->quality);
            dec->temporal_thresh = data[26] > 0 ? data[26] : derive_thresh(dec->quality);
            dec->dct_qp = data[27] > 0 ? data[27] : derive_dct_qp(dec->quality);
        } else {
            // Derive all from quality
            derive_lossy_params(dec->quality, dec);
        }
    }

    return true;
}
```

### 8.3 Frame Decoding with Lossy Opcodes

```c
bool qov_decode_frame_lossy(qov_lossy_decoder_t* dec,
                            const uint8_t* data, size_t size,
                            uint8_t chunk_flags) {
    size_t p = 0;
    size_t pixel_count = dec->header.width * dec->header.height;
    size_t px = 0;

    bool dct_mode = (chunk_flags & 0x20) != 0;

    if (dct_mode) {
        // DCT block decoding
        return decode_dct_frame(dec, data, size, chunk_flags);
    }

    // Standard opcode decoding (same as lossless)
    while (px < pixel_count && p < size - 8) {
        uint8_t b1 = data[p++];

        // Check for lossy extension opcodes first
        if (b1 >= 0x50 && b1 <= 0x5F) {
            switch (b1) {
                case 0x58:  // SKIP_SIMILAR
                    {
                        int count = data[p++];
                        int thresh = data[p++];
                        // Pixels already correct from prev_frame copy
                        px += count;
                    }
                    break;

                case 0x59:  // SKIP_SIMILAR_LONG
                    {
                        int count = read_u16(data + p);
                        p += 2;
                        int thresh = data[p++];
                        px += count;
                    }
                    break;

                default:
                    // Unknown lossy opcode
                    return false;
            }
            continue;
        }

        // Standard QOV opcodes
        // ... (same as lossless decoder)
    }

    return px == pixel_count;
}
```

---

## 9. Encoder Implementation

### 9.1 Complete Lossy Encoder

```c
typedef struct {
    // Base encoder fields
    qov_header_t header;
    qov_rgba_t   index[64];
    qov_rgba_t   prev_pixel;
    qov_rgba_t*  prev_frame;
    uint8_t*     output;
    size_t       output_size;
    size_t       output_capacity;

    // Lossy settings
    int          quality;
    int          y_quant;
    int          uv_quant;
    int          temporal_thresh;
    int          dct_qp;
    bool         use_dct;

    // Statistics
    size_t       total_pixels;
    size_t       skipped_pixels;
    size_t       dct_blocks;

} qov_lossy_encoder_t;

//-----------------------------------------------------------------------------
// Initialize lossy encoder
//-----------------------------------------------------------------------------
void qov_encoder_init_lossy(qov_lossy_encoder_t* enc,
                            uint16_t width, uint16_t height,
                            uint16_t fps_num, uint16_t fps_den,
                            int quality, bool use_dct) {
    memset(enc, 0, sizeof(*enc));

    enc->header.version = 0x03;
    enc->header.width = width;
    enc->header.height = height;
    enc->header.frame_rate_num = fps_num;
    enc->header.frame_rate_den = fps_den;
    enc->header.flags = 0x20;  // LOSSY_MODE

    if (use_dct) {
        enc->header.flags |= 0x40;  // DCT_ENABLED
    }

    enc->quality = quality;
    enc->use_dct = use_dct;

    // Derive quantization parameters
    lossy_params_t params;
    derive_lossy_params(quality, &params);
    enc->y_quant = params.y_quant;
    enc->uv_quant = params.uv_quant;
    enc->temporal_thresh = params.temporal_thresh;
    enc->dct_qp = params.dct_qp;

    // Allocate buffers
    size_t pixels = width * height;
    enc->prev_frame = calloc(pixels, sizeof(qov_rgba_t));
    enc->output_capacity = pixels * 4;  // Initial estimate
    enc->output = malloc(enc->output_capacity);
}

//-----------------------------------------------------------------------------
// Write lossy header
//-----------------------------------------------------------------------------
void qov_write_header_lossy(qov_lossy_encoder_t* enc) {
    // Magic
    write_u8(enc, 'q');
    write_u8(enc, 'o');
    write_u8(enc, 'v');
    write_u8(enc, 'f');

    // Version (0x03 for lossy)
    write_u8(enc, 0x03);

    // Flags
    write_u8(enc, enc->header.flags);

    // Dimensions
    write_u16(enc, enc->header.width);
    write_u16(enc, enc->header.height);

    // Frame rate
    write_u16(enc, enc->header.frame_rate_num);
    write_u16(enc, enc->header.frame_rate_den);

    // Total frames (placeholder)
    write_u32(enc, 0);

    // Audio (none for this example)
    write_u8(enc, 0);
    write_u8(enc, 0);
    write_u8(enc, 0);
    write_u8(enc, 0);

    // Colorspace
    write_u8(enc, 0x00);  // SRGB

    // Quality
    write_u8(enc, enc->quality);

    // Extended lossy parameters
    write_u8(enc, enc->y_quant);
    write_u8(enc, enc->uv_quant);
    write_u8(enc, enc->temporal_thresh);
    write_u8(enc, enc->dct_qp);

    // Reserved
    write_u32(enc, 0);
}

//-----------------------------------------------------------------------------
// Encode keyframe (lossy)
//-----------------------------------------------------------------------------
void qov_encode_keyframe_lossy(qov_lossy_encoder_t* enc,
                               const qov_rgba_t* pixels,
                               uint32_t timestamp) {
    size_t pixel_count = enc->header.width * enc->header.height;

    // Create quantized copy
    qov_rgba_t* quantized = malloc(pixel_count * sizeof(qov_rgba_t));

    for (size_t i = 0; i < pixel_count; i++) {
        quantized[i] = pixels[i];
        quantize_pixel(&quantized[i], enc->y_quant, enc->uv_quant);
    }

    if (enc->use_dct) {
        // DCT encoding
        encode_keyframe_dct(enc, quantized, timestamp);
    } else {
        // Standard opcode encoding with quantized pixels
        encode_keyframe_standard(enc, quantized, timestamp);
    }

    // Store for P-frame reference
    memcpy(enc->prev_frame, quantized, pixel_count * sizeof(qov_rgba_t));

    free(quantized);
}

//-----------------------------------------------------------------------------
// Encode P-frame (lossy)
//-----------------------------------------------------------------------------
void qov_encode_pframe_lossy(qov_lossy_encoder_t* enc,
                             const qov_rgba_t* pixels,
                             uint32_t timestamp) {
    size_t pixel_count = enc->header.width * enc->header.height;

    // Chunk header
    size_t header_pos = enc->output_size;
    write_u8(enc, 0x02);  // PFRAME
    write_u8(enc, enc->use_dct ? 0x20 : 0x00);
    write_u32(enc, 0);    // size placeholder (32-bit for v0x03)
    write_u32(enc, timestamp);

    size_t data_start = enc->output_size;

    // Quantize current frame
    qov_rgba_t* quantized = malloc(pixel_count * sizeof(qov_rgba_t));
    for (size_t i = 0; i < pixel_count; i++) {
        quantized[i] = pixels[i];
        quantize_pixel(&quantized[i], enc->y_quant, enc->uv_quant);
    }

    if (enc->use_dct) {
        // DCT-based P-frame
        encode_pframe_dct(enc, quantized, enc->prev_frame, timestamp);
    } else {
        // Opcode-based with temporal threshold
        size_t skip = 0;

        for (size_t px = 0; px < pixel_count; px++) {
            qov_rgba_t c = quantized[px];
            qov_rgba_t r = enc->prev_frame[px];

            // Check similarity with threshold
            if (abs(c.r - r.r) <= enc->temporal_thresh &&
                abs(c.g - r.g) <= enc->temporal_thresh &&
                abs(c.b - r.b) <= enc->temporal_thresh &&
                abs(c.a - r.a) <= enc->temporal_thresh / 2) {

                skip++;
                enc->skipped_pixels++;

                // Use reference pixel (lossy)
                quantized[px] = r;

                if (skip == 62 || px == pixel_count - 1) {
                    write_u8(enc, 0xC0 | (skip - 1));
                    skip = 0;
                }
                continue;
            }

            // Flush skips
            if (skip > 0) {
                write_u8(enc, 0xC0 | (skip - 1));
                skip = 0;
            }

            // Encode difference
            encode_pixel_diff(enc, c, r);
        }
    }

    // End marker
    for (int i = 0; i < 7; i++) write_u8(enc, 0x00);
    write_u8(enc, 0x01);

    // Update chunk size
    uint32_t chunk_size = enc->output_size - data_start;
    enc->output[header_pos + 2] = (chunk_size >> 24) & 0xFF;
    enc->output[header_pos + 3] = (chunk_size >> 16) & 0xFF;
    enc->output[header_pos + 4] = (chunk_size >> 8) & 0xFF;
    enc->output[header_pos + 5] = chunk_size & 0xFF;

    // Store for next P-frame reference
    memcpy(enc->prev_frame, quantized, pixel_count * sizeof(qov_rgba_t));

    free(quantized);
}
```

---

## 10. Quality Metrics

### 10.1 PSNR Calculation

```c
// Calculate Peak Signal-to-Noise Ratio
double calculate_psnr(const qov_rgba_t* original,
                      const qov_rgba_t* decoded,
                      size_t pixel_count) {
    double mse = 0.0;

    for (size_t i = 0; i < pixel_count; i++) {
        int dr = original[i].r - decoded[i].r;
        int dg = original[i].g - decoded[i].g;
        int db = original[i].b - decoded[i].b;

        mse += dr * dr + dg * dg + db * db;
    }

    mse /= (pixel_count * 3);

    if (mse == 0) return INFINITY;  // Perfect match

    return 10.0 * log10(255.0 * 255.0 / mse);
}
```

### 10.2 Expected Quality vs Compression

| Quality | PSNR (dB) | Compression Ratio | Visual Quality |
|---------|-----------|-------------------|----------------|
| 100     | ~50+      | 1.5-2x            | Visually lossless |
| 90      | 42-48     | 3-5x              | Excellent |
| 80      | 38-42     | 5-10x             | Very good |
| 70      | 34-38     | 10-15x            | Good |
| 60      | 30-34     | 15-25x            | Acceptable |
| 50      | 28-32     | 20-35x            | Noticeable artifacts |
| 40      | 26-30     | 30-45x            | Visible degradation |
| 30      | 24-28     | 40-50x            | Low quality |

---

## 11. Backward Compatibility

### 11.1 Decoder Compatibility Matrix

| Decoder Version | v0x01 Lossless | v0x02 Lossless | v0x03 Lossy |
|-----------------|----------------|----------------|-------------|
| v1.0 (original) | Yes            | No             | No          |
| v1.1 (extended) | Yes            | Yes            | No          |
| v2.0 (lossy)    | Yes            | Yes            | Yes         |

### 11.2 Graceful Degradation

Old decoders can partially handle lossy files:
- Version check fails cleanly (reports unsupported version)
- Unknown opcodes (0x50-0x5F) can be skipped if size known
- Quantized pixel mode files decode correctly (just different colors)

### 11.3 Feature Detection

```c
bool qov_supports_lossy(const uint8_t* data, size_t size) {
    if (size < 24) return false;

    // Check magic
    if (memcmp(data, "qovf", 4) != 0) return false;

    // Check version
    uint8_t version = data[4];
    if (version < 0x03) return false;

    // Check lossy flag
    uint8_t flags = data[5];
    return (flags & 0x20) != 0;
}
```

---

## 12. Implementation Recommendations

### 12.1 Encoder Strategy

1. **Start simple**: Implement quantized pixel mode first
2. **Add YUV**: Convert to YUV for better perceptual quantization
3. **Add temporal**: Implement similarity-based P-frame skipping
4. **Add DCT**: For maximum compression, add block transform
5. **Tune**: Adjust quality curves based on content type

### 12.2 Decoder Priority

1. **Version check**: Fail gracefully on unsupported versions
2. **Opcode handling**: Skip unknown opcodes when possible
3. **Performance**: DCT decode is the bottleneck - optimize IDCT
4. **Memory**: Same 2-buffer requirement as lossless

### 12.3 Content-Adaptive Encoding

```c
typedef enum {
    CONTENT_SCREEN,      // Screen capture, text, UI
    CONTENT_ANIMATION,   // Cartoons, anime, graphics
    CONTENT_NATURAL,     // Live action, photographs
    CONTENT_MIXED        // Combination
} content_type_t;

void adjust_for_content(qov_lossy_encoder_t* enc, content_type_t type) {
    switch (type) {
        case CONTENT_SCREEN:
            // Screens need sharp edges
            enc->y_quant = max(1, enc->y_quant / 2);
            enc->temporal_thresh = max(1, enc->temporal_thresh / 2);
            enc->use_dct = false;  // DCT blurs text
            break;

        case CONTENT_ANIMATION:
            // Animation has flat areas, benefits from RLE
            enc->temporal_thresh *= 2;
            break;

        case CONTENT_NATURAL:
            // Natural content hides artifacts well
            enc->uv_quant *= 2;
            enc->use_dct = true;
            break;

        case CONTENT_MIXED:
            // Use adaptive per-block decisions
            break;
    }
}
```

---

## 13. File Extension

- Lossless QOV: `.qov`
- Lossy QOV: `.qov` (same extension, distinguished by header)
- Alternative: `.qovl` for explicitly lossy files

---

## 14. Example Usage

```c
int main() {
    qov_lossy_encoder_t enc;

    // Initialize with quality 75 (good balance)
    qov_encoder_init_lossy(&enc, 1920, 1080, 30, 1,
                           75,      // quality
                           false);  // no DCT (simpler)

    qov_write_header_lossy(&enc);

    int keyframe_interval = 30;

    for (int frame = 0; frame < total_frames; frame++) {
        uint32_t timestamp = frame * 1000000 / 30;
        qov_rgba_t* pixels = get_frame(frame);

        if (frame % keyframe_interval == 0) {
            qov_encode_keyframe_lossy(&enc, pixels, timestamp);
        } else {
            qov_encode_pframe_lossy(&enc, pixels, timestamp);
        }
    }

    qov_encoder_finish(&enc, total_frames);

    // Report statistics
    printf("Compression: %.1fx\n",
           (float)(total_frames * 1920 * 1080 * 4) / enc.output_size);
    printf("Skipped pixels: %.1f%%\n",
           100.0 * enc.skipped_pixels / enc.total_pixels);

    // Write file
    FILE* f = fopen("output.qov", "wb");
    fwrite(enc.output, 1, enc.output_size, f);
    fclose(f);

    return 0;
}
```

---

## 15. License

This specification extension is placed in the public domain, same as the base QOV specification.
