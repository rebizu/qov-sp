/* QOV video encoder module for VLC 3.0.x transcode: RGBA pictures -> QOV1 ES.
 * Each picture becomes one chunk (SYNC+KEYFRAME or PFRAME), streamed out via
 * qov_encoder_take_chunks. Options: --sout-qov-keyint, --sout-qov-lz4. */
#include "qov_pre.h"

#include <vlc_common.h>
#include <vlc_plugin.h>
#include <vlc_codec.h>
#include <vlc_es.h>

#include "../qov.h"
#include "qov-vlc.h"

struct encoder_sys_t {
    qov_encoder *enc;
    uint32_t frame_count;
    int keyint;
    vlc_tick_t first_pts;
    bool have_first_pts;
};
typedef struct encoder_sys_t video_enc_sys_t;

static block_t *EncodeVideo(encoder_t *enc, picture_t *pic)
{
    video_enc_sys_t *sys = enc->p_sys;
    if (!pic)
        return NULL;
    qov_trace("enc: frame chroma=%4.4s %dx%d date=%lld", (const char*)&pic->format.i_chroma,
              pic->format.i_visible_width, pic->format.i_visible_height, (long long)pic->date);

    if (!sys->have_first_pts) {
        sys->first_pts = pic->date;
        sys->have_first_pts = true;
    }
    int64_t rel_us = pic->date - sys->first_pts;
    if (rel_us < 0)
        rel_us = 0;
    uint32_t ts = (uint32_t)(rel_us & 0xFFFFFFFFu);

    /* repack the (pitch-aligned) picture to tightly packed rows; I420 input
       is converted with the codec's own BT.601 math first */
    uint32_t w = pic->format.i_visible_width;
    uint32_t h = pic->format.i_visible_height;
    bool is_i420 = pic->format.i_chroma == VLC_CODEC_I420;
    uint8_t *rgba = malloc((size_t)w * h * 4);
    if (!rgba)
        return NULL;
    if (is_i420) {
        uint8_t *y = malloc((size_t)w * h);
        uint8_t *u = malloc((size_t)((w + 1) / 2) * ((h + 1) / 2));
        uint8_t *v = malloc((size_t)((w + 1) / 2) * ((h + 1) / 2));
        if (!y || !u || !v) {
            free(y); free(u); free(v); free(rgba);
            return NULL;
        }
        for (uint32_t y_row = 0; y_row < h; y_row++)
            memcpy(y + (size_t)y_row * w,
                   pic->p[0].p_pixels + (size_t)y_row * pic->p[0].i_pitch, w);
        uint32_t cw = (w + 1) / 2, ch = (h + 1) / 2;
        for (uint32_t y_row = 0; y_row < ch; y_row++) {
            memcpy(u + (size_t)y_row * cw,
                   pic->p[1].p_pixels + (size_t)y_row * pic->p[1].i_pitch, cw);
            memcpy(v + (size_t)y_row * cw,
                   pic->p[2].p_pixels + (size_t)y_row * pic->p[2].i_pitch, cw);
        }
        qov_yuv420_to_rgba(y, u, v, w, h, rgba);
        free(y); free(u); free(v);
    } else {
        for (uint32_t y = 0; y < h; y++)
            memcpy(rgba + (size_t)y * w * 4,
                   pic->p[0].p_pixels + (size_t)y * pic->p[0].i_pitch, (size_t)w * 4);
    }

    qov_result r = (sys->keyint > 0 && sys->frame_count % (uint32_t)sys->keyint == 0)
        ? qov_encode_keyframe(sys->enc, rgba, ts)
        : qov_encode_pframe(sys->enc, rgba, ts);
    free(rgba);
    qov_trace("enc: encoded r=%d frame=%u", (int)r, sys->frame_count);
    if (r != QOV_OK) {
        msg_Err(enc, "qov encode error %d", r);
        return NULL;
    }
    sys->frame_count++;

    uint8_t *chunks = NULL;
    size_t len = 0;
    r = qov_encoder_take_chunks(sys->enc, &chunks, &len);
    if (r != QOV_OK || !chunks) {
        free(chunks);
        return NULL;
    }

    block_t *block = block_Alloc(len);
    if (!block) {
        qov_free(chunks);
        return NULL;
    }
    memcpy(block->p_buffer, chunks, len);
    qov_free(chunks);
    block->i_pts = pic->date;
    block->i_dts = pic->date;
    return block;
}

int qov_vlc_video_encoder_open(vlc_object_t *obj)
{
    encoder_t *enc = (encoder_t *)obj;
    qov_trace("enc: open enter vchroma=%4.4s icat=%4.4s out=%4.4s %ux%u", (const char*)&enc->fmt_in.video.i_chroma, (const char*)&enc->fmt_in.i_codec, (const char*)&enc->fmt_out.i_codec, enc->fmt_in.video.i_width, enc->fmt_in.video.i_height);

    /* transcode probes with an empty chroma (availability test only); the
       real chroma arrives per picture and EncodeVideo adapts (RGBA/I420).
       Announce I420 so transcode builds a matching converter chain. */
    enc->fmt_in.video.i_chroma = VLC_CODEC_I420;
    uint32_t w = enc->fmt_in.video.i_visible_width ? enc->fmt_in.video.i_visible_width
                                                   : enc->fmt_in.video.i_width;
    uint32_t h = enc->fmt_in.video.i_visible_height ? enc->fmt_in.video.i_visible_height
                                                    : enc->fmt_in.video.i_height;
    if (w == 0 || h == 0)
        return VLC_EGENERIC;

    video_enc_sys_t *sys = vlc_obj_calloc(obj, 1, sizeof(*sys));
    if (!sys)
        return VLC_ENOMEM;

    qov_encode_params p;
    memset(&p, 0, sizeof p);
    p.width = w;
    p.height = h;
    p.fps_num = enc->fmt_in.video.i_frame_rate ? enc->fmt_in.video.i_frame_rate : 30;
    p.fps_den = enc->fmt_in.video.i_frame_rate_base ? enc->fmt_in.video.i_frame_rate_base : 1;
    p.colorspace = QOV_CS_SRGB;
    p.lz4 = var_InheritInteger(obj, "sout-qov-lz4") != 0;
    sys->keyint = var_InheritInteger(obj, "sout-qov-keyint");

    sys->enc = qov_encode_start(&p);
    if (!sys->enc) {
        msg_Err(enc, "qov: encoder start failed");
        return VLC_EGENERIC;
    }
    enc->p_sys = sys;

    enc->fmt_out.i_codec = QOV_VLC_VIDEO_FOURCC;
    enc->fmt_out.video.i_width = w;
    enc->fmt_out.video.i_visible_width = w;
    enc->fmt_out.video.i_height = h;
    enc->fmt_out.video.i_visible_height = h;
    enc->fmt_out.video.i_frame_rate = p.fps_num;
    enc->fmt_out.video.i_frame_rate_base = p.fps_den;

    enc->pf_encode_video = EncodeVideo;
    msg_Dbg(enc, "qov: video encoder %ux%u keyint %d", w, h, sys->keyint);
    return VLC_SUCCESS;
}

void qov_vlc_video_encoder_close(vlc_object_t *obj)
{
    encoder_t *enc = (encoder_t *)obj;
    video_enc_sys_t *sys = enc->p_sys;
    if (sys)
        qov_encoder_free(sys->enc);
}
