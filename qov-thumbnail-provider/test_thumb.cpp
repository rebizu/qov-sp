/* test_thumb.exe - exercises the real COM path of QovThumbnailProvider.dll
 * without Explorer: DllGetClassObject -> CreateInstance -> IInitializeWithStream
 * -> IThumbnailProvider::GetThumbnail, then writes the HBITMAP as a BMP.
 *
 *   test_thumb.exe <file.qov> <out.bmp> [cx]
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <shlwapi.h>
#include <thumbcache.h>
#include <propsys.h>

#include <cstdio>
#include <cstdlib>
#include <vector>

#include "guids.h"

typedef HRESULT(WINAPI *GetClassObjectFn)(REFCLSID, REFIID, void **);

static bool SaveBmp(HBITMAP hbmp, const wchar_t *path) {
    BITMAP bm;
    if (!GetObjectW(hbmp, sizeof(bm), &bm)) return false;

    BITMAPINFO bi;
    ZeroMemory(&bi, sizeof(bi));
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = bm.bmWidth;
    bi.bmiHeader.biHeight = -bm.bmHeight;   /* top-down */
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;

    std::vector<uint8_t> pixels((size_t)bm.bmWidth * bm.bmHeight * 4);
    HDC hdc = GetDC(nullptr);
    if (!GetDIBits(hdc, hbmp, 0, bm.bmHeight, pixels.data(), &bi, DIB_RGB_COLORS)) {
        ReleaseDC(nullptr, hdc);
        return false;
    }
    ReleaseDC(nullptr, hdc);

    BITMAPFILEHEADER fh;
    fh.bfType = 0x4D42;
    fh.bfSize = (DWORD)(sizeof(fh) + sizeof(BITMAPINFOHEADER) + pixels.size());
    fh.bfReserved1 = fh.bfReserved2 = 0;
    fh.bfOffBits = sizeof(fh) + sizeof(BITMAPINFOHEADER);

    FILE *f = nullptr;
    if (_wfopen_s(&f, path, L"wb") != 0 || !f) return false;
    fwrite(&fh, sizeof(fh), 1, f);
    fwrite(&bi.bmiHeader, sizeof(BITMAPINFOHEADER), 1, f);
    fwrite(pixels.data(), pixels.size(), 1, f);
    fclose(f);
    return true;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 3) {
        wprintf(L"usage: test_thumb.exe <file.qov> <out.bmp> [cx]\n");
        return 2;
    }
    UINT cx = argc >= 4 ? (UINT)_wtoi(argv[3]) : 256;
    if (cx == 0) cx = 256;

    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) { wprintf(L"CoInitialize failed 0x%08lX\n", hr); return 1; }

    HMODULE dll = LoadLibraryW(L"QovThumbnailProvider.dll");
    if (!dll) { wprintf(L"LoadLibrary failed %lu\n", GetLastError()); return 1; }

    auto getClassObject = (GetClassObjectFn)GetProcAddress(dll, "DllGetClassObject");
    if (!getClassObject) { wprintf(L"no DllGetClassObject\n"); return 1; }

    IClassFactory *factory = nullptr;
    hr = getClassObject(kCLSID_QovThumbnailProvider, IID_IClassFactory, (void **)&factory);
    if (FAILED(hr)) { wprintf(L"DllGetClassObject failed 0x%08lX\n", hr); return 1; }

    IInitializeWithStream *initStream = nullptr;
    hr = factory->CreateInstance(nullptr, kIID_IInitializeWithStream, (void **)&initStream);
    factory->Release();
    if (FAILED(hr)) { wprintf(L"CreateInstance failed 0x%08lX\n", hr); return 1; }

    IStream *stream = nullptr;
    hr = SHCreateStreamOnFileEx(argv[1], STGM_READ | STGM_SHARE_DENY_WRITE,
                                FILE_ATTRIBUTE_NORMAL, FALSE, nullptr, &stream);
    if (FAILED(hr)) { wprintf(L"open file failed 0x%08lX\n", hr); return 1; }

    hr = initStream->Initialize(stream, STGM_READ);
    stream->Release();
    if (FAILED(hr)) { wprintf(L"Initialize failed 0x%08lX\n", hr); return 1; }

    IThumbnailProvider *thumb = nullptr;
    hr = initStream->QueryInterface(kIID_IThumbnailProvider, (void **)&thumb);
    if (FAILED(hr)) { wprintf(L"no IThumbnailProvider 0x%08lX\n", hr); return 1; }
    initStream->Release();

    HBITMAP hbmp = nullptr;
    WTS_ALPHATYPE alpha = WTSAT_UNKNOWN;
    hr = thumb->GetThumbnail(cx, &hbmp, &alpha);
    thumb->Release();
    if (FAILED(hr)) { wprintf(L"GetThumbnail failed 0x%08lX\n", hr); return 1; }

    BITMAP bm;
    GetObjectW(hbmp, sizeof(bm), &bm);
    wprintf(L"ok: %ux%u alpha=%d\n", bm.bmWidth, bm.bmHeight, (int)alpha);

    bool saved = SaveBmp(hbmp, argv[2]);
    DeleteObject(hbmp);
    if (!saved) { wprintf(L"SaveBmp failed\n"); return 1; }
    wprintf(L"saved %s\n", argv[2]);
    return 0;
}
