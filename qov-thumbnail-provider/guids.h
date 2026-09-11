/* guids.h - CLSID/IID constants shared by the DLL and the test harness.
 * Kept as local statics so both build without needing a link-time GUID lib. */
#pragma once
#include <guiddef.h>

/* {D73AE4E4-0445-42B4-A8C2-767E5A8D3328} */
static const CLSID kCLSID_QovThumbnailProvider =
    {0xD73AE4E4, 0x0445, 0x42B4, {0xA8, 0xC2, 0x76, 0x7E, 0x5A, 0x8D, 0x33, 0x28}};

/* IID_IThumbnailProvider - also the ShellEx thumbnail-handler category key */
static const IID kIID_IThumbnailProvider =
    {0xe357fccd, 0xa995, 0x4576, {0xb0, 0x1f, 0x23, 0x46, 0x30, 0x15, 0x4e, 0x96}};

/* IID_IInitializeWithStream {b824b49d-22ac-4161-ac8a-9916e8fa3f7f} */
static const IID kIID_IInitializeWithStream =
    {0xb824b49d, 0x22ac, 0x4161, {0xac, 0x8a, 0x99, 0x16, 0xe8, 0xfa, 0x3f, 0x7f}};

#define QOV_THUMB_CLSID_STR "{D73AE4E4-0445-42B4-A8C2-767E5A8D3328}"
#define QOV_THUMB_CATID_STR "{E357FCCD-A995-4576-B01F-234630154E96}"
