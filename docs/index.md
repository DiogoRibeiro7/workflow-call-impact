<div class="impact-hero" markdown="1">

# Know which workflow callers will break

Compare a reusable workflow's old and proposed `workflow_call` interface with
the caller repositories you choose to scan. See the affected jobs before a
change reaches a shared branch or tag.

[Get started](getting-started.md){ .md-button .md-button--primary }
[Read the results](results.md){ .md-button }

</div>

<div class="impact-cards" markdown="1">

<div markdown="1">

### Find concrete breaks

Spot callers that pass removed inputs or secrets, omit new required values,
or read removed outputs.

</div>

<div markdown="1">

### Separate timing

Moving refs can be affected when they advance. Exact versions and commit
SHAs are reported for the next upgrade.

</div>

<div markdown="1">

### Use the report

Read findings in the job summary, write JSON for later steps, and fail the
check for definite breaks on moving refs.

</div>

</div>

## How it works

1. Provide the previous and proposed reusable workflow files.
2. Check out the caller repositories you want to assess under one directory.
3. Run the action in a pull request job and review its summary.

For a complete workflow, see [Getting started](getting-started.md). The
published action is
[`v0.1.0`](https://github.com/DiogoRibeiro7/workflow-call-impact/releases/tag/v0.1.0).

## What a finding looks like

| Caller | Ref | When | Result | Reason |
| --- | --- | --- | --- | --- |
| `team/app/ci.yml:build` | `main` | on ref update | break | does not pass required input `target` |

The action also marks changes to input types and defaults for review. See
[Read the results](results.md) for the failure rules and JSON shape.

!!! warning "Scan coverage is explicit"
    The action scans only the caller repositories you check out. It does not
    discover every caller across your organization. Review
    [scope and limitations](limitations.md) before treating a clean result as
    approval to change a shared workflow.
