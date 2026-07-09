// Minimal, dependency-free ID3v2 (2.3 / 2.4) tag reader. Extracts only what the viz
// surfaces in the HUD: title (TIT2), artist (TPE1), album (TALB), and attached
// picture (APIC). Synchsafe sizes for v2.4, plain big-endian sizes for v2.3. Returns
// null when no 'ID3' header is present or no recognized frames were found.
//
// Intentionally narrow: it does not parse v2.2 (3-char frame IDs), footer, extended
// header, or unsynchronisation — covering the common MP3s produced by modern taggers.

/** @param {Uint8Array} u @param {number} off @param {number} len */
function readText(u, off, len) {
  if (len < 1) return '';
  const enc = u[off];
  const bytes = u.subarray(off + 1, off + len);
  let s;
  if (enc === 1) s = new TextDecoder('utf-16').decode(bytes);        // UTF-16 with BOM
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(bytes); // UTF-16BE (rare)
  else if (enc === 3) s = new TextDecoder('utf-8').decode(bytes);    // UTF-8
  else s = new TextDecoder('latin1').decode(bytes);                  // 0 = ISO-8859-1
  return s.replace(/\0+$/, '').trim();
}

/** @param {Uint8Array} u @param {number} off @param {number} len */
function readApic(u, off, len) {
  const enc = u[off];
  let p = off + 1;
  let mimeEnd = p; while (mimeEnd < off + len && u[mimeEnd] !== 0) mimeEnd++;   // MIME: latin1, null-terminated
  const mime = new TextDecoder('latin1').decode(u.subarray(p, mimeEnd));
  p = mimeEnd + 1;
  if (p >= off + len) return null;
  p += 1;                                                                       // picture type byte
  if (enc === 1 || enc === 2) { while (p + 1 < off + len && !(u[p] === 0 && u[p + 1] === 0)) p++; p += 2; }   // UTF-16 description
  else { while (p < off + len && u[p] !== 0) p++; p += 1; }                     // latin1/utf-8 description
  const data = u.subarray(p, off + len);
  if (!data.length) return null;
  return { mime: mime || 'image/jpeg', data };
}

/**
 * @param {ArrayBuffer} buf - the raw file bytes (ID3 sits at offset 0)
 * @returns {{ title: string|null, artist: string|null, album: string|null, picture: { mime: string, data: Uint8Array } | null } | null}
 */
export function parseId3(buf) {
  const u = new Uint8Array(buf);
  if (u.length < 10 || u[0] !== 0x49 || u[1] !== 0x44 || u[2] !== 0x33) return null;   // "ID3"
  const major = u[3];
  const size = (u[6] & 0x7f) * 0x200000 + (u[7] & 0x7f) * 0x4000 + (u[8] & 0x7f) * 0x80 + (u[9] & 0x7f);   // tag size (synchsafe)
  let p = 10;
  const end = Math.min(u.length, 10 + size);
  const out = { title: null, artist: null, album: null, picture: null };
  while (p + 10 <= end) {
    const id = String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
    if (u[p] === 0) break;                                                       // padding / end of frames
    let fsize;
    if (major === 4) fsize = (u[p + 4] & 0x7f) * 0x200000 + (u[p + 5] & 0x7f) * 0x4000 + (u[p + 6] & 0x7f) * 0x80 + (u[p + 7] & 0x7f);
    else fsize = ((u[p + 4] << 24) | (u[p + 5] << 16) | (u[p + 6] << 8) | u[p + 7]) >>> 0;   // v2.3 big-endian
    const dp = p + 10;
    if (fsize === 0 || dp + fsize > u.length) break;
    if (id === 'TIT2') out.title = readText(u, dp, fsize);
    else if (id === 'TPE1') out.artist = readText(u, dp, fsize);
    else if (id === 'TALB') out.album = readText(u, dp, fsize);
    else if (id === 'APIC') out.picture = readApic(u, dp, fsize);
    p = dp + fsize;
  }
  if (!out.title && !out.artist && !out.album && !out.picture) return null;
  return out;
}
