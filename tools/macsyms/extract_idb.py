# Extract segments (raw bytes), functions and names from the Mac IDA database (python-idb).
import sys, idb, json
src, out = sys.argv[1], sys.argv[2]
with idb.from_file(src) as db:
    api = idb.IDAPython(db)
    segs = []
    for s in api.idautils.Segments():
        e = api.idc.SegEnd(s); name = api.idc.SegName(s) or ('code' if s == 0 else 'data')
        b = bytearray()
        CH = 0x10000
        for a in range(s, e, CH):
            n = min(CH, e - a)
            try: b += bytes(api.idc.GetManyBytes(a, n))
            except Exception:
                for x in range(a, a+n):
                    try: b.append(api.idc.Byte(x))
                    except Exception: b.append(0)
        open(f"{out}/seg_{s:08x}.bin", 'wb').write(b)
        segs.append({'start': s, 'end': e, 'name': name, 'file': f"seg_{s:08x}.bin"})
    funcs = []
    for ea in api.idautils.Functions():
        funcs.append([ea, api.idc.GetFunctionAttr(ea, api.idc.FUNCATTR_END), api.idc.GetFunctionName(ea)])
    names = [[ea, n] for ea, n in api.idautils.Names()]
    json.dump({'segments': segs, 'functions': funcs, 'names': names}, open(f"{out}/mac.json", 'w'))
    print(segs, len(funcs), len(names))
