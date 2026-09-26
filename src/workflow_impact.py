"""Check the effect of a reusable workflow interface change on local callers.

The caller repositories are checked out by the invoking workflow. This program
does not query GitHub or require a token, and only fails for demonstrably broken
callers that follow a moving ref.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class Change:
    """A change to one element of a workflow_call interface."""

    kind: str
    name: str
    detail: str


@dataclass(frozen=True)
class Finding:
    """A change that matters to one caller job."""

    caller: str
    ref: str
    timing: str
    severity: str
    reason: str


@dataclass(frozen=True)
class Result:
    """The deterministic report returned by an analysis."""

    changes: list[Change]
    findings: list[Finding]
    scanned_files: int
    matched_jobs: int


def _mapping(value: Any, where: str) -> Mapping[str, Any]:
    """Validate the shape of a YAML object before accessing its fields."""
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError(f"{where} must be a mapping with string keys")
    return value


def _read_workflow(path: Path) -> Mapping[str, Any]:
    """Read a GitHub workflow, accounting for PyYAML's YAML 1.1 `on` key."""
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ValueError(f"Cannot read workflow {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    # PyYAML interprets `on:` as the boolean True; GitHub interprets it as text.
    if True in raw and "on" not in raw:
        raw["on"] = raw.pop(True)
    return _mapping(raw, str(path))


def _interface(path: Path) -> Mapping[str, Mapping[str, Any]]:
    """Extract the declared call interface from a reusable workflow."""
    data = _read_workflow(path)
    triggers = _mapping(data.get("on"), f"{path}: on")
    call = _mapping(triggers.get("workflow_call") or {}, f"{path}: workflow_call")
    interface: dict[str, Mapping[str, Any]] = {}
    for field in ("inputs", "secrets", "outputs"):
        raw = call.get(field) or {}
        items = _mapping(raw, f"{path}: workflow_call.{field}")
        interface[field] = {
            key: _mapping(spec or {}, f"{path}: {field}.{key}") for key, spec in items.items()
        }
    return interface


def _required(spec: Mapping[str, Any]) -> bool:
    """Read a GitHub required flag, rejecting ambiguous YAML values."""
    value = spec.get("required", False)
    if not isinstance(value, bool):
        raise ValueError(f"required must be a boolean, got {value!r}")
    return value


def compare(before: Path, after: Path) -> list[Change]:
    """Describe interface changes without claiming all of them break callers."""
    old, new = _interface(before), _interface(after)
    changes: list[Change] = []
    for field in ("inputs", "secrets", "outputs"):
        previous, current = old[field], new[field]
        for key in sorted(previous.keys() - current.keys()):
            changes.append(Change(f"{field}_removed", key, f"{field[:-1]} removed"))
        for key in sorted(current.keys() - previous.keys()):
            if field != "outputs" and _required(current[key]):
                changes.append(Change(f"required_{field[:-1]}_added", key, "new required value"))
        for key in sorted(previous.keys() & current.keys()):
            if field in ("inputs", "secrets"):
                if not _required(previous[key]) and _required(current[key]):
                    changes.append(Change(f"{field[:-1]}_required", key, "became required"))
            if field == "inputs":
                if previous[key].get("type") != current[key].get("type"):
                    changes.append(Change("input_type", key, "type changed"))
                if previous[key].get("default") != current[key].get("default"):
                    changes.append(Change("input_default", key, "default changed"))
    return changes


def _caller_files(root: Path) -> list[Path]:
    """Find workflows in one or more checked-out caller repositories."""
    if not root.is_dir():
        raise ValueError(f"Callers directory does not exist: {root}")
    paths = root.rglob("*.yml")
    yaml_paths = root.rglob("*.yaml")
    return sorted(
        path
        for path in (*paths, *yaml_paths)
        if path.parent.name == "workflows" and path.parent.parent.name == ".github"
    )


def _ref_timing(ref: str) -> str:
    """Distinguish immutable references from branches and moving major tags."""
    if re.fullmatch(r"[a-fA-F0-9]{40}", ref) or re.fullmatch(
        r"v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?", ref
    ):
        return "on upgrade"
    return "on ref update"


def _output_used(workflow: Mapping[str, Any], job_id: str, output: str) -> bool:
    """Find dot-notation output reads elsewhere in this workflow."""
    source = json.dumps(workflow, default=str)
    expression = rf"needs\.{re.escape(job_id)}\.outputs\.{re.escape(output)}\b"
    return re.search(expression, source) is not None


def _evaluate(
    changes: Sequence[Change],
    workflow: Mapping[str, Any],
    job_id: str,
    job: Mapping[str, Any],
    caller: str,
    ref: str,
) -> list[Finding]:
    """Determine which changed fields affect the supplied caller job."""
    passed = _mapping(job.get("with") or {}, f"{caller}: with")
    secrets = job.get("secrets") or {}
    inherited = secrets == "inherit"
    named = _mapping(secrets, f"{caller}: secrets") if not inherited else {}
    findings: list[Finding] = []
    for change in changes:
        name = change.name
        kind = change.kind
        severity: str | None = None
        reason = ""
        if kind == "inputs_removed" and name in passed:
            severity, reason = "break", f"passes removed input {name}"
        elif kind in ("required_input_added", "input_required") and name not in passed:
            severity, reason = "break", f"does not pass required input {name}"
        elif kind == "input_type" and name in passed:
            severity, reason = "review", f"passes input {name} whose type changed"
        elif kind == "input_default" and name not in passed:
            severity, reason = "review", f"relies on changed default for {name}"
        elif kind == "secrets_removed" and name in named:
            severity, reason = "break", f"passes removed secret {name}"
        elif kind in ("required_secret_added", "secret_required") and name not in named:
            severity = "review" if inherited else "break"
            reason = f"must provide required secret {name}"
        elif kind == "outputs_removed" and _output_used(workflow, job_id, name):
            severity, reason = "break", f"reads removed output {name}"
        if severity is not None:
            findings.append(Finding(caller, ref, _ref_timing(ref), severity, reason))
    return findings


def analyze(before: Path, after: Path, provider: str, callers_root: Path) -> Result:
    """Compare the provider and inspect all locally available caller workflows."""
    if not re.fullmatch(r"[\w.-]+/[\w.-]+/\.github/workflows/[^/@]+\.ya?ml", provider):
        raise ValueError("provider must be OWNER/REPO/.github/workflows/FILE.yml")
    changes = compare(before, after)
    files = _caller_files(callers_root)
    findings: list[Finding] = []
    matched = 0
    for path in files:
        workflow = _read_workflow(path)
        jobs = _mapping(workflow.get("jobs") or {}, f"{path}: jobs")
        repository = path.parent.parent.parent.relative_to(callers_root)
        repo_name = str(repository) if repository != Path(".") else callers_root.name
        for job_id, raw_job in jobs.items():
            job = _mapping(raw_job, f"{path}: jobs.{job_id}")
            uses = job.get("uses")
            if not isinstance(uses, str) or "@" not in uses:
                continue
            target, ref = uses.rsplit("@", 1)
            if target.casefold() != provider.casefold() or not ref:
                continue
            matched += 1
            label = f"{repo_name}/{path.name}:{job_id}"
            findings.extend(_evaluate(changes, workflow, job_id, job, label, ref))
    return Result(
        changes, sorted(findings, key=lambda f: (f.caller, f.reason)), len(files), matched
    )


def _escape(value: str) -> str:
    """Keep caller-controlled names from breaking Markdown table cells."""
    return value.replace("|", "\\|").replace("\n", " ").replace("`", "'")


def markdown(result: Result) -> str:
    """Render a concise GitHub job summary."""
    lines = ["## Reusable workflow impact", ""]
    lines.append(
        f"Scanned {result.scanned_files} workflow file(s); "
        f"found {result.matched_jobs} caller job(s)."
    )
    lines.append("")
    if not result.changes:
        lines.append("No call interface changes found.")
    else:
        lines.append(f"Detected {len(result.changes)} interface changes.")
        lines.append("")
        if result.findings:
            lines.extend(
                ["| Caller | Ref | When | Result | Reason |", "| --- | --- | --- | --- | --- |"]
            )
            for finding in result.findings:
                parts = (
                    finding.caller,
                    finding.ref,
                    finding.timing,
                    finding.severity,
                    finding.reason,
                )
                lines.append("| " + " | ".join(_escape(part) for part in parts) + " |")
        else:
            lines.append("No matched caller uses a changed field.")
    lines.append("")
    lines.append(
        "Pinned refs are shown as *on upgrade*; branches and major tags as *on ref update*."
    )
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    """Run the analysis and write GitHub summary, outputs, and optional JSON."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--callers-root", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--fail-on-impact", choices=("true", "false"), default="true")
    parser.add_argument("--require-matches", choices=("true", "false"), default="true")
    args = parser.parse_args(argv)
    try:
        result = analyze(args.before, args.after, args.provider, args.callers_root)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    summary = markdown(result)
    print(summary, end="")
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(path).open("a", encoding="utf-8") as stream:
            stream.write(summary)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(asdict(result), indent=2) + "\n", encoding="utf-8")
    broken = {
        finding.caller
        for finding in result.findings
        if finding.severity == "break" and finding.timing == "on ref update"
    }
    if path := os.environ.get("GITHUB_OUTPUT"):
        with Path(path).open("a", encoding="utf-8") as stream:
            stream.write(f"affected-count={len(broken)}\n")
            stream.write(f"matched-count={result.matched_jobs}\n")
    if result.matched_jobs == 0 and args.require_matches == "true":
        print("error: no callers matched; check the provider and callers-root", file=sys.stderr)
        return 2
    return 1 if broken and args.fail_on_impact == "true" else 0


if __name__ == "__main__":
    raise SystemExit(main())
