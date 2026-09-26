# Reusable Workflow Impact

A GitHub Action that identifies callers affected by changes to a reusable
workflow's `workflow_call` interface. It compares the old and proposed workflow
files, scans caller repositories that you have checked out, and writes a job
summary. A JSON report is optional.

For each caller, the report distinguishes a moving branch or major tag from an
exact version or commit SHA. It fails only when a caller on a moving ref has a
definite break, such as a removed input it passes or a new required input it
does not pass. Changes to defaults and types are flagged for review.

## Example

Run this in the repository that owns the reusable workflow. Check out any caller
repositories you want to assess under `consumers/`. For private repositories,
provide a token with read access to those repositories to `actions/checkout`.

```yaml
name: Workflow change impact
on:
  pull_request:
    paths:
      - .github/workflows/build.yml

permissions:
  contents: read

jobs:
  impact:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: example/application
          path: consumers/example/application
      - name: Read the base version
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: git show "$BASE_SHA:.github/workflows/build.yml" > "$RUNNER_TEMP/before.yml"
      - uses: OWNER/workflow-call-impact@v1
        with:
          before-file: ${{ runner.temp }}/before.yml
          after-file: .github/workflows/build.yml
          provider: OWNER/automation/.github/workflows/build.yml
          callers-root: consumers
          report-file: impact.json
```

Replace `OWNER` and the example repositories with your own. Until a `v1`
release exists, use an exact commit SHA for the action. If the base version did
not contain the workflow, skip this comparison and review the new interface.

## What it checks

- Removed inputs or explicitly passed secrets; newly required inputs or secrets.
- Input type and default changes.
- Removed outputs referenced by another job using `needs.JOB.outputs.NAME`.
- Caller refs: exact versions and 40-character SHAs are classified as **on
  upgrade**; branches and major tags as **on ref update** (for example, when
  `main` receives the change or `v1` advances to a new release).

Only workflows directly under `.github/workflows/` are scanned, within the
provided callers directory. The action reads local files and does not request a
GitHub token. **You control which repositories are scanned by checking them
out first**; it does not discover every repository in an organization. Literal
values and expression-derived values are both reported for changed input types
because a static check cannot prove their runtime type. `secrets: inherit` is
marked for review when a new required secret appears.

## Inputs and outputs

| Input | Required | Meaning |
| --- | --- | --- |
| `before-file` | Yes | Old reusable workflow YAML. |
| `after-file` | Yes | Proposed reusable workflow YAML. |
| `provider` | Yes | `OWNER/REPO/.github/workflows/FILE.yml`, without `@ref`. |
| `callers-root` | Yes | Directory containing checked-out caller repositories. |
| `report-file` | No | Path to write JSON results. |
| `fail-on-impact` | No | `true` by default; `false` reports without failing. |
| `require-matches` | No | `true` by default; fail if no caller matches the provider. |

The action exposes `affected-count` (definitely broken caller jobs on moving
refs) and `matched-count` (all caller jobs using the provider). It exits with
status `0` for no definite break on ref update, or `1` for definite breaks or
invalid inputs.

## Local development

Node.js 24 is required for development. Install dependencies and run checks:

```bash
npm ci
npm run check
npm run lint
npm run format:check
npm run build
npm run test:coverage
npm run check:dist
```

The action runs on the runner's Node.js 24 action runtime. Its YAML parser is
included in the committed `dist/index.cjs` bundle, so consumers do not install
Node packages or Python dependencies.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor checks and the release
process. The repository must be public before this action can be listed in
GitHub Marketplace; it is usable from a private repository under GitHub's
normal private action access rules.

## Licence

MIT.
