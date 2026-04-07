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
  "clean-ts": "✅",
  "cobol-payroll": "🗿",
  "huge-ts": "🔥",
  "spaghetti-python": "🌀",
  "balanced-java": "☕",
};

const SCENARIO_SHORT: Record<string, string> = {
  "clean-ts": "Clean TS",
  "cobol-payroll": "COBOL",
  "huge-ts": "Huge TS",
  "spaghetti-python": "Python",
  "balanced-java": "Java",
};

const SCENARIO_FOCUS: Record<string, string> = {
  "clean-ts": "false positive test",
  "cobol-payroll": "exotic language",
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

function formatSpeed(sec: number | null): string {
  if (sec === null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

function rawCell(text: string): object {
  return { type: "raw_text", text };
}

/** Build a Slack Table block */
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
    return {
      text: "⚠️ Daily benchmark failed — no evaluation results produced.",
    };
  }

  const toolNames = Object.keys(results[0].perTool);
  const rankings = computeOverallRatings(results, toolNames);
  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣"];
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const rankingText = rankings
    .map((r, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      return `${medal} *${r.name}* — ${ratingEmoji(r.overall)} *${r.overall}*`;
    })
    .join("\n");

  const scenarioIds = results.map((r) => r.scenarioId);
  const scorecardHeader = [
    "Tool",
    ...scenarioIds.map((id) => SCENARIO_SHORT[id] ?? id),
    "Overall",
  ];
  const scorecardRows: string[][] = rankings.map((r) => {
    const scenarioCells = scenarioIds.map((id) => {
      const result = results.find((res) => res.scenarioId === id);
      const grade = result?.perTool[r.name]?.rating ?? "?";
      return `${ratingEmoji(grade)} ${grade}`;
    });
    return [r.name, ...scenarioCells, `${ratingEmoji(r.overall)} ${r.overall}`];
  });

  return {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🔬 Code Review Benchmark — ${date}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Overall Rankings*\n${rankingText}`,
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Scorecard*" },
      },
      tableBlock([scorecardHeader, ...scorecardRows]),
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: issueUrl
            ? `<${issueUrl}|View full report →>`
            : "_Full report not available_",
        },
      },
    ],
  };
}

function buildScenarioPayload(
  result: ScenarioEvaluation,
  toolNames: string[]
): object {
  const emoji = SCENARIO_EMOJI[result.scenarioId] ?? "📋";
  const label = SCENARIO_SHORT[result.scenarioId] ?? result.scenarioId;
  const focus = SCENARIO_FOCUS[result.scenarioId] ?? "";

  const detailHeader = ["Tool", "Grade", "Blocker", "Important", "Extra", "Medium", "FP", "Noise", "Speed"];
  const detailRows: string[][] = toolNames.map((name) => {
    const t = result.perTool[name];
    if (!t) return [name, "?", "—", "—", "—", "—", "—", "—", "—"];
    const blockers = t.blockersTotal > 0 ? `${t.blockersCaught}/${t.blockersTotal}` : "—";
    const highs = t.highsTotal > 0 ? `${t.highsCaught}/${t.highsTotal}` : "—";
    return [
      name,
      `${ratingEmoji(t.rating)} ${t.rating}`,
      blockers,
      highs,
      t.extraCount > 0 ? String(t.extraCount) : "—",
      t.mediumCount > 0 ? String(t.mediumCount) : "—",
      t.fpCount > 0 ? String(t.fpCount) : "—",
      t.noiseCount > 0 ? String(t.noiseCount) : "—",
      formatSpeed(t.responseTimeSec),
    ];
  });

  const verdictBlocks = toolNames
    .flatMap((name) => {
      const t = result.perTool[name];
      if (!t?.verdict) return [];
      return [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${name}:* ${t.verdict}`.slice(0, 3000),
        },
      }];
    });

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${label}* _— ${focus}_`,
        },
      },
      tableBlock([detailHeader, ...detailRows]),
      ...verdictBlocks,
    ],
  };
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
