// Builds sample-data/super_devicelock_demo.img: a real 3-partition super.img
// matching the exact layout the "Remove Device Lock Components" feature
// targets, for true end-to-end manual/CLI testing.
//
//   system_a     (ext4,  UNRELATED — must come out byte-identical)
//   product_a    (EROFS, lz4hc-compressed) containing:
//                  /priv-app/SecurityCom/SecurityCom.apk      (TARGET 1)
//                  /priv-app/OtherVendorApp/OtherVendorApp.apk  (decoy)
//                  /app/SomeApp/SomeApp.apk                     (decoy)
//   system_ext_a (EROFS, lz4hc-compressed) containing:
//                  /app/TranPluginApp/TranPluginApp.apk        (TARGET 2)
//                  /app/TranDaemonApp/TranDaemonApp.apk        (TARGET 3)
//                  /app/KeepMeApp/KeepMeApp.apk                 (decoy)
//                  /etc/permissions/keep.xml                    (decoy)
//
// The two EROFS images are pre-built fixtures (test/fixtures/devicelock-*),
// built once with `mkfs.erofs -zlz4hc` — deliberately compressed so their
// APKs come out as unsupported-for-content-reading COMPRESSED_COMPACT
// inodes, mirroring the real-world case described in the task (the
// directory-removal code path never needs to decompress a file's content,
// only list/patch its parent directory, so removal still works even though
// this project's APK *scanner* can't read these files).
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { buildSuperImage } from './lp-test-helpers.mjs';

async function main() {
  const ext4Gz = await readFile(new URL('./fixtures/test2.ext4.img.gz', import.meta.url));
  const systemA = new Uint8Array(gunzipSync(ext4Gz));
  const productA = new Uint8Array(await readFile(new URL('./fixtures/devicelock-product_a.erofs.img', import.meta.url)));
  const systemExtA = new Uint8Array(
    await readFile(new URL('./fixtures/devicelock-system_ext_a.erofs.img', import.meta.url))
  );

  const image = await buildSuperImage([
    { name: 'system_a', bytes: systemA },
    { name: 'product_a', bytes: productA },
    { name: 'system_ext_a', bytes: systemExtA },
  ]);

  const outPath = new URL('../sample-data/super_devicelock_demo.img', import.meta.url);
  await writeFile(outPath, image);
  console.log('Wrote sample-data/super_devicelock_demo.img:', image.length, 'bytes');
}

main();
