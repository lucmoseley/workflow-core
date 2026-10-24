// @vitest-environment node
/*
 * guard-issue-create-label.sh denies a `gh issue create` that carries no
 * `--label takes:<value>`, and one whose value is outside the closed seven
 * (mantahostels#470, the build; mantahostels#453, the ruling).
 *
 * A deny is only defensible while it cannot wedge sanctioned work, so every
 * allow-case below is a shape that would otherwise be a false positive — a
 * create that already carries the label in one of gh's several spellings, a
 * command that merely mentions `gh issue create`, any other gh subcommand. Do
 * not thin them out.
 *
 * A `gh` shim serves the edit route's body fetch (mantahostels#3555) and the second-map
 * limb's map list (#717); every other create verdict is read off the command
 * alone, so no case reaches the network.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a deny case and an issue is filed that routes to
 * nobody; lose an allow case and a correctly labelled create is wedged.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import HUMAN_BODIES from "./fixtures/takes-human-bodies.json" with {
	type: "json",
};
import { describeFailOpenLog, failOpenLogPath } from "./guard-log-fixture";
import { describeSharedParserLibrary } from "./guard-parse-fixture";
import { UNFILLED_DESTINATION } from "./lib/issue-gate";
import { ruleText } from "./lib/rule-text";
import {
	CLOSE_WHEN_LINE,
	FOUNDER_ACTS,
	outsideLineFault,
} from "./lib/takes-label";

const GUARD = path.resolve(__dirname, "guard-issue-create-label.sh");

/* The line every passing takes:human body carries (#983). */
const CLOSE = "\n**Close when:** the founder confirms it is done";
const DELIVERABLE = ruleText("founder-deliverable");
/* The guard's own pointer line, read off its source so the two cannot drift;
 * the template's path follows it, resolved per install (#1248). */
const POINTER_LEAD = /^DELIVERABLE_POINTER_LEAD="(.*)"$/m.exec(
	fs.readFileSync(GUARD, "utf8"),
)?.[1];
const pointer = (cmd: string) => `${POINTER_LEAD} ${cmd} founder-deliverable`;
const POINTER = pointer("scripts/lib/rule-text.sh");
const handover = (out: string): string | undefined => {
	let parsed: { hookSpecificOutput?: { additionalContext?: string } } = {};
	try {
		parsed = JSON.parse(out);
	} catch {
		// Not JSON: the guard handed nothing over.
	}
	return parsed.hookSpecificOutput?.additionalContext;
};

let dir: string;
let config: string;
let shared: string;
let elsewhere: string;

/* The edit route (mantahostels#3555) fetches the issue body through `gh`, so a test
 * points WFC_GH at a shim — it answers `gh issue view <n> --json body --jq …` with
 * GH_SHIM_BODY_<n>, or GH_SHIM_BODY, and exits 1 under GH_SHIM_MODE=fail.
 * The second-map limb's `gh issue list` (#717) gets GH_SHIM_MAPS, its argv
 * logged to GH_SHIM_ARGS. */
let binDir: string;
const writeShim = () => {
	fs.mkdirSync(binDir, { recursive: true });
	const at = path.join(binDir, "gh");
	fs.writeFileSync(
		at,
		[
			"#!/bin/sh",
			'[ -n "$GH_SHIM_COUNT" ] && echo call >>"$GH_SHIM_COUNT"',
			'if [ "$GH_SHIM_MODE" = fail ]; then exit 1; fi',
			'if [ "$2" = list ]; then',
			'  [ -n "$GH_SHIM_ARGS" ] && echo "$* (in $(pwd))" >>"$GH_SHIM_ARGS"',
			'  printf "%s" "$GH_SHIM_MAPS"; exit 0',
			"fi",
			'n="$3"',
			'eval "b=\\$GH_SHIM_BODY_$n"',
			'[ -z "$b" ] && b="$GH_SHIM_BODY"',
			'printf "%s" "$b"',
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
};

const run = (
	command: string,
	cwd = shared,
	extra: Record<string, string> = {},
) =>
	spawnSync(GUARD, [], {
		cwd,
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "test",
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: shared,
			// Unset, a test run appends to the founder's own fail-open log and
			// manufactures the very records check-guard-errors.js exists to report.
			CLAUDE_CONFIG_DIR: config,
			...extra,
		},
	});

const verdict = (
	command: string,
	cwd = shared,
	extra: Record<string, string> = {},
) => {
	const r = run(command, cwd, extra);
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	// A crashing guard emits no verdict either, so "allow" must mean silence by
	// design rather than by accident (mantahostels#123).
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = r.stdout ?? "";
	if (/"permissionDecision"\s*:\s*"deny"/.test(out)) return "deny";
	// A takes:human that passes is let through carrying a pointer to the
	// founder-deliverable rule (#983) — an allow, where the pointer is all of it.
	if (POINTER_LEAD && handover(out) === POINTER) return "allow";
	// The third tier, added with the GraphQL route (mantahostels#519): the command is let
	// through, with prose attached. It is neither a deny nor the silence an
	// allow means, so a test asserting "allow" must not pass on one.
	if (/"additionalContext"/.test(out)) return "warn";
	expect(out).toBe("");
	return "allow";
};

/** The refusal `command` earns, as the session reads it. Throws on an allow. */
const denyReason = (command: string, extra: Record<string, string> = {}) => {
	const r = run(command, shared, extra);
	if (!r.stdout?.trim()) throw new Error(`expected a deny for: ${command}`);
	return JSON.parse(r.stdout).hookSpecificOutput
		.permissionDecisionReason as string;
};

/* The two framing lines this guard's refusals open with (mantahostels#2145). Both splice
 * the same rule fragment and the same seven values underneath, so only these
 * tell a missing-label refusal from a bad-value one. */
const MISSING = "This creates an issue with no `takes:` label";
const INVALID =
	"This creates an issue with a `takes:` label that does not exist";

/** The fail-open records this run left, parsed as check-guard-errors.js parses them. */
const faults = () => {
	const at = failOpenLogPath(config, shared);
	if (!fs.existsSync(at)) return [];
	return fs
		.readFileSync(at, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t")[2]);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-issue-create-label-"));
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	elsewhere = path.join(dir, "elsewhere");
	binDir = path.join(dir, "bin");
	fs.mkdirSync(shared);
	fs.mkdirSync(elsewhere);
});

describe("the creates it denies", () => {
	it("denies a create carrying no labels at all", () => {
		const call = 'gh issue create --title "A thing" --body "some prose"';
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(MISSING);
	});

	it("points the refused create at file-issue.js, which files, labels and places in one call (#533)", () => {
		const call = 'gh issue create --title "A thing" --body "some prose"';
		expect(denyReason(call)).toContain("node scripts/file-issue.js --title");
	});

	it("denies a create whose labels are all of some other family", () => {
		const call =
			'gh issue create --title "A thing" --label "manual-finding" --label kind:ticket';
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(MISSING);
	});

	it("keeps the command's own labels in the fix it shows, so copying it drops none", () => {
		expect(
			denyReason(
				'gh issue create --title "x" --label kind:ticket --label "Reviews & Rewards"',
			),
		).toContain(
			"--label takes:triage --label kind:ticket --label 'Reviews & Rewards'",
		);
	});

	it("denies a takes: value outside the seven", () => {
		// The typo case mantahostels#470 exists for: a label gh does not know aborts the whole
		// create and still exits 0, so this looks like success and files nothing.
		for (const call of [
			"gh issue create --label takes:implememt",
			"gh issue create --label takes:research",
			"gh issue create --label takes:",
		]) {
			expect(verdict(call)).toBe("deny");
			expect(denyReason(call)).toContain(INVALID);
		}
	});

	it("denies a bad value even where a good one is spelled first", () => {
		// gh aborts on ANY label it does not know, so one valid value alongside a
		// typo still files nothing at exit 0 — the failure this guard exists to
		// make impossible. A scan that stopped at the first valid value would
		// wave it through.
		const call =
			"gh issue create --label takes:implement --label takes:implememt";
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(INVALID);
	});

	it("denies a create hidden behind a chain or a subshell", () => {
		for (const call of [
			'npm run test && gh issue create --title "x"',
			'(gh issue create --title "x")',
		]) {
			expect(verdict(call)).toBe("deny");
			expect(denyReason(call)).toContain(MISSING);
		}
	});

	it("names all seven values in the refusal, so the fix needs no other document", () => {
		const out = run("gh issue create --title x").stdout ?? "";
		for (const v of [
			"takes:wayfinder",
			"takes:to-spec",
			"takes:to-tickets",
			"takes:implement",
			"takes:triage",
			"takes:human",
			"takes:children",
		]) {
			expect(out).toContain(v);
		}
	});

	it("says a bad label aborts the create at exit 0, when the value is wrong", () => {
		const out = run("gh issue create --label takes:nonsense").stdout ?? "";
		expect(out).toMatch(/exits? 0/i);
		expect(out).toContain("takes:nonsense");
	});
});

describe("the creates it allows", () => {
	it("allows every spelling of a valid takes: label", () => {
		for (const flag of [
			"--label takes:implement",
			'--label "takes:implement"',
			"--label=takes:implement",
			"-l takes:implement",
			"-l=takes:implement",
			"-ltakes:implement",
		]) {
			expect(verdict(`gh issue create --title "x" ${flag}`)).toBe("allow");
		}
	});

	it("allows a valid value alongside other labels, in either order", () => {
		expect(
			verdict(
				'gh issue create --title "x" --label "Reviews & Rewards" --label takes:triage',
			),
		).toBe("allow");
		expect(
			verdict(
				'gh issue create --title "x" --label takes:children --label kind:spec',
			),
		).toBe("allow");
	});

	it("allows a comma-separated list carrying the value", () => {
		// gh takes `--label a,b`, so a guard reading the whole word as one label
		// would deny a create that is in fact labelled correctly. The value is
		// deliberately not takes:human, whose own limb (mantahostels#2775) would then decide
		// this — leaving the comma-splitting this test exists for unasserted.
		expect(
			verdict('gh issue create --title "x" --label "kind:ticket,takes:triage"'),
		).toBe("allow");
	});

	it("says nothing about any other command", () => {
		expect(verdict("gh issue edit 12 --add-label takes:triage")).toBe("allow");
		expect(verdict("gh issue view 12")).toBe("allow");
		expect(verdict("gh pr create --title x")).toBe("allow");
		expect(verdict("npm run test")).toBe("allow");
		// Another program that happens to take the same subcommand pair. Only `gh`
		// files a GitHub issue, so only `gh` is judged.
		expect(verdict("./bin/tracker issue create --title x")).toBe("allow");
	});

	it("says nothing about a command that merely mentions the string", () => {
		// The PostToolUse hook's known residual (mantahostels#453): a substring match fires on
		// a command that only quotes the words. This one matches command position.
		expect(verdict('grep -rn "gh issue create" scripts/')).toBe("allow");
		expect(verdict('echo "run gh issue create next"')).toBe("allow");
	});

	it("allows a create asking for help, which files nothing", () => {
		expect(verdict("gh issue create --help")).toBe("allow");
	});
});

/* Each shape is asserted both ways: labelled it passes, unlabelled or misspelt
 * it is still refused. */
describe("the command shapes the parser once lost the label in (#490)", () => {
	const heredocBody = (label: string) =>
		`gh issue create --title "burn mode's off" ${label} --body "$(cat <<'EOF'\nPlain body.\nEOF\n)"`;

	it("reads past an apostrophe in the title", () => {
		expect(verdict(heredocBody("--label takes:implement"))).toBe("allow");
		expect(denyReason(heredocBody("--label kind:ticket"))).toContain(MISSING);
	});

	it("reads past escaped quotes and a $'…' string", () => {
		expect(
			verdict(
				'gh issue create --title "the \\"actually opened\\" case" --body "it\'s \\"x\\"" --label takes:triage',
			),
		).toBe("allow");
		const ansi = (label: string) =>
			`gh issue create --title $'it\\'s' --body x ${label}`;
		expect(verdict(ansi("--label takes:triage"))).toBe("allow");
		expect(denyReason(ansi("--label kind:ticket"))).toContain(MISSING);
		expect(
			denyReason(
				'gh issue create --title "the \\"actually opened\\" case" --body "it\'s" --label kind:ticket',
			),
		).toContain(MISSING);
	});

	it("reads a create split across lines by `\\` continuations whole", () => {
		const split = (label: string) =>
			`gh issue create --repo o/r \\\n  --title "Don't split" \\\n  --body "x" \\\n  ${label} > .claude/tmp/out 2>&1`;
		expect(verdict(split("--label takes:implement"))).toBe("allow");
		expect(denyReason(split("--label kind:ticket"))).toContain(MISSING);
		expect(denyReason(split("--label takes:implememt"))).toContain(INVALID);
	});

	it("reads a label after a $(cat <<'EOF') body whose text quotes and brackets", () => {
		const body = (label: string) =>
			`gh issue create --title "t" --body "$(cat <<'EOF'\nsee the "report's" caveat (and a stray ) too)\nEOF\n)" \\\n  ${label} 2>&1 | tail -5`;
		expect(verdict(body("--label bug --label takes:implement"))).toBe("allow");
		expect(denyReason(body("--label takes:agent"))).toContain(INVALID);
		const bare = (label: string) =>
			`gh issue create --title "x" --body "$(cat <<\\EOF\nit's\nEOF\n)" ${label}`;
		expect(verdict(bare("--label takes:triage"))).toBe("allow");
		expect(denyReason(bare("--label kind:ticket"))).toContain(MISSING);
		expect(faults()).toEqual([]);
	});

	it("reads a label after a multi-line body carrying escaped quotes", () => {
		const escaped = (label: string) =>
			`gh issue create --title "t" \\\n  --body "the \\"release's\\" gate\nsecond line" \\\n  ${label}`;
		expect(verdict(escaped('--label "takes:implement"'))).toBe("allow");
		expect(denyReason(escaped("--label kind:ticket"))).toContain(MISSING);
	});

	it("reads a here-string inside a $(…) body as no heredoc", () => {
		const herestring = (label: string) =>
			`gh issue create --title "t" --body "$(cat <<<x\n)" ${label}`;
		expect(verdict(herestring("--label takes:triage"))).toBe("allow");
		expect(denyReason(herestring("--label kind:ticket"))).toContain(MISSING);
	});
});

describe("the api spelling of a creation", () => {
	// The one Bash route the flag-form deny still missed (mantahostels#511): `gh api --method
	// POST …/issues` files an issue exactly as `gh issue create` does.
	it("denies a POST to the issue collection carrying no labels", () => {
		const call =
			'gh api --method POST repos/owner/repo/issues -f title="A thing"';
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(MISSING);
	});

	it("denies a POST whose labels are all of some other family", () => {
		const call =
			"gh api -X POST /repos/o/r/issues -f title=x -f 'labels[]=kind:ticket'";
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(MISSING);
		expect(denyReason(call)).toContain(
			"-f 'labels[]=takes:triage' -f 'labels[]=kind:ticket'",
		);
	});

	it("denies a takes: value outside the seven", () => {
		const call =
			"gh api --method POST repos/o/r/issues -f 'labels[]=takes:implememt'";
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(INVALID);
	});

	// The `gh api` parser is shared with guard-issue-body.sh: an `=`-joined or
	// -i-bundled method reaches the endpoint test, and an `=`-joined field is not
	// misread as a nameless one.
	it("denies a POST whose method is joined by an =, or bundled behind -i", () => {
		for (const call of [
			"gh api -X=POST repos/o/r/issues -f title=x",
			"gh api -iX=POST repos/o/r/issues -f title=x",
		]) {
			expect(verdict(call)).toBe("deny");
			expect(denyReason(call)).toContain(MISSING);
		}
	});

	it("allows those same spellings once a takes: label is on them", () => {
		expect(
			verdict(
				"gh api -X=POST repos/o/r/issues -f title=x -f 'labels[]=takes:implement'",
			),
		).toBe("allow");
		expect(
			verdict(
				"gh api --method POST repos/o/r/issues -f title=x -f='labels[]=takes:implement'",
			),
		).toBe("allow");
	});

	it("denies a POST gh infers from the fields, with no --method at all", () => {
		// gh's own default: POST where any field was passed, GET otherwise.
		expect(verdict("gh api repos/o/r/issues -f title=x")).toBe("deny");
		expect(denyReason("gh api repos/o/r/issues -f title=x")).toContain(MISSING);
	});

	it("denies the endpoint's other spellings, and past a leading flag", () => {
		// exempt (mantahostels#2145): no `takes:` label is spelled, so the bad-value refusal
		// cannot fire; the missing-label text is pinned by "denies a create carrying
		// no labels at all".
		expect(
			verdict(
				"gh api --method POST https://api.github.com/repos/o/r/issues -f title=x",
			),
		).toBe("deny");
		expect(
			verdict(
				'gh api -H "Accept: application/vnd.github+json" --method POST repos/o/r/issues -f title=x',
			),
		).toBe("deny");
	});

	it("denies past ordinary quoting of the method and the endpoint", () => {
		// The splitter blanks a quoted span, so a guard judging the blanked word
		// would let a pair of quotes walk the creation past the deny.
		// exempt (mantahostels#2145): no `takes:` label spelled; missing-label text pinned by "denies a create carrying no labels at all".
		expect(verdict('gh api --method POST "repos/o/r/issues" -f title=x')).toBe(
			"deny",
		);
		expect(verdict("gh api --method 'POST' repos/o/r/issues -f title=x")).toBe(
			"deny",
		);
		expect(faults()).toEqual([]);
	});

	it("denies a creation whose title is in a variable, and says nothing of it", () => {
		// The FIELD NAME is what the guard reads, so one unexpanded value neither
		// disarms the deny nor manufactures a fail-open record on a creation
		// labelled correctly.
		// exempt (mantahostels#2145): no `takes:` label spelled; missing-label text pinned by "denies a create carrying no labels at all".
		expect(verdict('gh api --method POST repos/o/r/issues -f title="$T"')).toBe(
			"deny",
		);
	});

	it("allows a labelled creation whose other fields are in variables", () => {
		// Not takes:human: an unreadable body IS a recorded fail-open under the
		// mantahostels#2775 limb, which would mask the silence this test asserts.
		expect(
			verdict(
				'gh api --method POST repos/o/r/issues -f title="$T" -f body="$BODY" -f \'labels[]=takes:triage\'',
			),
		).toBe("allow");
		expect(faults()).toEqual([]);
	});

	it("allows a POST carrying a valid value, in gh's several field spellings", () => {
		for (const field of [
			"-f 'labels[]=takes:triage'",
			'-f "labels[]=takes:triage"',
			"--raw-field 'labels[]=takes:triage'",
			"-flabels[]=takes:triage",
			"--field=labels[]=takes:triage",
		]) {
			expect(
				verdict(`gh api --method POST repos/o/r/issues -f title=x ${field}`),
			).toBe("allow");
		}
		expect(faults()).toEqual([]);
	});

	it("says nothing about a call that files no issue", () => {
		for (const call of [
			// Listing the collection, which is what an unmethoded, fieldless call is.
			"gh api repos/o/r/issues",
			"gh api --method GET repos/o/r/issues -f state=open",
			"gh api --method POST repos/o/r/issues/12/comments -f body=x",
			"gh api --method POST repos/o/r/issues/132/dependencies/blocked_by -F issue_id=1",
			// Editing an issue that already exists is guard-issue-body.sh's business.
			"gh api --method PATCH repos/o/r/issues/12 -f state=closed",
			"gh api --method POST repos/o/r/labels -f name=bug",
		]) {
			expect(verdict(call)).toBe("allow");
		}
		expect(faults()).toEqual([]);
	});

	// mantahostels#103's fail-open side: the hidden text may carry the right label, so the
	// guard records that it judged nothing rather than guessing either way. One
	// case per assertion, because a shape allowed in SILENCE is the failure being
	// checked for.
	it.each([
		["gh api --method POST repos/o/r/issues --input payload.json", "--input"],
		[
			'gh api --method POST repos/o/r/issues -f "labels[]=$LABEL"',
			"the label is in a variable",
		],
		["gh api --method $METHOD repos/o/r/issues -f title=x", "the method is"],
		[
			'gh api --method POST repos/o/r/issues -f "$FIELD"',
			"a whole field, name included, is a variable",
		],
		['gh api --method POST "$ENDPOINT" -f title=x', "the endpoint is"],
	])("allows and records %s — %s", (call) => {
		expect(verdict(call)).toBe("allow");
		expect(faults()).toHaveLength(1);
		expect(faults()[0]).toMatch(/create allowed unchecked/);
	});
});

describe("the graphql spelling of a creation (mantahostels#519)", () => {
	// The last Bash route that files an issue: `gh api graphql` carrying a
	// `createIssue` mutation. GraphQL takes label NODE IDS, not names, so where
	// labels are present the guard cannot tell whether any is a `takes:` value.
	const mutation = (args: string) =>
		`gh api graphql -f query='mutation{createIssue(input:{${args}}){issue{number}}}'`;

	it("denies a createIssue carrying no labelIds at all", () => {
		// exempt (mantahostels#2145): no `takes:` label spelled; missing-label text pinned by "denies a create carrying no labels at all".
		expect(verdict(mutation('repositoryId:"R_x",title:"A thing"'))).toBe(
			"deny",
		);
	});

	it("denies an empty labelIds list, which applies no label either", () => {
		// exempt (mantahostels#2145): no `takes:` label spelled; missing-label text pinned by "denies a create carrying no labels at all".
		expect(verdict(mutation('repositoryId:"R_x",title:"t",labelIds:[]'))).toBe(
			"deny",
		);
	});

	it("denies past whitespace, GraphQL ignoring it", () => {
		// exempt (mantahostels#2145): no `takes:` label spelled; missing-label text pinned by "denies a create carrying no labels at all".
		expect(
			verdict(
				'gh api graphql -f query=\'mutation { createIssue ( input: {repositoryId: "R_x", title: "t"} ) { issue { number } } }\'',
			),
		).toBe("deny");
	});

	it("denies through gh's other field and endpoint spellings", () => {
		for (const call of [
			`gh api graphql --raw-field query='mutation{createIssue(input:{title:"t"}){issue{id}}}'`,
			`gh api graphql -fquery='mutation{createIssue(input:{title:"t"}){issue{id}}}'`,
			`gh api --method POST graphql -f query='mutation{createIssue(input:{title:"t"}){issue{id}}}'`,
			`gh api https://api.github.com/graphql -f query='mutation{createIssue(input:{title:"t"}){issue{id}}}'`,
			`npm run check && gh api graphql -f query='mutation{createIssue(input:{title:"t"}){issue{id}}}'`,
		]) {
			// exempt (mantahostels#2145): no `takes:` label spelled; missing-label text pinned by "denies a create carrying no labels at all".
			expect(verdict(call)).toBe("deny");
		}
	});

	it("denies a creation whose other input fields are in variables", () => {
		// Every field NAME is still spelled out inside a braced input, so a
		// labelIds could not be hiding in one.
		// exempt (mantahostels#2145): no `takes:` label spelled; missing-label text pinned by "denies a create carrying no labels at all".
		expect(
			verdict(
				"gh api graphql -f query='mutation($t:String!){createIssue(input:{repositoryId:\"R_x\",title:$t}){issue{id}}}' -f t=x",
			),
		).toBe("deny");
	});

	it("names all seven values and the flag-form fix in the refusal", () => {
		const out = run(mutation('title:"t"')).stdout ?? "";
		for (const v of [
			"takes:wayfinder",
			"takes:to-spec",
			"takes:to-tickets",
			"takes:implement",
			"takes:triage",
			"takes:human",
			"takes:children",
		]) {
			expect(out).toContain(v);
		}
		// GraphQL wants a node id, which a session cannot type from memory, so the
		// refusal has to offer a route that does not need one.
		expect(out).toContain("gh issue create");
	});

	it("warns rather than denying where labelIds is present but opaque", () => {
		// The honest limit: `LA_kwDO…` is a node id, and nothing on the command
		// says which label it names. Denying would refuse a correctly-labelled
		// creation; allowing in silence would say the guard had checked.
		expect(
			verdict(mutation('repositoryId:"R_x",title:"t",labelIds:["LA_kwDOx"]')),
		).toBe("warn");
		expect(verdict(mutation("title:$t,labelIds:$labels"))).toBe("warn");
	});

	it("says in the warning that the ids cannot be resolved to names", () => {
		const out = run(mutation('title:"t",labelIds:["LA_kwDOx"]')).stdout ?? "";
		expect(out).toContain("takes:");
		expect(out).toMatch(/labelIds/);
	});

	it("keeps the suggested command on its own line in the warning", () => {
		// A command substitution eats the values list's trailing newline, so
		// `$(values_line)  $GRAPHQL_FIX` rendered as `takes:children  gh issue
		// create …` — the fix glued onto the last value, on one unreadable line.
		const out = run(mutation('title:"t",labelIds:["LA_x"]')).stdout ?? "";
		const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
		expect(ctx).toContain("\n  gh issue create");
		// [ \t]+, not \s+: \s matches a newline, so the loose spelling fires on the
		// CORRECT output and the test can never go green.
		expect(ctx).not.toMatch(/takes:children[ \t]+gh issue create/);
	});

	it("warns, never denies, where a bracket in a string literal truncates the args", () => {
		// The arguments are read up to the FIRST `)`, so a bracket inside a title
		// cuts them short and a trailing labelIds falls off with them. An odd
		// quote count is the tell.
		expect(
			verdict(
				`gh api graphql -f query='mutation{createIssue(input:{title:"fix (again)",labelIds:["LA_x"]}){issue{id}}}'`,
			),
		).toBe("warn");
	});

	it("still denies an unlabelled creation whose title holds no bracket", () => {
		// The quote-count test must not swallow the ordinary deny: a balanced pair
		// of quotes around a plain title leaves the args fully read.
		// exempt (mantahostels#2145): no `takes:` label spelled; missing-label text pinned by "denies a create carrying no labels at all".
		expect(
			verdict(
				`gh api graphql -f query='mutation{createIssue(input:{title:"fix again"}){issue{id}}}'`,
			),
		).toBe("deny");
	});

	it("warns where the whole input object arrives as one variable", () => {
		expect(
			verdict(
				"gh api graphql -f query='mutation($input:CreateIssueInput!){createIssue(input:$input){issue{id}}}' -f input=@vars.json",
			),
		).toBe("warn");
	});

	it("warns where a visible createIssue's query text is only part-readable", () => {
		expect(
			verdict(
				'gh api graphql -f query="mutation{createIssue(input:{title:$T})}" -f query="$MORE"',
			),
		).toBe("warn");
	});

	it("says nothing about a read-only query, or any other mutation", () => {
		for (const call of [
			`gh api graphql -f query='query{repository(owner:"o",name:"r"){issue(number:8){number}}}'`,
			`gh api graphql -f query='mutation{updateIssue(input:{id:"x",state:CLOSED}){issue{id}}}'`,
			`gh api graphql -f query='mutation{addComment(input:{subjectId:"x",body:"y"}){clientMutationId}}'`,
			// The word `createIssue` as a field ALIAS on a read, which is not a call
			// to it: the guard keys off `createIssue(`, its own opening bracket.
			`gh api graphql -f query='query{createIssue:repository(owner:"o",name:"r"){name}}'`,
		]) {
			expect(verdict(call)).toBe("allow");
		}
		expect(faults()).toEqual([]);
	});

	it("stays silent on a query it cannot read at all, and records nothing", () => {
		// The residual, kept deliberately: an unreadable query MIGHT hide a
		// createIssue, but a query from a file or a variable is routine here, and
		// warning on every one would fire almost entirely on read-only queries.
		// guard-issue-body.sh already warns on exactly these commands, so the
		// opacity is not invisible to the session, and a fail-open record on each
		// would drown check-guard-errors.js.
		for (const call of [
			"gh api graphql -F query=@mutation.graphql",
			"gh api graphql -f query=@-",
			"gh api graphql --input payload.json",
			'gh api graphql -f query="$QUERY"',
		]) {
			expect(verdict(call)).toBe("allow");
		}
		expect(faults()).toEqual([]);
	});

	it("records nothing at all on a graphql creation it judged", () => {
		verdict(mutation('title:"t"'));
		verdict(mutation('title:"t",labelIds:["LA_x"]'));
		expect(faults()).toEqual([]);
	});
});

/* The `takes:human` limb (mantahostels#2775): the value is the one of the seven with no
 * command and no review loop, so a wrong one is examined by nobody — mantahostels#804 wrote
 * the positive test and nothing checked it. These assert the check, and the
 * fail-opens that keep it from wedging a legitimate create. */
describe("the takes:human body limb (mantahostels#2775)", () => {
	const human = "names no act performed outside Claude Code";
	const unread = "whose body this guard cannot read";

	it("denies a takes:human create whose body names no outside act", () => {
		const call =
			'gh issue create --title x --label takes:human --body "cut three doc lines"';
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(human);
	});

	it("denies one carrying no body at all", () => {
		const call = "gh issue create --title x --label takes:human";
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(human);
	});

	it("denies a bare marker with no act written after it", () => {
		// The marker is the sentence's opening, not the sentence. Accepting it
		// alone would make the check a string anyone pastes past.
		for (const body of ["Outside Claude Code:", "**Outside Claude Code:** "]) {
			const call = `gh issue create --title x --label takes:human --body ${JSON.stringify(body)}`;
			expect(verdict(call)).toBe("deny");
		}
	});

	it("denies a bare marker whose act sits on a later line (#994)", () => {
		const call = `gh issue create --title x --label takes:human --body '**Outside Claude Code:**\n\nmore text${CLOSE}'`;
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(human);
	});

	it("allows one that names the act, bold or plain", () => {
		for (const body of [
			"**Outside Claude Code:** submit the registration form",
			"Outside Claude Code: email Bunkward's partner team",
			"## Why\nprose first\n\n**Outside Claude Code:** read the region off the iPhone\n",
		]) {
			const call = `gh issue create --title x --label takes:human --body ${JSON.stringify(body + CLOSE)}`;
			expect(verdict(call)).toBe("allow");
		}
	});

	it("reads a --body-file off disk, which is how a long body is filed", () => {
		const named = path.join(shared, "named.md");
		const bare = path.join(shared, "bare.md");
		fs.writeFileSync(
			named,
			"why\n\n**Outside Claude Code:** sign the DPA\n**Close when:** the founder confirms it\n",
		);
		fs.writeFileSync(bare, "why\n\nnothing outside here\n");
		expect(
			verdict(`gh issue create --label takes:human --body-file ${named}`),
		).toBe("allow");
		expect(
			verdict(`gh issue create --label takes:human --body-file ${bare}`),
		).toBe("deny");
		// gh's short spelling of the same flag.
		expect(verdict(`gh issue create --label takes:human -F ${named}`)).toBe(
			"allow",
		);
	});

	it("says nothing about the other six values, whatever their body", () => {
		for (const v of [
			"takes:wayfinder",
			"takes:to-spec",
			"takes:to-tickets",
			"takes:implement",
			"takes:triage",
			"takes:children",
		]) {
			expect(
				verdict(`gh issue create --title x --label ${v} --body "no act here"`),
			).toBe("allow");
		}
	});

	it("refuses the label rather than the syntax, naming where the work goes instead", () => {
		const out = denyReason(
			'gh issue create --label takes:human --body "cut three doc lines"',
		);
		// A session reaching this refusal is holding the wrong label; the fix is
		// a different value, not a pasted line. Both re-routes must be on it.
		expect(out).toContain("takes:implement");
		expect(out).toContain("takes:wayfinder");
		expect(out).toContain("**Outside Claude Code:**");
		expect(out).toMatch(/founder decision or confirmation +→ takes:wayfinder/);
		expect(out).not.toContain("approval only the founder can give");
	});

	it("refuses a body it cannot read, naming the heredoc form (#668)", () => {
		for (const call of [
			'gh issue create --label takes:human --body "$BODY"',
			'gh issue create --label takes:human --body "$(cat notes.md)"',
			"gh issue create --label takes:human --body-file -",
		]) {
			const reason = denyReason(call);
			expect(reason).toContain(unread);
			expect(reason).toContain("cat <<'BODY' | gh issue create");
		}
		expect(faults()).toEqual([]);
	});

	it("refuses #565's own create, whose inline body held escaped backticks, as a body it cannot read", () => {
		const call =
			'gh issue create --title "Should the hook skip Explore?" --label "takes:human" --body "\\`scripts/x.sh\\` adds a line. The decision: exempt them or not." 2>&1 | tail -1';
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(unread);
	});

	it("still lets an unreadable body through on any other takes: value", () => {
		expect(
			verdict('gh issue create --label takes:triage --body "$(cat notes.md)"'),
		).toBe("allow");
		expect(faults()).toEqual([]);
	});

	describe("a heredoc piped into --body-file - (mantahostels#3439)", () => {
		const piped = (open: string, body: string, close = "BODY") =>
			`cat <<${open} | gh issue create --title x --label takes:human --body-file -\n${body}\n${close}`;

		it("reads a quoted heredoc's body, and judges it", () => {
			expect(verdict(piped("'BODY'", "why\n\ncut three doc lines"))).toBe(
				"deny",
			);
			expect(
				verdict(
					piped(
						"'BODY'",
						"why\n\n**Outside Claude Code:** sign the DPA\n**Close when:** the founder confirms it",
					),
				),
			).toBe("allow");
			// A double-quoted delimiter is as literal as a single-quoted one.
			expect(verdict(piped('"BODY"', "cut three doc lines"))).toBe("deny");
			expect(faults()).toEqual([]);
			// The same refusal the flag form earns, not a different route's.
			expect(denyReason(piped("'BODY'", "cut lines"))).toContain(human);
		});

		it("reads the form a session actually runs, prefix and trailing redirects included", () => {
			const session = (body: string) =>
				`cd /repo && cat <<'BODY' | gh issue create --title "t" --label takes:human --body-file - > .claude/tmp/x.txt 2>&1; echo "exit $?"\n${body}\nBODY`;
			expect(verdict(session("cut lines"))).toBe("deny");
			expect(
				verdict(
					session(
						"Outside Claude Code: sign the DPA\n**Close when:** the founder confirms it",
					),
				),
			).toBe("allow");
			// Indented, as inside a block.
			expect(verdict(`  ${piped("'BODY'", "cut lines")}`)).toBe("deny");
			expect(faults()).toEqual([]);
		});

		it("reads a heredoc attached to the create itself, and `-F -`", () => {
			const attached = (body: string) =>
				`gh issue create --label takes:human --body-file - <<'BODY'\n${body}\nBODY`;
			const short = (body: string) =>
				`cat <<'BODY' | gh issue create --label takes:human -F -\n${body}\nBODY`;
			for (const shape of [attached, short]) {
				expect(verdict(shape("cut lines"))).toBe("deny");
				expect(
					verdict(
						shape(
							"Outside Claude Code: sign the DPA\n**Close when:** the founder confirms it",
						),
					),
				).toBe("allow");
			}
			expect(faults()).toEqual([]);
		});

		it("reads an unquoted heredoc only where its body expands nothing", () => {
			expect(verdict(piped("BODY", "cut three doc lines"))).toBe("deny");
			expect(faults()).toEqual([]);
			for (const body of [
				"Outside Claude Code: $ACT",
				"see `ls`",
				"a \\$ escaped",
			]) {
				expect(denyReason(piped("BODY", body))).toContain(unread);
			}
			expect(faults()).toEqual([]);
		});

		it("judges the create's own body, never a later heredoc's", () => {
			const note = (body: string) => `\ncat <<'NOTE'\n${body}\nNOTE`;
			expect(
				verdict(
					`${piped("'BODY'", "cut lines")}${note("Outside Claude Code: x")}`,
				),
			).toBe("deny");
			expect(
				verdict(
					`${piped("'BODY'", "Outside Claude Code: pay x\nClose when: y")}${note("cut lines")}`,
				),
			).toBe("allow");
		});

		it("refuses the shapes whose stdin it cannot tie to the create, recording no fault (#668)", () => {
			for (const call of [
				// Two heredoc-fed creates: which body feeds which is not read, only
				// guessed.
				`${piped("'BODY'", "cut lines")}\n${piped("'NOTE'", "Outside Claude Code: x", "NOTE")}`,
				// A filter between the heredoc and gh changes the text gh receives.
				"grep x <<'BODY' | gh issue create --label takes:human --body-file -\ncut lines\nBODY",
				// A herestring is not a heredoc.
				'gh issue create --label takes:human --body-file - <<< "cut lines"',
				// Never terminated.
				"cat <<'BODY' | gh issue create --label takes:human --body-file -\ncut lines",
				// Tab-stripping heredoc, whose terminator the reader does not match.
				"cat <<-'BODY' | gh issue create --label takes:human --body-file -\n\tcut lines\n\tBODY",
				// A continued create line: its next line is flags, not body.
				"cat <<'BODY' | gh issue create --label takes:human --body-file - \\\n--title x\ncut lines\nBODY",
				// Mismatched delimiter quotes, which bash does not read as `BODY`.
				"cat <<'BODY\" | gh issue create --label takes:human --body-file -\ncut lines\nBODY",
			]) {
				expect(denyReason(call)).toContain(unread);
			}
			expect(faults()).toEqual([]);
		});
	});

	it("chases the REST spelling too", () => {
		const post = "gh api --method POST repos/o/r/issues -f title=x";
		expect(
			verdict(`${post} -f 'labels[]=takes:human' -f body="cut three lines"`),
		).toBe("deny");
		expect(
			verdict(
				`${post} -f 'labels[]=takes:human' -f body="Outside Claude Code: post the form Close when: it is accepted"`,
			),
		).toBe("allow");
	});

	it("refuses a REST body passed as @file, which is a path not the text (#668)", () => {
		expect(
			denyReason(
				"gh api --method POST repos/o/r/issues -f 'labels[]=takes:human' -F body=@body.md",
			),
		).toContain(unread);
	});

	it("gives one refusal, not two, when the label is also missing", () => {
		// The missing-label fault is the older and larger one, and its refusal
		// already carries all seven values.
		const call = 'gh issue create --title x --body "cut three doc lines"';
		expect(denyReason(call)).toContain(MISSING);
		expect(denyReason(call)).not.toContain(human);
	});
});

describe("the blank-body limb (mantahostels#3443)", () => {
	const blank = "This files an issue whose body";
	const create = "gh issue create --title x --label takes:implement";

	it("denies the 7 Sep shape, naming the file: a missing file piped into --body-file -", () => {
		// Verbatim but for the title (mantahostels#3443).
		const call = `cat .claude/tmp/followon-body.md | gh issue create --title "x" --label "Tech & Stack" --label "takes:implement" --body-file - > .claude/tmp/followon-created.out 2>&1 &`;
		expect(verdict(call)).toBe("deny");
		const out = denyReason(call);
		expect(out).toContain(`${blank} is read from a file that does not exist`);
		expect(out).toContain("`.claude/tmp/followon-body.md`");
		expect(out).not.toContain(MISSING);
	});

	it("allows the same pipe once the file holds a body", () => {
		fs.mkdirSync(path.join(shared, ".claude/tmp"), { recursive: true });
		fs.writeFileSync(path.join(shared, ".claude/tmp/body.md"), "why\n");
		expect(verdict(`cat .claude/tmp/body.md | ${create} --body-file -`)).toBe(
			"allow",
		);
		expect(verdict(`cat '.claude/tmp/body.md' | ${create} --body-file -`)).toBe(
			"allow",
		);
	});

	it("denies a --body-file naming a file absent from disk", () => {
		fs.writeFileSync(path.join(shared, "present.md"), "why\n");
		for (const [call, named] of [
			[`${create} --body-file /no/such/file.md`, "/no/such/file.md"],
			[`${create} -F missing.md`, "missing.md"],
			// Resolved against the directory the create runs in, not the hook's.
			[`cd ${elsewhere} && ${create} --body-file present.md`, "present.md"],
			[`cat -- missing.md | ${create} --body-file -`, "missing.md"],
			// A quoted `~` reaches gh unexpanded, so it names a relative path.
			[`${create} --body-file '~/present.md'`, "~/present.md"],
		]) {
			expect(denyReason(call)).toContain(
				`${blank} is read from a file that does not exist: \`${named}\``,
			);
		}
		expect(verdict(`${create} --body-file present.md`)).toBe("allow");
		expect(
			verdict(`cd ${elsewhere} && ${create} --body-file ${shared}/present.md`),
		).toBe("allow");
		// A subshell's `cd` and an empty `cd ''` leave the directory where it was.
		expect(
			verdict(`(cd ${elsewhere} && true); ${create} --body-file present.md`),
		).toBe("allow");
		expect(verdict(`cd '' && ${create} --body-file present.md`)).toBe("allow");
	});

	it("does not exempt a file named only after the read, or in the create's own title", () => {
		for (const call of [
			`${create} -F missing.md; printf x > missing.md`,
			"gh issue create --title 'fix missing.md' --label takes:implement -F missing.md",
		]) {
			expect(verdict(call)).toBe("deny");
		}
	});

	it("allows a command that writes the body file and then creates the issue", () => {
		// The file is absent at hook time only because this same command writes it.
		for (const call of [
			`cat > .claude/tmp/followon-body.md <<'BODY'\nwhy\nBODY\ncat .claude/tmp/followon-body.md | ${create} --body-file -`,
			`cat > new.md <<'BODY'\nwhy\nBODY\n${create} --body-file new.md`,
			`printf 'why\\n' | tee new.md >/dev/null && ${create} --body-file new.md`,
			`node scripts/write-body.js > out/new.md && ${create} -F out/new.md`,
		]) {
			expect(verdict(call)).toBe("allow");
		}
	});

	it("denies a body that is empty or whitespace-only, on every route it reads", () => {
		fs.writeFileSync(path.join(shared, "empty.md"), "");
		fs.writeFileSync(path.join(shared, "blank.md"), " \n\t\n");
		for (const call of [
			`${create} --body ""`,
			`${create} -b "   "`,
			`${create} --body-file empty.md`,
			`cat blank.md | ${create} --body-file -`,
			`cat <<'BODY' | ${create} --body-file -\nBODY`,
			`${create} --body-file - <<'BODY'\n  \nBODY`,
		]) {
			expect(verdict(call)).toBe("deny");
			expect(denyReason(call)).toContain(`${blank} is empty`);
		}
	});

	it("refuses the body before the label, whatever the takes: value, recording no fault", () => {
		expect(denyReason('gh issue create --title x --body ""')).toContain(blank);
		// takes:human is never logged as unreadable on its way to the refusal.
		expect(
			verdict("gh issue create --label takes:human --body-file /no/such.md"),
		).toBe("deny");
		expect(faults()).toEqual([]);
	});

	it("fails open on a body or a directory it cannot read", () => {
		for (const call of [
			`${create} --body "$BODY"`,
			`${create} --body-file "$F"`,
			`cat "$F" | ${create} --body-file -`,
			`cat $(ls *.md) | ${create} --body-file -`,
			// No body flag at all: gh itself refuses a non-interactive create.
			create,
			// Two creates: which cat feeds which is not read.
			`cat a.md | ${create} --body-file -\ncat b.md | ${create} --body-file -`,
			// A filter between the file and gh.
			`cat missing.md | grep x | ${create} --body-file -`,
		]) {
			expect(verdict(call)).toBe("allow");
		}
	});

	it("allows and records a body file in a directory it cannot follow, or that it cannot read", () => {
		fs.mkdirSync(path.join(shared, "notes"));
		for (const call of [
			`cd "$DIR" && ${create} --body-file missing.md`,
			`cd - && ${create} --body-file missing.md`,
			`pushd ${elsewhere} && ${create} --body-file missing.md`,
			`builtin cd ${elsewhere} && ${create} --body-file missing.md`,
			`${create} --body-file notes`,
		]) {
			expect(verdict(call)).toBe("allow");
		}
		expect(faults().filter((f) => /body file/.test(f))).toHaveLength(5);
	});

	it("refuses those same body files on a takes:human create, unrecorded (#668)", () => {
		fs.mkdirSync(path.join(shared, "notes"));
		const human = "gh issue create --title x --label takes:human";
		for (const call of [
			`cd "$DIR" && ${human} --body-file missing.md`,
			`${human} --body-file notes`,
		]) {
			expect(denyReason(call)).toContain("whose body this guard cannot read");
		}
		expect(faults()).toEqual([]);
	});
});

describe("the basis limb (#672)", () => {
	const create = "gh issue create --title x --label takes:implement";
	const unbased = "sets a wait with nothing behind it";

	it("denies a gate line or a prose wait with no basis, naming it", () => {
		for (const [call, named] of [
			[
				`${create} --body-file - <<'BODY'\n**Gated until:** 2026-10-05 — a week live\nBODY`,
				"**Gated until:** 2026-10-05",
			],
			[
				`${create} --body "re-run the census after a week live"`,
				"after a week",
			],
		]) {
			const out = denyReason(call);
			expect(out).toContain(unbased);
			expect(out).toContain(named);
			expect(out).toContain("why nothing sooner fits it");
		}
	});

	it("allows the same bodies once a basis is written, and a measurement window", () => {
		for (const call of [
			`${create} --body-file - <<'BODY'\n**Gated until:** 2026-09-29 — a day live\n**Gate basis:** counters live 24 hours\nBODY`,
			`${create} --body "80 asks in 30 days"`,
			`${create} --body-file - <<'BODY'\nquoted as \`after a week\` here\nBODY`,
		]) {
			expect(verdict(call)).toBe("allow");
		}
	});
});

describe("the second-map limb (#717)", () => {
	const create =
		"gh issue create --title x --label takes:wayfinder --label wayfinder:map --body y";
	const map = (number: number, destination: string) => ({
		number,
		labels: [{ name: "wayfinder:map" }],
		body: `## Destination\n\n${destination}\n\n## Notes\n`,
	});
	const env = (maps: unknown, extra: Record<string, string> = {}) => ({
		WFC_GH: path.join(binDir, "gh"),
		GH_SHIM_MAPS: typeof maps === "string" ? maps : JSON.stringify(maps),
		GH_SHIM_ARGS: path.join(dir, "gh-args"),
		...extra,
	});
	const listCalls = () => {
		const at = path.join(dir, "gh-args");
		return fs.existsSync(at)
			? fs.readFileSync(at, "utf8").split("\n").filter(Boolean)
			: [];
	};

	beforeEach(writeShim);

	it("denies a map while an open map's Destination is unfilled, naming it", () => {
		const e = env([map(3, UNFILLED_DESTINATION)]);
		expect(verdict(create, shared, e)).toBe("deny");
		const out = denyReason(create, e);
		expect(out).toContain("second wayfinder map while the first is unfilled");
		expect(out).toContain("Fill #3 instead");
		expect(faults()).toEqual([]);
	});

	it("allows a map once every open map's Destination is filled", () => {
		expect(verdict(create, shared, env([map(3, "Ship booking.")]))).toBe(
			"allow",
		);
		expect(verdict(create, shared, env([]))).toBe("allow");
	});

	it("makes its one gh call only for a map, against the create's --repo", () => {
		expect(
			verdict(
				"gh issue create --title x --label takes:implement --body y",
				shared,
				env([map(3, UNFILLED_DESTINATION)]),
			),
		).toBe("allow");
		expect(listCalls()).toEqual([]);
		verdict(`${create} --repo acme/widgets`, shared, env([]));
		expect(listCalls()).toHaveLength(1);
		expect(listCalls()[0]).toMatch(
			/^issue list --repo acme\/widgets --label wayfinder:map --state open /,
		);
	});

	it("runs its call where the create runs, so gh resolves the same repo", () => {
		verdict(`cd ${elsewhere} && ${create}`, shared, env([]));
		expect(listCalls()[0]).toContain(`(in ${elsewhere})`);
	});

	it("fails open, recorded, on an answer it cannot read", () => {
		for (const e of [env("not json"), env([], { GH_SHIM_MODE: "fail" })]) {
			expect(verdict(create, shared, e)).toBe("allow");
		}
		expect(faults()).toEqual([
			"lib/issue-gate.js --second-map gave no reading — second map unchecked on this create",
			"lib/issue-gate.js --second-map gave no reading — second map unchecked on this create",
		]);
	});

	it("fails open, recorded, where the create's directory cannot be entered", () => {
		const gone = path.join(dir, "gone");
		expect(verdict(`cd ${gone} && ${create}`, shared, env([]))).toBe("allow");
		expect(listCalls()).toEqual([]);
		expect(faults()).toEqual([
			"could not enter the directory a wayfinder:map create runs in — second map unchecked on this create",
		]);
	});

	describe("through the REST endpoint (#1464)", () => {
		const rest = (repo: string) =>
			`gh api --method POST repos/${repo}/issues -f title=x -f body=y -f 'labels[]=takes:wayfinder' -f 'labels[]=wayfinder:map'`;

		it("refuses as the flag form does, against the endpoint's repo", () => {
			const e = env([map(3, UNFILLED_DESTINATION)]);
			expect(verdict(rest("acme/widgets"), shared, e)).toBe("deny");
			expect(denyReason(rest("acme/widgets"), e).replace(/: .*\n/, "")).toBe(
				denyReason(create, e).replace(/: .*\n/, ""),
			);
			expect(listCalls()[0]).toMatch(/^issue list --repo acme\/widgets /);
			expect(faults()).toEqual([]);
		});

		it("allows a filled map, and lets gh fill {owner}/{repo} from the cwd", () => {
			expect(
				verdict(rest("{owner}/{repo}"), shared, env([map(3, "Ship booking.")])),
			).toBe("allow");
			expect(listCalls()[0]).toMatch(/^issue list --label wayfinder:map /);
		});

		it("fails open, recorded, on a half-placeholder endpoint whose repo it cannot know", () => {
			expect(verdict(rest("{owner}/widgets"), shared, env([]))).toBe("allow");
			expect(listCalls()).toEqual([]);
			expect(faults()).toEqual([
				"could not read which repo a wayfinder:map create files into — second map unchecked on this create",
			]);
		});
	});

	it("fails open, recorded, on a --repo it cannot read", () => {
		expect(verdict(`${create} --repo "$R"`, shared, env([]))).toBe("allow");
		expect(listCalls()).toEqual([]);
		expect(faults()).toEqual([
			"could not read which repo a wayfinder:map create files into — second map unchecked on this create",
		]);
	});
});

describe("the flags whose values it skips", () => {
	it("does not read a value-taking flag's own value as an argument", () => {
		// The pair-skip (mantahostels#477). Without it the unexpanded $VERSION below is read as
		// a bare word, the guard cannot tell what will be sent, and a create it
		// could have judged is allowed unchecked instead.
		// Not takes:human, whose own limb (mantahostels#2775) would decide this create on its
		// missing body before the pair-skip was tested at all.
		expect(
			verdict("gh issue create --title $VERSION --label takes:triage"),
		).toBe("allow");
		expect(faults().join("\n")).not.toMatch(/create allowed unchecked/);
	});

	it("does not credit a --label written after a bare --", () => {
		// End-of-options (mantahostels#495). gh's flag reader stops at `--` too, so what
		// follows reaches gh as a positional and no label is ever applied: reading
		// it as a label would allow a create that files an unlabelled issue.
		// exempt (mantahostels#2145): the `takes:` word sits past the `--`, so the guard reads
		// no label at all; the missing-label text is pinned by "denies a create
		// carrying no labels at all".
		expect(verdict("gh issue create --title x -- --label takes:human")).toBe(
			"deny",
		);
	});
});

describe("what it fails open on", () => {
	it("allows and records a label value it cannot read", () => {
		// An unexpanded variable: judging it would mean guessing the label.
		expect(verdict('gh issue create --title "x" --label "$LABEL"')).toBe(
			"allow",
		);
		expect(faults().join("\n")).toMatch(
			/could not read .*label.*create allowed unchecked/,
		);
	});

	it("allows and records a create whose whole argument list is hidden", () => {
		expect(verdict("gh issue create $ARGS")).toBe("allow");
		expect(faults().join("\n")).toMatch(/create allowed unchecked/);
	});

	it("allows and records everything when the shared parser cannot be read", () => {
		const at = path.join(dir, "detached");
		fs.mkdirSync(path.join(at, "lib"), { recursive: true });
		const guard = path.join(at, path.basename(GUARD));
		fs.copyFileSync(GUARD, guard);
		fs.chmodSync(guard, 0o755);
		// guard-log.sh reads the repo root through gr_root, which lives in
		// guard-root.sh since mantahostels#1905 — without it the fail-open record lands under
		// the wrong slug and this case tests nothing.
		for (const lib of ["guard-log.sh", "guard-root.sh"]) {
			fs.copyFileSync(
				path.resolve(__dirname, "lib", lib),
				path.join(at, "lib", lib),
			);
		}
		const r = spawnSync(guard, [], {
			cwd: shared,
			encoding: "utf8",
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "gh issue create --title x" },
			}),
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: shared,
				CLAUDE_CONFIG_DIR: config,
			},
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(faults().join("\n")).toMatch(/guard-parse\.sh did not load/);
	});

	it("records nothing at all on a create it judged", () => {
		// Every entry in this log claims something went unprotected, so a verdict
		// the guard actually reached must never appear in it.
		verdict("gh issue create --title x");
		verdict("gh issue create --title x --label takes:triage");
		expect(faults()).toEqual([]);
	});
});

describe("the guard is wired", () => {
	it("is registered as a PreToolUse Bash hook in self-plugin/hooks/hooks.json", () => {
		// An **Enforced** claim in CLAUDE.md is only true while this holds, and
		// check-guard-registry.js reads the same file in CI.
		const settings = JSON.parse(
			fs.readFileSync(
				path.resolve(__dirname, "..", "self-plugin", "hooks", "hooks.json"),
				"utf8",
			),
		);
		const bash = settings.hooks.PreToolUse.filter(
			(h: { matcher: string }) => h.matcher === "Bash",
		).flatMap((h: { hooks: Array<{ command: string }> }) => h.hooks);
		expect(
			bash.some((h: { command: string }) =>
				h.command.includes("guard-issue-create-label.sh"),
			),
		).toBe(true);
	});

	it("is executable, or the hook runner cannot invoke it", () => {
		expect(() => fs.accessSync(GUARD, fs.constants.X_OK)).not.toThrow();
	});

	it("spells the same seven values docs/agents/triage-labels.md does", () => {
		// A guard demanding a token the doc does not name is a trap, not a rule.
		const doc = fs.readFileSync(
			path.resolve(__dirname, "..", "docs", "agents", "triage-labels.md"),
			"utf8",
		);
		const list = fs
			.readFileSync(GUARD, "utf8")
			.match(/^TAKES_VALUES=\((.*)\)$/m);
		expect(list).not.toBeNull();
		const values = (list?.[1] ?? "").trim().split(/\s+/);
		expect(values).toHaveLength(7);
		for (const v of values) expect(doc).toContain(`takes:${v}`);
	});
});

describeFailOpenLog({
	guard: GUARD,
	denied: {
		tool_name: "Bash",
		tool_input: { command: "gh issue create --title x" },
	},
	fieldless: { tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: { tool_name: "Bash", tool_input: { command: "git status" } },
	ctx: () => ({ dir, config, project: shared }),
});

describeSharedParserLibrary({
	guard: GUARD,
	denyCommand: "gh issue create --title x",
	ctx: () => ({
		dir,
		shared,
		elsewhere,
		env: { CLAUDE_CONFIG_DIR: config },
	}),
});

/*
 * mantahostels#1649 relocated the `takes:` label rule out of CLAUDE.md and into these two
 * refusals (spec mantahostels#1641). Keyed by fragment id, never by a literal copied out of
 * the fragment — a second copy is the drift the store exists to prevent.
 */
describe("the relocated rule reaches the session that trips the guard", () => {
	it("prints no 'no command opens this' shape (mantahostels#3352, mantahostels#3555)", () => {
		expect(
			denyReason('gh issue create --label takes:human --body "cut lines"'),
		).not.toContain("One shape passes");
	});

	it.each([
		['gh issue create --title "t" --body "b"', "no label at all"],
		[
			'gh issue create --title "t" --body "b" --label takes:nonsense',
			"a value no label answers to",
		],
	])("%s carries the whole rule — %s", (command) => {
		expect(denyReason(command)).toContain(ruleText("issue-takes-label"));
	});

	it("still lists the seven values, which the fragment deliberately does not", () => {
		// The values are generated from the live label set, so they stay with the
		// guard; a fragment naming them would go stale the day one is added.
		expect(denyReason('gh issue create --title "t" --body "b"')).toContain(
			"takes:to-tickets",
		);
	});
});

/* The barred limb (#140). #131 carried an Outside line that named a
 * PROHIBITION — "which sits outside this repository and no agent may write
 * to" — where the file was writable and no rule barred it. The regex is
 * equivalent to scripts/lib/takes-label.js's BARRED_ACT, unpinned. */
describe("the barred limb (#140)", () => {
	const barred = "names a prohibition rather than an act";
	const create = (line: string) =>
		`gh issue create --title x --label takes:human --body '**Outside Claude Code:** ${line}${CLOSE}'`;

	it("denies #131's original line, naming it a prohibition rather than an act", () => {
		const call = create(
			"Edit the burn-mode segment of the user-scope status line at ~/.claude/statusline.sh, which sits outside this repository and no agent may write to.",
		);
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(barred);
		expect(denyReason(call)).toContain("BEING BARRED IS NOT BEING IMPOSSIBLE");
	});

	it.each([
		["no agent may", "edit the file, which no agent may write to"],
		["no agent can", "change it, which no agent can touch"],
		[
			"an agent is not permitted",
			"edit it; an agent is not permitted to do so",
		],
		["agents are barred", "edit it, since agents are barred from that path"],
		["no session may", "edit it, which no session may open"],
		["passive, by an agent", "redraw it — it cannot be done by an agent"],
	])("denies %s", (_, line) => {
		expect(verdict(create(line))).toBe("deny");
	});

	it.each([
		["an errand", "email the Bunkward affiliate desk for a partner key"],
		["a payment", "pay for one month of the vendor plan in the browser"],
		["a phone reading", "read the two-factor code off your own phone"],
		["a signature", "sign and return the agreement to the counterparty"],
	])("allows %s — a real act", (_, line) => {
		expect(verdict(create(line))).toBe("allow");
	});

	/* Every alternative names an AGENT or a SESSION as the barred subject. A
	   prohibition about the WORLD is usually part of a real errand, and an
	   earlier draft denied all four of these — the first because it merely
	   LOCATED something outside the repo, the rest because the prohibition was
	   someone else's. Found by review, not by reasoning. */
	it.each([
		[
			"a location, not a bar",
			"sign up on the vendor site; the credentials live outside this repository",
		],
		[
			"a form's own rule",
			"submit the form; once submitted it may not be edited",
		],
		[
			"a counterparty's rule",
			"phone the bank and ask why the account is barred from international transfers",
		],
		[
			"a third party's rule",
			"email the landlord that we are not permitted to sublet",
		],
	])("allows %s", (_, line) => {
		expect(verdict(create(line))).toBe("allow");
	});

	/* The deny text has to send the reader somewhere, and the two destinations
	   are the ones mantahostels#2775 names. */
	it("names both destinations in its refusal", () => {
		const r = denyReason(create("edit it, which no agent may write to"));
		expect(r).toContain("takes:wayfinder");
		expect(r).toContain("takes:implement");
	});
});

/* The repo-file limb (mantahostels#3555, ruled on mantahostels#3503): a takes:human whose Outside line
 * names a repo file as the act's product passed the line check and sat
 * unopened. The regex is equivalent to scripts/lib/takes-label.js's REPO_FILE_ACT, unpinned. */
describe("the repo-file limb (mantahostels#3555)", () => {
	const repo = "whose outside act produces a file in this repository";
	// Single-quoted: inside double quotes a backticked path would be a command
	// substitution, which the guard rightly cannot read and fails open on.
	const create = (line: string) =>
		`gh issue create --title x --label takes:human --body '**Outside Claude Code:** ${line}${CLOSE}'`;

	it("denies mantahostels#3503's original line — a tool and a repo path — citing that issue in the refusal", () => {
		const call = create(
			"draw the flat/silhouette mark variant in Inkscape and save it into `docs/brand_assets/`.",
		);
		expect(verdict(call)).toBe("deny");
		expect(denyReason(call)).toContain(repo);
		expect(denyReason(call)).toContain("#3503");
	});

	it.each([
		["a backticked repo path", "hand-edit `scripts/guard-x.sh`"],
		["a source filename", "redraw mark-final.svg at 2.85x"],
		["a file-producing tool", "lay the census out in a spreadsheet"],
		["a design tool", "trace the mark in Figma"],
	])("denies %s", (_, line) => {
		expect(verdict(create(line))).toBe("deny");
	});

	it("allows mantahostels#3092's line — paying in a browser is an errand", () => {
		expect(
			verdict(
				create(
					"pay for one month of Higgsfield Starter and one month of Midjourney Basic in the browser, and read three vendors output-ownership clauses there.",
				),
			),
		).toBe("allow");
	});

	it("reads the Outside line only, never the rest of the body", () => {
		const body =
			"**Outside Claude Code:** email the hostel.\n\nThe reply is filed to `docs/research/x.md` later.\n\n**Close when:** the reply is filed.";
		// A quoted heredoc, so the body is read: a double-quoted one holding
		// backticks is unreadable, and refused on that ground instead (#668).
		expect(
			verdict(
				`cat <<'BODY' | gh issue create --title x --label takes:human --body-file -\n${body}\nBODY`,
			),
		).toBe("allow");
		expect(faults()).toEqual([]);
	});

	it("leaves the line off any other takes: value alone", () => {
		expect(
			verdict(
				"gh issue create --title x --label takes:implement --body '**Outside Claude Code:** edit `docs/x.md`'",
			),
		).toBe("allow");
	});
});

describe("the edit route (mantahostels#3555)", () => {
	const errand = `**Outside Claude Code:** email the hostel.${CLOSE}`;
	const repoFile =
		"**Outside Claude Code:** draw it in Inkscape and save it into `docs/brand_assets/`.";
	const env = (extra: Record<string, string> = {}) => ({
		WFC_GH: path.join(binDir, "gh"),
		...extra,
	});

	beforeEach(writeShim);

	it("denies applying takes:human to an issue whose body has no Outside line, naming the issue", () => {
		const call = "gh issue edit 12 --add-label takes:human";
		const e = env({ GH_SHIM_BODY: "Fill the gaps." });
		expect(verdict(call, shared, e)).toBe("deny");
		expect(denyReason(call, e)).toContain(
			"applies `takes:human` to #12 whose body names no act",
		);
		expect(faults()).toEqual([]);
	});

	it("allows it where the body names the act", () => {
		expect(
			verdict(
				"gh issue edit 12 --add-label takes:human",
				shared,
				env({ GH_SHIM_BODY: errand }),
			),
		).toBe("allow");
	});

	it("denies it where the act produces a repo file, naming the issue", () => {
		const call = "gh issue edit 12 --add-label takes:human";
		expect(verdict(call, shared, env({ GH_SHIM_BODY: repoFile }))).toBe("deny");
		expect(denyReason(call, env({ GH_SHIM_BODY: repoFile }))).toContain(
			"applies `takes:human` to #12 whose outside act produces a file",
		);
	});

	/* #140: the barred limb reaches the relabel route too, which is the shape
	   #117 came in by — a takes:human applied to an issue already filed. */
	it("denies it where the Outside line names a prohibition", () => {
		const barred =
			"**Outside Claude Code:** edit the status line, which no agent may write to.";
		const call = "gh issue edit 12 --add-label takes:human";
		expect(verdict(call, shared, env({ GH_SHIM_BODY: barred }))).toBe("deny");
		expect(denyReason(call, env({ GH_SHIM_BODY: barred }))).toContain(
			"applies `takes:human` to #12 whose Outside line names a prohibition",
		);
	});

	it.each([
		"gh issue edit 12 --add-label takes:human,urgent",
		"gh issue edit --add-label takes:human 12",
		"gh issue edit https://github.com/o/r/issues/12 --add-label takes:human",
		"gh issue edit 12 --add-label=takes:human",
		"cd /repo && gh issue edit 12 --add-label takes:human > .claude/tmp/x.txt 2>&1; echo $?",
	])("reads the spelling: %s", (call) => {
		expect(verdict(call, shared, env({ GH_SHIM_BODY: "no line" }))).toBe(
			"deny",
		);
	});

	it("judges every number the edit names", () => {
		const e = env({ GH_SHIM_BODY_12: errand, GH_SHIM_BODY_13: "no line" });
		expect(
			verdict("gh issue edit 12 13 --add-label takes:human", shared, e),
		).toBe("deny");
		expect(
			denyReason("gh issue edit 12 13 --add-label takes:human", e),
		).toContain("to #13");
	});

	it("reads an inline --body the same edit writes, and fetches nothing", () => {
		const count = path.join(dir, "calls");
		const e = env({ GH_SHIM_BODY: errand, GH_SHIM_COUNT: count });
		expect(
			verdict(
				'gh issue edit 12 --add-label takes:human --body "cut three lines"',
				shared,
				e,
			),
		).toBe("deny");
		expect(
			verdict(
				`gh issue edit 12 --add-label takes:human --body ${JSON.stringify(errand)}`,
				shared,
				env({ GH_SHIM_BODY: "no line" }),
			),
		).toBe("allow");
		expect(fs.existsSync(count)).toBe(false);
	});

	it.each([
		["any other label", "gh issue edit 12 --add-label takes:implement"],
		["a removal", "gh issue edit 12 --remove-label takes:human"],
		["a title edit", 'gh issue edit 12 --title "x"'],
		["--help", "gh issue edit --help"],
	])("ignores %s", (_, call) => {
		expect(verdict(call, shared, env({ GH_SHIM_BODY: "no line" }))).toBe(
			"allow",
		);
		expect(faults()).toEqual([]);
	});

	// #669
	it.each([
		[
			"a --body-file",
			"gh issue edit 12 --add-label takes:human --body-file notes.md",
		],
		["a -F", "gh issue edit 12 --add-label takes:human -F -"],
		[
			"a --body it cannot read",
			'gh issue edit 12 --add-label takes:human --body "$B"',
		],
		[
			"a -b it cannot read",
			'gh issue edit 12 -b "$(cat x)" --add-label takes:human',
		],
	])(
		"denies a relabel whose body arrives by %s, offering issue-body.js append then the relabel as the way out",
		(_, call) => {
			const e = env({ GH_SHIM_BODY: errand });
			expect(verdict(call, shared, e)).toBe("deny");
			const reason = denyReason(call, e);
			expect(reason).toMatch(/cannot read/);
			expect(reason).toMatch(/issue-body\.js append <n>/);
			expect(reason).toMatch(/gh issue edit <n> --add-label takes:human\n/);
			expect(faults()).toEqual([]);
		},
	);

	it("fetches at most two bodies, and records the third as unchecked", () => {
		const count = path.join(dir, "calls");
		const e = env({ GH_SHIM_BODY: errand, GH_SHIM_COUNT: count });
		expect(
			verdict("gh issue edit 12 13 14 --add-label takes:human", shared, e),
		).toBe("allow");
		expect(fs.readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
		expect(
			faults().filter((f) => /#14 allowed unchecked/.test(f)),
		).toHaveLength(1);
	});

	it.each([
		[
			"gh unreachable",
			"gh issue edit 12 --add-label takes:human",
			{ GH_SHIM_MODE: "fail" },
		],
		[
			"a gh that cannot be found",
			"gh issue edit 12 --add-label takes:human",
			{ WFC_GH: "/dev/null/gh" }, // under a file, so never on disk
		],
		[
			"a number in a variable",
			'gh issue edit "$N" --add-label takes:human',
			{},
		],
	])("fails open, recorded, on %s", (_, call, extra) => {
		expect(
			verdict(call, shared, env({ GH_SHIM_BODY: "no line", ...extra })),
		).toBe("allow");
		expect(
			faults().filter((f) => /relabel allowed unchecked/.test(f)),
		).toHaveLength(1);
	});
});

/* The Close-when limb (#983): presence only, judged after the four
 * Outside-line tests, on create and on relabel; a pass gets a pointer to the
 * founder-deliverable rule. */
describe("the Close-when limb (#983)", () => {
	const noClose = "whose body has no **Close when:** line";
	const act = "**Outside Claude Code:** email the hostel.";
	const create = (body: string) =>
		`gh issue create --title x --label takes:human --body '${body}'`;
	const env = (body: string) => ({
		WFC_GH: path.join(binDir, "gh"),
		GH_SHIM_BODY: body,
	});

	it("denies a create whose body names the act but not what finishes it", () => {
		const call = create(act);
		expect(verdict(call)).toBe("deny");
		const reason = denyReason(call);
		expect(reason).toContain(`creates a \`takes:human\` issue ${noClose}`);
		expect(reason).toContain(DELIVERABLE);
	});

	it("denies a bare marker with nothing after it, on its line or the end", () => {
		expect(verdict(create(`${act}\n**Close when:** `))).toBe("deny");
		expect(verdict(create(`${act}\n**Close when:**\n\nmore text`))).toBe(
			"deny",
		);
	});

	it("judges the Outside line first, so one body earns one refusal", () => {
		const reason = denyReason(create("cut three doc lines"));
		expect(reason).toContain("names no act performed outside Claude Code");
		expect(reason).not.toContain(noClose);
	});

	it("denies a relabel onto a body with no Close-when line, naming the issue", () => {
		writeShim();
		const call = "gh issue edit 12 --add-label takes:human";
		expect(verdict(call, shared, env(act))).toBe("deny");
		expect(denyReason(call, env(act))).toContain(
			`applies \`takes:human\` to #12 ${noClose}`,
		);
	});

	it("points a pass at the founder-deliverable rule", () => {
		expect(POINTER_LEAD).toBeTruthy();
		expect(handover(run(create(`${act}${CLOSE}`)).stdout)).toBe(POINTER);
	});

	// WFC_SCRIPT_ROOT stands in for an install: a root with no package.json.
	it("names the template at the plugin root in an install (#1248)", () => {
		const plugin = fs.mkdtempSync(path.join(os.tmpdir(), "label-plugin-"));
		try {
			const r = run(create(`${act}${CLOSE}`), shared, {
				WFC_SCRIPT_ROOT: plugin,
			});
			expect(r.status).toBe(0);
			expect(handover(r.stdout)).toBe(
				pointer(`${plugin}/scripts/lib/rule-text.sh`),
			);
		} finally {
			fs.rmSync(plugin, { recursive: true, force: true });
		}
	});

	it("leaves every other takes: value without the line alone", () => {
		expect(
			verdict("gh issue create --title x --label takes:implement --body 'x'"),
		).toBe("allow");
	});
});

/* The founder-act limb (#1097): the shell half of takes-label.js's
 * NOT-A-FOUNDER-ACT test, through both routes. */
describe("the founder-act limb (#1097)", () => {
	const refusalPhrase: Record<string, string> = {
		"NO-OUTSIDE-ACT": "names no act performed outside Claude Code",
		"BARRED-NOT-IMPOSSIBLE": "names a prohibition rather than an act",
		"REPO-FILE-ACT": "produces a file in this repository",
		"NOT-A-FOUNDER-ACT": "names none of the founder's own acts",
		"NO-CLOSE-WHEN": "has no **Close when:** line",
	};
	const create = (body: string) =>
		`cat <<'BODY' | gh issue create --title x --label takes:human --body-file -\n${body}\nBODY`;
	const relabel = "gh issue edit 12 --add-label takes:human";
	const env = (body: string) => ({
		WFC_GH: path.join(binDir, "gh"),
		GH_SHIM_BODY: body,
	});
	const libVerdict = (body: string) =>
		outsideLineFault(body)?.fault ??
		(CLOSE_WHEN_LINE.test(body) ? "pass" : "NO-CLOSE-WHEN");

	beforeEach(writeShim);

	it.each(HUMAN_BODIES)("$reason", ({ body, verdict: want }) => {
		expect(libVerdict(body)).toBe(want);
		for (const [call, e] of [
			[create(body), {}],
			[relabel, env(body)],
		] as const) {
			if (want === "pass") {
				expect(verdict(call, shared, e)).toBe("allow");
				continue;
			}
			const reason = denyReason(call, e);
			for (const [tag, said] of Object.entries(refusalPhrase))
				if (tag === want) expect(reason).toContain(said);
				else expect(reason).not.toContain(said);
		}
	});

	it("quotes the act list and names both ways out", () => {
		const body =
			"**Outside Claude Code:** look up the dorm prices on the Bunkward site.\n**Close when:** done";
		for (const [call, e] of [
			[create(body), {}],
			[relabel, env(body)],
		] as const) {
			const reason = denyReason(call, e);
			expect(reason).toContain(`The acts are: ${FOUNDER_ACTS.join("; ")}`);
			expect(reason).toContain("name the act from that list");
			expect(reason).toContain("add a **Tried:** line");
		}
	});

	it.each([
		["names no act", "no line"],
		[
			"names a prohibition",
			"**Outside Claude Code:** edit it, which no agent may do.",
		],
	])("names the list, not the old examples, where the body %s", (_, body) => {
		const reason = denyReason(create(`${body}${CLOSE}`));
		expect(reason).toContain(FOUNDER_ACTS.join("; "));
		expect(reason).not.toContain("click through a third-party dashboard");
		expect(reason).not.toContain("read a setting off your own phone");
	});
});
