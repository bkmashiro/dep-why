import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { filterPackages, summarizePackageUsage } from "../src/interactive.js";
import {
  analyzeSourceImports,
  extractImportOccurrences,
  findUnusedDependencies,
  resolvePackageName
} from "../src/unused.js";

test("extractImportOccurrences resolves package names from common import syntaxes", () => {
  const source = `
import ReactDOM, { createRoot } from "react-dom";
import type { Config } from "vite";
import "reflect-metadata";
export { z } from "zod";
const chalk = require("chalk");
await import("@scope/pkg/runtime");
import localThing from "./local";
`;

  const occurrences = extractImportOccurrences(source, "src/main.tsx");

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.source),
    ["react-dom", "vite", "reflect-metadata", "zod", "chalk", "@scope/pkg"]
  );
  assert.deepEqual(occurrences[0]?.importedNames, ["ReactDOM", "createRoot"]);
});

test("resolvePackageName strips subpaths and ignores local imports", () => {
  assert.equal(resolvePackageName("@scope/pkg/runtime"), "@scope/pkg");
  assert.equal(resolvePackageName("lodash/fp"), "lodash");
  assert.equal(resolvePackageName("./utils"), undefined);
  assert.equal(resolvePackageName("node:fs"), undefined);
});

test("findUnusedDependencies compares package.json to imports under src", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dep-why-unused-"));
  await mkdir(join(cwd, "src"));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "fixture",
      dependencies: {
        react: "^19.0.0",
        lodash: "^4.17.21",
        zod: "^3.0.0"
      },
      devDependencies: {
        vitest: "^2.0.0",
        typescript: "^6.0.0"
      }
    })
  );
  await writeFile(
    join(cwd, "src", "main.tsx"),
    `import ReactDOM from "react-dom";
import { z } from "zod";
console.log(ReactDOM, z);
`
  );

  const report = await findUnusedDependencies(cwd);

  assert.deepEqual(report.dependencies, ["lodash", "react"]);
  assert.deepEqual(report.devDependencies, ["typescript", "vitest"]);
  assert.equal(report.filesScanned, 1);
});

test("analyzeSourceImports groups occurrences by package", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dep-why-analyze-"));
  await mkdir(join(cwd, "src"));
  await writeFile(
    join(cwd, "src", "index.ts"),
    `import ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
`
  );

  const analysis = await analyzeSourceImports(cwd);

  assert.equal(analysis.filesScanned, 1);
  assert.equal(analysis.packages.get("react-dom")?.length, 2);
});

test("filterPackages prefers exact and prefix matches before fuzzy matches", () => {
  const matches = filterPackages(["react", "react-dom", "preact", "router"], "reac");

  assert.deepEqual(matches, ["react", "react-dom", "preact"]);
});

test("summarizePackageUsage infers member and call usage from source", () => {
  const summary = summarizePackageUsage(
    "react-dom",
    [
      {
        filePath: "src/main.tsx",
        line: 1,
        source: "react-dom",
        statement: `import ReactDOM, { createRoot } from "react-dom";`,
        importedNames: ["ReactDOM", "createRoot"]
      }
    ],
    new Map([
      [
        "src/main.tsx",
        `import ReactDOM, { createRoot } from "react-dom";
ReactDOM.render(app, node);
createRoot(node);
`
      ]
    ])
  );

  assert.equal(summary.description, "render / createRoot()");
});
