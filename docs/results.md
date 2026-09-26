# Read the results

The action writes a table to the GitHub job summary and can also write the
same analysis as JSON. Each row names a caller job, the ref it uses, when the
change could affect it, and why it was flagged.

| Caller | Ref | When | Result | Reason |
| --- | --- | --- | --- | --- |
| `team/app/ci.yml:build` | `main` | on ref update | break | does not pass required input `target` |
| `team/api/ci.yml:build` | `v1.0.0` | on upgrade | break | passes removed input `old-input` |

## Timing and exit status

| Timing | Ref examples | What to do |
| --- | --- | --- |
| **On ref update** | `main`, `v1` | Fix the caller before advancing the branch or tag. |
| **On upgrade** | `v1.0.0`, a 40-character commit SHA | Fix the caller before moving it to the new version. |

With default inputs, the action fails if it finds a definite break in a
caller on a moving ref, or if no caller job matches the provider path. A break
in a caller pinned to an exact version is reported without failing the job.
Set `fail-on-impact: 'false'` to report moving-ref breaks without failing.

Changes to input types and defaults are marked **review**: the action cannot
resolve runtime expressions or prove their resulting types. A new required
secret with `secrets: inherit` also needs review.

## JSON report

Set `report-file: impact.json` to write a report for later steps. It contains:

| Field | Meaning |
| --- | --- |
| `changes` | Interface changes, with `kind`, `name`, and `detail`. |
| `findings` | Caller rows, with `caller`, `ref`, `timing`, `severity`, and `reason`. |
| `scanned_files` | Number of caller workflow files read. |
| `matched_jobs` | Number of caller jobs using the provider path. |

The action also exposes `affected-count` and `matched-count` as step outputs.
See the [reference](reference.md) for the input defaults and output definitions.
