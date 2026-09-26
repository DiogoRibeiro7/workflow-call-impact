/** Read selected caller workflows through the GitHub repository contents API. */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, type Result } from "./impact.js";

interface DirectoryEntry {
  type: string;
  name: string;
}

interface FileContent {
  type: string;
  encoding: string;
  content: string;
}

/** Validate a caller list before making requests or creating paths. */
export function parseRepositories(value: string): string[] {
  const repositories = value.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  for (const repository of repositories) {
    const parts = repository.split("/");
    if (
      parts.length !== 2 ||
      parts.some(
        (part) =>
          !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part ?? "") || part === "..",
      )
    ) {
      throw new Error(`Invalid caller repository: ${repository}`);
    }
    const normalized = repository.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`Duplicate caller repository: ${repository}`);
    }
    seen.add(normalized);
  }
  if (!repositories.length) throw new Error("caller-repositories is empty");
  return repositories;
}

/** Reject malformed responses instead of silently reporting an incomplete scan. */
async function getJson(
  url: string,
  token: string,
  request: typeof fetch,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await request(url, { headers, redirect: "error" });
  if (!response.ok) {
    throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
  }
  return response.json() as Promise<unknown>;
}

function workflowEntries(value: unknown, repository: string): string[] {
  if (!Array.isArray(value) || value.length >= 1000) {
    throw new Error(
      `Invalid or oversized workflows directory in ${repository}`,
    );
  }
  const names: string[] = [];
  for (const entry of value as DirectoryEntry[]) {
    if (!entry || typeof entry.name !== "string") {
      throw new Error(`Invalid workflows directory response for ${repository}`);
    }
    if (!/\.ya?ml$/.test(entry.name)) continue;
    if (entry.type !== "file" || !/^[^/\\]+\.ya?ml$/.test(entry.name)) {
      throw new Error(`Invalid workflow file in ${repository}`);
    }
    names.push(entry.name);
  }
  return names.sort();
}

function decodeWorkflow(
  value: unknown,
  repository: string,
  name: string,
): string {
  const file = value as FileContent | null;
  if (
    !file ||
    file.type !== "file" ||
    file.encoding !== "base64" ||
    typeof file.content !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      file.content.replace(/\s/g, ""),
    )
  ) {
    throw new Error(`Invalid workflow content for ${repository}/${name}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(file.content, "base64"),
  );
}

/** Download only workflow files from the named default branches, then reuse the local analyzer. */
export async function analyzeRepositories(
  before: string,
  after: string,
  provider: string,
  repositoriesInput: string,
  token: string,
  request: typeof fetch = fetch,
  apiUrl: string = process.env.GITHUB_API_URL || "https://api.github.com",
): Promise<Result> {
  const repositories = parseRepositories(repositoriesInput);
  const root = mkdtempSync(join(tmpdir(), "workflow-call-impact-"));
  try {
    for (const repository of repositories) {
      const [owner, name] = repository.split("/") as [string, string];
      const endpoint = `${apiUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/.github/workflows`;
      const entries = workflowEntries(
        await getJson(endpoint, token, request),
        repository,
      );
      const folder = join(root, owner, name, ".github", "workflows");
      mkdirSync(folder, { recursive: true });
      for (const file of entries) {
        const content = decodeWorkflow(
          await getJson(
            `${endpoint}/${encodeURIComponent(file)}`,
            token,
            request,
          ),
          repository,
          file,
        );
        writeFileSync(join(folder, file), content, "utf8");
      }
    }
    return analyze(before, after, provider, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
