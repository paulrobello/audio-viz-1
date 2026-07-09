#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D u_tex;
uniform sampler2D u_bloom;
uniform vec2 u_res;
uniform float u_bloomAmt;
uniform float u_vig, u_ca, u_grain, u_beat, u_time;   // optional post-FX (vignette / chromatic aberration / film grain), beat-reactive
vec3 tonemap(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
float hash21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
void main(){
  vec2 uv = gl_FragCoord.xy/u_res;
  vec2 d = uv-0.5; float r = length(d);
  // chromatic aberration: shift R/B outward, scaled by radius and the beat (applied before tonemap)
  float ca = u_ca*(0.4+0.6*u_beat)*r*0.06;
  vec2 dir = d/max(r,1e-4);
  vec3 c = vec3(texture(u_tex, uv+dir*ca).r, texture(u_tex, uv).g, texture(u_tex, uv-dir*ca).b);
  c += texture(u_bloom, uv).rgb * u_bloomAmt;   // add blurred bright-pass before tonemap
  c = tonemap(c*1.15);
  c = pow(c, vec3(0.4545));
  c *= mix(0.78, 1.0, smoothstep(1.15, 0.35, r));   // existing subtle base vignette
  c *= mix(1.0, 0.2, u_vig*(0.7+0.3*u_beat)*smoothstep(0.25, 0.85, r));   // optional beat-reactive vignette
  c += (hash21(floor(gl_FragCoord.xy) + u_time*60.0)-0.5)*u_grain*0.15;   // animated film grain
  frag = vec4(c, 1.0);
}
