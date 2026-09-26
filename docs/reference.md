# Inputs, outputs, and findings

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `before-file` | Yes | — | Previous version of the provider workflow YAML. |
| `after-file` | Yes | — | Proposed version of the provider workflow YAML. |
| `provider` | Yes | — | `OWNER/REPO/.github/workflows/FILE.yml` or `.yaml`, without `@ref`. |
| `callers-root` | Yes | — | Directory containing checked-out caller repositories. |
| `report-file` | No | Empty | Optional path for a JSON report. |
| `fail-on-impact` | No | `true` | Fail for definite breaks in callers using moving refs. |
| `require-matches` | No | `true` | Fail if no caller job references `provider`. |

The two boolean inputs accept the strings `true` and `false`.

## Outputs and exit status

| Output | Meaning |
| --- | --- |
| `affected-count` | Number of distinct caller jobs with a definite break on a moving ref. |
| `matched-count` | Number of caller jobs that reference the specified provider. |

With default settings, the action fails if `affected-count` is greater than
zero or `matched-count` is zero. An invalid input or an unreadable workflow
also fails the action. Set `fail-on-impact: 'false'` to collect findings
without failing for impact; set `require-matches: 'false'` when zero matches
are intentional.

## Findings

The job summary groups findings by caller job and shows its ref, timing,
severity, and reason. A **break** is a definite static mismatch; **review**
means the action cannot decide safely from the YAML alone.

| Timing | Ref examples | Meaning |
| --- | --- | --- |
| `on ref update` | `main`, `v1` | The caller follows a moving branch or major tag. |
| `on upgrade` | `v1.2.3`, a 40-character commit SHA | The caller is treated as pinned to a specific version. |

The optional JSON file contains `changes`, `findings`, `scanned_files`, and
`matched_jobs`. Each change has `kind`, `name`, and `detail`. Each finding
has `caller`, `ref`, `timing`, `severity`, and `reason`. For the exact shape,
see the [TypeScript result types](https://github.com/DiogoRibeiro7/workflow-call-impact/blob/main/src/impact.ts).
