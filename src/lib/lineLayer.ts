/**
 * The weave, drawn directly.
 *
 * Eighteen GeoJSON line layers became one custom layer, for the same reason the trains did: a
 * source is a data pipeline and this is static geometry. The network changes when the MTA publishes
 * a feed version, and it was being tiled and re-tiled as though it were live.
 *
 * What the move buys beyond that is one fan. The lines used to be offset by a MapLibre expression
 * that sampled `fanAt` at a list of zooms and drew chords between the samples, while the trains were
 * offset by `fanAt` itself — so the gap between the chord and the curve was a train sitting off its
 * own line. Here both read the same function, in the same pass, from the same camera, and the
 * question cannot be asked again.
 *
 * The polyline is expanded in the vertex stage rather than on the CPU. A width is a number of
 * pixels, and pixels only exist once the camera has been applied, so the extrusion has to happen
 * after the projection — which also means the half width and the band offset are both applied to
 * geometry that knows which way the line is turning, rather than displacing vertices that were
 * tessellated for a line somewhere else.
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { LINE_STRIDE, WEAVE_LEVELS, type LineMesh } from "./lineGeometry";
import { casingWidthAt, fanAt, lineWidthAt } from "./layout";

const VERT = `#version 300 es
precision highp float;

in vec2 a_prev;
in vec2 a_pos;
in vec2 a_next;
in float a_side;     // -1 or +1: which edge of the strip
in float a_cap;      // -1 / +1 on the pushed-out pairs that round an end off, 0 elsewhere
in vec2 a_band;      // (cb, mb): which band of its corridor this service rides
in vec3 a_colour;
in uint a_route;

uniform mat4 u_matrix;
uniform vec2 u_viewport;    // device pixels
uniform float u_dpr;
uniform vec2 u_fan;         // pixels per band at the zoom being drawn: (colour, metric)
uniform float u_lineHalf;    // CSS pixels
uniform float u_casingHalf;
uniform vec3 u_casingColour;
uniform uvec2 u_routeMask;

out float v_side;
out float v_cap;
out vec4 v_colour;
out float v_halfPx;
out float v_extPx;

vec4 clipOf(vec2 merc) { return u_matrix * vec4(merc, 0.0, 1.0); }
vec2 toPx(vec4 c) { return (c.xy / c.w) * 0.5 * u_viewport; }   // y up, device pixels

void main() {
  // Filtering is a uniform rather than a buffer rewrite: hiding a service is a bit going out.
  uint word = (a_route >> 5u) == 0u ? u_routeMask.x : u_routeMask.y;
  if ((word & (1u << (a_route & 31u))) == 0u) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // Kept, because the final position needs it too — projecting a_pos twice was a quarter of this
  // shader's matrix work for nothing.
  vec4 clip = clipOf(a_pos);
  vec2 sPrev = toPx(clipOf(a_prev)), sPos = toPx(clip), sNext = toPx(clipOf(a_next));
  vec2 dA = sPos - sPrev, dB = sNext - sPos;
  bool hasA = dot(dA, dA) > 1e-9;
  bool hasB = dot(dB, dB) > 1e-9;
  vec2 uA = hasA ? normalize(dA) : vec2(0.0);
  vec2 uB = hasB ? normalize(dB) : vec2(0.0);
  vec2 dir = normalize(hasA && hasB ? uA + uB : (hasA ? uA : uB));
  if (!hasA && !hasB) dir = vec2(0.0, 1.0);   // a degenerate stretch: pick a direction and move on

  // Right of travel, which is the side the band is offset to and the side the trains take.
  vec2 nR = vec2(dir.y, -dir.x);
  vec2 nA = hasA ? vec2(uA.y, -uA.x) : nR;
  /*
   * The miter, which is what makes an offset line a parallel curve rather than a set of displaced
   * segments. Both the band offset and the half width are perpendicular displacements at a joint,
   * so both get the same correction; clamped, because the correction goes to infinity as a turn
   * approaches a fold and a spike is worse than a truncation.
   */
  float mlen = 1.0 / max(dot(nR, nA), 0.25);

  /*
   * Two instances rather than two draws: instance 0 is the casing, instance 1 the line on top of
   * it. Same geometry, same pass, and the weave order still holds because the pair is issued per
   * level, lowest first — which is what makes a crossing read as one line passing under another.
   */
  bool casing = gl_InstanceID == 0;
  float halfPx = max(casing ? u_casingHalf : u_lineHalf, 0.35) * u_dpr;
  /*
   * A pixel wider than the line, so the edge has somewhere to fade.
   *
   * Without it the triangles stop exactly at the half width and the coverage the fragment stage
   * computes is still 0.5 there — a hard edge at half alpha, which reads as a halo and makes
   * neighbouring bands bleed into each other instead of leaving the dark gap between them.
   */
  float extPx = halfPx + 1.0;
  float fanPx = dot(a_band, u_fan) * u_dpr;
  vec2 off = nR * (fanPx + a_side * extPx) * mlen;
  off += dir * (a_cap * extPx);

  clip.xy += off / u_viewport * 2.0 * clip.w;
  gl_Position = clip;

  v_side = a_side;
  v_cap = a_cap;
  v_halfPx = halfPx;
  v_extPx = extPx;
  v_colour = vec4(casing ? u_casingColour : a_colour, casing ? 0.75 : 0.95);
}`;

const FRAG = `#version 300 es
precision mediump float;
in float v_side;
in float v_cap;
in vec4 v_colour;
in float v_halfPx;
in float v_extPx;
out vec4 fragColor;
void main() {
  // How far this fragment is from the centreline, in pixels. The cap term is zero everywhere but
  // past an end, where it turns the square corner into a disc.
  float d = length(vec2(v_side, v_cap)) * v_extPx;
  // Half a pixel either side of the edge: the whole ramp, and no more overdraw than it needs.
  float cover = clamp(v_halfPx - d + 0.5, 0.0, 1.0);
  float a = v_colour.a * cover;
  fragColor = vec4(v_colour.rgb * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "line shader failed to compile");
  return sh;
}

export class LineLayer implements CustomLayerInterface {
  readonly id = "routes-gl";
  readonly type = "custom";
  readonly renderingMode = "2d";

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private ebo: WebGLBuffer | null = null;
  private routeBuf: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  /** Which services are drawn, as bits. All of them until told otherwise. */
  private mask: [number, number] = [0xffffffff, 0xffffffff];
  /*
   * What is actually on screen.
   *
   * The first version of this layer submitted the whole network every frame, which is what the
   * eighteen GeoJSON layers never did — MapLibre only ever drew the tiles the camera was over. Fifty
   * thousand vertices through a vertex stage that projects three points each, twice over for casing
   * and line, cost more than it saved: 7.5 ms a frame became 10.5.
   *
   * So the index buffer is rebuilt from the strokes whose boxes meet the view, and only when the
   * view has moved far enough to matter. Everything else is the same buffer it always was.
   */
  private culled: Uint16Array | null = null;
  private drawRanges: { start: number; count: number }[] = [];
  private cullBox: [number, number, number, number] | null = null;

  /**
   * `casing` is read once, the way the style used to read it, and `fanScale` is the widening the
   * view applies when it is filtered to a few services — shared with the train layer so the two
   * cannot part company.
   */
  constructor(
    private readonly mesh: LineMesh,
    private readonly casing: [number, number, number],
    private readonly fanScale: () => number = () => 1,
  ) {}

  /**
   * Refill the index buffer with the strokes the camera is over.
   *
   * Padded by a third of the view on each side, so a pan has somewhere to go before this has to run
   * again, and the ranges come out grouped by weave level — the draw order is still a casing and a
   * line per level, lowest first, and that is what makes a crossing read as one line passing under
   * another.
   */
  private cull(gl: WebGL2RenderingContext, minX: number, minY: number, maxX: number, maxY: number) {
    const buf = this.culled;
    if (!buf) return;
    const padX = (maxX - minX) / 3, padY = (maxY - minY) / 3;
    const w = minX - padX, e = maxX + padX, s = minY - padY, n = maxY + padY;
    this.cullBox = [w, s, e, n];

    const src = this.mesh.indices;
    const ranges: { start: number; count: number }[] = [];
    let at = 0;
    for (let z = 0; z < WEAVE_LEVELS; z++) {
      const start = at;
      for (const part of this.mesh.parts) {
        if (part.z !== z || part.count === 0) continue;
        if (part.maxX < w || part.minX > e || part.maxY < s || part.minY > n) continue;
        buf.set(src.subarray(part.start, part.start + part.count), at);
        at += part.count;
      }
      ranges.push({ start, count: at - start });
    }
    this.drawRanges = ranges;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, buf, 0, at);
  }

  /** Show only these services, or all of them for `null`. No buffer is touched. */
  setVisible(routes: Set<string> | null) {
    let lo = 0, hi = 0;
    this.mesh.routes.forEach((r, i) => {
      if (routes && !routes.has(r)) return;
      if (i < 32) lo |= 1 << i; else hi |= 1 << (i - 32);
    });
    this.mask = routes ? [lo >>> 0, hi >>> 0] : [0xffffffff, 0xffffffff];
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "line program failed to link");
    this.program = program;
    for (const n of ["u_matrix", "u_viewport", "u_dpr", "u_fan", "u_lineHalf", "u_casingHalf", "u_casingColour", "u_routeMask"]) {
      this.uniforms[n] = gl.getUniformLocation(program, n);
    }

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.vertices, gl.STATIC_DRAW);
    const F = 4;
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(program, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, LINE_STRIDE * F, offset * F);
    };
    attr("a_prev", 2, 0);
    attr("a_pos", 2, 2);
    attr("a_next", 2, 4);
    attr("a_side", 1, 6);
    attr("a_cap", 1, 7);
    attr("a_band", 2, 8);
    attr("a_colour", 3, 10);

    // A byte a vertex, and an integer attribute rather than a normalised float, so the shader can
    // shift and mask it.
    this.routeBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.routeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.routeOf, gl.STATIC_DRAW);
    const rl = gl.getAttribLocation(program, "a_route");
    if (rl >= 0) {
      gl.enableVertexAttribArray(rl);
      gl.vertexAttribIPointer(rl, 1, gl.UNSIGNED_BYTE, 0, 0);
    }

    this.ebo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    // Sized for the whole network and refilled with whatever is in view.
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices.byteLength, gl.DYNAMIC_DRAW);
    this.culled = new Uint16Array(this.mesh.indices.length);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext) {
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    for (const b of [this.vbo, this.ebo, this.routeBuf]) if (b) gl.deleteBuffer(b);
    this.program = null; this.vao = null; this.vbo = this.ebo = this.routeBuf = null;
    this.map = null; this.gl = null;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map;
    if (!this.program || !this.vao || !map) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const zoom = map.getZoom();
    const fan = fanAt(zoom);
    const fs = this.fanScale();
    gl.uniformMatrix4fv(this.uniforms.u_matrix, false, args.defaultProjectionData.mainMatrix as Float32Array);
    gl.uniform2f(this.uniforms.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.uniforms.u_dpr, gl.drawingBufferWidth / Math.max(1, map.getCanvas().clientWidth));
    gl.uniform2f(this.uniforms.u_fan, fan.colour * fs, fan.metric * fs);
    gl.uniform2ui(this.uniforms.u_routeMask, this.mask[0], this.mask[1]);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    /*
     * Mercator bounds of what the camera can see, and a re-cull when the view has left the box the
     * last one was built for. `getBounds` is the bounding box of the visible region, which is
     * conservative under rotation and exactly right without it.
     */
    const b = map.getBounds();
    const merc = (lat: number) => {
      const sn = Math.sin((lat * Math.PI) / 180);
      return 0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI);
    };
    // Mercator y grows southward, so the north edge of the view is the smaller number. Naming them
    // min and max rather than north and south is the difference between a box and an empty one.
    const minX = (b.getWest() + 180) / 360, maxX = (b.getEast() + 180) / 360;
    const minY = merc(b.getNorth()), maxY = merc(b.getSouth());
    const box = this.cullBox;
    if (!box || minX < box[0] || minY < box[1] || maxX > box[2] || maxY > box[3]) {
      this.cull(gl, minX, minY, maxX, maxY);
    }

    gl.uniform1f(this.uniforms.u_lineHalf, lineWidthAt(zoom) / 2);
    gl.uniform1f(this.uniforms.u_casingHalf, casingWidthAt(zoom) / 2);
    gl.uniform3f(this.uniforms.u_casingColour, this.casing[0], this.casing[1], this.casing[2]);
    /*
     * A casing and a line per level, lowest first — nine draws of two instances rather than
     * eighteen draws, because the width, the colour and the opacity are the only things that differ
     * between the two and a shader can pick those from the instance.
     */
    for (let z = 0; z < WEAVE_LEVELS; z++) {
      const lv = this.drawRanges[z];
      if (!lv || lv.count === 0) continue;
      gl.drawElementsInstanced(gl.TRIANGLES, lv.count, gl.UNSIGNED_SHORT, lv.start * 2, 2);
    }
    gl.bindVertexArray(null);
  }
}
