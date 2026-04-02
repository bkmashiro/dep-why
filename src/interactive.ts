import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { createInterface } from "node:readline/promises";

import type { ImportOccurrence } from "./unused.js";

export interface PackageUsageSummary {
  packageName: string;
  occurrences: ImportOccurrence[];
  description: string | undefined;
}

export async function promptForPackageSelection(
  packages: string[],
  input: NodeJS.ReadableStream = defaultInput,
  output: NodeJS.WritableStream = defaultOutput
): Promise<string | undefined> {
  const rl = createInterface({ input, output });

  try {
    const query = (await rl.question("Which package to investigate? ")).trim();
    const matches = filterPackages(packages, query).slice(0, 10);
    if (matches.length === 0) {
      output.write(`No packages matched "${query}".\n`);
      return undefined;
    }

    output.write(`Matches for "${query || "*"}":\n`);
    for (const [index, pkg] of matches.entries()) {
      output.write(`  ${index + 1}. ${pkg}\n`);
    }

    const selection = (await rl.question("Choose a package number (default 1): ")).trim();
    const selectedIndex = selection ? Number.parseInt(selection, 10) - 1 : 0;
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= matches.length) {
      output.write("Invalid selection.\n");
      return undefined;
    }

    return matches[selectedIndex];
  } finally {
    rl.close();
  }
}

export function filterPackages(packages: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  const scored = packages
    .map((pkg) => ({ pkg, score: packageScore(pkg, normalizedQuery) }))
    .filter((entry) => entry.score !== Number.NEGATIVE_INFINITY)
    .sort((left, right) => right.score - left.score || left.pkg.localeCompare(right.pkg));

  return scored.map((entry) => entry.pkg);
}

export function summarizePackageUsage(
  packageName: string,
  occurrences: ImportOccurrence[],
  fileSources: Map<string, string>
): PackageUsageSummary {
  return {
    packageName,
    occurrences,
    description: inferUsageDescription(occurrences, fileSources)
  };
}

function inferUsageDescription(
  occurrences: ImportOccurrence[],
  fileSources: Map<string, string>
): string | undefined {
  const usages = new Set<string>();

  for (const occurrence of occurrences) {
    const source = fileSources.get(occurrence.filePath);
    if (!source) {
      continue;
    }

    for (const importedName of occurrence.importedNames) {
      const memberUsage = source.match(new RegExp(`\\b${escapeRegExp(importedName)}\\.([A-Za-z_$][\\w$]*)`, "g"));
      for (const match of memberUsage ?? []) {
        usages.add(match.replace(`${importedName}.`, ""));
        if (usages.size >= 3) {
          return [...usages].join(" / ");
        }
      }

      const callUsage = source.match(
        new RegExp(`\\b${escapeRegExp(importedName)}\\s*\\(`, "g")
      );
      if ((callUsage?.length ?? 0) > 0) {
        usages.add(`${importedName}()`);
        if (usages.size >= 3) {
          return [...usages].join(" / ");
        }
      }
    }
  }

  return usages.size > 0 ? [...usages].join(" / ") : undefined;
}

function packageScore(pkg: string, query: string): number {
  if (!query) {
    return 0;
  }

  const normalizedPackage = pkg.toLowerCase();
  if (normalizedPackage === query) {
    return 1000;
  }

  if (normalizedPackage.startsWith(query)) {
    return 800 - normalizedPackage.length;
  }

  if (normalizedPackage.includes(query)) {
    return 500 - normalizedPackage.indexOf(query);
  }

  let score = 0;
  let queryIndex = 0;
  for (const character of normalizedPackage) {
    if (character === query[queryIndex]) {
      score += 10;
      queryIndex += 1;
      if (queryIndex === query.length) {
        return score - normalizedPackage.length;
      }
    }
  }

  return Number.NEGATIVE_INFINITY;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
