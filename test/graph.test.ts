import test from "node:test";
import assert from "node:assert/strict";

import { findDependencyPaths, parsePackageLock, parsePnpmLock } from "../src/graph.js";

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
