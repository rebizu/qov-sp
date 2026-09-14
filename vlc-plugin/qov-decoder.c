/* QOV video decoder module for VLC 3.0.x: QOV1 bitstream -> RGBA pictures. */
#include "qov_pre.h"

#include <vlc_common.h>
#include <vlc_plugin.h>
#include <vlc_codec.h>
#include <vlc_es.h>

#include "../qov.h"
#include "qov-vlc.h"

struct decoder_sys_t {
    qov_decoder *dec;
    qov_header hdr;
    bool vout_ready;
};
typedef struct decoder_sys_t video_dec_sys_t;

static picture_t *DecodeBlock(video_dec_sys_t *sys, decoder_t *dec, block_t *block)
{
    uint8_t ctype = (block->i_flags & BLOCK_FLAG_TYPE_I) ? QOV_CHUNK_KEYFRAME
                                                         : QOV_CHUNK_PFRAME;
    qov_image img;
    qov_trace("vd: feeding ctype=%d", (int)ctype);
    qov_result r = qov_decoder_feed(sys->dec, ctype, 0, block->p_buffer,
                                    block->i_buffer, 0, &img, NULL);
    qov_trace("vd: fed r=%d img=%p", (int)r, (void*)img.rgba);
    block_Release(block);
    qov_trace("vd: block released");
    if (r != QOV_OK) {
        msg_Warn(dec, "qov decode error %d", r);
        return NULL;
    }

    if (!sys->vout_ready) {
        if (decoder_UpdateVideoFormat(dec) != 0)
            return NULL; /* no vout; drop */
        sys->vout_ready = true;
    }
    picture_t *pic = decoder_NewPicture(dec);
    qov_trace("vd: newpic=%p", (void*)pic);
    if (!pic)
        return NULL;
    /* qov_image is tightly packed RGBA; pictures have aligned pitches */
    for (int y = 0; y < (int)pic->format.i_visible_height; y++)
        memcpy(pic->p[0].p_pixels + (size_t)y * pic->p[0].i_pitch,
               img.rgba + (size_t)y * img.width * 4,
               (size_t)img.width * 4);
    qov_trace("vd: pixels copied");
    return pic;
}

static int Decode(decoder_t *dec, block_t *block)
{
    video_dec_sys_t *sys = dec->p_sys;
    static int dbg_n = 0;
    if (dbg_n++ < 2) msg_Warn(dec, "qovdec: decode call %d", dbg_n);
    if (!block)
        return VLCDEC_SUCCESS;
    if (block->i_flags & BLOCK_FLAG_CORRUPTED) {
        block_Release(block);
        return VLCDEC_SUCCESS;
    }

    qov_trace("vd: decode sz=%d flags=%x", (int)block->i_buffer, (unsigned)block->i_flags);
    vlc_tick_t pts = block->i_pts != VLC_TICK_INVALID ? block->i_pts : block->i_dts;
    picture_t *pic = DecodeBlock(sys, dec, block);
    qov_trace("vd: decoded pic=%p", (void*)pic);
    if (pic) {
        pic->date = pts;
        decoder_QueueVideo(dec, pic);
    }
    return VLCDEC_SUCCESS;
}

static void Flush(decoder_t *dec)
{
    video_dec_sys_t *sys = dec->p_sys;
    qov_decoder_reset(sys->dec);
    sys->vout_ready = false;
}

int qov_vlc_video_decoder_open(vlc_object_t *obj)
{
    decoder_t *dec = (decoder_t *)obj;
    qov_trace("vd: open enter codec=%4.4s extra=%d", (const char*)&dec->fmt_in.i_codec, (int)dec->fmt_in.i_extra);

    if (dec->fmt_in.i_codec != QOV_VLC_VIDEO_FOURCC)
        return VLC_EGENERIC;
    qov_trace("vd: codec match");
    if (!dec->fmt_in.p_extra || dec->fmt_in.i_extra < 24)
        return VLC_EGENERIC;

    video_dec_sys_t *sys = vlc_obj_calloc(obj, 1, sizeof(*sys));
    if (!sys)
        return VLC_ENOMEM;

    qov_result r = qov_decode_header(dec->fmt_in.p_extra, dec->fmt_in.i_extra, &sys->hdr);
    qov_trace("vd: header parsed r=%d", (int)r);
    if (r != QOV_OK) {
        msg_Err(dec, "qov: invalid embedded header (%d)", r);
        return VLC_EGENERIC;
    }
    r = qov_decoder_new(&sys->hdr, &sys->dec);
    qov_trace("vd: ctx new r=%d", (int)r);
    if (r != QOV_OK) {
        msg_Err(dec, "qov: decoder init failed (%d)", r);
        return VLC_EGENERIC;
    }
    dec->p_sys = sys;

    /* decoder_NewPicture allocates from fmt_out.video, which needs a real
       chroma + SAR setup, not just the codec field */
    dec->fmt_out.i_codec = VLC_CODEC_RGBA;
    video_format_Setup(&dec->fmt_out.video, VLC_CODEC_RGBA,
                       (int)sys->hdr.width, (int)sys->hdr.height,
                       (int)sys->hdr.width, (int)sys->hdr.height, 0, 1);
    dec->fmt_out.video.i_frame_rate = sys->hdr.fps_num;
    dec->fmt_out.video.i_frame_rate_base = sys->hdr.fps_den;
    dec->fmt_out.video.orientation = ORIENT_TOP_LEFT;

    dec->pf_decode = Decode;
    dec->pf_flush = Flush;
    qov_trace("vd: open complete %ux%u", sys->hdr.width, sys->hdr.height);
    return VLC_SUCCESS;
}

void qov_vlc_video_decoder_close(vlc_object_t *obj)
{
    decoder_t *dec = (decoder_t *)obj;
    video_dec_sys_t *sys = dec->p_sys;
    if (sys)
        qov_decoder_free(sys->dec);
}
