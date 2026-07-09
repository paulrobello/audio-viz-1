// Vite + vite-plugin-glsl imports GLSL files as their source string at build time.
// These ambient declarations let tsc resolve the .vert / .frag imports under checkJs.
declare module '*.vert' {
  const src: string;
  export default src;
}
declare module '*.frag' {
  const src: string;
  export default src;
}
