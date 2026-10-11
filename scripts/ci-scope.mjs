#!/usr/bin/env node
// Decides whether a CI area needs to do its heavy work, from the files a PR changed.
// Usage: node scripts/ci-scope.mjs <overlay|statusbar|record|browser>
// Writes run=true|false to $GITHUB_OUTPUT and prints it. Fail-open: a push to main, an unknown
// event, or any diff error runs the area, so a needed job is never skipped by mistake.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Root build tooling every area depends on: a change here can affect any package's build or tests.
const SHARED = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^scripts\//,
  /^\.github\//,
];

const AREAS = {
  // The Android jobs build and drive the Expo example app, so any change under examples/expo counts.
  overlay: [/^packages\/overlay\//, /^examples\/expo\//, ...SHARED],
  statusbar: [/^packages\/statusbar\//, /^examples\/expo\//, ...SHARED],
  record: [/^packages\/record\//, ...SHARED],
  // The browser job runs the browser kit tests plus the record example-recorder-browser journey.
  browser: [/^packages\/browser\//, /^packages\/record\//, /^examples\/expo\//, ...SHARED],
};

const area = process.argv[2];
const patterns = AREAS[area];
if (!patterns) {
  console.error(`ci-scope: unknown area "${area}" (want: ${Object.keys(AREAS).join(", ")})`);
  process.exit(2);
}

function decide() {
  if (process.env.GITHUB_EVENT_NAME === "push") return true; // main is always fully validated
  const base = process.env.GITHUB_BASE_REF;
  if (!base) return true;
  let files;
  try {
    execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base], { stdio: "ignore" });
    // Two-dot diff works on the shallow PR checkout: it needs both trees, not a merge base.
    files = execFileSync("git", ["diff", "--name-only", `origin/${base}`, "HEAD"], { encoding: "utf8" });
  } catch (error) {
    console.error(`ci-scope: ${area}: cannot diff against origin/${base} (${error.message}); running to be safe`);
    return true;
  }
  const changed = files.split("\n").map((line) => line.trim()).filter(Boolean);
  const matched = changed.filter((file) => patterns.some((pattern) => pattern.test(file)));
  if (matched.length) {
    console.log(`ci-scope: ${area}: ${matched.length} relevant change(s), e.g. ${matched.slice(0, 5).join(", ")}`);
  }
  return matched.length > 0;
}

const run = decide();
console.log(`ci-scope: ${area} run=${run}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
