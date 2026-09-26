/** GitHub Actions entry point; dependencies are bundled in dist/index.cjs. */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { analyze, markdown } from "./impact.js";

/** GitHub exposes JavaScript action inputs as INPUT_<NAME> environment variables. */
function input(name: string, required = false): string {
  const value = (
    process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`] ?? ""
  ).trim();
  if (required && !value)
    throw new Error(`Input required and not supplied: ${name}`);
  return value;
}

function booleanInput(name: string, defaultValue: boolean): boolean {
  const raw = input(name) || String(defaultValue);
  if (raw !== "true" && raw !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return raw === "true";
}

function run(): void {
  const result = analyze(
    input("before-file", true),
    input("after-file", true),
    input("provider", true),
    input("callers-root", true),
  );
  const summary = markdown(result);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }

  const reportFile = input("report-file");
  if (reportFile) {
    mkdirSync(dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  const broken = new Set(
    result.findings
      .filter(
        (finding) =>
          finding.severity === "break" && finding.timing === "on ref update",
      )
      .map((finding) => finding.caller),
  );
  if (process.env.GITHUB_OUTPUT) {
    // Both values are integers, so the single-line environment-file form is safe.
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `affected-count=${broken.size}\nmatched-count=${result.matched_jobs}\n`,
      "utf8",
    );
  }

  if (result.matched_jobs === 0 && booleanInput("require-matches", true)) {
    throw new Error("no callers matched; check the provider and callers-root");
  }
  if (broken.size > 0 && booleanInput("fail-on-impact", true)) {
    throw new Error(
      `${broken.size} caller job(s) have definite breaks on moving refs`,
    );
  }
}

try {
  run();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Escape control characters in the GitHub workflow command.
  const escaped = message
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  process.stderr.write(`::error::${escaped}\n`);
  process.exitCode = 1;
}
