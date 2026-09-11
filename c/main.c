/* qov_cli - CLI over the qov.h single-header codec.
 *
 *   qov_cli encode <case.json> <out.qov>
 *   qov_cli decode <file.qov> [--raw <dir>]
 *
 * Mirrors qov-analysis-tools/tscli.ts: encode reads the same corpus case
 * JSON (deterministic gradient/stripes/scroll16/noise patterns), decode
 * prints the same JSON report ({file, fileSha256, frames, frameSha256,
 * audioFrames, header}). Used by qov-analysis-tools/conformance.py.
 */
#define QOV_IMPLEMENTATION
#include "../qov.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

/* ------------------------------------------------------------------ */
/* SHA-256 (FIPS 180-4)                                                */
/* ------------------------------------------------------------------ */

typedef struct {
    uint32_t h[8];
    uint64_t len;
    uint8_t buf[64];
    size_t buf_len;
} sha256_ctx;

static const uint32_t sha_k[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static void sha256_init(sha256_ctx *c)
{
    static const uint32_t iv[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };
    memcpy(c->h, iv, sizeof iv);
    c->len = 0;
    c->buf_len = 0;
}

static void sha256_block(sha256_ctx *c, const uint8_t *p)
{
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = c->h[0], b = c->h[1], cc = c->h[2], dd = c->h[3];
    uint32_t e = c->h[4], f = c->h[5], g = c->h[6], hh = c->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = hh + s1 + ch + sha_k[i] + w[i];
        uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
        uint32_t t2 = s0 + maj;
        hh = g; g = f; f = e; e = dd + t1;
        dd = cc; cc = b; b = a; a = t1 + t2;
    }
    c->h[0] += a; c->h[1] += b; c->h[2] += cc; c->h[3] += dd;
    c->h[4] += e; c->h[5] += f; c->h[6] += g; c->h[7] += hh;
}

static void sha256_update(sha256_ctx *c, const uint8_t *p, size_t n)
{
    c->len += n;
    while (n > 0) {
        size_t take = 64 - c->buf_len;
        if (take > n) take = n;
        memcpy(c->buf + c->buf_len, p, take);
        c->buf_len += take;
        p += take;
        n -= take;
        if (c->buf_len == 64) {
            sha256_block(c, c->buf);
            c->buf_len = 0;
        }
    }
}

static void sha256_final(sha256_ctx *c, uint8_t out[32])
{
    uint64_t bits = c->len * 8;
    uint8_t pad = 0x80;
    sha256_update(c, &pad, 1);
    uint8_t z = 0;
    while (c->buf_len != 56) sha256_update(c, &z, 1);
    uint8_t lenb[8];
    for (int i = 0; i < 8; i++) lenb[i] = (uint8_t)(bits >> (56 - i * 8));
    sha256_update(c, lenb, 8);
    for (int i = 0; i < 8; i++) {
        out[i * 4] = (uint8_t)(c->h[i] >> 24);
        out[i * 4 + 1] = (uint8_t)(c->h[i] >> 16);
        out[i * 4 + 2] = (uint8_t)(c->h[i] >> 8);
        out[i * 4 + 3] = (uint8_t)c->h[i];
    }
}

static void sha256_hex(const uint8_t *data, size_t n, char out[65])
{
    sha256_ctx c;
    sha256_init(&c);
    sha256_update(&c, data, n);
    uint8_t d[32];
    sha256_final(&c, d);
    static const char hexd[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out[i * 2] = hexd[d[i] >> 4];
        out[i * 2 + 1] = hexd[d[i] & 15];
    }
    out[64] = 0;
}

/* ------------------------------------------------------------------ */
/* minimal flat-JSON access for corpus case files                      */
/* ------------------------------------------------------------------ */

static const char *json_value(const char *js, const char *key)
{
    char pat[48];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(js, pat);
    if (!p) return NULL;
    p += strlen(pat);
    while (*p == ' ' || *p == ':' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    return p;
}

static int json_int(const char *js, const char *key, int def)
{
    const char *p = json_value(js, key);
    return p ? (int)strtol(p, NULL, 10) : def;
}

static int json_bool(const char *js, const char *key, int def)
{
    const char *p = json_value(js, key);
    if (!p) return def;
    return strncmp(p, "true", 4) == 0;
}

static int json_has_string(const char *js, const char *key, const char *needle)
{
    const char *p = json_value(js, key);
    if (!p) return 0;
    const char *end = strchr(p, ']');
    if (!end) end = p + strlen(p);
    size_t nl = strlen(needle);
    for (const char *q = p; q + nl <= end; q++)
        if (memcmp(q, needle, nl) == 0) return 1;
    return 0;
}

static void json_string(const char *js, const char *key, char *out, size_t cap)
{
    out[0] = 0;
    const char *p = json_value(js, key);
    if (!p || *p != '"') return;
    p++;
    size_t i = 0;
    while (*p && *p != '"' && i + 1 < cap) out[i++] = *p++;
    out[i] = 0;
}

static int json_present(const char *js, const char *key)
{
    return json_value(js, key) != NULL;
}

/* ------------------------------------------------------------------ */
/* corpus frame generator (mirrors tscli.ts makeFrame)                 */
/* ------------------------------------------------------------------ */

static const uint8_t PAL[8][3] = {
    {255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 255, 0},
    {0, 255, 255}, {255, 0, 255}, {255, 255, 255}, {128, 128, 128}
};

static uint32_t lcg_next(uint32_t s)
{
    return (uint32_t)(((uint64_t)s * 1103515245u + 12345u) & 0x7fffffffu);
}

static void make_frame(uint8_t *px, int w, int h, const char *pattern, int n, int has_alpha_ch)
{
    uint32_t s = 12345u + (uint32_t)n * 7919u;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            int i = (y * w + x) * 4;
            int r = 0, g = 0, b = 0;
            if (strcmp(pattern, "gradient") == 0) {
                r = (int)((x * 255.0) / (w > 1 ? w - 1 : 1) + 0.5);
                g = (int)((y * 255.0) / (h > 1 ? h - 1 : 1) + 0.5);
                b = (x + y + n * 4) & 0xff;
            } else if (strcmp(pattern, "stripes") == 0) {
                const uint8_t *p = PAL[((x / 16) + n) % 8];
                r = p[0]; g = p[1]; b = p[2];
            } else if (strcmp(pattern, "scroll16") == 0) {
                int u = (x + n * 16) % w;
                r = (u * 3 + y) & 0xff;
                g = (u + y * 2) & 0xff;
                b = (u * u + y) & 0xff;
            } else if (strcmp(pattern, "noise") == 0) {
                s = lcg_next(s); r = (int)((s >> 16) & 0xff);
                s = lcg_next(s); g = (int)((s >> 16) & 0xff);
                s = lcg_next(s); b = (int)((s >> 16) & 0xff);
            } else {
                fprintf(stderr, "qov_cli ERROR: unknown pattern %s\n", pattern);
                exit(2);
            }
            px[i] = (uint8_t)r;
            px[i + 1] = (uint8_t)g;
            px[i + 2] = (uint8_t)b;
            px[i + 3] = has_alpha_ch ? (uint8_t)((x + n * 8) & 0xff) : 255;
        }
    }
}

static int colorspace_id(const char *name)
{
    static const char *names[8] = { "srgb", "srgba", "linear", "linear_a",
                                    "yuv420", "yuv422", "yuv444", "yuva420" };
    static const int ids[8] = { 0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13 };
    for (int i = 0; i < 8; i++)
        if (strcmp(name, names[i]) == 0) return ids[i];
    return -1;
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

static uint8_t *read_file(const char *path, size_t *size_out)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) { fclose(f); return NULL; }
    uint8_t *buf = malloc(n ? (size_t)n : 1);
    if (!buf) { fclose(f); return NULL; }
    if (n > 0 && fread(buf, 1, (size_t)n, f) != (size_t)n) {
        free(buf);
        fclose(f);
        return NULL;
    }
    fclose(f);
    *size_out = (size_t)n;
    return buf;
}

static int cmd_encode(const char *case_path, const char *out_path)
{
    size_t js_len;
    char *js = (char *)read_file(case_path, &js_len);
    if (!js) {
        fprintf(stderr, "qov_cli ERROR: cannot read %s\n", case_path);
        return 2;
    }

    char colorspace[32], pattern[32];
    json_string(js, "colorspace", colorspace, sizeof colorspace);
    json_string(js, "pattern", pattern, sizeof pattern);
    int cs = colorspace_id(colorspace);
    if (cs < 0) {
        fprintf(stderr, "qov_cli ERROR: unsupported colorspace '%s' "
                        "(audio-only cases are not encodable here)\n", colorspace);
        free(js);
        return 2;
    }

    int width = json_int(js, "width", 0);
    int height = json_int(js, "height", 0);
    int frames = json_int(js, "frames", 0);
    int fps = json_int(js, "fps", 30);
    int kf = json_int(js, "keyframeInterval", 2);
    if (kf <= 0) kf = 2;
    int quality = json_present(js, "quality") ? json_int(js, "quality", 0) : 0;
    int lz4 = json_bool(js, "compression", 1);

    int has_alpha_flag = json_has_string(js, "flags", "alpha") ||
                         cs == QOV_CS_SRGBA || cs == QOV_CS_LINEAR_A || cs == QOV_CS_YUVA420;
    int motion = json_has_string(js, "flags", "motion");

    qov_encode_params p;
    memset(&p, 0, sizeof p);
    p.width = (uint32_t)width;
    p.height = (uint32_t)height;
    p.fps_num = (uint32_t)fps;
    p.fps_den = 1;
    p.colorspace = (uint8_t)cs;
    p.has_alpha = has_alpha_flag;
    p.motion = motion;
    p.lz4 = lz4;
    p.quality = quality;

    qov_encoder *e = qov_encode_start(&p);
    if (!e) {
        fprintf(stderr, "qov_cli ERROR: qov_encode_start failed\n");
        free(js);
        return 2;
    }

    uint8_t *px = (uint8_t *)malloc((size_t)width * height * 4);
    if (!px) return 2;
    for (int n = 0; n < frames; n++) {
        make_frame(px, width, height, pattern, n, has_alpha_flag);
        uint32_t ts = (uint32_t)floor(n * 1e6 / fps + 0.5);
        qov_result r = (n % kf == 0)
            ? qov_encode_keyframe(e, px, ts)
            : qov_encode_pframe(e, px, ts);
        if (r != QOV_OK) {
            fprintf(stderr, "qov_cli ERROR: encode frame %d failed (%d)\n", n, r);
            return 2;
        }
    }

    uint8_t *data = NULL;
    size_t data_len = 0;
    qov_result r = qov_encode_finish(e, &data, &data_len);
    if (r != QOV_OK || !data) {
        fprintf(stderr, "qov_cli ERROR: qov_encode_finish failed (%d)\n", r);
        return 2;
    }

    FILE *f = fopen(out_path, "wb");
    if (!f || fwrite(data, 1, data_len, f) != data_len) {
        fprintf(stderr, "qov_cli ERROR: cannot write %s\n", out_path);
        return 2;
    }
    fclose(f);
    qov_free(data);
    free(px);
    free(js);
    printf("OK\n");
    return 0;
}

static void print_json_string(const char *s)
{
    putchar('"');
    for (; *s; s++) {
        if (*s == '\\' || *s == '"') putchar('\\');
        putchar(*s);
    }
    putchar('"');
}

static int cmd_decode(const char *path, const char *raw_dir)
{
    size_t size;
    uint8_t *data = read_file(path, &size);
    if (!data) {
        fprintf(stderr, "qov_cli ERROR: cannot read %s\n", path);
        return 2;
    }

    qov_header hdr;
    qov_result r = qov_decode_header(data, size, &hdr);
    if (r != QOV_OK) {
        fprintf(stderr, "qov_cli ERROR: header decode failed (%d)\n", r);
        return 2;
    }

    qov_image *frames = NULL;
    size_t count = 0;
    qov_decode_stats stats;
    memset(&stats, 0, sizeof stats);
    r = qov_decode_all(data, size, &frames, &count, &stats);
    if (r != QOV_OK) {
        fprintf(stderr, "qov_cli ERROR: decode failed (%d)\n", r);
        return 2;
    }

    char sha[65];
    sha256_hex(data, size, sha);

    printf("{\"file\":");
    print_json_string(path);
    printf(",\"fileSha256\":\"%s\",\"frames\":%d,\"frameSha256\":[",
           sha, (int)count);
    for (size_t i = 0; i < count; i++) {
        sha256_hex(frames[i].rgba, (size_t)frames[i].width * frames[i].height * 4, sha);
        printf("%s\"%s\"", i ? "," : "", sha);
    }
    printf("],\"audioFrames\":%d,\"header\":{\"version\":%d,\"colorspace\":%d,"
           "\"flags\":%d,\"width\":%u,\"height\":%u,\"totalFrames\":%u,"
           "\"audioChannels\":%d}}",
           (int)stats.audio_chunks, hdr.version, hdr.colorspace, hdr.flags,
           hdr.width, hdr.height, hdr.total_frames, hdr.audio_channels);

    if (raw_dir) {
        for (size_t i = 0; i < count; i++) {
            char fpath[1024];
            snprintf(fpath, sizeof fpath, "%s/frame_%d.rgba", raw_dir, (int)i);
            FILE *f = fopen(fpath, "wb");
            if (!f) {
                fprintf(stderr, "qov_cli ERROR: cannot write %s\n", fpath);
                return 2;
            }
            fwrite(frames[i].rgba, 1, (size_t)frames[i].width * frames[i].height * 4, f);
            fclose(f);
        }
    }

    qov_frames_free(frames, count);
    free(data);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "usage: qov_cli encode <case.json> <out.qov>\n"
                        "       qov_cli decode <file.qov> [--raw <dir>]\n");
        return 2;
    }
    if (strcmp(argv[1], "encode") == 0 && argc >= 4)
        return cmd_encode(argv[2], argv[3]);
    if (strcmp(argv[1], "decode") == 0) {
        const char *raw = NULL;
        for (int i = 3; i + 1 < argc; i++)
            if (strcmp(argv[i], "--raw") == 0) raw = argv[i + 1];
        return cmd_decode(argv[2], raw);
    }
    fprintf(stderr, "qov_cli ERROR: unknown command %s\n", argv[1]);
    return 2;
}
