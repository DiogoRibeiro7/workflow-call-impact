# Development and documentation

The action uses a bundled Node.js 24 runtime. Its source is in `src/`, its
tests are in `tests/`, and the committed action bundle is `dist/index.cjs`.

```bash
npm ci
npm run check
npm run lint
npm run format:check
npm run test:coverage
npm run check:dist
```

The MkDocs site is a separate build tool. Python 3.12 is needed only to build
the site:

```bash
python -m pip install -r requirements-docs.txt
mkdocs build --strict
mkdocs serve
```

Docs changes build in pull requests. After they merge to `main`, the docs
workflow deploys the built `site/` to GitHub Pages. Set **Settings → Pages →
Build and deployment → Source** to **GitHub Actions** for the repository.
The `site/` build output is ignored by Git; the deployment uses a Pages
artifact, not a `gh-pages` branch.

See [CONTRIBUTING.md](https://github.com/DiogoRibeiro7/workflow-call-impact/blob/main/CONTRIBUTING.md)
for release steps and how to propose changes to impact rules.
