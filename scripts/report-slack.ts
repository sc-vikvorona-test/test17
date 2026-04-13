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
  usefulnessScore: number | null;
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

const SCENARIO_EMOJI: Record<string, string> = {
  "rust-metrics": "🦀",
  "huge-ts": "🔥",
  "spaghetti-python": "🌀",
  "balanced-java": "☕",
};

const SCENARIO_SHORT: Record<string, string> = {
  "rust-metrics": "Rust",
  "huge-ts": "Huge TS",
  "spaghetti-python": "Python",
  "balanced-java": "Java",
};

const SCENARIO_FOCUS: Record<string, string> = {
  "rust-metrics": "Rust expertise",
  "huge-ts": "prioritization under load",
  "spaghetti-python": "signal vs noise",
  "balanced-java": "precision benchmark",
};

function ratingEmoji(rating: string): string {
  const first = rating[0]?.toUpperCase();
  if (first === "A") return "🟢";
  if (first === "B") return "🔵";
  if (first === "C") return "🟡";
  if (first === "D") return "🟠";
  return "🔴";
}

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

/** Recall % for a single tool in a single scenario (blockers + highs only). */
function recallPct(t: ToolRating): string {
  const total = t.blockersTotal + t.highsTotal;
  if (total === 0) return "—";
  return `${Math.round((t.blockersCaught + t.highsCaught) / total * 100)}%`;
}

/** Noise display: total FP + noise comments, — when tool didn't comment. */
function formatNoise(t: ToolRating): string {
  if (t.commentCount === 0) return "—";
  const n = (t.fpCount ?? 0) + (t.noiseCount ?? 0);
  return n === 0 ? "0" : String(n);
}

/** Usefulness display: score/10 or — when tool didn't comment. */
function formatUsefulness(t: ToolRating): string {
  if (t.usefulnessScore === null || t.usefulnessScore === undefined) return "—";
  return `${t.usefulnessScore}/10`;
}

function rawCell(text: string): object {
  return { type: "raw_text", text };
}

function tableBlock(rows: string[][]): object {
  return {
    type: "table",
    rows: rows.map((row) => row.map((cell) => rawCell(cell))),
  };
}

function buildMainPayload(
  results: ScenarioEvaluation[],
  issueUrl: string
): object {
  if (results.length === 0) {
    return { text: "⚠️ Daily benchmark failed — no evaluation results produced." };
  }

  const toolNames = Object.keys(results[0].perTool);
  const rankings = computeOverallRatings(results, toolNames);
  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣"];
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });

  // Aggregate recall + noise across all scenarios per tool
  type Agg = { caught: number; planted: number; noise: number; usefulSum: number; usefulCount: number };
  const agg = new Map<string, Agg>(
    toolNames.map((n) => [n, { caught: 0, planted: 0, noise: 0, usefulSum: 0, usefulCount: 0 }])
  );
  for (const r of results) {
    for (const name of toolNames) {
      const t = r.perTool[name];
      if (!t) continue;
      const a = agg.get(name)!;
      a.caught += t.blockersCaught + t.highsCaught;
      a.planted += t.blockersTotal + t.highsTotal;
      a.noise += (t.fpCount ?? 0) + (t.noiseCount ?? 0);
      if (t.usefulnessScore !== null && t.usefulnessScore !== undefined) {
        a.usefulSum += t.usefulnessScore;
        a.usefulCount++;
      }
    }
  }

  // Leaderboard: medal + name + grade + recall% + noise + usefulness
  const rankingLines = rankings
    .map((r, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const a = agg.get(r.name)!;
      const recall = a.planted > 0 ? `${Math.round(a.caught / a.planted * 100)}% recall` : "—";
      const noise = `${a.noise} noise`;
      const useful = a.usefulCount > 0 ? `${(a.usefulSum / a.usefulCount).toFixed(1)}/10 useful` : "";
      const parts = [recall, noise, useful].filter(Boolean).join("  |  ");
      return `${medal} *${r.name}* — ${ratingEmoji(r.overall)} *${r.overall}*  ${parts}`;
    })
    .join("\n");

  // Scorecard table
  const scenarioIds = results.map((r) => r.scenarioId);
  const scorecardHeader = ["Tool", ...scenarioIds.map((id) => SCENARIO_SHORT[id] ?? id), "Overall"];
  const scorecardRows = rankings.map((r) => {
    const cells = scenarioIds.map((id) => {
      const res = results.find((x) => x.scenarioId === id);
      const grade = res?.perTool[r.name]?.rating ?? "?";
      return `${ratingEmoji(grade)} ${grade}`;
    });
    return [r.name, ...cells, `${ratingEmoji(r.overall)} ${r.overall}`];
  });

  // Run-level insights (1-2 lines)
  const insights: string[] = [];
  const silentTools = toolNames.filter((n) =>
    results.every((r) => (r.perTool[n]?.commentCount ?? 0) === 0)
  );
  if (silentTools.length > 0) {
    insights.push(`🔇 ${silentTools.join(", ")} silent on all scenarios`);
  }
  const noisiest = [...agg.entries()]
    .filter(([, a]) => a.noise > 0)
    .sort((a, b) => b[1].noise - a[1].noise)[0];
  if (noisiest && noisiest[1].noise >= 8) {
    insights.push(`⚠️ ${noisiest[0]} — ${noisiest[1].noise} noise/FP comments`);
  }

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `🔬 Code Review Benchmark — ${date}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Rankings*\n${rankingLines}` },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Scorecard*" },
    },
    tableBlock([scorecardHeader, ...scorecardRows]),
  ];

  if (insights.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: insights.join("\n") },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: issueUrl ? `<${issueUrl}|View full report →>` : "_Full report not available_",
    },
  });

  return { blocks };
}

function buildScenarioPayload(
  result: ScenarioEvaluation,
  toolNames: string[]
): object {
  const emoji = SCENARIO_EMOJI[result.scenarioId] ?? "📋";
  const label = SCENARIO_SHORT[result.scenarioId] ?? result.scenarioId;
  const focus = SCENARIO_FOCUS[result.scenarioId] ?? "";

  // 7-column table: Tool | Grade | Recall | Extra | Noise | Depth | Useful
  const header = ["Tool", "Grade", "Recall", "Extra", "Noise", "Depth", "Useful"];
  const rows: string[][] = toolNames.map((name) => {
    const t = result.perTool[name];
    if (!t) return [name, "?", "—", "—", "—", "—", "—"];
    const caught = (t.plantedIssuesCaught ?? []).length;
    const depth = caught > 0
      ? `${t.explainedCount ?? 0}/${caught}${(t.fixSuggestedCount ?? 0) > 0 ? ` ✓${t.fixSuggestedCount}` : ""}`
      : "—";
    const extra = (t.extraCount ?? 0) > 0 ? `+${t.extraCount}` : "—";
    return [name, `${ratingEmoji(t.rating)} ${t.rating}`, recallPct(t), extra, formatNoise(t), depth, formatUsefulness(t)];
  });

  // Best tool by recall among those that commented
  const activeTools = toolNames.filter((n) => (result.perTool[n]?.commentCount ?? 0) > 0);
  const bestTool = [...activeTools].sort((a, b) => {
    const ta = result.perTool[a], tb = result.perTool[b];
    const rA = (ta.blockersCaught + ta.highsCaught) / Math.max(ta.blockersTotal + ta.highsTotal, 1);
    const rB = (tb.blockersCaught + tb.highsCaught) / Math.max(tb.blockersTotal + tb.highsTotal, 1);
    return rB - rA;
  })[0] ?? null;

  // Issues nobody caught (intersection of all active tools' missed lists)
  const activeMissed = activeTools.map((n) => new Set(result.perTool[n]?.plantedIssuesMissed ?? []));
  const nobodyCaught = activeMissed.length > 0
    ? [...activeMissed[0]].filter((issue) => activeMissed.every((s) => s.has(issue)))
    : [];

  const blocks: object[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${emoji} *${label}* _— ${focus}_` },
    },
    tableBlock([header, ...rows]),
  ];

  // Insight block
  const insightLines: string[] = [];

  if (bestTool) {
    const pct = recallPct(result.perTool[bestTool]);
    const notable = result.perTool[bestTool]?.notableComment;
    const notableStr = notable ? `\n> _${notable.slice(0, 1200).replace(/\n/g, " ")}${notable.length > 1200 ? "…" : ""}_` : "";
    insightLines.push(`⚡ *${bestTool}* led — ${pct} recall${notableStr}`);
  }

  if (nobodyCaught.length > 0) {
    const bullets = nobodyCaught
      .map((d) => `• ${d.length > 500 ? d.slice(0, 497) + "…" : d}`)
      .join("\n");
    insightLines.push(`🚫 *Nobody caught (${nobodyCaught.length}):*\n${bullets}`);
  }

  if (insightLines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: insightLines.join("\n\n") },
    });
  }

  return { blocks };
}

async function postToSlack(
  token: string,
  body: object
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<{ ok: boolean; ts?: string; error?: string }>;
}

async function main(): Promise<void> {
  const token = required("SLACK_TOKEN");
  const channel = required("SLACK_CHANNEL");
  const issueUrl = process.env.RUN_URL ?? process.env.ISSUE_URL ?? "";

  let results: ScenarioEvaluation[];
  const parseJson = (s: string): ScenarioEvaluation[] => JSON.parse(s);
  if (process.env.EVALUATION_JSON) {
    try {
      results = parseJson(process.env.EVALUATION_JSON);
    } catch {
      try {
        results = parseJson(readFileSync("/tmp/evaluation.json", "utf-8"));
      } catch {
        results = [];
        console.warn("No evaluation results found");
      }
    }
  } else {
    try {
      results = parseJson(readFileSync("/tmp/evaluation.json", "utf-8"));
    } catch {
      results = [];
      console.warn("No evaluation results found");
    }
  }

  const mainPayload = buildMainPayload(results, issueUrl);
  const mainData = await postToSlack(token, { channel, ...mainPayload });
  if (!mainData.ok) {
    throw new Error(`Slack API error: ${mainData.error}`);
  }
  if (!mainData.ts) {
    throw new Error("Slack response missing ts — cannot post thread replies");
  }
  console.log("Slack main message sent successfully");

  if (results.length === 0) return;

  const threadTs = mainData.ts;
  const toolNames = Object.keys(results[0].perTool);

  for (const result of results) {
    const scenarioPayload = buildScenarioPayload(result, toolNames);
    const scenarioData = await postToSlack(token, {
      channel,
      thread_ts: threadTs,
      ...scenarioPayload,
    });
    if (!scenarioData.ok) {
      throw new Error(`Slack API error posting scenario ${result.scenarioId}: ${scenarioData.error}`);
    }
    console.log(`Slack thread reply sent for scenario: ${result.scenarioId}`);
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
