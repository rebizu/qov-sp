/* prof.c — P-frame byte attribution profile (exploration scratch) */
#define QOV_IMPLEMENTATION
#include "qov_prof.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

int main(int argc, char **argv)
{
    if (argc < 5) { fprintf(stderr, "args: W H FPS TOTAL [quality]\n"); return 1; }
    int W = atoi(argv[1]), H = atoi(argv[2]);
    int fps = atoi(argv[3]);
    long total = atol(argv[4]);
    int quality = argc > 5 ? atoi(argv[5]) : 60;

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

    qov_encoder *e = qov_encode_start(&p);
    if (!e) { fprintf(stderr, "encode_start failed\n"); return 1; }
    qov_set_quality(e, quality);

    uint8_t *frame = malloc((size_t)W * H * 4);
    long n = 0;
    while (n < total && fread(frame, 1, (size_t)W * H * 4, stdin) == (size_t)W * H * 4) {
        uint32_t ts = (uint32_t)((double)n * 1e6 / fps + 0.5);
        qov_result r = (n % 120 == 0) ? qov_encode_keyframe(e, frame, ts)
                                      : qov_encode_pframe(e, frame, ts);
        if (r != QOV_OK) { fprintf(stderr, "encode frame %ld failed %d\n", n, r); return 1; }
        n++;
    }

    static const char *names[PF_CAT] = { "other", "band", "mv", "skiprun", "op",
        "qp_delta", "dc", "ac_run", "ac_level", "eob", "endmark" };
    double tot_bits = 0;
    for (int c = 0; c < PF_CAT; c++) tot_bits += g_bits[c];
    double pf = g_pf_chunks ? (double)g_pf_chunks : 1.0;
    printf("== P-frame payload attribution (%ld P-frames, q%d) ==\n", g_pf_chunks, quality);
    printf("raw payload: %.0f B/frame   rc-coded: %.1f B/frame   (kf rc: %.1f B/kf)\n",
           g_pf_raw_bytes / pf, g_pf_rc_bytes / pf, g_kf_rc_bytes / 6.0);
    printf("%-9s %12s %8s %12s %8s\n", "cat", "raw B/f", "raw%", "rc B/f", "rc%");
    for (int c = 0; c < PF_CAT; c++) {
        if (g_raw[c] == 0 && g_bits[c] == 0) continue;
        printf("%-9s %12.1f %7.1f%% %12.2f %7.1f%%\n", names[c],
               g_raw[c] / pf, 100.0 * g_raw[c] / g_pf_raw_bytes,
               g_bits[c] / 8.0 / pf, 100.0 * g_bits[c] / tot_bits);
    }
    printf("rc ideal total: %.1f B/f (vs actual %.1f B/f)\n",
           tot_bits / 8.0 / pf, g_pf_rc_bytes / pf);
    printf("\n== coded-block coefficient stats ==\n");
    printf("blocks %ld  dc-only %ld (%.1f%%)  nonzero ACs %ld (%.2f/block, |1|: %.1f%%)\n",
           g_blocks, g_dconly, 100.0 * g_dconly / g_blocks, g_acs,
           (double)g_acs / g_blocks, 100.0 * g_ac_mag1 / g_acs);
    printf("dc: zero %ld (%.1f%%)  fits s8 %ld (%.1f%%)  needs u16 %ld\n",
           g_dc_zero, 100.0 * g_dc_zero / g_blocks, g_dc_small,
           100.0 * g_dc_small / g_blocks, g_dc_big);
    printf("levels: %ldb %ldb %ldb %ldb   paired-with-run %ld\n",
           g_lv_size1, g_lv_size2, g_lv_size3, g_lv_size4, g_runbytes);
    return 0;
}
