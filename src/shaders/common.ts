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
  season: vec4f,   // blend weights: spring, summer, fall, winter
  weather: vec4f,  // precipitation, snow share, fog, wind (0..1)
  drift: vec4f,    // precipitation particles: drift x, z, fall (m, wrapped), -
  wind: vec4f,     // wind direction x, z; cloud scroll x, z
  house0: vec4f,   // centre x, z, cos, sin of its rotation
  house1: vec4f,   // half size x, z, floor height, eave height
  house2: vec4f,   // ridge height, roof overhang, on 0/1, -
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

/** The cabin: tests in its own space (x along the ridge, z toward the door). Needs only the globals. */
export const HOUSE = /* wgsl */ `
fn houseLocal(p: vec3f) -> vec3f {
  let d = p.xz - g.house0.xy;
  return vec3f(d.x * g.house0.z + d.y * g.house0.w, p.y, -d.x * g.house0.w + d.y * g.house0.z);
}
/** Under the roof (including its overhang), above the foundations: rain and snow can't reach here. */
fn underRoof(p: vec3f) -> bool {
  if (g.house2.z < 0.5) { return false; }
  let q = houseLocal(p);
  let ov = g.house2.y;
  let roof = g.house2.x - (g.house2.x - g.house1.w) * abs(q.z) / g.house1.y;
  return abs(q.x) < g.house1.x + ov && abs(q.z) < g.house1.y + ov && p.y < roof && p.y > g.house1.z - 1.0;
}
/** Inside the walls (floor to ridge). */
fn indoors(p: vec3f) -> bool {
  if (g.house2.z < 0.5) { return false; }
  let q = houseLocal(p);
  return abs(q.x) < g.house1.x - 0.05 && abs(q.z) < g.house1.y - 0.05 && p.y > g.house1.z - 0.2 && p.y < g.house2.x;
}
/** Within the house footprint, at any height (grass under the floor is hidden). */
fn onFootprint(p: vec3f) -> bool {
  if (g.house2.z < 0.5) { return false; }
  let q = houseLocal(p);
  return abs(q.x) < g.house1.x + 0.15 && abs(q.z) < g.house1.y + 0.15;
}
/** The fire, in world space. */
fn firePos() -> vec3f {
  let l = vec2f(0.0, -g.house1.y + 0.6);
  return vec3f(g.house0.x + l.x * g.house0.z - l.y * g.house0.w, g.house1.z + 0.35, g.house0.y + l.x * g.house0.w + l.y * g.house0.z);
}
/** Flickering firelight inside the cabin: warm, falling off with distance, no shadows. */
fn fireLight(n: vec3f, p: vec3f) -> vec3f {
  if (!indoors(p)) { return vec3f(0.0); }
  let t = g.cam.w;
  let flick = 0.85 + 0.1 * sin(t * 11.0) + 0.07 * sin(t * 17.3 + 1.0) + 0.05 * sin(t * 5.1);
  let v = firePos() - p;
  let d2 = dot(v, v);
  let l = v * inverseSqrt(max(d2, 1e-4));
  return vec3f(1.0, 0.5, 0.2) * 3.0 * flick * (max(dot(n, l), 0.0) * 0.8 + 0.2) / (1.0 + d2 * 0.9);
}
`;

/** Seasonal looks, driven by g.season = (spring, summer, fall, winter) weights. Needs NOISE. */
export const SEASON = /* wgsl */ `
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.3, 0.59, 0.11)); }

/** Snow lies here: patches spread as winter deepens, only on fairly flat, upward-facing surfaces. */
fn snowAt(p: vec3f, n: vec3f, px: vec2f) -> bool {
  let w = g.season.w;
  if (w < 0.01 || n.y < 0.5 || underRoof(p + vec3f(0.0, 0.05, 0.0))) { return false; }
  let k = vnoise(p.xz * 0.35) * 0.6 + vnoise(p.xz * 2.7) * 0.4 + (bayer(px) - 0.5) * 0.15;
  return k < w * 1.3 * smoothstep(0.5, 0.8, n.y) - 0.08;
}
fn snowAlbedo(p: vec3f) -> vec3f {
  return vec3f(0.7, 0.74, 0.8) * (0.92 + 0.08 * step(0.55, vnoise(p.xz * 9.0)));
}

/** Broadleaf foliage: fresh light green in spring; one of yellow, orange, red or brown per tree in fall. */
fn foliage(c: vec3f, p: vec3f) -> vec3f {
  let s = g.season;
  let l = lum(c);
  let spring = c * vec3f(1.3, 1.4, 0.7) + vec3f(0.015, 0.025, 0.0);
  let h = vnoise(p.xz * 0.28 + vec2f(13.0, 7.0)) * 0.8 + hash12(floor(p.xz * 0.7)) * 0.2;
  var pal = vec3f(0.5, 0.26, 0.09);                        // brown
  if (h < 0.35) { pal = vec3f(1.0, 0.78, 0.12); }          // yellow
  else if (h < 0.5) { pal = vec3f(1.0, 0.42, 0.06); }      // orange
  else if (h < 0.65) { pal = vec3f(0.85, 0.12, 0.05); }    // red
  let fall = pal * l * 2.6;
  let winter = mix(c, vec3f(l) * vec3f(0.95, 0.9, 0.7), 0.55) * 0.8;
  return c * s.y + spring * s.x + fall * s.z + winter * s.w;
}

/** Grass: lighter in spring, straw-yellow in fall, faded in winter. Non-green texels (petals, cattails) are kept. */
fn grassSeason(c: vec3f) -> vec3f {
  if (c.g < c.r || c.g < c.b) { return c; }
  let s = g.season;
  let l = lum(c);
  let spring = c * vec3f(1.2, 1.3, 0.75);
  let fall = mix(c, vec3f(l) * vec3f(2.0, 1.55, 0.55), 0.75);
  let winter = mix(c, vec3f(l) * vec3f(1.2, 1.1, 0.85), 0.6) * 0.85;
  return c * s.y + spring * s.x + fall * s.z + winter * s.w;
}
`;

export const LIGHTING = /* wgsl */ `
${NOISE}
${HOUSE}
${SEASON}
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
  let amb = mix(g.ambGnd.rgb, g.ambSky.rgb, n.y * 0.5 + 0.5) * select(1.0, 0.3, indoors(p));
  return albedo * (g.sunCol.rgb * ndl * sh + amb * ao + fireLight(n, p));
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
  // fog stays outdoors: a surface inside the cabin only gets a trace of it
  let f = (1.0 - exp(-d * g.ambGnd.w)) * select(1.0, 0.1, indoors(p));
  return mix(c, skyColor(vec3f(v.x, max(v.y, 0.0), v.z) / d), f * (1.0 - g.zenith.w));
}
`;
