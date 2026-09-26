/** Behavioural tests for interface changes and action outputs. */

import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { analyze, markdown } from "../src/impact.js";

const provider = "Example/automation/.github/workflows/build.yml";

function write(root: string, name: string, content: string): string {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function fixture(t: TestContext): {
  root: string;
  before: string;
  after: string;
  callers: string;
} {
  const root = mkdtempSync(join(tmpdir(), "workflow-impact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = write(
    root,
    "old.yml",
    `on:
  workflow_call:
    inputs:
      old-input:
        type: string
        required: false
      mode:
        type: string
        default: fast
    outputs:
      artifact:
        value: example
`,
  );
  const after = write(
    root,
    "new.yml",
    `on:
  workflow_call:
    inputs:
      mode:
        type: string
        default: safe
      target:
        type: string
        required: true
`,
  );
  const callers = join(root, "consumers");
  mkdirSync(callers);
  return { root, before, after, callers };
}

void test("moving callers break while exact version callers are affected on upgrade", (t) => {
  const { before, after, callers } = fixture(t);
  write(
    callers,
    "team/project/.github/workflows/ci.yml",
    `name: CI
on: push
jobs:
  build:
    uses: ${provider}@v1
    with:
      old-input: legacy
  consume:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ needs.build.outputs.artifact }}
`,
  );
  write(
    callers,
    "team/other/.github/workflows/ci.yaml",
    `jobs:
  build:
    uses: ${provider}@v1.0.0
    with:
      old-input: legacy
`,
  );
  const result = analyze(before, after, provider, callers);
  assert.equal(result.scanned_files, 2);
  assert.equal(result.matched_jobs, 2);
  assert.deepEqual(
    new Set(
      result.findings
        .filter((item) => item.timing === "on ref update")
        .map((item) => item.reason),
    ),
    new Set([
      "passes removed input old-input",
      "does not pass required input target",
      "reads removed output artifact",
      "relies on changed default for mode",
    ]),
  );
  assert.equal(
    result.findings.filter((item) => item.timing === "on upgrade").length,
    3,
  );
});

void test("inherited secrets are reported for review, not as a definite break", (t) => {
  const { before, after, callers } = fixture(t);
  writeFileSync(
    after,
    `on:
  workflow_call:
    inputs:
      old-input:
        type: string
      mode:
        type: string
        default: fast
    outputs:
      artifact: {}
    secrets:
      publish-token:
        required: true
`,
  );
  write(
    callers,
    "org/repo/.github/workflows/ci.yml",
    `jobs:
  build:
    uses: ${provider}@main
    secrets: inherit
`,
  );
  const result = analyze(before, after, provider, callers);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.severity, "review");
});

void test("unrelated callers do not produce findings", (t) => {
  const { before, after, callers } = fixture(t);
  write(
    callers,
    "org/repo/.github/workflows/ci.yml",
    `jobs:
  build:
    uses: another/repo/.github/workflows/build.yml@main
`,
  );
  const result = analyze(before, after, provider, callers);
  assert.ok(result.changes.length > 0);
  assert.equal(result.matched_jobs, 0);
  assert.deepEqual(result.findings, []);
});

void test("reports changed input types and explicitly passed secrets", (t) => {
  const { before, after, callers } = fixture(t);
  writeFileSync(
    before,
    `on:
  workflow_call:
    inputs:
      mode:
        type: string
        default: fast
    secrets:
      old-token: {}
`,
  );
  writeFileSync(
    after,
    `on:
  workflow_call:
    inputs:
      mode:
        type: boolean
        default: true
    secrets:
      new-token:
        required: true
`,
  );
  write(
    callers,
    "org/repo/.github/workflows/ci.yml",
    `jobs:
  deploy:
    uses: ${provider}@main
    with:
      mode: fast
    secrets:
      old-token: \${{ secrets.OLD_TOKEN }}
  default-mode:
    uses: ${provider}@v1.0.0
`,
  );
  const result = analyze(before, after, provider, callers);
  assert.equal(result.matched_jobs, 2);
  assert.deepEqual(
    new Set(result.findings.map((finding) => finding.reason)),
    new Set([
      "passes input mode whose type changed",
      "relies on changed default for mode",
      "passes removed secret old-token",
      "must provide required secret new-token",
    ]),
  );
  assert.equal(
    result.findings.filter((finding) => finding.timing === "on upgrade").length,
    2,
  );
  assert.match(markdown(result), /passes removed secret old-token/);
});

void test("rejects malformed workflow declarations instead of claiming a safe result", (t) => {
  const { before, after, callers } = fixture(t);
  writeFileSync(
    after,
    "on:\n  workflow_call:\n    inputs:\n      target:\n        required: yes\n",
  );
  assert.throws(
    () => analyze(before, after, provider, callers),
    /required must be a boolean/,
  );
  writeFileSync(after, "on:\n  workflow_call: []\n");
  assert.throws(
    () => analyze(before, after, provider, callers),
    /workflow_call must be a mapping/,
  );
  writeFileSync(after, "on:\n  workflow_call:\n    inputs: {}\n");
  assert.throws(
    () => analyze(before, after, "invalid-ref", callers),
    /provider must be/,
  );
  assert.throws(
    () => analyze(before, after, provider, join(callers, "missing")),
    /Callers directory/,
  );
});

void test("bundled action writes outputs and fails only for definite moving-ref breaks", (t) => {
  const { root, before, after, callers } = fixture(t);
  write(
    callers,
    "org/repo/.github/workflows/ci.yml",
    `jobs:
  build:
    uses: ${provider}@main
`,
  );
  const output = join(root, "output.txt");
  const summary = join(root, "summary.md");
  const report = join(root, "reports", "impact.json");
  // The GitHub runner creates command files before invoking the action.
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const bundle = join(import.meta.dirname, "..", "dist", "index.cjs");
  const env = {
    ...process.env,
    "INPUT_BEFORE-FILE": before,
    "INPUT_AFTER-FILE": after,
    INPUT_PROVIDER: provider,
    "INPUT_CALLERS-ROOT": callers,
    "INPUT_REPORT-FILE": report,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
  };
  const blocked = spawnSync(process.execPath, [bundle], {
    env,
    encoding: "utf8",
  });
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(readFileSync(output, "utf8"), /affected-count=1\n/);
  assert.match(readFileSync(output, "utf8"), /matched-count=1\n/);
  assert.match(readFileSync(summary, "utf8"), /required input target/);
  const parsedReport: unknown = JSON.parse(readFileSync(report, "utf8"));
  assert.ok(
    parsedReport !== null &&
      typeof parsedReport === "object" &&
      "matched_jobs" in parsedReport,
  );
  assert.equal(parsedReport.matched_jobs, 1);

  const reported = spawnSync(process.execPath, [bundle], {
    env: { ...env, "INPUT_FAIL-ON-IMPACT": "false" },
    encoding: "utf8",
  });
  assert.equal(reported.status, 0, reported.stderr);
  const unmatched = spawnSync(process.execPath, [bundle], {
    env: { ...env, INPUT_PROVIDER: "other/repo/.github/workflows/build.yml" },
    encoding: "utf8",
  });
  assert.equal(unmatched.status, 1, unmatched.stderr);
});

void test("bundled action requires exactly one caller source", (t) => {
  const { before, after, callers } = fixture(t);
  const bundle = join(import.meta.dirname, "..", "dist", "index.cjs");
  const env = {
    ...process.env,
    "INPUT_BEFORE-FILE": before,
    "INPUT_AFTER-FILE": after,
    INPUT_PROVIDER: provider,
  };
  const missing = spawnSync(process.execPath, [bundle], {
    env,
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Supply exactly one/);
  const both = spawnSync(process.execPath, [bundle], {
    env: {
      ...env,
      "INPUT_CALLERS-ROOT": callers,
      "INPUT_CALLER-REPOSITORIES": "acme/app",
    },
    encoding: "utf8",
  });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /Supply exactly one/);
});
