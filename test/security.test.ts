import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parsePackageLock } from "../src/graph.js";
import { checkSecurity, formatSecurityReport, parseAuditIssues } from "../src/security.js";

test("parseAuditIssues maps npm audit vulnerabilities onto installed package paths", () => {
  const graph = parsePackageLock(
    JSON.stringify({
      name: "your-project",
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            "api-client": "^1.0.0"
          }
        },
        "node_modules/api-client": {
          name: "api-client",
          version: "1.0.0",
          dependencies: {
            axios: "^0.21.1"
          }
        },
        "node_modules/api-client/node_modules/axios": {
          name: "axios",
          version: "0.21.1"
        }
      }
    })
  );
  const audit = {
    vulnerabilities: {
      axios: {
        name: "axios",
        severity: "moderate",
        nodes: ["node_modules/api-client/node_modules/axios"],
        via: [
          {
            title: "SSRF vulnerability",
            url: "https://example.test/advisory",
            severity: "moderate"
          }
        ],
        fixAvailable: {
          name: "axios",
          version: "0.21.4"
        }
      }
    }
  };

  const issues = parseAuditIssues(audit, graph);

  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.packageName, "axios");
  assert.equal(issues[0]?.version, "0.21.1");
  assert.deepEqual(issues[0]?.path, ["your-project", "api-client", "axios"]);
  assert.equal(issues[0]?.fixCommand, "npm install axios@0.21.4");

  const report = formatSecurityReport(issues, graph.nodes.size - 1);
  assert.match(report, /Checking 2 packages against npm audit/);
  assert.match(report, /Required by: api-client → your-project/);
});

test("checkSecurity consumes npm audit JSON even when npm exits non-zero", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dep-why-security-"));
  await writeFile(
    join(cwd, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            lodash: "^4.17.20"
          }
        },
        "node_modules/lodash": {
          name: "lodash",
          version: "4.17.20"
        }
      }
    })
  );

  const issues = await checkSecurity(cwd, async () => ({
    stdout: JSON.stringify({
      vulnerabilities: {
        lodash: {
          name: "lodash",
          severity: "critical",
          via: [
            {
              title: "Prototype Pollution",
              severity: "critical"
            }
          ],
          fixAvailable: {
            name: "lodash",
            version: "4.17.21"
          }
        }
      }
    }),
    stderr: ""
  }));

  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.packageName, "lodash");
  assert.equal(issues[0]?.path.join(" -> "), "fixture -> lodash");
});
