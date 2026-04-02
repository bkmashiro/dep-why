import chalk from "chalk";

import type { DependencyGraph, NodeKind } from "./graph.js";

export interface FormatOptions {
  json?: boolean;
  showAll?: boolean;
}

export function formatPaths(
  graph: DependencyGraph,
  targetPackage: string,
  version: string | undefined,
  paths: string[][],
  options: FormatOptions = {}
): string {
  if (options.json) {
    return JSON.stringify(
      {
        package: targetPackage,
        version,
        paths,
        count: paths.length
      },
      null,
      2
    );
  }

  if (paths.length === 0) {
    return `${chalk.red(targetPackage)} was not found in the dependency graph.`;
  }

  const heading = `${chalk.red(version ? `${targetPackage}@${version}` : targetPackage)} is required by:`;
  const displayPaths = options.showAll ? paths : paths.slice(0, 5);
  const lines = displayPaths.map((path) => `  ${colorizePath(graph, path).join(chalk.dim(" -> "))}`);
  const hiddenCount = paths.length - displayPaths.length;
  const footer = `${paths.length} dependency path(s) found.`;

  if (hiddenCount > 0) {
    lines.push(`  ${chalk.dim(`... ${hiddenCount} more path(s) omitted; pass --all to show everything.`)}`);
  }

  return [heading, ...lines, "", footer].join("\n");
}

function colorizePath(graph: DependencyGraph, path: string[]): string[] {
  return path.map((name, index) => {
    if (index === 0) {
      return chalk.green(name);
    }

    const kind = findNodeKind(graph, name);
    const displayName =
      index === 1 && kind === "dev" ? `${name} ${chalk.dim("(direct devDep)")}` : name;

    if (index === path.length - 1) {
      return chalk.red(displayName);
    }

    return chalk.white(displayName);
  });
}

function findNodeKind(graph: DependencyGraph, name: string): NodeKind | undefined {
  for (const node of graph.nodes.values()) {
    if (node.name === name) {
      return node.kind;
    }
  }

  return undefined;
}
