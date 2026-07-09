#version 300 es
precision highp float;
out vec4 frag;

uniform vec2  u_res;
uniform float u_time;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_level;
uniform float u_centroid;
uniform float u_beat;
uniform float u_beatPhase;   // bar-length beat-grid phase [0..1), downbeat at 0 (locked to BPM, soft-snapped to kick onsets)
uniform float u_snare;
uniform float u_hat;
uniform float u_shock;   // 0 at the instant of a beat, rises to 1 as the shockwave expands/fades
uniform float u_paletteShift;
uniform float u_style;
uniform float u_modeA;
uniform float u_modeB;
uniform float u_blend;
uniform float u_orbit;
uniform float u_zoom;
uniform float u_camYaw;
uniform float u_camPitch;
uniform float u_specOn;
uniform float u_reducedMotion;
uniform float u_feedback;
uniform float u_swirl;
uniform float u_glow;
uniform int u_rmSteps;
uniform vec3 u_pa, u_pb, u_pc, u_pd;   // custom cosine-palette vectors
uniform sampler2D u_prev;
uniform sampler2D u_spec;   // R8, 256x1 FFT magnitudes

mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }

vec3 palette(float t){
  vec3 a, b, c, d;
  if(u_style > 3.5){ a=u_pa; b=u_pb; c=u_pc; d=u_pd; }            // user-edited custom palette
  else if(u_style < 0.5){ a=vec3(0.5); b=vec3(0.5); c=vec3(1.0); d=vec3(0.00,0.33,0.67); }
  else if(u_style < 1.5){ a=vec3(0.6,0.4,0.5); b=vec3(0.5); c=vec3(1.0); d=vec3(0.30,0.20,0.55); }
  else if(u_style < 2.5){ a=vec3(0.4,0.5,0.6); b=vec3(0.5); c=vec3(1.0); d=vec3(0.55,0.55,0.85); }
  else { a=vec3(0.7,0.35,0.2); b=vec3(0.5); c=vec3(1.0); d=vec3(0.10,0.45,0.75); }
  return a + b*cos(6.28318*(c*t + d) + u_paletteShift);
}

float hash21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash21(i),       hash21(i+vec2(1,0)), u.x),
             mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v=0.0, a=0.5; mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<5;i++){ v+=a*noise(p); p=m*p; a*=0.5; }
  return v;
}

// ---------- scene 0: kaleidoscopic IFS fractal ----------
float map0(vec3 p){
  p.xy *= rot(u_time*0.10 + u_beat*1.5);
  p.xz *= rot(u_time*0.07 - u_beat*0.8);
  float s = 2.0 + u_bass*1.4 + u_beat*0.6;
  vec3 offset = vec3(1.0 - u_mid*0.35, 1.0 - u_treble*0.35, 1.0);
  float scale = 1.0;
  for(int i=0;i<11;i++){
    p = abs(p);
    if(p.x < p.y) p.xy = p.yx;
    if(p.x < p.z) p.xz = p.zx;
    if(p.y < p.z) p.yz = p.zy;
    p = p*s - offset*(s-1.0);
    p.xy *= rot(0.27 + u_mid*0.5);
    scale *= s;
  }
  return (length(p) - 0.6) / scale;
}
vec3 sceneFractal(vec2 uv){
  float camDist = (3.6 - u_bass*1.1 - u_beat*0.4) / u_zoom;
  vec3 ro;
  if(u_orbit > 0.5){ float cp=cos(u_camPitch); ro = camDist*vec3(sin(u_camYaw)*cp, sin(u_camPitch), cos(u_camYaw)*cp); }   // manual spherical orbit
  else { ro = vec3(0.0, 0.0, camDist); ro.xz *= rot(u_time*0.12 + u_centroid*1.2); ro.y = sin(u_time*0.18)*0.6; }          // auto camera
  vec3 fwd = normalize(-ro);
  vec3 rgt = normalize(cross(vec3(0.0,1.0,0.0), fwd));
  vec3 up  = cross(fwd, rgt);
  vec3 rd = normalize(uv.x*rgt + uv.y*up + 1.4*fwd);

  float t = 0.0, glow = 0.0, steps = 0.0;
  bool hit = false; vec3 p = vec3(0.0);
  for(int i=0;i<120;i++){
    if(i>=u_rmSteps) break;
    p = ro + rd*t;
    float d = map0(p);
    glow += exp(-d*7.0) * (0.012 + u_level*0.05);
    if(d < 0.0012){ hit = true; break; }
    t += d*0.9; steps += 1.0;
    if(t > 18.0) break;
  }
  vec3 col = vec3(0.0);
  if(hit){
    vec2 e = vec2(0.0009,0.0);
    vec3 n = normalize(vec3(map0(p+e.xyy)-map0(p-e.xyy), map0(p+e.yxy)-map0(p-e.yxy), map0(p+e.yyx)-map0(p-e.yyx)));
    vec3 lig = normalize(vec3(0.6,0.75,-0.45));
    float dif = clamp(dot(n,lig),0.0,1.0);
    float fre = pow(1.0-clamp(dot(n,-rd),0.0,1.0),3.0);
    float ao = 1.0 - steps/float(u_rmSteps);
    vec3 base = palette(u_centroid*0.6 + t*0.04 + u_time*0.04 + u_style*0.2);
    col = base*(0.18+0.9*dif)*ao + fre*palette(u_time*0.1+0.5)*(0.6+u_treble*1.4) + base*0.15*u_beat;
  } else {
    float r = length(uv);
    col = palette(u_centroid*0.5 + r*0.6 + u_time*0.03) * (0.04 + 0.10/(r+0.4)) * (0.4 + u_level);
    col += palette(u_time*0.05) * u_treble * 0.06;
  }
  col += glow * palette(u_time*0.08 + 0.3) * (1.0 + u_bass*2.0);
  return col;
}

// ---------- scene 1: epic hyperspace warp tunnel ----------
// centerline of a serpentine, coiling bore; the camera rides the inside of it
vec2 tunnelCenter(float s){
  float cf = 0.16 + u_mid*0.10;          // coiling rate (speeds up with mids)
  float ca = 0.40 + u_bass*0.30;         // coil amplitude (gentle bend so the receding walls stay visible)
  vec2 c = vec2(sin(s*cf), cos(s*cf)) * ca;
  float sCam = u_time*4.0;               // keep the camera on the centerline
  vec2 c0 = vec2(sin(sCam*cf), cos(sCam*cf)) * ca;
  return c - c0;
}
// signed distance to the ribbed tube wall (>0 inside the bore)
float tunnelD(vec3 p){
  float s = p.z + u_time*4.0;            // fly forward
  vec2 q = p.xy - tunnelCenter(s);
  float ang = atan(q.y, q.x);
  float baseR = 1.6 + 0.22*sin(s*2.0 + u_time) + u_bass*0.6;                       // breathing radius
  float flutes = 0.10*sin(ang*24.0 + s*4.0 + u_time*2.0) * (0.5 + u_bass);         // spiral flutes down the wall
  return (baseR + flutes) - length(q);
}
vec3 sceneTunnel(vec2 uv){
  vec3 ro = vec3(0.0);
  vec3 rd = normalize(vec3(uv, 1.3/u_zoom));
  if(u_orbit > 0.5){ rd.yz *= rot(u_camPitch*0.6); rd.xz *= rot(u_camYaw*0.6); }   // look around while flying

  float t = 0.0, glow = 0.0, shaft = 0.0; bool hit = false; vec3 p = vec3(0.0);
  float hitS = 0.0, hitAng = 0.0;
  for(int i=0;i<120;i++){
    if(i>=u_rmSteps) break;
    p = ro + rd*t;
    float s = p.z + u_time*4.0;
    float d = tunnelD(p);
    glow  += exp(-max(d,0.0)*3.0)*0.003 + exp(-abs(d)*9.0)*0.0015;
    vec2 q = p.xy - tunnelCenter(s);
    shaft += exp(-max(length(q),0.0)*2.4) * 0.003 * (0.15 + u_level*0.6); // faint light gathering near the axis
    if(d < 0.02){ hit = true; hitS = s; hitAng = atan(q.y, q.x); break; }
    t += max(d*0.9, 0.015);
    if(t > 40.0) break;
  }

  vec3 col = vec3(0.0);
  float calm = 1.0 - 0.8*u_reducedMotion;   // still the streaks + shockwave under reduced-motion
  if(hit){
    vec2 e = vec2(0.0028, 0.0);
    vec3 nout = normalize(vec3(                                       // wall normal from the SDF gradient
      tunnelD(p+e.xyy) - tunnelD(p-e.xyy),
      tunnelD(p+e.yxy) - tunnelD(p-e.yxy),
      tunnelD(p+e.yyx) - tunnelD(p-e.yyx) ));
    vec3 nin = -nout;                                                 // normal facing the camera (inside the bore)
    vec3 lig = normalize(vec3(0.1, 0.25, -0.7));
    float dif = clamp(dot(nin, lig), 0.0, 1.0);
    float fre = pow(1.0 - clamp(dot(nin, -rd), 0.0, 1.0), 5.0);       // fresnel rim (concentrated on silhouettes)
    vec3 base = palette(hitS*0.05 + u_time*0.06 + u_centroid);
    float ring = 0.5 + 0.5*sin(hitS*1.5 + u_time*2.0);
    vec3 w = base*(0.12 + ring*0.32);                                 // ribbed base wall
    w += palette(u_time*0.1) * u_treble * 0.25;
    w *= (0.40 + 0.80*dif);                                           // key light catches the ribs
    w += fre * palette(u_time*0.15 + 0.5) * (0.10 + u_bass*0.25 + u_treble*0.3); // fresnel rim glow
    // neon energy grooves: bright seams along the flutes + rings around the bore
    float neon = pow(0.5 + 0.5*sin(hitAng*24.0 + hitS*4.0 + u_time*2.0), 8.0);
    float seam = pow(0.5 + 0.5*sin(hitS*1.5), 6.0);
    w += neon * palette(u_time*0.2 + 0.3) * (0.5 + u_treble*1.1 + u_beat*0.9);
    w += seam * palette(u_centroid + 0.2) * (0.18 + u_beat*0.7);
    col = w * exp(-t*0.12);                                           // fade EVERYTHING into depth so the bore recedes to black
  }

  // light-speed streaks: bright radial spokes rushing past (feedback trails smear them outward into warp lines)
  float viewAng = atan(rd.y, rd.x);
  float streak = pow(0.5 + 0.5*sin(viewAng*30.0 + u_time*6.0), 12.0);
  col += streak * palette(u_time*0.3) * (0.05 + u_level*0.25 + u_bass*0.2) * (0.3 + 0.7*exp(-length(uv))) * calm;

  // beat shockwave: a ring blasting outward from the camera and fading
  float rr = length(uv);
  float shockR = u_shock * 1.35;
  float sw = smoothstep(0.05, 0.0, abs(rr - shockR));
  col += sw * palette(u_time*0.2 + 0.5) * (1.0 - u_shock) * 1.3 * calm;

  // volumetric god-ray shafts pouring down the bore
  col += shaft * palette(u_centroid + u_time*0.05) * 0.15 * (1.0 + u_beat*0.5);

  col += glow * palette(u_time*0.2 + 0.4) * (0.7 + u_bass*0.5);
  return col;
}

// ---------- scene 2: liquid plasma ----------
vec3 scenePlasma(vec2 uv){
  vec2 st = uv * (1.6 + u_bass*0.6);
  st *= rot(u_time*0.05);
  vec2 q = vec2(fbm(st + 0.12*u_time), fbm(st + vec2(5.2,1.3) + 0.10*u_time));
  vec2 r = vec2(fbm(st + 3.5*q + vec2(1.7,9.2) + 0.15*u_time + u_mid),
                fbm(st + 3.5*q + vec2(8.3,2.8) + 0.13*u_time + u_treble));
  float f = fbm(st + 3.5*r);
  vec3 c = palette(f*0.9 + u_centroid + u_bass*0.3 + u_style*0.15);
  c *= 0.5 + 0.9*f;
  c += (q.x*q.x) * 0.25 * palette(u_time*0.2);
  c += u_beat * 0.25 * palette(f + u_time*0.3);
  return c;
}

// ---------- scene 3: spiral vortex ----------
vec3 sceneVortex(vec2 uv){
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  a += r*(3.0 + u_bass*3.0) - u_time*0.6 + u_beat*2.0;
  vec2 suv = vec2(cos(a), sin(a)) * r;
  float n = fbm(suv*4.0 + u_time*0.25 + u_centroid*5.0);
  float beams = 0.5 + 0.5*sin(a*8.0 + u_time*1.5 + u_beat*3.0);
  vec3 c = palette(n + u_centroid + u_style*0.2) * (n*1.3 + 0.2);
  c *= smoothstep(1.25, 0.05, r);
  c += beams * 0.18 * palette(u_time*0.1);
  c += u_treble * 0.4 * palette(r*2.0 + u_time*0.2);
  return c * (0.7 + u_level*0.8);
}

// ---------- scene 4: audio-reactive scrolling frequency-bar terrain (raymarched heightmap) ----------
float terrH(vec2 p){ return fbm(p*0.45)*0.35 + texture(u_spec, vec2(fract(p.x*0.08), 0.5)).r*0.9 + u_bass*0.35; }
vec3 sceneTerrain(vec2 uv){
  vec3 ro = vec3(0.0, 1.3, u_time*2.0);                 // fly forward over the terrain
  vec3 rd = normalize(vec3(uv*1.1, 1.0) + vec3(0.0, -0.35, 0.0));   // look down at it
  float t=0.0; bool hit=false; vec3 p=vec3(0.0);
  for(int i=0;i<120;i++){
    if(i>=u_rmSteps) break;
    p = ro + rd*t;
    float h = terrH(p.xz);
    if(p.y < h){ hit=true; break; }
    t += max(0.04, (p.y - h)*0.8);
    if(t>24.0) break;
  }
  vec3 col = palette(u_centroid + u_time*0.04)*0.04;   // dark sky
  if(hit){
    vec2 e=vec2(0.06,0.0);
    vec3 n = normalize(vec3(terrH(p.xz-e.xy)-terrH(p.xz+e.xy), 2.0*e.x, terrH(p.xz-e.yx)-terrH(p.xz+e.yx)));
    float dif = clamp(dot(n, normalize(vec3(0.3,0.8,-0.4))),0.0,1.0);
    float spec = texture(u_spec, vec2(fract(p.x*0.08), 0.5)).r;
    vec3 base = palette(terrH(p.xz)*1.5 + u_centroid + u_time*0.06);
    col = base*(0.2+0.9*dif) + palette(u_time*0.15+0.3)*spec*0.5 + palette(u_time*0.1)*u_beat*0.3;
    col *= exp(-t*0.07);   // distance fog
  }
  return col;
}

// ---------- scene 5: user-pasted shader (body replaced at runtime; compile errors reported in the UI) ----------
vec3 sceneUser(vec2 uv){
  // USER_SHADER_BEGIN
  return palette(u_time*0.1 + u_bass) * (0.3 + u_bass);   // default body — paste your own GLSL (uv, u_bass, u_mid, u_treble, u_beat, u_snare, u_hat, palette(), fbm(), u_time)
  // USER_SHADER_END
}

vec3 sceneById(float id, vec2 uv){
  if(id < 0.5)      return sceneFractal(uv);
  else if(id < 1.5) return sceneTunnel(uv);
  else if(id < 2.5) return scenePlasma(uv);
  else if(id < 3.5) return sceneVortex(uv);
  else if(id < 4.5) return sceneTerrain(uv);
  else              return sceneUser(uv);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res) / u_res.y;

  // crossfade between two scenes; only the second is evaluated during a transition
  vec3 colA = sceneById(u_modeA, uv);
  vec3 col  = (u_blend <= 0.001) ? colA : mix(colA, sceneById(u_modeB, uv), u_blend);

  // snare / hat onset accents (spectral-flux onsets) for richer reactivity
  col += palette(u_time*0.15 + 0.2) * u_snare * 0.10;
  col += palette(u_time*0.35 + 0.6) * u_hat   * 0.06;

  // beat-phase downbeat accent: a bar-length phase that anticipates (phase→1) and pulses on (phase→0)
  // the downbeat, so the field breathes with the grid even between detected onsets.
  float _db = 1.0 - smoothstep(0.0, 0.14, min(u_beatPhase, 1.0 - u_beatPhase));
  col += palette(u_time*0.12 + 0.7) * _db * (0.04 + u_bass*0.12 + u_beat*0.08) * (1.0 - 0.8*u_reducedMotion);

  // circular FFT spectrum ring overlay
  if(u_specOn > 0.5){
    float r = length(uv);
    float ang = atan(uv.y, uv.x);
    float af = ang/6.28318 + 0.5;
    float v = texture(u_spec, vec2(af, 0.5)).r;
    float inner = 0.62;
    float barLen = 0.40*v + 0.015;
    float d = r - inner;
    float edge = smoothstep(0.0,0.012,d) * (1.0 - smoothstep(barLen-0.04, barLen, d));
    col += palette(af*2.0 + u_time*0.1) * edge * (0.7 + v*2.2);
    col += palette(af + u_time*0.05) * smoothstep(0.007,0.0,abs(d)) * 0.7; // base ring
  }

  // feedback trails (phosphor persistence + swirl); damped under reduced-motion
  float rm = u_reducedMotion;
  vec2 c = gl_FragCoord.xy / u_res - 0.5;
  float zoom = 1.0 - (0.0035 + u_bass*0.012);
  float a = (u_swirl + u_beat*0.02 + u_mid*0.01) * (1.0 - 0.85*rm);
  c *= rot(a) * zoom;
  float decay = mix(u_feedback - u_beat*0.05, 0.15, rm);
  vec3 trail = texture(u_prev, c + 0.5).rgb * decay;
  col = max(col, trail);
  col += trail * u_glow * (1.0 - rm);

  frag = vec4(col, 1.0);
}
