import { L } from '../world/textures';
import { LIGHTING, SCENE_BINDINGS, SHADOW_BINDINGS } from './common';

const VS_IN = /* wgsl */ `
struct VIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) w: vec4f,     // grass, dirt, sand, rock
  @location(3) mw: vec2f,    // mud, water depth (negative on dry land)
};
`;

export const TERRAIN_WGSL = /* wgsl */ `
${SCENE_BINDINGS}
${LIGHTING}
${VS_IN}
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) p: vec3f,
  @location(1) n: vec3f,
  @location(2) w: vec4f,
  @location(3) mw: vec2f,
};

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.clip = g.vp * vec4f(v.pos, 1.0);
  o.p = v.pos; o.n = v.nrm; o.w = v.w; o.mw = v.mw;
  return o;
}

/** Bright web of pixelated caustics on the bed. */
fn caustics(p: vec2f, t: f32) -> f32 {
  let q = p * 1.6;
  let a = sin(q.x + sin(q.y * 1.3 + t * 0.9) * 1.4);
  let b = sin(q.y * 1.1 + sin(q.x * 0.8 - t * 0.7) * 1.6);
  let c = pow(1.0 - abs(a * b), 10.0);
  return floor(c * 3.0) / 3.0;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let n = normalize(i.n);
  let dz = (bayer(i.clip.xy) - 0.5) * 0.45;
  let depth = i.mw.y;
  // dithered material pick: the strongest weight wins, the threshold jitters per pixel so borders interleave
  var w = i.w + vec4f(dz, -dz, dz * 0.7, -dz * 0.8);
  var layer = ${L.Grass};
  var best = w.x;
  if (w.y > best) { best = w.y; layer = ${L.Dirt}; }
  if (w.z > best) { best = w.z; layer = ${L.Sand}; }
  if (w.w > best) { best = w.w; layer = ${L.Rock}; }
  if (i.mw.x + dz > 0.45 && layer != ${L.Rock}) { layer = ${L.Mud}; }
  let uv = projUV(i.p, n);
  var albedo = textureSample(atlas, samp, uv, layer).rgb;
  if (layer == ${L.Grass}) { albedo = grassSeason(albedo); }

  // wet margin, algae on the bed
  albedo *= select(1.0, 0.7, depth > -0.18);
  albedo *= 1.0 - 0.3 * g.weather.x * (1.0 - g.weather.y); // wet ground in the rain
  if (depth < -0.05 && snowAt(i.p, n, i.clip.xy)) { albedo = snowAlbedo(i.p); }
  let algae = step(0.62, vnoise(i.p.xz * 0.6) * 0.7 + vnoise(i.p.xz * 3.1) * 0.3) * step(0.3, depth);
  albedo = mix(albedo, albedo * vec3f(0.45, 0.95, 0.35) + vec3f(0.0, 0.03, 0.0), algae);

  var c = shade(albedo, n, i.p, 1.0);
  if (depth > 0.0) {
    // light under water: absorbed with depth, greened, rippled with caustics
    let sh = sunShadow(i.p, n);
    let k = exp(-depth * vec3f(0.9, 0.45, 0.55));
    c = c * k + albedo * g.sunCol.rgb * caustics(i.p.xz, g.cam.w) * 0.45 * sh * k.g * max(n.y, 0.0);
  }
  return vec4f(fog(c, i.p), 1.0);
}
`;

export const TERRAIN_SHADOW_WGSL = /* wgsl */ `
${SHADOW_BINDINGS}
${VS_IN}
@vertex fn vs(v: VIn) -> @builtin(position) vec4f {
  return g.shadow * vec4f(v.pos, 1.0);
}
`;
