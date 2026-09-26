# Contributing

Open an issue with a small provider and caller example before changing the
impact rules. The action intentionally reports uncertain cases for review and
fails only for definite breaks in callers using moving refs.

## Local development

Use Node.js 24. From the repository root:

```bash
npm ci
npm run check
npm run format:check
npm run build
npm test
npm run check:dist
```

Add a test with a minimal caller workflow for each changed matching rule.
Keep GitHub workflow fixtures in `tests/fixtures/`. Commit the generated
`dist/index.cjs` bundle whenever source or dependencies change. The CI workflow
also runs the action itself against a fixture. Do not rely only on unit tests
when changing `action.yml`.

Submit a focused pull request to `main`. Explain any difference between
definite breaks, cases requiring review, and callers affected on upgrade.
Changes to action inputs or outputs need a README update.

## Preparing a release

1. Confirm that the full CI job has run successfully, including the action
   smoke test and bundle verification. A run blocked before its job starts does
   not verify a release.
2. Review the README usage example, inputs, outputs, and limitations against the
   proposed commit.
3. Create a semantic version tag such as `v1.0.0` on the tested commit and draft
   the corresponding GitHub release. Keep major version tags such as `v1` on
   compatible stable releases only.
4. If publishing to GitHub Marketplace, make the repository public first, then
   follow GitHub's release form to publish the action. A private repository
   cannot be listed in the Marketplace.

No automated workflow in this repository creates releases or moves version
tags. Release tags should point to a commit whose checks have completed.
