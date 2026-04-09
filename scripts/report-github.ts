import { Octokit } from "@octokit/rest";
import { readFileSync } from "node:fs";
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

interface ToolRating {
  rating: string;
  verdict: string;
  plantedIssuesCaught: string[];
  plantedIssuesMissed: string[];
  notableComment: string | null;
  noiseAssessment: string;
  blockersCaught: number;
  blockersTotal: number;
  highsCaught: number;
  highsTotal: number;
  extraCount: number;
  mediumCount: number;
  fpCount: number;
  noiseCount: number;
  snr: number | null;
  explainedCount: number;
  fixSuggestedCount: number;
  caughtByCategory: Record<string, number>;
  totalByCategory: Record<string, number>;
  commentCount: number;
  responseTimeSec: number | null;
}

interface ScenarioEvaluation {
  scenarioId: string;
  prNumber: number;
  evaluationFocus: string;
  perTool: Record<string, ToolRating>;
}

interface PrEntry {
  scenarioId: string;
  prNumber: number;
  prUrl: string;
}

interface Scenario {
  id: string;
  prTitle: string;
  evaluationFocus: string;
}

const SCENARIO_LABELS: Record<string, string> = {
  "clean-ts": "✅ Clean PR",
  "rust-metrics": "🦀 Rust Metrics",
  "huge-ts": "🔥 Huge TypeScript",
  "spaghetti-python": "🌀 Python Spaghetti",
  "balanced-java": "☕ Balanced Java",
};

const SCENARIO_FOCUS: Record<string, string> = {
  "clean-ts": "false positive test",
  "rust-metrics": "Rust expertise",
  "huge-ts": "prioritization under load",
  "spaghetti-python": "signal vs noise",
  "balanced-java": "precision benchmark",
};

const GRADE_SCORES: Record<string, number> = {
  "A+": 4.3, A: 4, "A-": 3.7,
  "B+": 3.3, B: 3, "B-": 2.7,
  "C+": 2.3, C: 2, "C-": 1.7,
  "D+": 1.3, D: 1, "D-": 0.7,
  F: 0,
};

const GRADE_THRESHOLDS: Array<[number, string]> = [
  [4.15, "A+"], [3.85, "A"], [3.5, "A-"],
  [3.15, "B+"], [2.85, "B"], [2.5, "B-"],
  [2.15, "C+"], [1.85, "C"], [1.5, "C-"],
  [1.15, "D+"], [0.85, "D"], [0.5, "D-"],
];

function gradeToNumber(grade: string): number {
  return GRADE_SCORES[grade] ?? 2;
}

function numberToGrade(n: number): string {
  for (const [threshold, grade] of GRADE_THRESHOLDS) {
    if (n >= threshold) return grade;
  }
  return "F";
}

function computeOverallRatings(
  results: ScenarioEvaluation[],
  toolNames: string[]
): Array<{ name: string; overall: string; score: number }> {
  return toolNames
    .map((name) => {
      const scores = results
        .map((r) => r.perTool[name]?.rating ?? "C")
        .map(gradeToNumber);
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      return { name, score: avg, overall: numberToGrade(avg) };
    })
    .sort((a, b) => b.score - a.score);
}

function formatDate(): string {
  return new Date().toISOString().split("T")[0];
}

function buildIssueBody(
  results: ScenarioEvaluation[],
  scenarios: Scenario[],
  prs: PrEntry[],
  runUrl: string
): string {
  const date = formatDate();
  const toolNames =
    results.length > 0 ? Object.keys(results[0].perTool) : [];
  const rankings = computeOverallRatings(results, toolNames);

  const rankingLines = rankings
    .map((r, i) => `${i + 1}. **${r.name}** — ${r.overall}`)
    .join("\n");

  // Aggregate category recall across all scenarios
  const allCategories = Array.from(new Set(
    results.flatMap((r) =>
      toolNames.flatMap((n) => Object.keys(r.perTool[n]?.totalByCategory ?? {}))
    )
  )).sort();

  const categoryTable = allCategories.length > 0 ? (() => {
    const header = `| Category | Total | ${toolNames.join(" | ")} |`;
    const sep = `|----------|-------|${toolNames.map(() => "------").join("|")}|`;
    const rows = allCategories.map((cat) => {
      const total = results.reduce((sum, r) => {
        const t = r.perTool[toolNames[0]];
        return sum + (t?.totalByCategory[cat] ?? 0);
      }, 0);
      const toolCols = toolNames.map((name) => {
        const caught = results.reduce((sum, r) => sum + (r.perTool[name]?.caughtByCategory[cat] ?? 0), 0);
        const pct = total > 0 ? Math.round((caught / total) * 100) : 0;
        return `${caught}/${total} (${pct}%)`;
      });
      return `| **${cat}** | ${total} | ${toolCols.join(" | ")} |`;
    });
    return `## Category Recall\n\n${header}\n${sep}\n${rows.join("\n")}`;
  })() : "";

  const scenarioSections = results
    .map((result) => {
      const scenario = scenarios.find((s) => s.id === result.scenarioId);
      const pr = prs.find((p) => p.scenarioId === result.scenarioId);
      const label = SCENARIO_LABELS[result.scenarioId] ?? result.scenarioId;
      const focus = SCENARIO_FOCUS[result.scenarioId] ?? result.evaluationFocus;
      const prLink = pr ? ` — [PR #${pr.prNumber}](${pr.prUrl})` : "";
      const title = scenario?.prTitle ?? result.scenarioId;

      const toolRows = toolNames
        .map((name) => {
          const t = result.perTool[name];
          if (!t) return `| ${name} | ? | — | — | — | — | — | — | — |`;
          const blockers = t.blockersTotal > 0 ? `${t.blockersCaught}/${t.blockersTotal}` : "—";
          const highs = t.highsTotal > 0 ? `${t.highsCaught}/${t.highsTotal}` : "—";
          const extra = t.extraCount > 0 ? `+${t.extraCount}` : "—";
          const fp = t.fpCount > 0 ? String(t.fpCount) : "—";
          const noise = t.noiseCount > 0 ? String(t.noiseCount) : "—";
          const snr = t.snr !== null ? String(t.snr) : "—";
          const caught = t.plantedIssuesCaught?.length ?? 0;
          const depth = caught > 0
            ? `${t.explainedCount ?? 0}/${caught}${(t.fixSuggestedCount ?? 0) > 0 ? ` (✓${t.fixSuggestedCount})` : ""}`
            : "—";
          return `| ${name} | **${t.rating}** | ${blockers} | ${highs} | ${extra} | ${fp} | ${noise} | ${snr} | ${depth} |`;
        })
        .join("\n");

      const verdicts = toolNames
        .map((name) => {
          const t = result.perTool[name];
          if (!t) return "";
          const notable = t.notableComment
            ? `\n  > *"${t.notableComment.slice(0, 200)}"*`
            : "";
          return `**${name}:** ${t.verdict}${notable}`;
        })
        .filter(Boolean)
        .join("\n\n");

      return `### ${label}${prLink}
*${title}* — ${focus}

| Tool | Rating | Blockers | Highs | Extra | FP | Noise | SNR | Depth |
|------|--------|----------|-------|-------|----|-------|-----|-------|
${toolRows}

${verdicts}`;
    })
    .join("\n\n---\n\n");

  return `# Benchmark Report — ${date}

## Overall Rankings

${rankingLines}

---

${categoryTable}

---

## Per-Scenario Results

${scenarioSections}

---

[View Actions Run](${runUrl})`;
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  const repoFull = required("GITHUB_REPO");
  const runUrl = process.env.RUN_URL ?? "";

  const [owner, repo] = repoFull.split("/");

  let results: ScenarioEvaluation[];
  try {
    const raw =
      process.env.EVALUATION_JSON ??
      readFileSync("/tmp/evaluation.json", "utf-8");
    results = JSON.parse(raw);
  } catch {
    results = [];
    console.warn("No evaluation results found, creating failure report");
  }

  const scenariosPath = new URL("../scenarios.json", import.meta.url).pathname;
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenariosPath, "utf-8"));

  const prs: PrEntry[] = process.env.PR_MATRIX
    ? JSON.parse(process.env.PR_MATRIX)
    : [];

  const body = buildIssueBody(results, scenarios, prs, runUrl);

  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.issues.create({
    owner,
    repo,
    title: `Benchmark Report — ${formatDate()}`,
    body,
    labels: ["benchmark-report"],
  });

  console.log(`Created GitHub Issue #${data.number}: ${data.html_url}`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `issue-url=${data.html_url}\n`
    );
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
