/* QOA audio decoder module for VLC 3.0.x: raw QOA frames -> S16N blocks. */
#include "qov_pre.h"

#include <vlc_common.h>
#include <vlc_plugin.h>
#include <vlc_codec.h>
#include <vlc_es.h>

#include "../qov.h"
#include "qov-vlc.h"

struct decoder_sys_t {
    qov_decoder *dec;   /* video-free context used only for AUDIO chunks */
    qov_header hdr;
    bool aout_ready;
};
typedef struct decoder_sys_t audio_dec_sys_t;

static int Decode(decoder_t *dec, block_t *block)
{
    audio_dec_sys_t *sys = dec->p_sys;
    if (!block)
        return VLCDEC_SUCCESS;
    if (block->i_flags & BLOCK_FLAG_CORRUPTED) {
        block_Release(block);
        return VLCDEC_SUCCESS;
    }

    vlc_tick_t pts = block->i_pts != VLC_TICK_INVALID ? block->i_pts : block->i_dts;

    /* ES carries complete chunk records; the chunk header size follows from
       the qov file version the demuxer attached as extra data */
    size_t chdr = sys->hdr.version >= 2 ? 10 : 8;
    if (block->i_buffer <= chdr || block->p_buffer[0] != QOV_CHUNK_AUDIO) {
        block_Release(block);
        return VLCDEC_SUCCESS;
    }
    qov_audio aud;
    qov_result r = qov_decoder_feed(sys->dec, QOV_CHUNK_AUDIO, block->p_buffer[1],
                                    block->p_buffer + chdr, block->i_buffer - chdr,
                                    0, NULL, &aud);
    block_Release(block);
    if (r != QOV_OK || aud.sample_count == 0)
        return VLCDEC_SUCCESS;

    if (!sys->aout_ready) {
        if (decoder_UpdateAudioFormat(dec) != 0)
            return VLCDEC_SUCCESS; /* no aout; drop */
        sys->aout_ready = true;
    }
    block_t *out = decoder_NewAudioBuffer(dec, (unsigned)aud.sample_count);
    if (!out)
        return VLCDEC_SUCCESS;
    memcpy(out->p_buffer, aud.samples, aud.sample_count * aud.channels * 2);
    out->i_nb_samples = (unsigned)aud.sample_count;
    out->i_pts = pts;
    out->i_dts = out->i_pts;
    decoder_QueueAudio(dec, out);
    return VLCDEC_SUCCESS;
}

static void Flush(decoder_t *dec)
{
    audio_dec_sys_t *sys = dec->p_sys;
    qov_decoder_reset(sys->dec);
    sys->aout_ready = false;
}

int qov_vlc_audio_decoder_open(vlc_object_t *obj)
{
    decoder_t *dec = (decoder_t *)obj;

    if (dec->fmt_in.i_codec != QOV_VLC_AUDIO_FOURCC)
        return VLC_EGENERIC;
    if (dec->fmt_in.audio.i_rate == 0 || dec->fmt_in.audio.i_channels == 0)
        return VLC_EGENERIC;

    audio_dec_sys_t *sys = vlc_obj_calloc(obj, 1, sizeof(*sys));
    if (!sys)
        return VLC_ENOMEM;

    memset(&sys->hdr, 0, sizeof(sys->hdr));
    sys->hdr.version = 2;
    sys->hdr.header_size = 24;
    sys->hdr.audio_channels = (uint8_t)dec->fmt_in.audio.i_channels;
    sys->hdr.audio_rate = dec->fmt_in.audio.i_rate;
    /* video fields are unused by the AUDIO path but must be non-degenerate */
    sys->hdr.width = 16;
    sys->hdr.height = 16;
    sys->hdr.fps_num = 1;
    sys->hdr.fps_den = 1;
    sys->hdr.colorspace = QOV_CS_SRGB;

    qov_result r = qov_decoder_new(&sys->hdr, &sys->dec);
    if (r != QOV_OK) {
        msg_Err(dec, "qoa: decoder init failed (%d)", r);
        return VLC_EGENERIC;
    }
    dec->p_sys = sys;

    dec->fmt_out.i_codec = VLC_CODEC_S16N;
    dec->fmt_out.audio.i_rate = dec->fmt_in.audio.i_rate;
    dec->fmt_out.audio.i_channels = dec->fmt_in.audio.i_channels;
    dec->fmt_out.audio.i_physical_channels = dec->fmt_in.audio.i_channels > 1
        ? AOUT_CHANS_STEREO : AOUT_CHAN_CENTER;
    dec->fmt_out.audio.i_format = VLC_CODEC_S16N;

    dec->pf_decode = Decode;
    dec->pf_flush = Flush;
    return VLC_SUCCESS;
}

void qov_vlc_audio_decoder_close(vlc_object_t *obj)
{
    decoder_t *dec = (decoder_t *)obj;
    audio_dec_sys_t *sys = dec->p_sys;
    if (sys)
        qov_decoder_free(sys->dec);
}
