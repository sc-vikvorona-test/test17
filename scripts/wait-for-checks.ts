import { Octokit } from "@octokit/rest";
import "dotenv/config";

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

interface CheckResult {
  conclusion: string;
  completedAt: string | null;
  detailsUrl: string | null;
}

type ChecksSummary = Record<string, Record<string, CheckResult>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  prs: PrEntry[],
  expectedChecks: string[],
  pollIntervalMs: number,
  timeoutMs: number
): Promise<ChecksSummary> {
  const summary: ChecksSummary = {};
  const pending = new Map<number, Set<string>>();

  for (const pr of prs) {
    summary[pr.prNumber] = {};
    pending.set(pr.prNumber, new Set(expectedChecks));
  }

  const deadline = Date.now() + timeoutMs;

  while (pending.size > 0 && Date.now() < deadline) {
    for (const pr of prs) {
      const remainingChecks = pending.get(pr.prNumber);
      if (!remainingChecks || remainingChecks.size === 0) continue;

      const { data } = await octokit.checks.listForRef({
        owner,
        repo,
        ref: pr.headSha,
        per_page: 100,
      });

      for (const check of data.check_runs) {
        if (!remainingChecks.has(check.name)) continue;
        if (check.status !== "completed") continue;

        summary[pr.prNumber][check.name] = {
          conclusion: check.conclusion ?? "neutral",
          completedAt: check.completed_at,
          detailsUrl: check.details_url ?? null,
        };
        remainingChecks.delete(check.name);
        console.log(
          `PR #${pr.prNumber} — ${check.name}: ${check.conclusion} at ${check.completed_at}`
        );
      }

      if (remainingChecks.size === 0) {
        pending.delete(pr.prNumber);
      }
    }

    if (pending.size > 0) {
      const totalRemaining = Array.from(pending.values()).reduce(
        (acc, s) => acc + s.size,
        0
      );
      console.log(
        `Waiting... ${totalRemaining} checks still pending. Next poll in ${pollIntervalMs / 1000}s`
      );
      await sleep(pollIntervalMs);
    }
  }

  for (const [prNumber, remainingChecks] of pending) {
    for (const checkName of remainingChecks) {
      console.warn(
        `PR #${prNumber} — ${checkName}: timed out waiting for completion`
      );
      summary[prNumber][checkName] = {
        conclusion: "timed_out",
        completedAt: null,
        detailsUrl: null,
      };
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  const repoFull = required("GITHUB_REPO");
  const prMatrixRaw = required("PR_MATRIX");
  const expectedChecksRaw = required("EXPECTED_CHECKS");

  const [owner, repo] = repoFull.split("/");
  const prs: PrEntry[] = JSON.parse(prMatrixRaw);
  const expectedChecks = expectedChecksRaw.split(",").map((s) => s.trim());
  const pollIntervalMs =
    parseInt(process.env.POLL_INTERVAL_SECONDS ?? "30", 10) * 1000;
  const timeoutMs =
    parseInt(process.env.TIMEOUT_SECONDS ?? "7200", 10) * 1000;

  console.log(
    `Waiting for checks: ${expectedChecks.join(", ")} on ${prs.length} PRs`
  );
  console.log(`Timeout: ${timeoutMs / 1000}s, Poll interval: ${pollIntervalMs / 1000}s`);

  const octokit = new Octokit({ auth: token });
  const summary = await pollChecks(
    octokit,
    owner,
    repo,
    prs,
    expectedChecks,
    pollIntervalMs,
    timeoutMs
  );

  const output = JSON.stringify(summary);
  console.log(`\nChecks summary: ${output}`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `checks-summary=${output}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
