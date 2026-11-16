// WGSL shared by every scene shader: the global uniform block, texture bindings, lighting, sky, fog.

export const GLOBALS = /* wgsl */ `
struct G {
  vp: mat4x4f,
  cam: vec4f,      // xyz, time
  sunDir: vec4f,   // xyz towards the key light, sky brightness
  sunCol: vec4f,   // rgb, night 0..1
  ambSky: vec4f,   // rgb, exposure
  ambGnd: vec4f,   // rgb, fog density
  zenith: vec4f,   // rgb, camera underwater 0/1
  horizon: vec4f,  // rgb, colour levels
  glow: vec4f,     // rgb, pixel filter on 0/1
  shadow: mat4x4f,
  right: vec4f,    // xyz, tan half fov x
  up: vec4f,       // xyz, tan half fov y
  fwd: vec4f,      // xyz, near
  res: vec4f,      // low-res w, h, canvas w, h
};
@group(0) @binding(0) var<uniform> g: G;
`;

/** Scene group: globals, texture array + sampler, shadow map + comparison sampler. */
export const SCENE_BINDINGS = /* wgsl */ `
${GLOBALS}
@group(0) @binding(1) var atlas: texture_2d_array<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowSamp: sampler_comparison;
`;

/** Shadow-pass group: globals and the texture array (for cutout alpha). */
export const SHADOW_BINDINGS = /* wgsl */ `
${GLOBALS}
@group(0) @binding(1) var atlas: texture_2d_array<f32>;
@group(0) @binding(2) var samp: sampler;
`;

export const NOISE = /* wgsl */ `
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1, 0)), u.x), mix(hash12(i + vec2f(0, 1)), hash12(i + vec2f(1, 1)), u.x), u.y);
}
fn fbm2(p: vec2f) -> f32 {
  var s = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 4; i++) { s += a * vnoise(q); q = q * 2.03 + vec2f(1.7, 9.2); a *= 0.5; }
  return s / 0.9375;
}
const BAYER = array<f32, 16>(0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
/** Ordered-dither threshold in [0, 1) for a pixel. */
fn bayer(p: vec2f) -> f32 {
  let i = vec2u(p) % vec2u(4u);
  return (BAYER[i.y * 4u + i.x] + 0.5) / 16.0;
}
`;

export const LIGHTING = /* wgsl */ `
${NOISE}
/** Texture coordinates projected from world space on the dominant axis of the normal (side faces keep v vertical). */
fn projUV(p: vec3f, n: vec3f) -> vec2f {
  let a = abs(n);
  var uv = p.xz;
  if (a.x > a.y && a.x > a.z) { uv = vec2f(p.z, -p.y); } else if (a.z > a.y) { uv = vec2f(p.x, -p.y); }
  return uv * 0.5; // TEXEL_PER_M / TEX
}

/** Sun visibility: one hard-edged shadow-map tap (crisp, blocky shadows), normal-offset to avoid acne. */
fn sunShadow(p: vec3f, n: vec3f) -> f32 {
  let q = g.shadow * vec4f(p + n * 0.06, 1.0);
  let uv = vec2f(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
  let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)) && q.z < 1.0;
  let s = textureSampleCompareLevel(shadowMap, shadowSamp, uv, q.z - 0.0004);
  return select(1.0, s, inside);
}

/** Lambert sun (with shadow) + hemispheric ambient. */
fn shade(albedo: vec3f, n: vec3f, p: vec3f, ao: f32) -> vec3f {
  let ndl = max(dot(n, g.sunDir.xyz), 0.0);
  let sh = select(1.0, sunShadow(p, n), ndl > 0.0);
  let amb = mix(g.ambGnd.rgb, g.ambSky.rgb, n.y * 0.5 + 0.5);
  return albedo * (g.sunCol.rgb * ndl * sh + amb * ao);
}

/** Sky radiance in direction d (no clouds or stars: those are drawn by the post pass). */
fn skyColor(d: vec3f) -> vec3f {
  let h = clamp(d.y, 0.0, 1.0);
  var c = mix(g.horizon.rgb, g.zenith.rgb, pow(h, 0.45));
  let sd = max(dot(d, g.sunDir.xyz), 0.0);
  c += g.glow.rgb * (pow(sd, 6.0) * 0.45 + pow(sd, 60.0) * 0.5) * (1.0 - g.sunCol.a);
  c = select(c, g.horizon.rgb * 0.75, d.y < -0.02);
  return c * g.sunDir.w;
}

/** Distance haze toward the sky colour behind the point. */
fn fog(c: vec3f, p: vec3f) -> vec3f {
  let v = p - g.cam.xyz;
  let d = length(v);
  let f = 1.0 - exp(-d * g.ambGnd.w);
  return mix(c, skyColor(vec3f(v.x, max(v.y, 0.0), v.z) / d), f * (1.0 - g.zenith.w));
}
`;
