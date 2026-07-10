#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D u_tex;
uniform sampler2D u_bloom;
uniform vec2 u_res;
uniform float u_bloomAmt;
uniform float u_vig, u_ca, u_grain, u_beat, u_time;   // optional post-FX (vignette / chromatic aberration / film grain), beat-reactive
vec3 tonemap(vec3 x){ return (x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14); }   // ACES-approx curve (unclamped; hue handled in main)
float hash21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
void main(){
  vec2 uv = gl_FragCoord.xy/u_res;
  vec2 d = uv-0.5; float r = length(d);
  // chromatic aberration: shift R/B outward, scaled by radius and the beat (applied before tonemap)
  float ca = u_ca*(0.4+0.6*u_beat)*r*0.06;
  vec2 dir = d/max(r,1e-4);
  vec3 c = vec3(texture(u_tex, uv+dir*ca).r, texture(u_tex, uv).g, texture(u_tex, uv-dir*ca).b);
  c += texture(u_bloom, uv).rgb * u_bloomAmt;   // add blurred bright-pass before tonemap
  c *= 0.85;                                     // exposure: pull the whole image down so bright peaks don't slam to white
  // hue-preserving tonemap: the per-channel ACES curve washes saturated highlights toward white,
  // so blend it with a luminance-scaled version that keeps the colour's hue at high brightness.
  vec3 perCh = tonemap(c);
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  vec3 hue = c * (tonemap(vec3(l)).x / max(l, 1e-4));
  c = clamp(mix(perCh, hue, 0.65), 0.0, 1.0);   // favour hue-preserving highlights, keep a per-channel safety net
  c = pow(c, vec3(0.4545));
  c *= mix(0.78, 1.0, smoothstep(1.15, 0.35, r));   // existing subtle base vignette
  c *= mix(1.0, 0.2, u_vig*(0.7+0.3*u_beat)*smoothstep(0.25, 0.85, r));   // optional beat-reactive vignette
  c += (hash21(floor(gl_FragCoord.xy) + u_time*60.0)-0.5)*u_grain*0.15;   // animated film grain
  frag = vec4(c, 1.0);
}
