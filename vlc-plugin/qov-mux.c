/* QOV muxer module for VLC 3.0.x: wraps a QOV1 video ES (encoder chunk bytes)
 * and an optional QOA1 audio ES into a .qov container, with keyframe INDEX.
 *
 * The video encoder emits complete SYNC+KEYFRAME/PFRAME chunks, so the muxer
 * writes those verbatim; audio QOA1 blocks become AUDIO chunk payloads.
 * The whole file is streamed to the sout access; the keyframe index is
 * written at close.
 */
#include "qov_pre.h"

#include <vlc_common.h>
#include <vlc_plugin.h>
#include <vlc_sout.h>
#include <vlc_es.h>
#include <vlc_block.h>

#include "../qov.h"
#include "qov-vlc.h"

struct sout_mux_sys_t {
    sout_input_t *video;
    sout_input_t *audio;
    bool header_written;
    bool eof_written;
    uint64_t bytes_written;
    uint32_t total_frames;
    uint32_t audio_channels;
    uint32_t audio_rate;

    uint32_t *kf_frame;
    uint64_t *kf_offset;
    uint32_t *kf_ts;
    size_t kf_count, kf_cap;
};
typedef struct sout_mux_sys_t mux_sys_t;

static block_t *write_access(mux_sys_t *sys, sout_mux_t *mux, const uint8_t *data, size_t len)
{
    block_t *b = block_Alloc(len);
    if (!b)
        return NULL;
    memcpy(b->p_buffer, data, len);
    sys->bytes_written += len;
    sout_AccessOutWrite(mux->p_access, b);
    return NULL;
}

static void write_header(mux_sys_t *sys, sout_mux_t *mux)
{
    sout_input_t *v = sys->video;
    const es_format_t *vfmt = &v->fmt;
    uint32_t w = vfmt->video.i_visible_width ? vfmt->video.i_visible_width : vfmt->video.i_width;
    uint32_t h = vfmt->video.i_visible_height ? vfmt->video.i_visible_height : vfmt->video.i_height;
    uint32_t fps_num = vfmt->video.i_frame_rate ? vfmt->video.i_frame_rate : 30;
    uint32_t fps_den = vfmt->video.i_frame_rate_base ? vfmt->video.i_frame_rate_base : 1;

    uint8_t hdr[24];
    memcpy(hdr, "qovf", 4);
    hdr[4] = 2; /* version 2, lossless */
    hdr[5] = QOV_F_HAS_INDEX;
    uint32_t wh = (w << 16) | (h & 0xFFFF);
    uint32_t fps = (fps_num << 16) | (fps_den & 0xFFFF);
    hdr[6] = (uint8_t)(wh >> 24);  hdr[7] = (uint8_t)(wh >> 16);
    hdr[8] = (uint8_t)(wh >> 8);   hdr[9] = (uint8_t)wh;
    hdr[10] = (uint8_t)(fps >> 24); hdr[11] = (uint8_t)(fps >> 16);
    hdr[12] = (uint8_t)(fps >> 8);  hdr[13] = (uint8_t)fps;
    memset(hdr + 14, 0, 4); /* total frames patched at close */
    hdr[18] = (uint8_t)sys->audio_channels;
    hdr[19] = (uint8_t)((sys->audio_rate >> 16) & 0xff);
    hdr[20] = (uint8_t)((sys->audio_rate >> 8) & 0xff);
    hdr[21] = (uint8_t)(sys->audio_rate & 0xff);
    hdr[22] = QOV_CS_SRGB;
    hdr[23] = 0; /* quality */
    write_access(sys, mux, hdr, sizeof hdr);
    sys->header_written = true;
}

static void mux_video_block(mux_sys_t *sys, sout_mux_t *mux, block_t *block)
{
    /* The block holds complete chunks (SYNC + KEYFRAME, or PFRAME) produced
       by the QOV video encoder; scan for keyframe offsets for the index. */
    size_t pos = 0;
    uint8_t *p = block->p_buffer;
    while (pos + 10 <= block->i_buffer) {
        uint8_t type = p[pos];
        uint32_t csize = qov_vlc_be32(p + pos + 2);
        if (pos + 10 + csize > block->i_buffer) {
            msg_Warn(mux, "qov mux: truncated chunk in encoder block");
            break;
        }
        if (type == QOV_CHUNK_KEYFRAME && sys->kf_count < 1000000u) {
            if (sys->kf_count == sys->kf_cap) {
                size_t ncap = sys->kf_cap ? sys->kf_cap * 2 : 64;
                uint32_t *nf = realloc(sys->kf_frame, ncap * sizeof(uint32_t));
                uint64_t *nof = realloc(sys->kf_offset, ncap * sizeof(uint64_t));
                uint32_t *nts = realloc(sys->kf_ts, ncap * sizeof(uint32_t));
                if (nf) sys->kf_frame = nf;
                if (nof) sys->kf_offset = nof;
                if (nts) sys->kf_ts = nts;
                if (!nf || !nof || !nts)
                    break;
                sys->kf_cap = ncap;
            }
            uint32_t frame = qov_vlc_be32(p + pos + 14);
            uint32_t ts = qov_vlc_be32(p + pos + 6);
            sys->kf_frame[sys->kf_count] = frame;
            sys->kf_offset[sys->kf_count] = sys->bytes_written + pos;
            sys->kf_ts[sys->kf_count] = ts;
            sys->kf_count++;
        }
        if (type == QOV_CHUNK_KEYFRAME || type == QOV_CHUNK_PFRAME) {
            sys->total_frames++;
            qov_trace("mux: video chunk type=%d size=%u", (int)type, csize);
        }
        pos += 10 + csize;
    }
    write_access(sys, mux, p, block->i_buffer);
}

static void drain_fifo(mux_sys_t *sys, sout_mux_t *mux, sout_input_t *input);

static int Mux(sout_mux_t *mux)
{
    mux_sys_t *sys = mux->p_sys;
    qov_trace("mux: pf_mux inputs=%d hdr=%d", mux->i_nb_inputs, (int)sys->header_written);
    if (!sys->header_written)
        write_header(sys, mux);

    for (int i = 0; i < mux->i_nb_inputs; i++) {
        sout_input_t *input = mux->pp_inputs[i];
        block_t *block;
        /* block_FifoGet blocks, so only pull when data is queued */
        while (block_FifoCount(input->p_fifo) > 0 &&
               (block = block_FifoGet(input->p_fifo)) != NULL) {
            if (input == sys->video) {
                mux_video_block(sys, mux, block);
            } else if (input == sys->audio) {
                /* QOA1 ES carries complete AUDIO chunk records; pass through */
                qov_trace("mux: audio block %d bytes", (int)block->i_buffer);
                write_access(sys, mux, block->p_buffer, block->i_buffer);
            }
            block_Release(block);
        }
    }
    return VLC_SUCCESS;
}

static int AddStream(sout_mux_t *mux, sout_input_t *input)
{
    mux_sys_t *sys = mux->p_sys;
    qov_trace("mux: AddStream codec=%4.4s", (const char*)&input->fmt.i_codec);

    if (input->fmt.i_codec == QOV_VLC_VIDEO_FOURCC && !sys->video) {
        sys->video = input;
        msg_Dbg(mux, "qov mux: video %ux%u",
                input->fmt.video.i_width, input->fmt.video.i_height);
        return VLC_SUCCESS;
    }
    if (input->fmt.i_codec == QOV_VLC_AUDIO_FOURCC && !sys->audio) {
        sys->audio = input;
        sys->audio_channels = input->fmt.audio.i_channels;
        sys->audio_rate = input->fmt.audio.i_rate;
        msg_Dbg(mux, "qov mux: audio ch=%u rate=%u", sys->audio_channels, sys->audio_rate);
        return VLC_SUCCESS;
    }
    msg_Err(mux, "qov mux: unsupported stream codec 0x%08x", input->fmt.i_codec);
    return VLC_EGENERIC;
}

static void DelStream(sout_mux_t *mux, sout_input_t *input)
{
    mux_sys_t *sys = mux->p_sys;
    qov_trace("mux: DelStream video=%d fifocount=%zu", input == sys->video,
              block_FifoCount(input->p_fifo));
    /* sout tears streams down before mux close: flush this stream now */
    drain_fifo(sys, mux, input);
}

int qov_vlc_mux_open(vlc_object_t *obj)
{
    sout_mux_t *mux = (sout_mux_t *)obj;
    qov_trace("mux: open enter");

    mux_sys_t *sys = vlc_obj_calloc(obj, 1, sizeof(*sys));
    if (!sys)
        return VLC_ENOMEM;
    mux->p_sys = sys;
    mux->pf_addstream = AddStream;
    mux->pf_delstream = DelStream;
    mux->pf_mux = Mux;
    /* VLC gates pf_mux behind sout-mux-caching (default 1500 ms) while
       b_waiting_stream is true; files shorter than that would lose their
       tail. Mux immediately instead - which also requires declaring that
       streams may be added at any time. */
    mux->b_waiting_stream = false;
    mux->b_add_stream_any_time = true;
    msg_Dbg(mux, "qov mux: open");
    return VLC_SUCCESS;
}

static void drain_fifo(mux_sys_t *sys, sout_mux_t *mux, sout_input_t *input)
{
    while (block_FifoCount(input->p_fifo) > 0) {
        block_t *block = block_FifoGet(input->p_fifo);
        if (input == sys->video)
            mux_video_block(sys, mux, block);
        else if (input == sys->audio)
            write_access(sys, mux, block->p_buffer, block->i_buffer);
        block_Release(block);
    }
}

void qov_vlc_mux_close(vlc_object_t *obj)
{
    sout_mux_t *mux = (sout_mux_t *)obj;
    mux_sys_t *sys = mux->p_sys;
    if (!sys)
        return;

    qov_trace("mux: close inputs=%d written=%llu eof=%d", mux->i_nb_inputs,
              (unsigned long long)sys->bytes_written, (int)sys->eof_written);
    if (sys->header_written && !sys->eof_written) {
        /* flush whatever is still queued when the sout tears down */
        for (int i = 0; i < mux->i_nb_inputs; i++) {
            qov_trace("mux: drain fifo %d count=%zu", i, block_FifoCount(mux->pp_inputs[i]->p_fifo));
            drain_fifo(sys, mux, mux->pp_inputs[i]);
        }
        /* INDEX chunk */
        if (sys->kf_count > 0) {
            size_t payload = 4 + sys->kf_count * 16;
            size_t total = 10 + payload;
            uint8_t *buf = malloc(total);
            if (buf) {
                buf[0] = QOV_CHUNK_INDEX;
                buf[1] = 0;
                buf[2] = (uint8_t)(payload >> 24); buf[3] = (uint8_t)(payload >> 16);
                buf[4] = (uint8_t)(payload >> 8);  buf[5] = (uint8_t)payload;
                buf[6] = buf[7] = buf[8] = buf[9] = 0;
                memset(buf + 10, 0, 4);
                for (size_t i = 0; i < sys->kf_count; i++) {
                    uint8_t *e = buf + 14 + i * 16;
                    uint32_t frame = sys->kf_frame[i];
                    uint64_t offset = sys->kf_offset[i];
                    uint32_t ts = sys->kf_ts[i];
                    e[0] = (uint8_t)(frame >> 24); e[1] = (uint8_t)(frame >> 16);
                    e[2] = (uint8_t)(frame >> 8);  e[3] = (uint8_t)frame;
                    e[4] = (uint8_t)(offset >> 56); e[5] = (uint8_t)(offset >> 48);
                    e[6] = (uint8_t)(offset >> 40); e[7] = (uint8_t)(offset >> 32);
                    e[8] = (uint8_t)(offset >> 24); e[9] = (uint8_t)(offset >> 16);
                    e[10] = (uint8_t)(offset >> 8); e[11] = (uint8_t)offset;
                    e[12] = (uint8_t)(ts >> 24); e[13] = (uint8_t)(ts >> 16);
                    e[14] = (uint8_t)(ts >> 8);  e[15] = (uint8_t)ts;
                }
                write_access(sys, mux, buf, total);
                free(buf);
            }
        }
        /* END chunk */
        uint8_t end[10] = { QOV_CHUNK_END, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
        write_access(sys, mux, end, 10);

        /* patch total frames in the header */
        block_t *patch = block_Alloc(4);
        if (patch) {
            uint32_t tf = sys->total_frames;
            patch->p_buffer[0] = (uint8_t)(tf >> 24);
            patch->p_buffer[1] = (uint8_t)(tf >> 16);
            patch->p_buffer[2] = (uint8_t)(tf >> 8);
            patch->p_buffer[3] = (uint8_t)tf;
            if (sout_AccessOutSeek(mux->p_access, 14) == VLC_SUCCESS)
                sout_AccessOutWrite(mux->p_access, patch);
            else
                block_Release(patch);
        }
        sys->eof_written = true;
    }

    free(sys->kf_frame);
    free(sys->kf_offset);
    free(sys->kf_ts);
}
