# QOV plugin for VLC 3.0.x

A native VLC media player plugin for the QOV (Quite OK Video) format: full
playback (video + QOA audio), seeking, remuxing, and transcoding to QOV —
built directly on the `qov.h` single-header codec.

## Modules (one DLL, five VLC modules)

| Module        | Capability      | What it does                                                        |
|---------------|-----------------|---------------------------------------------------------------------|
| `qov-demux.c` | `demux`         | Probes the `qovf` magic, exposes QOV1 video + QOA1 audio ES, walks chunks, seeks via the keyframe INDEX chunk |
| `qov-decoder.c` | `video decoder` | QOV1 chunks → RGBA pictures (incremental `qov_decoder`)            |
| `qov-audio.c` | `audio decoder` | QOA1 frames → S16N PCM                                              |
| `qov-encoder.c` | `encoder`     | RGBA/I420 pictures → QOV1 chunk stream (`--sout-qov-keyint`, `--sout-qov-lz4`) |
| `qov-mux.c`   | `sout mux`      | Wraps QOV1/QOA1 into a `.qov` container with keyframe INDEX          |

The QOV1/QOA1 elementary stream format used between the modules is
**complete chunk records** (10-byte chunk header + payload), which lets the
muxer pass remuxed data through verbatim and keeps the encoder/muxer
decoupled. The qov file header rides along as ES extra data.

## Build

Requires **mingw-w64 GCC** (VLC 3.0 plugin headers are GCC-only — no MSVC
paths) and the official VLC win64 package with its `sdk/` folder:

```
curl -O https://download.videolan.org/pub/videolan/vlc/3.0.23/win64/vlc-3.0.23-win64.7z
7zr x vlc-3.0.23-win64.7z "vlc-3.0.23\sdk\*"     # 7zr.exe from 7-zip.org
cd vlc-plugin && build.cmd
```

`build.cmd` looks for the SDK at
`../qov-analysis-tools/.build/vlcsdk/vlc-3.0.23/sdk` (override `SDKDIR`).

Gotchas baked into the build: `-D__PLUGIN__ -DHAVE_POLL=1
-DMODULE_STRING='"qov"'` (do **not** define `VLC_MODULE_NAME`, it collides
with an enum in `vlc_plugin.h`), a `poll()` stub (mingw has no `poll.h`), a
local `N_()` shim (not shipped in the SDK headers), and linking
`libvlc.lib` + `libvlccore.lib` from the SDK.

## Install

VLC on Windows loads modules **only** through `plugins/plugins.dat`; a
freshly copied DLL is silently ignored until the cache is regenerated:

```
taskkill /IM vlc.exe /F
copy qovplug.dll "C:\Program Files\VideoLAN\VLC\plugins\codec\libqov_plugin.dll"
vlc-cache-gen.exe "C:\Program Files\VideoLAN\VLC\plugins"
```

(`vlc-cache-gen.exe` ships in the VLC folder; writing to `Program Files`
needs admin. A portable VLC extract works without admin. `VLC_PLUGIN_PATH`
and `--plugin-path` are dead in 3.0.x. Naming must match
`lib*_plugin.dll`.)

Verify with `vlc -I dummy --list | findstr qov` — should show 5 modules.

## Usage

- **Playback**: open a `.qov` file — the demuxer is content-probed via the
  `qovf` magic. Seek uses the keyframe INDEX (keyframe granularity).
- **Remux**: `vlc in.qov --sout "#std{access=file,mux=qov,dst=out.qov}"`
- **Transcode** (any VLC-decodable source → QOV):
  `vlc in.mp4 --avcodec-hw=none --sout "#transcode{vcodec=QOV1,venc=qov,acodec=none}:std{access=file,mux=qov,dst=out.qov}"`
  - `--sout-qov-keyint N` keyframe interval (default 150, 0 = first frame only)
  - `--sout-qov-lz4 0/1` per-chunk LZ4 (default on)

## Verified

- 5 modules register; corpus `.qov` files play (video decode + QOA audio)
- Remux through `mux=qov` reproduces every frame and the audio PCM
  byte-identically (`qov_cli decode` hash comparison against the manifest)
- Transcode mp4 (rawvideo/I420 source) → `.qov`: 120/120 frames, and the
  result plays back through the plugin's own demuxer + decoder

## Known limitations

- VLC drops the final frame of streams **shorter than the 1500 ms
  `sout-mux-caching` window** on remux/transcode — stock VLC muxers (mp4)
  behave identically, it is core sout teardown behavior, not plugin-specific.
- Transcoding from h264 on this portable build hits a dxva/converter-chain
  failure; use `--avcodec-hw=none` or non-h264 sources. (Stock transcodes
  may be affected equally.)
- The muxer cannot patch `total_frames` into the header reliably (sout
  access seek); players synthesize the count, decode is unaffected.
- No QOA **audio encoder**, so `acodec` cannot produce QOA yet (audio in
  transcodes is dropped with `acodec=none`); audio *playback/remux* works.
- Seeking is keyframe-granular and requires a HAS_INDEX file (encoder-
  produced files have one).
- Chunk timestamps are u32 µs (spec field) — they wrap at ~71.6 min; the
  demuxer falls back to frame-counter-derived pts.
