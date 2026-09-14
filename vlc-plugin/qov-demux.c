/* QOV demuxer module for VLC 3.0.x.
 *
 * Probes the "qovf" magic, exposes one QOV1 video ES plus an optional QOA1
 * audio ES, walks chunks in pf_demux and seeks via the keyframe INDEX chunk.
 */
#include "qov_pre.h"

#include <vlc_common.h>
#include <vlc_plugin.h>
#include <vlc_demux.h>
#include <vlc_es.h>
#include <vlc_block.h>

#include "../qov.h"
#include "qov-vlc.h"

struct demux_sys_t {
    es_out_id_t *video_es;
    es_out_id_t *audio_es;
    qov_header hdr;

    /* keyframe index for seeking */
    uint32_t *kf_frame;     /* frame numbers */
    uint64_t *kf_offset;    /* chunk header offsets */
    uint32_t *kf_ts;        /* microseconds */
    size_t kf_count;

    uint32_t frame_count;
    uint32_t audio_count;
    bool eof;
} ;

static size_t chunk_header_size(const qov_header *h)
{
    return h->version >= 2 ? 10 : 8;
}

static uint32_t chunk_payload_size(const qov_header *h, const uint8_t *hdr_bytes)
{
    return h->version >= 2 ? qov_vlc_be32(hdr_bytes + 2)
                           : (uint32_t)((hdr_bytes[2] << 8) | hdr_bytes[3]);
}

static uint32_t chunk_ts(const qov_header *h, const uint8_t *hdr_bytes)
{
    return h->version >= 2 ? qov_vlc_be32(hdr_bytes + 6)
                           : qov_vlc_be32(hdr_bytes + 4);
}

/* chunk timestamps are u32 microseconds and wrap on long files; the per-ES
   counters * frame duration stay exact */
static int64_t frame_pts_us(demux_sys_t *sys, uint32_t chunk_ts, bool audio)
{
    uint32_t counter = audio ? sys->audio_count : sys->frame_count;
    if (chunk_ts != 0)
        return (int64_t)chunk_ts;
    return (int64_t)counter * 1000000ll * sys->hdr.fps_den / sys->hdr.fps_num;
}

static int64_t frame_duration_us(demux_sys_t *sys)
{
    return (int64_t)sys->hdr.fps_den * 1000000ll / sys->hdr.fps_num;
}

static void free_index(demux_sys_t *sys)
{
    free(sys->kf_frame);
    free(sys->kf_offset);
    free(sys->kf_ts);
    sys->kf_frame = NULL;
    sys->kf_offset = NULL;
    sys->kf_ts = NULL;
    sys->kf_count = 0;
}

/* Reads the INDEX chunk (immediately before the END chunk at EOF).
   Layout: count u32 BE, then count x [frame u32 | offset u64 | ts u32]. */
static void load_index(demux_t *demux, demux_sys_t *sys)
{
    uint64_t file_size = 0;
    if (vlc_stream_GetSize(demux->s, &file_size) != VLC_SUCCESS || file_size < 128)
        return;

    size_t chdr = chunk_header_size(&sys->hdr);

    /* the END chunk (zero payload) sits at the very end */
    uint8_t tail[10];
    if (vlc_stream_Seek(demux->s, file_size - chdr) != VLC_SUCCESS)
        return;
    if (vlc_stream_Read(demux->s, tail, chdr) != (ssize_t)chdr)
        return;
    if (tail[0] != QOV_CHUNK_END)
        return;

    /* scan a bounded window backwards from END for the INDEX chunk header:
       header position P must satisfy P + chdr + csize == file_size - chdr
       with csize read from the header itself */
    uint64_t window = 4 + (uint64_t)16 * 100000 + 2 * chdr;
    if (window > file_size)
        window = file_size;
    uint64_t win_start = file_size - window;
    size_t wlen = (size_t)window;
    uint8_t *win = malloc(wlen);
    if (!win)
        return;
    if (vlc_stream_Seek(demux->s, win_start) != VLC_SUCCESS ||
        vlc_stream_Read(demux->s, win, (ssize_t)wlen) != (ssize_t)wlen) {
        free(win);
        return;
    }

    uint64_t payload_end = file_size - chdr; /* INDEX payload ends here */
    for (size_t i = 0; i + chdr <= wlen; i++) {
        if (win[i] != QOV_CHUNK_INDEX)
            continue;
        uint32_t csize = chunk_payload_size(&sys->hdr, win + i);
        uint64_t p = win_start + i;
        if (csize < 4 || (csize - 4) % 16 != 0 || csize > 4 + 1000000u * 16)
            continue;
        if (p + chdr + csize != payload_end)
            continue;
        if (i + chdr + csize > wlen) {
            free(win);
            return;
        }
        uint32_t count = (csize - 4) / 16;
        if (count == 0)
            break;

        uint32_t *kf_frame = malloc(sizeof(uint32_t) * count);
        uint64_t *kf_offset = malloc(sizeof(uint64_t) * count);
        uint32_t *kf_ts = malloc(sizeof(uint32_t) * count);
        if (!kf_frame || !kf_offset || !kf_ts) {
            free(kf_frame); free(kf_offset); free(kf_ts);
            break;
        }
        size_t n = 0;
        for (uint32_t k = 0; k < count; k++) {
            const uint8_t *e = win + i + chdr + 4 + (size_t)k * 16;
            uint64_t offset = ((uint64_t)qov_vlc_be32(e + 4) << 32) | qov_vlc_be32(e + 8);
            if (offset < sys->hdr.header_size || offset >= file_size)
                continue;
            kf_frame[n] = qov_vlc_be32(e);
            kf_offset[n] = offset;
            kf_ts[n] = qov_vlc_be32(e + 12);
            n++;
        }
        if (n > 0) {
            sys->kf_frame = kf_frame;
            sys->kf_offset = kf_offset;
            sys->kf_ts = kf_ts;
            sys->kf_count = n;
            msg_Dbg(demux, "qov: loaded keyframe index (%zu entries)", n);
        } else {
            free(kf_frame); free(kf_offset); free(kf_ts);
        }
        break;
    }
    free(win);
}

static int seek_to_keyframe(demux_t *demux, int64_t target_us)
{
    demux_sys_t *sys = demux->p_sys;
    if (sys->kf_count == 0)
        return VLC_EGENERIC;

    /* last keyframe at or before the target (keyframes are in file order) */
    size_t pick = 0;
    for (size_t i = 0; i < sys->kf_count; i++) {
        if ((int64_t)sys->kf_ts[i] <= target_us)
            pick = i;
        else
            break;
    }
    if (vlc_stream_Seek(demux->s, sys->kf_offset[pick]) != VLC_SUCCESS)
        return VLC_EGENERIC;
    sys->frame_count = sys->kf_frame[pick];
    sys->eof = false;
    es_out_Control(demux->out, ES_OUT_RESET_PCR);
    msg_Dbg(demux, "qov: seek to keyframe %u at %llu",
            sys->kf_frame[pick], (unsigned long long)sys->kf_offset[pick]);
    return VLC_SUCCESS;
}

static int Demux(demux_t *demux)
{
    demux_sys_t *sys = demux->p_sys;
    if (sys->eof)
        return 0;

    size_t chdr = chunk_header_size(&sys->hdr);
    uint8_t hdr_bytes[10];
    ssize_t got = vlc_stream_Read(demux->s, hdr_bytes, chdr);
    if (got == 0)
        return 0;
    if (got != (ssize_t)chdr)
        return -1;

    uint8_t ctype = hdr_bytes[0];
    uint32_t csize = chunk_payload_size(&sys->hdr, hdr_bytes);

    if (ctype == QOV_CHUNK_END) {
        sys->eof = true;
        return 0;
    }

    if (ctype == QOV_CHUNK_KEYFRAME || ctype == QOV_CHUNK_PFRAME) {
        /* ES format: complete chunk records (header + payload) */
        block_t *block = block_Alloc((size_t)chdr + csize);
        if (!block)
            return -1;
        memcpy(block->p_buffer, hdr_bytes, chdr);
        if (vlc_stream_Read(demux->s, block->p_buffer + chdr, csize) != (ssize_t)csize) {
            block_Release(block);
            return -1;
        }
        int64_t pts = VLC_TICK_0 + frame_pts_us(sys, chunk_ts(&sys->hdr, hdr_bytes), false);
        block->i_pts = pts;
        block->i_dts = pts;
        block->i_flags = ctype == QOV_CHUNK_KEYFRAME ? BLOCK_FLAG_TYPE_I : BLOCK_FLAG_TYPE_P;
        sys->frame_count++;
        es_out_Control(demux->out, ES_OUT_SET_PCR, (int64_t)pts);
#ifdef QOV_TRACE
        {
            FILE *qf = fopen("qov_trace.txt", "a");
            if (qf) { fprintf(qf, "dmx: video chunk type=%d size=%u pts=%lld", (int)ctype, csize, (long long)pts); fputc(10, qf); fclose(qf); }
        }
#endif
        es_out_Send(demux->out, sys->video_es, block);
        return 1;
    }

    if (ctype == QOV_CHUNK_AUDIO && sys->audio_es) {
        block_t *block = block_Alloc((size_t)chdr + csize);
        if (!block)
            return -1;
        memcpy(block->p_buffer, hdr_bytes, chdr);
        if (vlc_stream_Read(demux->s, block->p_buffer + chdr, csize) != (ssize_t)csize) {
            block_Release(block);
            return -1;
        }
        sys->audio_count++;
        int64_t pts = VLC_TICK_0 + frame_pts_us(sys, chunk_ts(&sys->hdr, hdr_bytes), true);
        block->i_pts = pts;
        block->i_dts = pts;
        es_out_Control(demux->out, ES_OUT_SET_PCR, (int64_t)pts);
#ifdef QOV_TRACE
        {
            FILE *qf = fopen("qov_trace.txt", "a");
            if (qf) { fprintf(qf, "dmx: audio chunk size=%u pts=%lld", csize, (long long)pts); fputc(10, qf); fclose(qf); }
        }
#endif
        es_out_Send(demux->out, sys->audio_es, block);
        return 1;
    }

    /* SYNC / BFRAME / INDEX / unknown: skip the payload */
    uint32_t left = csize;
    uint8_t sink[4096];
    while (left > 0) {
        uint32_t take = left < sizeof sink ? left : (uint32_t)sizeof sink;
        ssize_t rd = vlc_stream_Read(demux->s, sink, take);
        if (rd <= 0)
            return -1;
        left -= (uint32_t)rd;
    }
    return 1;
}

static int Control(demux_t *demux, int query, va_list args)
{
    demux_sys_t *sys = demux->p_sys;

    switch (query) {
    case DEMUX_CAN_SEEK: {
        bool *b = va_arg(args, bool *);
        *b = sys->kf_count > 0;
        return VLC_SUCCESS;
    }
    case DEMUX_GET_TIME: {
        int64_t *t = va_arg(args, int64_t *);
        *t = (int64_t)sys->frame_count * frame_duration_us(sys);
        return VLC_SUCCESS;
    }
    case DEMUX_GET_LENGTH: {
        int64_t *l = va_arg(args, int64_t *);
        if (sys->hdr.total_frames > 0)
            *l = (int64_t)sys->hdr.total_frames * frame_duration_us(sys);
        else
            *l = -1;
        return VLC_SUCCESS;
    }
    case DEMUX_GET_POSITION: {
        double *pos = va_arg(args, double *);
        if (sys->hdr.total_frames > 0)
            *pos = (double)sys->frame_count / sys->hdr.total_frames;
        else
            *pos = 0.0;
        return VLC_SUCCESS;
    }
    case DEMUX_SET_POSITION: {
        double pos = va_arg(args, double);
        if (sys->kf_count == 0 || sys->hdr.total_frames == 0)
            return VLC_EGENERIC;
        int64_t target_us = (int64_t)(pos * sys->hdr.total_frames) * frame_duration_us(sys);
        return seek_to_keyframe(demux, target_us);
    }
    case DEMUX_SET_TIME: {
        int64_t target_us = va_arg(args, int64_t);
        VLC_UNUSED((bool)va_arg(args, int)); /* precise */
        return seek_to_keyframe(demux, target_us);
    }
    }
    return VLC_EGENERIC;
}

static int Open(vlc_object_t *obj)
{
    demux_t *demux = (demux_t *)obj;

    const uint8_t *peek;
    ssize_t peeked = vlc_stream_Peek(demux->s, &peek, 32);
    if (peeked < 24)
        return VLC_EGENERIC;
    if (peek[0] != 'q' || peek[1] != 'o' || peek[2] != 'v' || peek[3] != 'f')
        return VLC_EGENERIC;

    demux_sys_t *sys = vlc_obj_calloc(obj, 1, sizeof(*sys));
    if (!sys)
        return VLC_ENOMEM;

    qov_result r = qov_decode_header(peek, peeked, &sys->hdr);
    if (r != QOV_OK) {
        msg_Dbg(demux, "qov: header probe failed (%d)", r);
        return VLC_EGENERIC;
    }

    demux->p_sys = sys;
    demux->pf_demux = Demux;
    demux->pf_control = Control;
    msg_Dbg(demux, "qov: %ux%u fps %u/%u colorspace 0x%02x audio ch=%u rate=%u",
            sys->hdr.width, sys->hdr.height, sys->hdr.fps_num, sys->hdr.fps_den,
            sys->hdr.colorspace, sys->hdr.audio_channels, sys->hdr.audio_rate);

    /* video ES: opaque QOV1 bitstream, qov header passed as extra data */
    es_format_t fmt;
    es_format_Init(&fmt, VIDEO_ES, QOV_VLC_VIDEO_FOURCC);
    fmt.video.i_width = sys->hdr.width;
    fmt.video.i_visible_width = sys->hdr.width;
    fmt.video.i_height = sys->hdr.height;
    fmt.video.i_visible_height = sys->hdr.height;
    fmt.video.i_frame_rate = sys->hdr.fps_num;
    fmt.video.i_frame_rate_base = sys->hdr.fps_den;
    fmt.i_extra = (int)sys->hdr.header_size;
    fmt.p_extra = malloc(sys->hdr.header_size);
    if (!fmt.p_extra) {
        es_format_Clean(&fmt);
        return VLC_ENOMEM;
    }
    memcpy(fmt.p_extra, peek, sys->hdr.header_size);
    sys->video_es = es_out_Add(demux->out, &fmt);
    es_format_Clean(&fmt);
    if (!sys->video_es)
        return VLC_EGENERIC;

    /* audio ES: raw QOA frames (decoded by the QOA1 audio decoder submodule) */
    if (sys->hdr.audio_channels > 0 && sys->hdr.audio_rate > 0) {
        es_format_Init(&fmt, AUDIO_ES, QOV_VLC_AUDIO_FOURCC);
        fmt.audio.i_rate = sys->hdr.audio_rate;
        fmt.audio.i_channels = sys->hdr.audio_channels;
        fmt.audio.i_physical_channels = sys->hdr.audio_channels > 1 ? AOUT_CHANS_STEREO : AOUT_CHAN_CENTER;
        fmt.i_extra = (int)sys->hdr.header_size;
        fmt.p_extra = malloc(sys->hdr.header_size);
        if (!fmt.p_extra) {
            es_format_Clean(&fmt);
            return VLC_ENOMEM;
        }
        memcpy(fmt.p_extra, peek, sys->hdr.header_size);
        sys->audio_es = es_out_Add(demux->out, &fmt);
        es_format_Clean(&fmt);
    }

    load_index(demux, sys);
    if (vlc_stream_Seek(demux->s, sys->hdr.header_size) != VLC_SUCCESS)
        msg_Warn(demux, "qov: cannot rewind after index probe");

    return VLC_SUCCESS;
}

static void Close(vlc_object_t *obj)
{
    demux_t *demux = (demux_t *)obj;
    demux_sys_t *sys = demux->p_sys;
    free_index(sys);
}

vlc_module_begin()
    set_shortname("QOV")
    set_description(N_("QOV (Quite OK Video) demuxer"))
    set_capability("demux", 230)
    set_callbacks(Open, Close)
    add_shortcut("qov")

#ifndef DEMUX_ONLY
    add_submodule()
    set_shortname("QOV")
    set_description(N_("QOV (Quite OK Video) video decoder"))
    set_capability("video decoder", 70)
    set_callbacks(qov_vlc_video_decoder_open, qov_vlc_video_decoder_close)
    add_shortcut("qov")
#endif
#ifndef AUDIO_ENC_MUX
    add_submodule()
    set_shortname("QOA")
    set_description(N_("QOA (Quite OK Audio) decoder"))
    set_capability("audio decoder", 70)
    set_callbacks(qov_vlc_audio_decoder_open, qov_vlc_audio_decoder_close)
    add_shortcut("qov")

    add_submodule()
    set_shortname("QOV")
    set_description(N_("QOV (Quite OK Video) video encoder"))
    set_capability("encoder", 60)
    set_callbacks(qov_vlc_video_encoder_open, qov_vlc_video_encoder_close)
    add_shortcut("qov")
    add_integer("sout-qov-keyint", 150, N_("Keyframe interval"),
                N_("Number of frames between keyframes (0 = first frame only)"), true)
    add_integer("sout-qov-lz4", 1, N_("LZ4 chunk compression"),
                N_("Compress frame chunks with LZ4"), true)

    add_submodule()
    set_shortname("QOV")
    set_description(N_("QOV (Quite OK Video) muxer"))
    set_capability("sout mux", 60)
    set_callbacks(qov_vlc_mux_open, qov_vlc_mux_close)
    add_shortcut("qov")
#endif
vlc_module_end()
