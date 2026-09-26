# Reusable Workflow Impact

Review changes to a reusable GitHub workflow before they reach its callers.
The action compares the old and proposed `workflow_call` interfaces, then
checks caller workflows from repositories you have checked out in the job.

It identifies definite breaks, such as a caller passing an input that has
been removed, and flags changes that need human review. Findings appear in
the GitHub job summary; a JSON report is optional.

The action does **not** discover repositories across an organization. You
decide which callers to assess by checking them out first. See the
[scope and limitations](limitations.md) before using the result as a release
gate.

## Start here

1. [Add the action to a pull request workflow](getting-started.md).
2. [Check inputs, outputs, and result semantics](reference.md).
3. [Build and contribute to the project](development.md).

The published action is version
[`v0.1.0`](https://github.com/DiogoRibeiro7/workflow-call-impact/releases/tag/v0.1.0).
