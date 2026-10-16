#!/usr/bin/env python3
"""Upscaling methods for the HD-art prototype: Real-ESRGAN via onnxruntime (tiled, CPU),
xBR level-2 (FFmpeg vf_xbr 2x algorithm, vectorised numpy), and Pillow resampling baselines.
All functions take/return straight-alpha RGBA uint8 numpy arrays (H, W, 4)."""
import os, time
import numpy as np
from PIL import Image
from scipy import ndimage

ONNX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'onnx')
_sessions = {}


def session(name):
    import onnxruntime as ort
    if name not in _sessions:
        so = ort.SessionOptions()
        so.intra_op_num_threads = os.cpu_count() or 2
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _sessions[name] = ort.InferenceSession(os.path.join(ONNX_DIR, name + '.onnx'), so,
                                               providers=['CPUExecutionProvider'])
    return _sessions[name]


def _pixel_unshuffle(x, r=2):
    c, h, w = x.shape
    return x.reshape(c, h // r, r, w // r, r).transpose(0, 2, 4, 1, 3).reshape(c * r * r, h // r, w // r)


def model_rgb(name, rgb, tile=160, pad=12):
    """rgb: float32 (H, W, 3) in 0..1 -> float32 (sH, sW, 3). Tiled with overlap padding."""
    s = session(name)
    is_x2 = 'x2plus' in name
    scale = 2 if is_x2 else 4
    h, w, _ = rgb.shape
    x = rgb.transpose(2, 0, 1)
    if is_x2:  # model wants even dims; reflect-pad
        ph, pw = h % 2, w % 2
        x = np.pad(x, ((0, 0), (0, ph), (0, pw)), mode='edge')
    H, W = x.shape[1:]
    out = np.zeros((3, H * scale, W * scale), np.float32)
    for y0 in range(0, H, tile):
        for x0 in range(0, W, tile):
            y1, x1 = min(y0 + tile, H), min(x0 + tile, W)
            ya, xa = max(y0 - pad, 0), max(x0 - pad, 0)
            yb, xb = min(y1 + pad, H), min(x1 + pad, W)
            if is_x2:  # keep crop even
                ya -= ya % 2; xa -= xa % 2; yb += yb % 2; xb += xb % 2
            t = x[:, ya:yb, xa:xb]
            inp = _pixel_unshuffle(t) if is_x2 else t
            o = s.run(None, {'input': inp[None].astype(np.float32)})[0][0]
            out[:, y0 * scale:y1 * scale, x0 * scale:x1 * scale] = \
                o[:, (y0 - ya) * scale:(y1 - ya) * scale, (x0 - xa) * scale:(x1 - xa) * scale]
    out = out[:, :h * scale, :w * scale]
    return np.clip(out.transpose(1, 2, 0), 0, 1)


def bleed(rgba):
    """Fill RGB under fully transparent pixels with the nearest visible colour (edge padding)."""
    a = rgba[..., 3]
    if a.min() > 0:
        return rgba[..., :3]
    vis = a > 0
    if not vis.any():
        return rgba[..., :3]
    _, (iy, ix) = ndimage.distance_transform_edt(~vis, return_indices=True)
    return rgba[iy, ix, :3]


def neural(name, rgba, alpha_mode='bleed'):
    """Returns RGBA uint8 at the model scale.
    alpha_mode: 'bleed'  - RGB with colours bled into transparent area, alpha through the model
                'premul' - premultiplied RGB and alpha through the model, then un-premultiply
                'naive'  - straight RGB as decoded (black under transparent), alpha through model
                'lanczos'- bleed RGB, alpha upscaled with Lanczos instead of the model."""
    f = rgba.astype(np.float32) / 255
    opaque = rgba[..., 3].min() == 255
    if opaque:
        rgb = model_rgb(name, f[..., :3])
        a = np.ones(rgb.shape[:2], np.float32)
    else:
        al = f[..., 3:4]
        if alpha_mode == 'premul':
            rgb_in = f[..., :3] * al
        elif alpha_mode == 'naive':
            rgb_in = f[..., :3]
        else:
            rgb_in = bleed(rgba).astype(np.float32) / 255
        rgb = model_rgb(name, rgb_in)
        s = rgb.shape[0] // rgba.shape[0]
        if alpha_mode == 'lanczos':
            a = np.asarray(Image.fromarray(rgba[..., 3]).resize(rgb.shape[1::-1], Image.LANCZOS),
                           np.float32) / 255
        else:
            a = model_rgb(name, np.repeat(al, 3, axis=2)).mean(axis=2)
        a = np.clip(a, 0, 1)
        a[a < 1.5 / 255] = 0
        if alpha_mode == 'premul':
            rgb = np.where(a[..., None] > 0, np.clip(rgb / np.maximum(a[..., None], 1e-4), 0, 1), 0)
    return np.dstack([np.round(rgb * 255), np.round(a * 255)]).astype(np.uint8)


# ------------------------------------------------------------------ xBR (lv2, 2x)
def _yuv(rgb):
    r, g, b = [rgb[..., i].astype(np.int32) for i in range(3)]
    y = (299 * r + 587 * g + 114 * b) // 1000
    u = (-169 * r - 331 * g + 500 * b) // 1000
    v = (500 * r - 419 * g - 81 * b) // 1000
    return np.stack([y, u, v], -1)


def xbr2x(rgba):
    """FFmpeg vf_xbr 2x (Hyllian xBR lv2). Edge detection on premultiplied YUV + alpha,
    blending done on premultiplied RGBA so transparent edges don't fringe."""
    h, w, _ = rgba.shape
    f = rgba.astype(np.float32)
    pm = f.copy(); pm[..., :3] *= f[..., 3:4] / 255
    yuv = _yuv(pm[..., :3]).astype(np.float32)
    feat = np.concatenate([yuv * np.array([48, 7, 6], np.float32), pm[..., 3:4] * 48], -1)
    P = np.pad(pm, ((2, 2), (2, 2), (0, 0)), mode='edge')
    F = np.pad(feat, ((2, 2), (2, 2), (0, 0)), mode='edge')

    def nb(dy, dx):  # neighbour at offset
        return P[2 + dy:2 + dy + h, 2 + dx:2 + dx + w], F[2 + dy:2 + dy + h, 2 + dx:2 + dx + w]
    names = {'A1': (-2, -1), 'B1': (-2, 0), 'C1': (-2, 1), 'A0': (-1, -2), 'PA': (-1, -1), 'PB': (-1, 0),
             'PC': (-1, 1), 'C4': (-1, 2), 'D0': (0, -2), 'PD': (0, -1), 'PE': (0, 0), 'PF': (0, 1),
             'F4': (0, 2), 'G0': (1, -2), 'PG': (1, -1), 'PH': (1, 0), 'PI': (1, 1), 'I4': (1, 2),
             'G5': (2, -1), 'H5': (2, 0), 'I5': (2, 1)}
    px = {k: nb(*v) for k, v in names.items()}
    col = {k: v[0] for k, v in px.items()}
    ft = {k: v[1] for k, v in px.items()}

    def df(a, b):
        return np.abs(ft[a] - ft[b]).sum(-1)

    def ne(a, b):  # exact inequality
        return (col[a] != col[b]).any(-1)

    def eq(a, b):
        return df(a, b) < 155

    E = [col['PE'].copy() for _ in range(4)]   # 0 TL, 1 TR, 2 BL, 3 BR

    def blend(dst, src, m, k):
        dst[m] = dst[m] + (src[m] - dst[m]) * (k / 256)

    def filt(PE, PI, PH, PF, PG, PC, PD, PB, PA, G5, C4, G0, D0, C1, B1, F4, I4, H5, I5, A0, A1,
             N0, N1, N2, N3):
        cond = ne(PE, PH) & ne(PE, PF)
        e = df(PE, PC) + df(PE, PG) + df(PI, H5) + df(PI, F4) + 4 * df(PH, PF)
        i = df(PH, PD) + df(PH, I5) + df(PF, I4) + df(PF, PB) + 4 * df(PE, PI)
        cond &= e <= i
        pxsel = np.where((df(PE, PF) <= df(PE, PH))[..., None], col[PF], col[PH])
        lv2 = (e < i) & ((~eq(PF, PB) & ~eq(PH, PD)) | (eq(PE, PI) & (~eq(PF, I4) & ~eq(PH, I5)))
                         | eq(PE, PG) | eq(PE, PC))
        ke, ki = df(PF, PG), df(PH, PC)
        left = (2 * ke <= ki) & ne(PE, PG) & ne(PD, PG)
        up = (ke >= 2 * ki) & ne(PE, PC) & ne(PB, PC)
        m_lu = cond & lv2 & left & up
        m_l = cond & lv2 & left & ~up
        m_u = cond & lv2 & up & ~left
        m_d = cond & ~(lv2 & (left | up))
        blend(E[N3], pxsel, m_lu, 224); blend(E[N2], pxsel, m_lu, 64); E[N1][m_lu] = E[N2][m_lu]
        blend(E[N3], pxsel, m_l, 192); blend(E[N2], pxsel, m_l, 64)
        blend(E[N3], pxsel, m_u, 192); blend(E[N1], pxsel, m_u, 64)
        blend(E[N3], pxsel, m_d, 128)

    filt('PE', 'PI', 'PH', 'PF', 'PG', 'PC', 'PD', 'PB', 'PA', 'G5', 'C4', 'G0', 'D0', 'C1', 'B1', 'F4', 'I4', 'H5', 'I5', 'A0', 'A1', 0, 1, 2, 3)
    filt('PE', 'PC', 'PF', 'PB', 'PI', 'PA', 'PH', 'PD', 'PG', 'I4', 'A1', 'I5', 'H5', 'A0', 'D0', 'B1', 'C1', 'F4', 'C4', 'G5', 'G0', 2, 0, 3, 1)
    filt('PE', 'PA', 'PB', 'PD', 'PC', 'PG', 'PF', 'PH', 'PI', 'C1', 'G0', 'C4', 'F4', 'G5', 'H5', 'D0', 'A0', 'B1', 'A1', 'I4', 'I5', 3, 2, 1, 0)
    filt('PE', 'PG', 'PD', 'PH', 'PA', 'PI', 'PB', 'PF', 'PC', 'A0', 'I5', 'A1', 'B1', 'I4', 'F4', 'H5', 'G5', 'D0', 'G0', 'C1', 'C4', 1, 3, 0, 2)
    out = np.zeros((2 * h, 2 * w, 4), np.float32)
    out[0::2, 0::2], out[0::2, 1::2], out[1::2, 0::2], out[1::2, 1::2] = E
    return _unpremul(out)


def _unpremul(pm):
    a = pm[..., 3:4]
    rgb = np.where(a > 0, pm[..., :3] * 255 / np.maximum(a, 1e-3), 0)
    return np.clip(np.round(np.concatenate([rgb, a], -1)), 0, 255).astype(np.uint8)


# ------------------------------------------------------------------ resampling
def resize(rgba, size, method=Image.LANCZOS):
    """Resize in premultiplied space (avoids dark/colour fringes at alpha edges)."""
    f = rgba.astype(np.float32)
    if rgba[..., 3].min() == 255:
        return np.asarray(Image.fromarray(rgba).resize(size, method))
    pm = f.copy(); pm[..., :3] *= f[..., 3:4] / 255
    ch = [np.asarray(Image.fromarray(pm[..., c], 'F').resize(size, method)) for c in range(4)]
    return _unpremul(np.clip(np.stack(ch, -1), 0, 255))


def unsharp(rgba, radius=1.0, amount=0.6, threshold=2):
    from PIL import ImageFilter
    im = Image.fromarray(rgba)
    rgb = im.convert('RGB').filter(ImageFilter.UnsharpMask(radius, int(amount * 100), threshold))
    out = np.asarray(rgb).copy()
    return np.dstack([out, rgba[..., 3]])


def timed(fn, *a, **k):
    t = time.perf_counter(); r = fn(*a, **k); return r, time.perf_counter() - t
