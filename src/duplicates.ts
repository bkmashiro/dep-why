import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export interface DuplicatePackageVersion {
  version: string;
  via: string;
  sizeBytes: number;
  count: number;
}

export interface DuplicatePackageGroup {
  name: string;
  versions: DuplicatePackageVersion[];
  wastedBytes: number;
}

interface PackageInstance {
  version: string;
  packagePath: string;
  via: string;
  sizeBytes: number;
}

export async function findDuplicatePackages(cwd: string): Promise<DuplicatePackageGroup[]> {
  const nodeModulesPath = join(cwd, "node_modules");
  const packageJsonPaths = await collectPackageJsonPaths(nodeModulesPath);
  const instances = await Promise.all(packageJsonPaths.map((packageJsonPath) => loadPackageInstance(cwd, packageJsonPath)));
  const grouped = new Map<string, PackageInstance[]>();

  for (const instance of instances) {
    const entries = grouped.get(instance.name) ?? [];
    entries.push(instance);
    grouped.set(instance.name, entries);
  }

  return [...grouped.entries()]
    .map(([name, entries]) => createDuplicateGroup(name, entries))
    .filter((entry): entry is DuplicatePackageGroup => entry !== undefined)
    .sort((left, right) => right.wastedBytes - left.wastedBytes || left.name.localeCompare(right.name));
}

export function formatDuplicateReport(groups: DuplicatePackageGroup[]): string {
  if (groups.length === 0) {
    return "No duplicate packages found.";
  }

  const lines = ["Duplicate packages found:", ""];
  for (const group of groups) {
    const parts = group.versions.map((version) => `${version.version} (via ${version.via})`);
    const conflict = group.versions.length > 1 ? "  \u2190 version conflict!" : "";
    lines.push(`  ${group.name.padEnd(12)}${parts.join(" + ")}${conflict}`);
  }

  const totalWastedBytes = groups.reduce((sum, group) => sum + group.wastedBytes, 0);
  lines.push("");
  lines.push(`Total: ${groups.length} duplicates, ~${formatBytes(totalWastedBytes)} wasted`);
  lines.push("Run: npm dedupe  (may help with minor/patch dups)");
  return lines.join("\n");
}

async function collectPackageJsonPaths(rootPath: string): Promise<string[]> {
  const entries: string[] = [];
  await walkNodeModules(rootPath, entries);
  return entries;
}

async function walkNodeModules(currentPath: string, entries: string[]): Promise<void> {
  let dirEntries;
  try {
    dirEntries = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }

    throw error;
  }

  const packageJsonPath = join(currentPath, "package.json");
  try {
    await stat(packageJsonPath);
    entries.push(packageJsonPath);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  for (const entry of dirEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    await walkNodeModules(join(currentPath, entry.name), entries);
  }
}

async function loadPackageInstance(cwd: string, packageJsonPath: string): Promise<PackageInstance & { name: string }> {
  const source = await readFile(packageJsonPath, "utf8");
  const manifest = JSON.parse(source) as { name?: string; version?: string };
  const packagePath = packageJsonPath.slice(0, -"/package.json".length);
  const packageName = manifest.name ?? relative(join(cwd, "node_modules"), packagePath);

  return {
    name: packageName,
    version: manifest.version ?? "unknown",
    packagePath,
    via: describeVia(cwd, packagePath),
    sizeBytes: await getDirectorySize(packagePath)
  };
}

function createDuplicateGroup(name: string, entries: PackageInstance[]): DuplicatePackageGroup | undefined {
  const versions = new Map<string, PackageInstance[]>();
  for (const entry of entries) {
    const bucket = versions.get(entry.version) ?? [];
    bucket.push(entry);
    versions.set(entry.version, bucket);
  }

  if (versions.size < 2) {
    return undefined;
  }

  const versionEntries = [...versions.entries()]
    .map(([version, items]) => ({
      version,
      via: items[0]?.via ?? "unknown",
      sizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
      count: items.length
    }))
    .sort((left, right) => left.version.localeCompare(right.version));
  const keepBytes = Math.max(...versionEntries.map((entry) => entry.sizeBytes));
  const wastedBytes = versionEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0) - keepBytes;

  return { name, versions: versionEntries, wastedBytes };
}

async function getDirectorySize(directoryPath: string): Promise<number> {
  const dirEntries = await readdir(directoryPath, { withFileTypes: true });
  let total = 0;

  for (const entry of dirEntries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(entryPath);
      continue;
    }

    if (entry.isFile()) {
      total += (await stat(entryPath)).size;
    }
  }

  return total;
}

function describeVia(cwd: string, packagePath: string): string {
  const relativePath = relative(join(cwd, "node_modules"), packagePath);
  const segments = relativePath.split("/node_modules/");
  if (segments.length <= 1) {
    return "your-project";
  }

  const parent = segments.at(-2);
  return parent?.split("/").at(-1) ?? "unknown";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
