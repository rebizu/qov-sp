/* bench_speed.c — encode/decode fps, C reference, single thread.
 * Measures qov_encode_* over a raw RGBA input and qov_decoder_feed over the
 * produced stream at the call settings (320x240@24, yuv420, q60, motion +
 * intra-DCT keyframes + intra refresh, range coder, mono 16 kHz speech),
 * best of 3 runs, v1 grammar vs structured P-frames (argv[3]).
 *
 * Usage:
 *   gcc -O2 -std=c99 -w -ffp-contract=off -I.. -o .build/bench_speed bench_speed.c -lm
 *   ffmpeg -t 30 -i corpus-real/cam720.mkv -vf scale=320:240 -r 24 \
 *          -f rawvideo -pix_fmt rgba .build-tmp/cam720_320x240.raw
 *   .build/bench_speed .build-tmp/cam720_320x240.raw 720 0   # v1
 *   .build/bench_speed .build-tmp/cam720_320x240.raw 720 1   # structured (v3.9)
 *
 * The two runs share one harness, so the pair is the apples-to-apples
 * comparison; absolute numbers include per-frame chunk extraction in the
 * timed encode loop and are therefore slightly below the older section-2
 * rows taken with a different harness.
 */
#define _POSIX_C_SOURCE 200809L
#define QOV_IMPLEMENTATION
#include "../qov.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

static double now_s(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

static uint64_t checksum(const uint8_t *d, size_t n)
{
    uint64_t h = 1469598103934665603ull;
    for (size_t i = 0; i < n; i++) { h ^= d[i]; h *= 1099511628211ull; }
    return h;
}

int main(int argc, char **argv)
{
    if (argc < 3) { fprintf(stderr, "args: raw_file total_frames [structured]\n"); return 1; }
    FILE *f = fopen(argv[1], "rb");
    long total = atol(argv[2]);
    int structured = argc > 3 ? atoi(argv[3]) : 0;

    qov_encode_params p;
    memset(&p, 0, sizeof p);
    p.width = 320; p.height = 240;
    p.fps_num = 24; p.fps_den = 1;
    p.colorspace = QOV_CS_YUV420;
    p.motion = 1;
    p.intra_dct_keyframes = 1;
    p.intra_refresh = 1;
    p.lz4 = 1;
    p.quality = 60;
    p.range_coding = 1;
    p.pframe_structured = structured;
    p.audio_channels = 1;
    p.audio_rate = 16000;

    uint8_t *raw = malloc((size_t)320 * 240 * 4 * total);
    if (fread(raw, (size_t)320 * 240 * 4, total, f) != (size_t)total) { fprintf(stderr, "raw short\n"); return 1; }
    fclose(f);

    int16_t asamples[256];
    uint8_t *out = NULL; size_t out_cap = 0, out_len = 0;
    double best_enc = 1e9;
    for (int rep = 0; rep < 3; rep++) {
        qov_encoder *e = qov_encode_start(&p);
        qov_set_quality(e, 60);
        long audio_done = 0;
        double t0 = now_s();
        for (long n = 0; n < total; n++) {
            uint32_t ts = (uint32_t)((double)n * 1e6 / 24.0 + 0.5);
            qov_result r = (n % 120 == 0) ? qov_encode_keyframe(e, raw + (size_t)n * 320 * 240 * 4, ts)
                                          : qov_encode_pframe(e, raw + (size_t)n * 320 * 240 * 4, ts);
            if (r != QOV_OK) { fprintf(stderr, "enc fail\n"); return 1; }
            long should = (long)(((double)n + 1.0) * 16000.0 / 256.0 / 24.0);
            while (audio_done < should) {
                for (int i = 0; i < 256; i++)
                    asamples[i] = (int16_t)(16000.0 * ((audio_done * 256 + i) % 32 < 16 ? 0.4 : -0.4));
                if (qov_encode_audio(e, asamples, 256, (uint32_t)(audio_done * 16000.0 / 256.0 * 1e6)) != QOV_OK) return 1;
                audio_done++;
            }
            uint8_t *chunks; size_t clen;
            qov_encoder_take_chunks(e, &chunks, &clen);
            if (out_len + clen > out_cap) { out_cap = (out_len + clen) * 2; out = realloc(out, out_cap); }
            memcpy(out + out_len, chunks, clen); out_len += clen;
            free(chunks);
        }
        double t1 = now_s();
        if (t1 - t0 < best_enc) best_enc = t1 - t0;
        qov_encoder_free(e);
        if (rep == 2) { /* keep the last stream for decode */ }
    }

    /* rebuild a full stream once for decode timing */
    qov_encoder *e = qov_encode_start(&p);
    qov_set_quality(e, 60);
    uint8_t *stream = NULL; size_t slen = 0, scap = 0;
    long audio_done = 0;
    for (long n = 0; n < total; n++) {
        uint32_t ts = (uint32_t)((double)n * 1e6 / 24.0 + 0.5);
        if (n % 120 == 0) qov_encode_keyframe(e, raw + (size_t)n * 320 * 240 * 4, ts);
        else qov_encode_pframe(e, raw + (size_t)n * 320 * 240 * 4, ts);
        long should = (long)(((double)n + 1.0) * 16000.0 / 256.0 / 24.0);
        while (audio_done < should) {
            for (int i = 0; i < 256; i++)
                asamples[i] = (int16_t)(16000.0 * ((audio_done * 256 + i) % 32 < 16 ? 0.4 : -0.4));
            qov_encode_audio(e, asamples, 256, (uint32_t)(audio_done * 16000.0 / 256.0 * 1e6));
            audio_done++;
        }
        uint8_t *chunks; size_t clen;
        qov_encoder_take_chunks(e, &chunks, &clen);
        if (slen + clen > scap) { scap = (slen + clen) * 2; stream = realloc(stream, scap); }
        memcpy(stream + slen, chunks, clen); slen += clen;
        free(chunks);
    }
    uint8_t *head; size_t hlen;
    qov_encode_finish(e, &head, &hlen);
    qov_decoder *dec = NULL;
    qov_header hdr;
    qov_decode_header(head, hlen, &hdr);
    qov_decoder_new(&hdr, &dec);

    double best_dec = 1e9;
    uint64_t sink = 0;
    long frames = 0;
    for (int rep = 0; rep < 3; rep++) {
        double t0 = now_s();
        size_t pos = 0;
        frames = 0;
        while (pos + 10 <= slen) {
            uint8_t type = stream[pos], flags = stream[pos + 1];
            uint32_t size = ((uint32_t)stream[pos+2]<<24)|((uint32_t)stream[pos+3]<<16)|((uint32_t)stream[pos+4]<<8)|stream[pos+5];
            uint32_t ts = ((uint32_t)stream[pos+6]<<24)|((uint32_t)stream[pos+7]<<16)|((uint32_t)stream[pos+8]<<8)|stream[pos+9];
            if (type == 0x01 || type == 0x02) {
                qov_image img;
                if (qov_decoder_feed(dec, type, flags, stream + pos + 10, size, ts, &img, NULL) != QOV_OK) { fprintf(stderr, "dec fail\n"); return 1; }
                sink ^= checksum(img.rgba, (size_t)img.width * img.height * 4);
                frames++;
            } else if (type == 0x10) {
                sink ^= size; /* audio chunks: skipped content, counted */
            }
            pos += 10 + size;
        }
        double t1 = now_s();
        if (t1 - t0 < best_dec) best_dec = t1 - t0;
    }
    printf("%s: encode %.1f fps  decode %.1f fps  (%ld frames, stream %.1f MB) sink=%llx\n",
           structured ? "structured" : "v1        ",
           total / best_enc, frames / best_dec, frames, slen / 1e6, (unsigned long long)sink);
    return 0;
}
