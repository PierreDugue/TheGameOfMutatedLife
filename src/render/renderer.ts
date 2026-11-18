import { LEVELS, PIXEL, SHADOW_SIZE } from '../config';
import { createBuffer, type GPU } from '../gpu/device';
import { POST_WGSL } from '../shaders/post';
import { PROPS_SHADOW_WGSL, PROPS_WGSL } from '../shaders/props';
import { TERRAIN_SHADOW_WGSL, TERRAIN_WGSL } from '../shaders/terrain';
import { WATER_WGSL } from '../shaders/water';
import { CELLS_WGSL, HALO_WGSL } from '../shaders/life';
import { CREATURES_WGSL } from '../shaders/creatures';
import { PRECIP_WGSL } from '../shaders/precip';
import { primitiveMeshes, PRIM } from '../life/draw';
import type { Mesh } from '../world/meshkit';
import type { Light } from '../world/sky';
import { shadowMatrix, UB_FLOATS, writeGlobals, type View } from './uniforms';

interface Geo { vb: GPUBuffer; ib: GPUBuffer; count: number }

const HDR: GPUTextureFormat = 'rgba16float';
const DEPTH: GPUTextureFormat = 'depth32float';

const TERRAIN_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 48, attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x4' }, { shaderLocation: 3, offset: 40, format: 'float32x2' },
  ],
};
const PROP_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 56, attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x2' },
    { shaderLocation: 4, offset: 40, format: 'float32x3' }, { shaderLocation: 5, offset: 52, format: 'float32' },
  ],
};
/** Life instances: position + radius, colour + kind, depth / selected / phase. */
const LIFE_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 48, stepMode: 'instance', attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' },
    { shaderLocation: 2, offset: 32, format: 'float32x4' },
  ],
};
const WATER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }],
};

export interface SceneMeshes {
  terrain: Mesh | { vb: Float32Array<ArrayBuffer>; ib: Uint32Array<ArrayBuffer> }; solid: Mesh; cutout: Mesh;
  water: { vb: Float32Array<ArrayBuffer>; ib: Uint32Array<ArrayBuffer> };
  /** The cabin, drawn only while it is switched on. */
  houseSolid: Mesh; houseCutout: Mesh;
}

export class Renderer {
  private readonly device: GPUDevice;
  private readonly ub: GPUBuffer;
  private readonly u = new Float32Array(UB_FLOATS);
  private readonly geo: Record<'terrain' | 'solid' | 'cutout' | 'water' | 'houseSolid' | 'houseCutout', Geo>;
  private readonly shadowTex: GPUTexture;
  private readonly sceneBG: GPUBindGroup;
  private readonly shadowBG: GPUBindGroup;
  private readonly pipes: Record<string, GPURenderPipeline> = {};
  private readonly postLayout: GPUBindGroupLayout;
  private readonly waterLayout: GPUBindGroupLayout;
  private hdr!: GPUTexture;
  private depth!: GPUTexture;
  private postBG!: GPUBindGroup;
  private waterBG!: GPUBindGroup;
  private shadowM = new Float32Array(16);
  private shadowDir: [number, number, number] = [0, 0, 0];
  private shadowDirty = true;
  private lifeBuf: GPUBuffer | null = null;
  private lifeCount = 0;
  private lifeFirst = 0;
  private primBuf: GPUBuffer | null = null;
  private primCounts = [0, 0, 0];
  private readonly primMeshes: { buf: GPUBuffer; count: number }[];
  width = 0; height = 0; lowW = 0; lowH = 0;
  pixel = true;
  /** Season blend weights (spring, summer, fall, winter). */
  season: [number, number, number, number] = [1, 0, 0, 0];
  /** Season the shadow map was last drawn for (mushrooms come and go, snow hides grass). */
  private shadowSeason = [1, 0, 0, 0];
  /** Weather uniforms (see Frame.weather) and the number of rain / snow particles to draw. */
  readonly weather = new Float32Array(12);
  precipCount = 0;
  /** House uniforms (see Frame.house); index 10 is the on flag. */
  readonly house = new Float32Array(12);
  get houseOn(): boolean { return this.house[10] > 0.5; }
  setHouse(values: number[]): void { this.house.set(values); this.shadowDirty = true; }

  constructor(private readonly gpu: GPU, meshes: SceneMeshes, atlas: GPUTexture) {
    const d = (this.device = gpu.device);
    this.ub = d.createBuffer({ size: UB_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const up = (m: { vb: Float32Array<ArrayBuffer>; ib: Uint32Array<ArrayBuffer> }): Geo => ({
      vb: createBuffer(d, m.vb, GPUBufferUsage.VERTEX), ib: createBuffer(d, m.ib, GPUBufferUsage.INDEX), count: m.ib.length,
    });
    this.geo = {
      terrain: up(meshes.terrain), solid: up(meshes.solid), cutout: up(meshes.cutout), water: up(meshes.water),
      houseSolid: up(meshes.houseSolid), houseCutout: up(meshes.houseCutout),
    };

    this.shadowTex = d.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const samp = d.createSampler({ magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 1 });
    const shadowSamp = d.createSampler({ compare: 'less-equal', magFilter: 'nearest', minFilter: 'nearest' });

    const F = GPUShaderStage.FRAGMENT, V = GPUShaderStage.VERTEX;
    const sceneLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: V | F, buffer: {} },
        { binding: 1, visibility: F, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: F, sampler: {} },
        { binding: 3, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: F, sampler: { type: 'comparison' } },
      ],
    });
    const shadowLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: V | F, buffer: {} },
        { binding: 1, visibility: F, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: F, sampler: {} },
      ],
    });
    this.waterLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: { sampleType: 'depth' } }] });
    this.postLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, buffer: {} },
        { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
      ],
    });
    const atlasView = atlas.createView({ dimension: '2d-array' });
    this.sceneBG = d.createBindGroup({
      layout: sceneLayout, entries: [
        { binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: atlasView }, { binding: 2, resource: samp },
        { binding: 3, resource: this.shadowTex.createView() }, { binding: 4, resource: shadowSamp },
      ],
    });
    this.shadowBG = d.createBindGroup({
      layout: shadowLayout, entries: [{ binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: atlasView }, { binding: 2, resource: samp }],
    });

    const mod = (code: string, label: string): GPUShaderModule => d.createShaderModule({ code, label });
    const terrainM = mod(TERRAIN_WGSL, 'terrain'), propsM = mod(PROPS_WGSL, 'props'), waterM = mod(WATER_WGSL, 'water');
    const tShadowM = mod(TERRAIN_SHADOW_WGSL, 'terrain shadow'), pShadowM = mod(PROPS_SHADOW_WGSL, 'props shadow'), postM = mod(POST_WGSL, 'post');
    const sceneL = d.createPipelineLayout({ bindGroupLayouts: [sceneLayout] });
    const waterL = d.createPipelineLayout({ bindGroupLayouts: [sceneLayout, this.waterLayout] });
    const shadowL = d.createPipelineLayout({ bindGroupLayouts: [shadowLayout] });
    const depthOn: GPUDepthStencilState = { format: DEPTH, depthWriteEnabled: true, depthCompare: 'greater' };
    const scene = (label: string, m: GPUShaderModule, buf: GPUVertexBufferLayout, fs: string, cull: GPUCullMode): GPURenderPipeline => d.createRenderPipeline({
      label, layout: sceneL,
      vertex: { module: m, entryPoint: 'vs', buffers: [buf] },
      fragment: { module: m, entryPoint: fs, targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
      depthStencil: depthOn,
    });
    this.pipes.terrain = scene('terrain', terrainM, TERRAIN_LAYOUT, 'fs', 'back');
    this.pipes.solid = scene('solid', propsM, PROP_LAYOUT, 'fsSolid', 'back');
    this.pipes.cutout = scene('cutout', propsM, PROP_LAYOUT, 'fsCutout', 'none');
    this.pipes.water = d.createRenderPipeline({
      label: 'water', layout: waterL,
      vertex: { module: waterM, entryPoint: 'vs', buffers: [WATER_LAYOUT] },
      fragment: {
        module: waterM, entryPoint: 'fs', targets: [{
          format: HDR, blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater' },
    });
    const cellsM = mod(CELLS_WGSL, 'cells'), haloM = mod(HALO_WGSL, 'halo');
    this.pipes.cells = d.createRenderPipeline({
      label: 'cells', layout: sceneL,
      vertex: { module: cellsM, entryPoint: 'vs', buffers: [LIFE_LAYOUT] },
      fragment: { module: cellsM, entryPoint: 'fs', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depthOn,
    });
    this.pipes.halo = d.createRenderPipeline({
      label: 'halo', layout: sceneL,
      vertex: { module: haloM, entryPoint: 'vs', buffers: [LIFE_LAYOUT] },
      fragment: {
        module: haloM, entryPoint: 'fs', targets: [{
          format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater' },
    });
    const precipM = mod(PRECIP_WGSL, 'precip');
    this.pipes.precip = d.createRenderPipeline({
      label: 'precip', layout: sceneL,
      vertex: { module: precipM, entryPoint: 'vs' },
      fragment: {
        module: precipM, entryPoint: 'fs', targets: [{
          format: HDR, blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'greater' },
    });
    const creaturesM = mod(CREATURES_WGSL, 'creatures');
    this.pipes.creatures = d.createRenderPipeline({
      label: 'creatures', layout: sceneL,
      vertex: {
        module: creaturesM, entryPoint: 'vs', buffers: [
          { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] },
          { arrayStride: PRIM * 4, stepMode: 'instance', attributes: [0, 1, 2, 3, 4].map((k) => ({ shaderLocation: 2 + k, offset: k * 16, format: 'float32x4' as GPUVertexFormat })) },
        ],
      },
      fragment: { module: creaturesM, entryPoint: 'fs', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depthOn,
    });
    this.primMeshes = primitiveMeshes().map((m) => ({ buf: createBuffer(d, m, GPUBufferUsage.VERTEX), count: m.length / 6 }));
    const shadowDepth: GPUDepthStencilState = { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less' };
    this.pipes.shTerrain = d.createRenderPipeline({
      label: 'shadow terrain', layout: shadowL, vertex: { module: tShadowM, entryPoint: 'vs', buffers: [TERRAIN_LAYOUT] },
      primitive: { cullMode: 'none' }, depthStencil: shadowDepth,
    });
    this.pipes.shSolid = d.createRenderPipeline({
      label: 'shadow solid', layout: shadowL, vertex: { module: pShadowM, entryPoint: 'vs', buffers: [PROP_LAYOUT] },
      primitive: { cullMode: 'none' }, depthStencil: shadowDepth,
    });
    this.pipes.shCutout = d.createRenderPipeline({
      label: 'shadow cutout', layout: shadowL, vertex: { module: pShadowM, entryPoint: 'vs', buffers: [PROP_LAYOUT] },
      fragment: { module: pShadowM, entryPoint: 'fsCutout', targets: [] },
      primitive: { cullMode: 'none' }, depthStencil: shadowDepth,
    });
    this.pipes.post = d.createRenderPipeline({
      label: 'post', layout: d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] }),
      vertex: { module: postM, entryPoint: 'vs' },
      fragment: { module: postM, entryPoint: 'fs', targets: [{ format: gpu.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.resize();
  }

  /** (Re)creates the low-resolution targets for the current canvas size and pixel mode. */
  resize(): void {
    const c = this.gpu.canvas, dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = Math.max(1, c.clientWidth), ch = Math.max(1, c.clientHeight);
    this.width = c.width = Math.round(cw * dpr);
    this.height = c.height = Math.round(ch * dpr);
    const lw = this.pixel ? Math.ceil(cw / PIXEL) : this.width, lh = this.pixel ? Math.ceil(ch / PIXEL) : this.height;
    if (lw === this.lowW && lh === this.lowH && this.hdr) return;
    this.lowW = lw; this.lowH = lh;
    this.hdr?.destroy(); this.depth?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.hdr = this.device.createTexture({ size: [lw, lh], format: HDR, usage });
    this.depth = this.device.createTexture({ size: [lw, lh], format: DEPTH, usage });
    this.postBG = this.device.createBindGroup({
      layout: this.postLayout, entries: [
        { binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: this.hdr.createView() }, { binding: 2, resource: this.depth.createView() },
      ],
    });
    this.waterBG = this.device.createBindGroup({ layout: this.waterLayout, entries: [{ binding: 0, resource: this.depth.createView() }] });
  }

  /** Uploads this frame's life impostors (12 floats each); instances before `first` get a halo but no body. */
  setLife(data: Float32Array<ArrayBuffer>, count: number, first = 0): void {
    const bytes = count * 12 * 4;
    this.lifeFirst = first;
    if (!this.lifeBuf || this.lifeBuf.size < bytes) {
      this.lifeBuf?.destroy();
      this.lifeBuf = this.device.createBuffer({ size: Math.max(bytes, 1 << 16) * 2, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (bytes) this.device.queue.writeBuffer(this.lifeBuf, 0, data.buffer, data.byteOffset, bytes);
    this.lifeCount = count;
  }

  /** Uploads close-up creature primitives: `counts` spheres, tubes, fans, in that order. */
  setCreatures(data: Float32Array<ArrayBuffer>, counts: number[]): void {
    const total = counts[0] + counts[1] + counts[2], bytes = total * PRIM * 4;
    if (!this.primBuf || this.primBuf.size < bytes) {
      this.primBuf?.destroy();
      this.primBuf = this.device.createBuffer({ size: Math.max(bytes, 1 << 16) * 2, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (bytes) this.device.queue.writeBuffer(this.primBuf, 0, data.buffer, data.byteOffset, bytes);
    this.primCounts = counts.slice();
  }

  private drawLife(pass: GPURenderPassEncoder, pipe: string): void {
    if (!this.lifeCount || !this.lifeBuf) return;
    pass.setPipeline(this.pipes[pipe]);
    pass.setVertexBuffer(0, this.lifeBuf);
    if (pipe === 'cells') { if (this.lifeCount > this.lifeFirst) pass.draw(6, this.lifeCount - this.lifeFirst, 0, this.lifeFirst); }
    else pass.draw(6, this.lifeCount);
  }

  private drawCreatures(pass: GPURenderPassEncoder): void {
    if (!this.primBuf) return;
    pass.setPipeline(this.pipes.creatures);
    pass.setVertexBuffer(1, this.primBuf);
    let first = 0;
    for (let m = 0; m < 3; m++) {
      const n = this.primCounts[m];
      if (n) { pass.setVertexBuffer(0, this.primMeshes[m].buf); pass.draw(this.primMeshes[m].count, n, 0, first); }
      first += n;
    }
  }

  private captureNext: ((b: Blob | null) => void) | null = null;

  /** Resolves with a PNG of the next rendered frame (works even while the page is hidden). */
  capture(): Promise<Blob | null> { return new Promise((r) => { this.captureNext = r; }); }

  private async readShot(buf: GPUBuffer, rowBytes: number): Promise<Blob | null> {
    const w = this.width, h = this.height;
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange()), px = new Uint8ClampedArray(w * h * 4);
    const bgra = this.gpu.format === 'bgra8unorm';
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * rowBytes + x * 4, o = (y * w + x) * 4;
      px[o] = src[i + (bgra ? 2 : 0)]; px[o + 1] = src[i + 1]; px[o + 2] = src[i + (bgra ? 0 : 2)]; px[o + 3] = 255;
    }
    buf.unmap(); buf.destroy();
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.putImageData(new ImageData(px, w, h), 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }

  setPixel(on: boolean): void { this.pixel = on; this.resize(); }

  private draw(pass: GPURenderPassEncoder, pipe: string, g: Geo): void {
    if (!g.count) return;
    pass.setPipeline(this.pipes[pipe]);
    pass.setVertexBuffer(0, g.vb);
    pass.setIndexBuffer(g.ib, 'uint32');
    pass.drawIndexed(g.count);
  }

  render(view: View, time: number, light: Light, underwater: boolean): void {
    const d = this.device;
    // the world is static: re-render the shadow map only when the key light has moved ~0.2°
    const dd = light.dir, sd = this.shadowDir;
    const seasonMoved = this.season.some((w, i) => Math.abs(w - this.shadowSeason[i]) > 0.02);
    if (seasonMoved) { this.shadowSeason = [...this.season]; this.shadowDirty = true; }
    if (this.shadowDirty || dd[0] * sd[0] + dd[1] * sd[1] + dd[2] * sd[2] < 0.999994) {
      this.shadowM = shadowMatrix(light.dir);
      this.shadowDir = [...light.dir];
      this.shadowDirty = true;
    }
    writeGlobals(this.u, {
      view, time, light, lowW: this.lowW, lowH: this.lowH, canvasW: this.width, canvasH: this.height,
      underwater, pixel: this.pixel, levels: LEVELS, fog: 0.0035 + this.weather[2] * 0.06, season: this.season, weather: this.weather, house: this.house,
    }, this.shadowM);
    d.queue.writeBuffer(this.ub, 0, this.u);

    const enc = d.createCommandEncoder();
    if (this.shadowDirty) {
      this.shadowDirty = false;
      const p = enc.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      p.setBindGroup(0, this.shadowBG);
      this.draw(p, 'shTerrain', this.geo.terrain);
      this.draw(p, 'shSolid', this.geo.solid);
      this.draw(p, 'shCutout', this.geo.cutout);
      if (this.houseOn) { this.draw(p, 'shSolid', this.geo.houseSolid); this.draw(p, 'shCutout', this.geo.houseCutout); }
      p.end();
    }

    const hv = this.hdr.createView(), dv = this.depth.createView();
    const p = enc.beginRenderPass({
      colorAttachments: [{ view: hv, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: dv, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    p.setBindGroup(0, this.sceneBG);
    this.draw(p, 'terrain', this.geo.terrain);
    this.draw(p, 'solid', this.geo.solid);
    this.draw(p, 'cutout', this.geo.cutout);
    if (this.houseOn) { this.draw(p, 'solid', this.geo.houseSolid); this.draw(p, 'cutout', this.geo.houseCutout); }
    this.drawLife(p, 'cells');
    this.drawCreatures(p);
    p.end();

    const w = enc.beginRenderPass({
      colorAttachments: [{ view: hv, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: dv, depthReadOnly: true },
    });
    w.setBindGroup(0, this.sceneBG);
    w.setBindGroup(1, this.waterBG);
    this.draw(w, 'water', this.geo.water);
    this.drawLife(w, 'halo');
    if (this.precipCount > 0 && !underwater) {
      w.setPipeline(this.pipes.precip);
      w.draw(6, this.precipCount);
    }
    w.end();

    const frame = this.gpu.context.getCurrentTexture();
    const post = enc.beginRenderPass({
      colorAttachments: [{ view: frame.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    });
    post.setPipeline(this.pipes.post);
    post.setBindGroup(0, this.postBG);
    post.draw(3);
    post.end();
    let shot: GPUBuffer | null = null, rowBytes = 0;
    if (this.captureNext) {
      rowBytes = Math.ceil((this.width * 4) / 256) * 256;
      shot = d.createBuffer({ size: rowBytes * this.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.copyTextureToBuffer({ texture: frame }, { buffer: shot, bytesPerRow: rowBytes }, [this.width, this.height]);
    }
    d.queue.submit([enc.finish()]);
    if (shot && this.captureNext) { const done = this.captureNext; this.captureNext = null; void this.readShot(shot, rowBytes).then(done); }
  }
}
