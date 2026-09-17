// Adapted from React Bits' Faulty Terminal background (MIT):
// https://www.reactbits.dev/backgrounds/faulty-terminal
//
// The GLSL below is upstream's, minus the uniforms this window does not turn:
// chromatic aberration, the dither grain and the light-mode inversion are gone,
// and the scanline, curvature, flicker, noise and grid figures are `const`s
// rather than props, because a background with fourteen knobs is fourteen ways
// for two screens to disagree about what the app looks like.
//
// The renderer is not upstream's. It drew through `ogl`, a library this package
// would otherwise not carry, for one fullscreen triangle and one program — so
// it is the WebGL calls `ogl` would have made instead. Two behaviours are ours
// and deliberate: Reduce Motion paints a single still frame (a canvas does not
// hear the `prefers-reduced-motion` rule in styles.css), and the loop stops
// while the element is off-screen or the window is hidden, so an idle window
// costs no wakeups.

import { cn } from "cn";
import { useEffect, useRef, type ReactElement } from "react";

const VERTEX_SHADER = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;

varying vec2 vUv;

uniform float iTime;
uniform float uScale;
uniform float uDigitSize;
uniform vec3  uTint;
uniform vec2  uMouse;
uniform float uUseMouse;
uniform float uPageLoadProgress;
uniform float uBrightness;

const vec2  uGridMul = vec2(2.0, 1.0);
const float uScanlineIntensity = 0.3;
const float uCurvature = 0.2;
const float uMouseStrength = 0.2;
const float uNoiseAmp = 1.0;

float time;

float noise(vec2 p)
{
  return sin(p.x * 10.0) * sin(p.y * (3.0 + sin(time * 0.090909))) + 0.2;
}

mat2 rotate(float angle)
{
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

float fbm(vec2 p)
{
  p *= 1.1;
  float f = 0.0;
  float amp = 0.5 * uNoiseAmp;

  mat2 modify0 = rotate(time * 0.02);
  f += amp * noise(p);
  p = modify0 * p * 2.0;
  amp *= 0.454545;

  mat2 modify1 = rotate(time * 0.02);
  f += amp * noise(p);
  p = modify1 * p * 2.0;
  amp *= 0.454545;

  mat2 modify2 = rotate(time * 0.08);
  f += amp * noise(p);

  return f;
}

float pattern(vec2 p, out vec2 q, out vec2 r) {
  vec2 offset1 = vec2(1.0);
  vec2 offset0 = vec2(0.0);
  mat2 rot01 = rotate(0.1 * time);
  mat2 rot1 = rotate(0.1);

  q = vec2(fbm(p + offset1), fbm(rot01 * p + offset1));
  r = vec2(fbm(rot1 * q + offset0), fbm(q + offset0));
  return fbm(p + r);
}

float digit(vec2 p){
    vec2 grid = uGridMul * 15.0;
    vec2 s = floor(p * grid) / grid;
    p = p * grid;
    vec2 q, r;
    float intensity = pattern(s * 0.1, q, r) * 1.3 - 0.03;

    if(uUseMouse > 0.5){
        vec2 mouseWorld = uMouse * uScale;
        float distToMouse = distance(s, mouseWorld);
        float mouseInfluence = exp(-distToMouse * 8.0) * uMouseStrength * 10.0;
        intensity += mouseInfluence;

        float ripple = sin(distToMouse * 20.0 - iTime * 5.0) * 0.1 * mouseInfluence;
        intensity += ripple;
    }

    float cellRandom = fract(sin(dot(s, vec2(12.9898, 78.233))) * 43758.5453);
    float cellDelay = cellRandom * 0.8;
    float cellProgress = clamp((uPageLoadProgress - cellDelay) / 0.2, 0.0, 1.0);
    intensity *= smoothstep(0.0, 1.0, cellProgress);

    p = fract(p);
    p *= uDigitSize;

    float px5 = p.x * 5.0;
    float py5 = (1.0 - p.y) * 5.0;
    float x = fract(px5);
    float y = fract(py5);

    float i = floor(py5) - 2.0;
    float j = floor(px5) - 2.0;
    float n = i * i + j * j;
    float f = n * 0.0625;

    float isOn = step(0.1, intensity - f);
    float brightness = isOn * (0.2 + y * 0.8) * (0.75 + x * 0.25);

    return step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0) * brightness;
}

float onOff(float a, float b, float c)
{
  return step(c, sin(iTime + a * cos(iTime * b)));
}

float displace(vec2 look)
{
    float y = look.y - mod(iTime * 0.25, 1.0);
    float window = 1.0 / (1.0 + 50.0 * y * y);
    return sin(look.y * 20.0 + iTime) * 0.0125 * onOff(4.0, 2.0, 0.8) * (1.0 + cos(iTime * 60.0)) * window;
}

vec3 getColor(vec2 p){
    float bar = step(mod(p.y + time * 20.0, 1.0), 0.2) * 0.4 + 1.0;
    bar *= uScanlineIntensity;

    p.x += displace(p);

    float middle = digit(p);

    const float off = 0.002;
    float sum = digit(p + vec2(-off, -off)) + digit(p + vec2(0.0, -off)) + digit(p + vec2(off, -off)) +
                digit(p + vec2(-off, 0.0)) + digit(p + vec2(0.0, 0.0)) + digit(p + vec2(off, 0.0)) +
                digit(p + vec2(-off, off)) + digit(p + vec2(0.0, off)) + digit(p + vec2(off, off));

    return vec3(0.9) * middle + sum * 0.1 * vec3(1.0) * bar;
}

vec2 barrel(vec2 uv){
  vec2 c = uv * 2.0 - 1.0;
  float r2 = dot(c, c);
  c *= 1.0 + uCurvature * r2;
  return c * 0.5 + 0.5;
}

void main() {
    time = iTime * 0.333333;

    vec2 p = barrel(vUv) * uScale;
    vec3 col = getColor(p) * uTint * uBrightness;

    gl_FragColor = vec4(col, 1.0);
}
`;

const POSITIONS = new Float32Array([-1, -1, 3, -1, -1, 3]);
const TEXTURE_COORDINATES = new Float32Array([0, 0, 2, 0, 0, 2]);

const MAXIMUM_PIXEL_RATIO = 2;
const ENTRANCE_MS = 2000;
const MOUSE_DAMPING = 0.08;
const STILL_FRAME_TIME = 12;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export interface FaultyTerminalProps {
  readonly className?: string | undefined;
  /** How much of the field one viewport shows — larger is a finer grid. */
  readonly scale?: number | undefined;
  /** Glyph size within its cell. Below 1 the glyphs separate. */
  readonly digitSize?: number | undefined;
  /** Seconds of animation per second of wall clock. */
  readonly timeScale?: number | undefined;
  /** Multiplies the field. Below 1 it recedes. */
  readonly brightness?: number | undefined;
  /** `#rgb` or `#rrggbb`. The field is white before it is tinted. */
  readonly tint?: string | undefined;
}

interface Settings {
  readonly scale: number;
  readonly digitSize: number;
  readonly timeScale: number;
  readonly brightness: number;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

function channels(tint: string): { red: number; green: number; blue: number } {
  const digits = tint.replace("#", "").trim();
  const full =
    digits.length === 3
      ? [...digits].map((digit) => `${digit}${digit}`).join("")
      : digits.padEnd(6, "0").slice(0, 6);
  const packed = Number.parseInt(full, 16);

  if (Number.isNaN(packed)) return { red: 1, green: 1, blue: 1 };

  return {
    red: ((packed >> 16) & 255) / 255,
    green: ((packed >> 8) & 255) / 255,
    blue: (packed & 255) / 255,
  };
}

function settingsOf(props: FaultyTerminalProps): Settings {
  return {
    scale: props.scale ?? 1,
    digitSize: props.digitSize ?? 1.5,
    timeScale: props.timeScale ?? 0.3,
    brightness: props.brightness ?? 1,
    ...channels(props.tint ?? "#ffffff"),
  };
}

function compile(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader | null {
  const shader = gl.createShader(kind);

  if (shader === null) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true) return shader;

  gl.deleteShader(shader);

  return null;
}

function link(gl: WebGLRenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = vertex === null || fragment === null ? null : gl.createProgram();

  if (program === null || vertex === null || fragment === null) {
    if (vertex !== null) gl.deleteShader(vertex);
    if (fragment !== null) gl.deleteShader(fragment);

    return null;
  }

  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (gl.getProgramParameter(program, gl.LINK_STATUS) === true) return program;

  gl.deleteProgram(program);

  return null;
}

function attribute(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
  data: Float32Array,
): WebGLBuffer | null {
  const buffer = gl.createBuffer();
  const location = gl.getAttribLocation(program, name);

  if (buffer === null || location < 0) return buffer;

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

  return buffer;
}

function run(
  canvas: HTMLCanvasElement,
  settings: { readonly current: Settings },
): (() => void) | undefined {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  const program = gl === null ? null : link(gl);

  if (gl === null || program === null) return undefined;

  const position = attribute(gl, program, "position", POSITIONS);
  const coordinates = attribute(gl, program, "uv", TEXTURE_COORDINATES);

  gl.useProgram(program);

  const iTime = gl.getUniformLocation(program, "iTime");
  const uScale = gl.getUniformLocation(program, "uScale");
  const uDigitSize = gl.getUniformLocation(program, "uDigitSize");
  const uTint = gl.getUniformLocation(program, "uTint");
  const uMouse = gl.getUniformLocation(program, "uMouse");
  const uUseMouse = gl.getUniformLocation(program, "uUseMouse");
  const uPageLoadProgress = gl.getUniformLocation(program, "uPageLoadProgress");
  const uBrightness = gl.getUniformLocation(program, "uBrightness");

  const controller = new AbortController();
  const { signal } = controller;
  const stillness = window.matchMedia(REDUCED_MOTION);

  let rect = canvas.getBoundingClientRect();
  let pointerX = 0.5;
  let pointerY = 0.5;
  let smoothX = 0.5;
  let smoothY = 0.5;
  let clock = 0;
  let entrance = 0;
  let previous = 0;
  let frame = 0;
  let isOnScreen = true;

  const resize = (): void => {
    const ratio = Math.min(window.devicePixelRatio || 1, MAXIMUM_PIXEL_RATIO);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));

    rect = canvas.getBoundingClientRect();

    if (canvas.width === width && canvas.height === height) return;

    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  };

  const paint = (time: number, progress: number, withPointer: number): void => {
    const current = settings.current;

    gl.uniform1f(iTime, time);
    gl.uniform1f(uScale, current.scale);
    gl.uniform1f(uDigitSize, current.digitSize);
    gl.uniform3f(uTint, current.red, current.green, current.blue);
    gl.uniform2f(uMouse, smoothX, smoothY);
    gl.uniform1f(uUseMouse, withPointer);
    gl.uniform1f(uPageLoadProgress, progress);
    gl.uniform1f(uBrightness, current.brightness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const step = (now: number): void => {
    frame = requestAnimationFrame(step);

    const delta = previous === 0 ? 0 : now - previous;

    previous = now;
    clock += delta * 0.001 * settings.current.timeScale;
    entrance = Math.min(entrance + delta, ENTRANCE_MS);
    smoothX += (pointerX - smoothX) * MOUSE_DAMPING;
    smoothY += (pointerY - smoothY) * MOUSE_DAMPING;

    paint(clock, entrance / ENTRANCE_MS, 1);
  };

  const stop = (): void => {
    if (frame === 0) return;

    cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
  };

  const sync = (): void => {
    stop();

    if (stillness.matches) {
      smoothX = 0.5;
      smoothY = 0.5;
      paint(STILL_FRAME_TIME, 1, 0);

      return;
    }

    if (isOnScreen && !document.hidden) frame = requestAnimationFrame(step);
  };

  const observer = new ResizeObserver(() => {
    resize();

    if (frame === 0) sync();
  });

  const visibility = new IntersectionObserver((entries) => {
    isOnScreen = entries.some((entry) => entry.isIntersecting);
    sync();
  });

  observer.observe(canvas);
  visibility.observe(canvas);
  resize();

  stillness.addEventListener("change", sync, { signal });
  document.addEventListener("visibilitychange", sync, { signal });
  window.addEventListener(
    "pointermove",
    (event: PointerEvent) => {
      pointerX = (event.clientX - rect.left) / Math.max(1, rect.width);
      pointerY = 1 - (event.clientY - rect.top) / Math.max(1, rect.height);
    },
    { passive: true, signal },
  );
  canvas.addEventListener(
    "webglcontextlost",
    (event) => {
      event.preventDefault();
      stop();
    },
    { signal },
  );

  sync();

  return () => {
    stop();
    controller.abort();
    observer.disconnect();
    visibility.disconnect();
    gl.deleteProgram(program);

    if (position !== null) gl.deleteBuffer(position);
    if (coordinates !== null) gl.deleteBuffer(coordinates);

    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}

export function FaultyTerminal(props: FaultyTerminalProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const settingsRef = useRef<Settings>(settingsOf(props));
  const { className, scale, digitSize, timeScale, brightness, tint } = props;

  useEffect(() => {
    settingsRef.current = settingsOf({ scale, digitSize, timeScale, brightness, tint });
  }, [scale, digitSize, timeScale, brightness, tint]);

  useEffect(() => {
    const canvas = canvasRef.current;

    return canvas === null ? undefined : run(canvas, settingsRef);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn("pointer-events-none block h-full w-full", className)}
    />
  );
}
