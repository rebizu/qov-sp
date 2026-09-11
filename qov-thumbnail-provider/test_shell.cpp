/* test_shell.exe - end-to-end check: asks the Windows shell for a thumbnail
 * through IShellItemImageFactory (the same pipeline Explorer uses), forcing
 * thumbnail-only so a plain icon fallback would fail the test.
 *
 *   test_shell.exe <file.qov> <out.bmp> [cx]
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shobjidl.h>
#include <shlwapi.h>

#include <cstdio>
#include <vector>

/* SIIGBF_THUMBNONLY: value from the SIIGBF enum (propsys.h in this SDK). */
static const SIIGBF QOV_SIIGBF_THUMBNONLY = (SIIGBF)0x1;

static bool SaveBmp(HBITMAP hbmp, const wchar_t *path) {
    BITMAP bm;
    if (!GetObjectW(hbmp, sizeof(bm), &bm)) return false;
    BITMAPINFO bi;
    ZeroMemory(&bi, sizeof(bi));
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = bm.bmWidth;
    bi.bmiHeader.biHeight = -bm.bmHeight;
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
        wprintf(L"usage: test_shell.exe <file.qov> <out.bmp> [cx]\n");
        return 2;
    }
    UINT cx = argc >= 4 ? (UINT)_wtoi(argv[3]) : 256;

    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) { wprintf(L"CoInitialize failed 0x%08lX\n", hr); return 1; }

    IShellItem *item = nullptr;
    hr = SHCreateItemFromParsingName(argv[1], nullptr, IID_PPV_ARGS(&item));
    if (FAILED(hr)) { wprintf(L"SHCreateItemFromParsingName failed 0x%08lX\n", hr); return 1; }

    IShellItemImageFactory *fact = nullptr;
    hr = item->QueryInterface(IID_PPV_ARGS(&fact));
    item->Release();
    if (FAILED(hr)) { wprintf(L"no IShellItemImageFactory 0x%08lX\n", hr); return 1; }

    HBITMAP hbmp = nullptr;
    SIZE sz = {(LONG)cx, (LONG)cx};
    hr = fact->GetImage(sz, QOV_SIIGBF_THUMBNONLY, &hbmp);
    fact->Release();
    if (FAILED(hr)) { wprintf(L"GetImage(THUMBNONLY) failed 0x%08lX\n", hr); return 1; }

    BITMAP bm;
    GetObjectW(hbmp, sizeof(bm), &bm);
    wprintf(L"shell thumbnail ok: %ldx%ld\n", bm.bmWidth, bm.bmHeight);
    bool saved = SaveBmp(hbmp, argv[2]);
    DeleteObject(hbmp);
    if (!saved) { wprintf(L"SaveBmp failed\n"); return 1; }
    wprintf(L"saved\n");
    return 0;
}
