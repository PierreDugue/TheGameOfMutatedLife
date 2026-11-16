import { LIGHTING, SCENE_BINDINGS } from './common';

/**
 * Close-up creatures: every body and part is an instanced primitive (sphere, tapered tube, flat fan) with its own
 * affine transform, built on the CPU from the body plan and the organism's pose each frame.
 */
export const CREATURES_WGSL = /* wgsl */ `
${SCENE_BINDINGS}
${LIGHTING}
struct VIn { @location(0) pos: vec3f, @location(1) nrm: vec3f };
struct Inst {
  @location(2) m0: vec4f, @location(3) m1: vec4f, @location(4) m2: vec4f,
  @location(5) col: vec4f,  // rgb, emissive
  @location(6) ex: vec4f,   // taper (tubes), depth below the surface, pattern, 0
};
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) p: vec3f,
  @location(1) n: vec3f,
  @location(2) @interpolate(flat) col: vec4f,
  @location(3) @interpolate(flat) ex: vec4f,
  @location(4) lp: vec3f,
};

@vertex fn vs(v: VIn, i: Inst) -> VOut {
  var o: VOut;
  var lp = v.pos;
  lp = vec3f(lp.xy * mix(1.0, i.ex.x, clamp(lp.z, 0.0, 1.0)), lp.z);
  let p = vec3f(dot(i.m0, vec4f(lp, 1.0)), dot(i.m1, vec4f(lp, 1.0)), dot(i.m2, vec4f(lp, 1.0)));
  let n = vec3f(dot(i.m0.xyz, v.nrm), dot(i.m1.xyz, v.nrm), dot(i.m2.xyz, v.nrm));
  o.clip = g.vp * vec4f(p, 1.0);
  o.p = p; o.n = n; o.col = i.col; o.ex = i.ex; o.lp = v.pos;
  return o;
}

@fragment fn fs(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(i.n);
  n = select(-n, n, front);
  var albedo = i.col.rgb;
  // membrane speckles in body space, pixel-stepped
  let sp = hash12(floor(i.lp.xy * 5.0 + i.lp.z * 3.0) + i.ex.z * 17.0);
  albedo *= select(1.0, 0.82, sp > 0.7 && i.ex.z > 0.0);
  let ndl = max(dot(n, g.sunDir.xyz), 0.0);
  let lit = floor((ndl * 0.85 + 0.15) * 4.0) / 4.0; // banded light, old-game style
  let k = exp(-i.ex.y * vec3f(0.9, 0.45, 0.55));
  let c = albedo * ((g.sunCol.rgb * lit + g.ambSky.rgb) * k + i.col.a);
  return vec4f(fog(c, i.p), 1.0);
}
`;
