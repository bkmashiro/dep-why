#!/usr/bin/env node

import process from "node:process";

import { Command } from "commander";

import { formatPaths } from "./formatter.js";
import { findDependencyPaths, getTargetVersion, loadGraph } from "./graph.js";

const program = new Command();

program
  .name("dep-why")
  .description("Explain why a package is present in your node_modules.")
  .argument("<package>", "Target package name")
  .option("--cwd <path>", "Project directory", process.cwd())
  .option("--json", "JSON output", false)
  .option("--max-depth <n>", "Max path depth to show", parseInteger, 10)
  .option("--all", "Show all paths", false)
  .action(async (targetPackage: string, options) => {
    try {
      const graph = await loadGraph(options.cwd);
      const paths = findDependencyPaths(graph, targetPackage, options.maxDepth);
      const version = getTargetVersion(graph, targetPackage, paths);
      const output = formatPaths(graph, targetPackage, version, paths, {
        json: options.json,
        showAll: options.all
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

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("--max-depth must be a positive integer.");
  }

  return parsed;
}
