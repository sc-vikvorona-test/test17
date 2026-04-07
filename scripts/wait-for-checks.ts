import { Octokit } from "@octokit/rest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

interface PrEntry {
  scenarioId: string;
  branch: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
}

interface Tool {
  name: string;
  botLogin: string | string[];
  configured: boolean;
}

interface ToolCommentStatus {
  commentCount: number;
  firstCommentAt: string | null;
}

type CommentsSummary = Record<number, Record<string, ToolCommentStatus>>;

function buildLoginToToolMap(tools: Tool[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    const logins = Array.isArray(tool.botLogin) ? tool.botLogin : [tool.botLogin];
    for (const login of logins) {
      map.set(login, tool.name);
    }
  }
  return map;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCommentStatsByTool(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  loginToTool: Map<string, string>
): Promise<Map<string, { count: number; firstAt: string }>> {
  const [reviewComments, issueComments, reviews] = await Promise.all([
    octokit.paginate(octokit.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.paginate(octokit.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const byTool = new Map<string, { count: number; firstAt: string }>();

  const allComments = [
    ...reviewComments.map((c) => ({ login: c.user?.login, createdAt: c.created_at })),
    ...issueComments.map((c) => ({ login: c.user?.login, createdAt: c.created_at })),
    ...reviews.filter((r) => r.body).map((r) => ({ login: r.user?.login, createdAt: r.submitted_at ?? "" })),
  ];

  for (const c of allComments) {
    const tool = loginToTool.get(c.login ?? "");
    if (!tool) continue;
    const existing = byTool.get(tool);
    if (existing) {
      existing.count++;
      if (c.createdAt < existing.firstAt) existing.firstAt = c.createdAt;
    } else {
      byTool.set(tool, { count: 1, firstAt: c.createdAt });
    }
  }

  return byTool;
}

async function pollForComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prs: PrEntry[],
  pollIntervalMs: number,
  timeoutMs: number,
  loginToTool: Map<string, string>
): Promise<CommentsSummary> {
  const toolNames = [...new Set(loginToTool.values())];
  const summary: CommentsSummary = {};
  const pending = new Map<number, Set<string>>();

  for (const pr of prs) {
    summary[pr.prNumber] = {};
    pending.set(pr.prNumber, new Set(toolNames));
  }

  const deadline = Date.now() + timeoutMs;

  while (pending.size > 0 && Date.now() < deadline) {
    await Promise.all(
      prs
        .filter((pr) => pending.has(pr.prNumber))
        .map(async (pr) => {
          const statsByTool = await fetchCommentStatsByTool(
            octokit,
            owner,
            repo,
            pr.prNumber,
            loginToTool
          );
          const remaining = pending.get(pr.prNumber)!;

          for (const [tool, stats] of statsByTool) {
            if (!remaining.has(tool)) continue;
            summary[pr.prNumber][tool] = {
              commentCount: stats.count,
              firstCommentAt: stats.firstAt,
            };
            remaining.delete(tool);
            console.log(
              `PR #${pr.prNumber} — ${tool}: ${stats.count} comment(s), first at ${stats.firstAt}`
            );
          }

          if (remaining.size === 0) {
            pending.delete(pr.prNumber);
          }
        })
    );

    if (pending.size > 0) {
      const totalRemaining = Array.from(pending.values()).reduce(
        (acc, s) => acc + s.size,
        0
      );
      const waitingSummary = Array.from(pending.entries())
        .map(([prNum, tools]) => `PR#${prNum}: [${[...tools].join(", ")}]`)
        .join("  ");
      console.log(
        `Waiting for ${totalRemaining} more: ${waitingSummary}. Next poll in ${pollIntervalMs / 1000}s`
      );
      await sleep(pollIntervalMs);
    }
  }

  // Record timed-out tools
  for (const [prNumber, remaining] of pending) {
    for (const tool of remaining) {
      console.warn(`PR #${prNumber} — ${tool}: timed out, no comments posted`);
      summary[prNumber][tool] = { commentCount: 0, firstCommentAt: null };
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  const repoFull = required("GITHUB_REPO");
  const prMatrixRaw = required("PR_MATRIX");

  const [owner, repo] = repoFull.split("/");
  const prs: PrEntry[] = JSON.parse(prMatrixRaw);

  const toolsPath = resolve(__dirname, "../tools.json");
  const { tools }: { tools: Tool[] } = JSON.parse(readFileSync(toolsPath, "utf-8"));
  const configuredTools = tools.filter((t) => t.configured !== false);
  const toolNames = configuredTools.map((t) => t.name);
  const loginToTool = buildLoginToToolMap(configuredTools);

  const pollIntervalMs =
    Number.parseInt(process.env.POLL_INTERVAL_SECONDS ?? "30", 10) * 1000;
  const timeoutMs =
    Number.parseInt(process.env.TIMEOUT_SECONDS ?? "900", 10) * 1000;

  console.log(`Waiting for comments from: ${toolNames.join(", ")}`);
  console.log(`${prs.length} PR(s). Timeout: ${timeoutMs / 1000}s, poll: ${pollIntervalMs / 1000}s`);

  const octokit = new Octokit({ auth: token });
  const summary = await pollForComments(
    octokit,
    owner,
    repo,
    prs,
    pollIntervalMs,
    timeoutMs,
    loginToTool
  );

  const output = JSON.stringify(summary);
  console.log(`\nComments summary: ${output}`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `checks-summary=${output}\n`);
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
