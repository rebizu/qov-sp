/* bench_stream.c — Phase 3 bandwidth benchmark (measurement harness, not
 * codec code).
 *
 * Reads raw RGBA frames from stdin (ffmpeg: cam720 -> 320x240@24 rgba) and
 * encodes them exactly like the call demo does (yuv420, q60 via
 * qov_set_quality, motion + intra-DCT keyframes + intra refresh, LZ4,
 * keyframe every 120). Writes a valid QOV *stream* to stdout (header + the
 * per-frame chunks taken with qov_encoder_take_chunks + index/END tail) and
 * one "frame vbytes abytes sbytes" line per frame to stderr so the QOV-S
 * wire overhead can be computed from the real chunk size distribution.
 *
 * Usage:
 *   gcc -O2 -std=c99 -w -ffp-contract=off -I.. -o .build/bench_stream bench_stream.c -lm
 *   ffmpeg -t 30 -i corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
 *          -f rawvideo -pix_fmt rgba - | .build/bench_stream 320 240 24 720 16000 1 \
 *          > parts.bin 2> stats.txt
 *   python3 bench_bandwidth.py parts.bin stats.txt 24 30 16000 1
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
    if (argc < 5) { fprintf(stderr, "args: W H FPS TOTAL [AUDIO_RATE AUDIO_CH]\n"); return 1; }
    int W = atoi(argv[1]), H = atoi(argv[2]);
    int fps = atoi(argv[3]);
    long total = atol(argv[4]);
    int audio_rate = argc > 5 ? atoi(argv[5]) : 0;
    int audio_ch = argc > 6 ? atoi(argv[6]) : 0;
    int quality = argc > 7 ? atoi(argv[7]) : 60;

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
    p.audio_channels = (uint8_t)audio_ch;
    p.audio_rate = (uint32_t)audio_rate;

    qov_encoder *e = qov_encode_start(&p);
    if (!e) { fprintf(stderr, "encode_start failed\n"); return 1; }
    if (qov_set_quality(e, quality) != QOV_OK) { fprintf(stderr, "set_quality failed\n"); return 1; }

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

        /* audio follows its own sample clock (rate/256 chunks per second),
           matching the demo capture path — not one chunk per video frame */
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
        /* per-type accounting over the chunk stream */
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
        fprintf(stderr, "%ld %ld %ld %ld\n", n, vbytes, abytes, sbytes);
        fwrite(chunks, 1, clen, stdout);
        free(chunks);
        n++;
    }

    /* tail: finish's buffer is header(32) + index + END; stdout so far is
       [chunks], so append header then index+END -> the caller reassembles
       header + chunks + tail (layout documented in the bench script) */
    uint8_t *head; size_t hlen;
    if (qov_encode_finish(e, &head, &hlen) != QOV_OK) { fprintf(stderr, "finish failed\n"); return 1; }
    fwrite(head, 1, hlen, stdout);
    free(head);
    fprintf(stderr, "DONE frames=%ld video=%ld audio=%ld sync=%ld\n", n, tot_v, tot_a, tot_s);
    return 0;
}
