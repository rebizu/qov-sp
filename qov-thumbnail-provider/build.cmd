@echo off
rem Builds QovThumbnailProvider.dll (x64) and test_thumb.exe with MSVC.
setlocal
cd /d "%~dp0"

set "VSROOT=%ProgramFiles(x86)%\Microsoft Visual Studio\2019\BuildTools"
call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo vcvars64.bat failed
  exit /b 1
)

if not exist obj mkdir obj

rc /nologo dll.rc
if errorlevel 1 exit /b 1

cl /nologo /W3 /O2 /EHsc /MT /DUNICODE /D_UNICODE /LD /Foobj\^
  qovthumb.cpp dll.cpp dll.res^
  /FeQovThumbnailProvider.dll^
  /link /DEF:QovThumbnailProvider.def ole32.lib advapi32.lib gdi32.lib user32.lib uuid.lib
if errorlevel 1 exit /b 1

cl /nologo /W3 /O2 /EHsc /MT /DUNICODE /D_UNICODE /Foobj\^
  test_thumb.cpp^
  /Fetest_thumb.exe^
  /link ole32.lib oleaut32.lib shlwapi.lib gdi32.lib user32.lib uuid.lib
if errorlevel 1 exit /b 1

echo BUILD OK

cl /nologo /W3 /O2 /EHsc /MT /DUNICODE /D_UNICODE /Foobj\^
  test_shell.cpp^
  /Fetest_shell.exe^
  /link ole32.lib shell32.lib gdi32.lib user32.lib gdiplus.lib windowscodecs.lib
if errorlevel 1 exit /b 1
echo BUILD2 OK
