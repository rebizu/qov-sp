/* qov_bench - Phase 0 scoreboard harness over the qov.h single-header codec.
 *
 *   qov_bench encode --w W --h H --frames N --quality Q [--fps F] [--kf K]
 *                    [--motion] [--lz4] [--cs yuv420|srgb]
 *                    --in <raw.rgba|-> --out <file.qov>
 *   qov_bench decode --in <file.qov> [--rawout <file|->]
 *
 * encode reads N frames of packed RGBA (w*h*4 bytes each, ffmpeg
 * `-f rawvideo -pix_fmt rgba` compatible) from --in ("-" = stdin), times
 * each qov_encode_keyframe/pframe call and prints one JSON line:
 *   {"mode":"encode","frames":N,"encodeMs":..,"msPerFrame":..,
 *    "bytes":..,"stats":{"framesKey":..,"framesP":..,
 *    "blocksSkip":..,"blocksCoded":..}}
 *
 * decode walks the chunk stream through the incremental decoder (only
 * video chunks are timed; no full-file frame buffering), optionally
 * writes the decoded RGBA frames sequentially to --rawout ("-" = stdout):
 *   {"mode":"decode","frames":N,"decodeMs":..,"msPerFrame":..}
 */
#define QOV_IMPLEMENTATION
#include "../qov.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <io.h>
#include <fcntl.h>
static void set_binary_stdio(void)
{
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
}
typedef LARGE_INTEGER qovbench_time;
static qovbench_time now(void)
{
    qovbench_time t;
    QueryPerformanceCounter(&t);
    return t;
}
static double elapsed_ms(qovbench_time a, qovbench_time b)
{
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return (double)(b.QuadPart - a.QuadPart) * 1000.0 / (double)f.QuadPart;
}
#else
#include <time.h>
typedef struct timespec qovbench_time;
static void set_binary_stdio(void) {}
static qovbench_time now(void)
{
    qovbench_time t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t;
}
static double elapsed_ms(qovbench_time a, qovbench_time b)
{
    return (double)(b.tv_sec - a.tv_sec) * 1000.0 +
           (double)(b.tv_nsec - a.tv_nsec) / 1e6;
}
#endif

static void *xread_all(FILE *f, size_t n)
{
    uint8_t *buf = (uint8_t *)malloc(n ? n : 1);
    if (!buf) return NULL;
    if (fread(buf, 1, n, f) != n) {
        free(buf);
        return NULL;
    }
    return buf;
}

static int arg_int(int argc, char **argv, const char *name, int def)
{
    for (int i = 1; i + 1 < argc; i++)
        if (strcmp(argv[i], name) == 0) return atoi(argv[i + 1]);
    return def;
}

static const char *arg_str(int argc, char **argv, const char *name, const char *def)
{
    for (int i = 1; i + 1 < argc; i++)
        if (strcmp(argv[i], name) == 0) return argv[i + 1];
    return def;
}

static int arg_flag(int argc, char **argv, const char *name)
{
    for (int i = 1; i < argc; i++)
        if (strcmp(argv[i], name) == 0) return 1;
    return 0;
}

static int cmd_encode(int argc, char **argv)
{
    int w = arg_int(argc, argv, "--w", 0);
    int h = arg_int(argc, argv, "--h", 0);
    int frames = arg_int(argc, argv, "--frames", 0);
    int fps = arg_int(argc, argv, "--fps", 30);
    int kf = arg_int(argc, argv, "--kf", 300);
    int quality = arg_int(argc, argv, "--quality", 60);
    const char *cs_name = arg_str(argc, argv, "--cs", "yuv420");
    const char *in_path = arg_str(argc, argv, "--in", NULL);
    const char *out_path = arg_str(argc, argv, "--out", NULL);
    if (w <= 0 || h <= 0 || frames <= 0 || !in_path || !out_path) {
        fprintf(stderr, "qov_bench: encode needs --w --h --frames --in --out\n");
        return 2;
    }

    FILE *in = strcmp(in_path, "-") == 0 ? stdin : fopen(in_path, "rb");
    if (!in) {
        fprintf(stderr, "qov_bench: cannot open %s\n", in_path);
        return 2;
    }

    qov_encode_params p;
    memset(&p, 0, sizeof p);
    p.width = (uint32_t)w;
    p.height = (uint32_t)h;
    p.fps_num = (uint32_t)fps;
    p.fps_den = 1;
    p.colorspace = strcmp(cs_name, "srgb") == 0 ? QOV_CS_SRGB : QOV_CS_YUV420;
    p.motion = arg_flag(argc, argv, "--motion");
    p.intra_dct_keyframes = arg_flag(argc, argv, "--ikf");
    p.intra_refresh = arg_flag(argc, argv, "--refresh");
    p.lz4 = arg_flag(argc, argv, "--lz4");
    p.quality = quality;

    qov_encoder *e = qov_encode_start(&p);
    if (!e) {
        fprintf(stderr, "qov_bench: qov_encode_start failed\n");
        return 2;
    }

    size_t frame_bytes = (size_t)w * h * 4;
    uint8_t *px = xread_all(in, frame_bytes);
    if (!px) {
        fprintf(stderr, "qov_bench: cannot read frame 0\n");
        return 2;
    }

    double total_ms = 0;
    for (int n = 0; n < frames; n++) {
        if (n > 0) {
            uint8_t *np = (uint8_t *)malloc(frame_bytes);
            if (!np || fread(np, 1, frame_bytes, in) != frame_bytes) {
                free(np);
                fprintf(stderr, "qov_bench: short input at frame %d\n", n);
                return 2;
            }
            free(px);
            px = np;
        }
        uint32_t ts = (uint32_t)((double)n * 1e6 / fps);
        qovbench_time t0 = now();
        qov_result r = (n % kf == 0) ? qov_encode_keyframe(e, px, ts)
                                     : qov_encode_pframe(e, px, ts);
        qovbench_time t1 = now();
        if (r != QOV_OK) {
            fprintf(stderr, "qov_bench: encode frame %d failed (%d)\n", n, r);
            return 2;
        }
        total_ms += elapsed_ms(t0, t1);
    }
    free(px);

    qov_encode_stats st;
    qov_encode_get_stats(e, &st);

    uint8_t *data = NULL;
    size_t data_len = 0;
    qov_result r = qov_encode_finish(e, &data, &data_len);
    if (r != QOV_OK || !data) {
        fprintf(stderr, "qov_bench: finish failed (%d)\n", r);
        return 2;
    }
    FILE *out = fopen(out_path, "wb");
    if (!out || fwrite(data, 1, data_len, out) != data_len) {
        fprintf(stderr, "qov_bench: cannot write %s\n", out_path);
        return 2;
    }
    fclose(out);
    qov_free(data);
    if (in != stdin) fclose(in);

    printf("{\"mode\":\"encode\",\"frames\":%d,\"encodeMs\":%.3f,"
           "\"msPerFrame\":%.4f,\"bytes\":%lu,"
           "\"stats\":{\"framesKey\":%llu,\"framesP\":%llu,"
           "\"blocksSkip\":%llu,\"blocksCoded\":%llu}}\n",
           frames, total_ms, total_ms / frames, (unsigned long)data_len,
           (unsigned long long)st.frames_key, (unsigned long long)st.frames_p,
           (unsigned long long)st.blocks_skip, (unsigned long long)st.blocks_coded);
    return 0;
}

static int cmd_decode(int argc, char **argv)
{
    const char *in_path = arg_str(argc, argv, "--in", NULL);
    const char *raw_path = arg_str(argc, argv, "--rawout", NULL);
    if (!in_path) {
        fprintf(stderr, "qov_bench: decode needs --in\n");
        return 2;
    }
    FILE *in = fopen(in_path, "rb");
    if (!in) {
        fprintf(stderr, "qov_bench: cannot open %s\n", in_path);
        return 2;
    }
    fseek(in, 0, SEEK_END);
    long ln = ftell(in);
    fseek(in, 0, SEEK_SET);
    uint8_t *data = xread_all(in, (size_t)ln);
    fclose(in);
    if (!data) {
        fprintf(stderr, "qov_bench: cannot read %s\n", in_path);
        return 2;
    }
    size_t size = (size_t)ln;

    qov_header hdr;    if (qov_decode_header(data, size, &hdr) != QOV_OK) {
        fprintf(stderr, "qov_bench: bad header\n");
        return 2;
    }
    qov_decoder *dec = NULL;
    if (qov_decoder_new(&hdr, &dec) != QOV_OK) {
        fprintf(stderr, "qov_bench: decoder alloc failed\n");
        return 2;
    }

    FILE *raw = NULL;
    if (raw_path) {
        raw = strcmp(raw_path, "-") == 0 ? stdout : fopen(raw_path, "wb");
        if (!raw) {
            fprintf(stderr, "qov_bench: cannot open %s\n", raw_path);
            return 2;
        }
    }

    size_t pos = hdr.header_size;
    size_t chunk_hdr = hdr.version >= 2 ? 10 : 8;
    int frames = 0;
    double total_ms = 0;
    while (pos + chunk_hdr <= size) {
        uint8_t ctype = data[pos], cflags = data[pos + 1];
        uint32_t csize = hdr.version >= 2
            ? ((uint32_t)data[pos + 2] << 24) | ((uint32_t)data[pos + 3] << 16) |
              ((uint32_t)data[pos + 4] << 8) | data[pos + 5]
            : (uint32_t)((data[pos + 2] << 8) | data[pos + 3]);
        if (pos + chunk_hdr + csize > size || ctype == 0xFF) break;
        const uint8_t *payload = data + pos + chunk_hdr;
        uint32_t ts = hdr.version >= 2
            ? ((uint32_t)data[pos + 6] << 24) | ((uint32_t)data[pos + 7] << 16) |
              ((uint32_t)data[pos + 8] << 8) | data[pos + 9]
            : ((uint32_t)data[pos + 4] << 24) | ((uint32_t)data[pos + 5] << 16) |
              ((uint32_t)data[pos + 6] << 8) | data[pos + 7];
        if (ctype == 0x01 || ctype == 0x02) {
            qov_image img;
            qovbench_time t0 = now();
            qov_result r = qov_decoder_feed(dec, ctype, cflags, payload, csize, ts, &img, NULL);
            qovbench_time t1 = now();
            if (r != QOV_OK) {
                fprintf(stderr, "qov_bench: decode chunk at %zu failed (%d)\n", pos, r);
                return 2;
            }
            total_ms += elapsed_ms(t0, t1);
            frames++;
            if (raw)
                fwrite(img.rgba, 1, (size_t)img.width * img.height * 4, raw);
        } else {
            qov_decoder_feed(dec, ctype, cflags, payload, csize, ts, NULL, NULL);
        }
        pos += chunk_hdr + csize;
    }
    qov_decoder_free(dec);
    if (raw && raw != stdout) fclose(raw);

    printf("{\"mode\":\"decode\",\"frames\":%d,\"decodeMs\":%.3f,"
           "\"msPerFrame\":%.4f}\n",
           frames, total_ms, frames ? total_ms / frames : 0.0);
    return 0;
}

int main(int argc, char **argv)
{
    set_binary_stdio();
    if (argc < 2) {
        fprintf(stderr,
                "usage: qov_bench encode --w W --h H --frames N --quality Q "
                "[--fps F] [--kf K] [--motion] [--lz4] [--cs yuv420|srgb] "
                "--in <raw.rgba|-> --out <file.qov>\n"
                "       qov_bench decode --in <file.qov> [--rawout <file|->]\n");
        return 2;
    }
    if (strcmp(argv[1], "encode") == 0) return cmd_encode(argc, argv);
    if (strcmp(argv[1], "decode") == 0) return cmd_decode(argc, argv);
    fprintf(stderr, "qov_bench: unknown command %s\n", argv[1]);
    return 2;
}
