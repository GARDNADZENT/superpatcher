// CRC-32C (Castagnoli), reflected/table-based, "raw" (chainable) form: no
// implicit pre/post inversion is applied here — callers pass whatever
// starting register value they need (e.g. 0xFFFFFFFF for a from-scratch
// checksum, or a previous crc32c() result to continue a chained checksum,
// which is exactly how ext4's metadata_csum seed derivation and directory
// block checksums are defined). This matches ext4's internal `ext4_chksum()`
// semantics (verified against real mkfs.ext4 output — see test/fs-modules
// .test.js "ext4 checksum" tests).

function buildTable() {
  const POLY = 0x82f63b78; // reflected Castagnoli polynomial
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (POLY ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const TABLE = buildTable();

/**
 * @param {number} seed starting CRC register value (use 0xFFFFFFFF for a
 *   fresh checksum, per ext4 convention).
 * @param {Uint8Array} bytes
 * @returns {number} resulting CRC register value (uint32)
 */
export function crc32c(seed, bytes) {
  let crc = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}
