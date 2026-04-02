# dep-why

A CLI that explains why a package is present in your `node_modules` by tracing the full dependency chain from your project root.

## Install

```bash
npm i -g dep-why
```

## Usage

```bash
dep-why <package> [options]
```

Options:

```text
--cwd <path>     Project directory (default: cwd)
--json           JSON output
--max-depth <n>  Max path depth to show (default: 10)
--all            Show all paths (default: top 5)
```

Examples:

```bash
dep-why lodash
dep-why react --cwd ~/projects/app
dep-why chalk --json --all
dep-why eslint --max-depth 4
```

Example output:

```text
lodash@4.17.21 is required by:
  your-project -> webpack -> enhanced-resolve -> lodash
  your-project -> jest -> @jest/transform -> lodash
  your-project -> eslint -> lodash

3 dependency path(s) found.
```

## How It Works

`dep-why` reads either:

- `package-lock.json` lockfile version 3
- `pnpm-lock.yaml`

It builds a dependency graph from the lockfile, then runs breadth-first search from your project root to discover every path that leads to the target package name. Output is colorized for terminal use and can also be emitted as JSON.

## Comparison With `npm why`

`npm why` is tied to npm’s installed dependency tree and focuses on npm projects. `dep-why` is intentionally small, lockfile-driven, and supports both npm and pnpm lockfiles from the current working tree without requiring `node_modules` traversal.
