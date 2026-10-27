// @vitest-environment node
/*
 * lib/anthropic-report.js, the guard-anthropic-report core (#2798), in
 * process: it refuses every `gh issue`, `gh pr` and writing `gh api` call it
 * can tie to an `anthropics/*` repo (#1987; the ruling, #1967).
 *
 * Do not thin the refusal or allow cases.
 *
 * The clone's remotes are read by the host's own port, real git over a temp
 * clone; the entry's own cases — the JSON it prints, the hook line, the
 * failure policy — are guard-anthropic-report.test.ts's.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";
import { readRuleText } from "./rule-text";

type Decision = { deny: string } | null;
const { decide } = require("./anthropic-report.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { buildHostPorts } = require("./anthropic-report-host.js") as {
	buildHostPorts: () => { remotes: (cwd: string) => string };
};
const { resolveScriptPaths } = require("./script-path.js") as {
	resolveScriptPaths: (text: string) => string;
};

const RULE = readRuleText("anthropic-report");

let dir: string;
let shared: string;
let faults: string[];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-report-"));
	shared = path.join(dir, "shared");
	fs.mkdirSync(shared);
	faults = [];
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

// A GH_REPO the runner happens to carry would decide every unnamed case.
const { GH_REPO: _, ...ENV } = process.env;

const run = (
	command: string,
	cwd = shared,
	vars: Record<string, string> = {},
	ruleText: (id: string) => string = readRuleText,
) =>
	decide(
		command,
		kitContextFake({
			cwd,
			fallbackCwd: cwd,
			vars: { ...ENV, ...vars },
			isDir: (p: string) =>
				fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
			log: (what: string) => faults.push(what),
			ruleText,
			corePaths: resolveScriptPaths,
			remotes: buildHostPorts().remotes,
		}),
	);

const verdict = (
	command: string,
	cwd = shared,
	vars: Record<string, string> = {},
) => (run(command, cwd, vars) ? "deny" : "allow");

/** The refusal's text, asserting it was a refusal. */
const readDenyReason = (command: string, cwd = shared) => {
	const d = run(command, cwd);
	if (!d) throw new Error(`expected a deny for: ${command}`);
	return d.deny;
};

/** A real clone with one remote. */
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
		const reason = readDenyReason(call);
		expect(reason).toContain("This writes to an Anthropic repo");
		expect(reason).toContain(RULE);
		expect(faults).toEqual([]);
	});

	it("names the repo it read, and the command as a human reads it", () => {
		expect(
			readDenyReason(
				'gh pr create -R anthropics/claude-code --title "x" --body "y"',
			),
		).toBe(
			`This writes to an Anthropic repo (anthropics/claude-code): gh pr create -R anthropics/claude-code --title "…" --body "…"\n\n${RULE}`,
		);
	});

	it("names the repo a URL or a GraphQL call spells, lowercased", () => {
		expect(
			readDenyReason(
				'gh issue comment https://github.com/Anthropics/Claude-Code/issues/12 --body "x"',
			),
		).toContain("(anthropics/claude-code)");
		expect(
			readDenyReason(
				'gh api graphql -f query="mutation { addComment(input:{subjectId:$id}) { clientMutationId } }" -f repo=Anthropics/Claude-Code',
			),
		).toContain("(anthropics/claude-code)");
	});

	it("still refuses, naming the fragment, where the rule store cannot give it", () => {
		const d = run(
			"gh issue comment 5 --repo anthropics/claude-code",
			shared,
			{},
			() => {
				throw new Error("no store");
			},
		);
		expect(d?.deny).toContain(
			"the rule could not be read from docs/agents/rules/anthropic-report.txt",
		);
	});

	it("refuses an unknown issue subcommand, a verb gh may add later", () => {
		expect(verdict("gh issue frobnicate 5 --repo anthropics/claude-code")).toBe(
			"deny",
		);
	});

	it("refuses a gh api call whose method it cannot read", () => {
		expect(
			verdict('gh api -X "$M" repos/anthropics/claude-code/issues/5'),
		).toBe("deny");
	});

	it("refuses a GH_REPO carried in the environment", () => {
		expect(
			verdict('gh issue create --title "x" --body "y"', shared, {
				GH_REPO: "anthropics/claude-code",
			}),
		).toBe("deny");
	});

	it("refuses on the first segment that writes, past a read", () => {
		expect(
			verdict(
				"gh issue view 5 --repo anthropics/claude-code && gh issue comment 5 --repo anthropics/claude-code",
			),
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
		expect(readDenyReason('gh pr create --title "x" --body "y"', at)).toContain(
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
		expect(faults).toEqual([]);
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
		// The groups that write nothing a report travels by.
		"gh release create v1 --repo anthropics/claude-code",
	])("lets it through: %s", (call) => {
		expect(verdict(call)).toBe("allow");
		expect(faults).toEqual([]);
	});
});

describe("a repo it cannot read", () => {
	it("fails open, recorded, on an exported GH_REPO it cannot resolve", () => {
		expect(
			verdict('export GH_REPO="$X" && gh issue create --title "x" --body "y"'),
		).toBe("allow");
		expect(faults).toEqual([
			"could not read GH_REPO on a gh write — allowed unchecked for an Anthropic repo",
		]);
	});

	it("fails open, recorded, on a GH_REPO it carries but cannot read", () => {
		expect(
			verdict('GH_REPO="$(pick)" gh issue create --title "x" --body "y"'),
		).toBe("allow");
		expect(faults).toEqual([
			"could not read GH_REPO on a gh write — allowed unchecked for an Anthropic repo",
		]);
	});

	it("fails open, recorded, on a GraphQL query read from a file", () => {
		expect(
			verdict(
				"gh api graphql -F repo=anthropics/claude-code -f query=@q.graphql",
			),
		).toBe("allow");
		expect(faults).toEqual([
			"a gh api graphql call naming anthropics carries a query the guard cannot read — allowed unchecked",
		]);
	});

	it("fails open, recorded, on an unresolvable --repo", () => {
		expect(verdict('gh issue create --repo "$R" --title "x" --body "y"')).toBe(
			"allow",
		);
		expect(faults).toEqual([
			"could not read the --repo of a gh issue create — allowed unchecked for an Anthropic repo",
		]);
	});

	it("fails open, recorded, on a gh api endpoint it cannot read", () => {
		expect(verdict('gh api -X POST "$EP" -f body=x')).toBe("allow");
		expect(faults).toEqual([
			"could not read a gh api endpoint — allowed unchecked for an Anthropic repo",
		]);
	});

	it("fails open, recorded, where it cannot tell which directory the write runs in, and judges the clone where it can", () => {
		// The bash guard refused this with an empty repo, its fail-open caught
		// in a subshell; the Node port fails open as documented (#2798).
		expect(
			verdict(`cd "$(mktemp -d)" && gh issue create --title "x" --body "y"`),
		).toBe("allow");
		expect(faults).toEqual([
			"could not tell which directory a gh write runs in — its clone's remotes unchecked for an Anthropic repo",
		]);
		const at = clone("https://github.com/anthropics/claude-code.git");
		expect(
			verdict(`cd "${at}" && gh issue create --title "x" --body "y"`),
		).toBe("deny");
	});
});
