/* v2prof.c — structured P-frame (flag 0x04) exploration: size + roundtrip */
#define QOV_IMPLEMENTATION
#include "qov_v2.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

static uint32_t fnv(const uint8_t *d, size_t n)
{
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < n; i++) { h ^= d[i]; h *= 16777619u; }
    return h;
}

typedef struct {
    long pf_count, pf_bytes;
    uint32_t *hashes;
    long frames;
} pass_out;

static int run_pass(int v2, int eg, const uint8_t *raw, long total, int W, int H, int fps,
                    int quality, pass_out *out)
{
    qov_encode_params p;
    memset(&p, 0, sizeof p);
    p.width = (uint32_t)W; p.height = (uint32_t)H;
    p.fps_num = (uint32_t)fps; p.fps_den = 1;
    p.colorspace = QOV_CS_YUV420;
    p.motion = 1;
    p.intra_dct_keyframes = 1;
    p.intra_refresh = 1;
    p.lz4 = 1;
    p.quality = quality;
    p.range_coding = 1;
    p.pframe_v2 = v2;
    p.exp_golomb = eg;

    qov_encoder *e = qov_encode_start(&p);
    if (!e) { fprintf(stderr, "encode_start failed\n"); return 1; }
    qov_set_quality(e, quality);

    qov_header hdr;
    memset(&hdr, 0, sizeof hdr);
    hdr.version = 3;
    hdr.colorspace = QOV_CS_YUV420;
    hdr.width = (uint32_t)W; hdr.height = (uint32_t)H;
    hdr.fps_num = (uint32_t)fps; hdr.fps_den = 1;
    hdr.lossy = 1;
    hdr.quality = (uint8_t)quality;
    hdr.y_quant = (uint8_t)(1 + (100 - quality) / 8);
    hdr.uv_quant = (uint8_t)(2 + (100 - quality) / 4);
    hdr.dct_qp = (uint8_t)(51 - quality * 51 / 100);
    hdr.header_size = 32;
    qov_decoder *dec = NULL;
    if (qov_decoder_new(&hdr, &dec) != QOV_OK) { fprintf(stderr, "decoder_new failed\n"); return 1; }

    out->hashes = malloc(sizeof(uint32_t) * (size_t)total);
    out->frames = 0;
    out->pf_count = 0; out->pf_bytes = 0;

    size_t fsize = (size_t)W * H * 4;
    for (long n = 0; n < total; n++) {
        const uint8_t *frame = raw + (size_t)n * fsize;
        uint32_t ts = (uint32_t)((double)n * 1e6 / fps + 0.5);
        qov_result r = (n % 120 == 0) ? qov_encode_keyframe(e, frame, ts)
                                      : qov_encode_pframe(e, frame, ts);
        if (r != QOV_OK) { fprintf(stderr, "encode %ld failed %d\n", n, r); return 1; }
        uint8_t *chunks = NULL; size_t clen = 0;
        qov_encoder_take_chunks(e, &chunks, &clen);
        size_t o = 0;
        int got_img = 0;
        while (o + 10 <= clen) {
            uint8_t type = chunks[o], flags = chunks[o + 1];
            uint32_t size = ((uint32_t)chunks[o + 2] << 24) | ((uint32_t)chunks[o + 3] << 16) |
                            ((uint32_t)chunks[o + 4] << 8) | chunks[o + 5];
            uint32_t cts = ((uint32_t)chunks[o + 6] << 24) | ((uint32_t)chunks[o + 7] << 16) |
                           ((uint32_t)chunks[o + 8] << 8) | chunks[o + 9];
            if (o + 10 + size > clen) { fprintf(stderr, "chunk walk overrun\n"); return 1; }
            if (type == 0x01 || type == 0x02) {
                if (type == 0x02) { out->pf_count++; out->pf_bytes += (long)size; }
                qov_image img;
                qov_result dr = qov_decoder_feed(dec, type, flags, chunks + o + 10, size, cts, &img, NULL);
                if (dr != QOV_OK) { fprintf(stderr, "decode frame %ld failed %d\n", n, dr); return 1; }
                if (type == 0x01 || !got_img) {
                    out->hashes[n] = fnv(img.rgba, (size_t)img.width * img.height * 4);
                    got_img = 1;
                }
            }
            o += 10 + size;
        }
        free(chunks);
        out->frames++;
    }
    qov_decoder_free(dec);
    qov_encoder_free(e);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 5) { fprintf(stderr, "args: W H FPS TOTAL [quality]\n"); return 1; }
    int W = atoi(argv[1]), H = atoi(argv[2]);
    int fps = atoi(argv[3]);
    long total = atol(argv[4]);
    int quality = argc > 5 ? atoi(argv[5]) : 60;
    int eg = argc > 6 ? atoi(argv[6]) : 0;

    size_t fsize = (size_t)W * H * 4;
    uint8_t *raw = malloc(fsize * (size_t)total);
    long got = 0;
    while (got < total && fread(raw + (size_t)got * fsize, 1, fsize, stdin) == fsize) got++;
    if (got < total) { fprintf(stderr, "only %ld frames on stdin\n", got); total = got; }

    pass_out v1, v2;
    if (run_pass(0, eg, raw, total, W, H, fps, quality, &v1)) return 1;
    memset(g_bits, 0, sizeof g_bits); memset(g_raw, 0, sizeof g_raw);
    g_pf_chunks = g_pf_rc_bytes = g_pf_raw_bytes = g_kf_rc_bytes = 0;
    if (run_pass(1, eg, raw, total, W, H, fps, quality, &v2)) return 1;

    long p1 = v1.pf_count ? v1.pf_count : 1;
    long p2 = v2.pf_count ? v2.pf_count : 1;
    double b1 = (double)v1.pf_bytes / p1, b2 = (double)v2.pf_bytes / p2;
    printf("P-frames: %ld / %ld\n", v1.pf_count, v2.pf_count);
    printf("v1 P-frame chunk bytes: %.1f B/f\n", b1);
    printf("v2 P-frame chunk bytes: %.1f B/f   (%+.1f%%)\n", b2, (b2 / b1 - 1) * 100.0);
    int mism = 0;
    for (long n = 0; n < total; n++)
        if (v1.hashes[n] != v2.hashes[n]) {
            if (mism < 5) fprintf(stderr, "frame %ld differs (h1=%08x h2=%08x)\n",
                                  n, v1.hashes[n], v2.hashes[n]);
            mism++;
        }
    printf("PIXELS: %s (%ld/%ld frames differ)\n", mism ? "MISMATCH" : "IDENTICAL", mism, total);
    {
        double pc = v2.pf_count ? (double)v2.pf_count : 1.0;
        if (!eg) printf("\nv2 raw composition (B/frame): chain %.1f  qp %.1f  dc %.1f  acrun %.1f  lev %.1f  eob %.1f\n",
               g2_chain / pc, g2_qp / pc, g2_dc / pc, g2_acrun / pc, g2_lev / pc, g2_eob / pc);
    }

    /* attribution of the v2 pass */
    static const char *names[PF_CAT] = { "other", "band", "mv", "skiprun", "op",
        "qp_delta", "dc", "ac_run", "ac_level", "eob", "endmark" };
    double tot_bits = 0;
    for (int c = 0; c < PF_CAT; c++) tot_bits += g_bits[c];
    printf("\nv2 rc attribution (B/frame of payload):\n");
    for (int c = 0; c < PF_CAT; c++)
        if (g_raw[c]) printf("  %-9s raw %7.1f  rc %7.2f (%4.1f%%)\n", names[c],
                             g_raw[c] / (double)v2.pf_count, g_bits[c] / 8.0 / v2.pf_count,
                             100.0 * g_bits[c] / tot_bits);
    return mism ? 2 : 0;
}
