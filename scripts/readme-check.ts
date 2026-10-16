// Extract and typecheck every fenced TypeScript block without executing it.
// Run after npm run build: node scripts/readme-check.ts [packages/<kit>/README.md ...]
// Existing gaps are frozen in readme-baseline.json; changing code or diagnostics
// invalidates its snapshot. Passing examples never need a baseline entry.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export interface Example {
  line: number;
  code: string;
  jsx?: true;
}

export interface BlockResult {
  readme: string;
  block: number; // 1-based TS block, 0 means no TypeScript example
  line: number;
  code: string;
  diagnostics: { start: number; code: number; message: string }[];
}

export interface BaselineEntry {
  readme: string;
  block: number;
  snapshot: string;
  reason: string;
}

export function examples(markdown: string): Example[] {
  const found: Example[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(`{3,}|~{3,})(\S*)\s*$/.exec(lines[i]);
    if (!fence) continue;
    const start = i + 1;
    const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
    while (++i < lines.length && !close.test(lines[i])) { /* fenced content */ }
    if (i === lines.length) throw new Error(`unclosed fence at line ${start}`);
    if (["ts", "typescript", "tsx"].includes(fence[2])) {
      found.push({ line: start + 1, code: lines.slice(start, i).join("\n"), ...(fence[2] === "tsx" ? { jsx: true as const } : {}) });
    }
  }
  return found;
}

export function snapshot(result: BlockResult): string {
  return createHash("sha256").update(JSON.stringify({ code: result.code, diagnostics: result.diagnostics })).digest("hex");
}

export function allowedFailure(result: BlockResult, baseline: BaselineEntry[]): boolean {
  return baseline.some((entry) => entry.readme === result.readme && entry.block === result.block &&
    entry.reason.trim() !== "" && entry.snapshot === snapshot(result));
}

export function analyze(readmes: string[]): BlockResult[] {
  // Ordinary NodeNext resolution against built workspace exports; no aliases
  // pointing into src that would hide broken declarations or exports maps.
  const scratch = mkdtempSync(join(root, ".readme-check-"));
  const results: BlockResult[] = [];
  try {
    const sources = new Map<string, BlockResult>();
    for (const readme of readmes) {
      const blocks = examples(readFileSync(readme, "utf8"));
      if (blocks.length === 0) {
        results.push({ readme: relative(root, readme), block: 0, line: 1, code: "", diagnostics: [
          { start: 0, code: 0, message: "no TypeScript example" },
        ] });
      }
      for (const [index, example] of blocks.entries()) {
        const path = join(scratch, `example-${sources.size}.${example.jsx ? "tsx" : "mts"}`);
        writeFileSync(path, `${example.code}\nexport {};\n`);
        const result = { readme: relative(root, readme), block: index + 1, line: example.line, code: example.code, diagnostics: [] } as BlockResult;
        results.push(result);
        sources.set(path, result);
      }
    }
    // TypeScript 7 has no stable JS compiler API, so run its tsc on a scratch project.
    const config = join(scratch, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ files: [...sources.keys()], compilerOptions: {
      module: "nodenext", moduleResolution: "nodenext", target: "es2023", jsx: "react-jsx", strict: true,
      noEmit: true, skipLibCheck: true, types: ["node"], lib: ["es2023", "dom"],
    } }));
    const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");
    const run = spawnSync(process.execPath, [tsc, "-p", config, "--pretty", "false"], { encoding: "utf8" });
    if (run.error) throw run.error;
    // Each diagnostic is "file(line,col): error TSn: message"; chained messages continue on indented lines.
    let current: { start: number; code: number; message: string } | undefined;
    for (const text of run.stdout.split(/\r?\n/)) {
      if (current && /^\s/.test(text)) { current.message += `\n${text}`; continue; }
      if (!text.trim()) continue;
      const match = /^(.+)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(text);
      const source = match && sources.get(resolve(match[1]));
      // Compiler/config/dependency errors outside an extracted file must fail.
      if (!match || !source) throw new Error(`readme-check: ${text}`);
      const lines = source.code.split("\n");
      const start = lines.slice(0, Number(match[2]) - 1).reduce((n, l) => n + l.length + 1, 0) + Number(match[3]) - 1;
      current = { start, code: Number(match[4]), message: match[5] };
      source.diagnostics.push(current);
    }
    if (run.status !== 0 && results.every((r) => r.block === 0 || r.diagnostics.length === 0)) {
      throw new Error(`readme-check: tsc exited ${run.status}: ${run.stderr || run.stdout}`);
    }
    return results;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  const readmes = process.argv.slice(2).length > 0 ? process.argv.slice(2).map((p) => resolve(p)) :
    readdirSync(join(root, "packages"), { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => join(root, "packages", e.name, "README.md"));
  const baseline = JSON.parse(readFileSync(join(root, "scripts/readme-baseline.json"), "utf8")) as BaselineEntry[];
  const results = analyze(readmes);
  let failed = 0;
  let allowed = 0;
  for (const result of results) {
    if (result.diagnostics.length === 0) continue;
    if (allowedFailure(result, baseline)) {
      allowed++;
      console.log(`baseline: ${result.readme} block ${result.block || "missing"}`);
      continue;
    }
    failed++;
    for (const diagnostic of result.diagnostics) {
      const line = result.line + result.code.slice(0, diagnostic.start).split("\n").length - 1;
      console.error(`${result.readme}:${line}: TS${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  const used = new Set(results.filter((r) => r.diagnostics.length > 0 && allowedFailure(r, baseline))
    .map((r) => `${r.readme}:${r.block}`));
  for (const entry of baseline) {
    if (readmes.some((p) => relative(root, p) === entry.readme) && !used.has(`${entry.readme}:${entry.block}`)) {
      console.warn(`baseline no longer needed: ${entry.readme} block ${entry.block}; remove its entry`);
    }
  }
  console.log(`README examples: ${results.filter((r) => r.block > 0).length} blocks, ${allowed} existing gaps, ${failed} new failures in ${readmes.length} kits`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
