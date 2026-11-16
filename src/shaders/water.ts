import { L } from '../world/textures';
import { LIGHTING, SCENE_BINDINGS } from './common';

export const WATER_WGSL = /* wgsl */ `
${SCENE_BINDINGS}
${LIGHTING}
@group(1) @binding(0) var sceneDepth: texture_depth_2d;

struct VIn { @location(0) pos: vec3f, @location(1) fd: vec3f };
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) p: vec3f,
  @location(1) flow: vec2f,
};

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.clip = g.vp * vec4f(v.pos, 1.0);
  o.p = v.pos; o.flow = v.fd.xy;
  return o;
}

fn ripples(p: vec2f, flow: vec2f, t: f32) -> f32 {
  // flow-map trick: two phases scrolling along the flow, cross-faded so the texture never stretches
  let ph0 = fract(t * 0.2); let ph1 = fract(t * 0.2 + 0.5);
  let base = p * 0.25 + vec2f(t * 0.01, t * 0.007);
  let a = textureSampleLevel(atlas, samp, base - flow * ph0 * 1.5, ${L.Water}, 0.0).r;
  let b = textureSampleLevel(atlas, samp, base * 1.37 + 0.31 - flow * ph1 * 1.5, ${L.Water}, 0.0).r;
  let w = abs(1.0 - 2.0 * ph0);
  return mix(a, b, w);
}

@fragment fn fs(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let v = g.cam.xyz - i.p;
  let dist = length(v);
  let vd = v / dist;
  // water thickness along the view ray, from the opaque scene's depth (reverse-Z: depth = near / distance)
  let sd = textureLoad(sceneDepth, vec2i(i.clip.xy), 0);
  let sceneDist = select(g.fwd.w / sd, 1e4, sd <= 0.0);
  let thick = max(sceneDist - g.fwd.w / i.clip.z, 0.0);

  let rip = ripples(i.p.xz, i.flow, g.cam.w);
  let n = normalize(vec3f((rip - 0.3) * 0.08, 1.0, (rip - 0.3) * 0.05));
  let sh = sunShadow(i.p, vec3f(0.0, 1.0, 0.0));
  let lit = g.sunCol.rgb * max(g.sunDir.y, 0.0) * mix(0.35, 1.0, sh) + g.ambSky.rgb;

  if (!front || g.zenith.w > 0.5) {
    // seen from below: bright, slightly see-through ceiling
    let c = vec3f(0.12, 0.3, 0.28) * lit * 0.8 + rip * 0.05 * lit;
    return vec4f(c, 0.7);
  }

  let body = mix(vec3f(0.09, 0.28, 0.22), vec3f(0.012, 0.06, 0.05), 1.0 - exp(-thick * 0.9)) * lit;
  let fres = 0.03 + 0.97 * pow(1.0 - max(vd.y, 0.0), 5.0);
  let refl = skyColor(reflect(-vd, n));
  var c = mix(body, refl, fres * 0.8);
  // highlight lines from the ripple texture, sun glints
  c += rip * 0.12 * lit;
  let spec = pow(max(dot(reflect(-vd, n), g.sunDir.xyz), 0.0), 300.0) * sh;
  c += g.sunCol.rgb * step(0.5, spec + rip * 0.2) * spec * 2.0;
  let a = clamp(1.0 - exp(-thick * 1.6), 0.0, 0.93);
  let alpha = clamp(max(a, fres * 0.9) + rip * 0.15, 0.0, 0.97);
  // foam where the water meets the shore
  let foam = step(thick, 0.1 + rip * 0.12) * step(0.02, thick);
  c = mix(c, lit * 0.9, foam * 0.6);
  return vec4f(fog(c, i.p), max(alpha, foam * 0.6));
}
`;
