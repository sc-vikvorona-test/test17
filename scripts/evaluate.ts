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

// Token pricing per million tokens (input / output) by model prefix
const MODEL_PRICING: Array<{ prefix: string; inputPer1M: number; outputPer1M: number }> = [
  { prefix: "claude-opus-4",    inputPer1M: 15.00, outputPer1M: 75.00 },
  { prefix: "claude-sonnet-4",  inputPer1M:  3.00, outputPer1M: 15.00 },
  { prefix: "claude-haiku-4",   inputPer1M:  0.80, outputPer1M:  4.00 },
  { prefix: "claude-opus-3",    inputPer1M: 15.00, outputPer1M: 75.00 },
  { prefix: "claude-sonnet-3",  inputPer1M:  3.00, outputPer1M: 15.00 },
  { prefix: "claude-haiku-3",   inputPer1M:  0.25, outputPer1M:  1.25 },
];

function getPricing(model: string): { inputPer1M: number; outputPer1M: number } {
  for (const p of MODEL_PRICING) {
    if (model.startsWith(p.prefix)) return p;
  }
  // Default to Sonnet pricing if unknown
  return { inputPer1M: 3.00, outputPer1M: 15.00 };
}

interface TokenUsage { inputTokens: number; outputTokens: number; calls: number }

function makeUsageTracker(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, calls: 0 };
}

function addUsage(tracker: TokenUsage, usage: { input_tokens: number; output_tokens: number }): void {
  tracker.inputTokens += usage.input_tokens;
  tracker.outputTokens += usage.output_tokens;
  tracker.calls++;
}

function formatCost(tracker: TokenUsage, model: string): string {
  const pricing = getPricing(model);
  const inputCost = (tracker.inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (tracker.outputTokens / 1_000_000) * pricing.outputPer1M;
  const total = inputCost + outputCost;
  return [
    `Claude API usage (${tracker.calls} calls):`,
    `  Input:  ${tracker.inputTokens.toLocaleString()} tokens  $${inputCost.toFixed(4)}`,
    `  Output: ${tracker.outputTokens.toLocaleString()} tokens  $${outputCost.toFixed(4)}`,
    `  Total:  $${total.toFixed(4)}`,
  ].join("\n");
}

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
  isReview: boolean;
}

interface ToolStats {
  commentCount: number;
  responseTimeSec: number | null;
}

// Sub-evaluator output (no grade/verdict — those come from arbiter)
interface SubToolRating {
  plantedCaughtIndices: number[];
  fpCount: number;
  fpNotes: string;
  noiseCount: number;
  noiseNotes: string;
  extraCount: number;
  mediumCount: number;
  explainedCount: number;
  fixSuggestedCount: number;
  notableComment: string | null;
  usefulnessScore: number | null;
}

interface SubEvalResult {
  perTool: Record<string, SubToolRating>;
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
  usefulnessScore: number | null;
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

// ---------------------------------------------------------------------------
// Grade computation — deterministic, based on structured fields only
// ---------------------------------------------------------------------------

function computeRating(r: ToolRating): string {
  if (r.commentCount === 0) return "F";

  // Weighted recall: blockers worth 2x highs
  const denom = r.blockersTotal * 2 + r.highsTotal;
  const recall = denom > 0
    ? (r.blockersCaught * 2 + r.highsCaught) / denom
    : 1.0;

  // Noise penalty: FPs hurt more than nitpicks
  const noisePenalty = Math.min(r.fpCount * 0.06 + r.noiseCount * 0.025, 0.25);

  // Depth bonus: small reward for quality explanations
  const caughtCount = r.plantedIssuesCaught.length;
  const depthBonus = caughtCount > 0 ? (r.explainedCount / caughtCount) * 0.08 : 0;

  const score = Math.max(0, Math.min(1, recall - noisePenalty + depthBonus));

  if (score >= 0.95) return "A+";
  if (score >= 0.88) return "A";
  if (score >= 0.82) return "A-";
  if (score >= 0.75) return "B+";
  if (score >= 0.68) return "B";
  if (score >= 0.60) return "B-";
  if (score >= 0.52) return "C+";
  if (score >= 0.44) return "C";
  if (score >= 0.36) return "C-";
  if (score >= 0.28) return "D+";
  if (score >= 0.20) return "D";
  if (score >= 0.10) return "D-";
  return "F";
}

// ---------------------------------------------------------------------------
// GitHub data fetching
// ---------------------------------------------------------------------------

function buildLoginToToolMap(tools: Tool[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    const logins = Array.isArray(tool.botLogin) ? tool.botLogin : [tool.botLogin];
    for (const login of logins) map.set(login, tool.name);
  }
  return map;
}

async function fetchPrCreatedAt(
  octokit: Octokit, owner: string, repo: string, prNumber: number
): Promise<string> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  return data.created_at;
}

async function fetchPrDiff(
  octokit: Octokit, owner: string, repo: string, prNumber: number
): Promise<string> {
  const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner, repo, pull_number: prNumber,
    headers: { accept: "application/vnd.github.diff" },
  });
  return response.data as unknown as string;
}

async function fetchPrComments(
  octokit: Octokit, owner: string, repo: string, prNumber: number,
  loginToTool: Map<string, string>
): Promise<ToolComment[]> {
  const [reviewComments, issueComments, reviews] = await Promise.all([
    octokit.paginate(octokit.pulls.listReviewComments, { owner, repo, pull_number: prNumber, per_page: 100 }),
    octokit.paginate(octokit.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 }),
    octokit.paginate(octokit.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 }),
  ]);

  const comments: ToolComment[] = [];

  for (const c of reviewComments) {
    const tool = loginToTool.get(c.user?.login ?? "");
    if (tool) comments.push({ tool, body: c.body, path: c.path, line: c.line ?? c.original_line ?? undefined, createdAt: c.created_at, isReview: true });
  }
  for (const c of issueComments) {
    const tool = loginToTool.get(c.user?.login ?? "");
    if (tool) comments.push({ tool, body: c.body ?? "", createdAt: c.created_at, isReview: false });
  }
  for (const r of reviews) {
    const tool = loginToTool.get(r.user?.login ?? "");
    if (tool && r.body) comments.push({ tool, body: r.body, createdAt: r.submitted_at ?? new Date().toISOString(), isReview: false });
  }

  return comments;
}

function computeToolStats(
  toolComments: ToolComment[], tools: Tool[], prCreatedAt: string
): Map<string, ToolStats> {
  const prCreatedMs = new Date(prCreatedAt).getTime();
  const stats = new Map<string, ToolStats>();

  for (const tool of tools) {
    const comments = toolComments.filter((c) => c.tool === tool.name);
    if (comments.length === 0) { stats.set(tool.name, { commentCount: 0, responseTimeSec: null }); continue; }
    const reviewComments = comments.filter((c) => c.isReview);
    const firstReviewMs = reviewComments.length > 0
      ? reviewComments.map((c) => new Date(c.createdAt).getTime()).sort((a, b) => a - b)[0]
      : null;
    stats.set(tool.name, {
      commentCount: comments.length,
      responseTimeSec: firstReviewMs === null ? null : Math.round((firstReviewMs - prCreatedMs) / 1000),
    });
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Shared helpers for building prompt sections
// ---------------------------------------------------------------------------

function buildPlantedSection(scenario: Scenario): string {
  return scenario.plantedIssues.length === 0
    ? "None — this is a clean PR with no intentional issues."
    : scenario.plantedIssues
        .map((i, idx) => `  [${idx}] ${i.severity.toUpperCase()} (${i.category ?? "general"}): ${i.description}`)
        .join("\n");
}

function buildStatsSection(tools: Tool[], toolStats: Map<string, ToolStats>): string {
  return tools.map((tool) => {
    const s = toolStats.get(tool.name)!;
    const speed = s.responseTimeSec === null
      ? s.commentCount > 0 ? "no inline comment" : "did not comment"
      : `${Math.floor(s.responseTimeSec / 60)}m${s.responseTimeSec % 60}s`;
    return `  ${tool.name}: ${s.commentCount} comments, first at ${speed}`;
  }).join("\n");
}

function buildToolSections(tools: Tool[], toolComments: ToolComment[]): string {
  const commentsByTool = new Map<string, ToolComment[]>();
  for (const tool of tools) commentsByTool.set(tool.name, []);
  for (const comment of toolComments) {
    const list = commentsByTool.get(comment.tool);
    if (list) list.push(comment);
  }
  return tools.map((tool) => {
    const comments = commentsByTool.get(tool.name) ?? [];
    if (comments.length === 0) return `<tool name="${tool.name}">\nNo comments posted.\n</tool>`;
    const commentText = comments
      .map((c, i) => {
        const lineSuffix = c.line ? `:${c.line}` : "";
        const location = c.path ? ` [${c.path}${lineSuffix}]` : "";
        return `Comment ${i + 1}${location}:\n${c.body}`;
      })
      .join("\n\n---\n\n");
    return `<tool name="${tool.name}" commentCount="${comments.length}">\n${commentText}\n</tool>`;
  }).join("\n\n");
}

// ---------------------------------------------------------------------------
// Sub-evaluator prompt
// ---------------------------------------------------------------------------

function buildSubEvalPrompt(
  scenario: Scenario, diff: string, toolComments: ToolComment[],
  tools: Tool[], toolStats: Map<string, ToolStats>
): string {
  const toolNames = tools.map((t) => `"${t.name}"`).join(", ");

  return `You are one of two independent evaluators in a code review benchmarking study. Your job is to carefully assess each tool's comments and report factual observations. A separate arbiter will cross-check your findings with the other evaluator's and produce the final verdict.

<scenario>
  <id>${scenario.id}</id>
  <title>${scenario.prTitle}</title>
  <project>${scenario.project}</project>
  <evaluation-focus>${scenario.evaluationFocus}</evaluation-focus>
</scenario>

<planted-issues>
These are the intentional issues introduced into this PR. They serve as ground truth for recall.
${buildPlantedSection(scenario)}
</planted-issues>

<tool-stats>
${buildStatsSection(tools, toolStats)}
</tool-stats>

<pull-request-diff>
${diff.slice(0, DIFF_CHAR_LIMIT)}
</pull-request-diff>

<tool-comments>
${buildToolSections(tools, toolComments)}
</tool-comments>

## Instructions

**Step 1 — Read the diff independently.**
Study the diff yourself before looking at tool comments. Form your own view of the issues present.

**Step 2 — Evaluate each tool's comments.**
- A tool catches a planted issue if it correctly identifies the underlying problem. Be strict: vague mentions without identifying the actual bug don't count. Record caught issues as their 0-based index.
- If a tool flags something NOT in the planted list: verify against the diff. If real, count as extra (blocker/high severity) or medium (valid but less critical). Only count as FP if you verified the code is actually correct.
- Noise = technically valid but a human would wave off: style nitpicks, trivial naming, obvious-from-context observations.

**Step 3 — Assess usefulness.**
Would a developer find this tool's review genuinely helpful? Rate 0–10: clarity, explanation quality, actionability, proportionality (focused on what matters). Null if tool didn't comment.

Respond with only a JSON object (tool names must match exactly: ${toolNames}):
{
  "perTool": {
    "<tool name>": {
      "plantedCaughtIndices": [<0-based indices of caught planted issues, e.g. [0, 2, 5]>],
      "fpCount": <integer: comments flagging code you verified is actually correct>,
      "fpNotes": "<brief: what did it incorrectly flag, or 'none'>",
      "noiseCount": <integer: valid but trivial/obvious comments a human would dismiss>,
      "noiseNotes": "<brief: what is the noise, or 'none'>",
      "extraCount": <integer: real unplanted findings at blocker/high severity>,
      "mediumCount": <integer: real unplanted findings that are valid but not critical>,
      "explainedCount": <integer: of caught planted issues, how many explained (1) specific code + (2) why it's a bug + (3) impact or fix. Label-only comments don't count>,
      "fixSuggestedCount": <integer: of caught planted issues, how many included actual code fix (not generic advice). Must be ≤ explainedCount>,
      "notableComment": "<the single most useful comment this tool made, or null>",
      "usefulnessScore": <integer 0-10 or null if tool didn't comment>
    }
  }
}`;
}

// ---------------------------------------------------------------------------
// Arbiter prompt
// ---------------------------------------------------------------------------

function buildArbiterPrompt(
  scenario: Scenario, diff: string, toolComments: ToolComment[],
  tools: Tool[], toolStats: Map<string, ToolStats>,
  subA: SubEvalResult, subB: SubEvalResult
): string {
  const toolNames = tools.map((t) => `"${t.name}"`).join(", ");

  const subAJson = JSON.stringify(subA.perTool, null, 2);
  const subBJson = JSON.stringify(subB.perTool, null, 2);

  return `You are the arbiter in a three-stage code review evaluation. Two independent evaluators have already assessed the tools. Your job is to cross-check their findings, resolve any disagreements by looking at the actual code and comments, and produce the final authoritative evaluation.

<scenario>
  <id>${scenario.id}</id>
  <title>${scenario.prTitle}</title>
  <project>${scenario.project}</project>
  <evaluation-focus>${scenario.evaluationFocus}</evaluation-focus>
</scenario>

<planted-issues>
${buildPlantedSection(scenario)}
</planted-issues>

<tool-stats>
${buildStatsSection(tools, toolStats)}
</tool-stats>

<pull-request-diff>
${diff.slice(0, DIFF_CHAR_LIMIT)}
</pull-request-diff>

<tool-comments>
${buildToolSections(tools, toolComments)}
</tool-comments>

<evaluator-A>
${subAJson}
</evaluator-A>

<evaluator-B>
${subBJson}
</evaluator-B>

## Arbiter instructions

For each tool:
1. **Where A and B agree** — accept that value directly unless you spot a clear error.
2. **Where they disagree on plantedCaughtIndices** — look at the tool's actual comments and the diff to make the call. Be strict: the tool must identify the specific bug mechanism, not just mention the area.
3. **Where they disagree on counts** — use the fpNotes/noiseNotes from both evaluators plus your own reading to decide.
4. **Write a verdict** (2-3 sentences): honest assessment of the tool's performance, including any notable bonus findings and depth of analysis. If you resolved disagreements, briefly note what you decided.
5. **Write a noiseAssessment**: did the tool focus on what matters, or scatter? Mention volume if high.
6. **Finalize usefulnessScore** (0-10): your own judgment, informed by both evaluators but not bound by them.

Respond with only a JSON object (tool names must match exactly: ${toolNames}):
{
  "perTool": {
    "<tool name>": {
      "plantedCaughtIndices": [<final 0-based indices>],
      "fpCount": <integer>,
      "noiseCount": <integer>,
      "extraCount": <integer>,
      "mediumCount": <integer>,
      "explainedCount": <integer>,
      "fixSuggestedCount": <integer>,
      "notableComment": "<string or null>",
      "noiseAssessment": "<string>",
      "verdict": "<2-3 sentences>",
      "usefulnessScore": <integer 0-10 or null>
    }
  }
}`;
}

// ---------------------------------------------------------------------------
// Sub-eval runner
// ---------------------------------------------------------------------------

async function runSubEval(
  anthropic: Anthropic, model: string, input: EvaluationInput, label: "A" | "B",
  usage: TokenUsage
): Promise<SubEvalResult> {
  const { scenario, diff, toolComments, tools, toolStats } = input;
  const prompt = buildSubEvalPrompt(scenario, diff, toolComments, tools, toolStats);

  const subToolSchema = {
    type: "object" as const,
    properties: {
      plantedCaughtIndices: { type: "array", items: { type: "integer" } },
      fpCount: { type: "integer" },
      fpNotes: { type: "string" },
      noiseCount: { type: "integer" },
      noiseNotes: { type: "string" },
      extraCount: { type: "integer" },
      mediumCount: { type: "integer" },
      explainedCount: { type: "integer" },
      fixSuggestedCount: { type: "integer" },
      notableComment: { type: ["string", "null"] },
      usefulnessScore: { type: ["integer", "null"] },
    },
    required: ["plantedCaughtIndices", "fpCount", "fpNotes", "noiseCount", "noiseNotes",
      "extraCount", "mediumCount", "explainedCount", "fixSuggestedCount",
      "notableComment", "usefulnessScore"],
  };

  const perToolProperties: Record<string, unknown> = {};
  for (const tool of tools) perToolProperties[tool.name] = subToolSchema;

  const start = Date.now();
  const message = await anthropic.messages.create({
    model,
    max_tokens: 8192,
    tools: [{
      name: "submit_sub_evaluation",
      description: "Submit independent sub-evaluation results",
      input_schema: {
        type: "object" as const,
        properties: { perTool: { type: "object", properties: perToolProperties } },
        required: ["perTool"],
      },
    }],
    tool_choice: { type: "tool", name: "submit_sub_evaluation" },
    messages: [{ role: "user", content: prompt }],
  });
  addUsage(usage, message.usage);
  console.log(`Sub-eval ${label} for ${scenario.id} took ${Math.round((Date.now() - start) / 1000)}s`);

  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error(`Sub-eval ${label} for ${scenario.id}: no tool_use in response`);

  const parsed = (toolUse as { type: "tool_use"; input: unknown }).input as SubEvalResult;

  // Clamp indices to valid range
  for (const tool of tools) {
    const r = parsed.perTool[tool.name];
    if (r) {
      r.plantedCaughtIndices = (r.plantedCaughtIndices ?? [])
        .filter((i) => i >= 0 && i < scenario.plantedIssues.length);
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Arbiter runner
// ---------------------------------------------------------------------------

async function runArbiter(
  anthropic: Anthropic, model: string, input: EvaluationInput,
  subA: SubEvalResult, subB: SubEvalResult, usage: TokenUsage
): Promise<Record<string, {
  plantedCaughtIndices: number[];
  fpCount: number;
  noiseCount: number;
  extraCount: number;
  mediumCount: number;
  explainedCount: number;
  fixSuggestedCount: number;
  notableComment: string | null;
  noiseAssessment: string;
  verdict: string;
  usefulnessScore: number | null;
}>> {
  const { scenario, diff, toolComments, tools, toolStats } = input;
  const prompt = buildArbiterPrompt(scenario, diff, toolComments, tools, toolStats, subA, subB);

  const arbiterToolSchema = {
    type: "object" as const,
    properties: {
      plantedCaughtIndices: { type: "array", items: { type: "integer" } },
      fpCount: { type: "integer" },
      noiseCount: { type: "integer" },
      extraCount: { type: "integer" },
      mediumCount: { type: "integer" },
      explainedCount: { type: "integer" },
      fixSuggestedCount: { type: "integer" },
      notableComment: { type: ["string", "null"] },
      noiseAssessment: { type: "string" },
      verdict: { type: "string" },
      usefulnessScore: { type: ["integer", "null"] },
    },
    required: ["plantedCaughtIndices", "fpCount", "noiseCount", "extraCount", "mediumCount",
      "explainedCount", "fixSuggestedCount", "notableComment", "noiseAssessment", "verdict",
      "usefulnessScore"],
  };

  const perToolProperties: Record<string, unknown> = {};
  for (const tool of tools) perToolProperties[tool.name] = arbiterToolSchema;

  const start = Date.now();
  const message = await anthropic.messages.create({
    model,
    max_tokens: 16384,
    tools: [{
      name: "submit_arbiter_evaluation",
      description: "Submit final arbiter evaluation",
      input_schema: {
        type: "object" as const,
        properties: { perTool: { type: "object", properties: perToolProperties } },
        required: ["perTool"],
      },
    }],
    tool_choice: { type: "tool", name: "submit_arbiter_evaluation" },
    messages: [{ role: "user", content: prompt }],
  });
  addUsage(usage, message.usage);
  console.log(`Arbiter for ${scenario.id} took ${Math.round((Date.now() - start) / 1000)}s`);

  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error(`Arbiter for ${scenario.id}: no tool_use in response`);

  const parsed = (toolUse as { type: "tool_use"; input: { perTool: ReturnType<typeof runArbiter> extends Promise<infer T> ? T : never } }).input;
  return parsed.perTool as Awaited<ReturnType<typeof runArbiter>>;
}

// ---------------------------------------------------------------------------
// Main evaluator — orchestrates sub-evals → arbiter → post-process
// ---------------------------------------------------------------------------

async function evaluateScenario(
  anthropic: Anthropic, model: string, input: EvaluationInput, usage: TokenUsage
): Promise<ScenarioEvaluation> {
  const { scenario, prEntry, tools, toolStats } = input;

  const blockersTotal = scenario.plantedIssues.filter((i) => i.severity === "blocker").length;
  const highsTotal = scenario.plantedIssues.filter((i) => i.severity === "high").length;

  const totalByCategory: Record<string, number> = {};
  for (const issue of scenario.plantedIssues) {
    if (issue.severity === "smell") continue;
    const cat = issue.category ?? "general";
    totalByCategory[cat] = (totalByCategory[cat] ?? 0) + 1;
  }

  try {
    // Phase 1: two independent sub-evals in parallel
    console.log(`  Running sub-evals A+B for ${scenario.id}...`);
    const [subA, subB] = await Promise.all([
      runSubEval(anthropic, model, input, "A", usage),
      runSubEval(anthropic, model, input, "B", usage),
    ]);

    // Phase 2: arbiter cross-checks and produces final verdict
    console.log(`  Running arbiter for ${scenario.id}...`);
    const arbiterResult = await runArbiter(anthropic, model, input, subA, subB, usage);

    // Phase 3: post-process into full ToolRating objects
    const perTool: Record<string, ToolRating> = {};

    for (const tool of tools) {
      const ar = arbiterResult[tool.name];
      const stats = toolStats.get(tool.name)!;

      if (!ar) {
        perTool[tool.name] = makeFallbackRating(tool.name, blockersTotal, highsTotal, totalByCategory, stats, scenario);
        continue;
      }

      const caughtIndices = (ar.plantedCaughtIndices ?? [])
        .filter((i) => i >= 0 && i < scenario.plantedIssues.length);
      const caughtSet = new Set(caughtIndices);

      const plantedIssuesCaught = caughtIndices.map((i) => scenario.plantedIssues[i].description);
      const plantedIssuesMissed = scenario.plantedIssues
        .map((issue, i) => ({ issue, i }))
        .filter(({ issue, i }) => issue.severity !== "smell" && !caughtSet.has(i))
        .map(({ issue }) => issue.description);

      const blockersCaught = caughtIndices.filter((i) => scenario.plantedIssues[i].severity === "blocker").length;
      const highsCaught = caughtIndices.filter((i) => scenario.plantedIssues[i].severity === "high").length;

      const caughtByCategory: Record<string, number> = {};
      for (const i of caughtIndices) {
        const issue = scenario.plantedIssues[i];
        if (issue.severity === "smell") continue;
        const cat = issue.category ?? "general";
        caughtByCategory[cat] = (caughtByCategory[cat] ?? 0) + 1;
      }

      const caughtCount = plantedIssuesCaught.length;
      const explainedCount = Math.min(ar.explainedCount ?? 0, caughtCount);
      const fixSuggestedCount = Math.min(ar.fixSuggestedCount ?? 0, explainedCount);

      const rating: ToolRating = {
        rating: "?", // placeholder — computed below
        verdict: ar.verdict ?? "",
        plantedCaughtIndices: caughtIndices,
        plantedIssuesCaught,
        plantedIssuesMissed,
        notableComment: ar.notableComment ?? null,
        noiseAssessment: ar.noiseAssessment ?? "",
        blockersCaught: Math.min(blockersCaught, blockersTotal),
        blockersTotal,
        highsCaught: Math.min(highsCaught, highsTotal),
        highsTotal,
        extraCount: ar.extraCount ?? 0,
        mediumCount: ar.mediumCount ?? 0,
        fpCount: ar.fpCount ?? 0,
        noiseCount: ar.noiseCount ?? 0,
        snr: null, // deprecated
        usefulnessScore: stats.commentCount === 0 ? null : (ar.usefulnessScore ?? null),
        explainedCount,
        fixSuggestedCount,
        caughtByCategory,
        totalByCategory,
        commentCount: stats.commentCount,
        responseTimeSec: stats.responseTimeSec,
      };

      rating.rating = computeRating(rating);
      perTool[tool.name] = rating;
    }

    return {
      scenarioId: scenario.id,
      prNumber: prEntry.prNumber,
      evaluationFocus: scenario.evaluationFocus.slice(0, FOCUS_MAX_LENGTH),
      perTool,
    };
  } catch (err) {
    console.error(`Evaluation failed for ${scenario.id}:`, String(err).slice(0, ERROR_PREVIEW_LENGTH));
    return {
      scenarioId: scenario.id,
      prNumber: prEntry.prNumber,
      evaluationFocus: scenario.evaluationFocus.slice(0, FOCUS_MAX_LENGTH),
      perTool: Object.fromEntries(
        tools.map((t) => [t.name, makeFallbackRating(t.name, blockersTotal, highsTotal, totalByCategory, toolStats.get(t.name)!, scenario)])
      ),
    };
  }
}

function makeFallbackRating(
  _toolName: string,
  blockersTotal: number,
  highsTotal: number,
  totalByCategory: Record<string, number>,
  stats: ToolStats,
  scenario: Scenario
): ToolRating {
  return {
    rating: "?",
    verdict: "Evaluation failed: could not parse Claude response",
    plantedCaughtIndices: [],
    plantedIssuesCaught: [],
    plantedIssuesMissed: scenario.plantedIssues.filter((i) => i.severity !== "smell").map((i) => i.description),
    notableComment: null,
    noiseAssessment: "unknown",
    blockersCaught: 0, blockersTotal,
    highsCaught: 0, highsTotal,
    extraCount: 0, mediumCount: 0, fpCount: 0, noiseCount: 0,
    snr: null,
    usefulnessScore: null,
    explainedCount: 0, fixSuggestedCount: 0,
    caughtByCategory: {}, totalByCategory,
    commentCount: stats.commentCount,
    responseTimeSec: stats.responseTimeSec,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
  const { tools: allTools }: { tools: Tool[] } = JSON.parse(readFileSync(toolsPath, "utf-8"));
  const tools = allTools.filter((t) => t.configured !== false);

  const loginToTool = buildLoginToToolMap(tools);
  const octokit = new Octokit({ auth: token });
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // Fetch all PR data in parallel
  const prData = await Promise.all(
    prs.map(async (prEntry) => {
      const scenario = scenarios.find((s) => s.id === prEntry.scenarioId);
      if (!scenario) { console.warn(`No scenario found for ${prEntry.scenarioId}`); return null; }
      console.log(`Fetching data for PR #${prEntry.prNumber} (${scenario.id})...`);
      const [prCreatedAt, diff, toolComments] = await Promise.all([
        fetchPrCreatedAt(octokit, owner, repo, prEntry.prNumber),
        fetchPrDiff(octokit, owner, repo, prEntry.prNumber),
        fetchPrComments(octokit, owner, repo, prEntry.prNumber, loginToTool),
      ]);
      const toolStats = computeToolStats(toolComments, tools, prCreatedAt);
      return { scenario, prEntry, diff, toolComments, toolStats };
    })
  );

  // Run all scenario evaluations in parallel (each scenario does 2 sub-evals + 1 arbiter internally)
  console.log("Running parallel scenario evaluations (2 sub-evals + arbiter each)...");
  const usage = makeUsageTracker();
  const results = await Promise.all(
    prData
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .map(({ scenario, prEntry, diff, toolComments, toolStats }) => {
        console.log(`Evaluating: ${scenario.id} (PR #${prEntry.prNumber})`);
        return evaluateScenario(anthropic, model, { scenario, prEntry, diff, toolComments, tools, toolStats }, usage);
      })
  );

  console.log(`\n${formatCost(usage, model)}`);

  const output = JSON.stringify(results, null, 2);
  writeFileSync("/tmp/evaluation.json", output);
  console.log(`\nEvaluation results written to /tmp/evaluation.json`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    const compact = JSON.stringify(results);
    const truncated = compact.length > OUTPUT_SIZE_LIMIT ? compact.slice(0, OUTPUT_SIZE_LIMIT) + "..." : compact;
    appendFileSync(process.env.GITHUB_OUTPUT, `evaluation-json=${truncated}\n`);
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
