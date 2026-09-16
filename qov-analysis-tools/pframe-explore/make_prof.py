import re, sys
src = open('qov.h').read()

# --- 1. instrumentation globals + instrumented rc_encode loop ---
anchor = "static qov_result qov__rc_encode(const uint8_t *in, size_t len,"
inst = r'''
/* ---- exploration profiler (scratch build, not part of the codec) ---- */
enum { PT_NONE=0, PT_BAND, PT_MV, PT_SKIP, PT_OP, PT_QP, PT_DC,
       PT_ACRUN, PT_ACLEV, PT_EOB, PT_END, PF_CAT };
static double g_bits[PF_CAT];
static size_t g_raw[PF_CAT];
static uint8_t *g_tags;
static size_t g_tags_cap;
static int g_profile_on;
static long g_pf_chunks, g_pf_rc_bytes, g_pf_raw_bytes, g_kf_rc_bytes;
/* per-block coefficient stats (non-EG branch of enc_dct_emit) */
static long g_blocks, g_dconly, g_acs, g_ac_mag1;
static long g_dc_zero, g_dc_small, g_dc_big;
static long g_lv_size1, g_lv_size2, g_lv_size3, g_lv_size4, g_runbytes;

'''
src = src.replace(anchor, inst + anchor, 1)

old_loop = "    for (size_t i = 0; i < len; i++) qov_rc_enc_byte(&rc, &m, in[i]);\n    *out_len = qov_rc_enc_flush(&rc);"
new_loop = r'''    for (size_t i = 0; i < len; i++) {
        if (g_profile_on && g_tags) {
            int c = g_tags[i] < PF_CAT ? g_tags[i] : 0;
            g_bits[c] += log2((double)m.total) - log2((double)m.freq[in[i]]);
            g_raw[c]++;
        }
        qov_rc_enc_byte(&rc, &m, in[i]);
    }
    *out_len = qov_rc_enc_flush(&rc);'''
assert src.count(old_loop) == 1
src = src.replace(old_loop, new_loop, 1)

# --- 2. payload tagger (mirrors the decoder grammar, EG off) ---
tagger = r'''
static void qov__prof_tag(const uint8_t *d, size_t len, int refresh, int have_mv,
                          int w, int h, int cw, int ch)
{
    if (g_tags_cap < len) {
        g_tags = (uint8_t *)qov__realloc(g_tags, len * 2);
        g_tags_cap = len * 2;
    }
    memset(g_tags, PT_NONE, len);
    size_t pos = 0;
    if (refresh) { g_tags[pos++] = PT_BAND; }
    if (have_mv) {
        int count = (d[pos + 1] << 8) | d[pos + 2];
        size_t mvsz = 3 + (size_t)count * 2;
        for (size_t i = 0; i < mvsz && pos < len; i++, pos++) g_tags[pos] = PT_MV;
    }
    int planes_ops[3] = { 0x50, 0x51, 0x51 };
    int planes_tot[3] = { ((w + 7) / 8) * ((h + 7) / 8),
                          ((cw + 7) / 8) * ((ch + 7) / 8),
                          ((cw + 7) / 8) * ((ch + 7) / 8) };
    for (int p = 0; p < 3 && pos < len; p++) {
        int done = 0;
        while (done < planes_tot[p] && pos < len) {
            uint8_t b1 = d[pos];
            if (b1 == 0x52 || b1 == 0x53) {
                g_tags[pos] = PT_SKIP; g_tags[pos + 1] = PT_SKIP;
                pos += 2; done += d[pos - 1];
            } else if (b1 == planes_ops[p]) {
                g_tags[pos] = PT_OP; pos++;
                g_tags[pos] = PT_QP; pos++;
                g_tags[pos] = PT_DC; g_tags[pos + 1] = PT_DC; pos += 2;
                for (;;) {
                    uint8_t b = d[pos];
                    if (b == 0x00) { g_tags[pos] = PT_EOB; pos++; break; }
                    if (b == 0xF0) { g_tags[pos] = PT_ACRUN; pos++; continue; }
                    int run = b >> 4, size = b & 15;
                    g_tags[pos] = PT_ACRUN; pos++;
                    for (int i = 0; i < size; i++) { g_tags[pos] = PT_ACLEV; pos++; }
                }
                done++;
            } else {
                fprintf(stderr, "[prof] tag mismatch at pos %zu (byte %02x)\n", pos, b1);
                return;
            }
        }
    }
    while (pos < len) g_tags[pos] = PT_END, pos++;
}

'''
anchor2 = "static void qov__enc_write_chunk(qov_encoder *e, uint8_t type, uint8_t base_flags,"
assert src.count(anchor2) == 1
src = src.replace(anchor2, tagger + anchor2, 1)

# --- 3. hook into write_chunk RC branch ---
old_rc = r'''    if (e->p.range_coding && (base_flags & QOV_CF_DCT_BLOCKS)) {
        /* v3.8: payload = [u32 BE raw size][range-coded bytes] */
        uint8_t *rc = NULL;
        size_t rc_len = 0;
        qov_result r = qov__rc_encode(data, len, &rc, &rc_len);'''
new_rc = r'''    if (e->p.range_coding && (base_flags & QOV_CF_DCT_BLOCKS)) {
        /* v3.8: payload = [u32 BE raw size][range-coded bytes] */
        uint8_t *rc = NULL;
        size_t rc_len = 0;
        g_profile_on = 0; g_tags = NULL;
        if (type == 0x02 && !(base_flags & 0x40)) {
            uint32_t cw = qov_chroma_w(e->p.colorspace, e->p.width);
            uint32_t chh = qov_chroma_h(e->p.colorspace, e->p.height);
            qov__prof_tag(data, len, (base_flags & QOV_CF_REFRESH_BAND) != 0,
                          (base_flags & 0x02) != 0,
                          (int)e->p.width, (int)e->p.height, (int)cw, (int)chh);
            g_profile_on = 1;
        }
        qov_result r = qov__rc_encode(data, len, &rc, &rc_len);
        if (type == 0x02) { g_pf_chunks++; g_pf_rc_bytes += (long)rc_len; g_pf_raw_bytes += (long)len; }
        else g_kf_rc_bytes += (long)rc_len;'''
assert src.count(old_rc) == 1
src = src.replace(old_rc, new_rc, 1)

# --- 4. coefficient stats in the non-EG emit branch ---
old_dc = "    qov__buf_u16(&e->fb, (uint16_t)((uint16_t)qv[0] & 0xffff));"
new_dc = r'''    qov__buf_u16(&e->fb, (uint16_t)((uint16_t)qv[0] & 0xffff));
    g_blocks++;
    if (qv[0] == 0) g_dc_zero++;
    else if (qv[0] >= -128 && qv[0] <= 127) g_dc_small++;
    else g_dc_big++;'''
assert src.count(old_dc) == 1
src = src.replace(old_dc, new_dc, 1)

old_lvl = r'''            int size = (qv[k] >= -128 && qv[k] <= 127) ? 1 : (qv[k] >= -32768 && qv[k] <= 32767) ? 2
                     : (qv[k] >= -8388608 && qv[k] <= 8388607) ? 3 : 4;
            qov__buf_u8(&e->fb, (uint8_t)((zero_run << 4) | size));'''
new_lvl = old_lvl + r'''
            g_acs++;
            int mag = qv[k] < 0 ? -qv[k] : qv[k];
            if (mag == 1) g_ac_mag1++;
            if (size == 1) g_lv_size1++; else if (size == 2) g_lv_size2++;
            else if (size == 3) g_lv_size3++; else g_lv_size4++;
            g_runbytes += (zero_run > 0) ? 1 : 0;'''
assert src.count(old_lvl) == 1
src = src.replace(old_lvl, new_lvl, 1)

open('qov_prof.h', 'w').write(src)
print("patched ok")
