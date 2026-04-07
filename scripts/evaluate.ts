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
}

interface ToolStats {
  commentCount: number;
  responseTimeSec: number | null;
}

export interface ToolRating {
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
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const parts: string[] = [];
  for (const file of files) {
    parts.push(`--- ${file.filename} (+${file.additions}/-${file.deletions})`);
    if (file.patch) {
      parts.push(file.patch);
    }
    parts.push("");
  }
  return parts.join("\n");
}

async function fetchPrComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  loginToTool: Map<string, string>
): Promise<ToolComment[]> {
  const [reviewComments, issueComments] = await Promise.all([
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
    if (comments.length === 0) {
      stats.set(tool.name, { commentCount: 0, responseTimeSec: null });
      continue;
    }
    const firstMs = comments
      .map((c) => new Date(c.createdAt).getTime())
      .sort((a, b) => a - b)[0];
    stats.set(tool.name, {
      commentCount: comments.length,
      responseTimeSec: Math.round((firstMs - prCreatedMs) / 1000),
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
  const blockers = scenario.plantedIssues.filter((i) => i.severity === "blocker");
  const highs = scenario.plantedIssues.filter((i) => i.severity === "high");
  const smells = scenario.plantedIssues.filter((i) => i.severity === "smell");

  const plantedSection =
    scenario.plantedIssues.length === 0
      ? "None — this is a clean PR with no intentional issues."
      : [
          blockers.length > 0
            ? `BLOCKERS (${blockers.length}):\n` +
              blockers.map((i) => `  - ${i.description}`).join("\n")
            : "",
          highs.length > 0
            ? `HIGHS (${highs.length}):\n` +
              highs.map((i) => `  - ${i.description}`).join("\n")
            : "",
          smells.length > 0
            ? `SMELLS (${smells.length}):\n` +
              smells.map((i) => `  - ${i.description}`).join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");

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
          ? "did not comment"
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
These are the intentional issues introduced into this PR. They are ground truth.
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

Evaluate each tool's performance on this specific PR. You have the full diff and know exactly what was planted. Use your own judgment — there is no prescribed rubric or scoring formula. The evaluation focus above describes what matters most for this particular scenario.

For each tool, count how many of the BLOCKER issues and HIGH issues it actually caught based on its comments. A tool catches an issue if it correctly identifies the underlying problem — it doesn't need to use the exact same words, but the bug must be clearly recognized. Be strict: vague comments that mention a file without identifying the specific bug don't count.

For tools that did not comment at all, assign F and note they skipped the PR.

Respond with only a JSON object using this structure (tool names must match exactly: ${toolNames}):
{
  "scenarioId": "${scenario.id}",
  "prNumber": 0,
  "evaluationFocus": "${scenario.evaluationFocus.slice(0, FOCUS_MAX_LENGTH)}",
  "perTool": {
    "<tool name>": {
      "rating": "<letter grade, e.g. A, B+, C-, F>",
      "verdict": "<2-3 sentences: your honest assessment>",
      "plantedIssuesCaught": ["<brief description of each planted issue this tool caught>"],
      "plantedIssuesMissed": ["<brief description of each planted issue this tool missed>"],
      "notableComment": "<the single most useful or interesting comment this tool made, or null>",
      "noiseAssessment": "<brief: did the tool focus on what matters or scatter? mention comment volume if high>",
      "blockersCaught": <integer: how many BLOCKER issues this tool caught>,
      "highsCaught": <integer: how many HIGH issues this tool caught>
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

  const message = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const jsonText = jsonMatch ? jsonMatch[0] : text;

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
      }
    }
    result = parsed;
  } catch {
    console.error(
      `Failed to parse Claude response for ${scenario.id}:`,
      text.slice(0, ERROR_PREVIEW_LENGTH)
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
              plantedIssuesCaught: [],
              plantedIssuesMissed: scenario.plantedIssues.map((i) => i.description),
              notableComment: null,
              noiseAssessment: "unknown",
              blockersCaught: 0,
              blockersTotal,
              highsCaught: 0,
              highsTotal,
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
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-6";

  const [owner, repo] = repoFull.split("/");
  const prs: PrEntry[] = JSON.parse(prMatrixRaw);

  const scenariosPath = resolve(__dirname, "../scenarios.json");
  const toolsPath = resolve(__dirname, "../tools.json");
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenariosPath, "utf-8"));
  const { tools }: { tools: Tool[] } = JSON.parse(
    readFileSync(toolsPath, "utf-8")
  );

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
