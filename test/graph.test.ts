import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findDependencyPaths,
  getTargetVersion,
  loadGraph,
  parsePackageLock,
  parsePnpmLock
} from "../src/graph.js";

const packageLockFixture = JSON.stringify({
  name: "your-project",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "your-project",
      version: "1.0.0",
      dependencies: {
        webpack: "^5.0.0"
      },
      devDependencies: {
        eslint: "^9.0.0"
      }
    },
    "node_modules/webpack": {
      name: "webpack",
      version: "5.1.0",
      dependencies: {
        "enhanced-resolve": "^5.0.0",
        lodash: "^4.17.21"
      }
    },
    "node_modules/enhanced-resolve": {
      name: "enhanced-resolve",
      version: "5.0.0",
      dependencies: {
        lodash: "^4.17.21"
      }
    },
    "node_modules/lodash": {
      name: "lodash",
      version: "4.17.21"
    },
    "node_modules/eslint": {
      name: "eslint",
      version: "9.0.0",
      dependencies: {
        lodash: "^4.17.21"
      },
      dev: true
    }
  }
});

test("parses a minimal package-lock.json v3 fixture correctly", () => {
  const graph = parsePackageLock(packageLockFixture);

  assert.equal(graph.nodes.get("root")?.name, "your-project");
  assert.deepEqual(
    [...(graph.edges.get("root") ?? [])].sort(),
    ["eslint@9.0.0", "webpack@5.1.0"]
  );
});

test("BFS finds direct dependency path", () => {
  const graph = parsePackageLock(packageLockFixture);
  const paths = findDependencyPaths(graph, "webpack");

  assert.deepEqual(paths, [["your-project", "webpack"]]);
});

test("BFS finds transitive dependency path", () => {
  const graph = parsePackageLock(packageLockFixture);
  const paths = findDependencyPaths(graph, "lodash");

  assert.deepEqual(paths, [
    ["your-project", "webpack", "lodash"],
    ["your-project", "eslint", "lodash"],
    ["your-project", "webpack", "enhanced-resolve", "lodash"]
  ]);
});

test("returns empty array when package not found", () => {
  const graph = parsePackageLock(packageLockFixture);

  assert.deepEqual(findDependencyPaths(graph, "react"), []);
});

test("deduplicates identical paths", () => {
  const graph = parsePackageLock(
    JSON.stringify({
      name: "your-project",
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            foo: "^1.0.0"
          }
        },
        "node_modules/foo": {
          name: "foo",
          version: "1.0.0",
          dependencies: {
            bar: "^1.0.0"
          }
        },
        "node_modules/bar": {
          name: "bar",
          version: "1.0.0"
        }
      }
    })
  );

  const first = findDependencyPaths(graph, "bar");
  const second = findDependencyPaths(graph, "bar");

  assert.deepEqual(first, [["your-project", "foo", "bar"]]);
  assert.deepEqual(second, [["your-project", "foo", "bar"]]);
});

test("parses a minimal pnpm-lock.yaml fixture correctly", () => {
  const graph = parsePnpmLock(`
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      webpack:
        version: 5.1.0
packages:
  webpack@5.1.0:
    dependencies:
      lodash: 4.17.21
  lodash@4.17.21: {}
`);

  assert.deepEqual(findDependencyPaths(graph, "lodash"), [
    ["your-project", "webpack", "lodash"]
  ]);
});

test("package-lock parsing preserves resolved nested packages and normalizes non-semver root specs", () => {
  const graph = parsePackageLock(
    JSON.stringify({
      name: "your-project",
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            foo: "workspace:*",
            bar: "npm:bar-alias"
          },
          optionalDependencies: {
            opt: "^1.0.0"
          },
          peerDependencies: {
            peer: "^2.0.0"
          }
        },
        "node_modules/foo": {
          name: "foo",
          version: "1.2.3",
          dependencies: {
            shared: "^1.0.0"
          }
        },
        "node_modules/bar": {
          name: "bar",
          version: "2.3.4"
        },
        "node_modules/foo/node_modules/shared": {
          name: "shared",
          version: "1.0.0"
        }
      }
    })
  );

  assert.deepEqual(
    [...(graph.edges.get("root") ?? [])].sort(),
    ["bar@2.3.4", "foo@1.2.3", "opt@1.0.0", "peer@2.0.0"]
  );
  assert.deepEqual(findDependencyPaths(graph, "shared"), [["your-project", "foo", "shared"]]);
});

test("getTargetVersion returns undefined for missing targets and resolves the discovered version", () => {
  const graph = parsePackageLock(packageLockFixture);
  const foundPaths = findDependencyPaths(graph, "lodash");

  assert.equal(getTargetVersion(graph, "lodash", foundPaths), "4.17.21");
  assert.equal(getTargetVersion(graph, "react", []), undefined);
});

test("pnpm parsing falls back to the first importer and handles scoped and slash-delimited package keys", () => {
  const graph = parsePnpmLock(`
lockfileVersion: '9.0'
importers:
  packages/app:
    dependencies:
      "@scope/pkg": workspace:*
      legacy: link:../legacy
packages:
  "@scope/pkg@1.2.3(peer@4.0.0)":
    dependencies:
      left-pad: 1.3.0
  left-pad/1.3.0: {}
  legacy/2.0.0: {}
`);

  assert.deepEqual(findDependencyPaths(graph, "@scope/pkg"), [["your-project", "@scope/pkg"]]);
  assert.deepEqual(findDependencyPaths(graph, "left-pad"), [
    ["your-project", "@scope/pkg", "left-pad"]
  ]);
  assert.deepEqual(findDependencyPaths(graph, "legacy"), [["your-project", "legacy"]]);
});

test("pnpm parsing supports scoped package keys without explicit package metadata", () => {
  const graph = parsePnpmLock(`
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      "@types/node":
        version: 24.0.0
packages:
  /@types/node@24.0.0: {}
`);

  assert.deepEqual(findDependencyPaths(graph, "@types/node"), [["your-project", "@types/node"]]);
});

test("loadGraph prefers package-lock.json and falls back to pnpm-lock.yaml", async () => {
  const packageLockDir = await mkdtemp(join(tmpdir(), "dep-why-package-lock-"));
  await writeFile(
    join(packageLockDir, "package-lock.json"),
    JSON.stringify({
      name: "package-lock-project",
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            foo: "^1.0.0"
          }
        },
        "node_modules/foo": {
          name: "foo",
          version: "1.0.0"
        }
      }
    })
  );

  const packageLockGraph = await loadGraph(packageLockDir);
  assert.equal(packageLockGraph.nodes.get("root")?.name, "package-lock-project");

  const pnpmDir = await mkdtemp(join(tmpdir(), "dep-why-pnpm-lock-"));
  await writeFile(
    join(pnpmDir, "pnpm-lock.yaml"),
    `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      foo:
        version: 1.0.0
packages:
  foo@1.0.0: {}
`
  );

  const pnpmGraph = await loadGraph(pnpmDir);
  assert.deepEqual(findDependencyPaths(pnpmGraph, "foo"), [["your-project", "foo"]]);
});

test("loadGraph reports missing lockfiles and invalid package-lock contents", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "dep-why-empty-"));
  await assert.rejects(
    loadGraph(emptyDir),
    /No supported lockfile found\. Expected package-lock\.json or pnpm-lock\.yaml\./
  );

  const invalidDir = await mkdtemp(join(tmpdir(), "dep-why-invalid-"));
  await writeFile(join(invalidDir, "package-lock.json"), "{not valid json");
  await assert.rejects(loadGraph(invalidDir), /Expected property name or '}'/);
});
