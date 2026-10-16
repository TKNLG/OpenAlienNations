#!/usr/bin/env python3
"""Torch-free conversion of Real-ESRGAN .pth weights to ONNX.

- .pth (zip) is read with a *restricted* unpickler: only OrderedDict and the torch tensor
  rebuild helpers are allowed, so no arbitrary code from the download can run.
- The ONNX protobuf is written by a tiny hand-rolled encoder (no `onnx` package needed).

Usage: esrgan_onnx.py <in.pth> <out.onnx>
Supports RRDBNet (x4plus, x4plus_anime_6B, x2plus) and SRVGGNetCompact (animevideov3, general-x4v3).
For x2plus the model expects pixel-unshuffled input (12 ch); done in numpy by the runner.
"""
import io, pickle, struct, sys, zipfile, collections
import numpy as np

# ---------------------------------------------------------------- pth loading
_DT = {'FloatStorage': np.float32, 'HalfStorage': np.float16, 'DoubleStorage': np.float64,
       'LongStorage': np.int64, 'IntStorage': np.int32}


class _Storage:
    def __init__(self, kind):
        self.kind = kind


def _rebuild_tensor_v2(storage, offset, size, stride, requires_grad=False, hooks=None, meta=None):
    arr, = storage
    n = int(np.prod(size)) if size else 1
    itemsize = arr.itemsize
    if n == 0:
        return np.zeros(size, arr.dtype)
    out = np.lib.stride_tricks.as_strided(arr[offset:], shape=tuple(size),
                                          strides=tuple(s * itemsize for s in stride))
    return np.array(out)


def _rebuild_parameter(data, requires_grad, hooks):
    return data


class _Unpickler(pickle.Unpickler):
    def __init__(self, f, zf, prefix):
        super().__init__(f)
        self.zf, self.prefix = zf, prefix

    def find_class(self, mod, name):
        if (mod, name) == ('collections', 'OrderedDict'):
            return collections.OrderedDict
        if mod == 'torch._utils' and name == '_rebuild_tensor_v2':
            return _rebuild_tensor_v2
        if mod == 'torch._utils' and name == '_rebuild_parameter':
            return _rebuild_parameter
        if mod == 'torch' and name in _DT:
            return _Storage(name)
        raise pickle.UnpicklingError(f'blocked global {mod}.{name}')

    def persistent_load(self, pid):
        # ('storage', storage_type, key, location, numel)
        _, st, key, _loc, _n = pid
        raw = self.zf.read(f'{self.prefix}/data/{key}')
        return [np.frombuffer(raw, _DT[st.kind])]   # list so _rebuild sees a 1-tuple-like


def load_pth(path):
    zf = zipfile.ZipFile(path)
    pkl = [n for n in zf.namelist() if n.endswith('data.pkl')][0]
    prefix = pkl[:-len('/data.pkl')]
    sd = _Unpickler(io.BytesIO(zf.read(pkl)), zf, prefix).load()
    for k in ('params_ema', 'params'):
        if isinstance(sd, dict) and k in sd:
            return sd[k]
    return sd


# ---------------------------------------------------------------- protobuf encoder
def _varint(v):
    if v < 0:
        v += 1 << 64
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def f_varint(field, v):
    return _varint(field << 3 | 0) + _varint(v)


def f_bytes(field, b):
    if isinstance(b, str):
        b = b.encode()
    return _varint(field << 3 | 2) + _varint(len(b)) + b


def f_float(field, v):
    return _varint(field << 3 | 5) + struct.pack('<f', v)


def tensor(name, arr):
    arr = np.ascontiguousarray(arr)
    dt = {np.dtype('float32'): 1, np.dtype('int64'): 7}[arr.dtype]
    return b''.join([f_varint(1, d) for d in arr.shape]) + f_varint(2, dt) + \
        f_bytes(8, name) + f_bytes(9, arr.tobytes())


def attr(name, v):
    if isinstance(v, float):
        return f_bytes(1, name) + f_float(2, v) + f_varint(20, 1)
    if isinstance(v, int):
        return f_bytes(1, name) + f_varint(3, v) + f_varint(20, 2)
    if isinstance(v, str):
        return f_bytes(1, name) + f_bytes(4, v) + f_varint(20, 3)
    if isinstance(v, (list, tuple)):
        return f_bytes(1, name) + b''.join(f_varint(8, i) for i in v) + f_varint(20, 7)
    raise TypeError(v)


def value_info(name, dims):
    dim_msgs = b''
    for d in dims:
        dm = f_varint(1, d) if isinstance(d, int) else f_bytes(2, d)
        dim_msgs += f_bytes(1, dm)
    shape = dim_msgs
    tt = f_varint(1, 1) + f_bytes(2, shape)
    tp = f_bytes(1, tt)
    return f_bytes(1, name) + f_bytes(2, tp)


class G:
    def __init__(self):
        self.nodes, self.inits, self.n = [], [], 0

    def tmp(self, p='t'):
        self.n += 1
        return f'{p}{self.n}'

    def init(self, name, arr):
        self.inits.append(tensor(name, arr))
        return name

    def node(self, op, ins, attrs=None, out=None):
        out = out or self.tmp()
        b = b''.join(f_bytes(1, i) for i in ins) + f_bytes(2, out) + f_bytes(3, out) + f_bytes(4, op)
        for k, v in (attrs or {}).items():
            b += f_bytes(5, attr(k, v))
        self.nodes.append(b)
        return out

    def conv(self, x, sd, key):
        w = self.init(key + '.weight', sd[key + '.weight'].astype(np.float32))
        b = self.init(key + '.bias', sd[key + '.bias'].astype(np.float32))
        return self.node('Conv', [x, w, b], {'kernel_shape': [3, 3], 'pads': [1, 1, 1, 1]})

    def lrelu(self, x):
        return self.node('LeakyRelu', [x], {'alpha': 0.2})

    def scale(self, x, s):
        c = self.init(self.tmp('c'), np.array([s], np.float32))
        return self.node('Mul', [x, c])

    def up2(self, x):
        sc = self.init(self.tmp('sc'), np.array([1, 1, 2, 2], np.float32))
        return self.node('Resize', [x, '', sc], {'mode': 'nearest',
                                                 'coordinate_transformation_mode': 'asymmetric',
                                                 'nearest_mode': 'floor'})

    def model(self, in_ch, out_ch=3):
        graph = b''.join(f_bytes(1, n) for n in self.nodes) + f_bytes(2, 'g') + \
            b''.join(f_bytes(5, t) for t in self.inits) + \
            f_bytes(11, value_info('input', [1, in_ch, 'h', 'w'])) + \
            f_bytes(12, value_info('output', [1, out_ch, 'H', 'W']))
        opset = f_bytes(1, '') + f_varint(2, 17)
        return f_varint(1, 8) + f_bytes(2, 'esrgan_onnx.py') + f_bytes(7, graph) + f_bytes(8, opset)


def build_rrdb(sd):
    g = G()
    nb = 1 + max(int(k.split('.')[1]) for k in sd if k.startswith('body.'))
    in_ch = sd['conv_first.weight'].shape[1]
    feat = g.conv('input', sd, 'conv_first')
    x = feat
    for b in range(nb):
        rin = x
        for r in (1, 2, 3):
            p = f'body.{b}.rdb{r}'
            xs = [x]
            for c in range(1, 5):
                cat = xs[0] if len(xs) == 1 else g.node('Concat', xs, {'axis': 1})
                xs.append(g.lrelu(g.conv(cat, sd, f'{p}.conv{c}')))
            x5 = g.conv(g.node('Concat', xs, {'axis': 1}), sd, f'{p}.conv5')
            x = g.node('Add', [g.scale(x5, 0.2), x])
        x = g.node('Add', [g.scale(x, 0.2), rin])
    feat = g.node('Add', [feat, g.conv(x, sd, 'conv_body')])
    feat = g.lrelu(g.conv(g.up2(feat), sd, 'conv_up1'))
    feat = g.lrelu(g.conv(g.up2(feat), sd, 'conv_up2'))
    out = g.conv(g.lrelu(g.conv(feat, sd, 'conv_hr')), sd, 'conv_last')
    g.node('Identity', [out], out='output')
    return g.model(in_ch), dict(arch='RRDBNet', blocks=nb, in_ch=in_ch)


def build_srvgg(sd):
    g = G()
    idx = sorted({int(k.split('.')[1]) for k in sd if k.startswith('body.')})
    x = 'input'
    for i in idx:
        w = sd[f'body.{i}.weight']
        if w.ndim == 4:
            x = g.conv(x, sd, f'body.{i}')
        else:  # PReLU, one slope per channel
            s = g.init(f'body.{i}.weight', w.astype(np.float32).reshape(-1, 1, 1))
            x = g.node('PRelu', [x, s])
    out_c = sd[f'body.{idx[-1]}.weight'].shape[0]
    up = int(round((out_c / 3) ** 0.5))
    x = g.node('DepthToSpace', [x], {'blocksize': up, 'mode': 'CRD'})
    sc = g.init('upsc', np.array([1, 1, up, up], np.float32))
    base = g.node('Resize', ['input', '', sc], {'mode': 'nearest',
                                               'coordinate_transformation_mode': 'asymmetric',
                                               'nearest_mode': 'floor'})
    g.node('Add', [x, base], out='output')
    return g.model(3), dict(arch='SRVGGNetCompact', convs=len(idx), scale=up)


if __name__ == '__main__':
    sd = load_pth(sys.argv[1])
    m, info = build_rrdb(sd) if 'conv_first.weight' in sd else build_srvgg(sd)
    open(sys.argv[2], 'wb').write(m)
    print(info, len(m) / 1e6, 'MB')
