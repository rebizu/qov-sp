import re
src = open('qov_prof.h').read()

def slice_of(s, start_marker, end_marker):
    i = s.index(start_marker)
    j = s.index(end_marker, i)
    return i, j

def edit_slice(s, start_marker, end_marker, fn):
    i, j = slice_of(s, start_marker, end_marker)
    return s[:i] + fn(s[i:j]) + s[j:]

# ---- A. params field ----
old = "    uint8_t audio_channels; /* 0 = no audio (QOV_CHUNK_AUDIO via qov_encode_audio) */"
assert src.count(old) == 1
src = src.replace(old, "    int pframe_v2;          /* EXPLORATION: structured P-frame grammar, chunk flag 0x04 */\n" + old, 1)

# ---- B. skip flush helper before enc_plane_dct ----
anchor = "static void qov__enc_plane_dct(qov_encoder *e, const uint8_t *curr, const uint8_t *ref,"
helper = r'''/* v2 exploration: flush pending skips. v1 writes 0x52-tagged runs; v2
   writes a bare count chain where 255 means "255 more, chain continues"
   and every plane section ends with a byte < 255 (0 when nothing pending). */
static void qov__enc_skip_flush(qov_encoder *e, int *skip, int v2)
{
    if (v2) {
        while (*skip >= 255) { qov__buf_u8(&e->fb, 255); *skip -= 255; }
        qov__buf_u8(&e->fb, (uint8_t)*skip);
        *skip = 0;
        return;
    }
    while (*skip > 0) {
        uint8_t n = (uint8_t)(*skip > 255 ? 255 : *skip);
        qov__buf_u8(&e->fb, 0x52); qov__buf_u8(&e->fb, n);
        *skip -= n;
    }
}

'''
assert src.count(anchor) == 1
src = src.replace(anchor, helper + anchor, 1)

# ---- C. enc_dct_emit: bare param ----
def fix_emit(s):
    old_sig = """static void qov__enc_dct_emit(qov_encoder *e, const float *res, const int *quant,
                              uint8_t op, double scale, float *out_idct)"""
    assert s.count(old_sig) == 1
    s = s.replace(old_sig, """static void qov__enc_dct_emit(qov_encoder *e, const float *res, const int *quant,
                              uint8_t op, double scale, float *out_idct, int bare)""", 1)
    old_op = "    qov__buf_u8(&e->fb, op);\n    e->stats.blocks_coded++;"
    assert s.count(old_op) == 1
    s = s.replace(old_op, "    if (!bare) qov__buf_u8(&e->fb, op);\n    e->stats.blocks_coded++;", 1)
    old_qp = "    qov__buf_u8(&e->fb, (uint8_t)(0x40 + (int)e->dct_qp - (int)e->dct_qp_base));"
    assert s.count(old_qp) == 1
    s = s.replace(old_qp, "    if (!bare)\n" + old_qp, 1)
    return s
src = edit_slice(src, "static void qov__enc_dct_emit(", "static void qov__enc_plane_dct(", fix_emit)

# ---- D. enc_plane_dct: v2 param, per-plane qp, flush calls, bare emit ----
def fix_plane(s):
    old_sig = "int band_r0, int band_r1)\n{"
    assert s.count(old_sig) == 1
    s = s.replace(old_sig, "int band_r0, int band_r1, int v2)\n{", 1)
    old_top = "{\n    uint8_t qp = (uint8_t)e->dct_qp;"
    assert s.count(old_top) == 1
    s = s.replace(old_top, "{\n    if (v2) qov__buf_u8(&e->fb, (uint8_t)(0x40 + (int)e->dct_qp - (int)e->dct_qp_base));\n    uint8_t qp = (uint8_t)e->dct_qp;", 1)
    # flush sites (3): the while-loops become helper calls
    pat = re.compile(r"while \(skip > 0\) \{\n\s*uint8_t n = \(uint8_t\)\(skip > 255 \? 255 : skip\);\n\s*qov__buf_u8\(&e->fb, 0x52\); qov__buf_u8\(&e->fb, n\);\n\s*skip -= n;\n\s*\}")
    n = len(pat.findall(s))
    assert n == 3, n
    s = pat.sub("qov__enc_skip_flush(e, &skip, v2);", s)
    old_e = "qov__enc_dct_emit(e, res, quant, op, scale, idct);"
    assert s.count(old_e) == 2
    s = s.replace(old_e, "qov__enc_dct_emit(e, res, quant, op, scale, idct, v2);")
    return s
src = edit_slice(src, "static void qov__enc_plane_dct(", "/* ---- intra DCT plane encoder", fix_plane)

# ---- E. intra: bare = 0 ----
old_i = "qov__enc_dct_emit(e, res, quant, op, scale, idct);"
src = edit_slice(src, "/* ---- intra DCT plane encoder", "/* ---- YUV P-frame",
                 lambda s: s.replace(old_i, "qov__enc_dct_emit(e, res, quant, op, scale, idct, 0);"))

# ---- F. yuv_pframe: flag + v2 args ----
def fix_yuv(s):
    old_f = "    uint8_t flags = (uint8_t)(0x01 | (have_mv ? 0x02 : 0) | (refresh ? QOV_CF_REFRESH_BAND : 0));"
    assert s.count(old_f) == 1
    s = s.replace(old_f, "    uint8_t flags = (uint8_t)(0x01 | (have_mv ? 0x02 : 0) | (refresh ? QOV_CF_REFRESH_BAND : 0)\n                            | (e->p.pframe_v2 ? 0x04 : 0));", 1)
    for plane in ["yp, ref_y, next_y, (int)w, (int)h, qov_quant_luma, 0x50, yr0, yr1",
                  "up, ref_u, next_u, (int)uvw, (int)uvh, qov_quant_chroma, 0x51, cr0, cr1",
                  "vp, ref_v, next_v, (int)uvw, (int)uvh, qov_quant_chroma, 0x51, cr0, cr1",
                  "ap, ref_a, next_a, (int)w, (int)h, qov_quant_luma, 0x50, yr0, yr1"]:
        old_c = "qov__enc_plane_dct(e, " + plane + ");"
        assert s.count(old_c) == 1, plane
        s = s.replace(old_c, "qov__enc_plane_dct(e, " + plane + ", e->p.pframe_v2);", 1)
    return s
src = edit_slice(src, "/* ---- YUV P-frame (motion + quantized DCT/DPCM) ----", "/* ---- YUV temporal plane coder", fix_yuv)

# ---- G. decoder: dec_dct_block bare ----
def fix_decblock(s):
    old_sig = """static void qov__dec_dct_block(const uint8_t *payload, size_t payload_len,
                               size_t *pos, const int *quant, uint8_t qp_base, float *out, int eg)"""
    assert s.count(old_sig) == 1
    s = s.replace(old_sig, """static void qov__dec_dct_block(const uint8_t *payload, size_t payload_len,
                               size_t *pos, const int *quant, uint8_t qp_base, float *out, int eg,
                               int bare)""", 1)
    old_qp = """    uint8_t qp_byte = payload[(*pos)++];
    int qp_delta = (qp_byte & 0x7F) - 64;
    int final_qp = qov_clampi((int)qp_base + qp_delta, 0, 100);"""
    assert s.count(old_qp) == 1
    s = s.replace(old_qp, """    int final_qp;
    if (bare) {
        final_qp = qp_base; /* v2: plane-level qp, no per-block delta */
    } else {
        uint8_t qp_byte = payload[(*pos)++];
        int qp_delta = (qp_byte & 0x7F) - 64;
        final_qp = qov_clampi((int)qp_base + qp_delta, 0, 100);
    }""", 1)
    # v1 intra call site of dec_dct_block? none. P-frame call updated in v2 branch below.
    return s
src = edit_slice(src, "static void qov__dec_dct_block(", "static void qov__dec_plane_dct(", fix_decblock)

# ---- H. dec_plane_dct: v2 branch ----
def fix_decplane(s):
    old_sig = "int band_r0, int band_r1, int eg)\n{"
    assert s.count(old_sig) == 1
    s = s.replace(old_sig, "int band_r0, int band_r1, int eg, int v2)\n{", 1)
    old_top = """    float block[64];
    int blocks_x = (w + 7) / 8, blocks_y = (h + 7) / 8;
    int block_idx = 0, total = blocks_x * blocks_y;
"""
    assert s.count(old_top) == 1
    s = s.replace(old_top, old_top + r'''    if (v2) {
        int qp_abs = qov_clampi((int)qp_base + ((int)payload[(*pos)++] - 0x40), 0, 100);
        for (;;) {
            if (*pos >= payload_len) return;
            int r;
            do { r = payload[(*pos)++]; } while (r == 255 && *pos < payload_len);
            for (int n = 0; n < r && block_idx < total; n++, block_idx++) {
                int brow = block_idx / blocks_x;
                if (brow < band_r0 || brow >= band_r1) continue;
                int bx = (block_idx % blocks_x) * 8;
                int by = brow * 8;
                int pred = qov__intra_pred(plane, w, h, bx, by);
                for (int y = 0; y < 8 && by + y < h; y++)
                    for (int x = 0; x < 8 && bx + x < w; x++)
                        plane[(by + y) * w + bx + x] = (uint8_t)pred;
            }
            if (block_idx >= total) break;
            qov__dec_dct_block(payload, payload_len, pos, quant, (uint8_t)qp_abs, block, eg, 1);
            int bx = (block_idx % blocks_x) * 8;
            int by = (block_idx / blocks_x) * 8;
            int in_band = block_idx / blocks_x >= band_r0 && block_idx / blocks_x < band_r1;
            int pred = in_band ? qov__intra_pred(plane, w, h, bx, by) : 0;
            for (int y = 0; y < 8 && by + y < h; y++)
                for (int x = 0; x < 8 && bx + x < w; x++) {
                    int idx = (by + y) * w + (bx + x);
                    int val = in_band
                        ? (int)((double)pred + (double)block[y * 8 + x])
                        : (int)((double)plane[idx] + (double)block[y * 8 + x]);
                    plane[idx] = (uint8_t)qov_clampi(val, 0, 255);
                }
            block_idx++;
        }
        return;
    }
''', 1)
    # all v1 dec_dct_block calls gain bare=0 (plane_dct v1 loop + intra decoder)
    old_call = "qov__dec_dct_block(payload, payload_len, pos, quant, qp_base, block, eg);"
    while old_call in s:
        s = s.replace(old_call, old_call[:-2] + ", 0);", 1)
    return s
src = edit_slice(src, "static void qov__dec_plane_dct(", "/* ---- intra DCT plane decoder", fix_decplane)

# ---- H2. intra decoder's dec_dct_block call also gains bare=0 ----
old_intra_call = "qov__dec_dct_block(payload, payload_len, pos, quant, qp_base, block, eg);"
assert src.count(old_intra_call) == 1, src.count(old_intra_call)
src = src.replace(old_intra_call, old_intra_call[:-2] + ", 0);", 1)

# ---- I. P-frame handler: v2 flag + updated calls ----
old_h = """                uint8_t qp = hdr->dct_qp ? hdr->dct_qp : 20;
                int rows_y = ((int)hdr->height + 7) / 8;"""
assert src.count(old_h) == 1
src = src.replace(old_h, old_h.replace("uint8_t qp", "uint8_t qp").replace(
    "int rows_y", "int v2 = (cflags & 0x04) != 0;\n                int rows_y"), 1)
for args in ["d->curr_y, (int)hdr->width, (int)hdr->height, qov_quant_luma, qp, 0x50, yr0, yr1, eg",
             "d->curr_u, d->uv_w, d->uv_h, qov_quant_chroma, qp, 0x51, cr0, cr1, eg",
             "d->curr_v, d->uv_w, d->uv_h, qov_quant_chroma, qp, 0x51, cr0, cr1, eg",
             "d->curr_a, (int)hdr->width, (int)hdr->height, qov_quant_luma, qp, 0x50, yr0, yr1, eg"]:
    old_c = "qov__dec_plane_dct(p, payload_len_v, &pos, " + args + ");"
    assert src.count(old_c) == 1, args
    src = src.replace(old_c, old_c[:-2] + ", v2);", 1)

# ---- J. v2 tagger + hook dispatch ----
tag2 = r'''
static void qov__prof_tag_v2(const uint8_t *d, size_t len, int refresh, int have_mv,
                             int w, int h, int cw, int ch)
{
    if (g_tags_cap < len) {
        g_tags = (uint8_t *)realloc(g_tags, len * 2);
        if (!g_tags) { fprintf(stderr, "[prof] tag alloc failed\n"); abort(); }
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
    int planes_tot[3] = { ((w + 7) / 8) * ((h + 7) / 8),
                          ((cw + 7) / 8) * ((ch + 7) / 8),
                          ((cw + 7) / 8) * ((ch + 7) / 8) };
    for (int p = 0; p < 3 && pos < len; p++) {
        g_tags[pos] = PT_QP; pos++;
        int coded = 0, skipped = 0, tot = planes_tot[p];
        while (coded + skipped < tot && pos < len) {
            int r;
            do {
                if (pos >= len) return;
                r = d[pos]; g_tags[pos] = PT_SKIP; pos++;
                skipped += r;
            } while (r == 255);
            if (coded + skipped >= tot) break;
            g_tags[pos] = PT_DC; g_tags[pos + 1] = PT_DC; pos += 2;
            for (;;) {
                uint8_t b = d[pos];
                if (b == 0x00) { g_tags[pos] = PT_EOB; pos++; break; }
                if (b == 0xF0) { g_tags[pos] = PT_ACRUN; pos++; continue; }
                int size = b & 15;
                g_tags[pos] = PT_ACRUN; pos++;
                for (int i = 0; i < size; i++) { g_tags[pos] = PT_ACLEV; pos++; }
            }
            coded++;
        }
    }
    while (pos < len) g_tags[pos] = PT_END, pos++;
}

'''
anchor2 = "static void qov__enc_write_chunk(qov_encoder *e, uint8_t type, uint8_t base_flags,"
src = src.replace(anchor2, tag2 + anchor2, 1)
old_t = """            qov__prof_tag(data, len, (base_flags & QOV_CF_REFRESH_BAND) != 0,
                          (base_flags & 0x02) != 0,
                          (int)e->p.width, (int)e->p.height, (int)cw, (int)chh);"""
assert src.count(old_t) == 1
src = src.replace(old_t, """            if (base_flags & 0x04)
                qov__prof_tag_v2(data, len, (base_flags & QOV_CF_REFRESH_BAND) != 0,
                                 (base_flags & 0x02) != 0,
                                 (int)e->p.width, (int)e->p.height, (int)cw, (int)chh);
            else
                qov__prof_tag(data, len, (base_flags & QOV_CF_REFRESH_BAND) != 0,
                              (base_flags & 0x02) != 0,
                              (int)e->p.width, (int)e->p.height, (int)cw, (int)chh);""", 1)

open('qov_v2.h', 'w').write(src)
print("v2 patched ok")
