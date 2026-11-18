import { GLOBALS, NOISE } from './common';

/**
 * Final pass: upscales the low-resolution HDR image with nearest filtering (big square pixels), draws the sky
 * behind the scene (clouds, sun / moon disc, stars), underwater fog, exposure + ACES, and quantises each channel
 * to a few levels with an ordered dither in low-res pixel space.
 */
export const POST_WGSL = /* wgsl */ `
${GLOBALS}
${NOISE}
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn skyColor(d: vec3f) -> vec3f {
  let h = clamp(d.y, 0.0, 1.0);
  var c = mix(g.horizon.rgb, g.zenith.rgb, pow(h, 0.45));
  let sd = max(dot(d, g.sunDir.xyz), 0.0);
  c += g.glow.rgb * (pow(sd, 6.0) * 0.45 + pow(sd, 60.0) * 0.5) * (1.0 - g.sunCol.a);
  c = select(c, g.horizon.rgb * 0.75, d.y < -0.02);
  return c * g.sunDir.w;
}

fn sky(d: vec3f, px: vec2f) -> vec3f {
  var c = skyColor(d);
  let night = g.sunCol.a;
  // disc: the sun by day, a pale moon by night
  let sd = dot(d, g.sunDir.xyz);
  let disc = step(0.9993, sd);
  c = mix(c, mix(vec3f(40.0, 34.0, 26.0), vec3f(2.2, 2.4, 2.8), night), disc);
  // stars
  let sp = floor(d * 260.0);
  let st = step(0.9975, hash12(sp.xy + sp.z * 17.0)) * night * step(0.05, d.y);
  c += vec3f(1.5) * st * (0.6 + 0.4 * sin(g.cam.w * 3.0 + sp.x));
  // blocky clouds on a plane above the valley, three shades
  if (d.y > 0.02) {
    let uv = d.xz / (d.y + 0.12) * 1.2 + vec2f(g.cam.w * 0.01, 0.0);
    let q = floor(uv * 24.0) / 24.0;
    // cover by season: more in spring, none in summer
    let cover = dot(g.season, vec4f(1.35, 0.0, 1.0, 1.0));
    let n = fbm2(q * 1.3) - 0.48 + 0.12 * sin(g.cam.w * 0.02) + (cover - 1.0) * 0.14;
    let k = floor(clamp(n * 4.0, 0.0, 1.0) * 3.0) / 3.0 * step(0.02, cover) * min(cover * 1.5, 1.0);
    let lit = mix(g.horizon.rgb * 1.2 + g.glow.rgb * 0.3, vec3f(0.2, 0.22, 0.35), night);
    c = mix(c, lit * g.sunDir.w * mix(0.8, 1.15, k), min(k * 1.4, 0.9) * smoothstep(0.02, 0.2, d.y));
  }
  return c;
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let lowRes = g.res.xy;
  let px = floor(fc.xy * lowRes / g.res.zw);
  let ip = vec2i(min(px, lowRes - 1.0));
  var c = textureLoad(hdr, ip, 0).rgb;
  let dz = textureLoad(depth, ip, 0);
  let ndc = (px + 0.5) / lowRes * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let ray = normalize(g.fwd.xyz + g.right.xyz * ndc.x * g.right.w + g.up.xyz * ndc.y * g.up.w);
  if (dz <= 0.0) { c = sky(ray, px); }
  if (g.zenith.w > 0.5) {
    // underwater: murky green-blue fog by distance
    let d = select(g.fwd.w / dz, 60.0, dz <= 0.0);
    let deep = vec3f(0.03, 0.13, 0.12) * (g.sunCol.rgb * 0.35 + g.ambSky.rgb);
    c = mix(c * vec3f(0.55, 0.85, 0.8), deep, 1.0 - exp(-d * 0.22));
  }
  c = aces(c * g.ambSky.w * 1.6);
  c = pow(c, vec3f(1.0 / 2.2));
  if (g.glow.w > 0.5) {
    let lv = g.horizon.w - 1.0;
    c = floor(c * lv + bayer(px)) / lv;
  }
  return vec4f(c, 1.0);
}
`;
