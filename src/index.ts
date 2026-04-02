#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { Command } from "commander";

import { formatPaths } from "./formatter.js";
import { findDependencyPaths, getTargetVersion, loadGraph } from "./graph.js";
import {
  filterPackages,
  promptForPackageSelection,
  summarizePackageUsage
} from "./interactive.js";
import { analyzeSourceImports, findUnusedDependencies } from "./unused.js";

const program = new Command();

program
  .name("dep-why")
  .description("Explain why a package is present in your node_modules.")
  .argument("[package]", "Target package name")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option("--json", "JSON output", false)
  .option("--max-depth <n>", "Max path depth to show", parseInteger, 10)
  .option("--all", "Show all paths", false)
  .option("--unused", "Show dependencies declared in package.json but unused in src/", false)
  .option("--why <package>", "Explain why a package is needed")
  .option("--interactive", "Prompt for a package name interactively", false)
  .action(async (targetPackage: string | undefined, options) => {
    try {
      if (options.unused) {
        const output = await runUnusedMode(options.cwd);
        process.stdout.write(`${output}\n`);
        process.exitCode = 0;
        return;
      }

      const resolvedTargetPackage = await resolveTargetPackage(targetPackage, options);
      if (!resolvedTargetPackage) {
        throw new Error("A package name is required. Pass <package>, --why <package>, or --interactive.");
      }

      const graph = await loadGraph(options.cwd);
      const paths = findDependencyPaths(graph, resolvedTargetPackage, options.maxDepth);
      const version = getTargetVersion(graph, resolvedTargetPackage, paths);
      const usageOutput = await formatSourceUsage(options.cwd, resolvedTargetPackage);
      const output = formatPaths(graph, resolvedTargetPackage, version, paths, {
        json: options.json,
        showAll: options.all,
        usage: usageOutput
      });
      process.stdout.write(`${output}\n`);
      process.exitCode = paths.length === 0 ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);

async function resolveTargetPackage(
  targetPackage: string | undefined,
  options: {
    cwd: string;
    why?: string;
    interactive?: boolean;
  }
): Promise<string | undefined> {
  if (options.why && targetPackage && options.why !== targetPackage) {
    throw new Error("Pass either <package> or --why <package>, not both with different values.");
  }

  if (options.why) {
    return options.why;
  }

  if (targetPackage) {
    return targetPackage;
  }

  if (!options.interactive) {
    return undefined;
  }

  const packages = await loadDeclaredPackages(options.cwd);
  return promptForPackageSelection(packages);
}

async function runUnusedMode(cwd: string): Promise<string> {
  const report = await findUnusedDependencies(cwd);
  const lines = ["Scanning source files for import usage...", ""];

  if (report.dependencies.length > 0) {
    lines.push("Unused dependencies (in package.json but never imported):");
    for (const dependency of report.dependencies) {
      lines.push(`  ${dependency}  (last used: never found in src/)`);
    }
    lines.push("");
    lines.push(`Run: npm uninstall ${report.dependencies.join(" ")}`);
  } else {
    lines.push("No unused dependencies found.");
  }

  if (report.devDependencies.length > 0) {
    if (report.dependencies.length > 0) {
      lines.push("");
    }
    lines.push("Unused devDependencies:");
    for (const dependency of report.devDependencies) {
      lines.push(`  ${dependency}  (no ${dependency} imports found)`);
    }
  }

  return lines.join("\n");
}

async function formatSourceUsage(cwd: string, packageName: string): Promise<string[] | undefined> {
  const analysis = await analyzeSourceImports(cwd);
  const occurrences = analysis.packages.get(packageName);
  if (!occurrences || occurrences.length === 0) {
    return undefined;
  }

  const fileSources = await loadFileSources(cwd, [...new Set(occurrences.map((occurrence) => occurrence.filePath))]);
  const summary = summarizePackageUsage(packageName, occurrences, fileSources);
  const lines = occurrences.map(
    (occurrence) => `  ${occurrence.filePath}:${occurrence.line} (direct import)`
  );
  if (summary.description) {
    lines.push(`  -> Used for: ${summary.description}`);
  }

  return lines;
}

async function loadDeclaredPackages(cwd: string): Promise<string[]> {
  const source = await readFile(join(cwd, "package.json"), "utf8");
  const manifest = JSON.parse(source) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return filterPackages(
    [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})])],
    ""
  );
}

async function loadFileSources(cwd: string, filePaths: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(
    filePaths.map(async (filePath) => [filePath, await readFile(join(cwd, filePath), "utf8")] as const)
  );
  return new Map(entries);
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("--max-depth must be a positive integer.");
  }

  return parsed;
}
