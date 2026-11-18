import { L } from '../world/textures';
import { HOUSE, LIGHTING, NOISE, SCENE_BINDINGS, SHADOW_BINDINGS } from './common';

const VS_IN = /* wgsl */ `
struct VIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) uv: vec2f,
  @location(3) ls: vec2f,    // texture layer, sway
  @location(4) tint: vec3f,
  @location(5) ao: f32,
};
/** Mushrooms (sway slot = the share of fall after which each one has come up) are collapsed out of season. */
fn seasonal(v: VIn) -> bool {
  return i32(v.ls.x + 0.5) != ${L.Fungus} || g.season.z > v.ls.y;
}
/** Wind: a gusting sway that travels across the valley. */
fn wind(p: vec3f, t: f32) -> vec3f {
  let w = g.weather.w;
  let gust = 0.6 + 0.4 * sin(t * 0.35 + p.x * 0.05);
  let flutter = vec3f(sin(t * 1.9 + p.x * 0.45 + p.z * 0.3), 0.0, cos(t * 1.4 + p.z * 0.5) * 0.6) * gust * (0.35 + w * 1.6);
  // strong wind also bends everything downwind, in gusts
  let lean = vec3f(g.wind.x, 0.0, g.wind.y) * w * w * (0.9 + 0.6 * sin(t * 0.8 + dot(p.xz, g.wind.xy) * 0.15));
  return flutter + lean;
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
  let fungus = i32(v.ls.x + 0.5) == ${L.Fungus};
  let p = v.pos + wind(v.pos, g.cam.w) * select(v.ls.y, 0.0, fungus);
  o.clip = select(vec4f(0.0, 0.0, 0.0, 1.0), g.vp * vec4f(p, 1.0), seasonal(v));
  o.p = p; o.n = v.nrm; o.uv = v.uv; o.layer = i32(v.ls.x + 0.5); o.tint = v.tint; o.ao = v.ao;
  return o;
}

@fragment fn fsSolid(i: VOut) -> @location(0) vec4f {
  let n = normalize(i.n);
  let uv = projUV(i.p, n);
  // moss on the tops of rocks
  let moss = i.layer == ${L.Rock} && n.y > 0.55 && vnoise(i.p.xz * 1.7) + (bayer(i.clip.xy) - 0.5) * 0.3 > 0.55;
  let layer = select(i.layer, ${L.Grass}, moss);
  var albedo = textureSample(atlas, samp, uv, layer).rgb * i.tint;
  if (layer == ${L.Leaves} || layer == ${L.Bush}) { albedo = foliage(albedo, i.p); }
  else if (layer == ${L.Grass}) { albedo = grassSeason(albedo); }
  if (layer != ${L.Fungus} && layer != ${L.Berry} && snowAt(i.p, n, i.clip.xy)) { albedo = snowAlbedo(i.p); }
  return vec4f(fog(shade(albedo, n, i.p, i.ao), i.p), 1.0);
}

/** Seasonal swap of a cutout layer: flowers bloom in spring and wilt in fall and winter, lilies stop flowering. */
fn cutLayer(layer: i32, p: vec3f) -> i32 {
  let s = g.season;
  let gone = s.z + s.w;
  let k = vnoise(p.xz * 0.4 + vec2f(5.0, 1.0));
  if (layer == ${L.Flowers} && k < gone * 1.1) { return ${L.Blades}; }
  if (layer == ${L.Blades} && k > 1.0 - s.x * 0.5) { return ${L.Flowers}; }
  if (layer == ${L.LilyFlower} && k < gone * 1.1) { return ${L.Lily}; }
  return layer;
}
/** Grass cards are buried where snow lies. */
fn buried(layer: i32, p: vec3f, px: vec2f) -> bool {
  return (layer == ${L.Blades} || layer == ${L.Flowers}) && (snowAt(p, vec3f(0.0, 1.0, 0.0), px) || onFootprint(p));
}

/** Flames: licking noise tongues scrolling upward, hottest at the base, drawn unlit and bright. */
fn flame(uv: vec2f, p: vec3f) -> vec4f {
  let t = g.cam.w;
  let h = 1.0 - uv.y;
  let n = vnoise(vec2f(uv.x * 7.0 + p.x * 3.0, h * 5.0 - t * 4.0)) * 0.6 + vnoise(vec2f(uv.x * 15.0, h * 9.0 - t * 7.0)) * 0.4;
  let k = n * 1.1 - h * 1.15 - abs(uv.x - 0.5) * 1.6 + 0.45;
  if (k < 0.08) { return vec4f(0.0); }
  var c = vec3f(2.4, 0.5, 0.1);
  if (k > 0.22) { c = vec3f(4.0, 1.6, 0.3); }
  if (k > 0.4) { c = vec3f(5.0, 3.6, 1.4); }
  return vec4f(c, 1.0);
}

@fragment fn fsCutout(i: VOut) -> @location(0) vec4f {
  let layer = cutLayer(i.layer, i.p);
  var t = textureSample(atlas, samp, i.uv, layer);
  if (layer == ${L.Fire}) {
    let f = flame(i.uv, i.p);
    if (f.a < 0.5) { discard; }
    return vec4f(f.rgb, 1.0);
  }
  if (t.a < 0.5 || buried(layer, i.p, i.clip.xy)) { discard; }
  if (layer == ${L.Willow}) { t = vec4f(foliage(t.rgb, i.p), t.a); }
  else if (layer == ${L.Blades} || layer == ${L.Flowers} || layer == ${L.Reed}) { t = vec4f(grassSeason(t.rgb), t.a); }
  let n = normalize(i.n);
  // grass-like cards darken toward their roots
  let rooted = i.layer != ${L.Lily} && i.layer != ${L.LilyFlower} && i.layer != ${L.Willow};
  let ao = i.ao * select(1.0, mix(1.0, 0.55, i.uv.y * i.uv.y), rooted);
  return vec4f(fog(shade(t.rgb * i.tint, n, i.p, ao), i.p), 1.0);
}
`;

export const PROPS_SHADOW_WGSL = /* wgsl */ `
${SHADOW_BINDINGS}
${NOISE}
${HOUSE}
${VS_IN}
struct SOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) layer: i32, @location(2) pos: vec3f };
@vertex fn vs(v: VIn) -> SOut {
  var o: SOut;
  o.clip = select(vec4f(0.0, 0.0, 0.0, 1.0), g.shadow * vec4f(v.pos, 1.0), seasonal(v));
  o.pos = v.pos;
  o.uv = v.uv; o.layer = i32(v.ls.x + 0.5);
  return o;
}
@fragment fn fsCutout(i: SOut) {
  let layer = i32(i.layer);
  let buried = (layer == ${L.Blades} || layer == ${L.Flowers}) && g.season.w > 0.01
    && vnoise(i.pos.xz * 0.35) * 0.6 + vnoise(i.pos.xz * 2.7) * 0.4 < g.season.w * 1.3 - 0.08;
  let a = textureSample(atlas, samp, i.uv, i.layer).a;
  let hidden = layer == ${L.Fire} || ((layer == ${L.Blades} || layer == ${L.Flowers}) && onFootprint(i.pos));
  if (buried || hidden || a < 0.5) { discard; }
}
`;
