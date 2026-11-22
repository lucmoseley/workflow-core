// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { fakeTreeClassifier } from "./git-tree-fake.js";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";

type Decision = { deny: string } | null;

const { decide } = require("./hook-escape.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string) => string;
};

const FRAMING = "This command sets a git-hook escape";

interface Over {
	ruleText?: (id: string) => string;
	corePaths?: (text: string) => string;
}

const ctxFor = (over: Over = {}) =>
	kitContextFake({
		isDir: () => true,
		treeClass: fakeTreeClassifier({ "/repo": "shared" }),
		...over,
	});

const denial = (command: string, over?: Over): string | null => {
	const d = decide(command, ctxFor(over));
	return d === null ? null : d.deny;
};

describe("an agent setting a git-hook escape is refused (#916)", () => {
	it.each([
		"WFC_ALLOW_GATE_INPUT_DELETE=1 git commit -m x -- a",
		"WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"WFC_ALLOW_GATE_INPUT_DELETE=1 node scripts/commit-paths.js -m x -- a",
		'WFC_ALLOW_BRANCH="1" git commit -m x -- a',
		"FOO=bar WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"WFC_ALLOW_BRANCH+=1 git commit -m x -- a",
		"env WFC_ALLOW_GATE_INPUT_DELETE=1 git commit -m x -- a",
		"env -i PATH=/usr/bin WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"sudo WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"export WFC_ALLOW_BRANCH=1",
		"export WFC_ALLOW_GATE_INPUT_DELETE",
		"export FOO=1 WFC_ALLOW_GATE_INPUT_DELETE=1 && git commit -m x -- a",
		"WFC_ALLOW_BRANCH=1; export WFC_ALLOW_BRANCH; git commit -m x -- a",
		"declare -x WFC_ALLOW_BRANCH=1",
		"typeset -rx WFC_ALLOW_GATE_INPUT_DELETE=1",
		"git status && WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"cd /tmp && env WFC_ALLOW_GATE_INPUT_DELETE=yes git commit -m x -- a",
		"{ WFC_ALLOW_BRANCH=1 git commit -m x -- a; }",
		"git status && { WFC_ALLOW_BRANCH=1 git commit -m x -- a; }",
		"if true; then WFC_ALLOW_BRANCH=1 git commit -m x -- a; fi",
		"for f in a; do WFC_ALLOW_BRANCH=1 git commit -m x -- $f; done",
		"! WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"exec env WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"if WFC_ALLOW_BRANCH=1 git commit -m x -- a; then :; fi",
		"while WFC_ALLOW_BRANCH=1 git commit -m x -- a; do :; done",
		"time WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"WFC_ALLOW_BRANCH=1 exec git commit -m x -- a",
		"exec WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"echo 'a\nb'; WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"nohup WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"/usr/bin/env WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"sudo env WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"env WFC_ALLOW_BRANCH=1",
		"sudo export WFC_ALLOW_BRANCH=1",
		"/bin/export WFC_ALLOW_BRANCH=1",
		"export -nx WFC_ALLOW_BRANCH",
		"export -xn WFC_ALLOW_BRANCH",
		"export -n -x WFC_ALLOW_BRANCH",
		"declare -r -x WFC_ALLOW_BRANCH=1",
		"export WFC_ALLOW_BRANCH+=1",
		"WFC_ALLOW_BRANCH= git commit -m x -- a",
		"echo 'q' && WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"echo 'a\\'; WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"echo \\'; WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		'echo "it\'s"; WFC_ALLOW_BRANCH=1 git commit -m x -- a',
		'echo "a \\"it\'s"; WFC_ALLOW_BRANCH=1 git commit -m x -- a',
	])("%s", (command) => {
		const reason = denial(command);
		expect(reason).not.toBeNull();
		expect(reason).toContain(readRuleText("hook-escape"));
		expect(reason).toContain(FRAMING);
	});
});

describe("what it does not judge", () => {
	it.each([
		"grep -n WFC_ALLOW_BRANCH scripts/",
		"grep -rn 'WFC_ALLOW_BRANCH=1' .husky",
		'echo "WFC_ALLOW_GATE_INPUT_DELETE=1 git commit"',
		"git log -S WFC_ALLOW_GATE_INPUT_DELETE",
		"gh issue comment 1 --body 'Run this:\nWFC_ALLOW_BRANCH=1 git commit -m x -- a'",
		"echo 'x <<EOF\nWFC_ALLOW_BRANCH=1 git commit -m y\nEOF' > a.txt",
		"cat > a.txt <<'EOF'\nWFC_ALLOW_BRANCH=1 git commit -m y\nEOF",
		'gh issue comment 1 --body "Run this:\nWFC_ALLOW_BRANCH=1 git commit -m x -- a"',
		"echo 'x\nWFC_ALLOW_BRANCH=1 git commit -m x -- a",
		'echo "x\nWFC_ALLOW_BRANCH=1 git commit -m x -- a',
		"WFC_ALLOW_BRANCHES=1 git commit -m x -- a",
		"WFC_ALLOW_NEW_PACKAGE=1 npm install left-pad",
		"env -u WFC_ALLOW_BRANCH git commit -m x -- a",
		"env -u WFC_ALLOW_BRANCH",
		"unset WFC_ALLOW_BRANCH",
		"export -n WFC_ALLOW_BRANCH",
		"declare -r WFC_ALLOW_BRANCH=1",
		"git commit -m x -- a",
		"{ git commit -m x -- a; }",
		"time git commit -m x -- a",
		"exec git commit -m x -- a",
		"exec -a WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"git commit -m x -- WFC_ALLOW_BRANCH=1",
		"echo hi WFC_ALLOW_BRANCH=1",
		"FOO=1 echo WFC_ALLOW_BRANCH=1",
		"env FOO=1 echo WFC_ALLOW_BRANCH=1",
		"XWFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"export XWFC_ALLOW_BRANCH=1",
		"export WFC_ALLOW_BRANCHX=1",
		"export WFC_ALLOW_BRANCH_X",
		"XWFC_ALLOW_BRANCH=1 git commit; echo WFC_ALLOW_BRANCH",
		"WFC_ALLOW_BRANCHES=1 git commit; echo WFC_ALLOW_BRANCH",
		"export WFC_ALLOW_BRANCHES WFC_ALLOW_BRANCH_X; echo WFC_ALLOW_BRANCH",
		"FOO=WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"export FOO=WFC_ALLOW_BRANCH",
		"export -x -n WFC_ALLOW_BRANCH",
		"declare -n WFC_ALLOW_BRANCH",
		"declare WFC_ALLOW_BRANCH=1",
		"readonly WFC_ALLOW_BRANCH=1",
		"echo \\WFC_ALLOW_BRANCH=1",
		'echo "a \\" WFC_ALLOW_BRANCH=1 git"',
		"echo $WFC_ALLOW_BRANCH",
		"export",
		"sudo",
	])("%s", (command) => {
		expect(denial(command)).toBeNull();
	});
});

describe("the refusal's text", () => {
	it("names the segment that set the escape, its quoted spans rendered, after the framing", () => {
		expect(
			denial('git status && WFC_ALLOW_BRANCH="1" git commit -m x -- a'),
		).toBe(
			`${FRAMING}: WFC_ALLOW_BRANCH="…" git commit -m x -- a\n\n${readRuleText("hook-escape")}`,
		);
	});

	it("names the first of two refused segments", () => {
		expect(
			denial("export WFC_ALLOW_BRANCH=1; WFC_ALLOW_GATE_INPUT_DELETE=1 git x"),
		).toMatch(new RegExp(`^${FRAMING}: export WFC_ALLOW_BRANCH=1\n\n`));
	});

	it("still refuses where the rule cannot be read, naming the fragment's file", () => {
		const reason = denial("export WFC_ALLOW_BRANCH=1", {
			ruleText: () => {
				throw new Error("store fault");
			},
		});
		expect(reason).toBe(
			`${FRAMING}: export WFC_ALLOW_BRANCH=1\n\nA git-hook WFC_ALLOW_* escape is the founder's to set, never an agent's (#916); the rule could not be read from docs/agents/rules/hook-escape.txt. Restore that file from origin/main, or revert the change that removed it, then read it before doing anything else.`,
		);
	});

	it("asks the rule store for the hook-escape fragment by its id", () => {
		const asked: string[] = [];
		denial("export WFC_ALLOW_BRANCH=1", {
			ruleText: (id) => {
				asked.push(id);
				return "R";
			},
		});
		expect(asked).toEqual(["hook-escape"]);
	});

	it("spells the refusal's paths through the corePaths port, the command spliced after", () => {
		const reason = denial("WFC_ALLOW_BRANCH=1 node scripts/x.js", {
			corePaths: (t) => t.replaceAll("scripts/", "/plugin/scripts/"),
			ruleText: () => "see scripts/x.sh",
		});
		expect(reason).toBe(
			`${FRAMING}: WFC_ALLOW_BRANCH=1 node scripts/x.js\n\nsee /plugin/scripts/x.sh`,
		);
	});
});

describe("from a linked worktree, its rule is read from the main checkout's store (#4242)", () => {
	let at: { main: string; worktree: string };
	freshSandbox((sb) => {
		at = splitCheckout(path.join(sb.dir, "split"));
	});
	const plantRule = (tree: string, id: string, text: string) => {
		vi.stubEnv("WFC_RULES_DIR", "");
		const rules = path.join(tree, "docs", "agents", "rules");
		fs.mkdirSync(rules, { recursive: true });
		fs.writeFileSync(path.join(rules, `${id}.txt`), `${text}\n`);
	};
	const fromWorktree = (command: string) =>
		runCore("guard-hook-escape", toolCall("Bash", { command }), {
			root: at.main,
			worktree: at.worktree,
		}).output;

	it("refuses with the main checkout's hook-escape fragment, not the worktree's", () => {
		plantRule(at.main, "hook-escape", "HOST ESCAPE RULE");
		plantRule(at.worktree, "hook-escape", "WORKTREE ESCAPE RULE");
		const reason = String(
			fromWorktree("WFC_ALLOW_BRANCH=1 git commit -m x -- a")
				?.permissionDecisionReason,
		);
		expect(reason).toContain("HOST ESCAPE RULE");
		expect(reason).not.toContain("WORKTREE ESCAPE RULE");
	});
});
