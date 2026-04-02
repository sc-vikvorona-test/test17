import { readFileSync } from "node:fs";
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

interface SeverityBreakdown {
  blocker: number;
  high: number;
  medium: number;
  low: number;
}

interface ToolEvaluation {
  configured: boolean;
  issuesFound: number;
  severityBreakdown: SeverityBreakdown;
  falsePositives: number;
  nitpickRating: number;
  verbosityRating: number;
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
  configured: boolean;
  totalFound: number;
  totalExpected: number;
  detectionRate: number;
  severityBreakdown: SeverityBreakdown;
  totalFalsePositives: number;
  falsePositivesOnClean: number;
  avgFocusRating: number;
  avgConcisenessRating: number;
  avgCommentQuality: number;
}

function computeToolSummaries(
  results: EvaluationResult[],
  toolNames: string[]
): ToolSummary[] {
  const issueResults = results.filter((r) => r.expectedIssueCount > 0);
  const cleanResults = results.filter((r) => r.expectedIssueCount === 0);

  return toolNames.map((toolName) => {
    const firstEntry = results[0]?.perTool[toolName];
    const configured = firstEntry?.configured !== false;

    if (!configured) {
      return {
        name: toolName,
        configured: false,
        totalFound: 0,
        totalExpected: 0,
        detectionRate: 0,
        severityBreakdown: { blocker: 0, high: 0, medium: 0, low: 0 },
        totalFalsePositives: 0,
        falsePositivesOnClean: 0,
        avgFocusRating: 0,
        avgConcisenessRating: 0,
        avgCommentQuality: 0,
      };
    }

    const totalFound = issueResults.reduce(
      (sum, r) => sum + (r.perTool[toolName]?.issuesFound ?? 0),
      0
    );
    const totalExpected = issueResults.reduce((sum, r) => sum + r.expectedIssueCount, 0);

    const severityBreakdown: SeverityBreakdown = { blocker: 0, high: 0, medium: 0, low: 0 };
    for (const r of issueResults) {
      const sev = r.perTool[toolName]?.severityBreakdown;
      if (sev) {
        severityBreakdown.blocker += sev.blocker ?? 0;
        severityBreakdown.high += sev.high;
        severityBreakdown.medium += sev.medium;
        severityBreakdown.low += sev.low;
      }
    }

    const totalFalsePositives = results.reduce(
      (sum, r) => sum + (r.perTool[toolName]?.falsePositives ?? 0),
      0
    );
    const falsePositivesOnClean = cleanResults.reduce(
      (sum, r) => sum + (r.perTool[toolName]?.falsePositives ?? 0),
      0
    );

    const ratedResults = results.filter((r) => (r.perTool[toolName]?.commentQuality ?? 0) > 0);
    const avg = (field: keyof ToolEvaluation) => {
      const vals = ratedResults.map((r) => r.perTool[toolName]?.[field] as number).filter(Boolean);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };

    return {
      name: toolName,
      configured: true,
      totalFound,
      totalExpected,
      detectionRate: totalExpected > 0 ? (totalFound / totalExpected) * 100 : 0,
      severityBreakdown,
      totalFalsePositives,
      falsePositivesOnClean,
      avgFocusRating: avg("nitpickRating"),
      avgConcisenessRating: avg("verbosityRating"),
      avgCommentQuality: avg("commentQuality"),
    };
  });
}

function padR(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padL(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function stars(value: number, max: number = 5): string {
  const filled = Math.min(Math.max(0, Math.round(value)), max);
  return "●".repeat(filled) + "○".repeat(max - filled);
}

function medal(rank: number): string {
  return ["🥇", "🥈", "🥉"][rank] ?? `${rank + 1}.`;
}

function formatDate(): string {
  return new Date().toISOString().split("T")[0];
}

function fpIndicator(fp: number): string {
  return fp === 0 ? "✅ 0" : `⚠️ ${fp}`;
}

function buildLeaderboardBlocks(
  summaries: ToolSummary[],
  resultCount: number,
  runUrl: string
): object[] {
  const date = formatDate();
  const configuredSummaries = summaries.filter((s) => s.configured);
  const notConfiguredSummaries = summaries.filter((s) => !s.configured);

  const ranked = [...configuredSummaries].sort(
    (a, b) => b.detectionRate - a.detectionRate || a.totalFalsePositives - b.totalFalsePositives
  );

  const leaderboardLines = ranked.map((t, i) => {
    const sev = `B:${t.severityBreakdown.blocker} H:${t.severityBreakdown.high} M:${t.severityBreakdown.medium} L:${t.severityBreakdown.low}`;
    const fp = fpIndicator(t.totalFalsePositives);
    const fpClean = t.falsePositivesOnClean > 0 ? ` (${t.falsePositivesOnClean} on clean)` : "";
    return (
      `${medal(i)} *${t.name}*  ` +
      `${t.totalFound}/${t.totalExpected} detected (${t.detectionRate.toFixed(0)}%)  ` +
      `FP: ${fp}${fpClean}  ` +
      `[${sev}]\n` +
      `    Quality: ${stars(t.avgCommentQuality)}  ` +
      `Focus: ${stars(t.avgFocusRating)}  ` +
      `Conciseness: ${stars(t.avgConcisenessRating)}`
    );
  });

  if (notConfiguredSummaries.length > 0) {
    leaderboardLines.push(
      `⚠️ *${notConfiguredSummaries.map((s) => s.name).join(", ")}* — not configured`
    );
  }

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Code Review Benchmark — ${date}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Leaderboard* (${resultCount} scenarios)\n\n${leaderboardLines.join("\n\n")}`,
      },
    },
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${runUrl}|View Actions run> · Focus: 5=focused on real issues · Conciseness: 5=concise`,
        },
      ],
    },
  ];
}

function buildScenarioGridBlocks(
  results: EvaluationResult[],
  summaries: ToolSummary[],
  scenarios: Scenario[],
  _prs: PrEntry[]
): object[] {
  const configuredSummaries = summaries.filter((s) => s.configured);
  const ranked = [...configuredSummaries].sort(
    (a, b) => b.detectionRate - a.detectionRate || a.totalFalsePositives - b.totalFalsePositives
  );
  const toolNames = ranked.map((t) => t.name);

  function cellValue(result: EvaluationResult, toolName: string): string {
    const e = result.perTool[toolName];
    if (!e?.configured) return "—";
    if (result.expectedIssueCount === 0) {
      return e.falsePositives === 0 ? "✓ 0FP" : `! ${e.falsePositives}FP`;
    }
    const ratio = `${e.issuesFound}/${result.expectedIssueCount}`;
    return e.falsePositives > 0 ? `${ratio} +${e.falsePositives}FP` : ratio;
  }

  // Calculate column widths dynamically
  const idWidth = Math.max(8, ...results.map((r) => (r.scenarioId ?? "").length));
  const expWidth = 3; // "Exp"

  const toolWidths = toolNames.map((name) => {
    const headerLen = name.length;
    const dataLen = Math.max(...results.map((r) => cellValue(r, name).length));
    return Math.max(headerLen, dataLen);
  });

  const headerParts = [padR("Scenario", idWidth), padR("Exp", expWidth)];
  toolNames.forEach((name, i) => headerParts.push(padR(name, toolWidths[i])));
  const header = headerParts.join("  ");
  const separator = "─".repeat(header.length);

  const rows: string[] = [header, separator];

  for (const result of results) {
    const label = padR(result.scenarioId ?? "", idWidth);
    const exp = padR(String(result.expectedIssueCount), expWidth);
    const toolCols = toolNames.map((name, i) => padR(cellValue(result, name), toolWidths[i]));
    rows.push([label, exp, ...toolCols].join("  "));
  }

  const gridText = rows.join("\n");
  const SLACK_LIMIT = 2900;
  const prefix = "*Scenario Grid*  (found/expected  +FP=false positives)\n```\n";
  const suffix = "\n```";
  const body = gridText.length + prefix.length + suffix.length > SLACK_LIMIT
    ? gridText.slice(0, SLACK_LIMIT - prefix.length - suffix.length - 3) + "..."
    : gridText;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${prefix}${body}${suffix}`,
      },
    },
  ];
}

async function postToSlack(
  token: string,
  channel: string,
  blocks: object[]
): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, blocks, unfurl_links: false }),
  });

  const body = (await response.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    throw new Error(`Slack API error: ${body.error}`);
  }
  console.log(`Posted to Slack channel ${channel}`);
}

async function main(): Promise<void> {
  const slackToken = required("SLACK_TOKEN");
  const channel = process.env.SLACK_CHANNEL ?? "#code-review-benchmark-reports";
  const runUrl = process.env.RUN_URL ?? "";

  let results: EvaluationResult[];
  try {
    if (process.env.EVALUATION_JSON) {
      results = JSON.parse(process.env.EVALUATION_JSON);
    } else {
      results = JSON.parse(readFileSync("/tmp/evaluation.json", "utf-8"));
    }
  } catch {
    try {
      results = JSON.parse(readFileSync("/tmp/evaluation.json", "utf-8"));
    } catch {
      results = [];
      console.warn("No evaluation results found");
    }
  }

  const scenariosPath = new URL("../scenarios.json", import.meta.url).pathname;
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenariosPath, "utf-8"));

  const prs: PrEntry[] = process.env.PR_MATRIX ? JSON.parse(process.env.PR_MATRIX) : [];

  const toolNames = [...new Set(results.flatMap((r) => Object.keys(r.perTool)))];

  if (toolNames.length === 0) {
    console.warn("No tool data in results, skipping Slack post");
    return;
  }

  const summaries = computeToolSummaries(results, toolNames);

  await postToSlack(slackToken, channel, buildLeaderboardBlocks(summaries, results.length, runUrl));
  await postToSlack(slackToken, channel, buildScenarioGridBlocks(results, summaries, scenarios, prs));
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
