// @vitest-environment node
/*
 * lib/hook-escape.js, the guard-hook-escape core (#2801), in process: which
 * commands set one of the two git-hook escapes (#916) and are refused, and
 * which only mention one and pass.
 *
 * The walk's ports are values; the rule store is the real one, read in
 * process, so the deny is checked against the fragment it splices rather
 * than a second copy of its text. The production adapters are crossed in
 * guard-hook-escape.test.ts.
 */

import { describe, expect, it } from "vitest";
import { fakeTreeClassifier } from "./git-tree-fake.js";
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
		// Behind a reserved word or an `exec`, which the walker skips (#1013).
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
		// A multi-line quoted span before the assignment does not hide it.
		"echo 'a\nb'; WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		// The other launchers unwrap strips, and the ones it reads by basename.
		"nohup WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"/usr/bin/env WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"sudo env WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		// An `env` whose words run out before any command still carried one.
		"env WFC_ALLOW_BRANCH=1",
		// Exported by a launcher-run or path-spelt `export`.
		"sudo export WFC_ALLOW_BRANCH=1",
		"/bin/export WFC_ALLOW_BRANCH=1",
		// A flag word is read `n` first, then `x`, so either order in one word
		// re-exports; so does a later `-x` word, and `-x` after `-r`.
		"export -nx WFC_ALLOW_BRANCH",
		"export -xn WFC_ALLOW_BRANCH",
		"export -n -x WFC_ALLOW_BRANCH",
		"declare -r -x WFC_ALLOW_BRANCH=1",
		"export WFC_ALLOW_BRANCH+=1",
		// An empty value is an assignment all the same.
		"WFC_ALLOW_BRANCH= git commit -m x -- a",
		// An escape-only quoted value still names the escape outside quotes.
		"echo 'q' && WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		// A backslash is literal inside single quotes, and outside them it
		// escapes a quote rather than opening one.
		"echo 'a\\'; WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"echo \\'; WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		// A quote of the other kind inside a span opens nothing, `\"` included.
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
		// The founder's command written into a multi-line hand-over.
		"gh issue comment 1 --body 'Run this:\nWFC_ALLOW_BRANCH=1 git commit -m x -- a'",
		"echo 'x <<EOF\nWFC_ALLOW_BRANCH=1 git commit -m y\nEOF' > a.txt",
		"cat > a.txt <<'EOF'\nWFC_ALLOW_BRANCH=1 git commit -m y\nEOF",
		'gh issue comment 1 --body "Run this:\nWFC_ALLOW_BRANCH=1 git commit -m x -- a"',
		// A quote left open blanks the rest of the subject, over every line.
		"echo 'x\nWFC_ALLOW_BRANCH=1 git commit -m x -- a",
		'echo "x\nWFC_ALLOW_BRANCH=1 git commit -m x -- a',
		// A neighbouring name, and the escape out of this guard's scope.
		"WFC_ALLOW_BRANCHES=1 git commit -m x -- a",
		"WFC_ALLOW_NEW_PACKAGE=1 npm install left-pad",
		// Unsetting, and declaring without exporting.
		"env -u WFC_ALLOW_BRANCH git commit -m x -- a",
		"env -u WFC_ALLOW_BRANCH",
		"unset WFC_ALLOW_BRANCH",
		"export -n WFC_ALLOW_BRANCH",
		"declare -r WFC_ALLOW_BRANCH=1",
		"git commit -m x -- a",
		// Behind a reserved word or an `exec`, with no escape set (#1013).
		"{ git commit -m x -- a; }",
		"time git commit -m x -- a",
		"exec git commit -m x -- a",
		// `-a` names the command's argv[0]; it assigns no variable.
		"exec -a WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		// An escape-shaped argument after the command word is a flag value.
		"git commit -m x -- WFC_ALLOW_BRANCH=1",
		"echo hi WFC_ALLOW_BRANCH=1",
		// An assignment ends the leading run: what follows is the command.
		"FOO=1 echo WFC_ALLOW_BRANCH=1",
		"env FOO=1 echo WFC_ALLOW_BRANCH=1",
		// A name sharing the escape's tail or head is not the escape.
		"XWFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"export XWFC_ALLOW_BRANCH=1",
		"export WFC_ALLOW_BRANCHX=1",
		"export WFC_ALLOW_BRANCH_X",
		// The same, past the mention filter: the walk itself tells them apart.
		"XWFC_ALLOW_BRANCH=1 git commit; echo WFC_ALLOW_BRANCH",
		"WFC_ALLOW_BRANCHES=1 git commit; echo WFC_ALLOW_BRANCH",
		"export WFC_ALLOW_BRANCHES WFC_ALLOW_BRANCH_X; echo WFC_ALLOW_BRANCH",
		// An escape's name inside another's value assigns nothing.
		"FOO=WFC_ALLOW_BRANCH=1 git commit -m x -- a",
		"export FOO=WFC_ALLOW_BRANCH",
		// A later `-n` word takes the export away again.
		"export -x -n WFC_ALLOW_BRANCH",
		"declare -n WFC_ALLOW_BRANCH",
		"declare WFC_ALLOW_BRANCH=1",
		"readonly WFC_ALLOW_BRANCH=1",
		// A backslash outside quotes eats the character it escapes.
		"echo \\WFC_ALLOW_BRANCH=1",
		// A `\"` inside double quotes does not close them.
		'echo "a \\" WFC_ALLOW_BRANCH=1 git"',
		// A word that only reads `WFC_ALLOW_BRANCH`, spelt with no `=`.
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
			`${FRAMING}: export WFC_ALLOW_BRANCH=1\n\nA git-hook WFC_ALLOW_* escape is the founder's to set, never an agent's (#916); the rule could not be read from docs/agents/rules/hook-escape.txt. Read that file before doing anything else.`,
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
