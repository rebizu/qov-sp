/* qovthumb.cpp - QOV thumbnail COM object.
 *
 * Implements IInitializeWithStream + IThumbnailProvider: decodes the first
 * frame of a .qov stream with qov.h and hands Explorer a premultiplied
 * 32bpp top-down DIB. Alpha is preserved via alpha-weighted area-average
 * scaling, which is exactly premultiplied-space averaging.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <propsys.h>
#include <thumbcache.h>

#include <cstdint>
#include <new>
#include <vector>

#define QOV_IMPLEMENTATION
#include "../qov.h"

#include "guids.h"

namespace {

LONG g_liveObjects = 0;

class QovThumbProvider : public IInitializeWithStream, public IThumbnailProvider {
public:
    QovThumbProvider() : ref_(1), stream_(nullptr) { InterlockedIncrement(&g_liveObjects); }
    ~QovThumbProvider() {
        if (stream_) stream_->Release();
        InterlockedDecrement(&g_liveObjects);
    }

    /* IUnknown */
    STDMETHODIMP QueryInterface(REFIID riid, void **out) override {
        if (!out) return E_POINTER;
        if (riid == IID_IUnknown)
            *out = static_cast<IUnknown *>(static_cast<IInitializeWithStream *>(this));
        else if (riid == kIID_IInitializeWithStream)
            *out = static_cast<IInitializeWithStream *>(this);
        else if (riid == kIID_IThumbnailProvider)
            *out = static_cast<IThumbnailProvider *>(this);
        else { *out = nullptr; return E_NOINTERFACE; }
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref_); }
    STDMETHODIMP_(ULONG) Release() override {
        ULONG r = InterlockedDecrement(&ref_);
        if (r == 0) delete this;
        return r;
    }

    /* IInitializeWithStream */
    STDMETHODIMP Initialize(IStream *stream, DWORD /*grfMode*/) override {
        if (!stream) return E_INVALIDARG;
        if (stream_) stream_->Release();
        stream_ = stream;
        stream_->AddRef();
        return S_OK;
    }

    /* IThumbnailProvider */
    STDMETHODIMP GetThumbnail(UINT cx, HBITMAP *phbmp, WTS_ALPHATYPE *pat) override;

private:
    static std::vector<uint8_t> ReadAllStream(IStream *s);

    LONG ref_;
    IStream *stream_;
};

std::vector<uint8_t> QovThumbProvider::ReadAllStream(IStream *s) {
    /* Seek to start so a reused object re-reads the file. */
    LARGE_INTEGER zero = {0};
    s->Seek(zero, STREAM_SEEK_SET, nullptr);

    std::vector<uint8_t> buf;
    uint8_t chunk[64 * 1024];   /* keep small: shell threads have 1MB stacks */
    for (;;) {
        ULONG got = 0;
        if (FAILED(s->Read(chunk, sizeof(chunk), &got)) || got == 0) break;
        buf.insert(buf.end(), chunk, chunk + got);
        if (buf.size() > (2ull << 30)) break;   /* 2GB cap */
    }
    return buf;
}

STDMETHODIMP QovThumbProvider::GetThumbnail(UINT cx, HBITMAP *phbmp, WTS_ALPHATYPE *pat) {
    if (!phbmp || !pat) return E_POINTER;
    *phbmp = nullptr;
    *pat = WTSAT_UNKNOWN;
    if (!stream_) return E_UNEXPECTED;
    if (cx == 0) cx = 256;

    std::vector<uint8_t> data = ReadAllStream(stream_);
    if (data.empty()) return E_FAIL;

    qov_header hdr;
    if (qov_decode_header(data.data(), data.size(), &hdr) != QOV_OK) return E_FAIL;
    if (hdr.width == 0 || hdr.height == 0) return E_FAIL;

    qov_image img;
    if (qov_decode_first_frame(data.data(), data.size(), &img) != QOV_OK) return E_FAIL;

    /* Fit the larger dimension into cx; never upscale. */
    uint32_t tw = img.width, th = img.height;
    if (img.width > cx || img.height > cx) {
        double s = (img.width >= img.height)
                       ? (double)cx / img.width
                       : (double)cx / img.height;
        tw = img.width  ? (uint32_t)(img.width * s)  : 1;
        th = img.height ? (uint32_t)(img.height * s) : 1;
        if (tw == 0) tw = 1;
        if (th == 0) th = 1;
    }

    BITMAPINFO bi;
    ZeroMemory(&bi, sizeof(bi));
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = (LONG)tw;
    bi.bmiHeader.biHeight = -(LONG)th;      /* top-down */
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;

    void *bits = nullptr;
    HBITMAP hbmp = CreateDIBSection(nullptr, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    if (!hbmp || !bits) {
        if (hbmp) DeleteObject(hbmp);
        qov_free(img.rgba);
        return E_OUTOFMEMORY;
    }

    /* Area-average with alpha weighting == averaging in premultiplied space,
       which is what the shell expects (WTSAT_ARGB). */
    const uint8_t *src = img.rgba;
    uint32_t *dst = (uint32_t *)bits;
    const uint64_t sw = img.width, sh = img.height;
    for (uint32_t dy = 0; dy < th; dy++) {
        uint64_t sy0 = (uint64_t)dy * sh / th;
        uint64_t sy1 = ((uint64_t)(dy + 1) * sh + th - 1) / th;
        if (sy1 <= sy0) sy1 = sy0 + 1;
        if (sy1 > sh) sy1 = sh;
        for (uint32_t dx = 0; dx < tw; dx++) {
            uint64_t sx0 = (uint64_t)dx * sw / tw;
            uint64_t sx1 = ((uint64_t)(dx + 1) * sw + tw - 1) / tw;
            if (sx1 <= sx0) sx1 = sx0 + 1;
            if (sx1 > sw) sx1 = sw;
            uint64_t sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
            for (uint64_t y = sy0; y < sy1; y++) {
                const uint8_t *row = src + y * sw * 4;
                for (uint64_t x = sx0; x < sx1; x++) {
                    const uint8_t *p = row + x * 4;
                    uint32_t a = p[3];
                    sr += p[0] * a;
                    sg += p[1] * a;
                    sb += p[2] * a;
                    sa += a;
                    n++;
                }
            }
            if (n == 0) n = 1;
            const uint64_t denom = n * 255;
            const uint64_t half = denom / 2;
            /* sr = sum(R*a): premultiplied average = sr / (n*255) */
            uint32_t a  = (uint32_t)((sa * 255 + half) / denom);
            uint32_t pr = (uint32_t)((sr + half) / denom);
            uint32_t pg = (uint32_t)((sg + half) / denom);
            uint32_t pb = (uint32_t)((sb + half) / denom);
            dst[(size_t)dy * tw + dx] = pb | (pg << 8) | (pr << 16) | (a << 24);
        }
    }

    qov_free(img.rgba);

    *phbmp = hbmp;
    *pat = WTSAT_ARGB;
    return S_OK;
}

class Factory : public IClassFactory {
public:
    Factory() { InterlockedIncrement(&g_liveObjects); }
    ~Factory() { InterlockedDecrement(&g_liveObjects); }
    STDMETHODIMP QueryInterface(REFIID riid, void **out) override {
        if (!out) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IClassFactory) *out = static_cast<IClassFactory *>(this);
        else { *out = nullptr; return E_NOINTERFACE; }
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref_); }
    STDMETHODIMP_(ULONG) Release() override {
        ULONG r = InterlockedDecrement(&ref_);
        if (r == 0) delete this;
        return r;
    }
    STDMETHODIMP CreateInstance(IUnknown *outer, REFIID riid, void **out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        QovThumbProvider *p = new (std::nothrow) QovThumbProvider();
        if (!p) return E_OUTOFMEMORY;
        HRESULT hr = p->QueryInterface(riid, out);
        p->Release();
        return hr;
    }
    STDMETHODIMP LockServer(BOOL /*fLock*/) override { return S_OK; }

private:
    LONG ref_ = 1;
};

} // namespace

extern "C" STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void **out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (rclsid != kCLSID_QovThumbnailProvider) return CLASS_E_CLASSNOTAVAILABLE;
    Factory *f = new (std::nothrow) Factory();
    if (!f) return E_OUTOFMEMORY;
    HRESULT hr = f->QueryInterface(riid, out);
    f->Release();
    return hr;
}

extern "C" STDAPI DllCanUnloadNow(void) {
    return g_liveObjects == 0 ? S_OK : S_FALSE;
}
