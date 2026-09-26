/** Contract tests for downloading explicitly selected caller repositories. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  analyzeRepositories,
  parseRepositories,
} from "../src/github-callers.js";

const provider = "acme/workflows/.github/workflows/build.yml";

function interfaceFiles(t: TestContext): [string, string] {
  const root = mkdtempSync(join(tmpdir(), "caller-api-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = join(root, "before.yml");
  const after = join(root, "after.yml");
  writeFileSync(
    before,
    "on:\n  workflow_call:\n    inputs:\n      old-input:\n        type: string\n",
  );
  writeFileSync(after, "on:\n  workflow_call:\n    inputs: {}\n");
  return [before, after];
}

void test("validates caller names and rejects duplicates before downloading", () => {
  assert.deepEqual(parseRepositories("Acme/app\nacme/service"), [
    "Acme/app",
    "acme/service",
  ]);
  for (const invalid of [
    "",
    "owner",
    "../repo",
    "owner/..",
    "owner/repo/other",
  ]) {
    assert.throws(() => parseRepositories(invalid), /empty|Invalid/);
  }
  assert.throws(
    () => parseRepositories("acme/app ACME/APP"),
    /Duplicate caller repository/,
  );
});

void test("downloads workflows from selected repositories and analyzes their jobs", async (t) => {
  const [before, after] = interfaceFiles(t);
  const seen: string[] = [];
  const request: typeof fetch = (url, init) => {
    const path =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    seen.push(path);
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer secret-token",
    );
    if (path.endsWith("/workflows")) {
      return Promise.resolve(Response.json([{ type: "file", name: "ci.yml" }]));
    }
    const workflow = path.includes("/acme/app/")
      ? `jobs:\n  build:\n    uses: ${provider}@main\n    with:\n      old-input: legacy\n`
      : "jobs:\n  build:\n    runs-on: ubuntu-latest\n";
    return Promise.resolve(
      Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(workflow).toString("base64"),
      }),
    );
  };

  const result = await analyzeRepositories(
    before,
    after,
    provider,
    "acme/app\nacme/other",
    "secret-token",
    request,
    "https://github.example.com/api/v3",
  );
  assert.equal(result.scanned_files, 2);
  assert.equal(result.matched_jobs, 1);
  assert.deepEqual(
    result.findings.map((finding) => finding.caller),
    ["acme/app/ci.yml:build"],
  );
  assert.equal(seen.length, 4);
  assert.ok(
    seen.every((path) => path.startsWith("https://github.example.com/api/v3/")),
  );
});

void test("fails on API errors or incomplete directory and file responses", async (t) => {
  const [before, after] = interfaceFiles(t);
  const check = (request: typeof fetch, pattern: RegExp): Promise<void> =>
    assert.rejects(
      analyzeRepositories(before, after, provider, "acme/app", "", request),
      pattern,
    );

  await check(
    () => Promise.resolve(new Response(null, { status: 403 })),
    /HTTP 403/,
  );
  await check(
    () => Promise.resolve(Response.json({ message: "wrong shape" })),
    /directory/,
  );
  await check(
    (url) =>
      Promise.resolve(
        Response.json(
          (typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url
          ).endsWith("/workflows")
            ? Array.from({ length: 1000 }, (_, index) => ({
                type: "file",
                name: `${index}.yml`,
              }))
            : {},
        ),
      ),
    /oversized/,
  );
  await check(
    (url) =>
      Promise.resolve(
        Response.json(
          (typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url
          ).endsWith("/workflows")
            ? [{ type: "file", name: "ci.yml" }]
            : { type: "file", encoding: "none", content: "" },
        ),
      ),
    /Invalid workflow content/,
  );
});

void test("bundled action uses API mode and writes its standard outputs", async (t) => {
  const [before, after] = interfaceFiles(t);
  const output = join(dirname(before), "output.txt");
  writeFileSync(output, "");
  const workflow = `jobs:\n  build:\n    uses: ${provider}@main\n    with:\n      old-input: legacy\n`;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.endsWith("/workflows")
          ? [{ type: "file", name: "ci.yml" }]
          : {
              type: "file",
              encoding: "base64",
              content: Buffer.from(workflow).toString("base64"),
            },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    GITHUB_OUTPUT: output,
    "INPUT_BEFORE-FILE": before,
    "INPUT_AFTER-FILE": after,
    INPUT_PROVIDER: provider,
    "INPUT_CALLER-REPOSITORIES": "acme/app",
    "INPUT_FAIL-ON-IMPACT": "false",
  };
  delete env["INPUT_CALLERS-ROOT"];
  const bundle = join(import.meta.dirname, "..", "dist", "index.cjs");
  const { stdout } = await promisify(execFile)(process.execPath, [bundle], {
    env,
  });
  assert.match(stdout, /passes removed input old-input/);
  assert.match(
    readFileSync(output, "utf8"),
    /affected-count=1\nmatched-count=1\n/,
  );
  assert.equal(paths.length, 2);
});
