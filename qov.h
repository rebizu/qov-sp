/* qov.h - QOV (Quite OK Video) single-header codec, C99.
 *
 * A dependency-free decoder and encoder for the QOV container format
 * (qov-specification.md v3.2), bit-exact with the TypeScript and C#
 * reference implementations - verified against the golden corpus by
 * qov-analysis-tools/conformance.py.
 *
 * Usage (decoder):
 *     #define QOV_IMPLEMENTATION
 *     #include "qov.h"
 *
 *     qov_header hdr;
 *     qov_decode_header(data, size, &hdr);
 *     qov_image *frames = NULL; size_t count = 0;
 *     qov_decode_all(data, size, &frames, &count, NULL);
 *     ...
 *     qov_frames_free(frames, count);
 *
 * Usage (encoder):
 *     qov_encode_params p = {0};
 *     p.width = 128; p.height = 96; p.fps_num = 30; p.fps_den = 1;
 *     p.colorspace = QOV_CS_YUV420; p.lz4 = 1;
 *     qov_encoder *e = qov_encode_start(&p);
 *     qov_encode_keyframe(e, rgba, 0);
 *     qov_encode_pframe(e, rgba, 33333);
 *     uint8_t *out; size_t out_size;
 *     qov_encode_finish(e, &out, &out_size);
 *
 * Audio chunks are skipped during decode (counted in audio_chunks);
 * the C implementation does not encode audio.
 *
 * Supported: v1/v2/v3 headers, all eight colorspaces, RGB and YUV lossless,
 * v3 lossy (plane quantization + 8x8 DCT residuals), motion vectors,
 * alpha planes, LZ4 chunk compression (byte-identical to the reference
 * compressors, including the TS double-precision hash behavior).
 */
#ifndef QOV_H
#define QOV_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- error codes ---- */
enum {
    QOV_OK = 0,
    QOV_ERR_MAGIC,
    QOV_ERR_VERSION,
    QOV_ERR_HEADER,
    QOV_ERR_TRUNCATED,
    QOV_ERR_CORRUPT,
    QOV_ERR_OOM,
    QOV_ERR_PARAM,
    QOV_ERR_NO_ROOM
};
typedef int qov_result;

/* ---- colorspaces ---- */
enum {
    QOV_CS_SRGB = 0x00, QOV_CS_SRGBA = 0x01, QOV_CS_LINEAR = 0x02, QOV_CS_LINEAR_A = 0x03,
    QOV_CS_YUV420 = 0x10, QOV_CS_YUV422 = 0x11, QOV_CS_YUV444 = 0x12, QOV_CS_YUVA420 = 0x13
};

/* ---- header flags ---- */
enum { QOV_F_HAS_ALPHA = 0x01, QOV_F_HAS_MOTION = 0x02, QOV_F_HAS_INDEX = 0x04,
       QOV_F_HAS_BFRAMES = 0x08, QOV_F_LOSSY = 0x20, QOV_F_DCT = 0x40,
       QOV_F_INTRA_DCT_KF = 0x80 };

typedef struct {
    uint8_t version;        /* 1, 2 or 3 */
    uint8_t flags;
    uint8_t colorspace;
    uint8_t audio_channels;
    uint32_t width, height;
    uint32_t fps_num, fps_den;
    uint32_t total_frames;
    uint32_t audio_rate;
    int lossy;              /* flags & LOSSY (v3) */
    uint8_t quality, y_quant, uv_quant, temporal_thresh, dct_qp;
    size_t header_size;     /* 24 (v1/v2) or 32 (v3) */
} qov_header;

typedef struct {
    uint8_t *rgba;          /* width*height*4, free with qov_frames_free() */
    uint32_t width, height;
    uint32_t timestamp_us;
    int keyframe;
} qov_image;

typedef struct {
    size_t frame_count;
    size_t audio_chunks;    /* skipped during decode */
} qov_decode_stats;

/* ---- decode API ---- */
qov_result qov_decode_header(const uint8_t *data, size_t size, qov_header *out);
/* Decodes every frame into malloc'd RGBA images (free with qov_frames_free).
   Any of frames_out/count_out/stats may be NULL. */
qov_result qov_decode_all(const uint8_t *data, size_t size,
                          qov_image **frames_out, size_t *count_out,
                          qov_decode_stats *stats);
/* Decodes only the first frame (always a keyframe) into *out. Stops reading
   after the first video chunk - cheap for previews/thumbnails.
   out->rgba is malloc'd (free with qov_free()). */
qov_result qov_decode_first_frame(const uint8_t *data, size_t size, qov_image *out);
void qov_frames_free(qov_image *frames, size_t count);

/* ---- incremental decode API ---- */
/* Decoded QOA audio for one AUDIO chunk (interleaved s16). */
typedef struct {
    int16_t *samples;       /* sample_count * channels, interleaved */
    size_t sample_count;    /* per-channel samples */
    uint32_t rate;
    uint8_t channels;
} qov_audio;

typedef struct qov_decoder qov_decoder;

/* Creates a decoder context from a parsed header. NULL on invalid/OOM. */
qov_result qov_decoder_new(const qov_header *hdr, qov_decoder **out);
/* Feeds one raw chunk payload. chunk_type/chunk_flags are the chunk header
   fields (COMPRESSED 0x10 handled internally for frame chunks). Fills *out_img
   for KEYFRAME/PFRAME chunks and *out_aud for AUDIO chunks; either may be NULL.
   Both output buffers are owned by the decoder and stay valid only until the
   next feed/reset/free. SYNC/BFRAME/INDEX/END/unknown chunks produce no output.
   timestamp_us only feeds out_img->timestamp_us. */
qov_result qov_decoder_feed(qov_decoder *dec, uint8_t chunk_type, uint8_t chunk_flags,
                            const uint8_t *payload, size_t size, uint32_t timestamp_us,
                            qov_image *out_img, qov_audio *out_aud);
/* Clears reference frames and the RGB color cache (call after seeking to a
   keyframe boundary). */
qov_result qov_decoder_reset(qov_decoder *dec);
void qov_decoder_free(qov_decoder *dec);


/* ---- encode API ---- */
typedef struct {
    uint32_t width, height;
    uint32_t fps_num, fps_den;
    uint8_t colorspace;     /* QOV_CS_* */
    int has_alpha;          /* extra alpha plane in YUV modes */
    int motion;             /* motion estimation (HAS_MOTION) */
    int lz4;                /* per-chunk LZ4 compression */
    int quality;            /* <=0 or >=100: lossless; 1-99: lossy DCT */
    int intra_dct_keyframes; /* nonzero: lossy YUV keyframes use intra DCT
                                blocks (spec 3.4.3); wins on camera content,
                                loses on sharp screen content */
    uint8_t audio_channels; /* 0 = no audio (QOV_CHUNK_AUDIO via qov_encode_audio) */
    uint32_t audio_rate;    /* required when audio_channels > 0 */
} qov_encode_params;

typedef struct qov_encoder qov_encoder;

/* Starts an encoder (writes the file header). NULL on invalid params/OOM. */
qov_encoder *qov_encode_start(const qov_encode_params *params);
/* Encodes one full frame as a keyframe (with a preceding SYNC chunk).
   rgba is width*height*4 bytes. */
qov_result qov_encode_keyframe(qov_encoder *e, const uint8_t *rgba, uint64_t timestamp_us);
/* Encodes one full frame as a P-frame, predicted from the previous frame. */
qov_result qov_encode_pframe(qov_encoder *e, const uint8_t *rgba, uint64_t timestamp_us);
/* Encodes one AUDIO chunk: total_samples interleaved s16 samples become a
   single QOA frame (mirrors src/qov-encoder.ts encodeAudio: never LZ4
   compressed). Requires audio_channels/audio_rate in the encode params. */
qov_result qov_encode_audio(qov_encoder *e, const int16_t *samples,
                            size_t total_samples, uint64_t timestamp_us);
/* Takes the chunk bytes encoded so far (everything after the file header)
   out of the internal buffer, so an incremental consumer can stream them.
   The encoder keeps running; qov_encode_finish still writes the index and
   END chunk. *data_out is NULL when nothing is pending (QOV_OK). */
qov_result qov_encoder_take_chunks(qov_encoder *e, uint8_t **data_out, size_t *size_out);
/* Writes the index table + END chunk, patches the total frame count and
   hands ownership of the buffer to the caller (free with qov_free()).
   The encoder is freed; NULL inputs return QOV_ERR_PARAM. */
qov_result qov_encode_finish(qov_encoder *e, uint8_t **data_out, size_t *size_out);
void qov_encoder_free(qov_encoder *e);

/* Encoder decision tallies (scoreboard): per-frame counts plus the 8x8
   block decisions taken in the DCT plane encoders. Snapshot copy out. */
typedef struct {
    uint64_t frames_key;   /* keyframes encoded */
    uint64_t frames_p;     /* P-frames encoded (not counting keyframe fallback) */
    uint64_t blocks_skip;  /* 8x8 blocks below the skip threshold */
    uint64_t blocks_coded; /* 8x8 DCT blocks written */
} qov_encode_stats;
void qov_encode_get_stats(const qov_encoder *e, qov_encode_stats *out);

/* ---- custom allocation ---- */
/* Optional: install custom allocators before any qov_* call (default: libc).
   qov_free must be provided whenever mem_alloc is. */
void qov_set_allocator(void *(*mem_alloc)(size_t),
                       void *(*mem_realloc)(void *, size_t),
                       void (*mem_free)(void *));
void qov_free(void *p);

/* Converts planar 4:2:0 YUV (BT.601, same math as the decoder) to packed
   RGBA. out needs w*h*4 bytes. Useful for feeding decoded YUV frames to
   qov_encode_keyframe/pframe. */
void qov_yuv420_to_rgba(const uint8_t *yp, const uint8_t *up, const uint8_t *vp,
                        uint32_t w, uint32_t h, uint8_t *out);

#ifdef QOV_IMPLEMENTATION

#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* allocation                                                          */
/* ------------------------------------------------------------------ */

static void *(*qov_g_malloc)(size_t) = NULL;
static void *(*qov_g_realloc)(void *, size_t) = NULL;
static void (*qov_g_free)(void *) = NULL;

void qov_set_allocator(void *(*mem_alloc)(size_t), void *(*mem_realloc)(void *, size_t),
                       void (*mem_free)(void *))
{
    qov_g_malloc = mem_alloc;
    qov_g_realloc = mem_realloc;
    qov_g_free = mem_free;
}

static void *qov__malloc(size_t n) { return qov_g_malloc ? qov_g_malloc(n) : malloc(n ? n : 1); }
static void *qov__realloc(void *p, size_t n) { return qov_g_realloc ? qov_g_realloc(p, n) : realloc(p, n ? n : 1); }
static void qov__free(void *p) { if (qov_g_free) qov_g_free(p); else free(p); }
static uint8_t *qov__u8malloc(size_t n) { return (uint8_t *)qov__malloc(n); }

void qov_free(void *p) { qov__free(p); }

/* ------------------------------------------------------------------ */
/* helpers with JS semantics                                           */
/* ------------------------------------------------------------------ */

/* JS Math.round: floor(x + 0.5) - half-up, NOT banker's rounding */
static int qov_round(double x)
{
    double f = x + 0.5;
    long long i = (long long)f;
    if (f < 0.0 && (double)i != f) i -= 1;
    return (int)i;
}

/* JS Math.floor semantics (negative-safe integer truncation) */
static int qov_floord(double x)
{
    long long i = (long long)x;
    if (x < 0.0 && (double)i != x) i -= 1;
    return (int)i;
}

static int qov_clampi(int v, int lo, int hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

static uint32_t qov_be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

static uint32_t qov_chroma_w(uint8_t cs, uint32_t w) { return (cs == QOV_CS_YUV444) ? w : (w + 1) / 2; }
static uint32_t qov_chroma_h(uint8_t cs, uint32_t h)
{
    if (cs == QOV_CS_YUV444) return h;
    if (cs == QOV_CS_YUV422) return h;
    return (h + 1) / 2;
}

/* ------------------------------------------------------------------ */
/* growable byte buffer                                                */
/* ------------------------------------------------------------------ */

typedef struct {
    uint8_t *data;
    size_t size, cap;
} qov__buf;

static qov_result qov__buf_reserve(qov__buf *b, size_t extra)
{
    if (b->size + extra <= b->cap) return QOV_OK;
    size_t ncap = b->cap ? b->cap : (1 << 16);
    while (ncap < b->size + extra) ncap *= 2;
    uint8_t *nd = (uint8_t *)qov__realloc(b->data, ncap);
    if (!nd) return QOV_ERR_OOM;
    b->data = nd;
    b->cap = ncap;
    return QOV_OK;
}

static qov_result qov__buf_u8(qov__buf *b, uint8_t v)
{
    qov_result r = qov__buf_reserve(b, 1);
    if (r) return r;
    b->data[b->size++] = v;
    return QOV_OK;
}

static qov_result qov__buf_u16(qov__buf *b, uint16_t v)
{
    qov_result r = qov__buf_reserve(b, 2);
    if (r) return r;
    b->data[b->size++] = (uint8_t)(v >> 8);
    b->data[b->size++] = (uint8_t)v;
    return QOV_OK;
}

static qov_result qov__buf_be32(qov__buf *b, uint32_t v)
{
    qov_result r = qov__buf_reserve(b, 4);
    if (r) return r;
    b->data[b->size++] = (uint8_t)(v >> 24);
    b->data[b->size++] = (uint8_t)(v >> 16);
    b->data[b->size++] = (uint8_t)(v >> 8);
    b->data[b->size++] = (uint8_t)v;
    return QOV_OK;
}

static qov_result qov__buf_bytes(qov__buf *b, const uint8_t *p, size_t n)
{
    qov_result r = qov__buf_reserve(b, n);
    if (r) return r;
    memcpy(b->data + b->size, p, n);
    b->size += n;
    return QOV_OK;
}

static void qov__buf_patch_be32(qov__buf *b, size_t pos, uint32_t v)
{
    b->data[pos] = (uint8_t)(v >> 24);
    b->data[pos + 1] = (uint8_t)(v >> 16);
    b->data[pos + 2] = (uint8_t)(v >> 8);
    b->data[pos + 3] = (uint8_t)v;
}

/* ------------------------------------------------------------------ */
/* LZ4 block format (compress ported byte-exactly from src/lz4.ts)     */
/* ------------------------------------------------------------------ */

static int qov__lz4_hash4(const uint8_t *d, size_t pos)
{
    /* TS computes this as a DOUBLE multiply: v * 2654435769 loses
       precision above 2^53, so an exact 32-bit wrap diverges. Replicate:
       ToUint32(prod) >>> 16 & 0xFFFF == (exactInt(prod) >> 16) & 0xFFFF. */
    uint32_t v = (uint32_t)(d[pos] | (d[pos + 1] << 8) | (d[pos + 2] << 16) |
                            ((uint32_t)d[pos + 3] << 24));
    double prod = (double)v * 2654435769.0;
    uint64_t exact = (uint64_t)prod; /* prod is an exact integer double < 2^64 */
    return (int)((exact >> 16) & 0xFFFF);
}

static int qov__lz4_match4(const uint8_t *d, size_t a, size_t b)
{
    return d[a] == d[b] && d[a + 1] == d[b + 1] && d[a + 2] == d[b + 2] && d[a + 3] == d[b + 3];
}

static qov_result qov__lz4_decompress(const uint8_t *in, size_t in_len,
                                      uint8_t *out, size_t out_size)
{
    size_t in_pos = 0, out_pos = 0;
    while (in_pos < in_len) {
        uint8_t token = in[in_pos++];
        size_t lit_len = token >> 4;
        if (lit_len == 15) {
            uint8_t b;
            do {
                if (in_pos >= in_len) return QOV_ERR_TRUNCATED;
                b = in[in_pos++];
                lit_len += b;
            } while (b == 255);
        }
        if (in_pos + lit_len > in_len || out_pos + lit_len > out_size)
            return QOV_ERR_TRUNCATED;
        memcpy(out + out_pos, in + in_pos, lit_len);
        in_pos += lit_len;
        out_pos += lit_len;
        if (in_pos >= in_len) break;

        if (in_pos + 2 > in_len) return QOV_ERR_TRUNCATED;
        size_t offset = in[in_pos] | ((size_t)in[in_pos + 1] << 8);
        in_pos += 2;
        if (offset == 0 || offset > out_pos) return QOV_ERR_CORRUPT;
        size_t m_len = (token & 0x0f) + 4;
        if ((token & 0x0f) == 15) {
            uint8_t b;
            do {
                if (in_pos >= in_len) return QOV_ERR_TRUNCATED;
                b = in[in_pos++];
                m_len += b;
            } while (b == 255);
        }
        if (out_pos + m_len > out_size) return QOV_ERR_TRUNCATED;
        size_t match_pos = out_pos - offset;
        for (size_t i = 0; i < m_len; i++)
            out[out_pos++] = out[match_pos + i];
    }
    if (out_pos != out_size) return QOV_ERR_CORRUPT;
    return QOV_OK;
}

static qov_result qov__lz4_compress(const uint8_t *in, size_t in_size,
                                    uint8_t **out_data, size_t *out_len)
{
    *out_data = NULL;
    *out_len = 0;
    if (in_size == 0) return QOV_ERR_PARAM;

    size_t max_out = in_size + in_size / 255 + 16;
    uint8_t *out = (uint8_t *)qov__malloc(max_out);
    if (!out) return QOV_ERR_OOM;

    int *hash_table = (int *)qov__malloc(sizeof(int) * (1 << 16));
    if (!hash_table) { qov__free(out); return QOV_ERR_OOM; }
    for (size_t i = 0; i < (1 << 16); i++) hash_table[i] = -1;

    size_t out_pos = 0, anchor = 0, pos = 0;
    while (pos + 5 < in_size) {
        int h = qov__lz4_hash4(in, pos);
        int64_t ref = hash_table[h];
        hash_table[h] = (int)pos;

        if (ref >= 0 && pos - (size_t)ref < 65535 && qov__lz4_match4(in, pos, (size_t)ref)) {
            size_t literal_len = pos - anchor;
            size_t match_len = 4;
            while (pos + match_len < in_size - 5 && in[(size_t)ref + match_len] == in[pos + match_len])
                match_len++;

            size_t token_pos = out_pos++;
            uint8_t token = 0;

            if (literal_len >= 15) {
                token = (uint8_t)(15 << 4);
                size_t remaining = literal_len - 15;
                while (remaining >= 255) { out[out_pos++] = 255; remaining -= 255; }
                out[out_pos++] = (uint8_t)remaining;
            } else {
                token = (uint8_t)(literal_len << 4);
            }

            for (size_t i = 0; i < literal_len; i++) out[out_pos++] = in[anchor + i];

            size_t offset = pos - (size_t)ref;
            out[out_pos++] = (uint8_t)(offset & 0xff);
            out[out_pos++] = (uint8_t)((offset >> 8) & 0xff);

            size_t mlm4 = match_len - 4;
            if (mlm4 >= 15) {
                token |= 15;
                size_t remaining = mlm4 - 15;
                while (remaining >= 255) { out[out_pos++] = 255; remaining -= 255; }
                out[out_pos++] = (uint8_t)remaining;
            } else {
                token |= (uint8_t)mlm4;
            }

            out[token_pos] = token;
            pos += match_len;
            anchor = pos;

            if (pos + 5 < in_size)
                hash_table[qov__lz4_hash4(in, pos - 2)] = (int)(pos - 2);
        } else {
            pos++;
        }
    }

    size_t last_literals = in_size - anchor;
    if (last_literals > 0) {
        if (last_literals >= 15) {
            out[out_pos++] = (uint8_t)(15 << 4);
            size_t remaining = last_literals - 15;
            while (remaining >= 255) { out[out_pos++] = 255; remaining -= 255; }
            out[out_pos++] = (uint8_t)remaining;
        } else {
            out[out_pos++] = (uint8_t)(last_literals << 4);
        }
        for (size_t i = 0; i < last_literals; i++) out[out_pos++] = in[anchor + i];
    }

    qov__free(hash_table);

    /* TS acceptance rule: keep compression only when it saves >= 20% */
    if ((double)out_pos >= (double)in_size * 0.80) {
        qov__free(out);
        return QOV_ERR_NO_ROOM;
    }

    *out_data = out;
    *out_len = out_pos;
    return QOV_OK;
}

/* ------------------------------------------------------------------ */
/* QOA (Quite OK Audio) - bit-exact with src/qoa.ts                    */
/* ------------------------------------------------------------------ */

#define QOV_QOA_SLICE_SAMPLES 20
#define QOV_QOA_SLICES_PER_FRAME 256
#define QOV_QOA_LMS_LEN 4

typedef struct {
    int16_t history[QOV_QOA_LMS_LEN];
    int16_t weights[QOV_QOA_LMS_LEN];
} qov__qoa_lms;

/* Reference dequant table (qoaformat.org); rows 12-15 fixed in 72fcdc2 */
static const int qov__qoa_dequant_tab[16][8] = {
    {   1,    -1,    3,    -3,    5,    -5,     7,     -7},
    {   5,    -5,   18,   -18,   32,   -32,    49,    -49},
    {  16,   -16,   53,   -53,   95,   -95,   147,   -147},
    {  34,   -34,  113,  -113,  203,  -203,   315,   -315},
    {  63,   -63,  210,  -210,  378,  -378,   588,   -588},
    { 104,  -104,  345,  -345,  621,  -621,   966,   -966},
    { 158,  -158,  528,  -528,  950,  -950,  1477,  -1477},
    { 228,  -228,  760,  -760, 1368, -1368,  2128,  -2128},
    { 316,  -316, 1053, -1053, 1895, -1895,  2947,  -2947},
    { 422,  -422, 1405, -1405, 2529, -2529,  3934,  -3934},
    { 548,  -548, 1828, -1828, 3290, -3290,  5117,  -5117},
    { 696,  -696, 2320, -2320, 4176, -4176,  6496,  -6496},
    { 868,  -868, 2893, -2893, 5207, -5207,  8099,  -8099},
    {1064, -1064, 3548, -3548, 6386, -6386,  9933,  -9933},
    {1286, -1286, 4288, -4288, 7718, -7718, 12005, -12005},
    {1536, -1536, 5120, -5120, 9216, -9216, 14336, -14336},
};

static int qov__qoa_clamp16(int v) { return v < -32768 ? -32768 : (v > 32767 ? 32767 : v); }

static int qov__qoa_lms_predict(const qov__qoa_lms *lms)
{
    int p = 0;
    for (int i = 0; i < QOV_QOA_LMS_LEN; i++) p += lms->weights[i] * lms->history[i];
    return p >> 13;
}

static void qov__qoa_lms_update(qov__qoa_lms *lms, int residual)
{
    int delta = residual >> 4;
    for (int i = 0; i < QOV_QOA_LMS_LEN; i++)
        lms->weights[i] = (int16_t)(lms->weights[i] + (lms->history[i] < 0 ? -delta : delta));
    for (int i = 0; i < QOV_QOA_LMS_LEN - 1; i++) lms->history[i] = lms->history[i + 1];
    /* caller stores the reconstructed sample into history[LMS_LEN-1] */
}

/* Decodes one QOA frame. Returns per-channel sample count, 0 on error.
   out needs room for sample_count * channels samples (interleaved). */
static size_t qov__qoa_decode_frame(const uint8_t *payload, size_t size,
                                    qov__qoa_lms *lms, int16_t *out)
{
    if (size < 8) return 0;
    uint32_t channels = payload[0];
    uint32_t samplerate = ((uint32_t)payload[1] << 16) | ((uint32_t)payload[2] << 8) | payload[3];
    uint32_t fsamples = ((uint32_t)payload[4] << 8) | payload[5];
    uint32_t frame_size = ((uint32_t)payload[6] << 8) | payload[7];
    (void)samplerate;
    if (channels == 0 || channels > 8 || fsamples == 0) return 0;

    size_t header_size = 8 + (size_t)channels * 16;
    if (frame_size < header_size || frame_size > size) return 0;
    size_t num_slices = (frame_size - header_size) / 8;
    size_t slices_needed = ((size_t)fsamples + QOV_QOA_SLICE_SAMPLES - 1) / QOV_QOA_SLICE_SAMPLES;
    if (slices_needed > QOV_QOA_SLICES_PER_FRAME || slices_needed * channels > num_slices) return 0;

    size_t p = 8;
    for (uint32_t c = 0; c < channels; c++) {
        uint64_t history = 0, weights = 0;
        for (int i = 0; i < 8; i++) history = (history << 8) | payload[p++];
        for (int i = 0; i < 8; i++) weights = (weights << 8) | payload[p++];
        for (int i = 0; i < QOV_QOA_LMS_LEN; i++)
            lms[c].history[i] = (int16_t)(uint16_t)(history >> (48 - 16 * i));
        for (int i = 0; i < QOV_QOA_LMS_LEN; i++)
            lms[c].weights[i] = (int16_t)(uint16_t)(weights >> (48 - 16 * i));
    }

    for (uint32_t slice = 0; slice < slices_needed; slice++) {
        for (uint32_t c = 0; c < channels; c++) {
            uint64_t bits = 0;
            for (int i = 0; i < 8; i++) bits = (bits << 8) | payload[p++];
            int scalefactor = (int)((bits >> 60) & 0xf);
            bits <<= 4;
            for (int i = 0; i < QOV_QOA_SLICE_SAMPLES; i++) {
                int quantized = (int)((bits >> 61) & 0x7);
                bits <<= 3;
                int predicted = qov__qoa_lms_predict(&lms[c]);
                int dequantized = qov__qoa_dequant_tab[scalefactor][quantized];
                int reconstructed = qov__qoa_clamp16(predicted + dequantized);
                qov__qoa_lms_update(&lms[c], dequantized);
                lms[c].history[QOV_QOA_LMS_LEN - 1] = (int16_t)reconstructed;
                uint32_t idx = slice * QOV_QOA_SLICE_SAMPLES + (uint32_t)i;
                if (idx < fsamples) out[(size_t)idx * channels + c] = (int16_t)reconstructed;
            }
        }
    }
    return fsamples;
}

/* Encodes one QOA frame from interleaved s16 samples - mirrors the fixed
   src/qoa.ts QoaEncoder.encodeFrame exactly (exhaustive scalefactor search in
   ascending order, nearest-dequant quantization with strict-less tie-break). */
static size_t qov__qoa_encode_frame(const int16_t *samples, int channels, int samplerate,
                                    size_t sample_count, qov__qoa_lms *lms, uint8_t *out)
{
    size_t slices = (sample_count + QOV_QOA_SLICE_SAMPLES - 1) / QOV_QOA_SLICE_SAMPLES;
    size_t frame_size = 8 + (size_t)channels * 16 + slices * 8 * (size_t)channels;
    if (sample_count == 0 || sample_count > 0xffff || frame_size > 0xffff) return 0;

    size_t p = 0;
    out[p++] = (uint8_t)channels;
    out[p++] = (uint8_t)((samplerate >> 16) & 0xff);
    out[p++] = (uint8_t)((samplerate >> 8) & 0xff);
    out[p++] = (uint8_t)(samplerate & 0xff);
    out[p++] = (uint8_t)((sample_count >> 8) & 0xff);
    out[p++] = (uint8_t)(sample_count & 0xff);
    out[p++] = (uint8_t)((frame_size >> 8) & 0xff);
    out[p++] = (uint8_t)(frame_size & 0xff);
    for (int c = 0; c < channels; c++) {
        for (int i = 0; i < QOV_QOA_LMS_LEN; i++) {
            uint16_t h = (uint16_t)lms[c].history[i];
            out[p++] = (uint8_t)(h >> 8); out[p++] = (uint8_t)(h & 0xff);
        }
        for (int i = 0; i < QOV_QOA_LMS_LEN; i++) {
            uint16_t w = (uint16_t)lms[c].weights[i];
            out[p++] = (uint8_t)(w >> 8); out[p++] = (uint8_t)(w & 0xff);
        }
    }

    for (size_t slice_start = 0; slice_start < sample_count; slice_start += QOV_QOA_SLICE_SAMPLES) {
        size_t slice_len = sample_count - slice_start;
        if (slice_len > QOV_QOA_SLICE_SAMPLES) slice_len = QOV_QOA_SLICE_SAMPLES;
        for (int c = 0; c < channels; c++) {
            uint64_t best_error = (uint64_t)-1;
            uint64_t best_slice = 0;
            qov__qoa_lms best_lms = lms[c];

            for (int sf = 0; sf < 16; sf++) {
                qov__qoa_lms trial = lms[c];
                uint64_t current_error = 0;
                uint64_t current_slice = (uint64_t)sf << 60;

                for (size_t i = 0; i < slice_len; i++) {
                    int sample = samples[(slice_start + i) * (size_t)channels + c];
                    int predicted = qov__qoa_lms_predict(&trial);
                    int residual = sample - predicted;

                    int best_diff = 0x7fffffff, best_q = 0;
                    for (int q = 0; q < 8; q++) {
                        int diff = residual - qov__qoa_dequant_tab[sf][q];
                        if (diff < 0) diff = -diff;
                        if (diff < best_diff) { best_diff = diff; best_q = q; }
                    }
                    int dequantized = qov__qoa_dequant_tab[sf][best_q];
                    int reconstructed = qov__qoa_clamp16(predicted + dequantized);

                    int err = sample - reconstructed;
                    current_error += (uint64_t)((int64_t)err * err);
                    current_slice |= (uint64_t)best_q << ((19 - i) * 3);

                    qov__qoa_lms_update(&trial, dequantized);
                    trial.history[QOV_QOA_LMS_LEN - 1] = (int16_t)reconstructed;
                }

                if (current_error < best_error) {
                    best_error = current_error;
                    best_slice = current_slice;
                    best_lms = trial;
                }
            }

            lms[c] = best_lms;
            for (int i = 0; i < 8; i++) out[p++] = (uint8_t)(best_slice >> (56 - 8 * i));
        }
    }
    return frame_size;
}

/* ------------------------------------------------------------------ */
/* color conversion (bit-exact with src/color-utils.ts)                */
/* ------------------------------------------------------------------ */

static int qov_clamp_byte(int v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

static void qov_rgb_to_yuv_px(uint8_t r, uint8_t g, uint8_t b, int *y, int *u, int *v)
{
    *y = qov_clamp_byte(qov_round(0.299 * r + 0.587 * g + 0.114 * b));
    *u = qov_clamp_byte(qov_round(-0.169 * r - 0.331 * g + 0.500 * b + 128));
    *v = qov_clamp_byte(qov_round(0.500 * r - 0.419 * g - 0.081 * b + 128));
}

static void qov_yuv_to_rgb_px(int y, int u, int v, uint8_t *r, uint8_t *g, uint8_t *b)
{
    *r = (uint8_t)qov_clamp_byte(qov_round(y + 1.402 * (v - 128)));
    *g = (uint8_t)qov_clamp_byte(qov_round(y - 0.344 * (u - 128) - 0.714 * (v - 128)));
    *b = (uint8_t)qov_clamp_byte(qov_round(y + 1.772 * (u - 128)));
}

static uint32_t qov_chroma_w2(uint8_t cs, uint32_t w) { return (cs == QOV_CS_YUV444) ? w : (w + 1) / 2; }
static uint32_t qov_chroma_h2(uint8_t cs, uint32_t h)
{
    if (cs == QOV_CS_YUV444) return h;
    if (cs == QOV_CS_YUV422) return h;
    return (h + 1) / 2;
}

/* RGBA -> YUV planes per colorspace (yp/up/vp sized per colorspace, ap w*h) */
static void qov_rgba_to_yuv_planes(const uint8_t *px, uint32_t w, uint32_t h,
                                   uint8_t cs, uint8_t *yp, uint8_t *up, uint8_t *vp, uint8_t *ap)
{
    uint32_t uvw = qov_chroma_w2(cs, w);
    uint32_t uvh = qov_chroma_h2(cs, h);
    uint32_t blk_h = (cs == QOV_CS_YUV422) ? 1 : 2;

    for (uint32_t py = 0; py < h; py++) {
        for (uint32_t pxx = 0; pxx < w; pxx++) {
            size_t i = ((size_t)py * w + pxx) * 4;
            int y, u, v;
            qov_rgb_to_yuv_px(px[i], px[i + 1], px[i + 2], &y, &u, &v);
            yp[(size_t)py * w + pxx] = (uint8_t)y;
            if (ap) ap[(size_t)py * w + pxx] = px[i + 3];
        }
    }

    if (cs == QOV_CS_YUV444) {
        for (size_t i = 0; i < (size_t)w * h; i++) {
            int y, u, v;
            qov_rgb_to_yuv_px(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], &y, &u, &v);
            up[i] = (uint8_t)u;
            vp[i] = (uint8_t)v;
        }
        return;
    }

    for (uint32_t cy = 0; cy < uvh; cy++) {
        for (uint32_t cxx = 0; cxx < uvw; cxx++) {
            double u_sum = 0, v_sum = 0, w_sum = 0;
            for (uint32_t dy = 0; dy < blk_h; dy++) {
                for (uint32_t dx = 0; dx < 2; dx++) {
                    uint32_t sx = cxx * 2 + dx, sy = cy * blk_h + dy;
                    if (sx < w && sy < h) {
                        int y, u, v;
                        /* TS re-converts the source pixel; u/v are rounded and
                           clamped per source pixel BEFORE weighting */
                        qov_rgb_to_yuv_px(px[((size_t)sy * w + sx) * 4],
                                          px[((size_t)sy * w + sx) * 4 + 1],
                                          px[((size_t)sy * w + sx) * 4 + 2], &y, &u, &v);
                        double weight = (double)yp[(size_t)sy * w + sx] + 16.0;
                        u_sum += u * weight;
                        v_sum += v * weight;
                        w_sum += weight;
                    }
                }
            }
            size_t uv_idx = (size_t)cy * uvw + cxx;
            if (w_sum > 0) {
                up[uv_idx] = (uint8_t)qov_clamp_byte(qov_round(u_sum / w_sum));
                vp[uv_idx] = (uint8_t)qov_clamp_byte(qov_round(v_sum / w_sum));
            } else {
                up[uv_idx] = 128;
                vp[uv_idx] = 128;
            }
        }
    }
}

/* YUV planes -> RGBA per colorspace (ap may be NULL) */
static void qov_yuv_planes_to_rgba(const uint8_t *yp, const uint8_t *up, const uint8_t *vp,
                                   const uint8_t *ap, uint32_t w, uint32_t h,
                                   uint8_t cs, uint8_t *out)
{
    uint32_t uvw = qov_chroma_w2(cs, w);
    for (uint32_t py = 0; py < h; py++) {
        for (uint32_t pxx = 0; pxx < w; pxx++) {
            size_t y_idx = (size_t)py * w + pxx;
            size_t uv_idx;
            if (cs == QOV_CS_YUV444) uv_idx = y_idx;
            else if (cs == QOV_CS_YUV422) uv_idx = (size_t)py * uvw + (pxx / 2);
            else uv_idx = (size_t)(py / 2) * uvw + (pxx / 2);
            uint8_t r, g, b;
            qov_yuv_to_rgb_px(yp[y_idx], up[uv_idx], vp[uv_idx], &r, &g, &b);
            size_t o = y_idx * 4;
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
            out[o + 3] = ap ? ap[y_idx] : 255;
        }
    }
}

/* ------------------------------------------------------------------ */
/* DCT (COS table hardcoded from JS Math.cos; no libm dependency)      */
/* ------------------------------------------------------------------ */

static const double qov_cos[64] = {
    /* rows: frequency u (0..7); columns: sample x (0..7);
       qov_cos[u*8+x] = cos((2x+1) * u * PI / 16) as computed by JS Math.cos */
    1.000000000000000000, 1.000000000000000000, 1.000000000000000000, 1.000000000000000000,
    1.000000000000000000, 1.000000000000000000, 1.000000000000000000, 1.000000000000000000,
    0.980785280403230431, 0.831469612302545236, 0.555570233019602289, 0.195090322016128331,
    -0.195090322016128193, -0.555570233019601956, -0.831469612302545347, -0.980785280403230431,
    0.923879532511286738, 0.382683432365089837, -0.382683432365089726, -0.923879532511286738,
    -0.923879532511286850, -0.382683432365090337, 0.382683432365090004, 0.923879532511286516,
    0.831469612302545236, -0.195090322016128193, -0.980785280403230431, -0.555570233019602178,
    0.555570233019601845, 0.980785280403230431, 0.195090322016128775, -0.831469612302545125,
    0.707106781186547573, -0.707106781186547462, -0.707106781186547684, 0.707106781186547351,
    0.707106781186547684, -0.707106781186546685, -0.707106781186547129, 0.707106781186546574,
    0.555570233019602289, -0.980785280403230431, 0.195090322016128304, 0.831469612302545569,
    -0.831469612302545125, -0.195090322016128026, 0.980785280403230653, -0.555570233019601512,
    0.382683432365089837, -0.923879532511286850, 0.923879532511286516, -0.382683432365089893,
    -0.382683432365090559, 0.923879532511286738, -0.923879532511286405, 0.382683432365089560,
    0.195090322016128331, -0.555570233019602178, 0.831469612302545569, -0.980785280403230653,
    0.980785280403230431, -0.831469612302545014, 0.555570233019601512, -0.195090322016128581
};

static const int qov_zigzag[64] = {
    0, 1, 5, 6, 14, 15, 27, 28,
    2, 4, 7, 13, 16, 26, 29, 42,
    3, 8, 12, 17, 25, 30, 41, 43,
    9, 11, 18, 24, 31, 40, 44, 53,
    10, 19, 23, 32, 39, 45, 52, 54,
    20, 22, 33, 38, 46, 51, 55, 60,
    21, 34, 37, 47, 50, 56, 59, 61,
    35, 36, 48, 49, 57, 58, 62, 63
};

static const int qov_quant_luma[64] = {
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99
};

static const int qov_quant_chroma[64] = {
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99
};

/* ---- intra DC prediction (PR3, spec 3.4.3) ----
   Mean of the reconstructed left column / top row; integer round-half-up;
   128 when no neighbor exists. Pure integer math = bit-exact everywhere. */
static int qov__intra_pred(const uint8_t *plane, int w, int h, int x0, int y0)
{
    long lsum = 0, tsum = 0;
    int lcount = 0, tcount = 0;
    if (x0 > 0)
        for (int yy = 0; yy < 8 && y0 + yy < h; yy++) { lsum += plane[(long)(y0 + yy) * w + x0 - 1]; lcount++; }
    if (y0 > 0)
        for (int xx = 0; xx < 8 && x0 + xx < w; xx++) { tsum += plane[(long)(y0 - 1) * w + x0 + xx]; tcount++; }
    if (lcount && tcount) {
        int lm = (int)((2 * lsum + lcount) / (2 * lcount));
        int tm = (int)((2 * tsum + tcount) / (2 * tcount));
        return (lm + tm + 1) / 2;
    }
    if (lcount) return (int)((2 * lsum + lcount) / (2 * lcount));
    if (tcount) return (int)((2 * tsum + tcount) / (2 * tcount));
    return 128;
}

static void qov_forward_dct(const float *block, float *coeffs)
{
    for (int v = 0; v < 8; v++) {
        for (int u = 0; u < 8; u++) {
            double sum = 0;
            for (int y = 0; y < 8; y++)
                for (int x = 0; x < 8; x++)
                    sum += (double)block[y * 8 + x] * qov_cos[u * 8 + x] * qov_cos[v * 8 + y];
            double cu = (u == 0) ? (1.0 / 1.4142135623730951) : 1.0;
            double cv = (v == 0) ? (1.0 / 1.4142135623730951) : 1.0;
            coeffs[v * 8 + u] = (float)(0.25 * cu * cv * sum);
        }
    }
}

static void qov_inverse_dct_raw(const float *coeffs, float *block)
{
    for (int y = 0; y < 8; y++) {
        for (int x = 0; x < 8; x++) {
            double sum = 0;
            for (int v = 0; v < 8; v++)
                for (int u = 0; u < 8; u++) {
                    double cu = (u == 0) ? (1.0 / 1.4142135623730951) : 1.0;
                    double cv = (v == 0) ? (1.0 / 1.4142135623730951) : 1.0;
                    sum += cu * cv * (double)coeffs[v * 8 + u] * qov_cos[u * 8 + x] * qov_cos[v * 8 + y];
                }
            block[y * 8 + x] = (float)(0.25 * sum);
        }
    }
}

/* ------------------------------------------------------------------ */
/* motion (bit-exact port of src/motion.ts)                            */
/* ------------------------------------------------------------------ */

#define QOV_MV_BLOCK 16
#define QOV_MV_MAX 127

typedef struct {
    int block_size, grid_w, grid_h;
    int *vx, *vy;
} qov__mv;

static int qov__clampi(int v, int lo, int hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

static void qov__mv_sample(int i, int bw, int bh, int *ox, int *oy)
{
    switch (i) {
        case 0: *ox = 0; *oy = 0; break;
        case 1: *ox = bw - 1; *oy = 0; break;
        case 2: *ox = 0; *oy = bh - 1; break;
        case 3: *ox = bw - 1; *oy = bh - 1; break;
        default: *ox = bw >> 1; *oy = bh >> 1; break;
    }
}

static int qov__mv_sad_at(const uint8_t *curr, const uint8_t *prev, int w, int h,
                          int bx, int by, int bw, int bh, int dx, int dy)
{
    int sum = 0;
    for (int i = 0; i < 5; i++) {
        int ox, oy;
        qov__mv_sample(i, bw, bh, &ox, &oy);
        int pxx = qov__clampi(bx + ox, 0, w - 1);
        int pyy = qov__clampi(by + oy, 0, h - 1);
        int sx = qov__clampi(bx + ox + dx, 0, w - 1);
        int sy = qov__clampi(by + oy + dy, 0, h - 1);
        sum += abs(curr[pyy * w + pxx] - prev[sy * w + sx]);
    }
    return sum;
}

static int qov__mv_block_hash(const uint8_t *plane, int w, int bx, int by, int bw, int bh)
{
    int key = 0;
    for (int i = 0; i < 5; i++) {
        int ox, oy;
        qov__mv_sample(i, bw, bh, &ox, &oy);
        /* TS: (key*31 + px)|0 — wraps to int32 each step */
        key = (int)(int32_t)((int64_t)key * 31 + plane[(by + oy) * w + (bx + ox)]);
    }
    return key;
}

/* chained map: key -> list of block ids in row-major insertion order */
typedef struct qov__mv_entry {
    int key;
    int *ids;
    int n_ids, cap_ids;
    struct qov__mv_entry *next;
} qov__mv_entry;

typedef struct {
    qov__mv_entry **slots;
    size_t n_slots;
} qov__mv_map;

static void qov__mv_map_push(qov__mv_map *m, int key, int block_id)
{
    size_t slot = (size_t)(((uint32_t)key * 2654435769u) >> 16) & (m->n_slots - 1);
    qov__mv_entry *e = m->slots[slot];
    while (e) {
        if (e->key == key) {
            if (e->n_ids == e->cap_ids) {
                e->cap_ids = e->cap_ids ? e->cap_ids * 2 : 4;
                e->ids = (int *)qov__realloc(e->ids, sizeof(int) * (size_t)e->cap_ids);
            }
            e->ids[e->n_ids++] = block_id;
            return;
        }
        e = e->next;
    }
    e = (qov__mv_entry *)qov__malloc(sizeof(qov__mv_entry));
    e->key = key;
    e->cap_ids = 4;
    e->n_ids = 1;
    e->ids = (int *)qov__malloc(sizeof(int) * 4);
    e->ids[0] = block_id;
    e->next = m->slots[slot];
    m->slots[slot] = e;
}

static void qov__mv_map_free(qov__mv_map *m)
{
    for (size_t i = 0; i < m->n_slots; i++) {
        qov__mv_entry *e = m->slots[i];
        while (e) {
            qov__mv_entry *nx = e->next;
            qov__free(e->ids);
            qov__free(e);
            e = nx;
        }
    }
    qov__free(m->slots);
}

/* Find the entry for key (iteration order of candidates comes from the
   id list, which is row-major insertion order - same as the TS Map). */
static qov__mv_entry *qov__mv_map_find(qov__mv_map *m, int key)
{
    size_t slot = (size_t)(((uint32_t)key * 2654435769u) >> 16) & (m->n_slots - 1);
    qov__mv_entry *e = m->slots[slot];
    while (e && e->key != key) e = e->next;
    return e;
}

static qov_result qov__mv_estimate(const uint8_t *curr, const uint8_t *prev, int w, int h,
                                   int sad_skip, int use_diamond, int min_moved,
                                   qov__mv *out)
{
    int grid_w = (w + QOV_MV_BLOCK - 1) / QOV_MV_BLOCK;
    int grid_h = (h + QOV_MV_BLOCK - 1) / QOV_MV_BLOCK;
    int total = grid_w * grid_h;
    out->vx = out->vy = NULL;
    int *vx = (int *)qov__malloc(sizeof(int) * (size_t)total);
    int *vy = (int *)qov__malloc(sizeof(int) * (size_t)total);
    if (!vx || !vy) { qov__free(vx); qov__free(vy); return QOV_ERR_OOM; }
    for (int i = 0; i < total; i++) { vx[i] = 0; vy[i] = 0; }

    qov__mv_map map;
    map.n_slots = 256;
    while (map.n_slots < (size_t)total * 2) map.n_slots <<= 1;
    map.slots = (qov__mv_entry **)qov__malloc(sizeof(qov__mv_entry *) * map.n_slots);
    if (!map.slots) { qov__free(vx); qov__free(vy); return QOV_ERR_OOM; }
    for (size_t i = 0; i < map.n_slots; i++) map.slots[i] = NULL;

    for (int gbY = 0; gbY < grid_h; gbY++)
        for (int gbX = 0; gbX < grid_w; gbX++) {
            int bw = (gbX + 1) * QOV_MV_BLOCK <= w ? QOV_MV_BLOCK : w - gbX * QOV_MV_BLOCK;
            int bh = (gbY + 1) * QOV_MV_BLOCK <= h ? QOV_MV_BLOCK : h - gbY * QOV_MV_BLOCK;
            int key = qov__mv_block_hash(prev, w, gbX * QOV_MV_BLOCK, gbY * QOV_MV_BLOCK, bw, bh);
            qov__mv_map_push(&map, key, gbY * grid_w + gbX);
        }

    int moved = 0;
    for (int gbY = 0; gbY < grid_h; gbY++) {
        for (int gbX = 0; gbX < grid_w; gbX++) {
            int bx = gbX * QOV_MV_BLOCK, by = gbY * QOV_MV_BLOCK;
            int bw = (gbX + 1) * QOV_MV_BLOCK <= w ? QOV_MV_BLOCK : w - bx;
            int bh = (gbY + 1) * QOV_MV_BLOCK <= h ? QOV_MV_BLOCK : h - by;

            int sad0 = qov__mv_sad_at(curr, prev, w, h, bx, by, bw, bh, 0, 0);
            if (sad0 <= sad_skip) continue;

            int best_vx = 0, best_vy = 0, best_sad = sad0;

            int key = qov__mv_block_hash(curr, w, bx, by, bw, bh);
            qov__mv_entry *e = qov__mv_map_find(&map, key);
            if (e) {
                for (int c = 0; c < e->n_ids; c++) {
                    int cand = e->ids[c];
                    int cx = cand % grid_w, cy = cand / grid_w;
                    int dx = cx * QOV_MV_BLOCK - bx, dy = cy * QOV_MV_BLOCK - by;
                    if (dx < -QOV_MV_MAX || dx > QOV_MV_MAX || dy < -QOV_MV_MAX || dy > QOV_MV_MAX)
                        continue;
                    int s = qov__mv_sad_at(curr, prev, w, h, bx, by, bw, bh, dx, dy);
                    if (s < best_sad) { best_sad = s; best_vx = dx; best_vy = dy; }
                }
            }

            if (use_diamond && best_sad > sad_skip) {
                int base_x = best_vx, base_y = best_vy;
                for (int r = 4; r >= 2; r -= 2) {
                    for (int dy = -r; dy <= r; dy++) {
                        for (int dx = -r; dx <= r; dx++) {
                            if (abs(dx) + abs(dy) > r) continue;
                            int nvx = base_x + dx, nvy = base_y + dy;
                            if (nvx == best_vx && nvy == best_vy) continue;
                            if (nvx < -QOV_MV_MAX || nvx > QOV_MV_MAX || nvy < -QOV_MV_MAX || nvy > QOV_MV_MAX)
                                continue;
                            int s = qov__mv_sad_at(curr, prev, w, h, bx, by, bw, bh, nvx, nvy);
                            if (s < best_sad) { best_sad = s; best_vx = nvx; best_vy = nvy; }
                        }
                    }
                }
            }

            if (best_vx != 0 || best_vy != 0) {
                vx[gbY * grid_w + gbX] = best_vx;
                vy[gbY * grid_w + gbX] = best_vy;
                moved++;
            }
        }
    }

    qov__mv_map_free(&map);

    if (moved < min_moved) {
        qov__free(vx);
        qov__free(vy);
        return QOV_ERR_NO_ROOM; /* signal: no motion found */
    }
    out->block_size = QOV_MV_BLOCK;
    out->grid_w = grid_w;
    out->grid_h = grid_h;
    out->vx = vx;
    out->vy = vy;
    return QOV_OK;
}

static void qov__mv_write(const qov__mv *mv, qov__buf *b)
{
    qov__buf_u8(b, 1); /* block_size_id = 1 (16x16) */
    int last = 0;
    for (int i = 0; i < mv->grid_w * mv->grid_h; i++)
        if (mv->vx[i] != 0 || mv->vy[i] != 0) last = i;
    int count = last + 1;
    qov__buf_u16(b, (uint16_t)count);
    for (int i = 0; i < count; i++) {
        qov__buf_u8(b, (uint8_t)(mv->vx[i] & 0xff));
        qov__buf_u8(b, (uint8_t)(mv->vy[i] & 0xff));
    }
}

static void qov__mv_parse(const uint8_t *data, size_t size, size_t *pos, int width, int height,
                          qov__mv *out)
{
    uint8_t id = data[(*pos)++];
    int block_size = (id == 0) ? 8 : (id == 2) ? 32 : 16;
    int count = (int)((data[*pos] << 8) | data[*pos + 1]);
    *pos += 2;
    int grid_w = (width + block_size - 1) / block_size;
    int grid_h = (height + block_size - 1) / block_size;
    int total = grid_w * grid_h;
    out->block_size = block_size;
    out->grid_w = grid_w;
    out->grid_h = grid_h;
    out->vx = (int *)qov__malloc(sizeof(int) * (size_t)(total ? total : 1));
    out->vy = (int *)qov__malloc(sizeof(int) * (size_t)(total ? total : 1));
    for (int i = 0; i < total; i++) { out->vx[i] = 0; out->vy[i] = 0; }
    for (int i = 0; i < count && *pos + 1 < size; i++) {
        int bx = data[(*pos)++];
        int by = data[(*pos)++];
        if (i < total) {
            out->vx[i] = (int8_t)bx;
            out->vy[i] = (int8_t)by;
        }
    }
}

static void qov__mv_free(qov__mv *mv)
{
    qov__free(mv->vx);
    qov__free(mv->vy);
    mv->vx = mv->vy = NULL;
}

static void qov__mv_compensate_plane(const uint8_t *prev, int w, int h, const qov__mv *mv,
                                     uint8_t *out, int scale_x, int scale_y, int shift_x, int shift_y)
{
    int B = mv->block_size;
    int gw = (w + B - 1) / B, gh = (h + B - 1) / B;
    for (int gbY = 0; gbY < gh; gbY++) {
        for (int gbX = 0; gbX < gw; gbX++) {
            int lum_x = qov__clampi(gbX * B * scale_x / mv->block_size, 0, mv->grid_w - 1);
            int lum_y = qov__clampi(gbY * B * scale_y / mv->block_size, 0, mv->grid_h - 1);
            int li = lum_y * mv->grid_w + lum_x;
            int vx = mv->vx[li] >> shift_x, vy = mv->vy[li] >> shift_y;
            int bw = (gbX + 1) * B <= w ? B : w - gbX * B;
            int bh = (gbY + 1) * B <= h ? B : h - gbY * B;
            for (int y = 0; y < bh; y++) {
                int sy = qov__clampi(gbY * B + y + vy, 0, h - 1);
                int o_row = (gbY * B + y) * w + gbX * B;
                int s_row = sy * w;
                for (int x = 0; x < bw; x++) {
                    int sx = qov__clampi(gbX * B + x + vx, 0, w - 1);
                    out[o_row + x] = prev[s_row + sx];
                }
            }
        }
    }
}

static void qov__mv_compensate_frame(const uint8_t *prev, int w, int h, const qov__mv *mv, uint8_t *out)
{
    int B = mv->block_size;
    int gw = (w + B - 1) / B, gh = (h + B - 1) / B;
    for (int gbY = 0; gbY < gh; gbY++) {
        for (int gbX = 0; gbX < gw; gbX++) {
            int li = gbY * mv->grid_w + gbX;
            int vx = mv->vx[li], vy = mv->vy[li];
            int bw = (gbX + 1) * B <= w ? B : w - gbX * B;
            int bh = (gbY + 1) * B <= h ? B : h - gbY * B;
            for (int y = 0; y < bh; y++) {
                int sy = qov__clampi(gbY * B + y + vy, 0, h - 1);
                int o_row = ((gbY * B + y) * w + gbX * B) * 4;
                int s_row = (sy * w) * 4;
                for (int x = 0; x < bw; x++) {
                    int sx = qov__clampi(gbX * B + x + vx, 0, w - 1);
                    int o = o_row + x * 4, s = s_row + sx * 4;
                    out[o] = prev[s];
                    out[o + 1] = prev[s + 1];
                    out[o + 2] = prev[s + 2];
                    out[o + 3] = prev[s + 3];
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* decoder                                                             */
/* ------------------------------------------------------------------ */

typedef struct {
    qov_header hdr;
    const uint8_t *data;
    size_t size;
    size_t pos;
    int use32;
    int has_yuv_alpha;
    int y_size, uv_w, uv_h;
    uint8_t *prev_frame, *curr_frame; /* RGBA */
    uint8_t *prev_y, *prev_u, *prev_v, *prev_a;
    uint8_t *curr_y, *curr_u, *curr_v, *curr_a;
    uint8_t idx_r[64], idx_g[64], idx_b[64], idx_a[64];
    uint8_t p_r, p_g, p_b, p_a;
} qov__dec;

static void qov__dec_reset_rgb(qov__dec *d)
{
    for (int i = 0; i < 64; i++) { d->idx_r[i] = 0; d->idx_g[i] = 0; d->idx_b[i] = 0; d->idx_a[i] = 0; }
    d->p_r = 0; d->p_g = 0; d->p_b = 0; d->p_a = 255;
}

/* suppress -Wunused-parameter for decoders that ignore the payload length */
#define QOV__USE(x) (void)(x)

static int qov__dec_rgb_keyframe(qov__dec *d, const uint8_t *payload, size_t payload_len)
{
    uint32_t pixel_count = d->hdr.width * d->hdr.height;
    size_t data_end = payload_len - 8; /* exclude end marker */
    size_t pos = 0;
    uint32_t px = 0;

    qov__dec_reset_rgb(d);

    while (px < pixel_count && pos < data_end) {
        uint8_t b1 = payload[pos++];
        if (b1 == 0xFE) {
            d->p_r = payload[pos++];
            d->p_g = payload[pos++];
            d->p_b = payload[pos++];
        } else if (b1 == 0xFF) {
            d->p_r = payload[pos++];
            d->p_g = payload[pos++];
            d->p_b = payload[pos++];
            d->p_a = payload[pos++];
        } else if ((b1 & 0xC0) == 0x00) {
            int idx = b1 & 0x3F;
            d->p_r = d->idx_r[idx];
            d->p_g = d->idx_g[idx];
            d->p_b = d->idx_b[idx];
            d->p_a = d->idx_a[idx];
        } else if ((b1 & 0xC0) == 0x40) {
            d->p_r = (uint8_t)((d->p_r + ((b1 >> 4) & 0x03) - 2) & 0xff);
            d->p_g = (uint8_t)((d->p_g + ((b1 >> 2) & 0x03) - 2) & 0xff);
            d->p_b = (uint8_t)((d->p_b + (b1 & 0x03) - 2) & 0xff);
        } else if ((b1 & 0xC0) == 0x80) {
            uint8_t b2 = payload[pos++];
            int dg = (b1 & 0x3f) - 32;
            int dr_dg = ((b2 >> 4) & 0x0f) - 8;
            int db_dg = (b2 & 0x0f) - 8;
            d->p_r = (uint8_t)((d->p_r + dg + dr_dg) & 0xff);
            d->p_g = (uint8_t)((d->p_g + dg) & 0xff);
            d->p_b = (uint8_t)((d->p_b + dg + db_dg) & 0xff);
        } else if ((b1 & 0xC0) == 0xC0) {
            int run = (b1 & 0x3f) + 1;
            for (int i = 0; i < run && px < pixel_count; i++) {
                size_t o = (size_t)px * 4;
                d->curr_frame[o] = d->p_r;
                d->curr_frame[o + 1] = d->p_g;
                d->curr_frame[o + 2] = d->p_b;
                d->curr_frame[o + 3] = d->p_a;
                px++;
            }
            continue;
        }

        int hash = (d->p_r * 3 + d->p_g * 5 + d->p_b * 7 + d->p_a * 11) % 64;
        d->idx_r[hash] = d->p_r;
        d->idx_g[hash] = d->p_g;
        d->idx_b[hash] = d->p_b;
        d->idx_a[hash] = d->p_a;
        size_t o = (size_t)px * 4;
        d->curr_frame[o] = d->p_r;
        d->curr_frame[o + 1] = d->p_g;
        d->curr_frame[o + 2] = d->p_b;
        d->curr_frame[o + 3] = d->p_a;
        px++;
    }

    uint8_t *t = d->prev_frame; d->prev_frame = d->curr_frame; d->curr_frame = t;
    return px == pixel_count;
}

static void qov__dec_yuv_plane_keyframe(const uint8_t *payload, size_t payload_len,
                                        size_t *pos, uint8_t *plane, size_t size)
{
    QOV__USE(payload_len);
    uint8_t prev_val = 0;
    int index[64];
    for (int i = 0; i < 64; i++) index[i] = -1;
    size_t px = 0;

    while (px < size) {
        uint8_t b1 = payload[(*pos)++];
        if ((b1 & 0xC0) == 0xC0 && b1 < 0xFE) {
            int run = (b1 & 0x3f) + 1;
            for (int i = 0; i < run && px < size; i++) plane[px++] = prev_val;
        } else if ((b1 & 0xC0) == 0x00) {
            int idx = b1 & 0x3f;
            int v = index[idx];
            if (v == -1) v = 128; /* neutral fallback for uninitialized slot */
            prev_val = (uint8_t)v;
            plane[px++] = prev_val;
            index[idx] = prev_val; /* no-op on valid streams; uninit-fallback parity with TS */
        } else if ((b1 & 0xC0) == 0x40) {
            int dv = (b1 & 0x0f) - 8;
            prev_val = (uint8_t)((prev_val + dv) & 0xff);
            int idx = (prev_val * 3) % 64;
            index[idx] = prev_val;
            plane[px++] = prev_val;
        } else if ((b1 & 0xC0) == 0x80) {
            int dv = (b1 & 0x3f) - 32;
            prev_val = (uint8_t)((prev_val + dv) & 0xff);
            int idx = (prev_val * 3) % 64;
            index[idx] = prev_val;
            plane[px++] = prev_val;
        } else if (b1 == 0xFE) {
            prev_val = payload[(*pos)++];
            int idx = (prev_val * 3) % 64;
            index[idx] = prev_val;
            plane[px++] = prev_val;
        } else {
            break; /* unknown opcode */
        }
    }
}

static void qov__dec_yuv_plane_temporal(const uint8_t *payload, size_t payload_len,
                                        size_t *pos, uint8_t *plane, const uint8_t *ref, size_t size)
{
    QOV__USE(payload_len);
    int index[64];
    for (int i = 0; i < 64; i++) index[i] = -1;
    size_t px = 0;

    memcpy(plane, ref, size);

    while (px < size) {
        uint8_t b1 = payload[(*pos)++];
        if (b1 == 0x00) { /* SKIP_LONG */
            uint16_t skip = (uint16_t)((payload[*pos] << 8) | payload[*pos + 1]);
            *pos += 2;
            px += skip;
        } else if ((b1 & 0xC0) == 0xC0 && b1 < 0xFE) {
            px += (b1 & 0x3f) + 1;
        } else if ((b1 & 0xC0) == 0x00) {
            int idx = b1 & 0x3f;
            if (index[idx] == -1) plane[px++] = 128;
            else plane[px++] = (uint8_t)index[idx];
        } else if (b1 == 0x58 || b1 == 0x59) {
            int count = (b1 == 0x58) ? payload[(*pos)++] : (int)((payload[*pos] << 8) | payload[*pos + 1]);
            if (b1 == 0x59) *pos += 2; else *pos += 1;
            (void)payload[(*pos)++]; /* threshold, informational */
            for (int i = 0; i < count && px < size; i++) plane[px] = ref[px], px++;
        } else if ((b1 & 0xC0) == 0x40) {
            int dv = (b1 & 0x0f) - 8;
            plane[px] = (uint8_t)((ref[px] + dv) & 0xff);
            int idx = (plane[px] * 3) % 64;
            index[idx] = plane[px];
            px++;
        } else if ((b1 & 0xC0) == 0x80) {
            int dv = (b1 & 0x3f) - 32;
            plane[px] = (uint8_t)((ref[px] + dv) & 0xff);
            int idx = (plane[px] * 3) % 64;
            index[idx] = plane[px];
            px++;
        } else if (b1 == 0xFE) {
            plane[px] = payload[(*pos)++];
            int idx = (plane[px] * 3) % 64;
            index[idx] = plane[px];
            px++;
        } else {
            break; /* unknown opcode */
        }
    }
}

static void qov__dec_dct_block(const uint8_t *payload, size_t payload_len,
                               size_t *pos, const int *quant, uint8_t qp_base, float *out)
{
    uint8_t qp_byte = payload[(*pos)++];
    int qp_delta = (qp_byte & 0x7F) - 64;
    int final_qp = qov_clampi((int)qp_base + qp_delta, 0, 100);
    double scale = 0.1 + final_qp * 0.1;

    if (*pos + 2 > payload_len) return;
    uint16_t dc_raw = (uint16_t)((payload[*pos] << 8) | payload[*pos + 1]);
    *pos += 2;
    int dc = (dc_raw & 0x8000) ? (int)dc_raw - 65536 : (int)dc_raw;

    float coeffs[64];
    for (int i = 0; i < 64; i++) coeffs[i] = 0; /* TS: new Float32Array(64) */
    coeffs[0] = (float)(dc * (double)quant[0] * scale);

    int k = 1;
    while (k < 64 && *pos < payload_len) {
        uint8_t b1 = payload[(*pos)++];
        if (b1 == 0x00) break; /* EOB */
        if (b1 == 0xF0) { k += 16; continue; } /* zero run of 16 */

        int run = (b1 >> 4) & 0x0F;
        int size = b1 & 0x0F;
        k += run;
        if (k >= 64) break;

        int level = 0;
        if (size > 0) {
            uint32_t raw = 0;
            for (int i = 0; i < size && *pos < payload_len; i++)
                raw = (raw << 8) | payload[(*pos)++];
            int neg_bit = 1 << (size * 8 - 1);
            if (raw & (uint32_t)neg_bit) level = (int)raw - (neg_bit << 1);
            else level = (int)raw;
        }

        coeffs[qov_zigzag[k]] = (float)(level * (double)quant[qov_zigzag[k]] * scale);
        k++;
    }

    qov_inverse_dct_raw(coeffs, out);
}

static void qov__dec_plane_dct(const uint8_t *payload, size_t payload_len,
                               size_t *pos, uint8_t *plane, int w, int h,
                               const int *quant, uint8_t qp_base, uint8_t op_type)
{
    float block[64];
    int blocks_x = (w + 7) / 8, blocks_y = (h + 7) / 8;
    int block_idx = 0, total = blocks_x * blocks_y;

    while (block_idx < total && *pos < payload_len) {
        uint8_t b1 = payload[(*pos)++];
        if (b1 == 0x52 || b1 == 0x53) { /* SKIP / ZERO */
            uint8_t count = payload[(*pos)++];
            block_idx += count;
        } else if (b1 == op_type) {
            qov__dec_dct_block(payload, payload_len, pos, quant, qp_base, block);
            int bx = (block_idx % blocks_x) * 8;
            int by = (block_idx / blocks_x) * 8;
            for (int y = 0; y < 8 && by + y < h; y++)
                for (int x = 0; x < 8 && bx + x < w; x++) {
                    int idx = (by + y) * w + (bx + x);
                    /* TS adds in double (exact) then truncates via Uint8Array;
                       a float-precision add here rounds across integer
                       boundaries and diverges by 1 */
                    int val = (int)((double)plane[idx] + (double)block[y * 8 + x]);
                    plane[idx] = (uint8_t)qov_clampi(val, 0, 255);
                }
            block_idx++;
        } else {
            block_idx++; /* unexpected opcode: TS warns and advances one block */
        }
    }
}

/* ---- intra DCT plane decoder (PR3, spec 3.4.3) ----
   Raster-order reconstruction: the skip opcode fills the block with the
   DC prediction; coded blocks add the residual to it. */
static void qov__dec_plane_intra_dct(const uint8_t *payload, size_t payload_len,
                                     size_t *pos, uint8_t *plane, int w, int h,
                                     const int *quant, uint8_t qp_base, uint8_t op_type)
{
    float block[64];
    int blocks_x = (w + 7) / 8, blocks_y = (h + 7) / 8;
    int block_idx = 0, total = blocks_x * blocks_y;

    while (block_idx < total && *pos < payload_len) {
        uint8_t b1 = payload[(*pos)++];
        if (b1 == 0x52 || b1 == 0x53) { /* SKIP / ZERO: prediction-only blocks */
            uint8_t count = payload[(*pos)++];
            for (int n = 0; n < count && block_idx < total; n++, block_idx++) {
                int bx = (block_idx % blocks_x) * 8;
                int by = (block_idx / blocks_x) * 8;
                int pred = qov__intra_pred(plane, w, h, bx, by);
                for (int yy = 0; yy < 8 && by + yy < h; yy++)
                    for (int xx = 0; xx < 8 && bx + xx < w; xx++)
                        plane[(by + yy) * w + bx + xx] = (uint8_t)pred;
            }
        } else if (b1 == op_type) {
            int bx = (block_idx % blocks_x) * 8;
            int by = (block_idx / blocks_x) * 8;
            int pred = qov__intra_pred(plane, w, h, bx, by);
            qov__dec_dct_block(payload, payload_len, pos, quant, qp_base, block);
            for (int yy = 0; yy < 8 && by + yy < h; yy++)
                for (int xx = 0; xx < 8 && bx + xx < w; xx++) {
                    int idx = (by + yy) * w + bx + xx;
                    /* double-precision add then truncate, mirroring TS */
                    int val = (int)((double)pred + (double)block[yy * 8 + xx]);
                    plane[idx] = (uint8_t)qov_clampi(val, 0, 255);
                }
            block_idx++;
        } else {
            block_idx++; /* unexpected opcode: TS warns and advances one block */
        }
    }
}

static void qov__dec_rgb_pframe(qov__dec *d, const uint8_t *payload, size_t payload_len, int has_motion)
{
    uint32_t pixel_count = d->hdr.width * d->hdr.height;
    size_t data_end = payload_len - 8;
    size_t pos = 0;
    uint32_t px = 0;

    if (has_motion) {
        qov__mv mv;
        qov__mv_parse(payload, payload_len, &pos, (int)d->hdr.width, (int)d->hdr.height, &mv);
        qov__mv_compensate_frame(d->prev_frame, (int)d->hdr.width, (int)d->hdr.height, &mv, d->curr_frame);
        qov__mv_free(&mv);
    } else {
        memcpy(d->curr_frame, d->prev_frame, (size_t)pixel_count * 4);
    }

    while (px < pixel_count && pos < data_end) {
        uint8_t b1 = payload[pos++];
        if (b1 == 0x00) {
            uint16_t skip = (uint16_t)((payload[pos] << 8) | payload[pos + 1]);
            pos += 2;
            px += skip;
        } else if ((b1 & 0xC0) == 0xC0 && b1 < 0xFE) {
            px += (b1 & 0x3f) + 1;
        } else if (b1 == 0x58 || b1 == 0x59) {
            /* SKIP_SIMILAR: copies from the UNCOMPENSATED previous frame (TS quirk) */
            int count;
            if (b1 == 0x58) { count = payload[pos++]; }
            else { count = (int)((payload[pos] << 8) | payload[pos + 1]); pos += 2; }
            (void)payload[pos++]; /* threshold, informational */
            for (int i = 0; i < count && px < pixel_count; i++) {
                size_t o = (size_t)px * 4;
                d->curr_frame[o] = d->prev_frame[o];
                d->curr_frame[o + 1] = d->prev_frame[o + 1];
                d->curr_frame[o + 2] = d->prev_frame[o + 2];
                d->curr_frame[o + 3] = d->prev_frame[o + 3];
                px++;
            }
        } else if ((b1 & 0xC0) == 0x40) {
            size_t o = (size_t)px * 4;
            d->curr_frame[o] = (uint8_t)((d->curr_frame[o] + ((b1 >> 4) & 0x03) - 2) & 0xff);
            d->curr_frame[o + 1] = (uint8_t)((d->curr_frame[o + 1] + ((b1 >> 2) & 0x03) - 2) & 0xff);
            d->curr_frame[o + 2] = (uint8_t)((d->curr_frame[o + 2] + (b1 & 0x03) - 2) & 0xff);
            int hash = (d->curr_frame[o] * 3 + d->curr_frame[o + 1] * 5 +
                        d->curr_frame[o + 2] * 7 + d->curr_frame[o + 3] * 11) % 64;
            d->idx_r[hash] = d->curr_frame[o];
            d->idx_g[hash] = d->curr_frame[o + 1];
            d->idx_b[hash] = d->curr_frame[o + 2];
            d->idx_a[hash] = d->curr_frame[o + 3];
            px++;
        } else if ((b1 & 0xC0) == 0x80) {
            uint8_t b2 = payload[pos++];
            size_t o = (size_t)px * 4;
            int dg = (b1 & 0x3f) - 32;
            int dr_dg = ((b2 >> 4) & 0x0f) - 8;
            int db_dg = (b2 & 0x0f) - 8;
            d->curr_frame[o] = (uint8_t)((d->curr_frame[o] + dg + dr_dg) & 0xff);
            d->curr_frame[o + 1] = (uint8_t)((d->curr_frame[o + 1] + dg) & 0xff);
            d->curr_frame[o + 2] = (uint8_t)((d->curr_frame[o + 2] + dg + db_dg) & 0xff);
            int hash = (d->curr_frame[o] * 3 + d->curr_frame[o + 1] * 5 +
                        d->curr_frame[o + 2] * 7 + d->curr_frame[o + 3] * 11) % 64;
            d->idx_r[hash] = d->curr_frame[o];
            d->idx_g[hash] = d->curr_frame[o + 1];
            d->idx_b[hash] = d->curr_frame[o + 2];
            d->idx_a[hash] = d->curr_frame[o + 3];
            px++;
        } else if ((b1 & 0xC0) == 0x00) {
            int idx = b1 & 0x3f;
            size_t o = (size_t)px * 4;
            d->curr_frame[o] = d->idx_r[idx];
            d->curr_frame[o + 1] = d->idx_g[idx];
            d->curr_frame[o + 2] = d->idx_b[idx];
            d->curr_frame[o + 3] = d->idx_a[idx];
            px++;
        } else if (b1 == 0xFE) {
            size_t o = (size_t)px * 4;
            d->curr_frame[o] = payload[pos++];
            d->curr_frame[o + 1] = payload[pos++];
            d->curr_frame[o + 2] = payload[pos++];
            int hash = (d->curr_frame[o] * 3 + d->curr_frame[o + 1] * 5 +
                        d->curr_frame[o + 2] * 7 + d->curr_frame[o + 3] * 11) % 64;
            d->idx_r[hash] = d->curr_frame[o];
            d->idx_g[hash] = d->curr_frame[o + 1];
            d->idx_b[hash] = d->curr_frame[o + 2];
            d->idx_a[hash] = d->curr_frame[o + 3];
            px++;
        } else if (b1 == 0xFF) {
            size_t o = (size_t)px * 4;
            d->curr_frame[o] = payload[pos++];
            d->curr_frame[o + 1] = payload[pos++];
            d->curr_frame[o + 2] = payload[pos++];
            d->curr_frame[o + 3] = payload[pos++];
            int hash = (d->curr_frame[o] * 3 + d->curr_frame[o + 1] * 5 +
                        d->curr_frame[o + 2] * 7 + d->curr_frame[o + 3] * 11) % 64;
            d->idx_r[hash] = d->curr_frame[o];
            d->idx_g[hash] = d->curr_frame[o + 1];
            d->idx_b[hash] = d->curr_frame[o + 2];
            d->idx_a[hash] = d->curr_frame[o + 3];
            px++;
        }
    }

    /* swap frame buffers (mirrors TS decodePFrameDataFromBuffer) */
    {
        uint8_t *t = d->prev_frame; d->prev_frame = d->curr_frame; d->curr_frame = t;
    }
}

qov_result qov_decode_header(const uint8_t *data, size_t size, qov_header *out)
{
    if (!data || !out) return QOV_ERR_PARAM;
    if (size < 4) return QOV_ERR_TRUNCATED;
    if (data[0] != 'q' || data[1] != 'o' || data[2] != 'v' || data[3] != 'f')
        return QOV_ERR_MAGIC;
    uint8_t version = data[4];
    if (version != 1 && version != 2 && version != 3) return QOV_ERR_VERSION;

    memset(out, 0, sizeof(*out));
    out->version = version;
    out->flags = data[5];
    out->width = qov_be32(data + 6) >> 16;
    out->height = qov_be32(data + 8) >> 16;
    out->fps_num = qov_be32(data + 10) >> 16;
    out->fps_den = qov_be32(data + 12) >> 16;
    out->total_frames = qov_be32(data + 14);
    out->audio_channels = data[18];
    out->audio_rate = qov_be32(data + 19) >> 8;
    out->colorspace = data[22];
    out->lossy = (out->flags & QOV_F_LOSSY) != 0;
    out->header_size = (version == 3) ? 32 : 24;
    if (out->fps_den == 0) return QOV_ERR_HEADER;
    if (size < out->header_size) return QOV_ERR_TRUNCATED;
    if (version == 3) {
        out->quality = data[23];
        out->y_quant = data[24];
        out->uv_quant = data[25];
        out->temporal_thresh = data[26];
        out->dct_qp = data[27];
    }
    return QOV_OK;
}

struct qov_decoder {
    qov__dec d;
    int is_yuv;
    size_t pixel_bytes, uv_bytes;
    uint8_t *img_rgba;      /* reused output image buffer */
    int16_t *aud_pcm;       /* reused output audio buffer (interleaved) */
    size_t aud_cap;         /* capacity in samples (total, not per channel) */
};

qov_result qov_decoder_new(const qov_header *hdr, qov_decoder **out)
{
    if (!hdr || !out) return QOV_ERR_PARAM;
    if (hdr->width == 0 || hdr->height == 0 || hdr->fps_den == 0) return QOV_ERR_HEADER;
    *out = NULL;

    qov_decoder *dec = (qov_decoder *)qov__malloc(sizeof(qov_decoder));
    if (!dec) return QOV_ERR_OOM;
    memset(dec, 0, sizeof(*dec));

    qov__dec *d = &dec->d;
    d->hdr = *hdr;
    dec->is_yuv = hdr->colorspace >= QOV_CS_YUV420 && hdr->colorspace <= QOV_CS_YUVA420;
    d->y_size = (int)(hdr->width * hdr->height);
    d->uv_w = (int)qov_chroma_w(hdr->colorspace, hdr->width);
    d->uv_h = (int)qov_chroma_h(hdr->colorspace, hdr->height);
    d->has_yuv_alpha = (hdr->flags & QOV_F_HAS_ALPHA) != 0 ||
                       hdr->colorspace == QOV_CS_YUVA420;
    dec->uv_bytes = (size_t)d->uv_w * d->uv_h;
    dec->pixel_bytes = (size_t)hdr->width * hdr->height * 4;

    d->prev_frame = qov__u8malloc(dec->pixel_bytes);
    d->curr_frame = qov__u8malloc(dec->pixel_bytes);
    if (dec->is_yuv) {
        d->prev_y = qov__u8malloc((size_t)d->y_size);
        d->prev_u = qov__u8malloc(dec->uv_bytes);
        d->prev_v = qov__u8malloc(dec->uv_bytes);
        d->curr_y = qov__u8malloc((size_t)d->y_size);
        d->curr_u = qov__u8malloc(dec->uv_bytes);
        d->curr_v = qov__u8malloc(dec->uv_bytes);
        if (d->has_yuv_alpha) {
            d->prev_a = qov__u8malloc((size_t)d->y_size);
            d->curr_a = qov__u8malloc((size_t)d->y_size);
        }
    }
    dec->img_rgba = qov__u8malloc(dec->pixel_bytes);
    if (!d->prev_frame || !d->curr_frame || !dec->img_rgba ||
        (dec->is_yuv && (!d->prev_y || !d->prev_u || !d->prev_v || !d->curr_y || !d->curr_u || !d->curr_v ||
                        (d->has_yuv_alpha && (!d->prev_a || !d->curr_a))))) {
        qov_decoder_free(dec);
        return QOV_ERR_OOM;
    }
    qov_decoder_reset(dec);
    *out = dec;
    return QOV_OK;
}

qov_result qov_decoder_reset(qov_decoder *dec)
{
    if (!dec) return QOV_ERR_PARAM;
    qov__dec *d = &dec->d;
    memset(d->prev_frame, 0, dec->pixel_bytes);
    memset(d->curr_frame, 0, dec->pixel_bytes);
    if (dec->is_yuv) {
        memset(d->prev_y, 0, (size_t)d->y_size);
        memset(d->prev_u, 0, dec->uv_bytes);
        memset(d->prev_v, 0, dec->uv_bytes);
        memset(d->curr_y, 0, (size_t)d->y_size);
        memset(d->curr_u, 0, dec->uv_bytes);
        memset(d->curr_v, 0, dec->uv_bytes);
        if (d->has_yuv_alpha) {
            memset(d->prev_a, 0, (size_t)d->y_size);
            memset(d->curr_a, 0, (size_t)d->y_size);
        }
    }
    qov__dec_reset_rgb(d);
    return QOV_OK;
}

void qov_decoder_free(qov_decoder *dec)
{
    if (!dec) return;
    qov__dec *d = &dec->d;
    qov__free(d->prev_frame);
    qov__free(d->curr_frame);
    qov__free(d->prev_y);
    qov__free(d->prev_u);
    qov__free(d->prev_v);
    qov__free(d->prev_a);
    qov__free(d->curr_y);
    qov__free(d->curr_u);
    qov__free(d->curr_v);
    qov__free(d->curr_a);
    qov__free(dec->img_rgba);
    qov__free(dec->aud_pcm);
    qov__free(dec);
}

static qov_result qov__dec_feed(qov_decoder *dec, uint8_t ctype, uint8_t cflags,
                                const uint8_t *payload, size_t csize, uint32_t ts,
                                qov_image *out_img, qov_audio *out_aud)
{
    if (out_img) memset(out_img, 0, sizeof(*out_img));
    if (out_aud) memset(out_aud, 0, sizeof(*out_aud));
    if (ctype == 0xFF) return QOV_OK;

    qov__dec *d = &dec->d;
    qov_header *hdr = &d->hdr;
    const uint8_t *p = payload;
    size_t payload_len = csize;
    uint8_t *decomp = NULL;
    qov_result r = QOV_OK;

    if ((cflags & 0x10) && (ctype == 0x01 || ctype == 0x02 || ctype == 0x03)) {
        if (csize < 4) return QOV_ERR_TRUNCATED;
        uint32_t usz = qov_be32(p);
        decomp = qov__u8malloc(usz);
        if (!decomp) return QOV_ERR_OOM;
        r = qov__lz4_decompress(p + 4, csize - 4, decomp, usz);
        if (r != QOV_OK) { qov__free(decomp); return r; }
        payload_len = usz;
        p = decomp;
    }

    if (ctype == 0x10) {
        /* AUDIO: one or more QOA frames back to back (mirrors src/qoa.ts:
           LMS state reloads from each frame header) */
        size_t pos = 0;
        size_t total = 0;
        int channels = 0;
        while (pos + 8 <= payload_len) {
            qov__qoa_lms lms[8];
            channels = p[0];
            if (channels <= 0 || channels > 8) { r = QOV_ERR_CORRUPT; break; }
            uint32_t frame_size = ((uint32_t)p[pos + 6] << 8) | p[pos + 7];
            if (frame_size < 8 || pos + frame_size > payload_len) { r = QOV_ERR_TRUNCATED; break; }
            size_t need = total + 5120 * (size_t)channels;
            if (need > dec->aud_cap) {
                size_t ncap = dec->aud_cap ? dec->aud_cap : need;
                while (ncap < need) ncap *= 2;
                int16_t *np = (int16_t *)qov__realloc(dec->aud_pcm, ncap * sizeof(int16_t));
                if (!np) { r = QOV_ERR_OOM; break; }
                dec->aud_pcm = np;
                dec->aud_cap = ncap;
            }
            size_t got = qov__qoa_decode_frame(p + pos, payload_len - pos, lms,
                                               dec->aud_pcm + total);
            if (!got) { r = QOV_ERR_CORRUPT; break; }
            total += got * (size_t)channels;
            pos += frame_size;
        }
        if (r == QOV_OK && out_aud) {
            out_aud->samples = dec->aud_pcm;
            out_aud->sample_count = channels > 0 ? total / (size_t)channels : 0;
            out_aud->rate = hdr->audio_rate;
            out_aud->channels = (uint8_t)hdr->audio_channels;
        }
        if (decomp) qov__free(decomp);
        return r;
    }

    if (ctype == 0x01 || ctype == 0x02) {
        size_t payload_len_v = payload_len;
        int has_motion = (cflags & 0x02) != 0;

        if (dec->is_yuv) {
            size_t pos = 0;
            qov__mv mv;
            int have_mv = 0;
            if (has_motion) {
                qov__mv_parse(p, payload_len_v, &pos, (int)hdr->width, (int)hdr->height, &mv);
                have_mv = 1;
            }
            uint8_t *ref_y = d->prev_y, *ref_u = d->prev_u, *ref_v = d->prev_v, *ref_a = d->prev_a;
            uint8_t *comp_y = NULL, *comp_u = NULL, *comp_v = NULL, *comp_a = NULL;
            if (have_mv) {
                comp_y = qov__u8malloc((size_t)d->y_size);
                comp_u = qov__u8malloc(dec->uv_bytes);
                comp_v = qov__u8malloc(dec->uv_bytes);
                qov__mv_compensate_plane(d->prev_y, (int)hdr->width, (int)hdr->height, &mv, comp_y, 1, 1, 0, 0);
                qov__mv_compensate_plane(d->prev_u, d->uv_w, d->uv_h, &mv, comp_u, 2, 2, 1, 1);
                qov__mv_compensate_plane(d->prev_v, d->uv_w, d->uv_h, &mv, comp_v, 2, 2, 1, 1);
                ref_y = comp_y; ref_u = comp_u; ref_v = comp_v;
                if (d->has_yuv_alpha && d->prev_a) {
                    comp_a = qov__u8malloc((size_t)d->y_size);
                    qov__mv_compensate_plane(d->prev_a, (int)hdr->width, (int)hdr->height, &mv, comp_a, 1, 1, 0, 0);
                    ref_a = comp_a;
                }
            }
            if (ctype == 0x01 && (cflags & 0x20)) {
                /* PR3 intra DCT keyframe (spec 3.4.3) */
                uint8_t qp = hdr->dct_qp ? hdr->dct_qp : 20;
                qov__dec_plane_intra_dct(p, payload_len_v, &pos, d->curr_y, (int)hdr->width, (int)hdr->height, qov_quant_luma, qp, 0x50);
                qov__dec_plane_intra_dct(p, payload_len_v, &pos, d->curr_u, d->uv_w, d->uv_h, qov_quant_chroma, qp, 0x51);
                qov__dec_plane_intra_dct(p, payload_len_v, &pos, d->curr_v, d->uv_w, d->uv_h, qov_quant_chroma, qp, 0x51);
                if (d->has_yuv_alpha)
                    qov__dec_plane_intra_dct(p, payload_len_v, &pos, d->curr_a, (int)hdr->width, (int)hdr->height, qov_quant_luma, qp, 0x50);
            } else if (ctype == 0x01) {
                qov__dec_yuv_plane_keyframe(p, payload_len_v, &pos, d->curr_y, (size_t)d->y_size);
                qov__dec_yuv_plane_keyframe(p, payload_len_v, &pos, d->curr_u, dec->uv_bytes);
                qov__dec_yuv_plane_keyframe(p, payload_len_v, &pos, d->curr_v, dec->uv_bytes);
                if (d->has_yuv_alpha)
                    qov__dec_yuv_plane_keyframe(p, payload_len_v, &pos, d->curr_a, (size_t)d->y_size);
            } else if (cflags & 0x20) {
                /* DCT P-frame: seed from (compensated) reference, decode residuals */
                uint8_t qp = hdr->dct_qp ? hdr->dct_qp : 20;
                memcpy(d->curr_y, ref_y, (size_t)d->y_size);
                memcpy(d->curr_u, ref_u, dec->uv_bytes);
                memcpy(d->curr_v, ref_v, dec->uv_bytes);
                if (d->has_yuv_alpha && ref_a) memcpy(d->curr_a, ref_a, (size_t)d->y_size);
                qov__dec_plane_dct(p, payload_len_v, &pos, d->curr_y, (int)hdr->width, (int)hdr->height, qov_quant_luma, qp, 0x50);
                qov__dec_plane_dct(p, payload_len_v, &pos, d->curr_u, d->uv_w, d->uv_h, qov_quant_chroma, qp, 0x51);
                qov__dec_plane_dct(p, payload_len_v, &pos, d->curr_v, d->uv_w, d->uv_h, qov_quant_chroma, qp, 0x51);
                if (d->has_yuv_alpha && ref_a)
                    qov__dec_plane_dct(p, payload_len_v, &pos, d->curr_a, (int)hdr->width, (int)hdr->height, qov_quant_luma, qp, 0x50);
            } else {
                qov__dec_yuv_plane_temporal(p, payload_len_v, &pos, d->curr_y, ref_y, (size_t)d->y_size);
                qov__dec_yuv_plane_temporal(p, payload_len_v, &pos, d->curr_u, ref_u, dec->uv_bytes);
                qov__dec_yuv_plane_temporal(p, payload_len_v, &pos, d->curr_v, ref_v, dec->uv_bytes);
                if (d->has_yuv_alpha && ref_a)
                    qov__dec_yuv_plane_temporal(p, payload_len_v, &pos, d->curr_a, ref_a, (size_t)d->y_size);
            }
            if (have_mv) qov__mv_free(&mv);
            if (comp_y) qov__free(comp_y);
            if (comp_u) qov__free(comp_u);
            if (comp_v) qov__free(comp_v);
            if (comp_a) qov__free(comp_a);
        } else if (ctype == 0x01) {
            qov__dec_reset_rgb(d);
            qov__dec_rgb_keyframe(d, p, payload_len_v);
        } else {
            qov__dec_rgb_pframe(d, p, payload_len_v, has_motion);
        }

        /* swap refs (RGB decoders swap prev/curr internally) */
        if (dec->is_yuv) {
            uint8_t *t;
            t = d->prev_y; d->prev_y = d->curr_y; d->curr_y = t;
            t = d->prev_u; d->prev_u = d->curr_u; d->curr_u = t;
            t = d->prev_v; d->prev_v = d->curr_v; d->curr_v = t;
            if (d->has_yuv_alpha) {
                t = d->prev_a; d->prev_a = d->curr_a; d->curr_a = t;
            }
        }

        /* emit frame into the reused buffer */
        if (dec->is_yuv)
            qov_yuv_planes_to_rgba(d->prev_y, d->prev_u, d->prev_v,
                                   d->has_yuv_alpha ? d->prev_a : NULL,
                                   hdr->width, hdr->height, hdr->colorspace, dec->img_rgba);
        else
            memcpy(dec->img_rgba, d->prev_frame, dec->pixel_bytes);
        if (out_img) {
            out_img->rgba = dec->img_rgba;
            out_img->width = hdr->width;
            out_img->height = hdr->height;
            out_img->timestamp_us = ts;
            out_img->keyframe = (ctype == 0x01);
        }
    }
    /* SYNC(0x00), BFRAME(0x03), INDEX(0xF0), unknown: skip */

    if (decomp) qov__free(decomp);
    return r;
}

qov_result qov_decoder_feed(qov_decoder *dec, uint8_t chunk_type, uint8_t chunk_flags,
                            const uint8_t *payload, size_t size, uint32_t timestamp_us,
                            qov_image *out_img, qov_audio *out_aud)
{
    if (!dec || (!payload && size > 0)) return QOV_ERR_PARAM;
    return qov__dec_feed(dec, chunk_type, chunk_flags, payload, size, timestamp_us,
                         out_img, out_aud);
}

void qov_yuv420_to_rgba(const uint8_t *yp, const uint8_t *up, const uint8_t *vp,
                        uint32_t w, uint32_t h, uint8_t *out)
{
    qov_yuv_planes_to_rgba(yp, up, vp, NULL, w, h, QOV_CS_YUV420, out);
}

static qov_result qov__decode_impl(const uint8_t *data, size_t size,
                                   qov_image **frames_out, size_t *count_out,
                                   qov_decode_stats *stats, size_t max_frames)
{
    if (frames_out) *frames_out = NULL;
    if (count_out) *count_out = 0;
    if (stats) { stats->frame_count = 0; stats->audio_chunks = 0; }

    qov_header hdr;
    qov_result r = qov_decode_header(data, size, &hdr);
    if (r != QOV_OK) return r;

    qov_decoder *dec = NULL;
    r = qov_decoder_new(&hdr, &dec);
    if (r != QOV_OK) return r;

    qov_image *frames = NULL;
    size_t count = 0, cap = 0;
    size_t chunk_hdr = (hdr.version >= 2) ? 10 : 8;

    size_t pos = hdr.header_size;
    while (pos + chunk_hdr <= size && count < max_frames) {
        uint8_t ctype = data[pos], cflags = data[pos + 1];
        uint32_t csize = (hdr.version >= 2) ? qov_be32(data + pos + 2) : (uint32_t)((data[pos + 2] << 8) | data[pos + 3]);
        uint32_t ts = qov_be32(data + pos + ((hdr.version >= 2) ? 6 : 4));

        if (csize > size || pos + chunk_hdr + csize > size) { r = QOV_ERR_TRUNCATED; break; }
        const uint8_t *payload = data + pos + chunk_hdr;

        if (ctype == 0xFF) break;

        qov_image img;
        r = qov__dec_feed(dec, ctype, cflags, payload, csize, ts, &img, NULL);
        if (r != QOV_OK) break;
        if (ctype == 0x10 && stats) stats->audio_chunks++;

        if (ctype == 0x01 || ctype == 0x02) {
            if (count == cap) {
                size_t ncap = cap ? cap * 2 : 16;
                qov_image *nf = (qov_image *)qov__realloc(frames, sizeof(qov_image) * ncap);
                if (!nf) { r = QOV_ERR_OOM; break; }
                frames = nf;
                cap = ncap;
            }
            frames[count].rgba = qov__u8malloc(dec->pixel_bytes);
            if (!frames[count].rgba) { r = QOV_ERR_OOM; break; }
            memcpy(frames[count].rgba, img.rgba, dec->pixel_bytes);
            frames[count].width = img.width;
            frames[count].height = img.height;
            frames[count].timestamp_us = img.timestamp_us;
            frames[count].keyframe = img.keyframe;
            count++;
            if (stats) stats->frame_count = count;
        }
        pos += chunk_hdr + csize;
    }

    qov_decoder_free(dec);

    if (r != QOV_OK) {
        qov_frames_free(frames, count);
        return r;
    }
    if (frames_out) *frames_out = frames;
    else qov_frames_free(frames, count);
    if (count_out) *count_out = count;
    if (stats) stats->frame_count = count;
    return QOV_OK;
}

qov_result qov_decode_all(const uint8_t *data, size_t size,
                          qov_image **frames_out, size_t *count_out,
                          qov_decode_stats *stats)
{
    return qov__decode_impl(data, size, frames_out, count_out, stats, (size_t)-1);
}

qov_result qov_decode_first_frame(const uint8_t *data, size_t size, qov_image *out)
{
    if (!out) return QOV_ERR_PARAM;
    qov_image *frames = NULL;
    size_t count = 0;
    qov_result r = qov__decode_impl(data, size, &frames, &count, NULL, 1);
    if (r != QOV_OK) return r;
    if (count == 0) { qov__free(frames); return QOV_ERR_TRUNCATED; }
    *out = frames[0];   /* takes ownership of rgba */
    qov__free(frames);
    return QOV_OK;
}

void qov_frames_free(qov_image *frames, size_t count)
{
    if (!frames) return;
    for (size_t i = 0; i < count; i++) qov__free(frames[i].rgba);
    qov__free(frames);
}

/* ==================================================================== */
/* encoder                                                             */
/* ==================================================================== */

typedef struct { uint32_t frame, offset, ts; } qov__kf_t;

struct qov_encoder {
    qov_encode_params p;
    qov__buf out;
    qov__buf fb;
    uint8_t *prev_frame;
    uint8_t *prev_y, *prev_u, *prev_v, *prev_a;
    uint8_t cache_r[64], cache_g[64], cache_b[64], cache_a[64];
    int cache_set[64];
    uint32_t frame_count;
    int has_prev_frame;
    int is_yuv, has_alpha, lossy, use_dct;
    int y_quant, uv_quant, temporal_thresh, dct_qp;
    qov__kf_t *keyframes;
    size_t n_keyframes, key_cap;
    qov__qoa_lms qoa_lms[8];
    int has_audio;
    qov_encode_stats stats;
};

static void qov__enc_write_sync(qov_encoder *e, uint32_t frame, uint32_t ts)
{
    qov__buf_u8(&e->out, 0x00);
    qov__buf_u8(&e->out, 0);
    qov__buf_be32(&e->out, 8);
    qov__buf_be32(&e->out, ts);
    qov__buf_bytes(&e->out, (const uint8_t *)"QOVS", 4);
    qov__buf_be32(&e->out, frame);
}

static void qov__enc_write_chunk(qov_encoder *e, uint8_t type, uint8_t base_flags,
                                 uint32_t ts, const uint8_t *data, size_t len)
{
    if (e->p.lz4) {
        uint8_t *comp = NULL;
        size_t comp_len = 0;
        qov_result r = qov__lz4_compress(data, len, &comp, &comp_len);
        if (r == QOV_OK && comp) {
            qov__buf_u8(&e->out, type);
            qov__buf_u8(&e->out, (uint8_t)(base_flags | 0x10));
            qov__buf_be32(&e->out, (uint32_t)(comp_len + 4));
            qov__buf_be32(&e->out, ts);
            qov__buf_be32(&e->out, (uint32_t)len);
            qov__buf_bytes(&e->out, comp, comp_len);
            qov__free(comp);
            return;
        }
    }
    qov__buf_u8(&e->out, type);
    qov__buf_u8(&e->out, base_flags);
    qov__buf_be32(&e->out, (uint32_t)len);
    qov__buf_be32(&e->out, ts);
    qov__buf_bytes(&e->out, data, len);
}

static void qov__enc_end_marker(qov__buf *b)
{
    for (int i = 0; i < 7; i++) qov__buf_u8(b, 0);
    qov__buf_u8(b, 1);
}

qov_encoder *qov_encode_start(const qov_encode_params *params)
{
    if (!params || params->width == 0 || params->height == 0 ||
        params->fps_num == 0 || params->fps_den == 0 || params->colorspace > 0x13)
        return NULL;

    qov_encoder *e = (qov_encoder *)qov__malloc(sizeof(qov_encoder));
    if (!e) return NULL;
    memset(e, 0, sizeof(*e));
    e->p = *params;
    e->lossy = params->quality > 0 && params->quality < 100;
    e->use_dct = e->lossy;
    e->is_yuv = params->colorspace >= QOV_CS_YUV420;
    e->has_alpha = (params->has_alpha || params->colorspace == QOV_CS_YUVA420) && e->is_yuv;
    {
        int q = qov_clampi(params->quality, 0, 100);
        e->y_quant = (uint8_t)qov_clampi(1 + (100 - q) / 8, 1, 64);
        e->uv_quant = (uint8_t)qov_clampi(2 + (100 - q) / 4, 1, 64);
        e->temporal_thresh = (uint8_t)qov_clampi((100 - q) / 12, 0, 32);
        e->dct_qp = (uint8_t)qov_clampi(51 - q * 51 / 100, 0, 51);
    }

    e->prev_frame = qov__u8malloc((size_t)e->p.width * e->p.height * 4);
    if (e->is_yuv) {
        uint32_t uvw = qov_chroma_w(e->p.colorspace, e->p.width);
        uint32_t uvh = qov_chroma_h(e->p.colorspace, e->p.height);
        e->prev_y = qov__u8malloc((size_t)e->p.width * e->p.height);
        e->prev_u = qov__u8malloc((size_t)uvw * uvh);
        e->prev_v = qov__u8malloc((size_t)uvw * uvh);
        if (e->has_alpha) e->prev_a = qov__u8malloc((size_t)e->p.width * e->p.height);
    }

    /* write the 24/32-byte header */
    uint8_t version = e->lossy ? 3 : 2;
    uint8_t flags = (uint8_t)(QOV_F_HAS_INDEX | (e->p.has_alpha ? QOV_F_HAS_ALPHA : 0) |
                              (e->p.motion ? QOV_F_HAS_MOTION : 0) |
                              (e->p.intra_dct_keyframes ? QOV_F_INTRA_DCT_KF : 0));
    if (e->lossy) flags |= (uint8_t)(QOV_F_LOSSY | QOV_F_DCT);
    qov__buf_bytes(&e->out, (const uint8_t *)"qovf", 4);
    qov__buf_u8(&e->out, version);
    qov__buf_u8(&e->out, flags);
    qov__buf_be32(&e->out, ((uint32_t)e->p.width << 16) | (e->p.height & 0xFFFF));
    qov__buf_be32(&e->out, ((uint32_t)e->p.fps_num << 16) | (e->p.fps_den & 0xFFFF));
    qov__buf_be32(&e->out, 0); /* total frames, patched in finish */
    e->has_audio = e->p.audio_channels > 0 && e->p.audio_rate > 0;
    if (e->has_audio && e->p.audio_channels <= 8) {
        for (int c = 0; c < e->p.audio_channels; c++) {
            e->qoa_lms[c].weights[0] = 0;
            e->qoa_lms[c].weights[1] = 0;
            e->qoa_lms[c].weights[2] = (int16_t)-(1 << 13);
            e->qoa_lms[c].weights[3] = (int16_t)(1 << 14);
        }
    } else {
        e->has_audio = 0;
    }
    qov__buf_u8(&e->out, e->has_audio ? e->p.audio_channels : 0);
    qov__buf_u8(&e->out, e->has_audio ? (uint8_t)((e->p.audio_rate >> 16) & 0xff) : 0);
    qov__buf_u8(&e->out, e->has_audio ? (uint8_t)((e->p.audio_rate >> 8) & 0xff) : 0);
    qov__buf_u8(&e->out, e->has_audio ? (uint8_t)(e->p.audio_rate & 0xff) : 0);
    qov__buf_u8(&e->out, e->p.colorspace);
    qov__buf_u8(&e->out, e->lossy ? (uint8_t)params->quality : 0);
    if (version == 3) {
        qov__buf_u8(&e->out, e->y_quant);
        qov__buf_u8(&e->out, e->uv_quant);
        qov__buf_u8(&e->out, e->temporal_thresh);
        qov__buf_u8(&e->out, e->dct_qp);
        qov__buf_be32(&e->out, 0); /* reserved */
    }
    return e;
}

/* ---- lossy quantization helpers (mirror TS quantizePlane/quantizePixel) ---- */

static int qov__quant_plane_value(int value, int quant_step)
{
    if (quant_step <= 1) return value;
    return qov_clampi(qov_round(value / (double)quant_step) * quant_step, 0, 255);
}

static uint8_t *qov__quant_plane(uint8_t *plane, size_t size, int quant_step)
{
    if (quant_step <= 1) return plane;
    uint8_t *r = qov__u8malloc(size);
    for (size_t i = 0; i < size; i++) r[i] = (uint8_t)qov__quant_plane_value(plane[i], quant_step);
    return r;
}

/* ---- YUV keyframe plane coder ---- */
static void qov__enc_yuv_plane_keyframe(qov__buf *fb, const uint8_t *plane, size_t size)
{
    uint8_t prev_val = 0;
    int run = 0;
    int index[64];
    for (int i = 0; i < 64; i++) index[i] = -1;

    for (size_t i = 0; i < size; i++) {
        uint8_t val = plane[i];
        if (val == prev_val) {
            run++;
            if (run == 62 || i == size - 1) { qov__buf_u8(fb, (uint8_t)(0xC0 | (run - 1))); run = 0; }
            continue;
        }
        if (run > 0) { qov__buf_u8(fb, (uint8_t)(0xC0 | (run - 1))); run = 0; }

        int idx = (val * 3) % 64;
        if (index[idx] == val && i > 0) {
            qov__buf_u8(fb, (uint8_t)idx);
        } else {
            int d = val - prev_val;
            if (d >= -8 && d <= 7) qov__buf_u8(fb, (uint8_t)(0x40 | ((d + 8) & 0x0f)));
            else if (d >= -32 && d <= 31) qov__buf_u8(fb, (uint8_t)(0x80 | (d + 32)));
            else { qov__buf_u8(fb, 0xFE); qov__buf_u8(fb, val); }
        }
        index[idx] = val;
        prev_val = val;
    }
}

/* forward decl (defined with the public encoder API) */
static void qov__enc_yuv_plane_keyframe_delta(qov_encoder *e, const uint8_t *plane,
                                              const uint8_t *ref, size_t size, int thresh);
static void qov__enc_plane_intra_dct(qov_encoder *e, uint8_t *plane, int w, int h,
                                     const int *quant, uint8_t op);

/* ---- YUV keyframe ---- */
static void qov__enc_yuv_keyframe(qov_encoder *e, const uint8_t *pixels, uint32_t ts)
{
    e->fb.size = 0;
    uint32_t w = e->p.width, h = e->p.height;
    size_t y_size = (size_t)w * h;
    size_t uv_size = (size_t)qov_chroma_w(e->p.colorspace, w) * qov_chroma_h(e->p.colorspace, h);
    uint8_t *yp = qov__u8malloc(y_size);
    uint8_t *up = qov__u8malloc(uv_size);
    uint8_t *vp = qov__u8malloc(uv_size);
    uint8_t *ap = e->has_alpha ? qov__u8malloc(y_size) : NULL;

    qov_rgba_to_yuv_planes(pixels, w, h, e->p.colorspace, yp, up, vp, ap);

    if (e->lossy && e->p.intra_dct_keyframes) {
        int cw = qov_chroma_w(e->p.colorspace, w), ch = qov_chroma_h(e->p.colorspace, h);
        e->fb.size = 0;
        qov__enc_plane_intra_dct(e, yp, (int)w, (int)h, qov_quant_luma, 0x50);
        qov__enc_plane_intra_dct(e, up, cw, ch, qov_quant_chroma, 0x51);
        qov__enc_plane_intra_dct(e, vp, cw, ch, qov_quant_chroma, 0x51);
        if (ap) qov__enc_plane_intra_dct(e, ap, (int)w, (int)h, qov_quant_luma, 0x50);
        qov__enc_end_marker(&e->fb);
        qov__enc_write_chunk(e, 0x01, 0x01 | 0x20, ts, e->fb.data, e->fb.size);
        memcpy(e->prev_y, yp, y_size);
        memcpy(e->prev_u, up, uv_size);
        memcpy(e->prev_v, vp, uv_size);
        if (ap) memcpy(e->prev_a, ap, y_size);
    } else {
        if (e->lossy) {
            /* qov__quant_plane returns `plane` itself when the step is <= 1 */
            uint8_t *qy = qov__quant_plane(yp, y_size, e->y_quant);
            uint8_t *qu = qov__quant_plane(up, uv_size, e->uv_quant);
            uint8_t *qv = qov__quant_plane(vp, uv_size, e->uv_quant);
            if (qy != yp) { memcpy(yp, qy, y_size); qov__free(qy); }
            if (qu != up) { memcpy(up, qu, uv_size); qov__free(qu); }
            if (qv != vp) { memcpy(vp, qv, uv_size); qov__free(qv); }
            if (ap) {
                uint8_t *qa = qov__quant_plane(ap, y_size, e->y_quant);
                if (qa != ap) { memcpy(ap, qa, y_size); qov__free(qa); }
            }
        }
        memcpy(e->prev_y, yp, y_size);
        memcpy(e->prev_u, up, uv_size);
        memcpy(e->prev_v, vp, uv_size);
        if (ap) memcpy(e->prev_a, ap, y_size);

        e->fb.size = 0;
        qov__enc_yuv_plane_keyframe(&e->fb, yp, y_size);
        qov__enc_yuv_plane_keyframe(&e->fb, up, uv_size);
        qov__enc_yuv_plane_keyframe(&e->fb, vp, uv_size);
        if (ap) qov__enc_yuv_plane_keyframe(&e->fb, ap, y_size);
        qov__enc_end_marker(&e->fb);
        qov__enc_write_chunk(e, 0x01, 0x01, ts, e->fb.data, e->fb.size);
    }

    qov__free(yp); qov__free(up); qov__free(vp); qov__free(ap);
}

/* ---- RGB keyframe ---- */
static void qov__enc_rgb_keyframe(qov_encoder *e, const uint8_t *pixels, uint32_t ts)
{
    uint32_t pixel_count = e->p.width * e->p.height;
    e->fb.size = 0;
    /* TS resetRgbIndex: all 64 slots pre-seeded with (0,0,0,0) */
    memset(e->cache_r, 0, sizeof(e->cache_r));
    memset(e->cache_g, 0, sizeof(e->cache_g));
    memset(e->cache_b, 0, sizeof(e->cache_b));
    memset(e->cache_a, 0, sizeof(e->cache_a));

    uint8_t *quant = NULL;
    if (e->lossy) quant = qov__u8malloc(pixel_count * 4);

    uint8_t pr = 0, pg = 0, pb = 0, pa = 255;
    int run = 0;

    for (uint32_t px = 0; px < pixel_count; px++) {
        size_t o = (size_t)px * 4;
        uint8_t r = pixels[o], g = pixels[o + 1], b = pixels[o + 2], a = pixels[o + 3];
        if (e->lossy) {
            double yy = qov_floord((66.0 * r + 129.0 * g + 25.0 * b + 128.0) / 256.0) + 16;
            double cb = qov_floord((-38.0 * r - 74.0 * g + 112.0 * b + 128.0) / 256.0) + 128;
            double cr = qov_floord((112.0 * r - 94.0 * g - 18.0 * b + 128.0) / 256.0) + 128;
            yy = qov_round(yy / e->y_quant) * e->y_quant;
            cb = qov_round(cb / e->uv_quant) * e->uv_quant;
            cr = qov_round(cr / e->uv_quant) * e->uv_quant;
            double cy = yy - 16, d = cb - 128, ee = cr - 128;
            r = (uint8_t)qov_clampi((int)qov_floord((298.0 * cy + 409.0 * ee + 128.0) / 256.0), 0, 255);
            g = (uint8_t)qov_clampi((int)qov_floord((298.0 * cy - 100.0 * d - 208.0 * ee + 128.0) / 256.0), 0, 255);
            b = (uint8_t)qov_clampi((int)qov_floord((298.0 * cy + 516.0 * d + 128.0) / 256.0), 0, 255);
            quant[o] = r; quant[o + 1] = g; quant[o + 2] = b; quant[o + 3] = a;
        }

        if (r == pr && g == pg && b == pb && a == pa) {
            run++;
            if (run == 62 || px == pixel_count - 1) { qov__buf_u8(&e->fb, (uint8_t)(0xC0 | (run - 1))); run = 0; }
            continue;
        }
        if (run > 0) { qov__buf_u8(&e->fb, (uint8_t)(0xC0 | (run - 1))); run = 0; }

        int hash = (r * 3 + g * 5 + b * 7 + a * 11) % 64;
        if (e->cache_r[hash] == r && e->cache_g[hash] == g &&
            e->cache_b[hash] == b && e->cache_a[hash] == a) {
            qov__buf_u8(&e->fb, (uint8_t)hash);
        } else {
            int dr = r - pr, dg = g - pg, db = b - pb, da = a - pa;
            if (da == 0 && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
                qov__buf_u8(&e->fb, (uint8_t)(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2)));
            } else if (da == 0 && dg >= -32 && dg <= 31) {
                int dr_dg = dr - dg, db_dg = db - dg;
                if (dr_dg >= -8 && dr_dg <= 7 && db_dg >= -8 && db_dg <= 7) {
                    qov__buf_u8(&e->fb, (uint8_t)(0x80 | (dg + 32)));
                    qov__buf_u8(&e->fb, (uint8_t)(((dr_dg + 8) << 4) | (db_dg + 8)));
                } else {
                    qov__buf_u8(&e->fb, 0xFE);
                    qov__buf_u8(&e->fb, r); qov__buf_u8(&e->fb, g); qov__buf_u8(&e->fb, b);
                }
            } else if (da == 0) {
                qov__buf_u8(&e->fb, 0xFE);
                qov__buf_u8(&e->fb, r); qov__buf_u8(&e->fb, g); qov__buf_u8(&e->fb, b);
            } else {
                qov__buf_u8(&e->fb, 0xFF);
                qov__buf_u8(&e->fb, r); qov__buf_u8(&e->fb, g); qov__buf_u8(&e->fb, b); qov__buf_u8(&e->fb, a);
            }
            e->cache_r[hash] = r; e->cache_g[hash] = g; e->cache_b[hash] = b; e->cache_a[hash] = a;
        }
        pr = r; pg = g; pb = b; pa = a;
    }
    qov__enc_end_marker(&e->fb);
    qov__enc_write_chunk(e, 0x01, 0, ts, e->fb.data, e->fb.size);

    if (e->lossy && quant) memcpy(e->prev_frame, quant, pixel_count * 4);
    else memcpy(e->prev_frame, pixels, pixel_count * 4);
    qov__free(quant);
}

/* ---- RGB P-frame (motion + optional lossy quantization) ---- */
static void qov__enc_rgb_pframe(qov_encoder *e, const uint8_t *pixels, uint32_t ts)
{
    uint32_t pixel_count = e->p.width * e->p.height;
    int temporal_thresh = e->lossy ? e->temporal_thresh : 0;
    uint8_t *quant = e->lossy ? qov__u8malloc(pixel_count * 4) : NULL;
    e->fb.size = 0;

    /* motion estimation on luma vs the reference frame */
    qov__mv mv;
    int have_mv = 0;
    if (e->p.motion) {
        uint8_t *curr_luma = qov__u8malloc(pixel_count);
        uint8_t *prev_luma = qov__u8malloc(pixel_count);
        for (uint32_t i = 0; i < pixel_count; i++) {
            size_t o = (size_t)i * 4;
            curr_luma[i] = (uint8_t)((pixels[o] * 299 + pixels[o + 1] * 587 + pixels[o + 2] * 114) / 1000);
            prev_luma[i] = (uint8_t)((e->prev_frame[o] * 299 + e->prev_frame[o + 1] * 587 + e->prev_frame[o + 2] * 114) / 1000);
        }
        int min_moved = 4;
        {
            int gw = ((int)e->p.width + 15) / 16, gh = ((int)e->p.height + 15) / 16;
            int est = (int)(0.005 * gw * gh + 0.999999);
            if (est > min_moved) min_moved = est;
        }
        if (qov__mv_estimate(curr_luma, prev_luma, (int)e->p.width, (int)e->p.height,
                             temporal_thresh > 0 ? temporal_thresh * 5 : 0,
                             e->lossy, min_moved, &mv) == QOV_OK)
            have_mv = 1;
        qov__free(curr_luma);
        qov__free(prev_luma);
    }

    const uint8_t *ref = e->prev_frame;
    uint8_t *comp = NULL;
    if (have_mv) {
        comp = qov__u8malloc(pixel_count * 4);
        qov__mv_compensate_frame(e->prev_frame, (int)e->p.width, (int)e->p.height, &mv, comp);
        ref = comp;
        qov__mv_write(&mv, &e->fb);
    }

    int skip = 0;

    for (uint32_t px = 0; px < pixel_count; px++) {
        size_t o = (size_t)px * 4;
        uint8_t r = pixels[o], g = pixels[o + 1], b = pixels[o + 2], a = pixels[o + 3];
        if (e->lossy) {
            double yy = qov_floord((66.0 * r + 129.0 * g + 25.0 * b + 128.0) / 256.0) + 16;
            double cb = qov_floord((-38.0 * r - 74.0 * g + 112.0 * b + 128.0) / 256.0) + 128;
            double cr = qov_floord((112.0 * r - 94.0 * g - 18.0 * b + 128.0) / 256.0) + 128;
            yy = qov_round(yy / e->y_quant) * e->y_quant;
            cb = qov_round(cb / e->uv_quant) * e->uv_quant;
            cr = qov_round(cr / e->uv_quant) * e->uv_quant;
            double cy = yy - 16, d = cb - 128, ee = cr - 128;
            r = (uint8_t)qov_clampi((int)qov_floord((298.0 * cy + 409.0 * ee + 128.0) / 256.0), 0, 255);
            g = (uint8_t)qov_clampi((int)qov_floord((298.0 * cy - 100.0 * d - 208.0 * ee + 128.0) / 256.0), 0, 255);
            b = (uint8_t)qov_clampi((int)qov_floord((298.0 * cy + 516.0 * d + 128.0) / 256.0), 0, 255);
            quant[o] = r; quant[o + 1] = g; quant[o + 2] = b; quant[o + 3] = a;
        }

        int similar = e->lossy
            ? (abs(r - ref[o]) <= temporal_thresh &&
               abs(g - ref[o + 1]) <= temporal_thresh &&
               abs(b - ref[o + 2]) <= temporal_thresh &&
               abs(a - ref[o + 3]) <= temporal_thresh / 2)
            : (r == ref[o] && g == ref[o + 1] && b == ref[o + 2] && a == ref[o + 3]);

        if (similar) {
            /* decoder retains the compensated reference pixel on skip */
            if (quant) {
                quant[o] = ref[o]; quant[o + 1] = ref[o + 1]; quant[o + 2] = ref[o + 2]; quant[o + 3] = ref[o + 3];
            }
            skip++;
            if (skip == 62 || px == pixel_count - 1) { qov__buf_u8(&e->fb, (uint8_t)(0xC0 | (skip - 1))); skip = 0; }
            continue;
        }
        if (skip > 0) {
            if (skip <= 62) qov__buf_u8(&e->fb, (uint8_t)(0xC0 | (skip - 1)));
            else { qov__buf_u8(&e->fb, 0x00); qov__buf_u16(&e->fb, (uint16_t)skip); }
            skip = 0;
        }

        int dr = r - ref[o], dg = g - ref[o + 1], db = b - ref[o + 2], da = a - ref[o + 3];
        if (da == 0 && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
            qov__buf_u8(&e->fb, (uint8_t)(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2)));
        } else if (da == 0 && dg >= -32 && dg <= 31) {
            int dr_dg = dr - dg, db_dg = db - dg;
            if (dr_dg >= -8 && dr_dg <= 7 && db_dg >= -8 && db_dg <= 7) {
                qov__buf_u8(&e->fb, (uint8_t)(0x80 | (dg + 32)));
                qov__buf_u8(&e->fb, (uint8_t)(((dr_dg + 8) << 4) | (db_dg + 8)));
            } else {
                qov__buf_u8(&e->fb, 0xFE);
                qov__buf_u8(&e->fb, r); qov__buf_u8(&e->fb, g); qov__buf_u8(&e->fb, b);
            }
        } else if (da == 0) {
            qov__buf_u8(&e->fb, 0xFE);
            qov__buf_u8(&e->fb, r); qov__buf_u8(&e->fb, g); qov__buf_u8(&e->fb, b);
        } else {
            qov__buf_u8(&e->fb, 0xFF);
            qov__buf_u8(&e->fb, r); qov__buf_u8(&e->fb, g); qov__buf_u8(&e->fb, b); qov__buf_u8(&e->fb, a);
        }
    }
    qov__enc_end_marker(&e->fb);
    qov__enc_write_chunk(e, 0x02, have_mv ? 0x02 : 0, ts, e->fb.data, e->fb.size);

    if (e->lossy && quant) memcpy(e->prev_frame, quant, pixel_count * 4);
    else memcpy(e->prev_frame, pixels, pixel_count * 4);
    qov__free(quant);
    qov__free(comp);
    if (have_mv) qov__mv_free(&mv);
}

/* ---- generic DCT plane encoder (P-frame residuals vs reference) ---- */
static void qov__enc_plane_dct(qov_encoder *e, const uint8_t *curr, const uint8_t *ref,
                               uint8_t *next, int w, int h, const int *quant, uint8_t op)
{
    uint8_t qp = (uint8_t)e->dct_qp;
    double scale = 1.0 / (0.1 + qp * 0.1);
    int blocks_x = (w + 7) / 8, blocks_y = (h + 7) / 8;
    int skip = 0;
    for (int byi = 0; byi < blocks_y; byi++) {
        for (int bxi = 0; bxi < blocks_x; bxi++) {
            float res[64];
            double diff = 0;
            for (int yy = 0; yy < 8; yy++)
                for (int xx = 0; xx < 8; xx++) {
                    int pxx = bxi * 8 + xx, pyy = byi * 8 + yy;
                    if (pxx >= w || pyy >= h) { res[yy * 8 + xx] = 0; continue; }
                    int rr = curr[pyy * w + pxx] - ref[pyy * w + pxx];
                    res[yy * 8 + xx] = (float)rr;
                    diff += (rr < 0 ? -rr : rr);
                }
            if (diff < 32 + e->dct_qp * 8) {
                for (int yy = 0; yy < 8; yy++)
                    for (int xx = 0; xx < 8; xx++) {
                        int pxx = bxi * 8 + xx, pyy = byi * 8 + yy;
                        if (pxx < w && pyy < h) next[pyy * w + pxx] = ref[pyy * w + pxx];
                    }
                skip++;
                continue;
            }
            e->stats.blocks_skip += (uint64_t)skip;
            while (skip > 0) {
                uint8_t n = (uint8_t)(skip > 255 ? 255 : skip);
                qov__buf_u8(&e->fb, 0x52); qov__buf_u8(&e->fb, n);
                skip -= n;
            }
            float coeffs[64], rec[64];
            qov_forward_dct(res, coeffs);
            qov__buf_u8(&e->fb, op);
            e->stats.blocks_coded++;
            qov__buf_u8(&e->fb, 0x40);
            int dc = qov_round((double)coeffs[0] * scale / quant[0]);
            qov__buf_u16(&e->fb, (uint16_t)((uint16_t)dc & 0xffff));
            int zero_run = 0;
            for (int k = 1; k < 64; k++) {
                int zz = qov_zigzag[k];
                double prod = (double)coeffs[zz] * scale / quant[zz];
                /* AC dead-zone (spec 3.4.2): suppress |level| < 0.75 to kill
                   noise dithering between 0 and +/-1 */
                int qv = (prod > -0.75 && prod < 0.75) ? 0 : qov_round(prod);
                if (qv == 0) { zero_run++; continue; }
                while (zero_run >= 16) { qov__buf_u8(&e->fb, 0xF0); zero_run -= 16; }
                int size = (qv >= -128 && qv <= 127) ? 1 : (qv >= -32768 && qv <= 32767) ? 2
                         : (qv >= -8388608 && qv <= 8388607) ? 3 : 4;
                qov__buf_u8(&e->fb, (uint8_t)((zero_run << 4) | size));
                for (int sh = size - 1; sh >= 0; sh--)
                    qov__buf_u8(&e->fb, (uint8_t)((qv >> (8 * sh)) & 0xff));
                zero_run = 0;
            }
            qov__buf_u8(&e->fb, 0x00);
            rec[0] = (float)(qov_round((double)coeffs[0] * scale / quant[0]) * quant[0] / scale);
            for (int k = 1; k < 64; k++) {
                int zz = qov_zigzag[k];
                double prod = (double)coeffs[zz] * scale / quant[zz];
                int rq = (prod > -0.75 && prod < 0.75) ? 0 : qov_round(prod);
                rec[zz] = (float)(rq * quant[zz] / scale);
            }
            float idct[64];
            qov_inverse_dct_raw(rec, idct);
            for (int yy = 0; yy < 8; yy++)
                for (int xx = 0; xx < 8; xx++) {
                    int pxx = bxi * 8 + xx, pyy = byi * 8 + yy;
                    if (pxx >= w || pyy >= h) continue;
                    int idx = pyy * w + pxx;
                    int val = (int)(ref[idx] + idct[yy * 8 + xx]);
                    next[idx] = (uint8_t)qov_clampi(val, 0, 255);
                }
        }
    }
    e->stats.blocks_skip += (uint64_t)skip;
    while (skip > 0) {
        uint8_t n = (uint8_t)(skip > 255 ? 255 : skip);
        qov__buf_u8(&e->fb, 0x52); qov__buf_u8(&e->fb, n);
        skip -= n;
    }
}

/* ---- intra DCT plane encoder (PR3: DC-predicted keyframe blocks) ----
   Codes the plane as 8x8 intra blocks; the plane buffer doubles as the
   reconstruction reference and ends up holding the decoded values. */
static void qov__enc_plane_intra_dct(qov_encoder *e, uint8_t *plane, int w, int h,
                                     const int *quant, uint8_t op)
{
    uint8_t qp = (uint8_t)e->dct_qp;
    double scale = 1.0 / (0.1 + qp * 0.1);
    int blocks_x = (w + 7) / 8, blocks_y = (h + 7) / 8;
    int skip = 0;
    for (int byi = 0; byi < blocks_y; byi++) {
        for (int bxi = 0; bxi < blocks_x; bxi++) {
            int x0 = bxi * 8, y0 = byi * 8;
            int pred = qov__intra_pred(plane, w, h, x0, y0);
            float res[64];
            int diff = 0;
            for (int yy = 0; yy < 8; yy++)
                for (int xx = 0; xx < 8; xx++) {
                    int pxx = x0 + xx, pyy = y0 + yy;
                    if (pxx >= w || pyy >= h) { res[yy * 8 + xx] = 0; continue; }
                    int rr = plane[pyy * w + pxx] - pred;
                    res[yy * 8 + xx] = (float)rr;
                    diff += (rr < 0 ? -rr : rr);
                }
            if (diff < 32 + e->dct_qp * 8) {
                for (int yy = 0; yy < 8; yy++)
                    for (int xx = 0; xx < 8; xx++) {
                        int pxx = x0 + xx, pyy = y0 + yy;
                        if (pxx < w && pyy < h)
                            plane[pyy * w + pxx] = (uint8_t)qov_clampi(pred, 0, 255);
                    }
                skip++;
                e->stats.blocks_skip++;
                continue;
            }
            e->stats.blocks_skip += (uint64_t)skip;
            while (skip > 0) {
                uint8_t n = (uint8_t)(skip > 255 ? 255 : skip);
                qov__buf_u8(&e->fb, 0x52); qov__buf_u8(&e->fb, n);
                skip -= n;
            }
            float coeffs[64], rec[64], idct[64];
            qov_forward_dct(res, coeffs);
            qov__buf_u8(&e->fb, op);
            e->stats.blocks_coded++;
            qov__buf_u8(&e->fb, 0x40);
            int dc = qov_round((double)coeffs[0] * scale / quant[0]);
            qov__buf_u16(&e->fb, (uint16_t)((uint16_t)dc & 0xffff));
            int zero_run = 0;
            for (int k = 1; k < 64; k++) {
                int zz = qov_zigzag[k];
                double prod = (double)coeffs[zz] * scale / quant[zz];
                int qv = (prod > -0.75 && prod < 0.75) ? 0 : qov_round(prod);
                if (qv == 0) { zero_run++; continue; }
                while (zero_run >= 16) { qov__buf_u8(&e->fb, 0xF0); zero_run -= 16; }
                int size = (qv >= -128 && qv <= 127) ? 1 : (qv >= -32768 && qv <= 32767) ? 2
                         : (qv >= -8388608 && qv <= 8388607) ? 3 : 4;
                qov__buf_u8(&e->fb, (uint8_t)((zero_run << 4) | size));
                for (int sh = size - 1; sh >= 0; sh--)
                    qov__buf_u8(&e->fb, (uint8_t)((qv >> (8 * sh)) & 0xff));
                zero_run = 0;
            }
            qov__buf_u8(&e->fb, 0x00);
            rec[0] = (float)(dc * quant[0] / scale);
            for (int k = 1; k < 64; k++) {
                int zz = qov_zigzag[k];
                double prod = (double)coeffs[zz] * scale / quant[zz];
                int rq = (prod > -0.75 && prod < 0.75) ? 0 : qov_round(prod);
                rec[zz] = (float)(rq * quant[zz] / scale);
            }
            qov_inverse_dct_raw(rec, idct);
            for (int yy = 0; yy < 8; yy++)
                for (int xx = 0; xx < 8; xx++) {
                    int pxx = x0 + xx, pyy = y0 + yy;
                    if (pxx >= w || pyy >= h) continue;
                    int val = (int)((double)pred + (double)idct[yy * 8 + xx]);
                    plane[pyy * w + pxx] = (uint8_t)qov_clampi(val, 0, 255);
                }
        }
    }
    e->stats.blocks_skip += (uint64_t)skip;
    while (skip > 0) {
        uint8_t n = (uint8_t)(skip > 255 ? 255 : skip);
        qov__buf_u8(&e->fb, 0x52); qov__buf_u8(&e->fb, n);
        skip -= n;
    }
}

/* ---- YUV P-frame (motion + quantized DCT/DPCM) ---- */
static void qov__enc_yuv_pframe(qov_encoder *e, const uint8_t *pixels, uint32_t ts)
{
    uint32_t w = e->p.width, h = e->p.height;
    size_t y_size = (size_t)w * h;
    size_t uv_size = (size_t)qov_chroma_w(e->p.colorspace, w) * qov_chroma_h(e->p.colorspace, h);
    uint8_t *yp = qov__u8malloc(y_size);
    uint8_t *up = qov__u8malloc(uv_size);
    uint8_t *vp = qov__u8malloc(uv_size);
    uint8_t *ap = e->has_alpha ? qov__u8malloc(y_size) : NULL;

    qov_rgba_to_yuv_planes(pixels, w, h, e->p.colorspace, yp, up, vp, ap);

    if (e->lossy) {
        /* qov__quant_plane returns `plane` itself when the step is <= 1 */
        uint8_t *qy = qov__quant_plane(yp, y_size, e->y_quant);
        uint8_t *qu = qov__quant_plane(up, uv_size, e->uv_quant);
        uint8_t *qv = qov__quant_plane(vp, uv_size, e->uv_quant);
        if (qy != yp) { memcpy(yp, qy, y_size); qov__free(qy); }
        if (qu != up) { memcpy(up, qu, uv_size); qov__free(qu); }
        if (qv != vp) { memcpy(vp, qv, uv_size); qov__free(qv); }
        if (ap) {
            uint8_t *qa = qov__quant_plane(ap, y_size, e->y_quant);
            if (qa != ap) { memcpy(ap, qa, y_size); qov__free(qa); }
        }
    }

    qov__mv mv;
    int have_mv = 0;
    if (e->p.motion) {
        int min_moved = 4;
        {
            int gw = ((int)w + 15) / 16, gh = ((int)h + 15) / 16;
            int est = (int)(0.005 * gw * gh + 0.999999);
            if (est > min_moved) min_moved = est;
        }
        int tt = e->lossy ? e->temporal_thresh : 0;
        if (qov__mv_estimate(yp, e->prev_y, (int)w, (int)h,
                             tt > 0 ? tt * 5 : 0, e->lossy, min_moved, &mv) == QOV_OK)
            have_mv = 1;
    }

    const uint8_t *ref_y = e->prev_y, *ref_u = e->prev_u, *ref_v = e->prev_v, *ref_a = e->prev_a;
    uint8_t *comp_y = NULL, *comp_u = NULL, *comp_v = NULL, *comp_a = NULL;
    if (have_mv) {
        int sx = 2, sy = 2, shx = 1, shy = 1;
        if (e->p.colorspace == QOV_CS_YUV422) { sx = 2; sy = 1; shx = 1; shy = 0; }
        else if (e->p.colorspace == QOV_CS_YUV444) { sx = 1; sy = 1; shx = 0; shy = 0; }
        uint32_t uvw = qov_chroma_w(e->p.colorspace, w), uvh = qov_chroma_h(e->p.colorspace, h);
        comp_y = qov__u8malloc(y_size);
        comp_u = qov__u8malloc(uv_size);
        comp_v = qov__u8malloc(uv_size);
        qov__mv_compensate_plane(e->prev_y, (int)w, (int)h, &mv, comp_y, 1, 1, 0, 0);
        qov__mv_compensate_plane(e->prev_u, (int)uvw, (int)uvh, &mv, comp_u, sx, sy, shx, shy);
        qov__mv_compensate_plane(e->prev_v, (int)uvw, (int)uvh, &mv, comp_v, sx, sy, shx, shy);
        ref_y = comp_y; ref_u = comp_u; ref_v = comp_v;
        if (ap && e->prev_a) {
            comp_a = qov__u8malloc(y_size);
            qov__mv_compensate_plane(e->prev_a, (int)w, (int)h, &mv, comp_a, 1, 1, 0, 0);
            ref_a = comp_a;
        }
    }

    e->fb.size = 0;
    if (have_mv) qov__mv_write(&mv, &e->fb);

    uint8_t flags = (uint8_t)(0x01 | (have_mv ? 0x02 : 0));
    if (e->use_dct) {
        flags |= 0x20;
        uint8_t *next_y = qov__u8malloc(y_size);
        uint8_t *next_u = qov__u8malloc(uv_size);
        uint8_t *next_v = qov__u8malloc(uv_size);
        memcpy(next_y, ref_y, y_size);
        memcpy(next_u, ref_u, uv_size);
        memcpy(next_v, ref_v, uv_size);
        uint32_t uvw = qov_chroma_w(e->p.colorspace, w), uvh = qov_chroma_h(e->p.colorspace, h);
        qov__enc_plane_dct(e, yp, ref_y, next_y, (int)w, (int)h, qov_quant_luma, 0x50);
        qov__enc_plane_dct(e, up, ref_u, next_u, (int)uvw, (int)uvh, qov_quant_chroma, 0x51);
        qov__enc_plane_dct(e, vp, ref_v, next_v, (int)uvw, (int)uvh, qov_quant_chroma, 0x51);
        if (ap && ref_a) {
            uint8_t *next_a = qov__u8malloc(y_size);
            memcpy(next_a, ref_a, y_size);
            qov__enc_plane_dct(e, ap, ref_a, next_a, (int)w, (int)h, qov_quant_luma, 0x50);
            memcpy(e->prev_a, next_a, y_size);
            qov__free(next_a);
        }
        memcpy(e->prev_y, next_y, y_size);
        memcpy(e->prev_u, next_u, uv_size);
        memcpy(e->prev_v, next_v, uv_size);
        qov__free(next_y); qov__free(next_u); qov__free(next_v);
    } else {
        /* lossless DPCM: SKIP only when byte-equal */
        qov__enc_yuv_plane_keyframe_delta(e, yp, ref_y, y_size, 0);
        qov__enc_yuv_plane_keyframe_delta(e, up, ref_u, uv_size, 0);
        qov__enc_yuv_plane_keyframe_delta(e, vp, ref_v, uv_size, 0);
        if (ap) qov__enc_yuv_plane_keyframe_delta(e, ap, ref_a, y_size, 0);
        memcpy(e->prev_y, yp, y_size);
        memcpy(e->prev_u, up, uv_size);
        memcpy(e->prev_v, vp, uv_size);
        if (ap) memcpy(e->prev_a, ap, y_size);
    }
    qov__enc_end_marker(&e->fb);
    qov__enc_write_chunk(e, 0x02, flags, ts, e->fb.data, e->fb.size);

    qov__free(yp); qov__free(up); qov__free(vp); qov__free(ap);
    if (have_mv) qov__mv_free(&mv);
    qov__free(comp_y); qov__free(comp_u); qov__free(comp_v); qov__free(comp_a);
}

/* ---- YUV temporal plane coder (P-frame DPCM): mirrors TS encodeYuvPlanePFrame ---- */
static void qov__enc_yuv_plane_keyframe_delta(qov_encoder *e, const uint8_t *plane,
                                              const uint8_t *ref, size_t size, int thresh)
{
    qov__buf *fb = &e->fb;
    size_t skip = 0;
    int index[64];
    for (int i = 0; i < 64; i++) index[i] = -1;

    for (size_t i = 0; i < size; i++) {
        int val = plane[i];
        int ref_val = ref[i];

        int similar = thresh > 0
            ? ((val - ref_val < 0 ? ref_val - val : val - ref_val) <= thresh)
            : (val == ref_val);
        if (similar) {
            skip++;
            if (skip == 62 || i == size - 1) { qov__buf_u8(fb, (uint8_t)(0xC0 | (skip - 1))); skip = 0; }
            continue;
        }
        if (skip > 0) {
            if (skip <= 62) qov__buf_u8(fb, (uint8_t)(0xC0 | (skip - 1)));
            else { qov__buf_u8(fb, 0x00); qov__buf_u16(fb, (uint16_t)skip); }
            skip = 0;
        }

        int d = val - ref_val;
        int idx = (val * 3) % 64;
        if (d >= -8 && d <= 7) {
            /* TDIFF */
            qov__buf_u8(fb, (uint8_t)(0x40 | ((d + 8) & 0x0f)));
            index[idx] = val;
        } else if (d >= -32 && d <= 31) {
            /* TLUMA */
            qov__buf_u8(fb, (uint8_t)(0x80 | (d + 32)));
            index[idx] = val;
        } else if (index[idx] == val && idx != 0) {
            /* INDEX (0 unusable: 0x00 is SKIP_LONG) */
            qov__buf_u8(fb, (uint8_t)idx);
        } else {
            /* FULL */
            qov__buf_u8(fb, 0xFE);
            qov__buf_u8(fb, (uint8_t)val);
            index[idx] = val;
        }
    }
    if (skip > 0) {
        if (skip <= 62) qov__buf_u8(fb, (uint8_t)(0xC0 | (skip - 1)));
        else { qov__buf_u8(fb, 0x00); qov__buf_u16(fb, (uint16_t)skip); }
    }
}

/* ---- public encoder API ---- */
static qov_result qov__kf_record(qov_encoder *e, uint32_t frame, uint32_t ts)
{
    if (e->n_keyframes == e->key_cap) {
        size_t nc = e->key_cap ? e->key_cap * 2 : 16;
        void *nk = qov__realloc(e->keyframes, nc * sizeof(*e->keyframes));
        if (!nk) return QOV_ERR_OOM;
        e->keyframes = (qov__kf_t *)nk;
        e->key_cap = nc;
    }
    e->keyframes[e->n_keyframes].frame = frame;
    e->keyframes[e->n_keyframes].offset = (uint32_t)e->out.size; /* points at the SYNC chunk */
    e->keyframes[e->n_keyframes].ts = ts;
    e->n_keyframes++;
    return QOV_OK;
}

qov_result qov_encode_keyframe(qov_encoder *e, const uint8_t *rgba, uint64_t timestamp_us)
{
    if (!e || !rgba) return QOV_ERR_PARAM;
    e->stats.frames_key++;
    uint32_t ts = (uint32_t)timestamp_us;
    uint32_t frame = e->frame_count++;
    qov_result r = qov__kf_record(e, frame, ts);
    if (r != QOV_OK) return r;
    qov__enc_write_sync(e, frame, ts);
    if (e->is_yuv) qov__enc_yuv_keyframe(e, rgba, ts);
    else qov__enc_rgb_keyframe(e, rgba, ts);
    e->has_prev_frame = 1;
    return QOV_OK;
}

qov_result qov_encode_pframe(qov_encoder *e, const uint8_t *rgba, uint64_t timestamp_us)
{
    if (!e || !rgba) return QOV_ERR_PARAM;
    if (!e->has_prev_frame) return qov_encode_keyframe(e, rgba, timestamp_us);
    e->stats.frames_p++;
    uint32_t ts = (uint32_t)timestamp_us;
    e->frame_count++;
    if (e->is_yuv) qov__enc_yuv_pframe(e, rgba, ts);
    else qov__enc_rgb_pframe(e, rgba, ts);
    return QOV_OK;
}

qov_result qov_encode_audio(qov_encoder *e, const int16_t *samples,
                            size_t total_samples, uint64_t timestamp_us)
{
    if (!e || !samples) return QOV_ERR_PARAM;
    if (!e->has_audio) return QOV_ERR_PARAM;
    int ch = e->p.audio_channels;
    size_t per_ch = total_samples / (size_t)ch;
    if (per_ch == 0 || per_ch > 0xffff || per_ch * (size_t)ch != total_samples)
        return QOV_ERR_PARAM;

    uint8_t buf[8 + 8 * 16 + QOV_QOA_SLICES_PER_FRAME * 8 * 8];
    size_t frame_len = qov__qoa_encode_frame(samples, ch, (int)e->p.audio_rate,
                                             per_ch, e->qoa_lms, buf);
    if (frame_len == 0) return QOV_ERR_PARAM;

    /* mirrors src/qov-encoder.ts encodeAudio: AUDIO chunks are never compressed */
    uint32_t ts = (uint32_t)timestamp_us;
    qov__buf_u8(&e->out, 0x10);
    qov__buf_u8(&e->out, 0);
    qov__buf_be32(&e->out, (uint32_t)frame_len);
    qov__buf_be32(&e->out, ts);
    qov__buf_bytes(&e->out, buf, frame_len);
    return QOV_OK;
}

qov_result qov_encoder_take_chunks(qov_encoder *e, uint8_t **data_out, size_t *size_out)
{
    if (!e || !data_out || !size_out) return QOV_ERR_PARAM;
    *data_out = NULL;
    *size_out = 0;
    size_t hdr_size = e->lossy ? 32 : 24;
    if (e->out.size <= hdr_size) return QOV_OK;

    size_t chunk_len = e->out.size - hdr_size;
    uint8_t *chunks = qov__u8malloc(chunk_len);
    if (!chunks) return QOV_ERR_OOM;
    memcpy(chunks, e->out.data + hdr_size, chunk_len);
    memmove(e->out.data, e->out.data + hdr_size, hdr_size);
    e->out.size = hdr_size;
    *data_out = chunks;
    *size_out = chunk_len;
    return QOV_OK;
}

qov_result qov_encode_finish(qov_encoder *e, uint8_t **data_out, size_t *size_out)
{
    if (!e || !data_out || !size_out) {
        qov_encoder_free(e);
        return QOV_ERR_PARAM;
    }

    /* index table (HAS_INDEX is always set by qov_encode_start) */
    if (e->n_keyframes > 0) {
        qov__buf_u8(&e->out, 0xF0);
        qov__buf_u8(&e->out, 0);
        qov__buf_be32(&e->out, (uint32_t)(4 + e->n_keyframes * 16));
        qov__buf_be32(&e->out, 0);
        qov__buf_be32(&e->out, (uint32_t)e->n_keyframes);
        for (size_t i = 0; i < e->n_keyframes; i++) {
            qov__buf_be32(&e->out, e->keyframes[i].frame);
            qov__buf_be32(&e->out, 0);
            qov__buf_be32(&e->out, e->keyframes[i].offset);
            qov__buf_be32(&e->out, e->keyframes[i].ts);
        }
    }

    /* END chunk + end pattern */
    qov__buf_u8(&e->out, 0xFF);
    qov__buf_u8(&e->out, 0);
    qov__buf_be32(&e->out, 0);
    qov__buf_be32(&e->out, 0);
    qov__enc_end_marker(&e->out);

    /* patch total frames in the header */
    qov__buf_patch_be32(&e->out, 14, e->frame_count);

    *data_out = e->out.data; /* ownership moves to the caller */
    *size_out = e->out.size;
    e->out.data = NULL;
    e->out.size = 0;
    e->out.cap = 0;
    qov_encoder_free(e);
    return QOV_OK;
}

void qov_encode_get_stats(const qov_encoder *e, qov_encode_stats *out)
{
    if (!out) return;
    if (e) { *out = e->stats; return; }
    out->frames_key = 0; out->frames_p = 0;
    out->blocks_skip = 0; out->blocks_coded = 0;
}

void qov_encoder_free(qov_encoder *e)
{
    if (!e) return;
    qov__free(e->out.data);
    qov__free(e->fb.data);
    qov__free(e->prev_frame);
    qov__free(e->prev_y);
    qov__free(e->prev_u);
    qov__free(e->prev_v);
    qov__free(e->prev_a);
    qov__free(e->keyframes);
    qov__free(e);
}

#endif /* QOV_IMPLEMENTATION */

#ifdef __cplusplus
}
#endif

#endif /* QOV_H */
