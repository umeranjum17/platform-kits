// The main and testing entries bundle for browser and react-native with no Node import and no process.env, so the
// kit stays portable; only `./node` may use Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

for (const platform of ["browser", "react-native"] as const) {
  for (const file of ["src/index.ts", "src/testing.ts"]) {
    test(`${file} bundles for ${platform} with no Node import`, async () => {
      const result = await build({
        entryPoints: [new URL(`../${file}`, import.meta.url).pathname], bundle: true, write: false, metafile: true,
        platform: "browser", format: "esm", conditions: [platform], logLevel: "silent",
      });
      const imports = Object.values(result.metafile.inputs).flatMap((i) => i.imports.map((to) => to.path));
      assert.deepEqual(imports.filter((path) => path.startsWith("node:")), [], "no node:* import");
      assert.ok(!/process\.env/.test(result.outputFiles[0].text), "no process.env");
    });
  }
}
