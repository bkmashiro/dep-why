import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const IMPORT_PATTERN =
  /\bimport\s+(?:type\s+)?[^"'\n]*?from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bexport\s+[^"'\n]*?from\s*["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)/g;

export interface ImportOccurrence {
  filePath: string;
  line: number;
  source: string;
  statement: string;
  importedNames: string[];
}

export interface SourceImportAnalysis {
  filesScanned: number;
  packages: Map<string, ImportOccurrence[]>;
}

export interface UnusedDependencyReport {
  dependencies: string[];
  devDependencies: string[];
  usedPackages: Set<string>;
  filesScanned: number;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function analyzeSourceImports(cwd: string): Promise<SourceImportAnalysis> {
  const sourceDir = join(cwd, "src");
  const filePaths = await walkSourceFiles(sourceDir);
  const packages = new Map<string, ImportOccurrence[]>();

  for (const filePath of filePaths) {
    const source = await readFile(filePath, "utf8");
    const occurrences = extractImportOccurrences(source, relative(cwd, filePath));

    for (const occurrence of occurrences) {
      const list = packages.get(occurrence.source) ?? [];
      list.push(occurrence);
      packages.set(occurrence.source, list);
    }
  }

  return { filesScanned: filePaths.length, packages };
}

export async function findUnusedDependencies(cwd: string): Promise<UnusedDependencyReport> {
  const packageJson = await loadPackageManifest(cwd);
  const analysis = await analyzeSourceImports(cwd);
  const usedPackages = new Set(analysis.packages.keys());
  const dependencies = Object.keys(packageJson.dependencies ?? {}).filter(
    (name) => !usedPackages.has(name)
  );
  const devDependencies = Object.keys(packageJson.devDependencies ?? {}).filter(
    (name) => !usedPackages.has(name)
  );

  return {
    dependencies: dependencies.sort(),
    devDependencies: devDependencies.sort(),
    usedPackages,
    filesScanned: analysis.filesScanned
  };
}

export function extractImportOccurrences(source: string, filePath: string): ImportOccurrence[] {
  const occurrences: ImportOccurrence[] = [];

  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const importPath = match.slice(1).find(Boolean);
    if (!importPath) {
      continue;
    }

    const packageName = resolvePackageName(importPath);
    if (!packageName) {
      continue;
    }

    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    const statement = source.slice(index, source.indexOf("\n", index) === -1 ? undefined : source.indexOf("\n", index)).trim();

    occurrences.push({
      filePath,
      line,
      source: packageName,
      statement,
      importedNames: extractImportedNames(statement)
    });
  }

  return occurrences;
}

export function resolvePackageName(importPath: string): string | undefined {
  if (
    !importPath ||
    importPath.startsWith(".") ||
    importPath.startsWith("/") ||
    importPath.startsWith("#") ||
    importPath.startsWith("node:")
  ) {
    return undefined;
  }

  if (importPath.startsWith("@")) {
    const [scope, name] = importPath.split("/");
    return scope && name ? `${scope}/${name}` : undefined;
  }

  return importPath.split("/")[0];
}

async function loadPackageManifest(cwd: string): Promise<PackageManifest> {
  const packageJsonPath = join(cwd, "package.json");
  const source = await readFile(packageJsonPath, "utf8");
  return JSON.parse(source) as PackageManifest;
}

async function walkSourceFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walkSourceFiles(fullPath)));
        continue;
      }

      if (entry.isFile() && hasSupportedExtension(entry.name)) {
        files.push(fullPath);
      }
    }

    return files.sort();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
}

function hasSupportedExtension(fileName: string): boolean {
  return [...SOURCE_EXTENSIONS].some((extension) => fileName.endsWith(extension));
}

function extractImportedNames(statement: string): string[] {
  const names = new Set<string>();
  const fromMatch = statement.match(/^\s*import\s+(?:type\s+)?(.+?)\s+from\s+["']/);
  if (fromMatch) {
    collectImportSpecifiers(fromMatch[1], names);
  }

  const requireMatch = statement.match(/\b(?:const|let|var)\s+(.+?)\s*=\s*require\(/);
  if (requireMatch) {
    collectImportSpecifiers(requireMatch[1], names);
  }

  return [...names];
}

function collectImportSpecifiers(specifier: string, names: Set<string>): void {
  const trimmed = specifier.trim();
  if (!trimmed) {
    return;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    addNamedSpecifiers(trimmed.slice(1, -1), names);
    return;
  }

  if (trimmed.startsWith("* as ")) {
    names.add(trimmed.slice(5).trim());
    return;
  }

  if (trimmed.includes("{")) {
    const [defaultPart, namedPart] = trimmed.split("{", 2);
    if (defaultPart.trim()) {
      names.add(defaultPart.trim().replace(/,$/, ""));
    }
    addNamedSpecifiers(namedPart.replace(/}$/, ""), names);
    return;
  }

  names.add(trimmed.replace(/,$/, "").trim());
}

function addNamedSpecifiers(specifiers: string, names: Set<string>): void {
  for (const specifier of specifiers.split(",")) {
    const cleaned = specifier.trim();
    if (!cleaned) {
      continue;
    }

    const localName = cleaned.split(/\s+as\s+/i).at(-1)?.trim();
    if (localName) {
      names.add(localName);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
