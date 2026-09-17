/* bench_rc.c — BANDWIDTH-EXPLORATION §1: rate-control probe.
 *
 * Fork of bench_stream.c (measurement harness, not codec code). Adds:
 *   argv[12] target_kbps (0 = off, static quality)
 *   argv[13] controller mode: 1 = integral (±1 per 6 frames on cumulative
 *            budget drift), 2 = step ladder (±10 per 24 frames — the demo
 *            adaptation policy's cadence)
 * Quality rides the shipped v3.6 mid-stream API (qov_set_quality). The
 * controller sees only past emitted bytes — no lookahead.
 * stderr gains a 5th field: the working quality at encode time.
 */
#define QOV_IMPLEMENTATION
#include "qov.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

int main(int argc, char **argv)
{
    if (argc < 5) { fprintf(stderr, "args: W H FPS TOTAL [AUDIO_RATE AUDIO_CH "
                            "QUALITY RANGE MOTION REFRESH STRUCTURED "
                            "TARGET_KBPS MODE]\n"); return 1; }
    int W = atoi(argv[1]), H = atoi(argv[2]);
    int fps = atoi(argv[3]);
    long total = atol(argv[4]);
    int audio_rate = argc > 5 ? atoi(argv[5]) : 0;
    int audio_ch = argc > 6 ? atoi(argv[6]) : 0;
    int quality = argc > 7 ? atoi(argv[7]) : 60;
    int range = argc > 8 ? atoi(argv[8]) : 0;
    int motion = argc > 9 ? atoi(argv[9]) : 1;
    int refresh = argc > 10 ? atoi(argv[10]) : 1;
    int structured = argc > 11 ? atoi(argv[11]) : 0;
    int target = argc > 12 ? atoi(argv[12]) : 0;   /* kbps; 0 = static */
    int mode = argc > 13 ? atoi(argv[13]) : 1;     /* 1 integral, 2 step */

    qov_encode_params p;
    memset(&p, 0, sizeof p);
    p.width = (uint32_t)W; p.height = (uint32_t)H;
    p.fps_num = (uint32_t)fps; p.fps_den = 1;
    p.colorspace = QOV_CS_YUV420;
    p.motion = motion;
    p.intra_dct_keyframes = 1;
    p.intra_refresh = refresh;
    p.lz4 = 1;
    p.quality = quality;
    p.audio_channels = (uint8_t)audio_ch;
    p.audio_rate = (uint32_t)audio_rate;
    p.range_coding = range;
    p.pframe_structured = structured;

    qov_encoder *e = qov_encode_start(&p);
    if (!e) { fprintf(stderr, "encode_start failed\n"); return 1; }
    if (qov_set_quality(e, quality) != QOV_OK) { fprintf(stderr, "set_quality failed\n"); return 1; }

    double tbpf = target > 0 ? (double)target * 1000.0 / 8.0 / fps : 0.0;
    int q = quality, qmin = 25, qmax = 85;
    long cum = 0;

    uint8_t *frame = malloc((size_t)W * H * 4);
    long n = 0;
    long tot_v = 0, tot_a = 0, tot_s = 0;
    int16_t asamples[256 * 8];
    long audio_frames_done = 0;
    while (n < total && fread(frame, 1, (size_t)W * H * 4, stdin) == (size_t)W * H * 4) {
        uint32_t ts = (uint32_t)((double)n * 1e6 / fps + 0.5);
        qov_result r = (n % 120 == 0) ? qov_encode_keyframe(e, frame, ts)
                                      : qov_encode_pframe(e, frame, ts);
        if (r != QOV_OK) { fprintf(stderr, "encode frame %ld failed %d\n", n, r); return 1; }

        long abytes = 0;
        if (audio_ch > 0) {
            long should = (long)floor(((double)n + 1.0) * audio_rate / 256.0 / fps);
            while (audio_frames_done < should) {
                for (int i = 0; i < 256; i++) {
                    long gi = audio_frames_done * 256 + i;
                    double v = floor(sin((2.0 * 3.14159265358979323846 * 440.0 * gi) / (double)audio_rate) * 16000.0 + 0.5);
                    int16_t smp = (int16_t)(v < -32768.0 ? -32768 : (v > 32767.0 ? 32767 : v));
                    for (int c = 0; c < audio_ch; c++) asamples[i * audio_ch + c] = smp;
                }
                uint32_t ats = (uint32_t)((double)audio_frames_done * 256.0 / audio_rate * 1e6 + 0.5);
                if (qov_encode_audio(e, asamples, (size_t)256 * audio_ch, ats) != QOV_OK) {
                    fprintf(stderr, "audio %ld failed\n", audio_frames_done); return 1;
                }
                audio_frames_done++;
            }
        }

        uint8_t *chunks; size_t clen;
        if (qov_encoder_take_chunks(e, &chunks, &clen) != QOV_OK) {
            fprintf(stderr, "take_chunks failed\n"); return 1;
        }
        size_t pos = 0;
        long vbytes = 0, sbytes = 0;
        while (pos + 10 <= clen) {
            uint8_t t = chunks[pos];
            uint32_t sz = ((uint32_t)chunks[pos+2]<<24)|((uint32_t)chunks[pos+3]<<16)|((uint32_t)chunks[pos+4]<<8)|chunks[pos+5];
            if (pos + 10 + sz > clen) break;
            if (t == 0x10) abytes += 10 + sz;
            else if (t == 0x00) sbytes += 10 + sz;
            else vbytes += 10 + sz;
            pos += 10 + sz;
        }
        tot_v += vbytes; tot_a += abytes; tot_s += sbytes;
        fprintf(stderr, "%ld %ld %ld %ld %d\n", n, vbytes, abytes, sbytes, q);

        /* controller: cumulative-budget integral (or ladder-step) action */
        if (target > 0) {
            cum += vbytes;
            if (n > 12 && (n % (mode == 2 ? 24 : 6)) == 0) {
                double expected = tbpf * (double)(n + 1);
                double drift = ((double)cum - expected) / (double)(n + 1);
                double band = tbpf * 0.05;
                int step = (mode == 2) ? 10 : 1;
                if (drift > band && q > qmin) {
                    q -= step; if (q < qmin) q = qmin;
                    qov_set_quality(e, q);
                } else if (drift < -band && q < qmax) {
                    q += step; if (q > qmax) q = qmax;
                    qov_set_quality(e, q);
                }
            }
        }

        fwrite(chunks, 1, clen, stdout);
        free(chunks);
        n++;
    }

    uint8_t *head; size_t hlen;
    if (qov_encode_finish(e, &head, &hlen) != QOV_OK) { fprintf(stderr, "finish failed\n"); return 1; }
    fwrite(head, 1, hlen, stdout);
    free(head);
    fprintf(stderr, "DONE frames=%ld video=%ld audio=%ld sync=%ld\n", n, tot_v, tot_a, tot_s);
    return 0;
}
