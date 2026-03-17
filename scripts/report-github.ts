import { Octokit } from "@octokit/rest";
import { readFileSync } from "fs";
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

interface ToolEvaluation {
  issuesFound: number;
  falsePositives: number;
  commentQuality: number;
  notableFinding: string | null;
}

interface EvaluationResult {
  scenarioId: string;
  prNumber: number;
  expectedIssueCount: number;
  perTool: Record<string, ToolEvaluation>;
}

interface PrEntry {
  scenarioId: string;
  prNumber: number;
  prUrl: string;
}

interface Scenario {
  id: string;
  prTitle: string;
  category: string;
  expectedIssues: { security: number; bugs: number; smells: number };
}

interface ToolSummary {
  name: string;
  totalFound: number;
  totalExpected: number;
  detectionRate: number;
  totalFalsePositives: number;
  falsePositivesOnClean: number;
  avgCommentQuality: number;
  timedOutCount: number;
}

function computeToolSummaries(
  results: EvaluationResult[],
  toolNames: string[]
): ToolSummary[] {
  return toolNames.map((toolName) => {
    const issueResults = results.filter((r) => r.expectedIssueCount > 0);
    const cleanResults = results.filter((r) => r.expectedIssueCount === 0);

    const totalFound = issueResults.reduce(
      (sum, r) => sum + (r.perTool[toolName]?.issuesFound ?? 0),
      0
    );
    const totalExpected = issueResults.reduce(
      (sum, r) => sum + r.expectedIssueCount,
      0
    );
    const totalFalsePositives = results.reduce(
      (sum, r) => sum + (r.perTool[toolName]?.falsePositives ?? 0),
      0
    );
    const falsePositivesOnClean = cleanResults.reduce(
      (sum, r) => sum + (r.perTool[toolName]?.falsePositives ?? 0),
      0
    );
    const qualityScores = results
      .map((r) => r.perTool[toolName]?.commentQuality)
      .filter((q): q is number => q !== undefined);
    const avgCommentQuality =
      qualityScores.length > 0
        ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
        : 0;
    const timedOutCount = 0;

    return {
      name: toolName,
      totalFound,
      totalExpected,
      detectionRate: totalExpected > 0 ? (totalFound / totalExpected) * 100 : 0,
      totalFalsePositives,
      falsePositivesOnClean,
      avgCommentQuality,
      timedOutCount,
    };
  });
}

function formatDate(): string {
  return new Date().toISOString().split("T")[0];
}

function buildIssueBody(
  results: EvaluationResult[],
  toolSummaries: ToolSummary[],
  scenarios: Scenario[],
  prs: PrEntry[],
  runUrl: string
): string {
  const date = formatDate();
  const toolNames = toolSummaries.map((t) => t.name);

  const summaryTable = [
    `| Tool | Detection Rate | False Positives (total) | FP on Clean PR | Avg Comment Quality |`,
    `|------|---------------|------------------------|----------------|---------------------|`,
    ...toolSummaries.map(
      (t) =>
        `| ${t.name} | ${t.totalFound}/${t.totalExpected} (${t.detectionRate.toFixed(0)}%) | ${t.totalFalsePositives} | ${t.falsePositivesOnClean} | ${t.avgCommentQuality.toFixed(1)}/5 |`
    ),
  ].join("\n");

  const scenarioHeader =
    `| Scenario | Category | Expected |` +
    toolNames.map((n) => ` ${n} |`).join("");
  const scenarioSeparator =
    `|----------|----------|----------|` +
    toolNames.map(() => `----------|`).join("");

  const scenarioRows = results
    .map((result) => {
      const scenario = scenarios.find((s) => s.id === result.scenarioId);
      const pr = prs.find((p) => p.scenarioId === result.scenarioId);
      const scenarioLink = pr
        ? `[${result.scenarioId}](${pr.prUrl})`
        : result.scenarioId;
      const category = scenario?.category ?? "?";
      const toolCells = toolNames
        .map((name) => {
          const evaluation = result.perTool[name];
          if (!evaluation) return " — ";
          if (result.expectedIssueCount === 0) {
            return evaluation.falsePositives === 0 ? " ✅ 0 FP " : ` ⚠️ ${evaluation.falsePositives} FP `;
          }
          return ` ${evaluation.issuesFound}/${result.expectedIssueCount} `;
        })
        .join("|");
      return `| ${scenarioLink} | ${category} | ${result.expectedIssueCount} |${toolCells}|`;
    })
    .join("\n");

  const notableFindings: string[] = [];
  for (const result of results) {
    for (const [toolName, evaluation] of Object.entries(result.perTool)) {
      if (evaluation.notableFinding) {
        notableFindings.push(
          `- **${toolName}** on \`${result.scenarioId}\`: ${evaluation.notableFinding}`
        );
      }
    }
  }

  const prLinks = prs
    .map((p) => `- [${p.scenarioId} — PR #${p.prNumber}](${p.prUrl})`)
    .join("\n");

  return `# Benchmark Report — ${date}

## Summary

${summaryTable}

## Per-Scenario Breakdown

${scenarioHeader}
${scenarioSeparator}
${scenarioRows}

> Numbers show **issues found / total expected** for issue PRs, and **false positives** for the clean PR.

${notableFindings.length > 0 ? `## Notable Findings\n\n${notableFindings.join("\n")}\n` : ""}
## Links

${prLinks}

[View Actions Run](${runUrl})`;
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  const repoFull = required("GITHUB_REPO");
  const runUrl = process.env.RUN_URL ?? "";

  const [owner, repo] = repoFull.split("/");

  let results: EvaluationResult[];
  try {
    const raw =
      process.env.EVALUATION_JSON ?? readFileSync("/tmp/evaluation.json", "utf-8");
    results = JSON.parse(raw);
  } catch {
    results = [];
    console.warn("No evaluation results found, creating failure report");
  }

  const scenariosRaw =
    process.env.SCENARIOS_JSON ??
    readFileSync(
      new URL("../scenarios.json", import.meta.url).pathname,
      "utf-8"
    );
  const scenarios: Scenario[] = JSON.parse(scenariosRaw);

  const prs: PrEntry[] = process.env.PR_MATRIX
    ? JSON.parse(process.env.PR_MATRIX)
    : [];

  const toolNames =
    results.length > 0 ? Object.keys(results[0].perTool) : ["(no data)"];
  const toolSummaries = computeToolSummaries(results, toolNames);

  const body = buildIssueBody(results, toolSummaries, scenarios, prs, runUrl);

  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.issues.create({
    owner,
    repo,
    title: `Benchmark Report — ${formatDate()}`,
    body,
    labels: ["benchmark-report"],
  });

  console.log(`Created GitHub Issue #${data.number}: ${data.html_url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
