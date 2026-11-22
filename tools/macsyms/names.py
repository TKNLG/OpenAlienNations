"""Build per-program name tables from the match files.
  python3 names.py <mac names.tsv> <m_mac_pc.tsv> <out_pc.tsv> [<m_pc_pc2.tsv> <out_pc2.tsv>]
Output: pc_ea  mac_ea  Class::method  signature  match method. IDA auto names are skipped.
Analysis aid only: output feeds the specs in docs/, never the new code base.
"""
import sys, re
sig = {}
for l in open(sys.argv[1], encoding='latin1'):
    c = l.rstrip('\n').split('\t')
    if len(c) >= 7 and c[1] == 'func':
        sig[c[0]] = (c[2] + '::' if c[2] else '') + c[3] + c[4] + (' const' if c[5] == '1' else '')
auto = re.compile(r'^(sub_|nullsub_|unknown_libname|j_|loc_|FUN_)')
rows = []
for l in open(sys.argv[2]):
    a, b, how, s, na, nb = l.rstrip('\n').split('\t')
    if auto.match(na.split('::')[-1]): continue
    rows.append((b, a, na, sig.get(a, na), how))
with open(sys.argv[3], 'w') as o:
    for r in sorted(rows): o.write('\t'.join(r) + '\n')
print(sys.argv[3], len(rows), file=sys.stderr)
if len(sys.argv) > 5:
    t = {}
    for l in open(sys.argv[4]):
        c = l.split('\t'); t[c[0]] = c[1]
    with open(sys.argv[5], 'w') as o:
        n = 0
        for b, a, na, sg, how in sorted(rows):
            if b in t: o.write('\t'.join((t[b], a, na, sg, how)) + '\n'); n += 1
    print(sys.argv[5], n, file=sys.stderr)
