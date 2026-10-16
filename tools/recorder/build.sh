#!/usr/bin/env bash
# Build anrec.dll (PE32 i386) with the x86 w64devkit.
# Usage: tools/recorder/build.sh [w64devkit dir]   (or set W64DEVKIT; default: gcc/objdump on PATH)
set -euo pipefail
cd "$(dirname "$0")"
W64="${1:-${W64DEVKIT:-}}"
if [ -n "$W64" ]; then export PATH="$W64/bin:$PATH"; fi
mkdir -p out
gcc -shared -O2 -Wall -Wextra -o out/anrec.dll anrec.c hooks.S -static-libgcc -lkernel32
objdump -f out/anrec.dll | grep -q 'pei-i386' && echo "built tools/recorder/out/anrec.dll (PE32 i386)"
