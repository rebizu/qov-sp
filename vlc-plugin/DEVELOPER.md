# QOV VLC plugin — developer notes

This document exists so nobody has to re-derive the hard-won knowledge in
this plugin. Every "weird" line here exists because VLC did something
surprising. Read it before modifying the plugin. For build/install/usage
see [README.md](README.md).

## Architecture

One DLL (`qovplug.dll`), five VLC modules sharing one `vlc_module_begin()`
descriptor block in `qov-demux.c`:

```
.qov file
   │  content probe: "qovf" magic
   ▼
qov-demux.c (capability "demux")
   │  es_out: video ES fourcc QOV1, audio ES fourcc QOA1
   │  ES payload = complete chunk records (chunk header + payload)
   │  qov file header (24/32 bytes) rides as ES extra data on BOTH ES
   ▼                          ▼
qov-decoder.c             qov-audio.c
("video decoder")         ("audio decoder")
qov_decoder_feed()        qov_decoder_feed(AUDIO)
→ RGBA pictures           → S16N blocks
   │                          │
   └────────── VLC core playback ──────────

sout path (remux/transcode):
qov-encoder.c ("encoder")   → QOV1 chunk records (SYNC+KEY / PFRAME)
qov-mux.c ("sout mux")      → writes header/chunks/INDEX/END verbatim
```

The ES format contract matters: the demuxer sends **full chunk records**
(10-byte v2/v3 header + payload, 8-byte for v1), not bare payloads. That is
what allows the muxer to write remuxed data verbatim and keeps the encoder
(a producer of the same shape) interchangeable. If you change this, change
demuxer, both decoders, encoder, and muxer together.

Chunk walking lives in the demuxer only; payload decoding (LZ4, DCT, QOI
ops, QOA) lives in `qov.h` behind `qov_decoder_feed()`, which takes the
chunk type/flags and handles decompression internally.

## VLC module API traps

Each of these caused a real bug. Do not "clean them up" without reading
this.

### Capability strings are exact and unintuitive

| Module          | Capability       | NOT                                        |
|-----------------|------------------|--------------------------------------------|
| demuxer         | `demux`          |                                            |
| video decoder   | `video decoder`  |                                            |
| audio decoder   | `audio decoder`  |                                            |
| video encoder   | `encoder`        | `video encoder` (never matches transcode!)  |
| muxer           | `sout mux`       | `mux` (space, "no sout mux modules matched")|

Evidence: `modules/stream_out/transcode/video.c` probes with
`module_need(..., "encoder", venc, true)`; `src/stream_output/stream_output.c`
probes `"sout mux"`. The wiki "How to write a module" page does not list
these; the only reliable sources are the VLC sources for the version you
target.

### Decoders: `decoder_UpdateVideoFormat` before the first `decoder_NewPicture`

The SDK header says it outright: *"The behaviour is undefined if
decoder_UpdateVideoFormat() was not called"*. Undefined here means
segfault: `pf_vout_buffer_new` dereferences a vout that was never attached.
Same pattern for audio: `decoder_UpdateAudioFormat` before
`decoder_NewAudioBuffer`. Both are lazily called once per (re)format and
reset in `pf_flush` — keep it that way.

### Decoders/encoders: block/picture ownership

- A block passed to `pf_decode` is owned by the module — release it on
  every path (corrupted, decode error, success). Capture `i_pts` before
  `block_Release`; the pointer is dead after.
- Pictures from `decoder_NewPicture` must go through `decoder_QueueVideo`;
  qov_image output from `qov.h` is a **reused internal buffer** — copy into
  the picture immediately (row-by-row: pictures have aligned `i_pitch`,
  `qov_image` is tightly packed `w*4`).

### Encoder Open: the probe pass has no chroma

transcode probes encoders **twice**. The first pass is an availability test
with `fmt_in.video.i_chroma == 0` (source says so in a comment: "we
actually only test the availability of the encoder here"). If Open rejects
on chroma, the probe fails with "cannot find video encoder". After the
decoder's real output format is known, transcode re-probes / reconfigures
with the actual chroma. So:

- do not reject based on `fmt_in` chroma in Open;
- announce the input you want: `enc->fmt_in.video.i_chroma =
  VLC_CODEC_I420` — transcode builds its converter chain targeting this,
  and a zero chroma there makes the chain fail ("Failed to create video
  converter" → "cannot continue streaming due to errors with codec h264");
- adapt per picture at encode time (EncodeVideo handles RGBA and I420).

### Muxer: the waiting/caching gate and stream lifetime

- VLC gates `pf_mux` calls: while `b_waiting_stream` is true (the default),
  blocks are FIFO'd and muxing only starts after the first dts crosses
  `sout-mux-caching` (default **1500 ms**). Files shorter than that would
  produce nothing until teardown and lose their tail. Hence
  `b_waiting_stream = false`.
- With waiting disabled, `sout_MuxAddStream` demands
  `b_add_stream_any_time = true` or it refuses every stream ("cannot add a
  new stream"). Both flags must be set together.
- `block_FifoGet` **blocks** on an empty FIFO. Drain loops must check
  `block_FifoCount` first (the function is VLC-deprecated but works and is
  what stock code of this era uses).
- **sout deletes streams before the muxer is closed.** Anything still
  queued must be flushed in `pf_delstream` (DelStream); by the time
  `Close` runs, `mux->i_nb_inputs` is 0 and the FIFOs are gone. This is
  why the last video frame + last audio chunk were lost until DelStream
  drained.
- The demuxer side must send `ES_OUT_SET_PCR` (VLC_TICK_0-based) or VLC
  logs "Timestamp conversion failed ... no reference clock" and A/V sync
  suffers.

### Timestamps

VLC ticks are **microseconds** (`CLOCK_FREQ == 1000000`), so a qov chunk
timestamp in µs maps 1:1; VLC wants `VLC_TICK_0 + ts` (0/1 is an invalid
marker). The chunk field itself is u32 µs and wraps at ~71.6 min, which is
why the demuxer synthesizes pts from per-ES frame counters × frame duration
whenever a chunk ts is 0 — keep the two counters (video/audio) separate,
a shared counter misdates audio.

### Scores

Probe order is descending score, first Open win. Score 0 modules are only
loaded when named explicitly. Our scores (demux 230, decoders 70, encoder
60, mux 60) were chosen to sit below stock generic handlers but win once
the fourcc/shortcut matches; transcode requests `venc=qov` by shortcut, so
the encoder score barely matters.

## Windows module loading (the silent-failure minefield)

- **A DLL dropped into `plugins\` is silently ignored** until the module
  cache is regenerated: run `vlc-cache-gen.exe <absolute plugins dir>`
  (ships with VLC). There is no error, no log line — the DLL just never
  appears in `--list`. Deleting `plugins.dat` also works (VLC rebuilds it).
- File name must match `lib<name>_plugin.dll` (lowercase), e.g.
  `libqov_plugin.dll`.
- `VLC_PLUGIN_PATH` and `--plugin-path` are **dead** in 3.0.x
  ("option no longer exists"). Per-user plugin dirs do not exist on Windows.
- `--reset-plugins-cache` is the documented cache-buster (wiki), equivalent
  to deleting `plugins.dat`.
- Deterministic test loop (each step has bitten us):
  1. `taskkill /IM vlc.exe /F` — zombie VLCs lock the DLL,
  2. build to `vlc-plugin/qovplug.dll` and **copy that exact file** into
     the target `plugins\codec\` — building straight into one path and then
     copying from the other silently redeploys a stale DLL,
  3. delete `plugins.dat` or run `vlc-cache-gen.exe`,
  4. verify `vlc -I dummy --list` shows 5 qov modules before any playback
     test.

## Build system traps

- VLC 3.0 plugin headers are **GCC-only**. There are no `_MSC_VER` paths;
  MSVC fails inside `vlc_common.h`/`vlc_arrays.h` (`_Generic`, ssize_t).
  Don't try; use mingw-w64.
- Required defines: `-D__PLUGIN__` (entry symbol becomes
  `vlc_entry__<ABI>`, e.g. `vlc_entry__3_0_0f` — ABI-suffixed, so a plugin
  built against 3.0.x loads only that series), `-DHAVE_POLL=1`,
  `-DMODULE_STRING='"qov"'`.
- Do **not** define `VLC_MODULE_NAME`: it is an enum member in
  `vlc_plugin.h`, and defining it as a macro breaks the enum parse.
- Link `libvlc.lib` + `libvlccore.lib` from the SDK (MSVC-style COFF import
  libs link fine with mingw ld).
- `qov_pre.h` must be included **before any vlc_*.h**: `vlc_threads.h`
  calls `poll()` on Windows without a declaration and mingw has no
  `poll.h`; `qov_poll.c` provides a never-called stub.
- The SDK lacks the gettext shims; `N_()` is defined in `qov-vlc.h`.
- `qov_codec.c` is the only TU with `QOV_IMPLEMENTATION`; everything else
  includes `qov.h` for declarations. The muxer/decoder/encoder sys structs
  are definitions of VLC's opaque `struct decoder_sys_t` /
  `struct sout_mux_sys_t` — do not turn them back into typedefs (the
  typedefs already exist in the headers).
- `block_FifoCount` is deprecated upstream but is the only non-blocking
  length check in 3.0; expect the warning.

## qov.h-side contract

- `qov_decoder_new/feed/reset/free`: feed one raw chunk payload per call
  (COMPRESSED flag handled inside); output buffers are reused and valid
  only until the next feed/reset/free — copy out (the VLC decoder does).
  `qov_decoder_reset` after seeks that land on a keyframe.
- `qov_encoder_take_chunks` streams chunks out of the nominally
  whole-buffer encoder without changing the bitstream; the header stays at
  buffer start so recorded keyframe offsets remain absolute.
- Embedded QOA is a byte-exact mirror of the (reference-aligned) TS
  implementation — do not swap in upstream `qoa_encode`; encoders differ by
  quantization policy and conformance compares bytes. Upstream `qoa.h`
  (vendored at repo root, decode-only usage) was proven decode-identical.
- Any qov.h change must keep `npm run conformance` GREEN (20 cases × 8
  steps, includes byte-identical C encode).

## Debugging recipes

- **Crash-proof tracing**: build with `-DQOV_TRACE` and sprinkle
  `qov_trace("...", ...)` (macro in `qov-vlc.h`, appends +
  flushes `qov_trace.txt` into the process CWD per line). This exists
  because VLC's logger buffers and everything logged before a segfault is
  lost — both to redirected stdout (full buffering) and `--logfile`.
- **Module bisection**: `-DDEMUX_ONLY` and `-DAUDIO_ENC_MUX` guards in the
  descriptor block of `qov-demux.c` unregister submodule groups so a
  misbehaving module can be isolated (demux-only build proved the decoder
  crash was not in the demuxer).
- **Logs**: release VLC builds compile out most debug messages; `-vvv`
  still shows module_need probes ("looking for X module matching ...: N
  candidates") which is how capability-string mismatches reveal themselves.
- **Parity harnesses**: `qov-analysis-tools/.build/qoa_parity/` holds the
  3-way QOA comparison gear (C harness, TS harness via esbuild, corpus
  extraction) used when the embedded codec was aligned; reuse the pattern
  for any future byte-parity question.

## Update checklist

**Bumping VLC version** (e.g. 3.0.23 → 3.0.2x):
1. Re-download the matching win64 7z, re-extract `sdk/`, update `SDKDIR`.
2. Check the entry ABI suffix changed (`vlc_entry__3_0_0f` is version
   specific — it is auto-generated from `vlc_plugin.h`, so a clean rebuild
   is enough, but the *deployed* VLC must match the SDK series).
3. Re-run the verification matrix below.

**Adding/changing a module**: capability string (see table), score, and
`set_callbacks` signature first; then the module_sys struct trick (define
VLC's opaque struct, no typedef).

**Any change**: rebuild → taskkill → copy → cache-gen → `--list` shows 5 →
conformance (`npm run conformance`) → playback of a corpus file → remux
hash check → transcode from a rawvideo source.

## Known behavior limits (not bugs)

- Streams shorter than the 1500 ms `sout-mux-caching` window lose their
  final frame on ANY sout remux/transcode — stock VLC's mp4 muxer does the
  same (30→29 verified). Core teardown behavior.
- Transcode from h264 on the portable test rig fails in the
  dxva/converter chain; `--avcodec-hw=none` or non-h264 sources work.
  Possibly machine/build-specific, retest on newer VLC.
- `total_frames` in the muxed header stays 0 (the sout access seek for the
  header patch is unreliable); all known players synthesize the count.
- No QOA audio *encoder* module yet: transcodes drop audio
  (`acodec=none`); playback and remux of QOA audio work.
- Seek is keyframe-granular and needs a HAS_INDEX file; verified only
  headless (DEMUX_SET_TIME path + start-time), not yet in the GUI.
