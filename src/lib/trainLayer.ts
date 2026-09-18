import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import type { AtlasRect, TrainAtlas } from "./icons";
import { fanAt } from "./layout";

/**
 * The trains, drawn directly.
 *
 * A GeoJSON source is a data pipeline, not an animation one. `setData` means "this is different
 * data": it serialises to a worker, re-parses, re-tiles, rebuilds the symbol buckets for every
 * feature and ships new buffers back — all of it O(features), across a thread boundary, every
 * time. Animation is the opposite shape, the same data evaluated at a new moment, and pushing it
 * through that pipeline cost about nine milliseconds of main thread per update for seven hundred
 * trains. Which is why the map only moved them four times a second: the update was expensive, so
 * it was rationed, and rationed motion is what stepping looks like.
 *
 * Here the marks are instances of one quad sampling one texture, and an update is a buffer upload
 * of sixty-four bytes per train — no worker, no tiling, no symbol layout, one draw call for the
 * whole system. The vertex shader carries each train forward from where it was last told, so how
 * often the buffer is rebuilt and how often the map draws are no longer the same question: rebuild
 * at whatever rate the CPU can afford and the motion is still smooth at the frame rate.
 */

/**
 * Floats per instance. Twenty keeps the stride at eighty bytes, a multiple of sixteen, with two
 * slots to spare for the arc-length that render-4 will want.
 *
 * It was sixteen, for a round sixty-four, until the fan moved in here: a train now carries the band
 * it rides and the direction of the track under it, because that is what lets the sideways shift be
 * computed with the camera this frame is drawn with rather than the one the CPU last looked at.
 */
export const STRIDE = 20;

const VERT = `#version 300 es
precision highp float;

in vec2 a_corner;      // the quad, in units of the mark's own size, y down
in vec2 a_pos;         // mercator, where the train was when the buffer was built
in vec2 a_vel;         // mercator per second, to carry it forward from there
in vec4 a_uv;
in vec2 a_sizeLo;      // pixels at zoom 10
in vec2 a_sizeHi;      // pixels at zoom 14
in float a_rot;        // radians, clockwise from up
in float a_alpha;
in float a_aligned;    // 1 where the mark turns with the map, as a chevron does
in float a_tangent;    // radians, the direction of the track here — not the marker's heading
in vec2 a_band;        // (cb, mb): which band of its corridor this service rides

uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_zoom;
uniform float u_dt;
uniform float u_bearing;
uniform float u_dpr;
// Pixels per band at the zoom being drawn: (colour, metric). Set in render(), from the camera the
// frame is actually drawn with.
uniform vec2 u_fan;

out vec2 v_uv;
out float v_alpha;

const float HALF_PI = 1.5707963267948966;

void main() {
  vec4 clip = u_matrix * vec4(a_pos + a_vel * u_dt, 0.0, 1.0);
  // The marks are a fixed size on screen, so the quad is built in pixels and converted to clip
  // units here rather than being carried in world coordinates.
  vec2 size = mix(a_sizeLo, a_sizeHi, clamp((u_zoom - 10.0) / 4.0, 0.0, 1.0)) * u_dpr;
  float angle = a_rot - a_aligned * u_bearing;
  float c = cos(angle), s = sin(angle);
  vec2 off = a_corner * size;
  off = vec2(off.x * c - off.y * s, off.x * s + off.y * c);
  /*
   * The fan, in pixels, here rather than on the CPU.
   *
   * This is the sideways shift that makes five services sharing Queens Boulevard read as five
   * lines, and the renderer gives the line itself exactly this shift. It used to be computed
   * twice — once in pixels by the renderer at draw time, once in metres by the frame callback
   * from a map.getZoom() read taken before MapLibre had integrated the camera — so through
   * any gesture the trains were fanned by one zoom and their lines drawn at another, and they
   * swam sideways off the line and caught up afterwards. Eleven pixels is four hundred metres
   * at city zoom, which is why it got worse the further in you went.
   *
   * There is no version of two derivations that stays in step; this is the one, and u_fan
   * carries the frame's own camera into it.
   *
   * Perpendicular to the track's own direction, on the right of travel, which is the side the
   * line is offset to. a_tangent and not the marker's heading: the heading is rate-limited so
   * the arrow sweeps through curves rather than snapping, and a damped direction is the right
   * thing to point an arrow with and the wrong thing to displace a position by — it lags most
   * exactly where the curve is tightest.
   */
  float fan = dot(a_band, u_fan) * u_dpr;
  float fa = a_tangent + HALF_PI - u_bearing;
  off += vec2(sin(fa), -cos(fa)) * fan;
  clip.xy += vec2(off.x, -off.y) / u_viewport * 2.0 * clip.w;
  gl_Position = clip;
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner + 0.5);
  v_alpha = a_alpha;
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in vec2 v_uv;
in float v_alpha;
out vec4 fragColor;
void main() {
  // The atlas is uploaded premultiplied, so fading is a scale of the whole colour.
  fragColor = texture(u_atlas, v_uv) * v_alpha;
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader failed to compile");
  return sh;
}

export class TrainLayer implements CustomLayerInterface {
  readonly id = "trains-gl";
  readonly type = "custom";
  readonly renderingMode = "2d";

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private quad: WebGLBuffer | null = null;
  private instances: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private capacity = 0;
  private count = 0;
  /** The simulation time the current buffer describes; motion is measured from it. */
  private epoch = 0;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  /**
   * `time` is the simulation clock, so a replay at speed carries the trains forward at that speed.
   *
   * `fanScale` is how much the fan is widened when the view is filtered to a few services — the
   * component owns that decision, but the *curve* is evaluated in here, against the zoom this
   * frame is drawn with. Handing over a finished number instead would put the camera read back on
   * the CPU, one frame early, which is the whole bug.
   */
  constructor(
    private readonly atlas: TrainAtlas,
    private time: () => number,
    private fanScale: () => number = () => 1,
  ) {}

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program failed to link");
    this.program = program;
    for (const n of ["u_matrix", "u_viewport", "u_zoom", "u_dt", "u_bearing", "u_dpr", "u_atlas", "u_fan"]) {
      this.uniforms[n] = gl.getUniformLocation(program, n);
    }

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // One quad, drawn once per train. y runs down, matching the atlas and the screen.
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, "a_corner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    this.instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const F = 4;
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(program, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * F, offset * F);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr("a_pos", 2, 0);
    attr("a_vel", 2, 2);
    attr("a_uv", 4, 4);
    attr("a_sizeLo", 2, 8);
    attr("a_sizeHi", 2, 10);
    attr("a_rot", 1, 12);
    attr("a_alpha", 1, 13);
    attr("a_aligned", 1, 14);
    attr("a_tangent", 1, 15);
    // At float 16, so the vec2 lands on an eight-byte boundary.
    attr("a_band", 2, 16);
    gl.bindVertexArray(null);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.image);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // No mipmaps: the marks are drawn at about a quarter of the size they are stored at and never
    // minified far enough to need them.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext) {
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.quad) gl.deleteBuffer(this.quad);
    if (this.instances) gl.deleteBuffer(this.instances);
    if (this.texture) gl.deleteTexture(this.texture);
    this.program = this.vao = this.quad = this.instances = this.texture = null;
    this.map = null;
    this.gl = null;
  }

  /**
   * Hand over a new set of marks: positions as of `at`, and how they are moving.
   *
   * Grows the buffer in powers of two so a busy hour does not reallocate every time a train enters
   * service, and never shrinks it — the peak is the size worth keeping.
   */
  setMarks(data: Float32Array, count: number, at: number) {
    const gl = this.gl;
    this.count = count;
    this.epoch = at;
    if (!gl || !this.instances) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    if (count > this.capacity) {
      this.capacity = Math.max(256, 2 ** Math.ceil(Math.log2(count)));
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * STRIDE * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * STRIDE));
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map;
    if (!this.program || !this.vao || !map || this.count === 0) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    /*
     * The matrix that takes mercator [0..1] straight to clip space.
     *
     * Not `modelViewProjectionMatrix`, which is in-tile units of 0..EXTENT: fed mercator
     * coordinates it collapses the whole system into the corner of the world and — because the
     * quad is sized in clip units scaled by w — draws it enormous.
     */
    gl.uniformMatrix4fv(this.uniforms.u_matrix, false, args.defaultProjectionData.mainMatrix as Float32Array);
    gl.uniform2f(this.uniforms.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.uniforms.u_zoom, map.getZoom());
    gl.uniform1f(this.uniforms.u_bearing, (map.getBearing() * Math.PI) / 180);
    gl.uniform1f(this.uniforms.u_dpr, gl.drawingBufferWidth / Math.max(1, map.getCanvas().clientWidth));
    /*
     * The fan, from the camera this frame is being drawn with.
     *
     * `map.getZoom()` read *here* is the transform MapLibre is rendering, which is the point: the
     * same call from the frame callback is read before the camera is integrated and is a frame
     * stale through every gesture.
     */
    const fan = fanAt(map.getZoom());
    const fs = this.fanScale();
    gl.uniform2f(this.uniforms.u_fan, fan.colour * fs, fan.metric * fs);
    // How far past the buffer we are. Zero when it was rebuilt this frame; the shader carries the
    // trains the rest of the way when it was not.
    gl.uniform1f(this.uniforms.u_dt, Math.max(0, Math.min(2, this.time() - this.epoch)));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.u_atlas, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }
}

/** Mercator [0..1] from a longitude and latitude, the frame the layer draws in. */
export const mercatorX = (lon: number) => (lon + 180) / 360;
export const mercatorY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
/** Mercator units per metre at a latitude — how a speed becomes a velocity in that frame. */
export const mercatorPerMetre = (lat: number) => 1 / (40_075_016.686 * Math.cos((lat * Math.PI) / 180));

/**
 * Write one mark into the instance buffer.
 *
 * Positional rather than an object per mark on purpose: this runs once per train per rebuild, and
 * the whole point of the exercise is not to allocate seven hundred of anything on a frame.
 */
export function writeMark(
  out: Float32Array, i: number,
  x: number, y: number, vx: number, vy: number,
  r: AtlasRect,
  loW: number, loH: number, hiW: number, hiH: number,
  rot: number, alpha: number, aligned: number,
  tangent: number, cb: number, mb: number,
) {
  const o = i * STRIDE;
  out[o] = x; out[o + 1] = y; out[o + 2] = vx; out[o + 3] = vy;
  out[o + 4] = r.u0; out[o + 5] = r.v0; out[o + 6] = r.u1; out[o + 7] = r.v1;
  out[o + 8] = loW; out[o + 9] = loH; out[o + 10] = hiW; out[o + 11] = hiH;
  out[o + 12] = rot; out[o + 13] = alpha; out[o + 14] = aligned;
  out[o + 15] = tangent; out[o + 16] = cb; out[o + 17] = mb;
  out[o + 18] = 0; out[o + 19] = 0;
}
