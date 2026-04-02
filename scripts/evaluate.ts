import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_COMMENT_LENGTH = 1500;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

interface Scenario {
  id: string;
  branch: string;
  sourceTag: string;
  prTitle: string;
  prBody: string;
  project: string;
  category: string;
  expectedIssues: { security: number; bugs: number; smells: number };
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
  configured: boolean;
}

interface CheckResult {
  conclusion: string;
  completedAt: string | null;
  detailsUrl: string | null;
}

interface ToolComment {
  tool: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
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

async function fetchPrComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  loginToTool: Map<string, string>
): Promise<ToolComment[]> {
  const comments: ToolComment[] = [];

  const reviewComments = await octokit.paginate(
    octokit.pulls.listReviewComments,
    { owner, repo, pull_number: prNumber, per_page: 100 }
  );
  for (const c of reviewComments) {
    const tool = loginToTool.get(c.user?.login ?? "");
    if (!tool) continue;
    comments.push({
      tool,
      body: c.body.slice(0, MAX_COMMENT_LENGTH),
      path: c.path,
      line: c.line ?? c.original_line ?? undefined,
      createdAt: c.created_at,
    });
  }

  const issueComments = await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  for (const c of issueComments) {
    const tool = loginToTool.get(c.user?.login ?? "");
    if (!tool) continue;
    comments.push({
      tool,
      body: c.body?.slice(0, MAX_COMMENT_LENGTH) ?? "",
      createdAt: c.created_at,
    });
  }

  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  for (const r of reviews) {
    const tool = loginToTool.get(r.user?.login ?? "");
    if (!tool || !r.body) continue;
    comments.push({
      tool,
      body: r.body.slice(0, MAX_COMMENT_LENGTH),
      createdAt: r.submitted_at ?? new Date().toISOString(),
    });
  }

  return comments;
}

async function fetchChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string[]> {
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return files.map(
    (f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`
  );
}

function buildPrompt(
  scenario: Scenario,
  changedFiles: string[],
  toolComments: ToolComment[],
  checksSummary: Record<string, CheckResult>,
  configuredTools: Tool[],
  isCleanPr: boolean
): string {
  const expectedCount =
    scenario.expectedIssues.security +
    scenario.expectedIssues.bugs +
    scenario.expectedIssues.smells;

  const toolReviewsSection = configuredTools
    .map((tool) => {
      const check = tool.checkName
        ? (checksSummary[tool.checkName] ?? { conclusion: "not_found", detailsUrl: null })
        : { conclusion: "no_check_run", detailsUrl: null };
      const comments = toolComments.filter((c) => c.tool === tool.name);
      const inlineComments = comments.filter((c) => c.path);
      const summaryComments = comments.filter((c) => !c.path);

      const inlineSection =
        inlineComments.length > 0
          ? inlineComments.map((c) => `  [${c.path}:${c.line ?? "?"}] ${c.body}`).join("\n")
          : "  (none)";

      const summarySection =
        summaryComments.length > 0
          ? summaryComments.map((c) => `  ${c.body}`).join("\n")
          : "  (none)";

      return `=== ${tool.name} ===
Check: ${check.conclusion}
Inline comments (${inlineComments.length}):
${inlineSection}
Summary comments (${summaryComments.length}):
${summarySection}`;
    })
    .join("\n\n");

  const cleanPrNote = isCleanPr
    ? `\nIMPORTANT: This is a CLEAN PR — no intentional issues. Any issue flagged = false positive. Set issuesFound=0 for all tools.`
    : "";

  const toolNames = configuredTools.map((t) => `"${t.name}"`).join(", ");

  const schemaEntries = configuredTools
    .map(
      (t) =>
        `"${t.name}": { "configured": true, "issuesFound": 0, "severityBreakdown": { "blocker": 0, "high": 0, "medium": 0, "low": 0 }, "falsePositives": 0, "nitpickRating": 3, "verbosityRating": 3, "commentQuality": 1, "notableFinding": null }`
    )
    .join(",\n    ");

  return `<scenario>
id: ${scenario.id} | category: ${scenario.category} | project: ${scenario.project}
Expected issues: ${expectedCount} (${scenario.expectedIssues.security} security, ${scenario.expectedIssues.bugs} bugs, ${scenario.expectedIssues.smells} smells)${cleanPrNote}
Changed files: ${changedFiles.join(", ")}
</scenario>

<reviews>
${toolReviewsSection}
</reviews>

Evaluate each tool (${toolNames}). For each:
- issuesFound: distinct real issues identified (not comment count)
- severityBreakdown: classify each found issue as blocker (crash/data-loss/security), high (likely bug), medium (possible bug/design), or low (minor/style). Must sum to issuesFound
- falsePositives: comments on non-issues or things outside this diff
- nitpickRating 1-5: 5=only real issues, 1=mostly style/nitpick noise
- verbosityRating 1-5: 5=concise, 1=very verbose/padded
- commentQuality 1-5: accuracy + actionability + clarity (1 if no comments)
- notableFinding: one sentence on something surprising, or null

Reply ONLY with valid JSON, no markdown:
{
  "scenarioId": "${scenario.id}",
  "prNumber": 0,
  "expectedIssueCount": ${expectedCount},
  "perTool": {
    ${schemaEntries}
  }
}`;
}

interface ScenarioData {
  prEntry: PrEntry;
  changedFiles: string[];
  toolComments: ToolComment[];
  checksSummary: Record<string, CheckResult>;
}

async function evaluateScenario(
  anthropic: Anthropic,
  model: string,
  scenario: Scenario,
  data: ScenarioData,
  allTools: Tool[]
): Promise<EvaluationResult> {
  const configuredTools = allTools.filter((t) => t.configured);
  const isCleanPr = scenario.category === "clean";

  const prompt = buildPrompt(
    scenario,
    data.changedFiles,
    data.toolComments,
    data.checksSummary,
    configuredTools,
    isCleanPr
  );

  const message = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";

  const expectedCount =
    scenario.expectedIssues.security +
    scenario.expectedIssues.bugs +
    scenario.expectedIssues.smells;

  const notConfiguredEntry: ToolEvaluation = {
    configured: false,
    issuesFound: 0,
    severityBreakdown: { blocker: 0, high: 0, medium: 0, low: 0 },
    falsePositives: 0,
    nitpickRating: 0,
    verbosityRating: 0,
    commentQuality: 0,
    notableFinding: null,
  };

  let result: EvaluationResult;
  try {
    result = JSON.parse(text);
    result.prNumber = data.prEntry.prNumber;
    for (const tool of allTools.filter((t) => !t.configured)) {
      result.perTool[tool.name] = notConfiguredEntry;
    }
  } catch {
    console.error(`Failed to parse Claude response for ${scenario.id}:`, text);
    result = {
      scenarioId: scenario.id,
      prNumber: data.prEntry.prNumber,
      expectedIssueCount: expectedCount,
      perTool: Object.fromEntries(
        allTools.map((t) => [
          t.name,
          t.configured
            ? {
                configured: true,
                issuesFound: 0,
                severityBreakdown: { blocker: 0, high: 0, medium: 0, low: 0 },
                falsePositives: 0,
                nitpickRating: 0,
                verbosityRating: 0,
                commentQuality: 0,
                notableFinding: null,
              }
            : notConfiguredEntry,
        ])
      ),
    };
  }

  return result;
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  const repoFull = required("GITHUB_REPO");
  const prMatrixRaw = required("PR_MATRIX");
  const checksSummaryRaw = required("CHECKS_SUMMARY");
  const anthropicKey = required("ANTHROPIC_API_KEY");
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

  const [owner, repo] = repoFull.split("/");
  const prs: PrEntry[] = JSON.parse(prMatrixRaw);
  const allChecksSummary: Record<string, Record<string, CheckResult>> =
    JSON.parse(checksSummaryRaw);

  const scenariosPath = resolve(__dirname, "../scenarios.json");
  const toolsPath = resolve(__dirname, "../tools.json");
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenariosPath, "utf-8"));
  const { tools }: { tools: Tool[] } = JSON.parse(readFileSync(toolsPath, "utf-8"));

  const loginToTool = new Map<string, string>();
  for (const tool of tools) {
    const logins = Array.isArray(tool.botLogin) ? tool.botLogin : [tool.botLogin];
    for (const login of logins) {
      loginToTool.set(login, tool.name);
    }
  }

  const octokit = new Octokit({ auth: token });
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const results: EvaluationResult[] = [];

  for (const prEntry of prs) {
    const scenario = scenarios.find((s) => s.id === prEntry.scenarioId);
    if (!scenario) {
      console.warn(`No scenario found for ${prEntry.scenarioId}`);
      continue;
    }

    console.log(`Evaluating scenario: ${scenario.id} (PR #${prEntry.prNumber})`);

    const [changedFiles, toolComments] = await Promise.all([
      fetchChangedFiles(octokit, owner, repo, prEntry.prNumber),
      fetchPrComments(octokit, owner, repo, prEntry.prNumber, loginToTool),
    ]);

    const checksSummary = allChecksSummary[prEntry.prNumber] ?? {};

    const result = await evaluateScenario(
      anthropic,
      model,
      scenario,
      { prEntry, changedFiles, toolComments, checksSummary },
      tools
    );

    results.push(result);
    console.log(`Done: ${scenario.id}`);
  }

  const output = JSON.stringify(results);
  writeFileSync("/tmp/evaluation.json", output);
  console.log(`\nEvaluation results written to /tmp/evaluation.json`);

  if (process.env.GITHUB_OUTPUT) {
    const MAX_OUTPUT_BYTES = 900_000;
    const { appendFileSync } = await import("node:fs");
    const truncated =
      output.length > MAX_OUTPUT_BYTES ? output.slice(0, MAX_OUTPUT_BYTES) + "..." : output;
    appendFileSync(process.env.GITHUB_OUTPUT, `evaluation-json=${truncated}\n`);
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
