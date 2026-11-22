"""Score a match file against a ground-truth file (both: ea_A <tab> ea_B ...)."""
import sys, collections
m = {}
for l in open(sys.argv[1]):
    c = l.split('\t'); m[c[0]] = (c[1], c[2])
ok = bad = miss = 0; byhow = collections.Counter(); badhow = collections.Counter()
for l in open(sys.argv[2]):
    a, b = l.split('\t')[:2]
    if a not in m: miss += 1
    elif m[a][0] == b: ok += 1; byhow[m[a][1]] += 1
    else: bad += 1; badhow[m[a][1]] += 1
print(f'correct {ok}  wrong {bad}  unmatched {miss}  precision {ok / max(1, ok + bad):.3f}')
print(' correct by method', dict(byhow), ' wrong by method', dict(badhow))
print(' all matches by method', dict(collections.Counter(h for _, h in m.values())), 'total', len(m))
