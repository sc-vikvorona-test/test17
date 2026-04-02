import { readFileSync } from "node:fs";
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

interface SeverityBreakdown {
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
  avgNitpickRating: number;
  avgVerbosityRating: number;
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
        severityBreakdown: { high: 0, medium: 0, low: 0 },
        totalFalsePositives: 0,
        falsePositivesOnClean: 0,
        avgNitpickRating: 0,
        avgVerbosityRating: 0,
        avgCommentQuality: 0,
      };
    }

    const totalFound = issueResults.reduce(
      (sum, r) => sum + (r.perTool[toolName]?.issuesFound ?? 0),
      0
    );
    const totalExpected = issueResults.reduce((sum, r) => sum + r.expectedIssueCount, 0);

    const severityBreakdown: SeverityBreakdown = { high: 0, medium: 0, low: 0 };
    for (const r of issueResults) {
      const sev = r.perTool[toolName]?.severityBreakdown;
      if (sev) {
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
      avgNitpickRating: avg("nitpickRating"),
      avgVerbosityRating: avg("verbosityRating"),
      avgCommentQuality: avg("commentQuality"),
    };
  });
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

function buildSlackBlocks(
  summaries: ToolSummary[],
  results: EvaluationResult[],
  scenarios: Scenario[],
  prs: PrEntry[],
  runUrl: string
): object[] {
  const date = formatDate();
  const configuredSummaries = summaries.filter((s) => s.configured);
  const notConfiguredSummaries = summaries.filter((s) => !s.configured);

  // Sort by detection rate desc, then by fewest FPs
  const ranked = [...configuredSummaries].sort(
    (a, b) => b.detectionRate - a.detectionRate || a.totalFalsePositives - b.totalFalsePositives
  );

  const leaderboardLines = ranked.map((t, i) => {
    const sev = `H:${t.severityBreakdown.high} M:${t.severityBreakdown.medium} L:${t.severityBreakdown.low}`;
    return (
      `${medal(i)} *${t.name}*  ${t.totalFound}/${t.totalExpected} (${t.detectionRate.toFixed(0)}%)  ` +
      `FP:${t.totalFalsePositives} (clean:${t.falsePositivesOnClean})  ` +
      `[${sev}]  ` +
      `quality:${t.avgCommentQuality.toFixed(1)}  ` +
      `nitpick:${stars(t.avgNitpickRating)}  ` +
      `verbosity:${stars(t.avgVerbosityRating)}`
    );
  });

  if (notConfiguredSummaries.length > 0) {
    leaderboardLines.push(
      `⚠️ *${notConfiguredSummaries.map((s) => s.name).join(", ")}* — not configured`
    );
  }

  // Per-scenario breakdown
  const toolOrder = ranked.map((t) => t.name);
  const scenarioHeader =
    `Scenario | Cat | Exp | ` + toolOrder.join(" | ");
  const scenarioRows = results.map((r) => {
    const pr = prs.find((p) => p.scenarioId === r.scenarioId);
    const prLink = pr ? `<${pr.prUrl}|${r.scenarioId}>` : r.scenarioId;
    const scenario = scenarios.find((s) => s.id === r.scenarioId);
    const cat = scenario?.category.slice(0, 4) ?? "?";
    const cells = toolOrder.map((name) => {
      const e = r.perTool[name];
      if (!e) return "-";
      if (r.expectedIssueCount === 0) {
        return e.falsePositives === 0 ? "✅" : `⚠️${e.falsePositives}fp`;
      }
      return `${e.issuesFound}/${r.expectedIssueCount}`;
    });
    return `${prLink} | ${cat} | ${r.expectedIssueCount} | ${cells.join(" | ")}`;
  });

  // Notable findings
  const notables: string[] = [];
  for (const r of results) {
    for (const [toolName, e] of Object.entries(r.perTool)) {
      if (e.notableFinding) {
        notables.push(`• *${toolName}* on \`${r.scenarioId}\`: ${e.notableFinding}`);
      }
    }
  }

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Code Review Benchmark — ${date}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Leaderboard*\n${leaderboardLines.join("\n")}`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Per-Scenario* \`${scenarioHeader}\`\n${scenarioRows.join("\n")}`,
      },
    },
  ];

  const trailingBlocks: object[] = [
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${runUrl}|View Actions run> · ${results.length} scenarios evaluated`,
        },
      ],
    },
  ];

  if (notables.length > 0) {
    return [
      ...blocks,
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Notable Findings*\n${notables.join("\n")}` },
      },
      ...trailingBlocks,
    ];
  }

  return [...blocks, ...trailingBlocks];
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
  const blocks = buildSlackBlocks(summaries, results, scenarios, prs, runUrl);

  await postToSlack(slackToken, channel, blocks);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
