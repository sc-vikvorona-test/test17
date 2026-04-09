import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const DIFF_CHAR_LIMIT = 80_000;
const FOCUS_MAX_LENGTH = 80;
const ERROR_PREVIEW_LENGTH = 500;
const OUTPUT_SIZE_LIMIT = 900_000;

const __dirname = dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

interface PlantedIssue {
  severity: "blocker" | "high" | "smell";
  category?: string;
  description: string;
}

interface Scenario {
  id: string;
  branch: string;
  sourceTag: string;
  prTitle: string;
  prBody: string;
  project: string;
  evaluationFocus: string;
  plantedIssues: PlantedIssue[];
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
  checkName: string | null;
  configured?: boolean;
}

interface EvaluationInput {
  scenario: Scenario;
  prEntry: PrEntry;
  diff: string;
  toolComments: ToolComment[];
  tools: Tool[];
  toolStats: Map<string, ToolStats>;
}

interface ToolComment {
  tool: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
  isReview: boolean; // true = inline diff comment, false = issue/summary comment
}

interface ToolStats {
  commentCount: number;
  responseTimeSec: number | null;
}

export interface ToolRating {
  rating: string;
  verdict: string;
  plantedCaughtIndices: number[];
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

export interface ScenarioEvaluation {
  scenarioId: string;
  prNumber: number;
  evaluationFocus: string;
  perTool: Record<string, ToolRating>;
}

function buildLoginToToolMap(tools: Tool[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    const logins = Array.isArray(tool.botLogin)
      ? tool.botLogin
      : [tool.botLogin];
    for (const login of logins) {
      map.set(login, tool.name);
    }
  }
  return map;
}

async function fetchPrCreatedAt(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  return data.created_at;
}

async function fetchPrDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber,
    headers: { accept: "application/vnd.github.diff" },
  });
  return response.data as unknown as string;
}

async function fetchPrComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  loginToTool: Map<string, string>
): Promise<ToolComment[]> {
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

  const comments: ToolComment[] = [];

  for (const c of reviewComments) {
    const tool = loginToTool.get(c.user?.login ?? "");
    if (tool) {
      comments.push({
        tool,
        body: c.body,
        path: c.path,
        line: c.line ?? c.original_line ?? undefined,
        createdAt: c.created_at,
        isReview: true,
      });
    }
  }

  for (const c of issueComments) {
    const tool = loginToTool.get(c.user?.login ?? "");
    if (tool) {
      comments.push({
        tool,
        body: c.body ?? "",
        createdAt: c.created_at,
        isReview: false,
      });
    }
  }

  for (const r of reviews) {
    const tool = loginToTool.get(r.user?.login ?? "");
    if (tool && r.body) {
      comments.push({
        tool,
        body: r.body,
        createdAt: r.submitted_at ?? new Date().toISOString(),
        isReview: false,
      });
    }
  }

  return comments;
}

function computeToolStats(
  toolComments: ToolComment[],
  tools: Tool[],
  prCreatedAt: string
): Map<string, ToolStats> {
  const prCreatedMs = new Date(prCreatedAt).getTime();
  const stats = new Map<string, ToolStats>();

  for (const tool of tools) {
    const comments = toolComments.filter((c) => c.tool === tool.name);
    // Speed = time to first inline review comment only (not summary/issue comments)
    const reviewComments = comments.filter((c) => c.isReview);
    if (comments.length === 0) {
      stats.set(tool.name, { commentCount: 0, responseTimeSec: null });
      continue;
    }
    const firstReviewMs = reviewComments.length > 0
      ? reviewComments.map((c) => new Date(c.createdAt).getTime()).sort((a, b) => a - b)[0]
      : null;
    stats.set(tool.name, {
      commentCount: comments.length,
      responseTimeSec: firstReviewMs === null
        ? null
        : Math.round((firstReviewMs - prCreatedMs) / 1000),
    });
  }

  return stats;
}

function buildPrompt(
  scenario: Scenario,
  diff: string,
  toolComments: ToolComment[],
  tools: Tool[],
  toolStats: Map<string, ToolStats>
): string {
  const plantedSection =
    scenario.plantedIssues.length === 0
      ? "None — this is a clean PR with no intentional issues."
      : scenario.plantedIssues
          .map((i, idx) => `  [${idx}] ${i.severity.toUpperCase()} (${i.category ?? "general"}): ${i.description}`)
          .join("\n");

  const commentsByTool = new Map<string, ToolComment[]>();
  for (const tool of tools) {
    commentsByTool.set(tool.name, []);
  }
  for (const comment of toolComments) {
    const list = commentsByTool.get(comment.tool);
    if (list) list.push(comment);
  }

  const statsSection = tools
    .map((tool) => {
      const s = toolStats.get(tool.name)!;
      const speed =
        s.responseTimeSec === null
          ? s.commentCount > 0 ? "no inline comment" : "did not comment"
          : `${Math.floor(s.responseTimeSec / 60)}m${s.responseTimeSec % 60}s`;
      return `  ${tool.name}: ${s.commentCount} comments, first at ${speed}`;
    })
    .join("\n");

  const toolSections = tools
    .map((tool) => {
      const comments = commentsByTool.get(tool.name) ?? [];
      if (comments.length === 0) {
        return `<tool name="${tool.name}">\nNo comments posted.\n</tool>`;
      }
      const commentText = comments
        .map((c, i) => {
          const lineSuffix = c.line ? `:${c.line}` : "";
          const location = c.path ? ` [${c.path}${lineSuffix}]` : "";
          return `Comment ${i + 1}${location}:\n${c.body}`;
        })
        .join("\n\n---\n\n");
      return `<tool name="${tool.name}" commentCount="${comments.length}">\n${commentText}\n</tool>`;
    })
    .join("\n\n");

  const toolNames = tools.map((t) => `"${t.name}"`).join(", ");

  return `You are evaluating how well code review tools performed on a pull request in a benchmarking study.

<scenario>
  <id>${scenario.id}</id>
  <title>${scenario.prTitle}</title>
  <project>${scenario.project}</project>
  <evaluation-focus>${scenario.evaluationFocus}</evaluation-focus>
</scenario>

<planted-issues>
These are the intentional issues introduced into this PR, numbered by index. They serve as ground truth for recall measurement.
${plantedSection}
</planted-issues>

<tool-stats>
Comment volume and response speed per tool (time from PR opening to first inline comment):
${statsSection}
</tool-stats>

<pull-request-diff>
${diff.slice(0, DIFF_CHAR_LIMIT)}
</pull-request-diff>

<tool-comments>
${toolSections}
</tool-comments>

## Evaluation instructions

**Step 1 — Read the diff independently.**
Before looking at any tool's comments, study the diff yourself. Form your own view of what issues are present: bugs, logic errors, security problems, design issues. This independent reading is your ground truth for judging FPs and for spotting issues that tools missed or found beyond the planted list.

**Step 2 — Evaluate each tool's comments against both the planted list and your own analysis.**
- A tool catches a planted issue if it correctly identifies the underlying problem — exact wording doesn't matter but the specific bug must be recognized. Be strict: vague comments that mention a file or area without identifying the actual bug don't count.
- Record caught planted issues as their 0-based index from the planted-issues list above.
- If a tool flags something NOT in the planted list: verify it against the diff yourself. If it is a real problem in the code, note it in the verdict as a bonus finding — do NOT count it as a false positive. Only count as FP if you have verified the code is actually correct at the flagged location.
- A "noise" comment is technically valid but low-value: style nitpicks, trivial naming suggestions, or observations obvious from context.

**Step 3 — Assess depth of analysis.**
Did the tool demonstrate genuine understanding of the code, or did it only catch surface-level or obvious issues? Flag in the verdict if a tool's findings appear shallow (e.g., only caught issues that were trivially visible without real code comprehension).

For tools that did not comment at all, assign F and note they skipped the PR.

Respond with only a JSON object using this structure (tool names must match exactly: ${toolNames}):
{
  "scenarioId": "${scenario.id}",
  "prNumber": 0,
  "evaluationFocus": "${scenario.evaluationFocus.slice(0, FOCUS_MAX_LENGTH)}",
  "perTool": {
    "<tool name>": {
      "rating": "<letter grade, e.g. A, B+, C-, F>",
      "verdict": "<2-3 sentences: your honest assessment, including depth of analysis and any bonus findings>",
      "plantedCaughtIndices": [<0-based indices from the planted-issues list that this tool caught, e.g. [0, 2, 5]>],
      "notableComment": "<the single most useful or interesting comment this tool made, or null>",
      "noiseAssessment": "<brief: did the tool focus on what matters or scatter? mention comment volume if high>",
      "blockersCaught": <integer: how many planted BLOCKER issues this tool caught>,
      "highsCaught": <integer: how many planted HIGH issues this tool caught>,
      "extraCount": <integer: real unplanted findings at blocker or important severity — e.g. a security vulnerability, data loss risk, or serious bug the tool found that was not on the planted list>,
      "mediumCount": <integer: real unplanted findings that are valid but not critical — e.g. an off-by-one, missing edge case, or logic error that the tool correctly identified but that was not planted and is not severe enough to be Extra>,
      "fpCount": <integer: comments flagging code that you verified is actually correct — only after checking the diff>,
      "noiseCount": <integer: valid but a human author would just wave off — style nitpicks, trivial naming suggestions, observations obvious from context>,
      "explainedCount": <integer: of the caught planted issues, how many did the tool explain well — meaning the comment identifies (1) the specific vulnerable/buggy code, (2) WHY it is a bug (the mechanism, not just a label), AND (3) the consequence/impact OR a concrete fix. A comment that only names the issue type ("SQL injection here") without mechanism/impact does NOT count>,
      "fixSuggestedCount": <integer: of the caught planted issues, how many included a concrete code fix — actual changed code or a specific parameterized example, not generic advice like "use parameterized queries". Must be ≤ explainedCount>
    }
  }
}`;
}

async function evaluateScenario(
  anthropic: Anthropic,
  model: string,
  input: EvaluationInput
): Promise<ScenarioEvaluation> {
  const { scenario, prEntry, diff, toolComments, tools, toolStats } = input;
  const prompt = buildPrompt(scenario, diff, toolComments, tools, toolStats);

  const evalStart = Date.now();
  const toolRatingSchema = {
    type: "object" as const,
    properties: {
      rating: { type: "string" },
      verdict: { type: "string" },
      plantedCaughtIndices: { type: "array", items: { type: "integer" } },
      notableComment: { type: ["string", "null"] },
      noiseAssessment: { type: "string" },
      blockersCaught: { type: "integer" },
      highsCaught: { type: "integer" },
      extraCount: { type: "integer" },
      mediumCount: { type: "integer" },
      fpCount: { type: "integer" },
      noiseCount: { type: "integer" },
      explainedCount: { type: "integer" },
      fixSuggestedCount: { type: "integer" },
    },
    required: ["rating", "verdict", "plantedCaughtIndices",
      "notableComment", "noiseAssessment", "blockersCaught", "highsCaught",
      "extraCount", "mediumCount", "fpCount", "noiseCount",
      "explainedCount", "fixSuggestedCount"],
  };

  const perToolProperties: Record<string, unknown> = {};
  for (const tool of tools) {
    perToolProperties[tool.name] = toolRatingSchema;
  }

  const message = await anthropic.messages.create({
    model,
    max_tokens: 16384,
    tools: [{
      name: "submit_evaluation",
      description: "Submit the completed scenario evaluation",
      input_schema: {
        type: "object" as const,
        properties: {
          scenarioId: { type: "string" },
          prNumber: { type: "integer" },
          evaluationFocus: { type: "string" },
          perTool: { type: "object", properties: perToolProperties },
        },
        required: ["scenarioId", "prNumber", "evaluationFocus", "perTool"],
      },
    }],
    tool_choice: { type: "tool", name: "submit_evaluation" },
    messages: [{ role: "user", content: prompt }],
  });

  const evalMs = Date.now() - evalStart;
  console.log(`Claude evaluation for ${scenario.id} took ${Math.round(evalMs / 1000)}s`);

  const toolUse = message.content.find((b) => b.type === "tool_use");
  const jsonText = toolUse ? JSON.stringify((toolUse as { type: "tool_use"; input: unknown }).input) : "";

  const blockersTotal = scenario.plantedIssues.filter(
    (i) => i.severity === "blocker"
  ).length;
  const highsTotal = scenario.plantedIssues.filter(
    (i) => i.severity === "high"
  ).length;

  let result: ScenarioEvaluation;
  try {
    const parsed = JSON.parse(jsonText);
    parsed.prNumber = prEntry.prNumber;

    // Compute totalByCategory from the scenario's planted issues (same for all tools)
    const totalByCategory: Record<string, number> = {};
    for (const issue of scenario.plantedIssues) {
      if (issue.severity === "smell") continue;
      const cat = issue.category ?? "general";
      totalByCategory[cat] = (totalByCategory[cat] ?? 0) + 1;
    }

    // Merge in computed stats that Claude doesn't need to calculate
    for (const tool of tools) {
      const rating = parsed.perTool[tool.name];
      if (rating) {
        const stats = toolStats.get(tool.name)!;
        rating.commentCount = stats.commentCount;
        rating.responseTimeSec = stats.responseTimeSec;
        rating.blockersTotal = blockersTotal;
        rating.highsTotal = highsTotal;
        rating.blockersCaught = Math.min(rating.blockersCaught ?? 0, blockersTotal);
        rating.highsCaught = Math.min(rating.highsCaught ?? 0, highsTotal);
        rating.extraCount = rating.extraCount ?? 0;
        rating.mediumCount = rating.mediumCount ?? 0;
        rating.fpCount = rating.fpCount ?? 0;
        rating.noiseCount = rating.noiseCount ?? 0;
        rating.explainedCount = rating.explainedCount ?? 0;
        rating.fixSuggestedCount = rating.fixSuggestedCount ?? 0;

        // Reconstruct caught/missed descriptions from indices
        const caughtIndices: number[] = (rating.plantedCaughtIndices ?? [])
          .filter((i: number) => i >= 0 && i < scenario.plantedIssues.length);
        const caughtSet = new Set(caughtIndices);
        rating.plantedCaughtIndices = caughtIndices;
        rating.plantedIssuesCaught = caughtIndices.map((i) => scenario.plantedIssues[i].description);
        rating.plantedIssuesMissed = scenario.plantedIssues
          .map((issue, i) => ({ issue, i }))
          .filter(({ issue, i }) => issue.severity !== "smell" && !caughtSet.has(i))
          .map(({ issue }) => issue.description);

        // Category-level recall
        const caughtByCategory: Record<string, number> = {};
        for (const i of caughtIndices) {
          const issue = scenario.plantedIssues[i];
          if (issue.severity === "smell") continue;
          const cat = issue.category ?? "general";
          caughtByCategory[cat] = (caughtByCategory[cat] ?? 0) + 1;
        }
        rating.caughtByCategory = caughtByCategory;
        rating.totalByCategory = totalByCategory;

        // Clamp depth counts to actual caught count
        const caughtCount = caughtIndices.length;
        rating.explainedCount = Math.min(rating.explainedCount, caughtCount);
        rating.fixSuggestedCount = Math.min(rating.fixSuggestedCount, rating.explainedCount);

        // SNR = useful signals / noise (higher is better; null when tool didn't comment)
        if (stats.commentCount === 0) {
          rating.snr = null;
        } else {
          const useful = rating.blockersCaught + rating.highsCaught + rating.extraCount + rating.mediumCount;
          const noise = rating.fpCount + rating.noiseCount;
          rating.snr = parseFloat((useful / Math.max(noise, 1)).toFixed(2));
        }
      }
    }
    result = parsed;
  } catch {
    console.error(
      `Failed to parse Claude response for ${scenario.id}:`,
      jsonText.slice(0, ERROR_PREVIEW_LENGTH)
    );
    result = {
      scenarioId: scenario.id,
      prNumber: prEntry.prNumber,
      evaluationFocus: scenario.evaluationFocus.slice(0, FOCUS_MAX_LENGTH),
      perTool: Object.fromEntries(
        tools.map((t) => {
          const stats = toolStats.get(t.name)!;
          return [
            t.name,
            {
              rating: "?",
              verdict: "Evaluation failed: could not parse Claude response",
              plantedCaughtIndices: [],
              plantedIssuesCaught: [],
              plantedIssuesMissed: scenario.plantedIssues
                .filter((i) => i.severity !== "smell")
                .map((i) => i.description),
              notableComment: null,
              noiseAssessment: "unknown",
              blockersCaught: 0,
              blockersTotal,
              highsCaught: 0,
              highsTotal,
              extraCount: 0,
              mediumCount: 0,
              fpCount: 0,
              noiseCount: 0,
              snr: null,
              explainedCount: 0,
              fixSuggestedCount: 0,
              caughtByCategory: {},
              totalByCategory: {},
              commentCount: stats.commentCount,
              responseTimeSec: stats.responseTimeSec,
            },
          ];
        })
      ),
    };
  }

  return result;
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  const repoFull = required("GITHUB_REPO");
  const prMatrixRaw = required("PR_MATRIX");
  const anthropicKey = required("ANTHROPIC_API_KEY");
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

  const [owner, repo] = repoFull.split("/");
  const prs: PrEntry[] = JSON.parse(prMatrixRaw);

  const scenariosPath = resolve(__dirname, "../scenarios.json");
  const toolsPath = resolve(__dirname, "../tools.json");
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenariosPath, "utf-8"));
  const { tools: allTools }: { tools: Tool[] } = JSON.parse(
    readFileSync(toolsPath, "utf-8")
  );
  const tools = allTools.filter((t) => t.configured !== false);

  const loginToTool = buildLoginToToolMap(tools);

  const octokit = new Octokit({ auth: token });
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // Fetch all PR data in parallel
  const prData = await Promise.all(
    prs.map(async (prEntry) => {
      const scenario = scenarios.find((s) => s.id === prEntry.scenarioId);
      if (!scenario) {
        console.warn(`No scenario found for ${prEntry.scenarioId}`);
        return null;
      }
      console.log(
        `Fetching data for PR #${prEntry.prNumber} (${scenario.id})...`
      );
      const [prCreatedAt, diff, toolComments] = await Promise.all([
        fetchPrCreatedAt(octokit, owner, repo, prEntry.prNumber),
        fetchPrDiff(octokit, owner, repo, prEntry.prNumber),
        fetchPrComments(octokit, owner, repo, prEntry.prNumber, loginToTool),
      ]);
      const toolStats = computeToolStats(toolComments, tools, prCreatedAt);
      return { scenario, prEntry, diff, toolComments, toolStats };
    })
  );

  // Run all evaluations in parallel — one focused prompt per scenario
  console.log("Running parallel scenario evaluations...");
  const results = await Promise.all(
    prData
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .map(({ scenario, prEntry, diff, toolComments, toolStats }) => {
        console.log(`Evaluating: ${scenario.id} (PR #${prEntry.prNumber})`);
        return evaluateScenario(anthropic, model, {
          scenario,
          prEntry,
          diff,
          toolComments,
          tools,
          toolStats,
        });
      })
  );

  const output = JSON.stringify(results, null, 2);
  writeFileSync("/tmp/evaluation.json", output);
  console.log(`\nEvaluation results written to /tmp/evaluation.json`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    // Use compact JSON (no newlines) — multiline values break the key=value format
    const compact = JSON.stringify(results);
    const truncated =
      compact.length > OUTPUT_SIZE_LIMIT ? compact.slice(0, OUTPUT_SIZE_LIMIT) + "..." : compact;
    appendFileSync(process.env.GITHUB_OUTPUT, `evaluation-json=${truncated}\n`);
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
