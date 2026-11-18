import { PRECIP_BOX } from '../world/weather';
import { LIGHTING, SCENE_BINDINGS } from './common';

/**
 * Rain and snow: instanced quads generated in the vertex shader (no buffers). Each particle has a fixed random spot
 * in a box around the camera; the accumulated drift and fall move every particle and the box wraps them, so the
 * shower follows the camera without ever being rebuilt. Rain is a thin streak along its velocity, snow a small flake
 * facing the camera.
 */
export const PRECIP_WGSL = /* wgsl */ `
${SCENE_BINDINGS}
${LIGHTING}
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) fade: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let B = ${PRECIP_BOX.toFixed(1)};
  let fi = f32(ii);
  let h = vec3f(hash12(vec2f(fi, 1.7)), hash12(vec2f(fi, 9.3)), hash12(vec2f(fi, 4.1)));
  let snow = g.weather.y;
  var p = h * B + vec3f(g.drift.x, -g.drift.z, g.drift.y);
  p = g.cam.xyz + (fract((p - g.cam.xyz) / B) - 0.5) * B;
  // flakes flutter as they fall
  let t = g.cam.w;
  p += vec3f(sin(t * 1.3 + fi), 0.0, cos(t * 1.1 + fi * 1.7)) * 0.25 * snow;

  var corners = array<vec2f, 6>(vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let corner = corners[vi];
  let toCam = normalize(g.cam.xyz - p);
  var pos: vec3f;
  if (snow > 0.5) {
    let s = 0.035 + 0.02 * h.x;
    pos = p + (g.right.xyz * corner.x + g.up.xyz * (corner.y * 2.0 - 1.0)) * s;
  } else {
    // a streak along the falling velocity (slanted by the wind), turned to face the camera
    let w = g.weather.w * 2.0;
    let vel = normalize(vec3f(g.wind.x * w, -7.0, g.wind.y * w));
    let side = normalize(cross(vel, toCam));
    pos = p + side * corner.x * 0.012 - vel * corner.y * (0.35 + 0.25 * h.y);
  }
  var o: VOut;
  o.clip = g.vp * vec4f(pos, 1.0);
  o.uv = corner;
  let d = distance(p, g.cam.xyz);
  o.fade = (1.0 - smoothstep(B * 0.3, B * 0.5, d)) * smoothstep(1.2, 3.0, d);
  return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let snow = g.weather.y;
  let light = g.sunCol.rgb * max(g.sunDir.y, 0.0) * 0.5 + g.ambSky.rgb * 1.6;
  let rain = vec4f(vec3f(0.55, 0.6, 0.7) * light, 0.32);
  let flake = vec4f(vec3f(0.9, 0.93, 0.97) * light, 0.9);
  let c = select(rain, flake, snow > 0.5);
  return vec4f(c.rgb, c.a * i.fade);
}
`;
