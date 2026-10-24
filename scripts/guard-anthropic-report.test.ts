// @vitest-environment node
/*
 * guard-anthropic-report.sh refuses every `gh issue`, `gh pr` and writing
 * `gh api` call it can tie to an `anthropics/*` repo (#1987; the ruling, #1967).
 *
 * Do not thin the refusal or allow cases.
 *
 * Over the 10 s run-cost budget (base §X8 (5)) because 40 of its cases are the
 * two shared fixtures' load and fail-open contracts, each spawning a detached
 * copy of the guard.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog, failOpenLogPath } from "./guard-log-fixture";
import { describeSharedParserLibrary } from "./guard-parse-fixture";
import { ruleText } from "./lib/rule-text";

const GUARD = path.resolve(__dirname, "guard-anthropic-report.sh");
const RULE = ruleText("anthropic-report");

let dir: string;
let config: string;
let shared: string;
let elsewhere: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-anthropic-report-"));
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	elsewhere = path.join(dir, "elsewhere");
	fs.mkdirSync(shared);
	fs.mkdirSync(elsewhere);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const run = (
	command: string,
	cwd = shared,
	extra: Record<string, string> = {},
) => {
	// A GH_REPO the runner happens to carry would decide every unnamed case.
	const { GH_REPO: _, ...env } = process.env;
	const r = spawnSync(GUARD, [], {
		cwd,
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "test",
			tool_name: "Bash",
			tool_input: { command },
			cwd,
		}),
		env: {
			...env,
			CLAUDE_PROJECT_DIR: shared,
			CLAUDE_CONFIG_DIR: config,
			...extra,
		},
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	return r;
};

const verdict = (
	command: string,
	cwd = shared,
	extra: Record<string, string> = {},
) => {
	const r = run(command, cwd, extra);
	// A crashing guard emits no verdict either, so "allow" must mean silence by
	// design rather than by accident (mantahostels#123).
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = r.stdout ?? "";
	if (/"permissionDecision"\s*:\s*"deny"/.test(out)) return "deny";
	expect(out).toBe("");
	return "allow";
};

/** The refusal's text, asserting it was a refusal. */
const denyReason = (command: string, cwd = shared) => {
	const r = run(command, cwd);
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	expect(out.permissionDecision).toBe("deny");
	return out.permissionDecisionReason as string;
};

const faults = () => {
	const at = failOpenLogPath(config, shared);
	if (!fs.existsSync(at)) return [];
	return fs
		.readFileSync(at, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t")[2]);
};

/** A clone with one remote. */
const clone = (url: string) => {
	const at = path.join(dir, "clone");
	fs.mkdirSync(at);
	spawnSync("git", ["init", "-q", at]);
	spawnSync("git", ["-C", at, "remote", "add", "upstream", url]);
	return at;
};

describe("a write it refuses", () => {
	it.each([
		'gh issue create --repo anthropics/claude-code --title "A bug" --body "x"',
		'gh issue create --repo anthropics/claude-code --title "A bug" --body "x" --label takes:triage',
		'gh api repos/anthropics/claude-code/issues -f title="A bug" -f "labels[]=takes:triage"',
		'gh issue create -R github.com/anthropics/claude-code --title "A bug" --body "x"',
		'gh issue create --repo https://github.com/Anthropics/claude-code/ --title "A bug" --body "x"',
		'gh issue create --repo git@github.com:anthropics/claude-code.git --title "A bug" --body "x"',
		'gh api repos/anthropics/claude-code/issues -f title="A bug" -F body=@report.md',
		'gh api --method POST /repos/anthropics/claude-code/issues -f title="A bug" -f body=x',
		'gh issue comment 5 --repo anthropics/claude-code --body "x"',
		'gh issue comment https://github.com/anthropics/claude-code/issues/12 --body "x"',
		'gh pr create -R anthropics/claude-code --title "x" --body "y"',
		'gh pr create -Ranthropics/claude-code --title "x" --body "y"',
		'gh pr comment https://github.com/anthropics/claude-code/pull/7 -b "x"',
		"gh issue edit 5 --repo=anthropics/claude-code --add-label bug",
		'gh api repos/anthropics/claude-code/issues/5/comments -f body="x"',
		'gh api -X PATCH repos/anthropics/claude-code/issues/5 -f body="x"',
		"gh api https://api.github.com/repos/anthropics/claude-code/issues/5/comments -f body=x",
		'gh api graphql -f query="mutation { addComment(input:{subjectId:$id, body:\\"y\\"}) { clientMutationId } }" -f id=X -f repo=anthropics/claude-code',
		'gh api graphql -f query="mutation { createDiscussion(input:{repositoryId:\\"R\\"}) { clientMutationId } }" -f owner=anthropics',
		'timeout 30 gh issue comment 3 --repo anthropics/claude-code --body "y"',
		'GH_REPO=anthropics/claude-code gh issue create --title "x" --body "y"',
		'env GH_REPO=anthropics/claude-code gh issue create --title "x" --body "y"',
		'GH_REPO=anthropics/claude-code gh api repos/{owner}/{repo}/issues -f title="x"',
		'export GH_REPO=anthropics/claude-code && gh issue create --title "x" --body "y"',
	])("refuses it, printing the rule: %s", (call) => {
		const reason = denyReason(call);
		expect(reason).toContain("This writes to an Anthropic repo");
		expect(reason).toContain(RULE);
	});

	it("names the repo it read in the refusal", () => {
		expect(
			denyReason(
				'gh pr create -R anthropics/claude-code --title "x" --body "y"',
			),
		).toContain("(anthropics/claude-code)");
	});

	it("refuses an unknown issue subcommand, a verb gh may add later", () => {
		expect(verdict("gh issue frobnicate 5 --repo anthropics/claude-code")).toBe(
			"deny",
		);
	});

	it("refuses a GH_REPO carried in the environment", () => {
		expect(
			verdict('gh issue create --title "x" --body "y"', shared, {
				GH_REPO: "anthropics/claude-code",
			}),
		).toBe("deny");
	});
});

describe("a write naming no repo, run inside a clone", () => {
	it("refuses it where any remote is an Anthropic repo", () => {
		const at = clone("https://github.com/anthropics/claude-code.git");
		expect(verdict('gh issue create --title "x" --body "y"', at)).toBe("deny");
		expect(verdict('gh api repos/{owner}/{repo}/issues -f title="x"', at)).toBe(
			"deny",
		);
		expect(denyReason('gh pr create --title "x" --body "y"', at)).toContain(
			"(anthropics/claude-code)",
		);
	});

	it("follows a cd into the clone", () => {
		const at = clone("git@github.com:anthropics/claude-code.git");
		expect(verdict(`cd ${at} && gh issue comment 5 --body "x"`)).toBe("deny");
	});

	it("lets a named repo override the clone, as gh does", () => {
		const at = clone("https://github.com/anthropics/claude-code.git");
		expect(
			verdict('gh issue create --repo someone/tool --title "x" --body "y"', at),
		).toBe("allow");
		expect(
			verdict(
				'GH_REPO=someone/tool gh issue create --title "x" --body "y"',
				at,
			),
		).toBe("allow");
	});

	it("allows it in a clone of any other repo", () => {
		const at = clone("https://github.com/someone/tool.git");
		expect(verdict('gh issue create --title "x" --body "y"', at)).toBe("allow");
	});
});

describe("what it lets through", () => {
	it.each([
		"gh issue view 5 --repo anthropics/claude-code",
		"gh issue list -R anthropics/claude-code --search compaction",
		"gh pr view https://github.com/anthropics/claude-code/pull/7",
		"gh pr diff 7 --repo anthropics/claude-code",
		"gh api repos/anthropics/claude-code/issues/5",
		"gh api --method GET repos/anthropics/claude-code/issues -f state=closed",
		'gh api graphql -f query="query { repository(owner:\\"anthropics\\", name:\\"claude-code\\") { id } }"',
		'gh issue create --repo someone/tool --title "x" --body "y"',
		'gh issue create --repo anthropics-fan/tool --title "x" --body "y"',
		'gh issue create --repo ghe.example.com/anthropics/tool --title "x" --body "y"',
		'gh api repos/someone/tool/issues -f title="x"',
		// A body citing an upstream issue is no target.
		'gh issue comment 5 --body "https://github.com/anthropics/claude-code/issues/12"',
		'gh issue comment 5 --body "see https://github.com/anthropics/claude-code/issues/12"',
		// A GraphQL mutation that never spells the owner: the node-id residual.
		'gh api graphql -f query="mutation { addComment(input:{subjectId:\\"X\\", body:\\"y\\"}) { clientMutationId } }"',
		'echo "gh issue create --repo anthropics/claude-code"',
		"gh issue create --repo anthropics/claude-code --help",
	])("lets it through: %s", (call) => {
		expect(verdict(call)).toBe("allow");
	});
});

describe("a repo it cannot read", () => {
	it("fails open, recorded, on an exported GH_REPO it cannot resolve", () => {
		expect(
			verdict('export GH_REPO="$X" && gh issue create --title "x" --body "y"'),
		).toBe("allow");
		expect(faults()).toEqual([
			"could not read GH_REPO on a gh write — allowed unchecked for an Anthropic repo",
		]);
	});

	it("fails open, recorded, on a GraphQL query read from a file", () => {
		expect(
			verdict(
				"gh api graphql -F repo=anthropics/claude-code -f query=@q.graphql",
			),
		).toBe("allow");
		expect(faults()).toEqual([
			"a gh api graphql call naming anthropics carries a query the guard cannot read — allowed unchecked",
		]);
	});

	it("fails open, recorded, on an unresolvable --repo", () => {
		expect(verdict('gh issue create --repo "$R" --title "x" --body "y"')).toBe(
			"allow",
		);
		expect(faults()).toEqual([
			"could not read the --repo of a gh issue create — allowed unchecked for an Anthropic repo",
		]);
	});
});

describeFailOpenLog({
	guard: GUARD,
	denied: {
		tool_name: "Bash",
		tool_input: { command: "gh issue comment 5 --repo anthropics/claude-code" },
	},
	fieldless: { tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: { tool_name: "Bash", tool_input: { command: "git status" } },
	ctx: () => ({ dir, config, project: shared }),
});

describeSharedParserLibrary({
	guard: GUARD,
	denyCommand: "gh issue comment 5 --repo anthropics/claude-code",
	ctx: () => ({
		dir,
		shared,
		elsewhere,
		env: { CLAUDE_CONFIG_DIR: config },
	}),
});
