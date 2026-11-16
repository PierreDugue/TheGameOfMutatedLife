import { L } from '../world/textures';
import { LIGHTING, SCENE_BINDINGS, SHADOW_BINDINGS } from './common';

const VS_IN = /* wgsl */ `
struct VIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) uv: vec2f,
  @location(3) ls: vec2f,    // texture layer, sway
  @location(4) tint: vec3f,
  @location(5) ao: f32,
};
/** Wind: a gusting sway that travels across the valley. */
fn wind(p: vec3f, t: f32) -> vec3f {
  let gust = 0.6 + 0.4 * sin(t * 0.35 + p.x * 0.05);
  return vec3f(sin(t * 1.9 + p.x * 0.45 + p.z * 0.3), 0.0, cos(t * 1.4 + p.z * 0.5) * 0.6) * gust;
}
`;

export const PROPS_WGSL = /* wgsl */ `
${SCENE_BINDINGS}
${LIGHTING}
${VS_IN}
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) p: vec3f,
  @location(1) n: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) layer: i32,
  @location(4) tint: vec3f,
  @location(5) ao: f32,
};

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  let p = v.pos + wind(v.pos, g.cam.w) * v.ls.y;
  o.clip = g.vp * vec4f(p, 1.0);
  o.p = p; o.n = v.nrm; o.uv = v.uv; o.layer = i32(v.ls.x + 0.5); o.tint = v.tint; o.ao = v.ao;
  return o;
}

@fragment fn fsSolid(i: VOut) -> @location(0) vec4f {
  let n = normalize(i.n);
  let uv = projUV(i.p, n);
  // moss on the tops of rocks
  let moss = i.layer == ${L.Rock} && n.y > 0.55 && vnoise(i.p.xz * 1.7) + (bayer(i.clip.xy) - 0.5) * 0.3 > 0.55;
  let layer = select(i.layer, ${L.Grass}, moss);
  let albedo = textureSample(atlas, samp, uv, layer).rgb * i.tint;
  return vec4f(fog(shade(albedo, n, i.p, i.ao), i.p), 1.0);
}

@fragment fn fsCutout(i: VOut) -> @location(0) vec4f {
  let t = textureSample(atlas, samp, i.uv, i.layer);
  if (t.a < 0.5) { discard; }
  let n = normalize(i.n);
  // grass-like cards darken toward their roots
  let rooted = i.layer != ${L.Lily} && i.layer != ${L.LilyFlower} && i.layer != ${L.Willow};
  let ao = i.ao * select(1.0, mix(1.0, 0.55, i.uv.y * i.uv.y), rooted);
  return vec4f(fog(shade(t.rgb * i.tint, n, i.p, ao), i.p), 1.0);
}
`;

export const PROPS_SHADOW_WGSL = /* wgsl */ `
${SHADOW_BINDINGS}
${VS_IN}
struct SOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) layer: i32 };
@vertex fn vs(v: VIn) -> SOut {
  var o: SOut;
  o.clip = g.shadow * vec4f(v.pos, 1.0);
  o.uv = v.uv; o.layer = i32(v.ls.x + 0.5);
  return o;
}
@fragment fn fsCutout(i: SOut) {
  if (textureSample(atlas, samp, i.uv, i.layer).a < 0.5) { discard; }
}
`;
