# Scope and limitations

The action checks the `workflow_call` interface for removed inputs, secrets,
and outputs; newly required inputs and secrets; fields that become required;
and changed input types and defaults.

It scans `.yml` and `.yaml` files directly under `.github/workflows/`. In local
mode it reads files below `callers-root`. In API mode it reads each explicitly
named repository's default branch. Only jobs whose `uses:` value matches the
specified provider are counted. A repository missing from the checkout
directory or the explicit list cannot appear in the report. The action does
not enumerate an organization for callers. API mode stops if it cannot read a
listed repository or a workflow; directories with 1,000 or more entries are
rejected because the Contents API cannot return a complete listing.

The analysis is static. It flags input type or default changes for review
because expressions can resolve only at runtime. With `secrets: inherit`, a
new required secret needs review because the action cannot prove that it is
available. It detects references to removed outputs in the same caller
workflow through `needs.JOB.outputs.NAME`; it does not execute jobs or prove
that all other consumers of outputs have been found.

An exact version such as `v1.2.3` is classified as **on upgrade**. That
classification assumes the version tag remains fixed. Moving such a tag later
can change callers without an explicit upgrade. Branches and major tags are
classified as **on ref update**.

Before treating a clean result as approval to change a shared workflow, check
that all relevant caller repositories were included and that `matched-count`
is reasonable. The default `require-matches: 'true'` catches an empty or
mistyped provider match, but it cannot detect a caller repository you forgot
to check out or list.
