/* dll.cpp - module entry points and COM registration.
 *
 * regsvr32 qovthumb.dll            -> per-machine (HKLM, needs admin)
 * regsvr32 /u qovthumb.dll         -> remove per-machine
 * regsvr32 /n /i:user qovthumb.dll -> per-user (HKCU, no admin needed)
 * regsvr32 /n /u /i:user qovthumb.dll -> remove per-user
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <olectl.h>     /* SELFREG_E_CLASS */

#include "guids.h"

static HMODULE g_self = nullptr;

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void * /*reserved*/) {
    if (reason == DLL_PROCESS_ATTACH) g_self = instance;
    return TRUE;
}

namespace {

const char kGuidStr[] = QOV_THUMB_CLSID_STR;
const char kCatStr[] = QOV_THUMB_CATID_STR;

struct RegValue { const char *name; const char *data; };

/* Writes (install) or deletes (uninstall) the CLSID + .qov association under
   the given registry root. root must be HKLM or HKCU; key paths get the
   "Software\Classes" prefix so HKCR merges them (per-user needs it too). */
HRESULT RegisterKeys(HKEY root, bool install) {
    char path[MAX_PATH];
    if (!g_self || !GetModuleFileNameA(g_self, path, MAX_PATH)) return E_FAIL;

    const char *base = "Software\\Classes\\";
    char clsidKey[160];
    wsprintfA(clsidKey, "%sCLSID\\%s", base, kGuidStr);
    char inprocKey[192];
    wsprintfA(inprocKey, "%sCLSID\\%s\\InprocServer32", base, kGuidStr);
    char assocKey[160];
    wsprintfA(assocKey, "%s.qov\\ShellEx\\%s", base, kCatStr);

    struct Entry { const char *key; const char *value; const char *data; };
    const Entry entries[] = {
        {clsidKey,  nullptr,          "QOV Thumbnail Provider"},
        {inprocKey, nullptr,          path},
        {inprocKey, "ThreadingModel", "Apartment"},
        {assocKey,  nullptr,          kGuidStr},
    };

    LONG lastError = ERROR_SUCCESS;
    for (const Entry &e : entries) {
        if (install) {
            HKEY hk;
            LONG rc = RegCreateKeyExA(root, e.key, 0, nullptr, REG_OPTION_NON_VOLATILE,
                                      KEY_WRITE, nullptr, &hk, nullptr);
            if (rc != ERROR_SUCCESS) { lastError = rc; continue; }
            rc = RegSetValueExA(hk, e.value, 0, REG_SZ, (const BYTE *)e.data,
                                (DWORD)strlen(e.data) + 1);
            RegCloseKey(hk);
            if (rc != ERROR_SUCCESS) lastError = rc;
        } else {
            RegDeleteKeyValueA(root, e.key, e.value);
        }
    }

    if (!install) {
        /* Empty keys left behind are harmless but tidy them anyway. */
        RegDeleteKeyA(root, assocKey);
        RegDeleteKeyA(root, inprocKey);
        RegDeleteKeyA(root, clsidKey);
    }

    return lastError == ERROR_SUCCESS ? S_OK : SELFREG_E_CLASS;
}

} // namespace

extern "C" STDAPI DllRegisterServer(void) {
    return RegisterKeys(HKEY_LOCAL_MACHINE, true);
}

extern "C" STDAPI DllUnregisterServer(void) {
    return RegisterKeys(HKEY_LOCAL_MACHINE, false);
}

extern "C" STDAPI DllInstall(BOOL install, LPCWSTR cmdline) {
    /* regsvr32 /i[:cmdline]; per-user when the cmdline says "user". */
    bool perUser = cmdline && wcsstr(cmdline, L"user") != nullptr;
    return RegisterKeys(perUser ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE, install != FALSE);
}
