"""Cross-build function matcher over FeatureDump.java output (JSON lines).

  python3 match.py A.jsonl B.jsonl out.tsv [--cross] [--vt vt_A.json vt_B.json] [--fac fac.json]

Writes  ea_A  ea_B  method  score  for every accepted pair. Same-architecture mode (default) uses
address-masked instruction hashes, string sets and call-graph propagation with mnemonic
similarity. --cross (PowerPC Mac build vs x86) cannot compare instructions and uses strings,
API calls, field-offset constants and call-graph structure instead.
Analysis aid only: output feeds the specs in docs/, never the new code base.
"""
import sys, json, math, collections, difflib, re

def load(p):
    F = {}
    for l in open(p):
        f = json.loads(l)
        f['callees'] = [c for c in f['calls'] if not c.startswith('ext:')]
        f['api'] = sorted({re.sub(r'(A|W)$', '', c[4:]) for c in f['calls'] if c.startswith('ext:')})
        F[f['ea']] = f
    callers = collections.defaultdict(list)
    for ea, f in F.items():
        for c in f['callees']:
            if c in F: callers[c].append(ea)
    for ea, f in F.items(): f['callers'] = callers.get(ea, [])
    return F


class Matcher:
    def __init__(self, A, B, cross=False):
        self.A, self.B, self.cross = A, B, cross
        self.m, self.r, self.how = {}, {}, {}
        # constants: inverse document frequency over both programs
        df = collections.Counter()
        for F in (A, B):
            for f in F.values(): df.update(set(f['consts']))
        n = len(A) + len(B)
        self.idf = {c: math.log(n / k) for c, k in df.items()}

    def add(self, a, b, how, score=1.0):
        if a in self.m or b in self.r: return False
        self.m[a], self.r[b], self.how[a] = b, a, (how, score)
        return True

    # ---- similarity ----
    def mnsim(self, a, b):
        x, y = self.A[a]['mn'].split(), self.B[b]['mn'].split()
        if not x or not y: return 0.0
        if min(len(x), len(y)) / max(len(x), len(y)) < 0.5: return 0.0
        return difflib.SequenceMatcher(None, x, y, autojunk=False).ratio()

    def constsim(self, a, b):
        x = collections.Counter(self.A[a]['consts']); y = collections.Counter(self.B[b]['consts'])
        if not x or not y: return 0.0
        num = sum(min(x[c], y[c]) * self.idf.get(c, 0) for c in x if c in y)
        den = math.sqrt(sum(v * self.idf.get(c, 0) for c, v in x.items()) * sum(v * self.idf.get(c, 0) for c, v in y.items()))
        return num / den if den else 0.0

    def setsim(self, x, y):
        x, y = set(x), set(y)
        if not x and not y: return None
        return len(x & y) / len(x | y)

    def nbrsim(self, a, b):
        """Fraction of already matched neighbours that agree."""
        fa, fb = self.A[a], self.B[b]
        agree = tot = 0
        for xs, ys, mp in ((fa['callees'], fb['callees'], self.m), (fa['callers'], fb['callers'], self.m)):
            ys = set(ys)
            for x in set(xs):
                if x in mp:
                    tot += 1; agree += mp[x] in ys
        return (agree / tot, tot) if tot else (0.0, 0)

    def score(self, a, b):
        fa, fb = self.A[a], self.B[b]
        if self.cross:
            s = 0.0; w = 0.0
            ss = self.setsim(norm_strs(fa['strs']), norm_strs(fb['strs']))
            if ss is not None: s += 3 * ss; w += 3
            aa = self.setsim(fa['api'], fb['api'])
            if aa is not None: s += 2 * aa; w += 2
            if fa['consts'] or fb['consts']:
                cs = self.constsim(a, b); s += 3 * min(1.0, cs * 2); w += 3
            ns, nt = self.nbrsim(a, b)
            if nt: s += 3 * ns; w += 3
            # size: instruction counts are about equal (PowerPC / x86), log-ratio penalty
            ra = abs(math.log(max(1, fa['ni']) / max(1, fb['ni'])))
            s += 2 * math.exp(-ra * 1.5); w += 2
            nc = abs(math.log((len(set(fa['callees'])) + 1) / (len(set(fb['callees'])) + 1)) - 0.45)
            s += 1 * math.exp(-nc); w += 1
            # callers: a function called from many places is called from many places in both builds
            ca, cb = len(set(fa['callers'])), len(set(fb['callers']))
            cr = abs(math.log((ca + 1) / (cb + 1)))
            s += 2 * math.exp(-cr); w += 2
            if max(ca, cb) >= 8 and cr > 1.2: return 0.0
            return s / w
        ms = self.mnsim(a, b)
        ns, nt = self.nbrsim(a, b)
        return 0.7 * ms + 0.3 * (ns if nt else ms)

    # ---- phases ----
    def exact_hash(self):
        ha = collections.defaultdict(list); hb = collections.defaultdict(list)
        for ea, f in self.A.items():
            if f['ni'] >= 6: ha[f['sh']].append(ea)
        for ea, f in self.B.items():
            if f['ni'] >= 6: hb[f['sh']].append(ea)
        n = 0
        for h, xs in ha.items():
            if len(xs) == 1 and len(hb.get(h, [])) == 1: n += self.add(xs[0], hb[h][0], 'hash')
        return n

    def unique_strings(self):
        def key(f): return tuple(sorted(set(norm_strs(f['strs']))))
        ka = collections.defaultdict(list); kb = collections.defaultdict(list)
        for ea, f in self.A.items():
            k = key(f)
            if k and sum(len(s) for s in k) >= 8: ka[k].append(ea)
        for ea, f in self.B.items():
            k = key(f)
            if k and sum(len(s) for s in k) >= 8: kb[k].append(ea)
        n = 0
        for k, xs in ka.items():
            if len(xs) == 1 and len(kb.get(k, [])) == 1:
                a, b = xs[0], kb[k][0]
                if self.cross or self.mnsim(a, b) > 0.5: n += self.add(a, b, 'strings')
        return n

    def propagate(self, thresh, margin):
        """Candidates: unmatched neighbours of matched pairs. Accept mutual best with margin."""
        cand = collections.defaultdict(set)
        for a, b in list(self.m.items()):
            fa, fb = self.A[a], self.B[b]
            for xs, ys in ((fa['callees'], fb['callees']), (fa['callers'], fb['callers'])):
                xs = [x for x in dict.fromkeys(xs) if x in self.A and x not in self.m]
                ys = [y for y in dict.fromkeys(ys) if y in self.B and y not in self.r]
                if not xs or not ys or len(xs) * len(ys) > 400: continue
                for x in xs:
                    for y in ys: cand[x].add(y)
        sc = {}
        for x, ys in cand.items():
            for y in ys: sc[(x, y)] = self.score(x, y)
        best_a = {}; best_b = {}
        for (x, y), s in sc.items():
            best_a.setdefault(x, []).append((s, y)); best_b.setdefault(y, []).append((s, x))
        n = 0
        for x, lst in best_a.items():
            lst.sort(reverse=True)
            s, y = lst[0]
            if s < thresh: continue
            if len(lst) > 1 and s - lst[1][0] < margin: continue
            lb = sorted(best_b[y], reverse=True)
            if lb[0][1] != x or (len(lb) > 1 and s - lb[1][0] < margin): continue
            n += self.add(x, y, 'graph', s)
        return n

    def callee_alignment(self):
        """Matched pair with callee lists of equal shape: pair unmatched callees by position."""
        n = 0
        for a, b in list(self.m.items()):
            xa = [c for c in self.A[a]['callees'] if c in self.A]
            xb = [c for c in self.B[b]['callees'] if c in self.B]
            if len(xa) != len(xb) or not xa: continue
            ok = all((x in self.m) == (y in self.r) and (x not in self.m or self.m[x] == y) for x, y in zip(xa, xb))
            if not ok: continue
            for x, y in zip(xa, xb):
                if x not in self.m and y not in self.r:
                    if self.cross or self.mnsim(x, y) > 0.6: n += self.add(x, y, 'align')
        return n

    # ---- vtables (cross mode): factory seeds, slot alignment, shared-slot propagation ----
    def vt_init(self, vta, vtb, fac):
        self.VA = {v['addr']: v['slots'] for v in vta}
        self.VB = {v['addr']: v['slots'] for v in vtb}
        self.vm, self.vr = {}, {}
        if fac:
            for c in fac['cases'].values():
                if c['mac_vt'] and c['pc_vts']: self.vt_add(c['mac_vt'], c['pc_vts'][-1])

    def vt_add(self, a, b):
        if a in self.vm or b in self.vr: return 0
        self.vm[a], self.vr[b] = b, a
        n = 0
        for x, y in zip(self.VA[a], self.VB[b]):
            if x in self.A and y in self.B: n += self.add(x, y, 'vtable')
        return n

    def vt_propagate(self):
        n = 0
        cand = []
        for a, sa in self.VA.items():
            if a in self.vm: continue
            best = []
            for b, sb in self.VB.items():
                if b in self.vr: continue
                agree = conflict = 0
                for x, y in zip(sa, sb):
                    if x in self.m: agree += self.m[x] == y; conflict += self.m[x] != y
                    elif y in self.r: conflict += 1
                if agree and not conflict:
                    # all mapped slots agree; prefer equal length, more agreements
                    best.append((agree + (0.5 if len(sa) == len(sb) else 0), b))
            best.sort(reverse=True)
            if best and (len(best) == 1 or best[0][0] > best[1][0]): cand.append((a, best[0][1], best[0][0]))
        rb = {}
        for a, b, s in cand: rb.setdefault(b, []).append((s, a))
        for b, lst in rb.items():
            lst.sort(reverse=True)
            if len(lst) == 1 or lst[0][0] > lst[1][0]: n += 1; self.vt_add(lst[0][1], b)
        return n

    def gap_alignment(self):
        """Between consecutive matched callees (in call order), pair equal-sized gaps of unmatched callees."""
        n = 0
        for a, b in list(self.m.items()):
            la = list(dict.fromkeys(c for c in self.A[a]['callees'] if c in self.A))
            lb = list(dict.fromkeys(c for c in self.B[b]['callees'] if c in self.B))
            pos_b = {y: j for j, y in enumerate(lb)}
            anchors = [(i, pos_b[self.m[x]]) for i, x in enumerate(la) if x in self.m and self.m[x] in pos_b]
            # keep an increasing chain
            chain, last = [(-1, -1)], -1
            for i, j in anchors:
                if j > last: chain.append((i, j)); last = j
            chain.append((len(la), len(lb)))
            for (i0, j0), (i1, j1) in zip(chain, chain[1:]):
                ga = [x for x in la[i0 + 1:i1] if x not in self.m]
                gb = [y for y in lb[j0 + 1:j1] if y not in self.r]
                if not ga or not gb: continue
                if len(ga) == len(gb) and len(ga) <= 3:
                    for x, y in zip(ga, gb):
                        if self.score(x, y) >= 0.45: n += self.add(x, y, 'gap')
                elif len(gb) == 1 and len(ga) <= 4:
                    sc = sorted(((self.score(x, gb[0]), x) for x in ga), reverse=True)
                    if sc[0][0] >= 0.55 and (len(sc) == 1 or sc[0][0] - sc[1][0] >= 0.1):
                        n += self.add(sc[0][1], gb[0], 'gap')
        return n

    def addr_alignment(self, maxgap=12, minscore=0.5):
        """Functions of one source file are emitted in definition order by both compilers: between
        two matched pairs that are address neighbours on both sides, align the unmatched functions
        in between (dynamic programming over the pair scores)."""
        ea_a = sorted(self.A); ea_b = sorted(self.B)
        ia = {e: i for i, e in enumerate(ea_a)}; ib = {e: i for i, e in enumerate(ea_b)}
        pairs = sorted((ia[a], ib[b]) for a, b in self.m.items() if a in ia and b in ib)
        n = 0
        for (a0, b0), (a1, b1) in zip(pairs, pairs[1:]):
            if not (b0 < b1) or a1 - a0 > maxgap or b1 - b0 > maxgap: continue
            ga = [ea_a[i] for i in range(a0 + 1, a1) if ea_a[i] not in self.m]
            gb = [ea_b[j] for j in range(b0 + 1, b1) if ea_b[j] not in self.r]
            if not ga or not gb: continue
            S = [[self.score(x, y) for y in gb] for x in ga]
            # DP: best monotonic set of pairs with score above minscore
            R, C = len(ga), len(gb)
            dp = [[0.0] * (C + 1) for _ in range(R + 1)]; bk = [[0] * (C + 1) for _ in range(R + 1)]
            for i in range(1, R + 1):
                for j in range(1, C + 1):
                    opts = [(dp[i - 1][j], 1), (dp[i][j - 1], 2)]
                    if S[i - 1][j - 1] >= minscore: opts.append((dp[i - 1][j - 1] + S[i - 1][j - 1], 3))
                    dp[i][j], bk[i][j] = max(opts)
            i, j = R, C
            while i and j:
                if bk[i][j] == 3:
                    n += self.add(ga[i - 1], gb[j - 1], 'order', S[i - 1][j - 1]); i -= 1; j -= 1
                elif bk[i][j] == 1: i -= 1
                else: j -= 1
        return n

    def run(self):
        log = []
        if getattr(self, 'VA', None) is not None:
            log.append(('vtable-seed', len(self.m)))
            for it in range(10):
                k = self.vt_propagate(); log.append((f'vt{it}', k, len(self.m)))
                if not k: break
        if not self.cross: log.append(('hash', self.exact_hash()))
        log.append(('strings', self.unique_strings()))
        if self.cross: log.append(('api', self.unique_api()))
        for it in range(30):
            k = self.callee_alignment()
            g = self.propagate(0.80 if not self.cross else self.th, 0.05 if not self.cross else self.mg)
            v = self.vt_propagate() if getattr(self, 'VA', None) is not None else 0
            q = self.gap_alignment() if self.cross else 0
            o = self.addr_alignment(minscore=self.om) if self.cross else 0
            log.append((f'iter{it}', k, g, v, q, o))
            if k + g + v + q + o == 0: break
        if not self.cross:
            log.append(('fuzzy', self.fuzzy_global()))
            for it in range(10):
                k = self.callee_alignment(); g = self.propagate(0.70, 0.05)
                log.append((f'iter2-{it}', k, g))
                if k + g == 0: break
        return log

    def unique_api(self):
        ka = collections.defaultdict(list); kb = collections.defaultdict(list)
        for ea, f in self.A.items():
            if len(f['api']) >= 2: ka[tuple(f['api'])].append(ea)
        for ea, f in self.B.items():
            if len(f['api']) >= 2: kb[tuple(f['api'])].append(ea)
        n = 0
        for k, xs in ka.items():
            if len(xs) == 1 and len(kb.get(k, [])) == 1: n += self.add(xs[0], kb[k][0], 'api')
        return n

    def fuzzy_global(self):
        """Same-arch only: unmatched functions with a near-identical mnemonic sequence of similar size."""
        ua = [a for a in self.A if a not in self.m and self.A[a]['ni'] >= 12]
        ub = [b for b in self.B if b not in self.r and self.B[b]['ni'] >= 12]
        byn = collections.defaultdict(list)
        for b in ub: byn[self.B[b]['ni'] // 8].append(b)
        best = {}
        for a in ua:
            k = self.A[a]['ni'] // 8
            cs = [b for d in (-1, 0, 1) for b in byn.get(k + d, [])]
            sc = sorted(((self.mnsim(a, b), b) for b in cs), reverse=True)[:2]
            if sc and sc[0][0] >= 0.9 and (len(sc) == 1 or sc[0][0] - sc[1][0] >= 0.05): best[a] = sc[0]
        rb = collections.defaultdict(list)
        for a, (s, b) in best.items(): rb[b].append((s, a))
        n = 0
        for b, lst in rb.items():
            if len(lst) == 1: n += self.add(lst[0][1], b, 'fuzzy', lst[0][0])
        return n


def norm_strs(ss):
    out = []
    for s in ss:
        s = s.replace(':', '/').replace('\\', '/').lower().strip()
        if len(s) >= 4 and not set(s) <= set('\xff'): out.append(s)
    return out


if __name__ == '__main__':
    A, B = load(sys.argv[1]), load(sys.argv[2])
    cross = '--cross' in sys.argv
    if cross:  # drop Mac library/template code that MSVC inlines or links differently
        A = {k: v for k, v in A.items() if not v['name'].startswith('std::') and '<' not in v['name'].split('::')[0]}
        for f in A.values(): f['callees'] = [c for c in f['callees'] if c in A]
        for f in A.values(): f['callers'] = [c for c in f['callers'] if c in A]
    M = Matcher(A, B, cross)
    M.th = float(sys.argv[sys.argv.index('--th') + 1]) if '--th' in sys.argv else 0.62
    M.om = float(sys.argv[sys.argv.index('--om') + 1]) if '--om' in sys.argv else 0.5
    M.mg = float(sys.argv[sys.argv.index('--mg') + 1]) if '--mg' in sys.argv else 0.08
    if '--exclude-b' in sys.argv:  # B functions that must stay unmatched (library code, disproved names)
        for l in open(sys.argv[sys.argv.index('--exclude-b') + 1]):
            e = l.split('\t')[0].strip()
            if e in B: M.r[e] = None
    if '--seed' in sys.argv:
        for l in open(sys.argv[sys.argv.index('--seed') + 1]):
            c = l.rstrip('\n').split('\t')
            if c[0] in A and c[1] in B: M.add(c[0], c[1], 'seed')
    if '--vt' in sys.argv:
        i = sys.argv.index('--vt')
        fac = json.load(open(sys.argv[sys.argv.index('--fac') + 1])) if '--fac' in sys.argv else None
        M.vt_init(json.load(open(sys.argv[i + 1])), json.load(open(sys.argv[i + 2])), fac)
    for row in M.run(): print(*row, file=sys.stderr)
    with open(sys.argv[3], 'w') as out:
        for a, b in sorted((a, b) for a, b in M.m.items() if b is not None):
            how, s = M.how[a]
            out.write(f'{a}\t{b}\t{how}\t{s:.3f}\t{A[a]["name"]}\t{B[b]["name"]}\n')
    print('matched', len(M.m), 'of', len(A), '/', len(B), file=sys.stderr)
