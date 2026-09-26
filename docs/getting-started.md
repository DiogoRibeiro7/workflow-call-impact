# Getting started

Run this action in the repository that owns the reusable workflow. It needs
the previous and proposed workflow YAML files, the provider path, and one or
more checked-out caller repositories. The example below checks one caller.

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
      - uses: DiogoRibeiro7/workflow-call-impact@a30329b80f3b0351ca827493252023c4c5279588 # v0.1.0
        with:
          before-file: ${{ runner.temp }}/before.yml
          after-file: .github/workflows/build.yml
          provider: example/automation/.github/workflows/build.yml
          callers-root: consumers
          report-file: impact.json
```

Replace `example/application` with each caller repository you want to scan.
Add a checkout step per repository, each below `consumers/`. Replace the
`provider` value with the **owner, repository, and workflow path of the
reusable workflow**, without its `@ref`. The action's own repository in the
`uses:` line stays `DiogoRibeiro7/workflow-call-impact`.

The example pins the exact commit released as `v0.1.0`. The release tag
`@v0.1.0` also works, but a commit SHA cannot move. No `v1` tag exists yet.

For private callers, give their `actions/checkout` steps a token with read
access to those repositories. This action itself reads local files and does
not need a token.

The base workflow must already exist at the pull request's base commit. If
the pull request introduces a new reusable workflow, review that interface
directly instead of running this comparison.

After the job runs, open its summary for the findings. The `report-file`
input writes the same analysis as JSON for later steps in the job. The
default behavior fails when a moving-ref caller has a definite break, or
when no caller matches the specified provider. See the [reference](reference.md)
for the controls.
