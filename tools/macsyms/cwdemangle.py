# Minimal CodeWarrior (ARM/cfront-style) demangler for the Mac symbol names.
#   .Work__10DVEvadeJobFv              -> ('DVEvadeJob', 'Work', '()')
#   .AddHomeless__4TownFP6DVUnit       -> ('Town', 'AddHomeless', '(DVUnit *)')
#   .dlg_groupinfo__Fi                 -> ('', 'dlg_groupinfo', '(int)')
#   .__ct__17MsgObjectWasBuiltFii      -> ('MsgObjectWasBuilt', 'MsgObjectWasBuilt', '(int, int)')
# Writes TSV: addr  namespace  name  params  const  raw
import sys, json, re

BASIC = {'v': 'void', 'c': 'char', 's': 'short', 'i': 'int', 'l': 'long', 'x': 'long long',
         'f': 'float', 'd': 'double', 'r': 'long double', 'b': 'bool', 'w': 'wchar_t', 'e': '...'}
OPS = {'__ct': None, '__dt': '~', '__as': 'operator=', '__eq': 'operator==', '__ne': 'operator!=',
       '__lt': 'operator<', '__gt': 'operator>', '__le': 'operator<=', '__ge': 'operator>=',
       '__pl': 'operator+', '__mi': 'operator-', '__ml': 'operator*', '__dv': 'operator/',
       '__md': 'operator%', '__apl': 'operator+=', '__ami': 'operator-=', '__amu': 'operator*=',
       '__adv': 'operator/=', '__vc': 'operator[]', '__cl': 'operator()', '__rf': 'operator->',
       '__nw': 'operator new', '__dl': 'operator delete', '__nwa': 'operator new[]',
       '__dla': 'operator delete[]', '__pp': 'operator++', '__mm': 'operator--', '__nt': 'operator!',
       '__aa': 'operator&&', '__oo': 'operator||', '__ls': 'operator<<', '__rs': 'operator>>',
       '__ad': 'operator&', '__or': 'operator|', '__er': 'operator^', '__co': 'operator~',
       '__aad': 'operator&=', '__aor': 'operator|=', '__opb': 'operator bool', '__opi': 'operator int'}


class P:
    def __init__(self, s): self.s, self.i = s, 0
    def peek(self): return self.s[self.i] if self.i < len(self.s) else ''
    def take(self, n=1):
        r = self.s[self.i:self.i + n]; self.i += n; return r
    def num(self):
        m = re.match(r'\d+', self.s[self.i:])
        if not m: raise ValueError('num')
        self.i += len(m.group()); return int(m.group())

    def name(self):
        n = self.num(); return self.take(n)

    def qual(self):
        if self.peek() == 'Q':
            self.take(); cnt = int(self.take())
            return '::'.join(self.name() for _ in range(cnt))
        return self.name()

    def typ(self):
        pre = ''
        quals = []
        while True:
            c = self.peek()
            if c == 'C': self.take(); quals.append('const')
            elif c == 'V': self.take(); quals.append('volatile')
            elif c == 'U': self.take(); pre = 'unsigned '
            elif c == 'S': self.take(); pre = 'signed '
            else: break
        c = self.peek()
        q = (' '.join(quals) + ' ') if quals else ''
        if c == 'P': self.take(); return q + self.typ() + ' *'
        if c == 'R': self.take(); return q + self.typ() + ' &'
        if c == 'A':
            self.take(); n = self.num(); self.take()  # '_'
            return q + self.typ() + f'[{n}]'
        if c == 'F':
            self.take(); args = self.args(stop='_'); self.take(); ret = self.typ()
            return f'{ret} (*)({args})'
        if c == 'M':
            self.take(); cls = self.qual(); t = self.typ(); return f'{t} {cls}::*'
        if c.isdigit() or c == 'Q': return q + self.qual()
        if c in BASIC: self.take(); return q + pre + BASIC[c]
        raise ValueError('type ' + c)

    def args(self, stop=''):
        out = []
        while self.i < len(self.s) and self.peek() != stop:
            c = self.peek()
            if c == 'T':  # repeat earlier arg
                self.take(); k = int(self.take()); out.append(out[k - 1] if k - 1 < len(out) else '?'); continue
            if c == 'N':
                self.take(); r = int(self.take()); k = int(self.take())
                out += [out[k - 1] if k - 1 < len(out) else '?'] * r; continue
            out.append(self.typ())
        return ', '.join(a for a in out if a != 'void')


def demangle(raw):
    s = raw[1:] if raw.startswith('.') else raw
    # split at the last "__" that is followed by a class/qualifier/F
    for m in reversed(list(re.finditer(r'__(?=[0-9QFC])', s))):
        base, rest = s[:m.start()], s[m.end():]
        if not base: continue
        try:
            p = P(rest); cls = ''
            if p.peek() in 'Q0123456789': cls = p.qual()
            const = False
            if p.peek() == 'C': p.take(); const = True
            if p.peek() != 'F': continue
            p.take(); args = p.args()
            if p.i != len(rest): continue
            meth = base
            if base in OPS:
                last = cls.split('::')[-1].split('<')[0] if cls else ''
                meth = last if OPS[base] is None else (('~' + last) if OPS[base] == '~' else OPS[base])
            return cls, meth, f'({args})', const
        except (ValueError, IndexError):
            continue
    return None


if __name__ == '__main__':
    d = json.load(open(sys.argv[1]))
    funcs = {ea for ea, _, _ in d['functions']}
    ok = bad = 0
    with open(sys.argv[2], 'w') as out:
        for ea, n in d['names']:
            r = demangle(n)
            kind = 'func' if ea in funcs else 'label'
            if r:
                ok += 1; cls, meth, args, const = r
                out.write(f'{ea:08x}\t{kind}\t{cls}\t{meth}\t{args}\t{int(const)}\t{n}\n')
            else:
                bad += 1
                plain = n[1:] if n.startswith('.') else n
                out.write(f'{ea:08x}\t{kind}\t\t{plain}\t\t0\t{n}\n')
        named = {ea for ea, _ in d['names']}
        for ea, _, n in d['functions']:  # unnamed functions (sub_...): start address only
            if ea not in named: out.write(f'{ea:08x}\tfunc\t\t{n}\t\t0\t{n}\n')
    print('demangled', ok, 'plain', bad, file=sys.stderr)
