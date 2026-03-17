import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  botLogin: string;
  checkName: string;
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
      body: c.body.slice(0, 1000),
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
      body: c.body?.slice(0, 1000) ?? "",
      createdAt: c.created_at,
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
  tools: Tool[],
  isCleanPr: boolean
): string {
  const expectedCount =
    scenario.expectedIssues.security +
    scenario.expectedIssues.bugs +
    scenario.expectedIssues.smells;

  const toolReviewsSection = tools
    .map((tool) => {
      const check = checksSummary[tool.checkName] ?? {
        conclusion: "not_found",
        detailsUrl: null,
      };
      const comments = toolComments.filter((c) => c.tool === tool.name);
      const inlineComments = comments.filter((c) => c.path);
      const summaryComments = comments.filter((c) => !c.path);

      const inlineSection =
        inlineComments.length > 0
          ? inlineComments
              .map((c) => `  [${c.path}:${c.line ?? "?"}] ${c.body}`)
              .join("\n")
          : "  (no inline comments)";

      const summarySection =
        summaryComments.length > 0
          ? summaryComments.map((c) => `  ${c.body}`).join("\n")
          : "  (no summary comment)";

      return `=== ${tool.name} ===
Check conclusion: ${check.conclusion}

Inline review comments:
${inlineSection}

Summary/PR-level comments:
${summarySection}`;
    })
    .join("\n\n");

  const cleanPrNote = isCleanPr
    ? `\nIMPORTANT: This is a clean PR with NO intentional issues introduced. Any issue flagged by a tool is a FALSE POSITIVE. Set issuesFound=0 for tools that correctly post nothing. For tools that do post comments, count each comment as a false positive.`
    : "";

  const toolNames = tools.map((t) => t.name).join('", "');

  return `<scenario-context>
Scenario ID: ${scenario.id}
Category: ${scenario.category}
Project: ${scenario.project}
PR Title: "${scenario.prTitle}"
PR Description: "${scenario.prBody}"
Expected issues introduced: ${expectedCount} total (${scenario.expectedIssues.security} security, ${scenario.expectedIssues.bugs} bugs, ${scenario.expectedIssues.smells} code smells)${cleanPrNote}
</scenario-context>

<changed-files>
${changedFiles.join("\n")}
</changed-files>

<tool-reviews>
${toolReviewsSection}
</tool-reviews>

<instructions>
You are evaluating AI code review tools on their ability to find intentional issues in a pull request.

For each tool ("${toolNames}"), determine:
1. issuesFound (integer): How many distinct issues did this tool identify in its comments? Count each unique problem flagged, not each comment. If the tool timed out or has no comments, use 0.
2. falsePositives (integer): How many comments appear to flag things that are not real issues in this diff?
3. commentQuality (1-5): Overall quality of the tool's comments — are they accurate, actionable, well-explained? Use 1 if no comments posted.
4. notableFinding (string or null): Any interesting or surprising behavior from this tool (e.g., "Caught cross-module impact", "Missed obvious SQL injection", "Only tool to flag the hardcoded secret"). Null if nothing notable.

Respond with ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "scenarioId": "${scenario.id}",
  "prNumber": 0,
  "expectedIssueCount": ${expectedCount},
  "perTool": {
    ${tools.map((t) => `"${t.name}": { "issuesFound": 0, "falsePositives": 0, "commentQuality": 1, "notableFinding": null }`).join(",\n    ")}
  }
}
</instructions>`;
}

async function evaluateScenario(
  anthropic: Anthropic,
  model: string,
  scenario: Scenario,
  prEntry: PrEntry,
  changedFiles: string[],
  toolComments: ToolComment[],
  checksSummary: Record<string, CheckResult>,
  tools: Tool[]
): Promise<EvaluationResult> {
  const isCleanPr = scenario.category === "clean";
  const prompt = buildPrompt(
    scenario,
    changedFiles,
    toolComments,
    checksSummary,
    tools,
    isCleanPr
  );

  const message = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";

  let result: EvaluationResult;
  try {
    result = JSON.parse(text);
    result.prNumber = prEntry.prNumber;
  } catch {
    console.error(`Failed to parse Claude response for ${scenario.id}:`, text);
    result = {
      scenarioId: scenario.id,
      prNumber: prEntry.prNumber,
      expectedIssueCount:
        scenario.expectedIssues.security +
        scenario.expectedIssues.bugs +
        scenario.expectedIssues.smells,
      perTool: Object.fromEntries(
        tools.map((t) => [
          t.name,
          {
            issuesFound: 0,
            falsePositives: 0,
            commentQuality: 1,
            notableFinding: "Evaluation failed: could not parse Claude response",
          },
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
  const allChecksSummary: Record<
    string,
    Record<string, CheckResult>
  > = JSON.parse(checksSummaryRaw);

  const scenariosPath = resolve(__dirname, "../scenarios.json");
  const toolsPath = resolve(__dirname, "../tools.json");
  const scenarios: Scenario[] = JSON.parse(readFileSync(scenariosPath, "utf-8"));
  const { tools }: { tools: Tool[] } = JSON.parse(readFileSync(toolsPath, "utf-8"));

  const loginToTool = new Map<string, string>();
  for (const tool of tools) {
    loginToTool.set(tool.botLogin, tool.name);
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
      prEntry,
      changedFiles,
      toolComments,
      checksSummary,
      tools
    );

    results.push(result);
    console.log(`Done: ${scenario.id}`);
  }

  const output = JSON.stringify(results);
  writeFileSync("/tmp/evaluation.json", output);
  console.log(`\nEvaluation results written to /tmp/evaluation.json`);

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("fs");
    const truncated =
      output.length > 900_000 ? output.slice(0, 900_000) + "..." : output;
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `evaluation-json=${truncated}\n`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
