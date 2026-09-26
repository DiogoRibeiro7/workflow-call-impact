"""Behavioural tests for interface changes and their actual callers."""

import tempfile
import unittest
from pathlib import Path

from src.workflow_impact import analyze, main

PROVIDER = "Example/automation/.github/workflows/build.yml"


def write(root: Path, name: str, content: str) -> Path:
    """Create a test workflow in an isolated repository layout."""
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


class WorkflowImpactTests(unittest.TestCase):
    """Exercise the behaviour a workflow maintainer relies upon."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = write(
            self.root,
            "old.yml",
            """on:
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
        value: ${{ jobs.build.outputs.artifact }}
""",
        )
        self.new = write(
            self.root,
            "new.yml",
            """on:
  workflow_call:
    inputs:
      mode:
        type: string
        default: safe
      target:
        type: string
        required: true
""",
        )
        self.callers = self.root / "consumers"

    def test_moving_caller_breaks_and_pinned_caller_is_only_at_risk(self) -> None:
        """Report affected jobs, and never block a caller pinned to an old version."""
        write(
            self.callers,
            "team/project/.github/workflows/ci.yml",
            f"""name: CI
on: push
jobs:
  build:
    uses: {PROVIDER}@v1
    with:
      old-input: legacy
  consume:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo ${{{{ needs.build.outputs.artifact }}}}
""",
        )
        write(
            self.callers,
            "team/other/.github/workflows/ci.yaml",
            f"""jobs:
  build:
    uses: {PROVIDER}@v1.0.0
    with:
      old-input: legacy
""",
        )
        result = analyze(self.old, self.new, PROVIDER, self.callers)
        self.assertEqual(result.scanned_files, 2)
        self.assertEqual(result.matched_jobs, 2)
        current = [item for item in result.findings if item.timing == "on ref update"]
        pinned = [item for item in result.findings if item.timing == "on upgrade"]
        self.assertEqual(
            {item.reason for item in current},
            {
                "passes removed input old-input",
                "does not pass required input target",
                "reads removed output artifact",
                "relies on changed default for mode",
            },
        )
        self.assertEqual(len(pinned), 3)
        self.assertTrue(
            all(item.severity == "break" for item in pinned if "default" not in item.reason)
        )

    def test_secret_inheritance_is_not_claimed_as_a_definite_failure(self) -> None:
        """An inherited secret may exist even when no mapping is visible here."""
        write(
            self.root,
            "new.yml",
            """on:
  workflow_call:
    inputs:
      old-input:
        type: string
        required: false
      mode:
        type: string
        default: fast
    outputs:
      artifact: {}
    secrets:
      publish-token:
        required: true
""",
        )
        write(
            self.callers,
            "org/repo/.github/workflows/ci.yml",
            f"""jobs:
  build:
    uses: {PROVIDER}@main
    secrets: inherit
""",
        )
        result = analyze(self.old, self.new, PROVIDER, self.callers)
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].severity, "review")

    def test_unrelated_calls_do_not_trigger_findings(self) -> None:
        """An interface diff alone does not prove consumer impact."""
        write(
            self.callers,
            "org/repo/.github/workflows/ci.yml",
            """jobs:
  build:
    uses: another/repo/.github/workflows/build.yml@main
""",
        )
        result = analyze(self.old, self.new, PROVIDER, self.callers)
        self.assertGreater(len(result.changes), 0)
        self.assertEqual(result.matched_jobs, 0)
        self.assertEqual(result.findings, [])
        args = [
            "--before",
            str(self.old),
            "--after",
            str(self.new),
            "--provider",
            PROVIDER,
            "--callers-root",
            str(self.callers),
        ]
        self.assertEqual(main(args), 2)
        self.assertEqual(main([*args, "--require-matches", "false"]), 0)

    def test_cli_fails_only_for_a_definite_moving_ref_break(self) -> None:
        """The blocking status matches the documented policy."""
        write(
            self.callers,
            "org/repo/.github/workflows/ci.yml",
            f"""jobs:
  build:
    uses: {PROVIDER}@main
""",
        )
        args = [
            "--before",
            str(self.old),
            "--after",
            str(self.new),
            "--provider",
            PROVIDER,
            "--callers-root",
            str(self.callers),
        ]
        self.assertEqual(main(args), 1)
        self.assertEqual(main([*args, "--fail-on-impact", "false"]), 0)


if __name__ == "__main__":
    unittest.main()
