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
// Vite imports CSS as side-effect modules (import './styles.css'). TS 5.5+ (TS2882) errors on
// side-effect imports without a declaration, so allow it as an empty module.
declare module '*.css';
