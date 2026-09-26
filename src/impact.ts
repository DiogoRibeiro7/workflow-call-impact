/** Compare reusable workflow interfaces with checked-out caller jobs. */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parse } from "yaml";

type YamlObject = Record<string, unknown>;

export type ChangeKind =
  | "inputs_removed"
  | "secrets_removed"
  | "outputs_removed"
  | "required_input_added"
  | "required_secret_added"
  | "input_required"
  | "secret_required"
  | "input_type"
  | "input_default";

export interface Change {
  kind: ChangeKind;
  name: string;
  detail: string;
}

export interface Finding {
  caller: string;
  ref: string;
  timing: "on upgrade" | "on ref update";
  severity: "break" | "review";
  reason: string;
}

export interface Result {
  changes: Change[];
  findings: Finding[];
  scanned_files: number;
  matched_jobs: number;
}

type InterfaceField = "inputs" | "secrets" | "outputs";
type CallInterface = Record<InterfaceField, Record<string, YamlObject>>;

/** Validate a YAML mapping before reading its fields. */
function mapping(value: unknown, where: string): YamlObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be a mapping with string keys`);
  }
  return value as YamlObject;
}

/** YAML 1.2 keeps GitHub's `on` key as text, unlike PyYAML's YAML 1.1 rules. */
function readWorkflow(path: string): YamlObject {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"), { uniqueKeys: true });
  } catch (error) {
    throw new Error(`Cannot read workflow ${path}: ${String(error)}`);
  }
  return mapping(raw, path);
}

function readInterface(path: string): CallInterface {
  const workflow = readWorkflow(path);
  const triggers = mapping(workflow.on, `${path}: on`);
  const call = mapping(triggers.workflow_call ?? {}, `${path}: workflow_call`);
  const result: CallInterface = { inputs: {}, secrets: {}, outputs: {} };
  for (const field of ["inputs", "secrets", "outputs"] as const) {
    const entries = mapping(
      call[field] ?? {},
      `${path}: workflow_call.${field}`,
    );
    result[field] = Object.fromEntries(
      Object.entries(entries).map(([name, value]) => [
        name,
        mapping(value ?? {}, `${path}: ${field}.${name}`),
      ]),
    );
  }
  return result;
}

function required(spec: YamlObject): boolean {
  const value = spec.required ?? false;
  if (typeof value !== "boolean") {
    throw new Error(`required must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Describe changes without assuming they affect every caller. */
export function compare(before: string, after: string): Change[] {
  const oldInterface = readInterface(before);
  const newInterface = readInterface(after);
  const changes: Change[] = [];
  for (const field of ["inputs", "secrets", "outputs"] as const) {
    const oldValues = oldInterface[field];
    const newValues = newInterface[field];
    const singular = field.slice(0, -1);
    for (const name of Object.keys(oldValues)
      .filter((key) => !Object.hasOwn(newValues, key))
      .sort()) {
      changes.push({
        kind: `${field}_removed` as ChangeKind,
        name,
        detail: `${singular} removed`,
      });
    }
    for (const name of Object.keys(newValues)
      .filter((key) => !Object.hasOwn(oldValues, key))
      .sort()) {
      const spec = newValues[name];
      if (field !== "outputs" && spec && required(spec)) {
        changes.push({
          kind: `required_${singular}_added` as ChangeKind,
          name,
          detail: "new required value",
        });
      }
    }
    for (const name of Object.keys(oldValues)
      .filter((key) => Object.hasOwn(newValues, key))
      .sort()) {
      const previous = oldValues[name];
      const current = newValues[name];
      if (!previous || !current) continue;
      if (field !== "outputs" && !required(previous) && required(current)) {
        changes.push({
          kind: `${singular}_required` as ChangeKind,
          name,
          detail: "became required",
        });
      }
      if (field === "inputs") {
        if (previous.type !== current.type) {
          changes.push({ kind: "input_type", name, detail: "type changed" });
        }
        if (previous.default !== current.default) {
          changes.push({
            kind: "input_default",
            name,
            detail: "default changed",
          });
        }
      }
    }
  }
  return changes;
}

/** Visit workflow files in checked-out repositories, without following symlinks. */
function callerFiles(root: string): string[] {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Callers directory does not exist: ${root}`);
  }
  const paths: string[] = [];
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (
        entry.isDirectory() &&
        entry.name !== ".git" &&
        entry.name !== "node_modules"
      ) {
        visit(path);
      } else if (
        entry.isFile() &&
        /\.ya?ml$/.test(entry.name) &&
        basename(folder) === "workflows" &&
        basename(dirname(folder)) === ".github"
      ) {
        paths.push(path);
      }
    }
  };
  visit(root);
  return paths.sort();
}

function refTiming(ref: string): Finding["timing"] {
  return /^[a-fA-F0-9]{40}$/.test(ref) ||
    /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(ref)
    ? "on upgrade"
    : "on ref update";
}

function outputUsed(
  workflow: YamlObject,
  jobId: string,
  output: string,
): boolean {
  const escape = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `needs\\.${escape(jobId)}\\.outputs\\.${escape(output)}\\b`,
  );
  return expression.test(JSON.stringify(workflow));
}

function evaluate(
  changes: Change[],
  workflow: YamlObject,
  jobId: string,
  job: YamlObject,
  caller: string,
  ref: string,
): Finding[] {
  const passed = mapping(job.with ?? {}, `${caller}: with`);
  const inherited = job.secrets === "inherit";
  const named = inherited
    ? {}
    : mapping(job.secrets ?? {}, `${caller}: secrets`);
  const findings: Finding[] = [];
  for (const change of changes) {
    const name = change.name;
    let severity: Finding["severity"] | undefined;
    let reason = "";
    if (change.kind === "inputs_removed" && Object.hasOwn(passed, name)) {
      [severity, reason] = ["break", `passes removed input ${name}`];
    } else if (
      (change.kind === "required_input_added" ||
        change.kind === "input_required") &&
      !Object.hasOwn(passed, name)
    ) {
      [severity, reason] = ["break", `does not pass required input ${name}`];
    } else if (change.kind === "input_type" && Object.hasOwn(passed, name)) {
      [severity, reason] = [
        "review",
        `passes input ${name} whose type changed`,
      ];
    } else if (
      change.kind === "input_default" &&
      !Object.hasOwn(passed, name)
    ) {
      [severity, reason] = ["review", `relies on changed default for ${name}`];
    } else if (
      change.kind === "secrets_removed" &&
      Object.hasOwn(named, name)
    ) {
      [severity, reason] = ["break", `passes removed secret ${name}`];
    } else if (
      (change.kind === "required_secret_added" ||
        change.kind === "secret_required") &&
      !Object.hasOwn(named, name)
    ) {
      [severity, reason] = [
        inherited ? "review" : "break",
        `must provide required secret ${name}`,
      ];
    } else if (
      change.kind === "outputs_removed" &&
      outputUsed(workflow, jobId, name)
    ) {
      [severity, reason] = ["break", `reads removed output ${name}`];
    }
    if (severity)
      findings.push({ caller, ref, timing: refTiming(ref), severity, reason });
  }
  return findings;
}

/** Return a deterministic report for all checked-out caller workflows. */
export function analyze(
  before: string,
  after: string,
  provider: string,
  callersRoot: string,
): Result {
  if (
    !/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[^/@]+\.ya?ml$/.test(provider)
  ) {
    throw new Error("provider must be OWNER/REPO/.github/workflows/FILE.yml");
  }
  const changes = compare(before, after);
  const files = callerFiles(callersRoot);
  const findings: Finding[] = [];
  let matchedJobs = 0;
  for (const path of files) {
    const workflow = readWorkflow(path);
    const jobs = mapping(workflow.jobs ?? {}, `${path}: jobs`);
    const repo = relative(callersRoot, dirname(dirname(dirname(path))));
    const repoName = repo || basename(callersRoot);
    for (const [jobId, rawJob] of Object.entries(jobs)) {
      const job = mapping(rawJob, `${path}: jobs.${jobId}`);
      const uses = job.uses;
      if (typeof uses !== "string" || !uses.includes("@")) continue;
      const at = uses.lastIndexOf("@");
      const target = uses.slice(0, at);
      const ref = uses.slice(at + 1);
      if (target.toLowerCase() !== provider.toLowerCase() || !ref) continue;
      matchedJobs += 1;
      const caller = `${repoName}/${basename(path)}:${jobId}`;
      findings.push(...evaluate(changes, workflow, jobId, job, caller, ref));
    }
  }
  findings.sort(
    (a, b) =>
      a.caller.localeCompare(b.caller) || a.reason.localeCompare(b.reason),
  );
  return {
    changes,
    findings,
    scanned_files: files.length,
    matched_jobs: matchedJobs,
  };
}

function escapeCell(value: string): string {
  return value
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]/g, " ")
    .replace(/`/g, "'");
}

/** Format the same findings for a GitHub job summary. */
export function markdown(result: Result): string {
  const lines = [
    "## Reusable workflow impact",
    "",
    `Scanned ${result.scanned_files} workflow file(s); found ${result.matched_jobs} caller job(s).`,
    "",
  ];
  if (!result.changes.length) {
    lines.push("No call interface changes found.");
  } else {
    lines.push(`Detected ${result.changes.length} interface changes.`, "");
    if (result.findings.length) {
      lines.push(
        "| Caller | Ref | When | Result | Reason |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const finding of result.findings) {
        const parts = [
          finding.caller,
          finding.ref,
          finding.timing,
          finding.severity,
          finding.reason,
        ];
        lines.push(`| ${parts.map(escapeCell).join(" | ")} |`);
      }
    } else {
      lines.push("No matched caller uses a changed field.");
    }
  }
  lines.push(
    "",
    "Pinned refs are shown as *on upgrade*; branches and major tags as *on ref update*.",
  );
  return `${lines.join("\n")}\n`;
}
