@echo off
rem Build the QOV VLC 3.0.x plugin (qovplug.dll) with mingw-w64 gcc.
rem VLC 3.0 plugin headers only support GCC on Windows (no _MSC_VER paths).
rem Requires: mingw-w64 gcc on PATH, VLC 3.0.x win64 7z sdk/ extracted.
setlocal enabledelayedexpansion
set SDKDIR=%~dp0..\qov-analysis-tools\.build\vlcsdk\vlc-3.0.23\sdk
if not exist "%SDKDIR%\include\vlc\plugins\vlc_plugin.h" (
    echo VLC SDK not found at %SDKDIR%
    echo Download vlc-3.0.23-win64.7z from download.videolan.org and extract:
    echo   7zr x vlc-3.0.23-win64.7z "vlc-3.0.23\sdk\*"
    exit /b 1
)

set GCC=gcc
where gcc >nul 2>nul
if errorlevel 1 (
    if exist "C:\msys64\mingw64\bin\gcc.exe" (
        set GCC=C:\msys64\mingw64\bin\gcc.exe
        set PATH=C:\msys64\mingw64\bin;%PATH%
    ) else (
        echo gcc not found - install mingw-w64 ^(MSYS2^)
        exit /b 1
    )
)

if not exist obj mkdir obj

%GCC% -O2 -Wall -std=gnu99 -shared -o qovplug.dll ^
  -I"%SDKDIR%\include\vlc\plugins" -I"%~dp0.." ^
  -D__PLUGIN__ -DHAVE_POLL=1 -DMODULE_STRING='"qov"' ^
  qov_codec.c qov_poll.c qov-demux.c qov-decoder.c qov-audio.c qov-encoder.c qov-mux.c ^
  -L"%SDKDIR%\lib" -lvlc -lvlccore -lws2_32 ^
  -Wl,--no-undefined -Wl,--export-all-symbols -static-libgcc
if errorlevel 1 (
    echo build failed
    exit /b 1
)

echo.
echo Built %~dp0qovplug.dll
echo Test:   set VLC_PLUGIN_PATH=%~dp0 ^&^& vlc -I dummy --list ^| findstr qov
echo Install: copy into "%%ProgramFiles%%\VideoLAN\VLC\plugins" and delete
echo          "plugins\plugins.dat" so VLC rescans.
