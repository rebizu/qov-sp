/* qov-vlc.h - shared definitions for the QOV VLC 3.0.x plugin modules */
#ifndef QOV_VLC_H
#define QOV_VLC_H

/* the VLC sdk headers do not ship the gettext shims */
#ifndef N_
#define N_(s) (s)
#endif

#define QOV_VLC_VIDEO_FOURCC VLC_FOURCC('Q','O','V','1')
#define QOV_VLC_AUDIO_FOURCC VLC_FOURCC('Q','O','A','1')

/* chunk types (qov-specification.md section 2) */
#define QOV_CHUNK_SYNC      0x00
#define QOV_CHUNK_KEYFRAME  0x01
#define QOV_CHUNK_PFRAME    0x02
#define QOV_CHUNK_BFRAME    0x03
#define QOV_CHUNK_AUDIO     0x10
#define QOV_CHUNK_INDEX     0xF0
#define QOV_CHUNK_END       0xFF
#define QOV_CHUNK_FLAG_COMPRESSED 0x10

static inline uint32_t qov_vlc_be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

/* crash-proof debug trace (survives segfaults, unlike the VLC logger) */
#include <stdio.h>
#ifdef QOV_TRACE
#define qov_trace(...) do { FILE *qf = fopen("qov_trace.txt", "a");     if (qf) { fprintf(qf, __VA_ARGS__); fputc(10, qf); fclose(qf); } } while (0)
#else
#define qov_trace(...) do { } while (0)
#endif

/* module callbacks (all live in one plugin DLL) */
int qov_vlc_video_decoder_open(vlc_object_t *);
void qov_vlc_video_decoder_close(vlc_object_t *);
int qov_vlc_audio_decoder_open(vlc_object_t *);
void qov_vlc_audio_decoder_close(vlc_object_t *);
int qov_vlc_video_encoder_open(vlc_object_t *);
void qov_vlc_video_encoder_close(vlc_object_t *);
int qov_vlc_mux_open(vlc_object_t *);
void qov_vlc_mux_close(vlc_object_t *);

#endif
