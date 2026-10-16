/* anrec.dll: runtime recorder for the original game (GOG AN.exe v2.05), milestone M0.
 *
 * Loaded by the an-patch ddraw proxy when an-patch.ini has [record] enabled=1. Patches jumps
 * over srand, rand and the scheduler's tick start/end (hooks.S) and writes every event as a
 * 16-byte record to Bin\rec\anrec-<date>-<time>.bin. Format and plan:
 * docs/architecture/runtime-recorder.md. Refuses to patch an exe whose bytes differ.
 *
 * Our own code; it contains addresses and the original instruction bytes only to verify them. */
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>

/* record kinds */
#define K_HEADER     0  /* a = format version, b = flags (bit0 force_seed active) */
#define K_SRAND      1  /* a = caller, b = seed stored */
#define K_RAND       2  /* a = caller, b = seed before; tick = counter; kind bit 8 = inside a tick */
#define K_TICK_START 3  /* a = scheduler slot, b = ms since recorder start */
#define K_TICK_END   4  /* a = rand calls in this tick, b = hook time so far (us) */
#define K_SRAND_RAW  5  /* a = caller, b = seed the game asked for (when forced) */
#define IN_TICK      0x100

#define FORMAT_VERSION 1
#define TICK_COUNTER (*(volatile DWORD *)0x4b3780)

typedef struct { DWORD kind, tick, a, b; } Rec;

void stub_srand(void);
void stub_rand(void);
void stub_tick_start(void);
void stub_tick_end(void);

static CRITICAL_SECTION g_lock;
static HANDLE g_out = INVALID_HANDLE_VALUE;
static Rec g_buf[8192];
static int g_n;
static int g_inTick;
static DWORD g_tickRands;
static LONGLONG g_qpf, g_qpc0, g_hookTicks;
static int g_forceSeed;
static DWORD g_forcedSeed;
static DWORD g_flushEvery;
static DWORD g_ticksSinceFlush;
static char g_dir[MAX_PATH];
static int g_active;

static void flushLocked(void)
{
    DWORD w;
    if (g_n && g_out != INVALID_HANDLE_VALUE) WriteFile(g_out, g_buf, g_n * sizeof(Rec), &w, NULL);
    g_n = 0;
}

static void put(DWORD kind, DWORD a, DWORD b)
{
    Rec *r = &g_buf[g_n++];
    r->kind = kind; r->tick = TICK_COUNTER; r->a = a; r->b = b;
    if (g_n == (int)(sizeof g_buf / sizeof g_buf[0])) flushLocked();
}

static LONGLONG qpc(void) { LARGE_INTEGER t; QueryPerformanceCounter(&t); return t.QuadPart; }

DWORD __cdecl log_srand(DWORD caller, DWORD seed)
{
    LONGLONG t0 = qpc();
    DWORD stored = g_forceSeed ? g_forcedSeed : seed;
    EnterCriticalSection(&g_lock);
    if (g_forceSeed) put(K_SRAND_RAW, caller, seed);
    put(K_SRAND, caller, stored);
    flushLocked();
    g_hookTicks += qpc() - t0;
    LeaveCriticalSection(&g_lock);
    return stored;
}

void __cdecl log_rand(DWORD caller, DWORD seedBefore)
{
    LONGLONG t0 = qpc();
    EnterCriticalSection(&g_lock);
    put(K_RAND | (g_inTick ? IN_TICK : 0), caller, seedBefore);
    if (g_inTick) g_tickRands++;
    g_hookTicks += qpc() - t0;
    LeaveCriticalSection(&g_lock);
}

void __cdecl log_tick_start(DWORD slot)
{
    LONGLONG t0 = qpc();
    EnterCriticalSection(&g_lock);
    g_inTick = 1;
    g_tickRands = 0;
    put(K_TICK_START, slot, (DWORD)((t0 - g_qpc0) * 1000 / g_qpf));
    g_hookTicks += qpc() - t0;
    LeaveCriticalSection(&g_lock);
}

void __cdecl log_tick_end(void)
{
    LONGLONG t0 = qpc();
    EnterCriticalSection(&g_lock);
    put(K_TICK_END, g_tickRands, (DWORD)(g_hookTicks * 1000000 / g_qpf));
    g_inTick = 0;
    if (++g_ticksSinceFlush >= g_flushEvery) { flushLocked(); g_ticksSinceFlush = 0; }
    g_hookTicks += qpc() - t0;
    LeaveCriticalSection(&g_lock);
}

static void textlog(const char *fmt, const char *s, DWORD v)
{
    char path[MAX_PATH], line[512];
    FILE *f;
    snprintf(path, sizeof path, "%sanrec.log", g_dir);
    f = fopen(path, "a");
    if (!f) return;
    snprintf(line, sizeof line, fmt, s, v);
    fprintf(f, "%s\n", line);
    fclose(f);
}

static const unsigned char O_SRAND[] = { 0x8b, 0x44, 0x24, 0x04, 0xa3, 0x00, 0x07, 0x4b, 0x00, 0xc3 };
static const unsigned char O_RAND[]  = { 0xa1, 0x00, 0x07, 0x4b, 0x00, 0x69, 0xc0, 0xfd, 0x43, 0x03, 0x00,
                                         0x05, 0xc3, 0x9e, 0x26, 0x00 };
static const unsigned char O_TICK0[] = { 0x8b, 0x43, 0x2c, 0x8d, 0x14, 0x40, 0x8b, 0x43, 0x20 };
static const unsigned char O_TICK1[] = { 0x8b, 0x15, 0x80, 0x37, 0x4b, 0x00, 0x42, 0x89, 0x15, 0x80, 0x37, 0x4b, 0x00 };

static int install(void)
{
    /* the verified byte runs are longer than the patched part, to be sure of the build */
    static const struct { DWORD addr; int checkLen; const unsigned char *orig; int patchLen; void (*stub)(void); const char *name; } P[] = {
        { 0x4936af, sizeof O_SRAND, O_SRAND, 5, stub_srand,      "srand" },
        { 0x4936b9, sizeof O_RAND,  O_RAND,  5, stub_rand,       "rand" },
        { 0x482ced, sizeof O_TICK0, O_TICK0, 6, stub_tick_start, "tick start" },
        { 0x482df3, sizeof O_TICK1, O_TICK1, 6, stub_tick_end,   "tick end" },
    };
    int i;
    for (i = 0; i < 4; i++) {
        if (IsBadReadPtr((void *)P[i].addr, P[i].checkLen) || memcmp((void *)P[i].addr, P[i].orig, P[i].checkLen) != 0) {
            textlog("anrec: bytes at %s differ: not GOG AN.exe v2.05, nothing patched (%lu)", P[i].name, (DWORD)i);
            return 0;
        }
    }
    for (i = 0; i < 4; i++) {
        unsigned char *p = (unsigned char *)P[i].addr;
        DWORD old;
        int k;
        VirtualProtect(p, P[i].patchLen, PAGE_EXECUTE_READWRITE, &old);
        p[0] = 0xe9;
        *(DWORD *)(p + 1) = (DWORD)P[i].stub - (P[i].addr + 5);
        for (k = 5; k < P[i].patchLen; k++) p[k] = 0x90;
        VirtualProtect(p, P[i].patchLen, old, &old);
    }
    FlushInstructionCache(GetCurrentProcess(), NULL, 0);
    return 1;
}

/* --- no_sound: make DirectSoundCreate report "no driver" (sound set-up then returns "no sound";
 * with Remote Desktop audio redirection every DirectSound call can be so slow that start-up
 * takes minutes) --- */

static HRESULT WINAPI noDirectSoundCreate(void *guid, void **ds, void *outer)
{
    (void)guid; (void)outer;
    if (ds) *ds = NULL;
    return (HRESULT)0x88780078; /* DSERR_NODRIVER */
}

static int disableSound(void)
{
    BYTE *base = (BYTE *)GetModuleHandleA(NULL);
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + ((IMAGE_DOS_HEADER *)base)->e_lfanew);
    IMAGE_DATA_DIRECTORY *dir = &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    IMAGE_IMPORT_DESCRIPTOR *d = (IMAGE_IMPORT_DESCRIPTOR *)(base + dir->VirtualAddress);
    for (; d->Name; d++) {
        IMAGE_THUNK_DATA *names, *iat;
        if (_stricmp((char *)(base + d->Name), "DSOUND.DLL") != 0) continue;
        names = (IMAGE_THUNK_DATA *)(base + (d->OriginalFirstThunk ? d->OriginalFirstThunk : d->FirstThunk));
        iat = (IMAGE_THUNK_DATA *)(base + d->FirstThunk);
        for (; names->u1.Ordinal; names++, iat++) {
            if (IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal) && IMAGE_ORDINAL(names->u1.Ordinal) == 1) {
                DWORD old;
                VirtualProtect(&iat->u1.Function, 4, PAGE_READWRITE, &old);
                iat->u1.Function = (DWORD)noDirectSoundCreate;
                VirtualProtect(&iat->u1.Function, 4, old, &old);
                return 1;
            }
        }
    }
    return 0;
}

/* --- skip_intro: the intro player looks up intro.avi at 0x48766a and skips the video when the
 * lookup returns 0 (front-end.md 3.1). Make that one lookup return 0; the CD check (a separate
 * lookup of data\intro.avi) is untouched. Display only. --- */

static int skipIntro(void)
{
    static const unsigned char orig[] = { 0xe8, 0x61, 0x1b, 0x00, 0x00, 0x8b, 0xf8 };
    unsigned char *p = (unsigned char *)0x48766a;
    DWORD old;
    if (IsBadReadPtr(p, sizeof orig) || memcmp(p, orig, sizeof orig) != 0) return 0;
    VirtualProtect(p, 5, PAGE_EXECUTE_READWRITE, &old);
    p[0] = 0x31; p[1] = 0xc0; p[2] = 0x90; p[3] = 0x90; p[4] = 0x90;   /* xor eax,eax; nop x3 */
    VirtualProtect(p, 5, old, &old);
    FlushInstructionCache(GetCurrentProcess(), p, 5);
    return 1;
}

/* --- watchdog: quit file and stuck-thread sampling (needs no debugger rights) --- */

static HANDLE g_mainThread;
static DWORD g_watchSecs;

static void vlog(const char *fmt, ...)
{
    char path[MAX_PATH];
    FILE *f;
    va_list ap;
    snprintf(path, sizeof path, "%sanrec.log", g_dir);
    f = fopen(path, "a");
    if (!f) return;
    va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
    fputc('\n', f);
    fclose(f);
}

static void describe(DWORD addr, char *out, int n)
{
    HMODULE m;
    char name[MAX_PATH], *b;
    if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCSTR)addr, &m) && GetModuleFileNameA(m, name, sizeof name)) {
        b = strrchr(name, '\\');
        snprintf(out, n, "%08lx %s+%lx", addr, b ? b + 1 : name, addr - (DWORD)m);
    } else snprintf(out, n, "%08lx ?", addr);
}

/* Suspend the main thread, log its eip and the stack words that look like return addresses
 * (they point just behind a call instruction in executable memory). */
static void sample(int k)
{
    CONTEXT c;
    MEMORY_BASIC_INFORMATION mi;
    DWORD *sp, *end;
    char d[MAX_PATH + 32];
    int found = 0;
    if (SuspendThread(g_mainThread) == (DWORD)-1) { vlog("watchdog: suspend failed %lu", GetLastError()); return; }
    c.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
    if (GetThreadContext(g_mainThread, &c)) {
        describe(c.Eip, d, sizeof d);
        vlog("watchdog sample %d: tick %lu eip %s esp %08lx", k, TICK_COUNTER, d, c.Esp);
        {   /* frame-pointer chain: reliable where the code keeps ebp frames */
            DWORD *bp = (DWORD *)c.Ebp;
            int i;
            for (i = 0; i < 24 && !IsBadReadPtr(bp, 8) && (DWORD)bp >= c.Esp; i++) {
                describe(bp[1], d, sizeof d);
                vlog("   ebp#%02d %s", i, d);
                if ((DWORD *)bp[0] <= bp) break;
                bp = (DWORD *)bp[0];
            }
        }
        sp = (DWORD *)c.Esp;
        end = sp + 4096;
        if (VirtualQuery(sp, &mi, sizeof mi)) {
            DWORD *top = (DWORD *)((char *)mi.BaseAddress + mi.RegionSize);
            if (end > top) end = top;
        }
        for (; sp < end && found < 32; sp++) {
            DWORD v = *sp;
            unsigned char *q = (unsigned char *)v;
            if (v < 0x10000 || IsBadReadPtr(q - 6, 6)) continue;
            if (!VirtualQuery(q, &mi, sizeof mi)
                || !(mi.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)))
                continue;
            if (q[-5] == 0xe8 || (q[-6] == 0xff && (q[-5] & 0x38) == 0x10)
                || (q[-3] == 0xff && (q[-2] & 0x38) == 0x10) || (q[-2] == 0xff && (q[-1] & 0x38) == 0x10)) {
                describe(v, d, sizeof d);
                vlog("   [esp+%04lx] %s", (DWORD)((char *)sp - (char *)c.Esp), d);
                found++;
            }
        }
    } else vlog("watchdog: GetThreadContext failed %lu", GetLastError());
    ResumeThread(g_mainThread);
}

/* Polls once a second: Bin\rec\anrec.quit ends the game (no rights needed), and with
 * [record] watchdog=N the main thread is sampled at 5, 10, 15, 20, 40, 80 ... s up to N s. */
static DWORD WINAPI watchdog(LPVOID arg)
{
    char quit[MAX_PATH];
    DWORD t = 0, next = 5;
    int k = 0;
    (void)arg;
    snprintf(quit, sizeof quit, "%srec\\anrec.quit", g_dir);
    for (;;) {
        Sleep(1000);
        t++;
        if (GetFileAttributesA(quit) != INVALID_FILE_ATTRIBUTES) {
            DeleteFileA(quit);
            vlog("watchdog: quit file seen, terminating");
            if (g_active) { EnterCriticalSection(&g_lock); flushLocked(); LeaveCriticalSection(&g_lock); }
            TerminateProcess(GetCurrentProcess(), 0);
        }
        if (g_watchSecs && t == next && t <= g_watchSecs) { sample(++k); next = next < 20 ? next + 5 : next * 2; }
    }
    return 0;
}

static void start(HINSTANCE self)
{
    char ini[MAX_PATH], path[MAX_PATH], *p;
    SYSTEMTIME st;
    LARGE_INTEGER f;
    char seedStr[32];

    GetModuleFileNameA(self, g_dir, MAX_PATH);
    p = strrchr(g_dir, '\\');
    if (p) p[1] = 0; else g_dir[0] = 0;
    snprintf(ini, sizeof ini, "%san-patch.ini", g_dir);

    GetPrivateProfileStringA("record", "force_seed", "", seedStr, sizeof seedStr, ini);
    if (seedStr[0]) { g_forceSeed = 1; g_forcedSeed = strtoul(seedStr, NULL, 0); }
    g_flushEvery = GetPrivateProfileIntA("record", "flush_ticks", 50, ini);
    if (!g_flushEvery) g_flushEvery = 1;

    QueryPerformanceFrequency(&f); g_qpf = f.QuadPart; g_qpc0 = qpc();
    InitializeCriticalSection(&g_lock);

    snprintf(path, sizeof path, "%srec", g_dir);
    CreateDirectoryA(path, NULL);

    /* DllMain runs on the main thread (the proxy is a static import of the exe) */
    g_watchSecs = GetPrivateProfileIntA("record", "watchdog", 0, ini);
    DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &g_mainThread,
                    THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, 0);
    CloseHandle(CreateThread(NULL, 0, watchdog, NULL, 0, NULL));
    vlog("anrec: loaded, watchdog %lu s, hooks %d", g_watchSecs, GetPrivateProfileIntA("record", "hooks", 1, ini));
    if (GetPrivateProfileIntA("record", "no_sound", 0, ini))
        vlog("anrec: no_sound: DirectSoundCreate %s", disableSound() ? "replaced" : "import NOT found");
    if (GetPrivateProfileIntA("record", "skip_intro", 0, ini))
        vlog("anrec: skip_intro: %s", skipIntro() ? "patched" : "bytes differ, NOT patched");
    if (!GetPrivateProfileIntA("record", "hooks", 1, ini)) return;

    GetLocalTime(&st);
    snprintf(path, sizeof path, "%srec\\anrec-%04d%02d%02d-%02d%02d%02d.bin", g_dir,
             st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    g_out = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (g_out == INVALID_HANDLE_VALUE) { textlog("anrec: cannot create %s (%lu)", path, GetLastError()); return; }

    if (!install()) { CloseHandle(g_out); g_out = INVALID_HANDLE_VALUE; DeleteFileA(path); return; }
    g_active = 1;
    {
        Rec h[2] = { { K_HEADER, 0x43455241 /* "AREC" */, FORMAT_VERSION, (DWORD)g_forceSeed },
                     { K_HEADER, 0, (DWORD)g_qpf, g_forcedSeed } };
        DWORD w;
        WriteFile(g_out, h, sizeof h, &w, NULL);
    }
    textlog("anrec: recording to %s (force_seed %lu)", path, (DWORD)g_forceSeed);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        start(inst);
    } else if (reason == DLL_PROCESS_DETACH && g_active) {
        EnterCriticalSection(&g_lock);
        flushLocked();
        CloseHandle(g_out);
        g_out = INVALID_HANDLE_VALUE;
        LeaveCriticalSection(&g_lock);
    }
    return TRUE;
}
