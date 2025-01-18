# QOV (Quite OK Video) Format Specification

**Version:** 1.0
**Date:** January 2026
**Based on:** QOI (Quite OK Image) and QOA (Quite OK Audio)

---

## Overview

QOV is a simple, fast video format designed for:
- **Fast decoding** (priority) with optional enhanced compression
- **Simplicity** - Reference implementation in ~500-800 lines of C
- **Streaming support** - Unknown length streams with sync markers
- **Flexible features** - Optional alpha, motion vectors, YUV color spaces

---

## 1. File Header (24 bytes)

```
Offset  Size  Name            Description
──────────────────────────────────────────────────────────────
0       4     magic           Magic bytes "qovf" (0x716f7666)
4       1     version         Format version (0x01 = 16-bit chunks, 0x02 = 32-bit chunks)
5       1     flags           Feature flags (bitfield)
6       2     width           Video width (1-65535), big-endian
8       2     height          Video height (1-65535), big-endian
10      2     frame_rate_num  Frame rate numerator, big-endian
12      2     frame_rate_den  Frame rate denominator, big-endian
14      4     total_frames    Total frame count (0 = unknown/streaming)
18      1     audio_channels  Audio channels (0 = no audio, 1-8)
19      3     audio_rate      Audio sample rate (0-16777215 Hz), big-endian
22      1     colorspace      Color space identifier
23      1     reserved        Reserved (must be 0x00)
```

### 1.1 Flags Byte (Bitfield)

```
Bit  Name           Description
────────────────────────────────────────────────────────────
0    HAS_ALPHA      Frames include alpha channel
1    HAS_MOTION     Motion vectors enabled for P/B-frames
2    HAS_INDEX      Index table present at end of file
3    HAS_BFRAMES    B-frames present (requires decode reordering)
4    ENHANCED_COMP  Enhanced compression mode (slower decode)
5-7  Reserved       Must be 0
```

### 1.2 Colorspace Byte

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

All chunks share a common header. The header size depends on the format version:

**Version 0x01 (8-byte header, max chunk 65KB):**
```
Offset  Size  Name         Description
──────────────────────────────────────────────────────────────
0       1     chunk_type   Chunk type identifier
1       1     chunk_flags  Chunk-specific flags
2       2     chunk_size   Size of data after header, big-endian (16-bit)
4       4     timestamp    Timestamp in microseconds, big-endian
```

**Version 0x02 (10-byte header, supports large frames):**
```
Offset  Size  Name         Description
──────────────────────────────────────────────────────────────
0       1     chunk_type   Chunk type identifier
1       1     chunk_flags  Chunk-specific flags
2       4     chunk_size   Size of data after header, big-endian (32-bit)
6       4     timestamp    Timestamp in microseconds, big-endian
```

**Note:** Version 0x02 is recommended for video resolutions above 640x480 to avoid chunk size overflow.

### 2.1 Chunk Type IDs

```
Value  Name      Description
────────────────────────────────────────────────────────────
0x00   SYNC      Sync marker (streaming recovery point)
0x01   KEYFRAME  I-frame (complete image, no dependencies)
0x02   PFRAME    P-frame (references previous frame)
0x03   BFRAME    B-frame (references previous and next frames)
0x10   AUDIO     Audio data (QOA-based)
0xF0   INDEX     Seek index table
0xFF   END       End of stream marker
```

### 2.2 Chunk Flags Byte

The chunk_flags byte is a bitfield with the following bits:

```
Bit  Name        Description
────────────────────────────────────────────────────────────
0    YUV_MODE    Frame uses YUV plane-based encoding (0x01)
1    HAS_MOTION  Frame includes motion vectors (0x02)
2-3  Reserved    Must be 0
4    COMPRESSED  Chunk data is LZ4 compressed (0x10)
5    Reserved    Must be 0 (reserved for future compression types)
6-7  Reserved    Must be 0
```

### 2.3 LZ4 Compression

When the COMPRESSED flag (bit 4) is set, the chunk uses LZ4 block compression
for smaller file sizes while maintaining fast decompression.

**Compressed Chunk Layout:**
```
Offset  Size  Name              Description
──────────────────────────────────────────────────────────────
0       1     chunk_type        Chunk type identifier
1       1     chunk_flags       Flags with COMPRESSED bit set (0x10)
2       4     chunk_size        Size of compressed data + 4 (32-bit)
6       4     timestamp         Timestamp in microseconds
10      4     uncompressed_size Original size before compression
14      N     compressed_data   LZ4 compressed opcode stream
```

**Compression Notes:**
- Uses LZ4 block format (not LZ4 frame format)
- Decompression requires knowing the uncompressed size in advance
- Encoder may choose not to compress if compression ratio < 5%
- Decompressor must check COMPRESSED flag before reading data
- End marker (8 bytes) is included in the compressed data

**Decompression Algorithm:**
1. Read chunk header including chunk_flags
2. If (chunk_flags & 0x10): read 4-byte uncompressed_size
3. Read (chunk_size - 4) bytes of compressed data
4. Decompress using LZ4 block decompression
5. Decode opcodes from decompressed data as normal

**Expected Compression Ratios:**
- RGB keyframes: 1.5-2x reduction
- RGB P-frames: 2-3x reduction
- YUV frames: 1.5-2.5x reduction

---

## 3. Video Opcodes

### 3.1 RGB Mode Opcodes (QOI-Compatible)

Used when colorspace is SRGB, SRGBA, LINEAR, or LINEAR_A.

```
Byte Range   Name           Structure
──────────────────────────────────────────────────────────────
0x00-0x3F    QOV_OP_INDEX   | 00 | index (6 bits) |
                            Index into 64-entry color cache
                            Hash: (r*3 + g*5 + b*7 + a*11) % 64

0x40-0x7F    QOV_OP_DIFF    | 01 | dr (2) | dg (2) | db (2) |
                            Small RGB difference from previous pixel
                            Bias: 2 (range -2 to +1 per channel)

0x80-0xBF    QOV_OP_LUMA    | 10 | dg (6 bits) |
                            | dr-dg (4) | db-dg (4) |
                            Luma-based difference
                            dg bias: 32, dr-dg/db-dg bias: 8

0xC0-0xFD    QOV_OP_RUN     | 11 | run (6 bits) |
                            Repeat previous pixel 1-62 times
                            Bias: -1 (stored 0-61 = run 1-62)

0xFE         QOV_OP_RGB     | 11111110 | r | g | b |
                            Literal RGB values (3 bytes)

0xFF         QOV_OP_RGBA    | 11111111 | r | g | b | a |
                            Literal RGBA values (4 bytes)
```

### 3.2 YUV Mode Opcodes (Plane-Based Encoding)

Used when colorspace is YUV420, YUV422, YUV444, or YUVA420.

**Important:** YUV frames are encoded as separate planes (Y, U, V, and optionally A),
not as combined YUV tuples. Each plane uses the simplified single-channel opcodes below.
The chunk_flags byte has bit 0 set (0x01) to indicate YUV mode.

```
Byte Range   Name            Structure
──────────────────────────────────────────────────────────────
0x00-0x3F    QOV_YUV_INDEX   | 00 | index (6 bits) |
                             Index into 64-entry value cache
                             Hash: (value * 3) % 64

0x40-0x4F    QOV_YUV_DIFF    | 0100 | d (4 bits) |
                             Small difference from previous value
                             d bias: 8 (range -8 to +7)

0x80-0xBF    QOV_YUV_LUMA    | 10 | d (6 bits) |
                             Larger difference from previous value
                             d bias: 32 (range -32 to +31)

0xC0-0xFD    QOV_YUV_RUN     | 11 | run (6 bits) |
                             Repeat previous value 1-62 times

0xFE         QOV_YUV_FULL    | 11111110 | value |
                             Literal 8-bit value (1 byte)
```

**Color Conversion (BT.601):**
```
RGB to YUV:
  Y  = 0.299*R + 0.587*G + 0.114*B
  Cb = -0.147*R - 0.289*G + 0.436*B + 128
  Cr = 0.615*R - 0.515*G - 0.100*B + 128

YUV to RGB:
  R = Y + 1.140*(Cr-128)
  G = Y - 0.395*(Cb-128) - 0.581*(Cr-128)
  B = Y + 2.032*(Cb-128)
```

### 3.3 Temporal Opcodes (P-frames and B-frames)

Additional opcodes for inter-frame prediction in RGB mode:

```
Byte Range   Name              Structure
──────────────────────────────────────────────────────────────
0xC0-0xFD    QOV_OP_SKIP       | 11 | count (6 bits) |
                               Skip 1-62 pixels (unchanged from ref)

0x00         QOV_OP_SKIP_LONG  | 00000000 | count_hi | count_lo |
                               Skip 1-65535 pixels (2-byte count)

0x40-0x7F    QOV_OP_TDIFF      | 01 | dr (2) | dg (2) | db (2) |
                               Temporal diff from reference frame
                               Same bias as QOV_OP_DIFF

0x80-0xBF    QOV_OP_TLUMA      | 10 | dg (6 bits) |
                               | dr-dg (4) | db-dg (4) |
                               Temporal luma diff from reference
```

### 3.4 YUV Temporal Opcodes (P-frames)

For YUV mode P-frames, each plane uses these opcodes:

```
Byte Range   Name              Structure
──────────────────────────────────────────────────────────────
0xC0-0xFD    QOV_YUV_SKIP      | 11 | count (6 bits) |
                               Skip 1-62 values (unchanged from ref)

0x00         QOV_YUV_SKIP_LONG | 00000000 | count_hi | count_lo |
                               Skip 1-65535 values (2-byte count)

0x00-0x3F    QOV_YUV_INDEX     | 00 | index (6 bits) |
                               Index into value cache (only if not 0x00)

0x40-0x4F    QOV_YUV_TDIFF     | 0100 | d (4 bits) |
                               Temporal diff from reference value
                               d bias: 8 (range -8 to +7)

0x80-0xBF    QOV_YUV_TLUMA     | 10 | d (6 bits) |
                               Larger temporal diff from reference
                               d bias: 32 (range -32 to +31)

0xFE         QOV_YUV_FULL      | 11111110 | value |
                               Literal 8-bit value
```

**Important:** For P-frames, the encoder MUST update the index cache after
encoding TDIFF and TLUMA opcodes to keep encoder/decoder caches in sync.

---

## 4. Keyframe (I-frame) Format

```
Chunk Header:
  chunk_type  = 0x01
  chunk_flags:
    Bit 0: YUV mode (0 = RGB opcodes, 1 = YUV opcodes)

Data:
  [Pixel data using RGB or YUV opcodes]
  [8-byte end marker: 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01]
```

### 4.1 YUV Plane Encoding

For YUV colorspaces, planes are encoded separately in sequence:

**YUV 4:2:0 (colorspace 0x10):**
```
1. Y plane  - Full resolution (width × height values)
2. U plane  - Quarter resolution (ceil(width/2) × ceil(height/2) values)
3. V plane  - Quarter resolution (ceil(width/2) × ceil(height/2) values)
```

**YUVA 4:2:0 (colorspace 0x13):**
```
1. Y plane  - Full resolution
2. U plane  - Quarter resolution
3. V plane  - Quarter resolution
4. A plane  - Full resolution (width × height values)
```

**YUV 4:2:2 (colorspace 0x11):**
```
1. Y plane  - Full resolution (width × height values)
2. U plane  - Half horizontal (ceil(width/2) × height values)
3. V plane  - Half horizontal (ceil(width/2) × height values)
```

**YUV 4:4:4 (colorspace 0x12):**
```
1. Y plane  - Full resolution (width × height values)
2. U plane  - Full resolution (width × height values)
3. V plane  - Full resolution (width × height values)
```

**Encoding Rules:**
- Each plane is encoded independently using YUV opcodes (Section 3.2)
- Each plane maintains its own 64-entry index cache
- The previous value for DIFF/LUMA starts at 0 for Y, 128 for U/V
- Planes are written sequentially without delimiters
- The decoder must decode exactly the expected number of values per plane

---

## 5. P-frame Format

```
Chunk Header:
  chunk_type  = 0x02
  chunk_flags:
    Bit 0: YUV mode (0 = RGB temporal opcodes, 1 = YUV plane encoding)
    Bit 1: Has motion vectors (requires HAS_MOTION in file flags)

RGB Mode Data (no motion vectors):
  [Pixel data using temporal + standard opcodes (Section 3.3)]
  [8-byte end marker]

YUV Mode Data (chunk_flags bit 0 = 1):
  [Y plane using YUV temporal opcodes (Section 3.4)]
  [U plane using YUV temporal opcodes]
  [V plane using YUV temporal opcodes]
  [A plane if YUVA colorspace]
  [8-byte end marker]

Data (with motion vectors):
  [Motion vector block]
  [Residual pixel data]
  [8-byte end marker]
```

**YUV P-frame Decoding:**
1. Copy previous frame's planes as base
2. Decode each plane's temporal differences
3. Convert YUV planes back to RGBA for display

### 5.1 Motion Vector Block

Only present when chunk_flags bit 1 is set:

```
Offset  Size  Name        Description
──────────────────────────────────────────────────────────────
0       1     block_size  Block dimensions: 0=8×8, 1=16×16, 2=32×32
1       2     mv_count    Number of motion vectors, big-endian

For each motion vector (2 bytes):
  0     1     mv_x        Signed X displacement (-128 to +127)
  1     1     mv_y        Signed Y displacement (-128 to +127)
```

Motion vectors are stored in raster order (left-to-right, top-to-bottom).
A zero vector (0, 0) means the block is unchanged from reference.

---

## 6. B-frame Format

```
Chunk Header:
  chunk_type  = 0x03
  chunk_flags:
    Bit 0: YUV mode
    Bit 1: Has motion vectors

Data:
  [Forward motion vectors]   - Reference to previous keyframe/P-frame
  [Backward motion vectors]  - Reference to next keyframe
  [Residual pixel data]
  [8-byte end marker]
```

B-frames require the decoder to buffer the next keyframe before display.

---

## 7. Audio Chunk (QOA-Based)

```
Chunk Header:
  chunk_type  = 0x10
  chunk_flags:
    Bits 0-3: Number of QOA frames (1-15)

Audio Frame Structure:
  samples        [2 bytes]  Samples per channel in this frame, big-endian

  Per channel:
    lms_history  [8 bytes]  4 × 16-bit signed history values
    lms_weights  [8 bytes]  4 × 16-bit signed LMS weights

  Slices (8 bytes each, interleaved by channel):
    scale_factor [4 bits]   Quantization scale (0-15)
    residuals    [60 bits]  20 × 3-bit quantized residuals
```

### 7.1 QOA Constants

```c
// Scale factor table (16 entries)
const int QOA_SCALE[16] = {
    1, 7, 21, 45, 84, 138, 211, 304,
    421, 562, 731, 928, 1157, 1419, 1715, 2048
};

// Dequantization table [scale][residual]
const int QOA_DEQUANT[16][8] = {
    {   1,    -1,    3,    -3,    5,    -5,     7,     -7},
    {   5,    -5,   18,   -18,   32,   -32,    49,    -49},
    // ... (see QOA specification for full table)
};
```

---

## 8. Sync Marker (Streaming)

```
Chunk Header:
  chunk_type  = 0x00
  chunk_flags = 0x00
  chunk_size  = 8
  timestamp   = current timestamp

Data (8 bytes):
  sync_magic   [4 bytes]  "QOVS" (0x514f5653)
  frame_number [4 bytes]  Current frame number, big-endian
```

Sync markers should be inserted:
- Before every keyframe
- Optionally every N seconds for long GOPs

---

## 9. Index Table (Seeking)

```
Chunk Header:
  chunk_type  = 0xF0
  chunk_flags = 0x00

Data:
  entry_count  [4 bytes]  Number of entries, big-endian

  Per entry (16 bytes):
    frame_num    [4 bytes]  Keyframe number, big-endian
    file_offset  [8 bytes]  Byte offset from file start, big-endian
    timestamp    [4 bytes]  Timestamp in microseconds, big-endian
```

The index table is located at the end of the file, before the END chunk.
Only keyframes are indexed.

---

## 10. End Marker

```
Chunk Header:
  chunk_type  = 0xFF
  chunk_flags = 0x00
  chunk_size  = 0
  timestamp   = 0

Followed by:
  end_pattern  [8 bytes]  0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01
```

---

## 11. File Layout

```
┌─────────────────────────────────────┐
│ File Header (24 bytes)              │
├─────────────────────────────────────┤
│ SYNC Marker                         │
│ KEYFRAME 0                          │
│ AUDIO                               │
│ PFRAME 1                            │
│ AUDIO                               │
│ PFRAME 2                            │
│ AUDIO                               │
│ ...                                 │
├─────────────────────────────────────┤
│ SYNC Marker                         │
│ KEYFRAME 30                         │
│ AUDIO                               │
│ ...                                 │
├─────────────────────────────────────┤
│ INDEX Table (optional)              │
│ END Marker                          │
└─────────────────────────────────────┘
```

**Recommended keyframe interval:** Every 30-60 frames (1-2 seconds at 30fps)

---

## 12. Decoder Pseudocode

```c
//=============================================================================
// QOV DECODER - Reference Implementation Pseudocode
//=============================================================================

typedef struct {
    uint8_t r, g, b, a;
} qov_rgba_t;

typedef struct {
    uint32_t width, height;
    uint32_t frame_rate_num, frame_rate_den;
    uint32_t total_frames;
    uint8_t  flags;
    uint8_t  colorspace;
    uint8_t  audio_channels;
    uint32_t audio_rate;
} qov_header_t;

typedef struct {
    qov_header_t header;
    qov_rgba_t   index[64];          // Color cache
    qov_rgba_t   prev_pixel;         // Previous pixel
    qov_rgba_t*  prev_frame;         // Previous frame buffer
    qov_rgba_t*  curr_frame;         // Current frame buffer
    int16_t      lms_history[8][4];  // Audio LMS history per channel
    int16_t      lms_weights[8][4];  // Audio LMS weights per channel
} qov_decoder_t;

//-----------------------------------------------------------------------------
// Read big-endian integers
//-----------------------------------------------------------------------------
uint16_t read_u16(const uint8_t* p) {
    return (p[0] << 8) | p[1];
}

uint32_t read_u32(const uint8_t* p) {
    return (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3];
}

//-----------------------------------------------------------------------------
// Decode file header
//-----------------------------------------------------------------------------
bool qov_decode_header(qov_decoder_t* dec, const uint8_t* data, size_t size) {
    if (size < 24) return false;

    // Check magic
    if (data[0] != 'q' || data[1] != 'o' || data[2] != 'v' || data[3] != 'f')
        return false;

    // Check version
    if (data[4] != 0x01) return false;

    dec->header.flags          = data[5];
    dec->header.width          = read_u16(data + 6);
    dec->header.height         = read_u16(data + 8);
    dec->header.frame_rate_num = read_u16(data + 10);
    dec->header.frame_rate_den = read_u16(data + 12);
    dec->header.total_frames   = read_u32(data + 14);
    dec->header.audio_channels = data[18];
    dec->header.audio_rate     = (data[19] << 16) | (data[20] << 8) | data[21];
    dec->header.colorspace     = data[22];

    // Allocate frame buffers
    size_t pixels = dec->header.width * dec->header.height;
    dec->prev_frame = calloc(pixels, sizeof(qov_rgba_t));
    dec->curr_frame = calloc(pixels, sizeof(qov_rgba_t));

    // Initialize decoder state
    memset(dec->index, 0, sizeof(dec->index));
    dec->prev_pixel = (qov_rgba_t){0, 0, 0, 255};

    return true;
}

//-----------------------------------------------------------------------------
// Color index hash function (QOI-compatible)
//-----------------------------------------------------------------------------
int qov_color_hash(qov_rgba_t c) {
    return (c.r * 3 + c.g * 5 + c.b * 7 + c.a * 11) % 64;
}

//-----------------------------------------------------------------------------
// Decode keyframe (I-frame)
//-----------------------------------------------------------------------------
bool qov_decode_keyframe(qov_decoder_t* dec, const uint8_t* data, size_t size) {
    size_t p = 0;
    size_t pixel_count = dec->header.width * dec->header.height;
    size_t px = 0;

    // Reset state for new frame
    memset(dec->index, 0, sizeof(dec->index));
    dec->prev_pixel = (qov_rgba_t){0, 0, 0, 255};

    while (px < pixel_count && p < size - 8) {
        uint8_t b1 = data[p++];

        if (b1 == 0xFE) {
            // QOV_OP_RGB
            dec->prev_pixel.r = data[p++];
            dec->prev_pixel.g = data[p++];
            dec->prev_pixel.b = data[p++];
        }
        else if (b1 == 0xFF) {
            // QOV_OP_RGBA
            dec->prev_pixel.r = data[p++];
            dec->prev_pixel.g = data[p++];
            dec->prev_pixel.b = data[p++];
            dec->prev_pixel.a = data[p++];
        }
        else if ((b1 & 0xC0) == 0x00) {
            // QOV_OP_INDEX
            int idx = b1 & 0x3F;
            dec->prev_pixel = dec->index[idx];
        }
        else if ((b1 & 0xC0) == 0x40) {
            // QOV_OP_DIFF
            dec->prev_pixel.r += ((b1 >> 4) & 0x03) - 2;
            dec->prev_pixel.g += ((b1 >> 2) & 0x03) - 2;
            dec->prev_pixel.b += (b1 & 0x03) - 2;
        }
        else if ((b1 & 0xC0) == 0x80) {
            // QOV_OP_LUMA
            uint8_t b2 = data[p++];
            int dg = (b1 & 0x3F) - 32;
            int dr_dg = ((b2 >> 4) & 0x0F) - 8;
            int db_dg = (b2 & 0x0F) - 8;
            dec->prev_pixel.r += dg + dr_dg;
            dec->prev_pixel.g += dg;
            dec->prev_pixel.b += dg + db_dg;
        }
        else if ((b1 & 0xC0) == 0xC0) {
            // QOV_OP_RUN
            int run = (b1 & 0x3F) + 1;
            for (int i = 0; i < run && px < pixel_count; i++) {
                dec->curr_frame[px++] = dec->prev_pixel;
            }
            continue;  // Skip the store below, run already stored pixels
        }

        // Update color cache and store pixel
        dec->index[qov_color_hash(dec->prev_pixel)] = dec->prev_pixel;
        dec->curr_frame[px++] = dec->prev_pixel;
    }

    // Swap frame buffers
    qov_rgba_t* tmp = dec->prev_frame;
    dec->prev_frame = dec->curr_frame;
    dec->curr_frame = tmp;

    return px == pixel_count;
}

//-----------------------------------------------------------------------------
// Decode P-frame (with temporal prediction)
//-----------------------------------------------------------------------------
bool qov_decode_pframe(qov_decoder_t* dec, const uint8_t* data, size_t size,
                       bool has_motion) {
    size_t p = 0;
    size_t pixel_count = dec->header.width * dec->header.height;
    size_t px = 0;

    // Handle motion vectors if present
    if (has_motion && (dec->header.flags & 0x02)) {
        uint8_t block_size_id = data[p++];
        int block_dim = 8 << block_size_id;  // 8, 16, or 32
        uint16_t mv_count = read_u16(data + p);
        p += 2;

        int blocks_x = (dec->header.width + block_dim - 1) / block_dim;
        int blocks_y = (dec->header.height + block_dim - 1) / block_dim;

        // Apply motion compensation
        for (int by = 0; by < blocks_y; by++) {
            for (int bx = 0; bx < blocks_x; bx++) {
                int8_t mv_x = (int8_t)data[p++];
                int8_t mv_y = (int8_t)data[p++];

                // Copy block from reference with motion offset
                for (int y = 0; y < block_dim; y++) {
                    for (int x = 0; x < block_dim; x++) {
                        int dst_x = bx * block_dim + x;
                        int dst_y = by * block_dim + y;
                        int src_x = dst_x + mv_x;
                        int src_y = dst_y + mv_y;

                        if (dst_x < dec->header.width &&
                            dst_y < dec->header.height) {
                            // Clamp source coordinates
                            src_x = CLAMP(src_x, 0, dec->header.width - 1);
                            src_y = CLAMP(src_y, 0, dec->header.height - 1);

                            size_t dst_idx = dst_y * dec->header.width + dst_x;
                            size_t src_idx = src_y * dec->header.width + src_x;
                            dec->curr_frame[dst_idx] = dec->prev_frame[src_idx];
                        }
                    }
                }
            }
        }
    } else {
        // No motion vectors - copy previous frame as base
        memcpy(dec->curr_frame, dec->prev_frame,
               pixel_count * sizeof(qov_rgba_t));
    }

    // Decode residuals/differences
    while (px < pixel_count && p < size - 8) {
        uint8_t b1 = data[p++];

        if (b1 == 0x00) {
            // QOV_OP_SKIP_LONG
            uint16_t skip = read_u16(data + p);
            p += 2;
            px += skip;
        }
        else if ((b1 & 0xC0) == 0xC0 && b1 < 0xFE) {
            // QOV_OP_SKIP
            int skip = (b1 & 0x3F) + 1;
            px += skip;
        }
        else if ((b1 & 0xC0) == 0x40) {
            // QOV_OP_TDIFF - temporal difference
            qov_rgba_t ref = dec->curr_frame[px];  // Motion-compensated or copied
            ref.r += ((b1 >> 4) & 0x03) - 2;
            ref.g += ((b1 >> 2) & 0x03) - 2;
            ref.b += (b1 & 0x03) - 2;
            dec->curr_frame[px++] = ref;
            dec->index[qov_color_hash(ref)] = ref;
        }
        else if ((b1 & 0xC0) == 0x80) {
            // QOV_OP_TLUMA - temporal luma difference
            uint8_t b2 = data[p++];
            qov_rgba_t ref = dec->curr_frame[px];
            int dg = (b1 & 0x3F) - 32;
            int dr_dg = ((b2 >> 4) & 0x0F) - 8;
            int db_dg = (b2 & 0x0F) - 8;
            ref.r += dg + dr_dg;
            ref.g += dg;
            ref.b += dg + db_dg;
            dec->curr_frame[px++] = ref;
            dec->index[qov_color_hash(ref)] = ref;
        }
        else if ((b1 & 0xC0) == 0x00) {
            // QOV_OP_INDEX
            int idx = b1 & 0x3F;
            dec->curr_frame[px++] = dec->index[idx];
        }
        else if (b1 == 0xFE) {
            // QOV_OP_RGB
            qov_rgba_t c;
            c.r = data[p++];
            c.g = data[p++];
            c.b = data[p++];
            c.a = dec->curr_frame[px].a;
            dec->curr_frame[px++] = c;
            dec->index[qov_color_hash(c)] = c;
        }
        else if (b1 == 0xFF) {
            // QOV_OP_RGBA
            qov_rgba_t c;
            c.r = data[p++];
            c.g = data[p++];
            c.b = data[p++];
            c.a = data[p++];
            dec->curr_frame[px++] = c;
            dec->index[qov_color_hash(c)] = c;
        }
    }

    // Swap frame buffers
    qov_rgba_t* tmp = dec->prev_frame;
    dec->prev_frame = dec->curr_frame;
    dec->curr_frame = tmp;

    return true;
}

//-----------------------------------------------------------------------------
// Decode audio chunk (QOA-based)
//-----------------------------------------------------------------------------
bool qov_decode_audio(qov_decoder_t* dec, const uint8_t* data, size_t size,
                      int16_t* output, size_t* samples_out) {
    size_t p = 0;
    size_t out_idx = 0;
    int channels = dec->header.audio_channels;

    // QOA scale factor table
    static const int SCALE[16] = {
        1, 7, 21, 45, 84, 138, 211, 304,
        421, 562, 731, 928, 1157, 1419, 1715, 2048
    };

    // QOA dequantization table
    static const int DEQUANT[16][8] = {
        {   1,   -1,    3,   -3,    5,   -5,    7,   -7},
        {   5,   -5,   18,  -18,   32,  -32,   49,  -49},
        {  16,  -16,   53,  -53,   95,  -95,  147, -147},
        {  34,  -34,  113, -113,  203, -203,  315, -315},
        {  63,  -63,  210, -210,  378, -378,  588, -588},
        { 104, -104,  345, -345,  621, -621,  966, -966},
        { 158, -158,  528, -528,  950, -950, 1477,-1477},
        { 228, -228,  760, -760, 1368,-1368, 2128,-2128},
        { 316, -316, 1053,-1053, 1895,-1895, 2947,-2947},
        { 422, -422, 1405,-1405, 2529,-2529, 3934,-3934},
        { 548, -548, 1828,-1828, 3290,-3290, 5765,-5765},
        { 696, -696, 2320,-2320, 4176,-4176, 6496,-6496},
        { 868, -868, 2893,-2893, 5207,-5207, 8099,-8099},
        {1064,-1064, 3548,-3548, 6386,-6386, 9933,-9933},
        {1286,-1286, 4288,-4288, 7718,-7718,12005,-12005},
        {1536,-1536, 5120,-5120, 9216,-9216,14336,-14336},
    };

    uint16_t samples_per_channel = read_u16(data + p);
    p += 2;

    // Read LMS state per channel
    for (int ch = 0; ch < channels; ch++) {
        for (int i = 0; i < 4; i++) {
            dec->lms_history[ch][i] = (int16_t)read_u16(data + p);
            p += 2;
        }
        for (int i = 0; i < 4; i++) {
            dec->lms_weights[ch][i] = (int16_t)read_u16(data + p);
            p += 2;
        }
    }

    // Decode slices
    int num_slices = (samples_per_channel + 19) / 20;

    for (int slice = 0; slice < num_slices; slice++) {
        for (int ch = 0; ch < channels; ch++) {
            // Read 8-byte slice
            uint64_t slice_data = 0;
            for (int i = 0; i < 8; i++) {
                slice_data = (slice_data << 8) | data[p++];
            }

            // Extract scale factor (top 4 bits)
            int sf = (slice_data >> 60) & 0x0F;

            // Decode 20 samples
            for (int s = 0; s < 20; s++) {
                int samples_done = slice * 20 + s;
                if (samples_done >= samples_per_channel) break;

                // Extract 3-bit residual
                int residual_idx = (slice_data >> (57 - s * 3)) & 0x07;
                int residual = DEQUANT[sf][residual_idx];

                // LMS prediction
                int prediction = 0;
                for (int i = 0; i < 4; i++) {
                    prediction += dec->lms_weights[ch][i] *
                                  dec->lms_history[ch][i];
                }
                prediction >>= 13;

                // Reconstruct sample
                int sample = CLAMP(prediction + residual, -32768, 32767);

                // Update LMS state
                int delta = residual >> 4;
                for (int i = 0; i < 4; i++) {
                    dec->lms_weights[ch][i] +=
                        dec->lms_history[ch][i] < 0 ? -delta : delta;
                }

                // Shift history
                for (int i = 0; i < 3; i++) {
                    dec->lms_history[ch][i] = dec->lms_history[ch][i + 1];
                }
                dec->lms_history[ch][3] = sample;

                // Output (interleaved)
                output[out_idx * channels + ch] = sample;
            }
            out_idx++;
        }
    }

    *samples_out = samples_per_channel;
    return true;
}

//-----------------------------------------------------------------------------
// Main decode loop
//-----------------------------------------------------------------------------
bool qov_decode(const uint8_t* data, size_t size,
                qov_frame_callback on_frame,
                qov_audio_callback on_audio,
                void* user_data) {
    qov_decoder_t dec = {0};

    // Decode header
    if (!qov_decode_header(&dec, data, size)) {
        return false;
    }

    size_t p = 24;  // After header

    while (p < size) {
        // Read chunk header
        uint8_t chunk_type = data[p];
        uint8_t chunk_flags = data[p + 1];
        uint16_t chunk_size = read_u16(data + p + 2);
        uint32_t timestamp = read_u32(data + p + 4);
        p += 8;

        const uint8_t* chunk_data = data + p;

        switch (chunk_type) {
            case 0x00:  // SYNC
                // Skip sync marker, just continue
                break;

            case 0x01:  // KEYFRAME
                qov_decode_keyframe(&dec, chunk_data, chunk_size);
                if (on_frame) {
                    on_frame(dec.prev_frame, dec.header.width,
                             dec.header.height, timestamp, user_data);
                }
                break;

            case 0x02:  // PFRAME
                qov_decode_pframe(&dec, chunk_data, chunk_size,
                                  chunk_flags & 0x02);
                if (on_frame) {
                    on_frame(dec.prev_frame, dec.header.width,
                             dec.header.height, timestamp, user_data);
                }
                break;

            case 0x10:  // AUDIO
                if (on_audio) {
                    int16_t audio_buf[5120 * 8];  // Max samples × channels
                    size_t samples;
                    qov_decode_audio(&dec, chunk_data, chunk_size,
                                     audio_buf, &samples);
                    on_audio(audio_buf, samples, dec.header.audio_channels,
                             timestamp, user_data);
                }
                break;

            case 0xF0:  // INDEX
                // Index table - can be used for seeking
                break;

            case 0xFF:  // END
                goto done;
        }

        p += chunk_size;
    }

done:
    free(dec.prev_frame);
    free(dec.curr_frame);
    return true;
}
```

---

## 13. Encoder Pseudocode

```c
//=============================================================================
// QOV ENCODER - Reference Implementation Pseudocode
//=============================================================================

typedef struct {
    qov_header_t header;
    qov_rgba_t   index[64];
    qov_rgba_t   prev_pixel;
    qov_rgba_t*  prev_frame;
    uint8_t*     output;
    size_t       output_size;
    size_t       output_capacity;

    // Index table for seeking
    uint32_t*    keyframe_numbers;
    uint64_t*    keyframe_offsets;
    uint32_t*    keyframe_timestamps;
    size_t       keyframe_count;

    // Audio encoder state
    int16_t      lms_history[8][4];
    int16_t      lms_weights[8][4];
} qov_encoder_t;

//-----------------------------------------------------------------------------
// Write helpers
//-----------------------------------------------------------------------------
void write_u8(qov_encoder_t* enc, uint8_t v) {
    if (enc->output_size >= enc->output_capacity) {
        enc->output_capacity *= 2;
        enc->output = realloc(enc->output, enc->output_capacity);
    }
    enc->output[enc->output_size++] = v;
}

void write_u16(qov_encoder_t* enc, uint16_t v) {
    write_u8(enc, v >> 8);
    write_u8(enc, v & 0xFF);
}

void write_u32(qov_encoder_t* enc, uint32_t v) {
    write_u8(enc, (v >> 24) & 0xFF);
    write_u8(enc, (v >> 16) & 0xFF);
    write_u8(enc, (v >> 8) & 0xFF);
    write_u8(enc, v & 0xFF);
}

//-----------------------------------------------------------------------------
// Initialize encoder
//-----------------------------------------------------------------------------
void qov_encoder_init(qov_encoder_t* enc, uint16_t width, uint16_t height,
                      uint16_t fps_num, uint16_t fps_den,
                      uint8_t flags, uint8_t colorspace,
                      uint8_t audio_channels, uint32_t audio_rate) {
    memset(enc, 0, sizeof(*enc));

    enc->header.width = width;
    enc->header.height = height;
    enc->header.frame_rate_num = fps_num;
    enc->header.frame_rate_den = fps_den;
    enc->header.flags = flags;
    enc->header.colorspace = colorspace;
    enc->header.audio_channels = audio_channels;
    enc->header.audio_rate = audio_rate;

    size_t pixels = width * height;
    enc->prev_frame = calloc(pixels, sizeof(qov_rgba_t));
    enc->output_capacity = 1024 * 1024;  // 1MB initial
    enc->output = malloc(enc->output_capacity);
    enc->output_size = 0;

    enc->prev_pixel = (qov_rgba_t){0, 0, 0, 255};
    memset(enc->index, 0, sizeof(enc->index));

    // Initialize LMS weights
    for (int ch = 0; ch < 8; ch++) {
        enc->lms_weights[ch][0] = 0;
        enc->lms_weights[ch][1] = 0;
        enc->lms_weights[ch][2] = -(1 << 13);
        enc->lms_weights[ch][3] = (1 << 14);
    }
}

//-----------------------------------------------------------------------------
// Write file header
//-----------------------------------------------------------------------------
void qov_write_header(qov_encoder_t* enc) {
    // Magic
    write_u8(enc, 'q');
    write_u8(enc, 'o');
    write_u8(enc, 'v');
    write_u8(enc, 'f');

    // Version
    write_u8(enc, 0x01);

    // Flags
    write_u8(enc, enc->header.flags);

    // Dimensions
    write_u16(enc, enc->header.width);
    write_u16(enc, enc->header.height);

    // Frame rate
    write_u16(enc, enc->header.frame_rate_num);
    write_u16(enc, enc->header.frame_rate_den);

    // Total frames (placeholder, updated at end)
    write_u32(enc, 0);

    // Audio
    write_u8(enc, enc->header.audio_channels);
    write_u8(enc, (enc->header.audio_rate >> 16) & 0xFF);
    write_u8(enc, (enc->header.audio_rate >> 8) & 0xFF);
    write_u8(enc, enc->header.audio_rate & 0xFF);

    // Colorspace and reserved
    write_u8(enc, enc->header.colorspace);
    write_u8(enc, 0x00);
}

//-----------------------------------------------------------------------------
// Write sync marker
//-----------------------------------------------------------------------------
void qov_write_sync(qov_encoder_t* enc, uint32_t frame_number,
                    uint32_t timestamp) {
    write_u8(enc, 0x00);   // SYNC type
    write_u8(enc, 0x00);   // flags
    write_u16(enc, 8);     // size
    write_u32(enc, timestamp);

    // Sync data
    write_u8(enc, 'Q');
    write_u8(enc, 'O');
    write_u8(enc, 'V');
    write_u8(enc, 'S');
    write_u32(enc, frame_number);
}

//-----------------------------------------------------------------------------
// Encode keyframe
//-----------------------------------------------------------------------------
void qov_encode_keyframe(qov_encoder_t* enc, const qov_rgba_t* pixels,
                         uint32_t frame_number, uint32_t timestamp) {
    // Record keyframe position for index
    if (enc->header.flags & 0x04) {  // HAS_INDEX
        // Store keyframe info for later
        enc->keyframe_count++;
        enc->keyframe_numbers = realloc(enc->keyframe_numbers,
                                        enc->keyframe_count * sizeof(uint32_t));
        enc->keyframe_offsets = realloc(enc->keyframe_offsets,
                                        enc->keyframe_count * sizeof(uint64_t));
        enc->keyframe_timestamps = realloc(enc->keyframe_timestamps,
                                           enc->keyframe_count * sizeof(uint32_t));
        enc->keyframe_numbers[enc->keyframe_count - 1] = frame_number;
        enc->keyframe_offsets[enc->keyframe_count - 1] = enc->output_size;
        enc->keyframe_timestamps[enc->keyframe_count - 1] = timestamp;
    }

    // Write sync marker before keyframe
    qov_write_sync(enc, frame_number, timestamp);

    // Chunk header placeholder
    size_t header_pos = enc->output_size;
    write_u8(enc, 0x01);   // KEYFRAME type
    write_u8(enc, 0x00);   // flags (RGB mode)
    write_u16(enc, 0);     // size placeholder
    write_u32(enc, timestamp);

    size_t data_start = enc->output_size;

    // Reset encoder state
    memset(enc->index, 0, sizeof(enc->index));
    enc->prev_pixel = (qov_rgba_t){0, 0, 0, 255};

    size_t pixel_count = enc->header.width * enc->header.height;
    size_t run = 0;

    for (size_t px = 0; px < pixel_count; px++) {
        qov_rgba_t c = pixels[px];

        // Check for run
        if (c.r == enc->prev_pixel.r && c.g == enc->prev_pixel.g &&
            c.b == enc->prev_pixel.b && c.a == enc->prev_pixel.a) {
            run++;
            if (run == 62 || px == pixel_count - 1) {
                write_u8(enc, 0xC0 | (run - 1));
                run = 0;
            }
            continue;
        }

        // Flush pending run
        if (run > 0) {
            write_u8(enc, 0xC0 | (run - 1));
            run = 0;
        }

        // Check index
        int idx = qov_color_hash(c);
        if (enc->index[idx].r == c.r && enc->index[idx].g == c.g &&
            enc->index[idx].b == c.b && enc->index[idx].a == c.a) {
            write_u8(enc, idx);
        }
        else {
            // Try diff
            int dr = c.r - enc->prev_pixel.r;
            int dg = c.g - enc->prev_pixel.g;
            int db = c.b - enc->prev_pixel.b;
            int da = c.a - enc->prev_pixel.a;

            if (da == 0) {
                if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 &&
                    db >= -2 && db <= 1) {
                    // QOV_OP_DIFF
                    write_u8(enc, 0x40 | ((dr + 2) << 4) |
                             ((dg + 2) << 2) | (db + 2));
                }
                else if (dg >= -32 && dg <= 31) {
                    int dr_dg = dr - dg;
                    int db_dg = db - dg;
                    if (dr_dg >= -8 && dr_dg <= 7 && db_dg >= -8 && db_dg <= 7) {
                        // QOV_OP_LUMA
                        write_u8(enc, 0x80 | (dg + 32));
                        write_u8(enc, ((dr_dg + 8) << 4) | (db_dg + 8));
                    }
                    else {
                        // QOV_OP_RGB
                        write_u8(enc, 0xFE);
                        write_u8(enc, c.r);
                        write_u8(enc, c.g);
                        write_u8(enc, c.b);
                    }
                }
                else {
                    // QOV_OP_RGB
                    write_u8(enc, 0xFE);
                    write_u8(enc, c.r);
                    write_u8(enc, c.g);
                    write_u8(enc, c.b);
                }
            }
            else {
                // QOV_OP_RGBA
                write_u8(enc, 0xFF);
                write_u8(enc, c.r);
                write_u8(enc, c.g);
                write_u8(enc, c.b);
                write_u8(enc, c.a);
            }
        }

        enc->index[idx] = c;
        enc->prev_pixel = c;
    }

    // End marker
    for (int i = 0; i < 7; i++) write_u8(enc, 0x00);
    write_u8(enc, 0x01);

    // Update chunk size
    uint16_t chunk_size = enc->output_size - data_start;
    enc->output[header_pos + 2] = chunk_size >> 8;
    enc->output[header_pos + 3] = chunk_size & 0xFF;

    // Store frame for P-frame reference
    memcpy(enc->prev_frame, pixels, pixel_count * sizeof(qov_rgba_t));
}

//-----------------------------------------------------------------------------
// Encode P-frame (fast mode - no motion vectors)
//-----------------------------------------------------------------------------
void qov_encode_pframe(qov_encoder_t* enc, const qov_rgba_t* pixels,
                       uint32_t timestamp) {
    // Chunk header placeholder
    size_t header_pos = enc->output_size;
    write_u8(enc, 0x02);   // PFRAME type
    write_u8(enc, 0x00);   // flags (no motion)
    write_u16(enc, 0);     // size placeholder
    write_u32(enc, timestamp);

    size_t data_start = enc->output_size;
    size_t pixel_count = enc->header.width * enc->header.height;
    size_t skip = 0;

    for (size_t px = 0; px < pixel_count; px++) {
        qov_rgba_t c = pixels[px];
        qov_rgba_t ref = enc->prev_frame[px];

        // Check if pixel unchanged from reference
        if (c.r == ref.r && c.g == ref.g && c.b == ref.b && c.a == ref.a) {
            skip++;
            if (skip == 62 || px == pixel_count - 1) {
                write_u8(enc, 0xC0 | (skip - 1));  // QOV_OP_SKIP
                skip = 0;
            }
            continue;
        }

        // Flush skip
        if (skip > 0) {
            if (skip <= 62) {
                write_u8(enc, 0xC0 | (skip - 1));
            } else {
                write_u8(enc, 0x00);  // QOV_OP_SKIP_LONG
                write_u16(enc, skip);
            }
            skip = 0;
        }

        // Try temporal diff
        int dr = c.r - ref.r;
        int dg = c.g - ref.g;
        int db = c.b - ref.b;
        int da = c.a - ref.a;

        if (da == 0 && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 &&
            db >= -2 && db <= 1) {
            // QOV_OP_TDIFF
            write_u8(enc, 0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));
        }
        else if (da == 0 && dg >= -32 && dg <= 31) {
            int dr_dg = dr - dg;
            int db_dg = db - dg;
            if (dr_dg >= -8 && dr_dg <= 7 && db_dg >= -8 && db_dg <= 7) {
                // QOV_OP_TLUMA
                write_u8(enc, 0x80 | (dg + 32));
                write_u8(enc, ((dr_dg + 8) << 4) | (db_dg + 8));
            }
            else {
                // QOV_OP_RGB
                write_u8(enc, 0xFE);
                write_u8(enc, c.r);
                write_u8(enc, c.g);
                write_u8(enc, c.b);
            }
        }
        else if (da == 0) {
            // QOV_OP_RGB
            write_u8(enc, 0xFE);
            write_u8(enc, c.r);
            write_u8(enc, c.g);
            write_u8(enc, c.b);
        }
        else {
            // QOV_OP_RGBA
            write_u8(enc, 0xFF);
            write_u8(enc, c.r);
            write_u8(enc, c.g);
            write_u8(enc, c.b);
            write_u8(enc, c.a);
        }

        enc->index[qov_color_hash(c)] = c;
    }

    // End marker
    for (int i = 0; i < 7; i++) write_u8(enc, 0x00);
    write_u8(enc, 0x01);

    // Update chunk size
    uint16_t chunk_size = enc->output_size - data_start;
    enc->output[header_pos + 2] = chunk_size >> 8;
    enc->output[header_pos + 3] = chunk_size & 0xFF;

    // Store frame for next P-frame reference
    memcpy(enc->prev_frame, pixels, pixel_count * sizeof(qov_rgba_t));
}

//-----------------------------------------------------------------------------
// Encode audio chunk (QOA-based)
//-----------------------------------------------------------------------------
void qov_encode_audio(qov_encoder_t* enc, const int16_t* samples,
                      size_t sample_count, uint32_t timestamp) {
    int channels = enc->header.audio_channels;

    // QOA constants
    static const int SCALE[16] = {
        1, 7, 21, 45, 84, 138, 211, 304,
        421, 562, 731, 928, 1157, 1419, 1715, 2048
    };

    static const int QUANT[17] = {
        7, 7, 7, 5, 5, 3, 3, 1, 0, 0, 2, 2, 4, 4, 6, 6, 6
    };

    // Chunk header placeholder
    size_t header_pos = enc->output_size;
    write_u8(enc, 0x10);   // AUDIO type
    write_u8(enc, 0x01);   // 1 QOA frame
    write_u16(enc, 0);     // size placeholder
    write_u32(enc, timestamp);

    size_t data_start = enc->output_size;

    // Samples per channel
    write_u16(enc, sample_count);

    // Write LMS state per channel
    for (int ch = 0; ch < channels; ch++) {
        for (int i = 0; i < 4; i++) {
            write_u16(enc, enc->lms_history[ch][i]);
        }
        for (int i = 0; i < 4; i++) {
            write_u16(enc, enc->lms_weights[ch][i]);
        }
    }

    // Encode slices (20 samples each)
    int num_slices = (sample_count + 19) / 20;

    for (int slice = 0; slice < num_slices; slice++) {
        for (int ch = 0; ch < channels; ch++) {
            // Find best scale factor (brute force)
            int best_sf = 0;
            int64_t best_error = INT64_MAX;

            for (int sf = 0; sf < 16; sf++) {
                int16_t test_history[4];
                int16_t test_weights[4];
                memcpy(test_history, enc->lms_history[ch], sizeof(test_history));
                memcpy(test_weights, enc->lms_weights[ch], sizeof(test_weights));

                int64_t error = 0;

                for (int s = 0; s < 20; s++) {
                    int sample_idx = slice * 20 + s;
                    if (sample_idx >= sample_count) break;

                    int16_t sample = samples[sample_idx * channels + ch];

                    // LMS prediction
                    int prediction = 0;
                    for (int i = 0; i < 4; i++) {
                        prediction += test_weights[i] * test_history[i];
                    }
                    prediction >>= 13;

                    int residual = sample - prediction;
                    int scaled = residual / SCALE[sf];
                    scaled = CLAMP(scaled + 8, 0, 16);
                    int quantized = QUANT[scaled];

                    // Dequantize and reconstruct
                    int dequant = (quantized >= 4) ?
                        SCALE[sf] * (quantized - 3) :
                        -SCALE[sf] * (4 - quantized);
                    int reconstructed = CLAMP(prediction + dequant, -32768, 32767);

                    error += (int64_t)(sample - reconstructed) *
                             (sample - reconstructed);

                    // Update test LMS
                    int delta = dequant >> 4;
                    for (int i = 0; i < 4; i++) {
                        test_weights[i] += test_history[i] < 0 ? -delta : delta;
                    }
                    for (int i = 0; i < 3; i++) {
                        test_history[i] = test_history[i + 1];
                    }
                    test_history[3] = reconstructed;
                }

                if (error < best_error) {
                    best_error = error;
                    best_sf = sf;
                }
            }

            // Encode slice with best scale factor
            uint64_t slice_data = (uint64_t)best_sf << 60;

            for (int s = 0; s < 20; s++) {
                int sample_idx = slice * 20 + s;
                if (sample_idx >= sample_count) {
                    // Pad with zeros
                    slice_data |= (uint64_t)0 << (57 - s * 3);
                    continue;
                }

                int16_t sample = samples[sample_idx * channels + ch];

                // LMS prediction
                int prediction = 0;
                for (int i = 0; i < 4; i++) {
                    prediction += enc->lms_weights[ch][i] *
                                  enc->lms_history[ch][i];
                }
                prediction >>= 13;

                int residual = sample - prediction;
                int scaled = residual / SCALE[best_sf];
                scaled = CLAMP(scaled + 8, 0, 16);
                int quantized = QUANT[scaled];

                slice_data |= (uint64_t)quantized << (57 - s * 3);

                // Dequantize and update state
                int dequant = (quantized >= 4) ?
                    SCALE[best_sf] * (quantized - 3) :
                    -SCALE[best_sf] * (4 - quantized);
                int reconstructed = CLAMP(prediction + dequant, -32768, 32767);

                int delta = dequant >> 4;
                for (int i = 0; i < 4; i++) {
                    enc->lms_weights[ch][i] +=
                        enc->lms_history[ch][i] < 0 ? -delta : delta;
                }
                for (int i = 0; i < 3; i++) {
                    enc->lms_history[ch][i] = enc->lms_history[ch][i + 1];
                }
                enc->lms_history[ch][3] = reconstructed;
            }

            // Write 8-byte slice
            for (int i = 7; i >= 0; i--) {
                write_u8(enc, (slice_data >> (i * 8)) & 0xFF);
            }
        }
    }

    // Update chunk size
    uint16_t chunk_size = enc->output_size - data_start;
    enc->output[header_pos + 2] = chunk_size >> 8;
    enc->output[header_pos + 3] = chunk_size & 0xFF;
}

//-----------------------------------------------------------------------------
// Write index table
//-----------------------------------------------------------------------------
void qov_write_index(qov_encoder_t* enc) {
    if (!(enc->header.flags & 0x04) || enc->keyframe_count == 0) return;

    // Chunk header
    write_u8(enc, 0xF0);   // INDEX type
    write_u8(enc, 0x00);   // flags
    uint16_t size = 4 + enc->keyframe_count * 16;
    write_u16(enc, size);
    write_u32(enc, 0);     // timestamp (not used)

    // Entry count
    write_u32(enc, enc->keyframe_count);

    // Index entries
    for (size_t i = 0; i < enc->keyframe_count; i++) {
        write_u32(enc, enc->keyframe_numbers[i]);
        // 8-byte offset
        uint64_t offset = enc->keyframe_offsets[i];
        write_u32(enc, (offset >> 32) & 0xFFFFFFFF);
        write_u32(enc, offset & 0xFFFFFFFF);
        write_u32(enc, enc->keyframe_timestamps[i]);
    }
}

//-----------------------------------------------------------------------------
// Write end marker
//-----------------------------------------------------------------------------
void qov_write_end(qov_encoder_t* enc) {
    write_u8(enc, 0xFF);   // END type
    write_u8(enc, 0x00);   // flags
    write_u16(enc, 0);     // size
    write_u32(enc, 0);     // timestamp

    // End pattern
    for (int i = 0; i < 7; i++) write_u8(enc, 0x00);
    write_u8(enc, 0x01);
}

//-----------------------------------------------------------------------------
// Finalize and get output
//-----------------------------------------------------------------------------
void qov_encoder_finish(qov_encoder_t* enc, uint32_t total_frames) {
    // Write index table
    qov_write_index(enc);

    // Write end marker
    qov_write_end(enc);

    // Update total frame count in header
    enc->output[14] = (total_frames >> 24) & 0xFF;
    enc->output[15] = (total_frames >> 16) & 0xFF;
    enc->output[16] = (total_frames >> 8) & 0xFF;
    enc->output[17] = total_frames & 0xFF;
}

//-----------------------------------------------------------------------------
// Example usage
//-----------------------------------------------------------------------------
/*
int main() {
    qov_encoder_t enc;

    // Initialize: 1920x1080, 30fps, with index table
    qov_encoder_init(&enc, 1920, 1080, 30, 1,
                     0x04,    // HAS_INDEX
                     0x00,    // SRGB
                     2,       // stereo audio
                     48000);  // 48kHz

    qov_write_header(&enc);

    int keyframe_interval = 30;

    for (int frame = 0; frame < total_frames; frame++) {
        uint32_t timestamp = frame * 1000000 / 30;  // microseconds

        qov_rgba_t* pixels = get_frame(frame);

        if (frame % keyframe_interval == 0) {
            qov_encode_keyframe(&enc, pixels, frame, timestamp);
        } else {
            qov_encode_pframe(&enc, pixels, timestamp);
        }

        // Encode audio for this frame
        int16_t* audio = get_audio_for_frame(frame);
        int samples = 48000 / 30;  // ~1600 samples per frame
        qov_encode_audio(&enc, audio, samples, timestamp);
    }

    qov_encoder_finish(&enc, total_frames);

    // Write to file
    FILE* f = fopen("output.qov", "wb");
    fwrite(enc.output, 1, enc.output_size, f);
    fclose(f);

    return 0;
}
*/
```

---

## 14. Implementation Notes

### 14.1 Decoder Complexity Levels

| Mode | Flags | LOC | Features |
|------|-------|-----|----------|
| Minimal | 0x00 | ~300 | RGB keyframes only, no audio |
| Simple | 0x00 | ~400 | RGB, P-frames, no motion |
| Standard | 0x04 | ~500 | RGB/YUV, index table |
| Full | 0x07 | ~800 | All features including motion |

### 14.2 Performance Considerations

1. **Decode priority**: Skip opcodes are most common in P-frames, optimize for them
2. **Memory**: Only need 2 frame buffers (current + previous)
3. **SIMD**: Color hash and LMS prediction are SIMD-friendly
4. **Streaming**: Process chunks independently, no global state needed

### 14.3 Recommended Settings

| Use Case | Keyframe Interval | Motion | Colorspace |
|----------|-------------------|--------|------------|
| Screen recording | 60 frames | No | SRGB |
| Animation | 30 frames | No | SRGBA |
| Live action | 30 frames | Yes | YUV420 |
| Streaming | 60 frames | No | SRGB |

---

## 15. License

This specification is placed in the public domain.
