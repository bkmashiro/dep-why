import { readFile } from "node:fs/promises";
import { join } from "node:path";

import yaml from "js-yaml";

export type NodeKind = "root" | "prod" | "dev" | "optional" | "peer";

export interface GraphNode {
  id: string;
  name: string;
  version?: string;
  kind: NodeKind;
}

export interface DependencyGraph {
  rootId: string;
  nodes: Map<string, GraphNode>;
  edges: Map<string, Set<string>>;
}

interface PackageLockV3 {
  name?: string;
  packages?: Record<
    string,
    {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      dev?: boolean;
    }
  >;
}

interface PnpmLockfile {
  importers?: Record<
    string,
    {
      dependencies?: Record<string, string | { version?: string }>;
      devDependencies?: Record<string, string | { version?: string }>;
      optionalDependencies?: Record<string, string | { version?: string }>;
    }
  >;
  packages?: Record<
    string,
    {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }
  >;
}

const ROOT_ID = "root";
const DEFAULT_IMPORTER = ".";

export async function loadGraph(cwd: string): Promise<DependencyGraph> {
  const packageLockPath = join(cwd, "package-lock.json");
  const pnpmLockPath = join(cwd, "pnpm-lock.yaml");

  try {
    const packageLock = await readFile(packageLockPath, "utf8");
    return parsePackageLock(packageLock);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  try {
    const pnpmLock = await readFile(pnpmLockPath, "utf8");
    return parsePnpmLock(pnpmLock);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  throw new Error("No supported lockfile found. Expected package-lock.json or pnpm-lock.yaml.");
}

export function parsePackageLock(source: string): DependencyGraph {
  const lockfile = JSON.parse(source) as PackageLockV3;
  const packages = lockfile.packages ?? {};
  const graph = createGraph(lockfile.name ?? "your-project");
  const pathToId = new Map<string, string>();

  for (const [packagePath, pkg] of Object.entries(packages)) {
    if (packagePath === "") {
      continue;
    }

    const name = pkg.name ?? packagePath.split("node_modules/").at(-1);
    if (!name) {
      continue;
    }

    const id = packageNodeId(name, pkg.version);
    const kind: NodeKind = pkg.dev ? "dev" : "prod";
    upsertNode(graph, { id, name, version: pkg.version, kind });
    pathToId.set(packagePath, id);
  }

  const rootPackage = packages[""];
  addPackageLockRootEdges(graph, rootPackage?.dependencies, pathToId, "prod");
  addPackageLockRootEdges(graph, rootPackage?.devDependencies, pathToId, "dev");
  addPackageLockRootEdges(graph, rootPackage?.optionalDependencies, pathToId, "optional");
  addPackageLockRootEdges(graph, rootPackage?.peerDependencies, pathToId, "peer");

  for (const [packagePath, pkg] of Object.entries(packages)) {
    if (packagePath === "") {
      continue;
    }

    const name = pkg.name ?? packagePath.split("node_modules/").at(-1);
    if (!name) {
      continue;
    }

    const fromId = packageNodeId(name, pkg.version);
    addPackageLockEdges(graph, packagePath, fromId, pkg.dependencies, pathToId, "prod");
    addPackageLockEdges(graph, packagePath, fromId, pkg.optionalDependencies, pathToId, "optional");
    addPackageLockEdges(graph, packagePath, fromId, pkg.peerDependencies, pathToId, "peer");
  }

  return graph;
}

export function parsePnpmLock(source: string): DependencyGraph {
  const lockfile = yaml.load(source) as PnpmLockfile;
  const importer = lockfile.importers?.[DEFAULT_IMPORTER] ?? firstImporter(lockfile.importers);
  const graph = createGraph("your-project");

  for (const [packageKey, pkg] of Object.entries(lockfile.packages ?? {})) {
    const version = pkg.version ?? versionFromPnpmKey(packageKey);
    const name = pkg.name ?? nameFromPnpmKey(packageKey);
    if (!name) {
      continue;
    }

    const id = packageNodeId(name, version);
    upsertNode(graph, { id, name, version, kind: "prod" });
  }

  addRootEdges(graph, importer?.dependencies, "prod");
  addRootEdges(graph, importer?.devDependencies, "dev");
  addRootEdges(graph, importer?.optionalDependencies, "optional");

  for (const [packageKey, pkg] of Object.entries(lockfile.packages ?? {})) {
    const version = pkg.version ?? versionFromPnpmKey(packageKey);
    const name = pkg.name ?? nameFromPnpmKey(packageKey);
    if (!name) {
      continue;
    }

    const fromId = packageNodeId(name, version);
    addPackageEdges(graph, fromId, pkg.dependencies, "prod");
    addPackageEdges(graph, fromId, pkg.optionalDependencies, "optional");
    addPackageEdges(graph, fromId, pkg.peerDependencies, "peer");
  }

  return graph;
}

export function findDependencyPaths(
  graph: DependencyGraph,
  targetPackage: string,
  maxDepth = 10
): string[][] {
  return findDependencyNodePaths(
    graph,
    (node) => node.name === targetPackage,
    maxDepth
  ).map((path) => path.map((id) => formatPathNode(graph, id)));
}

export function findDependencyNodePaths(
  graph: DependencyGraph,
  matcher: (node: GraphNode) => boolean,
  maxDepth = 10
): string[][] {
  const queue: Array<{ id: string; path: string[] }> = [{ id: graph.rootId, path: [graph.rootId] }];
  const found = new Set<string>();
  const results: string[][] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    if (current.path.length - 1 >= maxDepth) {
      continue;
    }

    const neighbors = [...(graph.edges.get(current.id) ?? new Set<string>())];
    for (const neighborId of neighbors) {
      if (current.path.includes(neighborId)) {
        continue;
      }

      const nextPath = [...current.path, neighborId];
      const node = graph.nodes.get(neighborId);
      if (!node) {
        continue;
      }

      if (matcher(node)) {
        const key = nextPath.join("\u0000");
        if (!found.has(key)) {
          found.add(key);
          results.push(nextPath);
        }
        continue;
      }

      queue.push({ id: neighborId, path: nextPath });
    }
  }

  return results;
}

export function getTargetVersion(
  graph: DependencyGraph,
  targetPackage: string,
  paths: string[][]
): string | undefined {
  if (paths.length === 0) {
    return undefined;
  }

  const firstPath = paths[0];
  const lastName = firstPath[firstPath.length - 1];
  const node = [...graph.nodes.values()].find((candidate) => {
    if (candidate.name !== targetPackage) {
      return false;
    }

    const formatted = formatPathNode(graph, candidate.id);
    return formatted === lastName;
  });

  return node?.version;
}

function createGraph(rootName: string): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  nodes.set(ROOT_ID, { id: ROOT_ID, name: rootName, kind: "root" });

  return {
    rootId: ROOT_ID,
    nodes,
    edges: new Map<string, Set<string>>()
  };
}

function addRootEdges(
  graph: DependencyGraph,
  dependencies: Record<string, string | { version?: string }> | undefined,
  kind: Exclude<NodeKind, "root">
): void {
  if (!dependencies) {
    return;
  }

  for (const [name, spec] of Object.entries(dependencies)) {
    const version = normalizeVersionSpec(spec);
    const id = resolveNodeId(graph, name, version);
    upsertNode(graph, { id, name, version: graph.nodes.get(id)?.version ?? version, kind });
    addEdge(graph, ROOT_ID, id);
  }
}

function addPackageEdges(
  graph: DependencyGraph,
  fromId: string,
  dependencies: Record<string, string> | undefined,
  kind: Exclude<NodeKind, "root">
): void {
  if (!dependencies) {
    return;
  }

  for (const [name, spec] of Object.entries(dependencies)) {
    const version = normalizeVersionSpec(spec);
    const id = resolveNodeId(graph, name, version);
    upsertNode(graph, { id, name, version: graph.nodes.get(id)?.version ?? version, kind });
    addEdge(graph, fromId, id);
  }
}

function addPackageLockRootEdges(
  graph: DependencyGraph,
  dependencies: Record<string, string> | undefined,
  pathToId: Map<string, string>,
  kind: Exclude<NodeKind, "root">
): void {
  if (!dependencies) {
    return;
  }

  for (const name of Object.keys(dependencies)) {
    const resolvedId = resolvePackageLockId("", name, pathToId);
    if (resolvedId) {
      addEdge(graph, ROOT_ID, resolvedId);
      continue;
    }

    const id = packageNodeId(name, normalizeVersionSpec(dependencies[name]));
    upsertNode(graph, { id, name, version: normalizeVersionSpec(dependencies[name]), kind });
    addEdge(graph, ROOT_ID, id);
  }
}

function addPackageLockEdges(
  graph: DependencyGraph,
  packagePath: string,
  fromId: string,
  dependencies: Record<string, string> | undefined,
  pathToId: Map<string, string>,
  kind: Exclude<NodeKind, "root">
): void {
  if (!dependencies) {
    return;
  }

  for (const [name, spec] of Object.entries(dependencies)) {
    const resolvedId = resolvePackageLockId(packagePath, name, pathToId);
    if (resolvedId) {
      addEdge(graph, fromId, resolvedId);
      continue;
    }

    const version = normalizeVersionSpec(spec);
    const id = packageNodeId(name, version);
    upsertNode(graph, { id, name, version, kind });
    addEdge(graph, fromId, id);
  }
}

function addEdge(graph: DependencyGraph, from: string, to: string): void {
  const neighbors = graph.edges.get(from) ?? new Set<string>();
  neighbors.add(to);
  graph.edges.set(from, neighbors);
}

function upsertNode(graph: DependencyGraph, node: GraphNode): void {
  const existing = graph.nodes.get(node.id);
  if (!existing) {
    graph.nodes.set(node.id, node);
    return;
  }

  if (existing.kind === "prod" && node.kind !== "prod") {
    return;
  }

  if (existing.kind !== "prod" && node.kind === "prod") {
    graph.nodes.set(node.id, node);
  }
}

function packageNodeId(name: string, version?: string): string {
  return version ? `${name}@${version}` : name;
}

function resolveNodeId(graph: DependencyGraph, name: string, version?: string): string {
  if (version) {
    const exactId = packageNodeId(name, version);
    if (graph.nodes.has(exactId)) {
      return exactId;
    }
  }

  const matches = [...graph.nodes.values()].filter((node) => node.name === name);
  if (matches.length === 1) {
    return matches[0].id;
  }

  return packageNodeId(name, version);
}

function normalizeVersionSpec(value: string | { version?: string }): string | undefined {
  if (typeof value === "string") {
    return cleanVersion(value);
  }

  return cleanVersion(value.version);
}

function cleanVersion(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const withoutPeers = value.split("(")[0];
  const match = withoutPeers.match(/\d+\.\d+\.\d+[^/]*/);
  if (match) {
    return match[0];
  }

  const trimmed = withoutPeers.replace(/^workspace:/, "").replace(/^npm:/, "");
  return trimmed || undefined;
}

function formatPathNode(graph: DependencyGraph, id: string): string {
  const node = graph.nodes.get(id);
  if (!node) {
    return id;
  }

  return node.name;
}

function resolvePackageLockId(
  packagePath: string,
  dependencyName: string,
  pathToId: Map<string, string>
): string | undefined {
  const candidatePaths = packageLockCandidatePaths(packagePath, dependencyName);
  for (const candidate of candidatePaths) {
    const id = pathToId.get(candidate);
    if (id) {
      return id;
    }
  }

  return undefined;
}

function packageLockCandidatePaths(packagePath: string, dependencyName: string): string[] {
  const candidates: string[] = [];
  let currentPath = packagePath;

  while (true) {
    const base = currentPath ? `${currentPath}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`;
    candidates.push(base);

    const parent = parentPackagePath(currentPath);
    if (parent === currentPath) {
      break;
    }

    currentPath = parent;
  }

  return candidates;
}

function parentPackagePath(packagePath: string): string {
  if (!packagePath) {
    return packagePath;
  }

  const marker = "/node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index === -1) {
    return "";
  }

  return packagePath.slice(0, index);
}

function nameFromPnpmKey(packageKey: string): string | undefined {
  const normalized = packageKey.startsWith("/") ? packageKey.slice(1) : packageKey;
  const withoutPeers = normalized.split("(")[0];

  if (!withoutPeers.includes("/")) {
    const scopedSeparator = withoutPeers.lastIndexOf("@");
    return scopedSeparator > 0 ? withoutPeers.slice(0, scopedSeparator) : withoutPeers;
  }

  if (withoutPeers.startsWith("@")) {
    const slashIndex = withoutPeers.indexOf("/", 1);
    const versionSeparator = withoutPeers.lastIndexOf("@");
    if (slashIndex !== -1 && versionSeparator > slashIndex) {
      return withoutPeers.slice(0, versionSeparator);
    }

    const segments = withoutPeers.split("/");
    if (segments.length >= 2) {
      return `${segments[0]}/${segments[1]}`;
    }
    return undefined;
  }

  const slashIndex = withoutPeers.lastIndexOf("/");
  const atIndex = withoutPeers.lastIndexOf("@");
  if (atIndex > slashIndex) {
    return withoutPeers.slice(0, atIndex);
  }

  return slashIndex === -1 ? withoutPeers : withoutPeers.slice(0, slashIndex);
}

function versionFromPnpmKey(packageKey: string): string | undefined {
  const normalized = packageKey.startsWith("/") ? packageKey.slice(1) : packageKey;
  const withoutPeers = normalized.split("(")[0];
  const slashIndex = withoutPeers.lastIndexOf("/");
  const atIndex = withoutPeers.lastIndexOf("@");

  if (!withoutPeers.includes("/")) {
    return atIndex > 0 ? cleanVersion(withoutPeers.slice(atIndex + 1)) : undefined;
  }

  if (withoutPeers.startsWith("@") && atIndex > slashIndex) {
    return cleanVersion(withoutPeers.slice(atIndex + 1));
  }

  const index = withoutPeers.lastIndexOf("/");
  if (index === -1) {
    return undefined;
  }

  return cleanVersion(withoutPeers.slice(index + 1));
}

function firstImporter(
  importers: PnpmLockfile["importers"]
): NonNullable<PnpmLockfile["importers"]>[string] | undefined {
  const first = Object.keys(importers ?? {})[0];
  return first ? importers?.[first] : undefined;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
