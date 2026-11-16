import { LIGHTING, SCENE_BINDINGS } from './common';

// Cells and food particles as camera-facing sphere impostors (opaque, scene pass), and their glow halos
// (additive, drawn after the water so they shine through it). Each never shrinks below about one low-res pixel.

const COMMON = /* wgsl */ `
struct Inst {
  @location(0) pr: vec4f,    // position, radius
  @location(1) ck: vec4f,    // colour, kind (0 sun-eater, 1 eater, 2 particle)
  @location(2) misc: vec4f,  // depth below the surface, selected, phase, 0
};
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) col: vec3f,
  @location(2) @interpolate(flat) kmisc: vec4f,  // kind, depth, selected, phase
  @location(3) p: vec3f,
  @location(4) @interpolate(flat) near: f32,
};
const CORNERS = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));

fn billboard(vi: u32, inst: Inst, grow: f32, minPx: f32) -> VOut {
  var o: VOut;
  let uv = CORNERS[vi];
  let dist = max(length(inst.pr.xyz - g.cam.xyz), 0.01);
  let px = 2.0 * dist * g.up.w / g.res.y; // world size of one low-res pixel at that distance
  let r = max(inst.pr.w, minPx * px * 0.5) * grow;
  let p = inst.pr.xyz + (g.right.xyz * uv.x + g.up.xyz * uv.y) * r;
  o.clip = g.vp * vec4f(p, 1.0);
  o.uv = uv; o.col = inst.ck.rgb; o.p = inst.pr.xyz;
  o.kmisc = vec4f(inst.ck.w, inst.misc.x, inst.misc.y, inst.misc.z);
  o.near = inst.misc.w;
  return o;
}
`;

export const CELLS_WGSL = /* wgsl */ `
${SCENE_BINDINGS}
${LIGHTING}
${COMMON}
@vertex fn vs(@builtin(vertex_index) vi: u32, inst: Inst) -> VOut {
  let minPx = select(1.6, 1.0, inst.ck.w > 1.5) + inst.misc.y * 2.0;
  return billboard(vi, inst, 1.0, minPx);
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let d2 = dot(i.uv, i.uv);
  if (d2 > 1.0) { discard; }
  let kind = i.kmisc.x; let depth = i.kmisc.y; let sel = i.kmisc.z; let ph = i.kmisc.w;
  let z = sqrt(1.0 - d2);
  let n = normalize(g.right.xyz * i.uv.x + g.up.xyz * i.uv.y - g.fwd.xyz * z);
  var albedo = i.col;
  var emit = 0.0;
  if (kind < 1.5) {
    // membrane rim, nucleus, and chloroplast specks for sun-eaters
    let rim = smoothstep(0.62, 0.9, d2);
    albedo = mix(albedo * 0.75, albedo * 1.25 + 0.1, rim);
    let wob = vec2f(sin(g.cam.w * 1.3 + ph * 6.28), cos(g.cam.w * 1.1 + ph * 6.28)) * 0.08;
    if (length(i.uv - vec2f(0.22, 0.18) - wob) < 0.28) { albedo *= 0.45; }
    let cell = floor((i.uv + 1.0) * 3.0);
    if (kind < 0.5 && hash12(cell + ph * 31.0) > 0.55 && d2 < 0.55) { albedo = vec3f(0.15, 0.6, 0.12); }
    emit = 0.35;
    albedo = select(albedo, mix(albedo, vec3f(1.0, 0.9, 0.2), rim), sel > 0.5);
  }
  let ndl = max(dot(n, g.sunDir.xyz), 0.0);
  let k = exp(-depth * vec3f(0.9, 0.45, 0.55));
  let c = albedo * ((g.sunCol.rgb * ndl + g.ambSky.rgb) * k + emit);
  return vec4f(fog(c, i.p), 1.0);
}
`;

export const HALO_WGSL = /* wgsl */ `
${SCENE_BINDINGS}
${LIGHTING}
${COMMON}
@vertex fn vs(@builtin(vertex_index) vi: u32, inst: Inst) -> VOut {
  var o = billboard(vi, inst, select(3.0, 0.0, inst.ck.w > 1.5) + inst.misc.y * 1.5, 1.6 + inst.misc.y * 2.0);
  return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let d = length(i.uv);
  if (d > 1.0) { discard; }
  let sel = i.kmisc.z;
  // stepped falloff keeps the glow pixelated
  // brighter when seen from above, so life shows through the water surface
  let boost = select(3.0, 1.0, g.zenith.w > 0.5);
  var a = floor((1.0 - smoothstep(0.2, 1.0, d)) * 4.0) / 4.0 * 0.22 * boost * select(1.0, 0.15, i.near > 0.5);
  var c = i.col * a;
  let pulse = 0.5 + 0.5 * sin(g.cam.w * 5.0);
  let ring = step(abs(d - 0.62), 0.09) * sel;
  c += vec3f(1.0, 0.85, 0.2) * ring * (0.6 + 0.6 * pulse);
  return vec4f(c * (1.0 - g.sunCol.a * 0.3 + g.sunCol.a), 1.0);
}
`;
