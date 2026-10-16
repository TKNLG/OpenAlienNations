// Draws the terrain heightfield. Spec: docs/rendering/terrain-drawing.md
// One quad per map cell, built in 32x32-cell chunks. Every tile is one layer of a
// TEXTURE_2D_ARRAY; mixed-ground quads blend their four corner tiles per pixel on the GPU.

import { compileProgram, uniforms } from './gl.ts';
import { Camera, CELL_W, CELL_H } from './camera.ts';
import type { TerrainSet } from '../formats/os.ts';
import { CLASS_TILESET, CLASS_WATER, type Terrain } from '../world/terrain.ts';

const CHUNK = 32;
const F = 11; // floats per vertex: x, y, h, light, u, v, layer0..3, anim

/** fixed layer order in the texture array (animation frames must be consecutive) */
export const TERRAIN_SET_ORDER = [
  'wiese', 'gelbgras', 'schnee', 'rock', 'waldboden', 'gruenwald', 'weg',
  'wasser1', 'wasser2', 'wasser3', 'wasser4',
  'transition1', 'transition2', 'transition3', 'transition4',
];

const VS = `#version 300 es
in vec2 a_pos; in float a_h; in float a_light; in vec2 a_uv; in vec4 a_layers; in float a_anim;
uniform vec2 u_cam; uniform vec2 u_offset; uniform vec2 u_scale; uniform float u_frame;
out vec2 v_uv; out float v_light; out vec2 v_cell; flat out vec4 v_layers;
void main() {
  v_cell = a_pos;
  vec2 w = a_pos + u_offset - u_cam;
  vec2 s = vec2((w.y - w.x) * ${CELL_W / 2}.0, (w.x + w.y) * ${CELL_H / 2}.0 - (a_h - 128.0));
  gl_Position = vec4(s * u_scale, 0.0, 1.0);
  v_uv = a_uv; v_light = a_light / 162.0; v_layers = a_layers + vec4(a_anim * u_frame);
}`;

const FS = `#version 300 es
precision mediump float; precision mediump sampler2DArray;
uniform sampler2DArray u_tiles;
uniform sampler2D u_fog; uniform float u_fogInv;
in vec2 v_uv; in float v_light; in vec2 v_cell; flat in vec4 v_layers;
out vec4 o;
void main() {
  vec3 c;
  if (v_layers.x == v_layers.y && v_layers.y == v_layers.z && v_layers.z == v_layers.w) {
    c = texture(u_tiles, vec3(v_uv, v_layers.x)).rgb;
  } else {
    float u = v_uv.x, v = v_uv.y;
    c = texture(u_tiles, vec3(v_uv, v_layers.x)).rgb * (1.0 - u) * (1.0 - v)
      + texture(u_tiles, vec3(v_uv, v_layers.y)).rgb * u * (1.0 - v)
      + texture(u_tiles, vec3(v_uv, v_layers.z)).rgb * (1.0 - u) * v
      + texture(u_tiles, vec3(v_uv, v_layers.w)).rgb * u * v;
  }
  // fog of war (docs/game/fog-of-war.md): 0 = never explored (black), 0.5 = explored, 1 = in sight;
  // one texel per map vertex, sampled bilinearly so the borders are soft
  float fog = texture(u_fog, (v_cell + 0.5) * u_fogInv).r;
  o = vec4(c * v_light * fog, 1.0);
}`;

interface Chunk { vao: WebGLVertexArrayObject; buf: WebGLBuffer; count: number; cx: number; cy: number; }

/** corner pattern (bit k = corner p_k is water) -> shoreline tile index, read from the tiles' pixels */
function shorePatterns(set: TerrainSet): Map<number, number> {
  const out = new Map<number, number>();
  const isWater = (rgba: Uint8Array, x: number, y: number) => {
    const i = (y * 64 + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    return b > r + 40 && b > g + 20;
  };
  set.tiles.forEach((t, i) => {
    let p = 0;
    if (isWater(t.rgba, 4, 4)) p |= 1;     // p0 (0,0)
    if (isWater(t.rgba, 59, 4)) p |= 2;    // p1 (1,0)
    if (isWater(t.rgba, 4, 59)) p |= 4;    // p2 (0,1)
    if (isWater(t.rgba, 59, 59)) p |= 8;   // p3 (1,1)
    if (!out.has(p)) out.set(p, i);
  });
  return out;
}

export class TerrainRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation>;
  private tex: WebGLTexture;
  private layerBase = new Map<string, number>();
  private shore: Map<number, number>;
  private chunks: Chunk[] = [];
  private indexBuf: WebGLBuffer;
  private fogTex: WebGLTexture;
  private fogSize = 0;

  constructor(gl: WebGL2RenderingContext, sets: Map<string, TerrainSet>) {
    this.gl = gl;
    this.prog = compileProgram(gl, VS, FS);
    this.u = uniforms(gl, this.prog, ['u_cam', 'u_offset', 'u_scale', 'u_frame', 'u_tiles', 'u_fog', 'u_fogInv']);

    let layers = 0;
    for (const name of TERRAIN_SET_ORDER) {
      const set = sets.get(name);
      if (!set) throw new Error(`terrain set ${name}.os missing`);
      this.layerBase.set(name, layers);
      layers += set.tiles.length;
    }
    this.shore = shorePatterns(sets.get('transition1')!);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 7, gl.RGBA8, 64, 64, layers);
    for (const name of TERRAIN_SET_ORDER) {
      const base = this.layerBase.get(name)!;
      sets.get(name)!.tiles.forEach((t, i) =>
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, base + i, 64, 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, t.rgba));
    }
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const idx = new Uint16Array(CHUNK * CHUNK * 6);
    for (let q = 0; q < CHUNK * CHUNK; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    this.indexBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    this.fogTex = gl.createTexture()!;
    this.setFog(1, null);
  }

  /** fog of war per map vertex (size x size, row-major): 0 unexplored, 128 explored, 255 in sight;
   *  null = everything visible */
  setFog(size: number, data: Uint8Array | null): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (!data) {
      this.fogSize = 1;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    } else if (size !== this.fogSize) {
      this.fogSize = size;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RED, gl.UNSIGNED_BYTE, data);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  private terrain: Terrain | null = null;
  private light: Uint8Array | null = null;

  setTerrain(t: Terrain, light: Uint8Array): void {
    const gl = this.gl;
    for (const c of this.chunks) { gl.deleteVertexArray(c.vao); gl.deleteBuffer(c.buf); }
    this.chunks = [];
    this.terrain = t; this.light = light;
    for (let cy = 0; cy < t.size; cy += CHUNK)
      for (let cx = 0; cx < t.size; cx += CHUNK) this.chunks.push(this.buildChunk(cx, cy, null));
  }

  /** rebuild the chunks touching cells x0..x1, y0..y1 (inclusive, wrapped) after terrain edits */
  updateRegion(x0: number, y0: number, x1: number, y1: number): void {
    const t = this.terrain;
    if (!t) return;
    const mask = t.size - 1;
    const want = new Set<Chunk>();
    for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) {
      const cx = (x & mask) - ((x & mask) % CHUNK), cy = (y & mask) - ((y & mask) % CHUNK);
      const c = this.chunks.find(k => k.cx === cx && k.cy === cy);
      if (c) want.add(c);
    }
    for (const c of want) this.buildChunk(c.cx, c.cy, c);
  }

  private buildChunk(cx: number, cy: number, reuse: Chunk | null): Chunk {
    const gl = this.gl, t = this.terrain!, light = this.light!;
    const n = t.size, mask = n - 1, bits = t.sizeBits;
    const at = (x: number, y: number) => ((y & mask) << bits) | (x & mask);
    const waterBase = this.layerBase.get('wasser1')!, shoreBase = this.layerBase.get('transition1')!;
    const waterPerFrame = this.layerBase.get('wasser2')! - waterBase;
    const shorePerFrame = this.layerBase.get('transition2')! - shoreBase;
    const vertexLayer = (i: number) => this.layerBase.get(CLASS_TILESET[t.cls[i]])! + t.tile[i];
    const ao = (t as Terrain & { aoCls?: Uint8Array }).aoCls;

    // quad corners p0..p3: [dx, dy, u, v]; draw order p0, p2, p3, p1 (around the quad)
    const P: [number, number, number, number][] = [[0, 0, 0, 0], [0, 1, 1, 0], [1, 0, 0, 1], [1, 1, 1, 1]];
    const ORDER = [0, 2, 3, 1];
    const layers = [0, 0, 0, 0], cv = [0, 0, 0, 0];
    const data = new Float32Array(CHUNK * CHUNK * 4 * F);
    let o = 0;
    for (let y = cy; y < cy + CHUNK; y++)
      for (let x = cx; x < cx + CHUNK; x++) {
        let water = 0;
        for (let k = 0; k < 4; k++) {
          cv[k] = at(x + P[k][0], y + P[k][1]);
          if (t.cls[cv[k]] === CLASS_WATER) water |= 1 << k;
        }
        let anim = 0;
        if (water === 15) {
          layers.fill(waterBase + t.tile[cv[0]]); anim = waterPerFrame;
          // add-on maps: the open sea (class 9) is static, only the coastal ring is animated (addon.md 8.3)
          if (ao && ao[cv[0]] === 9 && ao[cv[1]] === 9 && ao[cv[2]] === 9 && ao[cv[3]] === 9) anim = 0;
        } else if (water !== 0) {
          layers.fill(shoreBase + (this.shore.get(water) ?? 0)); anim = shorePerFrame;
        } else {
          const s0 = CLASS_TILESET[t.cls[cv[0]]];
          if (s0 === CLASS_TILESET[t.cls[cv[1]]] && s0 === CLASS_TILESET[t.cls[cv[2]]] &&
              s0 === CLASS_TILESET[t.cls[cv[3]]]) layers.fill(vertexLayer(cv[0]));
          else for (let k = 0; k < 4; k++) layers[k] = vertexLayer(cv[k]);
        }
        for (const k of ORDER) {
          const [dx, dy, u, v] = P[k];
          const vi = cv[k];
          data[o] = x + dx; data[o + 1] = y + dy; data[o + 2] = t.height[vi]; data[o + 3] = light[vi];
          data[o + 4] = u; data[o + 5] = v;
          data[o + 6] = layers[0]; data[o + 7] = layers[1]; data[o + 8] = layers[2]; data[o + 9] = layers[3];
          data[o + 10] = anim;
          o += F;
        }
      }
    if (reuse) {
      gl.bindBuffer(gl.ARRAY_BUFFER, reuse.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      return reuse;
    }
    const vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.prog, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, F * 4, offset * 4);
    };
    attr('a_pos', 2, 0); attr('a_h', 1, 2); attr('a_light', 1, 3);
    attr('a_uv', 2, 4); attr('a_layers', 4, 6); attr('a_anim', 1, 10);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);
    gl.bindVertexArray(null);
    return { vao, buf, count: CHUNK * CHUNK * 6, cx, cy };
  }

  draw(cam: Camera, timeMs: number): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.uniform1i(this.u.u_tiles, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.uniform1i(this.u.u_fog, 1);
    gl.uniform1f(this.u.u_fogInv, 1 / this.fogSize);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(this.u.u_cam, cam.x, cam.y);
    gl.uniform2f(this.u.u_scale, (2 * cam.zoom) / cam.viewW, (-2 * cam.zoom) / cam.viewH);
    gl.uniform1f(this.u.u_frame, Math.floor(timeMs / 250) % 4);
    const halfW = cam.viewW / 2 / cam.zoom + CHUNK * CELL_W, halfH = cam.viewH / 2 / cam.zoom + CHUNK * CELL_H + 400;
    for (const c of this.chunks) {
      const mx = c.cx + CHUNK / 2, my = c.cy + CHUNK / 2;
      const ox = cam.nearest(mx, cam.x) - mx, oy = cam.nearest(my, cam.y) - my;
      const [sx, sy] = Camera.project(mx + ox - cam.x, my + oy - cam.y, 128);
      if (Math.abs(sx) > halfW || Math.abs(sy) > halfH) continue;
      gl.uniform2f(this.u.u_offset, ox, oy);
      gl.bindVertexArray(c.vao);
      gl.drawElements(gl.TRIANGLES, c.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }
}
