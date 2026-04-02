import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DependencyGraph, GraphNode } from "./graph.js";
import { findDependencyNodePaths, loadGraph } from "./graph.js";

const execFileAsync = promisify(execFile);

export interface SecurityIssue {
  packageName: string;
  version: string;
  severity: string;
  title: string;
  url?: string;
  fixCommand?: string;
  path: string[];
}

interface AuditRunnerResult {
  stdout: string;
  stderr: string;
}

type AuditRunner = (cwd: string) => Promise<AuditRunnerResult>;

interface AuditJson {
  auditReportVersion?: number;
  vulnerabilities?: Record<
    string,
    {
      name?: string;
      severity?: string;
      range?: string;
      via?: Array<string | { title?: string; url?: string; severity?: string; range?: string }>;
      nodes?: string[];
      fixAvailable?: boolean | { name?: string; version?: string };
    }
  >;
  advisories?: Record<
    string,
    {
      module_name?: string;
      severity?: string;
      title?: string;
      url?: string;
      findings?: Array<{ version?: string; paths?: string[] }>;
      recommendation?: string;
    }
  >;
}

export async function checkSecurity(cwd: string, runAudit: AuditRunner = defaultAuditRunner): Promise<SecurityIssue[]> {
  const graph = await loadGraph(cwd);
  const audit = await loadAuditJson(cwd, runAudit);
  const issues = parseAuditIssues(audit, graph);
  return issues.sort(compareSecurityIssues);
}

export function formatSecurityReport(issues: SecurityIssue[], packageCount: number): string {
  if (issues.length === 0) {
    return `Checking ${packageCount} packages against npm audit...\n\nNo known vulnerable packages found.`;
  }

  const lines = [`Checking ${packageCount} packages against npm audit...`, ""];
  for (const issue of issues) {
    lines.push(
      `${severityIcon(issue.severity)} ${capitalize(issue.severity)}: ${issue.packageName}@${issue.version}  \u2192 ${issue.title}`
    );
    lines.push(`   Required by: ${formatRequirementChain(issue.path)}`);
    if (issue.fixCommand) {
      lines.push(`   Fix: ${issue.fixCommand}`);
    }
    if (issue.url) {
      lines.push(`   More: ${issue.url}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function parseAuditIssues(audit: AuditJson, graph: DependencyGraph): SecurityIssue[] {
  const modernIssues = parseModernAuditIssues(audit, graph);
  if (modernIssues.length > 0) {
    return modernIssues;
  }

  return parseLegacyAuditIssues(audit, graph);
}

function parseModernAuditIssues(audit: AuditJson, graph: DependencyGraph): SecurityIssue[] {
  const vulnerabilities = audit.vulnerabilities ?? {};
  const issues: SecurityIssue[] = [];

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const nodeIds = resolveAuditNodeIds(graph, vulnerability.name ?? packageName, vulnerability.nodes);
    for (const nodeId of nodeIds) {
      const node = graph.nodes.get(nodeId);
      if (!node?.version) {
        continue;
      }

      const advisory = firstAuditAdvisory(vulnerability.via);
      issues.push({
        packageName: node.name,
        version: node.version,
        severity: advisory?.severity ?? vulnerability.severity ?? "unknown",
        title: advisory?.title ?? `Vulnerability in ${node.name}`,
        url: advisory?.url,
        fixCommand: formatFixCommand(node.name, vulnerability.fixAvailable),
        path: describePath(graph, node)
      });
    }
  }

  return dedupeSecurityIssues(issues);
}

function parseLegacyAuditIssues(audit: AuditJson, graph: DependencyGraph): SecurityIssue[] {
  const advisories = audit.advisories ?? {};
  const issues: SecurityIssue[] = [];

  for (const advisory of Object.values(advisories)) {
    for (const finding of advisory.findings ?? []) {
      const node = findNode(graph, advisory.module_name, finding.version);
      if (!node?.version) {
        continue;
      }

      issues.push({
        packageName: node.name,
        version: node.version,
        severity: advisory.severity ?? "unknown",
        title: advisory.title ?? `Vulnerability in ${node.name}`,
        url: advisory.url,
        fixCommand: formatLegacyFixCommand(node.name, advisory.recommendation),
        path: describePath(graph, node)
      });
    }
  }

  return dedupeSecurityIssues(issues);
}

function resolveAuditNodeIds(
  graph: DependencyGraph,
  packageName: string,
  nodes: string[] | undefined
): string[] {
  const resolved = (nodes ?? [])
    .map((nodePath) => nodePath.split("node_modules/").at(-1))
    .filter((name): name is string => Boolean(name))
    .flatMap((name) => [...graph.nodes.values()].filter((node) => node.name === name).map((node) => node.id));

  if (resolved.length > 0) {
    return [...new Set(resolved)];
  }

  return [...graph.nodes.values()]
    .filter((node) => node.name === packageName)
    .map((node) => node.id);
}

function firstAuditAdvisory(
  via: Array<string | { title?: string; url?: string; severity?: string }> | undefined
): { title?: string; url?: string; severity?: string } | undefined {
  return via?.find((entry): entry is { title?: string; url?: string; severity?: string } => typeof entry === "object");
}

function describePath(graph: DependencyGraph, node: GraphNode): string[] {
  const [path] = findDependencyNodePaths(graph, (candidate) => candidate.id === node.id, 20);
  if (!path) {
    return [graph.nodes.get(graph.rootId)?.name ?? "your-project", node.name];
  }

  return path
    .map((id) => graph.nodes.get(id))
    .filter((entry): entry is GraphNode => Boolean(entry))
    .map((entry) => entry.name);
}

function findNode(graph: DependencyGraph, packageName?: string, version?: string): GraphNode | undefined {
  return [...graph.nodes.values()].find((node) => node.name === packageName && node.version === version);
}

function dedupeSecurityIssues(issues: SecurityIssue[]): SecurityIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.packageName}\u0000${issue.version}\u0000${issue.title}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function formatRequirementChain(path: string[]): string {
  if (path.length <= 2) {
    return `${path[0]} (direct)`;
  }

  return path.slice(0, -1).reverse().join(" \u2192 ");
}

function formatFixCommand(
  packageName: string,
  fixAvailable: boolean | { name?: string; version?: string } | undefined
): string | undefined {
  if (!fixAvailable || fixAvailable === true) {
    return undefined;
  }

  return `npm install ${fixAvailable.name ?? packageName}@${fixAvailable.version}`;
}

function formatLegacyFixCommand(packageName: string, recommendation?: string): string | undefined {
  if (!recommendation) {
    return undefined;
  }

  const versionMatch = recommendation.match(/\d+\.\d+\.\d+[^\s)]*/);
  if (!versionMatch) {
    return undefined;
  }

  return `npm install ${packageName}@${versionMatch[0]}`;
}

async function loadAuditJson(cwd: string, runAudit: AuditRunner): Promise<AuditJson> {
  const { stdout, stderr } = await runAudit(cwd);
  const source = stdout.trim() || stderr.trim();
  if (!source) {
    throw new Error("npm audit returned no JSON output.");
  }

  return JSON.parse(source) as AuditJson;
}

async function defaultAuditRunner(cwd: string): Promise<AuditRunnerResult> {
  try {
    const result = await execFileAsync("npm", ["audit", "--json"], { cwd });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (isExecError(error)) {
      return {
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : ""
      };
    }

    throw error;
  }
}

function compareSecurityIssues(left: SecurityIssue, right: SecurityIssue): number {
  return severityRank(right.severity) - severityRank(left.severity) || left.packageName.localeCompare(right.packageName);
}

function severityRank(severity: string): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "moderate":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function severityIcon(severity: string): string {
  switch (severity) {
    case "critical":
    case "high":
      return "🔴";
    case "moderate":
      return "🟡";
    case "low":
      return "🟢";
    default:
      return "⚪";
  }
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function isExecError(error: unknown): error is NodeJS.ErrnoException & { stdout?: string; stderr?: string } {
  return Boolean(error && typeof error === "object" && ("stdout" in error || "stderr" in error));
}
