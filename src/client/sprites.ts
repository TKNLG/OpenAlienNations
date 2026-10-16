// Sprite atlas + batched, depth-sorted sprite drawing.

import { compileProgram, uniforms } from './gl.ts';

const ATLAS = 4096;
export interface AtlasRect { u0: number; v0: number; u1: number; v1: number; w: number; h: number; }

/** Simple shelf packer over one or more 4096x4096 atlas pages. */
export class SpriteAtlas {
  readonly pages: WebGLTexture[] = [];
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  readonly rects = new Map<string, { page: number; r: AtlasRect }>();

  private gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) { this.gl = gl; this.newPage(); }

  private newPage(): void {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, ATLAS, ATLAS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.pages.push(t);
    this.shelfX = this.shelfY = this.shelfH = 0;
  }

  add(key: string, w: number, h: number, rgba: Uint8Array): void {
    if (this.rects.has(key) || w === 0 || h === 0) return;
    if (this.shelfX + w + 2 > ATLAS) { this.shelfY += this.shelfH + 2; this.shelfX = 0; this.shelfH = 0; }
    if (this.shelfY + h + 2 > ATLAS) this.newPage();
    const x = this.shelfX + 1, y = this.shelfY + 1;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.pages[this.pages.length - 1]);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.rects.set(key, {
      page: this.pages.length - 1,
      r: { u0: x / ATLAS, v0: y / ATLAS, u1: (x + w) / ATLAS, v1: (y + h) / ATLAS, w, h },
    });
    this.shelfX += w + 2;
    this.shelfH = Math.max(this.shelfH, h);
  }
}

const VS = `#version 300 es
in vec2 a_pos; in vec2 a_uv; in vec4 a_tint; in float a_fx;
uniform vec2 u_scale;
out vec2 v_uv; out vec4 v_tint; out float v_fx;
void main() { gl_Position = vec4(a_pos * u_scale, 0.0, 1.0); v_uv = a_uv; v_tint = a_tint; v_fx = a_fx; }`;

const FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv; in vec4 v_tint; in float v_fx; out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv) * v_tint;
  // selection: blue boost B' = (B + alpha) / 2 on premultiplied colour where alpha > 31
  // (docs/rendering/objects.md 7.1); light and fog brightness (the tint) come first
  if (v_fx > 0.5 && c.a > 31.0 / 255.0) c.b = (c.b + c.a) * 0.5;
  o = c;
}`;

/**
 * tint: multiplies the (premultiplied) colour, e.g. [0.5, 0.5, 0.5, 1] for a fogged object;
 * boost: selection highlight. page: atlas page, or a Compositor picture (>= COMPOSITE_PAGE)
 */
export interface SpriteDraw { page: number; r: AtlasRect; x: number; y: number; depth: number; tint?: [number, number, number, number]; boost?: boolean; }

/** page numbers from here on are composite pictures (Compositor), not atlas pages */
export const COMPOSITE_PAGE = 1 << 20;

const NO_TINT: [number, number, number, number] = [1, 1, 1, 1];

function vert(d: Float32Array, o: number, x: number, y: number, u: number, v: number, t: [number, number, number, number], fx: number): void {
  d[o] = x; d[o + 1] = y; d[o + 2] = u; d[o + 3] = v;
  d[o + 4] = t[0] * t[3]; d[o + 5] = t[1] * t[3]; d[o + 6] = t[2] * t[3]; d[o + 7] = t[3]; d[o + 8] = fx;
}
const FLOATS = 9; // per vertex: pos 2, uv 2, tint 4, fx 1

/** Draws sprites (screen-space px relative to the view centre, zoom 1) sorted back to front. */
export class SpriteBatch {
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation>;
  private vao: WebGLVertexArrayObject;
  private buf: WebGLBuffer;
  private data = new Float32Array(6 * FLOATS * 4096);

  private gl: WebGL2RenderingContext;
  private atlas: SpriteAtlas;

  constructor(gl: WebGL2RenderingContext, atlas: SpriteAtlas) {
    this.gl = gl;
    this.atlas = atlas;
    this.prog = compileProgram(gl, VS, FS);
    this.u = uniforms(gl, this.prog, ['u_scale', 'u_tex']);
    this.vao = gl.createVertexArray()!;
    this.buf = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const pos = gl.getAttribLocation(this.prog, 'a_pos'), uv = gl.getAttribLocation(this.prog, 'a_uv');
    const tint = gl.getAttribLocation(this.prog, 'a_tint'), fx = gl.getAttribLocation(this.prog, 'a_fx');
    gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, FLOATS * 4, 0);
    gl.enableVertexAttribArray(uv); gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, FLOATS * 4, 8);
    gl.enableVertexAttribArray(tint); gl.vertexAttribPointer(tint, 4, gl.FLOAT, false, FLOATS * 4, 16);
    gl.enableVertexAttribArray(fx); gl.vertexAttribPointer(fx, 1, gl.FLOAT, false, FLOATS * 4, 32);
    gl.bindVertexArray(null);
  }

  /** composite pictures by page number (Compositor) */
  readonly composites = new Map<number, WebGLTexture>();

  /**
   * Draw sprites (positions relative to the view centre at zoom 1). `copy`: no blending, each
   * quad replaces what is below (composition, objects.md 2.1), and image row 0 at the bottom of
   * the target (= texture row 0 when the target is a framebuffer texture).
   */
  draw(list: SpriteDraw[], zoom: number, viewW: number, viewH: number, copy = false): void {
    const gl = this.gl;
    list.sort((a, b) => a.depth - b.depth);
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.u_scale, (2 * zoom) / viewW, ((copy ? 2 : -2) * zoom) / viewH);
    gl.uniform1i(this.u.u_tex, 0);
    if (copy) gl.disable(gl.BLEND);
    else gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // atlas is premultiplied
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.activeTexture(gl.TEXTURE0);
    // consecutive runs on the same atlas page go in one draw call
    let i = 0;
    while (i < list.length) {
      const page = list[i].page;
      let n = 0;
      const per = 6 * FLOATS;
      if (this.data.length < list.length * per) this.data = new Float32Array(list.length * per * 2);
      const d = this.data;
      while (i < list.length && list[i].page === page) {
        const { r, x, y } = list[i];
        const t = list[i].tint ?? NO_TINT, f = list[i].boost ? 1 : 0;
        const x1 = x + r.w, y1 = y + r.h;
        const { u0, v0, u1, v1 } = r;
        const o = n * per;
        vert(d, o, x, y, u0, v0, t, f); vert(d, o + FLOATS, x1, y, u1, v0, t, f); vert(d, o + 2 * FLOATS, x1, y1, u1, v1, t, f);
        vert(d, o + 3 * FLOATS, x, y, u0, v0, t, f); vert(d, o + 4 * FLOATS, x1, y1, u1, v1, t, f); vert(d, o + 5 * FLOATS, x, y1, u0, v1, t, f);
        n++; i++;
      }
      gl.bindTexture(gl.TEXTURE_2D, page >= COMPOSITE_PAGE ? this.composites.get(page) ?? null : this.atlas.pages[page]);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, n * per), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, n * 6);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}

/**
 * Multi-layer pictures (finished buildings, docs/rendering/objects.md 2.1): the layers are
 * composed 1:1 into a picture of their own, each layer's rectangle copied over what is below,
 * and that picture is then drawn scaled like any sprite. Drawing the layers one by one with
 * linear filtering at fractional positions would leave faint seams along the layer rectangles,
 * where both MS0's hole rim and the layer's edge are filtered against transparency.
 * A picture is re-composed only when its signature (layers and frames) changes.
 */
export class Compositor {
  private gl: WebGL2RenderingContext;
  private batch: SpriteBatch;
  private pics = new Map<number, { tex: WebGLTexture; fbo: WebGLFramebuffer; W: number; H: number; sig: string; used: number; page: number }>();
  private nextPage = COMPOSITE_PAGE;
  private frame = 0;

  constructor(gl: WebGL2RenderingContext, batch: SpriteBatch) { this.gl = gl; this.batch = batch; }

  /**
   * The composite picture `key` (an object id) of `parts` (x, y relative to the picture's top-left
   * corner, drawing order = depth), w x h pixels. Leaves the default framebuffer bound; the
   * caller restores its viewport.
   */
  compose(key: number, sig: string, parts: SpriteDraw[], w: number, h: number): { page: number; r: AtlasRect } {
    const gl = this.gl;
    const W = w + 2, H = h + 2;   // 1 px transparent border for filtering at the outer edge
    let p = this.pics.get(key);
    if (p && (p.W !== W || p.H !== H)) { this.free(key); p = undefined; }
    if (!p) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      p = { tex, fbo, W, H, sig: '', used: 0, page: this.nextPage++ };
      this.pics.set(key, p);
      this.batch.composites.set(p.page, tex);
    }
    p.used = this.frame;
    if (p.sig !== sig) {
      p.sig = sig;
      gl.bindFramebuffer(gl.FRAMEBUFFER, p.fbo);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // positions relative to the target centre, 1 px border
      this.batch.draw(parts.map(d => ({ ...d, x: d.x + 1 - W / 2, y: d.y + 1 - H / 2, tint: undefined, boost: false })), 1, W, H, true);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return { page: p.page, r: { u0: 1 / W, v0: 1 / H, u1: (1 + w) / W, v1: (1 + h) / H, w, h } };
  }

  /** call once per redraw: frees pictures not used for a while */
  sweep(): void {
    this.frame++;
    if (this.frame % 60) return;
    for (const [k, p] of this.pics) if (this.frame - p.used > 120) this.free(k);
  }

  private free(key: number): void {
    const p = this.pics.get(key);
    if (!p) return;
    this.gl.deleteFramebuffer(p.fbo); this.gl.deleteTexture(p.tex);
    this.batch.composites.delete(p.page);
    this.pics.delete(key);
  }

  clear(): void { for (const k of [...this.pics.keys()]) this.free(k); }
}
