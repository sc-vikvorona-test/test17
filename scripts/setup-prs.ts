import { Octokit } from "@octokit/rest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HTTP_UNPROCESSABLE_ENTITY = 422;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

interface Scenario {
  id: string;
  branch: string;
  sourceTag: string;
  prTitle: string;
  prBody: string;
  project: string;
  category: string;
  expectedIssues: { security: number; bugs: number; smells: number };
}

interface PrEntry {
  scenarioId: string;
  branch: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
}

async function getTagSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string
): Promise<string> {
  const { data } = await octokit.git.getRef({
    owner,
    repo,
    ref: `tags/${tag}`,
  });
  if (data.object.type === "tag") {
    const tagData = await octokit.git.getTag({
      owner,
      repo,
      tag_sha: data.object.sha,
    });
    return tagData.data.object.sha;
  }
  return data.object.sha;
}

async function getMasterSha(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<string> {
  const { data } = await octokit.git.getRef({ owner, repo, ref: "heads/master" });
  return data.object.sha;
}

// Cherry-pick scenario changes from sourceTagSha onto master, returning a new commit SHA.
async function rebaseScenarioOntoMaster(
  octokit: Octokit,
  owner: string,
  repo: string,
  sourceTagSha: string,
  masterSha: string,
  message: string
): Promise<string> {
  const { data: tagCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: sourceTagSha });
  const parentSha = tagCommit.parents[0]?.sha;

  if (!parentSha) {
    // No parent — use tag directly (shouldn't happen in practice)
    return sourceTagSha;
  }

  // Get files changed between the tag's parent and the tag itself
  const { data: comparison } = await octokit.repos.compareCommits({
    owner,
    repo,
    base: parentSha,
    head: sourceTagSha,
  });

  if (!comparison.files || comparison.files.length === 0) {
    return masterSha;
  }

  // Get master's tree SHA
  const { data: masterCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: masterSha });

  // Build tree entries: apply scenario file changes on top of master's tree
  const treeEntries = comparison.files.flatMap((file) => {
    if (file.status === "removed") {
      return [{ path: file.filename, mode: "100644" as const, type: "blob" as const, sha: null }];
    }
    if (file.status === "renamed" && file.previous_filename) {
      // Delete old path, add new path
      return [
        { path: file.previous_filename, mode: "100644" as const, type: "blob" as const, sha: null },
        { path: file.filename, mode: "100644" as const, type: "blob" as const, sha: file.sha },
      ];
    }
    return [{ path: file.filename, mode: "100644" as const, type: "blob" as const, sha: file.sha }];
  });

  const { data: newTree } = await octokit.git.createTree({
    owner,
    repo,
    base_tree: masterCommit.tree.sha,
    tree: treeEntries,
  });

  const { data: newCommit } = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [masterSha],
  });

  return newCommit.sha;
}

async function forcePushBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  sha: string
): Promise<void> {
  try {
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha,
      force: true,
    });
  } catch (err: unknown) {
    if ((err as { status?: number }).status === HTTP_UNPROCESSABLE_ENTITY) {
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha,
      });
    } else {
      throw err;
    }
  }
}

async function findOpenPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<number | null> {
  const { data } = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "open",
  });
  return data.length > 0 ? data[0].number : null;
}

async function setupPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  scenario: Scenario,
  headSha: string
): Promise<PrEntry> {
  const existingPr = await findOpenPr(octokit, owner, repo, scenario.branch);

  let prNumber: number;
  let prUrl: string;

  if (existingPr === null) {
    const { data } = await octokit.pulls.create({
      owner,
      repo,
      title: scenario.prTitle,
      body: scenario.prBody,
      head: scenario.branch,
      base: "master",
    });
    prNumber = data.number;
    prUrl = data.html_url;
    console.log(`Created PR #${prNumber} for ${scenario.id}`);
  } else {
    const { data } = await octokit.pulls.update({
      owner,
      repo,
      pull_number: existingPr,
      title: scenario.prTitle,
      body: scenario.prBody,
    });
    prNumber = data.number;
    prUrl = data.html_url;
    console.log(`Updated existing PR #${prNumber} for ${scenario.id}`);
  }

  return {
    scenarioId: scenario.id,
    branch: scenario.branch,
    prNumber,
    prUrl,
    headSha,
  };
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  const repoFull = required("GITHUB_REPO");
  const [owner, repo] = repoFull.split("/");

  const scenariosPath = resolve(__dirname, "../scenarios.json");
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenariosPath, "utf-8"));

  const octokit = new Octokit({ auth: token });
  const results: PrEntry[] = [];

  const masterSha = await getMasterSha(octokit, owner, repo);
  console.log(`Master HEAD: ${masterSha}`);

  for (const scenario of scenarios) {
    console.log(`Processing scenario: ${scenario.id}`);
    const tagSha = await getTagSha(octokit, owner, repo, scenario.sourceTag);
    const sha = await rebaseScenarioOntoMaster(octokit, owner, repo, tagSha, masterSha, scenario.prTitle);
    await forcePushBranch(octokit, owner, repo, scenario.branch, sha);
    const entry = await setupPr(octokit, owner, repo, scenario, sha);
    results.push(entry);
  }

  const output = JSON.stringify(results);
  console.log(`\nPR matrix: ${output}`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `pr-matrix=${output}\n`);
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
