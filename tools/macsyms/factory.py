"""Pair job classes of the Mac and PC builds through their job factories (case id = job type).

  python3 factory.py <exe> <jumptable hex> <ncases> <switch end hex> <mac decomp.c> <mac factory hex> <vt_mac.json> <vt_pc.json> out.json

PC: for each case target, walk the instructions (objdump) until the jump to the common end and
take the vtable pointers stored with `mov DWORD PTR [reg],imm32` (inlined constructors: base
class first, final class last). Mac: the decompiled factory calls Class::Class per case; the Mac
vtable of a class is the one whose first slot is Class::~Class.
Output: {"cases": {id: {"mac_class", "mac_vt", "pc_vts": [...]}}}.
Analysis aid only: output feeds the specs in docs/, never the new code base.
"""
import sys, json, struct, re, subprocess


def pe_read(d):
    pe = struct.unpack_from('<I', d, 0x3c)[0]; n = struct.unpack_from('<H', d, pe + 6)[0]
    opt = struct.unpack_from('<H', d, pe + 20)[0]; ib = struct.unpack_from('<I', d, pe + 52)[0]
    secs = []
    for i in range(n):
        o = pe + 24 + opt + 40 * i
        vs, va, rs, ro = struct.unpack_from('<IIII', d, o + 8)
        secs.append((ib + va, vs, ro))
    def off(a):
        for va, vs, ro in secs:
            if va <= a < va + vs: return ro + a - va
    return off


def main(exe, jt, ncases, end, mac_decomp, mac_fac, vt_mac, vt_pc, outp):
    d = open(exe, 'rb').read(); off = pe_read(d)
    jt, ncases, end = int(jt, 16), int(ncases), int(end, 16)
    pcvt = {v['addr'] for v in json.load(open(vt_pc))}
    targets = [struct.unpack_from('<I', d, off(jt + 4 * i))[0] for i in range(ncases)]
    lo, hi = min(targets), max(max(targets) + 0x200, end)
    lines = subprocess.run(['objdump', '-d', '-M', 'intel', f'--start-address={lo:#x}', f'--stop-address={hi:#x}', exe],
                           capture_output=True, text=True).stdout.splitlines()
    ins = []
    for l in lines:
        m = re.match(r'\s+([0-9a-f]+):\t[0-9a-f ]+\t(.*)', l)
        if m: ins.append((int(m.group(1), 16), m.group(2)))
    idx = {a: i for i, (a, _) in enumerate(ins)}
    pc = {}
    for case, t in enumerate(targets):
        if t == end or t not in idx: continue
        vts = []
        for a, txt in ins[idx[t]:idx[t] + 400]:
            m = re.search(r'mov\s+DWORD PTR \[(e[a-z]+)\],0x([0-9a-f]+)', txt)
            if m and m.group(2).zfill(8) in pcvt: vts.append(m.group(2).zfill(8))
            if re.match(r'jmp\s+0x([0-9a-f]+)', txt) and abs(int(re.match(r'jmp\s+0x([0-9a-f]+)', txt).group(1), 16) - end) < 0x10:
                break
            if txt.startswith('ret'): break
        pc[case] = vts
    # Mac
    src = open(mac_decomp, encoding='latin1').read()
    i = src.index(f'// ===== {int(mac_fac, 16):08x} ')
    body = src[i:src.index('\n}\n', i)]
    mac = {}
    cur = None
    for l in body.splitlines():
        m = re.match(r'\s*case (0x[0-9a-f]+|\d+):', l)
        if m: cur = int(m.group(1), 0); continue
        m = re.match(r'\s*([A-Za-z_0-9]+)::\1\(', l)
        if m and cur is not None and cur not in mac: mac[cur] = m.group(1)
    names = {}
    for l in open(mac_decomp.replace('decomp.c', '../match/mac.jsonl')):
        f = json.loads(l); names[f['ea']] = f['name']
    macvt = {}
    for v in json.load(open(vt_mac)):
        n0 = names.get(v['slots'][0], '')
        p = n0.split('::')
        if len(p) >= 2 and p[-1] == '~' + p[-2]: macvt.setdefault(p[-2], v['addr'])
    out = {}
    for case in sorted(set(pc) | set(mac)):
        cls = mac.get(case)
        out[case] = {'mac_class': cls, 'mac_vt': macvt.get(cls), 'pc_vts': pc.get(case, [])}
    json.dump({'cases': out}, open(outp, 'w'), indent=1)
    ok = sum(1 for c in out.values() if c['mac_vt'] and c['pc_vts'])
    print('cases', len(out), 'paired', ok, file=sys.stderr)


if __name__ == '__main__':
    main(*sys.argv[1:10])
