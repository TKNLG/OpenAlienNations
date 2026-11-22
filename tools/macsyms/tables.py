"""Seed pairs from function-pointer tables that exist in both builds in the same order
(message handlers, dialog handlers, mission goals). Picks the index offset with the best
instruction-count agreement and keeps pairs whose sizes are plausible.
  python3 tables.py A.jsonl B.jsonl vt_A.json vt_B.json addrA:addrB[:offset] [...] > seeds.tsv
(offset forced when given: B index = A index + offset; the message table needs +1)
Analysis aid only: output feeds the specs in docs/, never the new code base.
"""
import sys, json, math
A = {json.loads(l)['ea']: json.loads(l) for l in open(sys.argv[1])}
B = {json.loads(l)['ea']: json.loads(l) for l in open(sys.argv[2])}
VA = {v['addr']: v['slots'] for v in json.load(open(sys.argv[3]))}
VB = {v['addr']: v['slots'] for v in json.load(open(sys.argv[4]))}
def ok(x, y):
    if x not in A or y not in B: return 0
    r = abs(math.log(max(1, A[x]['ni']) / max(1, B[y]['ni'])))
    return math.exp(-r * 1.5)
for pair in sys.argv[5:]:
    parts = pair.split(':'); a, b = parts[0], parts[1]; ta, tb = VA[a], VB[b]
    if len(parts) > 2: best = int(parts[2])
    else: best = max(range(-4, 5), key=lambda o: sum(ok(ta[i], tb[i + o]) for i in range(len(ta)) if 0 <= i + o < len(tb)))
    n = 0
    for i, x in enumerate(ta):
        j = i + best
        if 0 <= j < len(tb) and ok(x, tb[j]) > 0.3:
            print(f'{x}\t{tb[j]}\ttable:{a}'); n += 1
    print(f'table {a}->{b} offset {best} pairs {n}/{len(ta)}', file=sys.stderr)
