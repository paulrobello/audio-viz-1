#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec2 u_dir;
void main(){
  vec2 uv = gl_FragCoord.xy/u_res;
  float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);   // 9-tap Gaussian weights
  vec3 sum = texture(u_tex, uv).rgb * w[0];
  for(int i=1;i<5;i++){
    vec2 off = u_dir * float(i);
    sum += texture(u_tex, uv+off).rgb * w[i];
    sum += texture(u_tex, uv-off).rgb * w[i];
  }
  frag = vec4(sum, 1.0);
}
