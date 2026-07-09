#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_thresh;
void main(){
  vec2 uv = gl_FragCoord.xy/u_res;
  vec3 c = texture(u_tex, uv).rgb;
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  float k = smoothstep(u_thresh, u_thresh+0.45, l);   // soft knee bright-pass
  frag = vec4(c*k, 1.0);
}
