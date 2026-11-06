import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";

import { projectMemoryPoint } from "./memory-3d.js";

import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

/**
 * Dependency-free WebGL2 renderer for the 3D memory graph.
 * Instanced billboard quads for nodes, one batched LINES draw for edges, GPU depth testing
 * (no per-frame CPU sort), and 1x1 offscreen color picking. Focus/hover styling is resolved
 * in the shader from uniforms, so pointer movement never re-uploads buffers; buffers change
 * only when the graph or the streamed layout positions change.
 */

export type Graph3DScene = {
  /** Render order; index i identifies ids[i] for picking and labels. */
  ids: string[];
  types: string[];
  labels: string[];
  /** Static per-node color (rgb 0..1) from the atlas. */
  colors: Float32Array;
  /** xyz per node; replaced (not mutated) whenever the streamed layout produces new positions. */
  positions: Float32Array;
  /** Edge list as index pairs into ids. */
  edgePairs: Uint32Array;
  edgeTypes: string[];
  /** 1 for nodes adjacent to the current focus; re-uploaded only when the focus changes. */
  neighbors: Uint8Array;
  /** Index of hover ?? selected node, or -1; consumed as a uniform, not a buffer. */
  focus: number;
};

/** Pick radius in CSS pixels; mirrors the Canvas hit test's max(7, radius + 3) lower bound. */
const PICK_RADIUS = 12;

const NODE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aPos;
layout(location=2) in vec3 aColor;
layout(location=3) in vec2 aMeta; // base radius, root flag
layout(location=4) in float aIndex;
layout(location=5) in float aNeighbor;
uniform vec2 uViewport;
uniform float uScale;
uniform float uZoom;
uniform float uYaw;
uniform float uPitch;
uniform float uPick;
uniform float uFocus;
uniform vec2 uPickTarget;
uniform vec2 uPickScale;
uniform float uPickRadius;
out vec3 vColor;
out float vAlpha;
out vec2 vUv;
flat out float vIndex;
void main() {
  float cy = cos(uYaw), sy = sin(uYaw);
  float x = aPos.x * cy + aPos.z * sy;
  float d = -aPos.x * sy + aPos.z * cy;
  float y = aPos.y * cos(uPitch) - d * sin(uPitch);
  float z = aPos.y * sin(uPitch) + d * cos(uPitch);
  float persp = 650.0 / max(120.0, 650.0 + z * uScale);
  float highlighted = uFocus >= 0.0 && aIndex == uFocus ? 1.0 : 0.0;
  float dimmed = uFocus >= 0.0 && aIndex != uFocus && aNeighbor < 0.5 ? 1.0 : 0.0;
  float radius = min(26.0, max(1.0, aMeta.x * persp * sqrt(uZoom) * (highlighted > 0.5 ? 1.5 : 1.0))); // cap bounds fill-rate overdraw at high zoom
  float cx = uViewport.x * 0.5 + x * uScale * uZoom * persp;
  float cyy = uViewport.y * 0.5 - y * uScale * uZoom * persp;
  vec2 ndc = vec2(cx * 2.0 / uViewport.x - 1.0, 1.0 - cyy * 2.0 / uViewport.y);
  if (uPick > 0.5) {
    radius = uPickRadius;
    ndc = (ndc - uPickTarget) * uPickScale;
  }
  vec2 off = aCorner * radius * 2.0 / uViewport * (uPick > 0.5 ? uPickScale : vec2(1.0));
  float zN = clamp(0.5 + z * uScale * 0.001, 0.0, 1.0);
  gl_Position = vec4(ndc + off, zN, 1.0);
  vUv = aCorner;
  vColor = highlighted > 0.5 ? vec3(1.0) : aColor;
  vAlpha = dimmed > 0.5 ? 0.2 : clamp(persp, 0.4, 1.0);
  vIndex = aIndex;
}`;

const NODE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
in vec2 vUv;
flat in float vIndex;
uniform float uPick;
out vec4 outColor;
void main() {
  if (uPick > 0.5) {
    float i = vIndex + 1.0;
    outColor = vec4(mod(i, 256.0) / 255.0, mod(floor(i / 256.0), 256.0) / 255.0, mod(floor(i / 65536.0), 256.0) / 255.0, 1.0);
    return;
  }
  if (dot(vUv, vUv) > 1.0) discard;
  outColor = vec4(vColor, vAlpha);
}`;

const EDGE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor; // base color by edge type
layout(location=2) in float aNode; // node index this vertex belongs to
uniform vec2 uViewport;
uniform float uScale;
uniform float uZoom;
uniform float uYaw;
uniform float uPitch;
uniform float uFocus;
out vec3 vColor;
void main() {
  float cy = cos(uYaw), sy = sin(uYaw);
  float x = aPos.x * cy + aPos.z * sy;
  float d = -aPos.x * sy + aPos.z * cy;
  float y = aPos.y * cos(uPitch) - d * sin(uPitch);
  float z = aPos.y * sin(uPitch) + d * cos(uPitch);
  float persp = 650.0 / max(120.0, 650.0 + z * uScale);
  float cx = uViewport.x * 0.5 + x * uScale * uZoom * persp;
  float cyy = uViewport.y * 0.5 - y * uScale * uZoom * persp;
  float zN = clamp(0.5 + z * uScale * 0.001, 0.0, 1.0);
  gl_Position = vec4(cx * 2.0 / uViewport.x - 1.0, 1.0 - cyy * 2.0 / uViewport.y, zN, 1.0);
  bool incident = uFocus >= 0.0 && aNode == uFocus;
  vColor = incident ? vec3(0.596, 0.855, 0.98) : uFocus >= 0.0 ? vec3(0.078, 0.125, 0.169) : aColor;
}`;

const EDGE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

const hexToRgb = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
};

const EDGE_COLORS: Record<string, [number, number, number]> = {
  DERIVED_FROM: hexToRgb("#385068"),
  DEFAULT: hexToRgb("#203343")
};

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader error");
  return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link error");
  return program;
}

export class MemoryGraphWebGLRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private nodeProgram: WebGLProgram;
  private edgeProgram: WebGLProgram;
  private nodeVao: WebGLVertexArrayObject;
  private edgeVao: WebGLVertexArrayObject;
  private quadBuffer: WebGLBuffer;
  private nodePosBuffer: WebGLBuffer;
  private nodeColorBuffer: WebGLBuffer;
  private nodeMetaBuffer: WebGLBuffer;
  private nodeIndexBuffer: WebGLBuffer;
  private nodeNeighborBuffer: WebGLBuffer;
  private edgePosBuffer: WebGLBuffer;
  private edgeColorBuffer: WebGLBuffer;
  private edgeNodeBuffer: WebGLBuffer;
  private pickFramebuffer: WebGLFramebuffer;
  private pickRenderbuffer: WebGLRenderbuffer;
  private nodeCount = 0;
  private edgeVertexCount = 0;
  private extent = 60;
  private scene: Graph3DScene | null = null;
  private lost = false;
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.canvas = canvas;
    this.gl = gl;
    this.nodeProgram = link(gl, NODE_VS, NODE_FS);
    this.edgeProgram = link(gl, EDGE_VS, EDGE_FS);

    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.nodePosBuffer = gl.createBuffer()!;
    this.nodeColorBuffer = gl.createBuffer()!;
    this.nodeMetaBuffer = gl.createBuffer()!;
    this.nodeIndexBuffer = gl.createBuffer()!;
    this.nodeNeighborBuffer = gl.createBuffer()!;
    this.edgePosBuffer = gl.createBuffer()!;
    this.edgeColorBuffer = gl.createBuffer()!;
    this.edgeNodeBuffer = gl.createBuffer()!;

    this.nodeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodePosBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeColorBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeMetaBuffer);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeIndexBuffer);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(4, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeNeighborBuffer);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    this.edgeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgePosBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeColorBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeNodeBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.pickFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
    this.pickRenderbuffer = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickRenderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 1, 1);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.pickRenderbuffer);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 1, 1);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      this.lost = true;
      this.onContextLost?.();
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.onContextRestored?.();
    });
  }

  static isSupported(): boolean {
    try {
      return Boolean(document.createElement("canvas").getContext("webgl2"));
    } catch {
      return false;
    }
  }

  get contextLost() { return this.lost; }

  private static extentOf(positions: Float32Array) {
    let extent = 60;
    for (let i = 0; i < positions.length; i += 3) {
      const d = Math.hypot(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      if (d > extent) extent = d;
    }
    return extent;
  }

  private edgePositions(scene: Graph3DScene) {
    const edgePos = new Float32Array(this.edgeVertexCount * 3);
    for (let e = 0; e < scene.edgePairs.length; e++) {
      const a = scene.edgePairs[e * 2]! * 3, b = scene.edgePairs[e * 2 + 1]! * 3;
      const p = scene.positions;
      edgePos.set([p[a]!, p[a + 1]!, p[a + 2]!, p[b]!, p[b + 1]!, p[b + 2]!], e * 6);
    }
    return edgePos;
  }

  /** Rebuild GPU buffers only for the parts of the scene that changed. */
  setScene(scene: Graph3DScene) {
    const gl = this.gl;
    const previous = this.scene;
    const graphChanged = !previous || previous.ids !== scene.ids || previous.edgePairs !== scene.edgePairs;
    const styleChanged = !previous || previous.focus !== scene.focus || previous.neighbors !== scene.neighbors;
    if (graphChanged) {
      this.nodeCount = scene.ids.length;
      this.edgeVertexCount = scene.edgePairs.length * 2;
      const meta = new Float32Array(this.nodeCount * 2);
      const index = new Float32Array(this.nodeCount);
      for (let i = 0; i < this.nodeCount; i++) {
        const root = scene.types[i] === "SOURCE" && isMemoryCoreLabel(scene.labels[i] ?? "");
        meta[i * 2] = root ? 10 : scene.types[i] === "SOURCE" ? 4.6 : 2.1;
        meta[i * 2 + 1] = root ? 1 : 0;
        index[i] = i;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, scene.colors, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeMetaBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, meta, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeIndexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, index, gl.STATIC_DRAW);
      const edgeColor = new Float32Array(this.edgeVertexCount * 3);
      const edgeNode = new Float32Array(this.edgeVertexCount);
      for (let e = 0; e < scene.edgePairs.length; e++) {
        const rgb = EDGE_COLORS[scene.edgeTypes[e] ?? "DEFAULT"] ?? EDGE_COLORS.DEFAULT!;
        edgeColor.set([...rgb, ...rgb], e * 6);
        edgeNode[e * 2] = scene.edgePairs[e * 2]!;
        edgeNode[e * 2 + 1] = scene.edgePairs[e * 2 + 1]!;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, edgeColor, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeNodeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, edgeNode, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgePosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.edgePositions(scene), gl.DYNAMIC_DRAW);
    }
    if (graphChanged || previous!.positions !== scene.positions) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodePosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, scene.positions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgePosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.edgePositions(scene), gl.DYNAMIC_DRAW);
      this.extent = MemoryGraphWebGLRenderer.extentOf(scene.positions);
    }
    if (styleChanged) {
      const neighbor = new Float32Array(this.nodeCount);
      for (let i = 0; i < this.nodeCount; i++) neighbor[i] = scene.neighbors[i] ?? 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeNeighborBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, neighbor, gl.DYNAMIC_DRAW);
    }
    this.scene = scene;
  }

  private uniforms(program: WebGLProgram) {
    const gl = this.gl;
    return {
      viewport: gl.getUniformLocation(program, "uViewport")!,
      scale: gl.getUniformLocation(program, "uScale")!,
      zoom: gl.getUniformLocation(program, "uZoom")!,
      yaw: gl.getUniformLocation(program, "uYaw")!,
      pitch: gl.getUniformLocation(program, "uPitch")!,
      pick: gl.getUniformLocation(program, "uPick")!,
      focus: gl.getUniformLocation(program, "uFocus")!,
      pickTarget: gl.getUniformLocation(program, "uPickTarget")!,
      pickScale: gl.getUniformLocation(program, "uPickScale")!,
      pickRadius: gl.getUniformLocation(program, "uPickRadius")!
    };
  }

  render(camera: MemoryCamera3D, focus: number) {
    if (this.lost || !this.scene) return;
    const gl = this.gl;
    const width = this.canvas.width, height = this.canvas.height;
    const scale = Math.min(width, height) * 0.4 / this.extent;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.edgeProgram);
    const edgeU = this.uniforms(this.edgeProgram);
    gl.uniform2f(edgeU.viewport, width, height);
    gl.uniform1f(edgeU.scale, scale);
    gl.uniform1f(edgeU.zoom, camera.zoom);
    gl.uniform1f(edgeU.yaw, camera.yaw);
    gl.uniform1f(edgeU.pitch, camera.pitch);
    gl.uniform1f(edgeU.focus, focus);
    gl.bindVertexArray(this.edgeVao);
    gl.drawArrays(gl.LINES, 0, this.edgeVertexCount);

    gl.useProgram(this.nodeProgram);
    const nodeU = this.uniforms(this.nodeProgram);
    gl.uniform2f(nodeU.viewport, width, height);
    gl.uniform1f(nodeU.scale, scale);
    gl.uniform1f(nodeU.zoom, camera.zoom);
    gl.uniform1f(nodeU.yaw, camera.yaw);
    gl.uniform1f(nodeU.pitch, camera.pitch);
    gl.uniform1f(nodeU.pick, 0);
    gl.uniform1f(nodeU.focus, focus);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
    gl.bindVertexArray(null);
  }

  /** GPU color picking: returns the node index at the CSS pixel, or -1. Single 1x1 readback, no CPU scan. */
  pick(xCss: number, yCss: number, camera: MemoryCamera3D): number {
    if (this.lost || !this.scene) return -1;
    const gl = this.gl;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width || this.canvas.width);
    const width = this.canvas.width, height = this.canvas.height;
    const scale = Math.min(width, height) * 0.4 / this.extent;
    const px = xCss * dpr, py = height - yCss * dpr;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
    gl.viewport(0, 0, 1, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.nodeProgram);
    const nodeU = this.uniforms(this.nodeProgram);
    gl.uniform2f(nodeU.viewport, width, height);
    gl.uniform1f(nodeU.scale, scale);
    gl.uniform1f(nodeU.zoom, camera.zoom);
    gl.uniform1f(nodeU.yaw, camera.yaw);
    gl.uniform1f(nodeU.pitch, camera.pitch);
    gl.uniform1f(nodeU.pick, 1);
    gl.uniform1f(nodeU.focus, -1);
    gl.uniform2f(nodeU.pickTarget, px * 2 / width - 1, py * 2 / height - 1);
    gl.uniform2f(nodeU.pickScale, width / (2 * PICK_RADIUS), height / (2 * PICK_RADIUS));
    gl.uniform1f(nodeU.pickRadius, PICK_RADIUS);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nodeCount);
    gl.bindVertexArray(null);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (pixel[3] === 0) return -1;
    return pixel[0]! + pixel[1]! * 256 + pixel[2]! * 65536 - 1;
  }

  /** CPU projection used only for the bounded label set. */
  project(index: number, camera: MemoryCamera3D): { x: number; y: number; perspective: number } | null {
    if (!this.scene || index < 0 || index >= this.nodeCount) return null;
    const p = this.scene.positions;
    const point: MemoryPoint3D = { x: p[index * 3]!, y: p[index * 3 + 1]!, z: p[index * 3 + 2]! };
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(rect.width, rect.height) * 0.4 / this.extent;
    return projectMemoryPoint(point, camera, scale, rect.width, rect.height);
  }

  dispose() {
    const gl = this.gl;
    for (const buffer of [this.quadBuffer, this.nodePosBuffer, this.nodeColorBuffer, this.nodeMetaBuffer, this.nodeIndexBuffer, this.nodeNeighborBuffer, this.edgePosBuffer, this.edgeColorBuffer, this.edgeNodeBuffer]) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.nodeVao);
    gl.deleteVertexArray(this.edgeVao);
    gl.deleteFramebuffer(this.pickFramebuffer);
    gl.deleteRenderbuffer(this.pickRenderbuffer);
    gl.deleteProgram(this.nodeProgram);
    gl.deleteProgram(this.edgeProgram);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
