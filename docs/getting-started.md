# Getting started

Run this action in the repository that owns the reusable workflow. It needs
the previous and proposed workflow YAML files, the provider path, and a
selection of caller repositories. The published `v0.1.0` release uses local
checkouts; the example below checks one caller.

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

## Read named caller repositories through the API

The next release adds `caller-repositories`. With it, the action downloads the
workflow files from each named repository's default branch. Keep the checkout
of the **provider** repository and the step that creates `before.yml`, then
remove the caller checkout steps and replace `callers-root` with:

```yaml
caller-repositories: |
  example/application
  example/service
github-token: ${{ secrets.CALLER_READ_TOKEN }}
```

The published `v0.1.0` release does not support these inputs. For private
callers, use a GitHub App token or fine-grained personal access token with
Contents **read** access to every listed repository. The default
`github.token` is scoped to the repository running the job, so it is not
sufficient for other private repositories. For public caller repositories,
you may omit `github-token`; GitHub's unauthenticated API limits still apply.
List each repository once using `OWNER/REPO`, one per line. The action reads
only files directly in `.github/workflows/` and stops with an error if a
repository cannot be read. It does not discover callers you did not list.

After the job runs, open its summary for the findings. The `report-file`
input writes the same analysis as JSON for later steps in the job. The
default behavior fails when a moving-ref caller has a definite break, or
when no caller matches the specified provider. See the [reference](reference.md)
for the controls.
