import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findDuplicatePackages, formatDuplicateReport } from "../src/duplicates.js";

test("findDuplicatePackages detects packages installed at multiple versions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dep-why-duplicates-"));
  await mkdir(join(cwd, "node_modules", "foo"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "app", "node_modules", "foo"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "app"), { recursive: true });

  await writeFile(join(cwd, "node_modules", "foo", "package.json"), JSON.stringify({ name: "foo", version: "1.0.0" }));
  await writeFile(join(cwd, "node_modules", "foo", "index.js"), "export default 1;\n");
  await writeFile(join(cwd, "node_modules", "app", "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  await writeFile(
    join(cwd, "node_modules", "app", "node_modules", "foo", "package.json"),
    JSON.stringify({ name: "foo", version: "2.0.0" })
  );
  await writeFile(join(cwd, "node_modules", "app", "node_modules", "foo", "index.js"), "export default 2;\n");

  const duplicates = await findDuplicatePackages(cwd);

  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.name, "foo");
  assert.deepEqual(
    duplicates[0]?.versions.map((entry) => `${entry.version}:${entry.via}`),
    ["1.0.0:your-project", "2.0.0:app"]
  );
  assert.ok((duplicates[0]?.wastedBytes ?? 0) > 0);

  const report = formatDuplicateReport(duplicates);
  assert.match(report, /Duplicate packages found:/);
  assert.match(report, /foo/);
  assert.match(report, /version conflict!/);
});
