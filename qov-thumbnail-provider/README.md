# QOV Thumbnail Provider (Windows)

Explorer shell extension that shows the first frame of a `.qov` file as its
thumbnail. Modeled after iOrange's QOIThumbnailProvider, but decoding is done
by the repo's own single-header C99 codec (`../qov.h`) — no image decoding
libraries involved.

## How it works

- `QovThumbnailProvider.dll` is a COM in-process server implementing
  `IInitializeWithStream` + `IThumbnailProvider` (the standard Windows
  thumbnail-handler contract), registered under
  `HKCR\.qov\ShellEx\{E357FCCD-A995-4576-B01F-234630154E96}`.
- The provider reads the stream, decodes only the **first frame**
  (`qov_decode_first_frame`, added to qov.h for this — cheap: stops after the
  first video chunk instead of decoding the whole file), area-average-scales it
  into the requested size (never upscaling), and returns a 32bpp top-down
  premultiplied DIB (`WTSAT_ARGB`), so files with alpha preview correctly.
- All eight QOV colorspaces are supported because decoding happens in qov.h,
  which is bit-exact with the TS/C# reference implementations.

## Files

| File | Purpose |
|------|---------|
| `qovthumb.cpp` | COM object: decode + scale + HBITMAP |
| `dll.cpp` | DllMain, self-registration (`DllRegisterServer`/`DllInstall`) |
| `guids.h` | CLSID `{D73AE4E4-0445-42B4-A8C2-767E5A8D3328}` |
| `test_thumb.cpp` | Calls the DLL's COM path directly, writes a BMP |
| `test_shell.cpp` | Asks the shell for the thumbnail via `IShellItemImageFactory` with `SIIGBF_THUMBNONLY` (end-to-end, fails if the shell falls back to a generic icon) |
| `capture.ps1` | Screenshots an Explorer window via PrintWindow for visual QA |

## Build

```cmd
build.cmd        \rem finds VS2019 BuildTools, builds x64 DLL + both test exes
```

x64 only (matches 64-bit Explorer — same tradeoff as the QOI reference repo).

## Install

```cmd
regsvr32 /n /i:user QovThumbnailProvider.dll   \rem per-user, no admin
regsvr32 QovThumbnailProvider.dll              \rem per-machine, admin shell
regsvr32 /n /u /i:user QovThumbnailProvider.dll  \rem remove per-user
```

Per-user registration writes `HKCU\Software\Classes\...` (which HKCR merges);
per-machine writes the same keys under `HKLM`. Explorer picks the handler up
without a restart; use fresh filenames when testing because the thumbnail
cache keys on name+mtime.

## Testing without Explorer

```cmd
test_thumb.exe file.qov out.bmp 256      \rem direct COM path
test_shell.exe file.qov out.bmp 256      \rem through the shell pipeline
```
