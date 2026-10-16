/* Hook stubs for anrec.dll (GOG AN.exe v2.05). Each stub is entered by a 5-byte jmp patched over
 * the named address; it calls the C logger and then performs the instructions it replaced.
 * Addresses: docs/architecture/runtime-recorder.md section 1. */
        .intel_syntax noprefix
        .text

/* srand(seed) at 0x4936af: [esp] = return address, [esp+4] = seed. */
        .globl _stub_srand
_stub_srand:
        push    ecx
        push    edx
        push    dword ptr [esp+12]          /* seed */
        push    dword ptr [esp+12]          /* caller */
        call    _log_srand                  /* returns the seed to store (possibly forced) */
        add     esp, 8
        pop     edx
        pop     ecx
        mov     dword ptr ds:[0x4b0700], eax
        ret

/* rand() at 0x4936b9: [esp] = return address. Only eax and flags change, as in the original. */
        .globl _stub_rand
_stub_rand:
        push    ecx
        push    edx
        push    dword ptr ds:[0x4b0700]     /* seed before */
        push    dword ptr [esp+12]          /* caller */
        call    _log_rand
        add     esp, 8
        pop     edx
        pop     ecx
        mov     eax, dword ptr ds:[0x4b0700]
        imul    eax, eax, 0x343fd
        add     eax, 0x269ec3
        mov     dword ptr ds:[0x4b0700], eax
        sar     eax, 16
        and     eax, 0x7fff
        ret

/* Tick start at 0x482ced (inside the scheduler poll, after the interval and pause checks).
 * ebx = scheduler. Replaced: mov eax,[ebx+0x2c] / lea edx,[eax+eax*2]; resume at 0x482cf3. */
        .globl _stub_tick_start
_stub_tick_start:
        pushad
        push    dword ptr [ebx+0x2c]        /* current slot */
        call    _log_tick_start
        add     esp, 4
        popad
        mov     eax, dword ptr [ebx+0x2c]
        lea     edx, [eax+eax*2]
        push    0x482cf3
        ret

/* Tick end at 0x482df3 (all jobs of the slot done, before the counter increment).
 * Replaced: mov edx,[0x4b3780]; resume at 0x482df9 (inc edx). */
        .globl _stub_tick_end
_stub_tick_end:
        pushad
        call    _log_tick_end
        popad
        mov     edx, dword ptr ds:[0x4b3780]
        push    0x482df9
        ret
