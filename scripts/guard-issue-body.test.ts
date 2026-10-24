// @vitest-environment node
/*
 * guard-issue-body.sh denies a raw issue-body write (mantahostels#132), and a deny is only
 * defensible while it cannot wedge sanctioned work. Every allow-case below is a
 * shape that would otherwise be a false positive — `gh issue create --body`,
 * every field-only edit, `gh issue comment` — so do not thin them out.
 *
 * The guard needs no repository: it judges the command form alone. The temp
 * dirs exist only to give the shared-parser
 * fixture somewhere to detach a copy to, and a foreign cwd to run it from.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a deny case and a whole-body `gh issue edit`
 * silently erases a parallel session's edit to the same issue; lose an allow
 * case and filing or commenting on issues is wedged.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog } from "./guard-log-fixture";
import { describeSharedParserLibrary } from "./guard-parse-fixture";

const GUARD = path.resolve(__dirname, "guard-issue-body.sh");

let dir: string;
let config: string;
let shared: string;
let elsewhere: string;

/**
 * Runs the guard on `command`, as Claude Code would. Every run is asserted to
 * exit 0 with a clean stderr:
 * a crashing guard emits no verdict either, so "allow" must mean silence by
 * design rather than by accident (mantahostels#123).
 */
const verdict = (command: string, cwd = shared) => {
	const r = spawnSync(GUARD, [], {
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
			// The guard writes fail-opens to CLAUDE_CONFIG_DIR's project dir. Unset, a
			// test run appends to the founder's own log and manufactures the very
			// records check-guard-errors.js exists to report.
			CLAUDE_CONFIG_DIR: config,
		},
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = r.stdout ?? "";
	if (/"permissionDecision"\s*:\s*"deny"/.test(out)) return "deny";
	if (/"additionalContext"/.test(out)) return "warn";
	expect(out).toBe("");
	return "allow";
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-issue-body-"));
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	elsewhere = path.join(dir, "elsewhere");
	fs.mkdirSync(shared);
	fs.mkdirSync(elsewhere);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a raw body write through gh issue edit is denied", () => {
	it.each([
		['gh issue edit 132 --body "new text"', "the long form"],
		['gh issue edit 132 -b "new text"', "the shorthand"],
		['gh issue edit 132 --body="new text"', "glued to the flag"],
		["gh issue edit 132 --body-file /tmp/body.md", "from a file"],
		["gh issue edit 132 -F /tmp/body.md", "the file shorthand"],
		["gh issue edit 132 --body-file=-", "from stdin, glued"],
		["gh issue edit 132 -F -", "from stdin, shorthand"],
		[
			'gh issue edit 132 --add-label kind:ticket --body "x"',
			"a body flag behind a field-only flag still writes the body",
		],
		[
			'gh issue edit https://github.com/owner/repo/issues/96 --body "x"',
			"addressed by URL rather than number",
		],
		['gh issue edit 96 97 --body "x"', "several issues at once"],
		['gh issue edit 132 -R owner/repo -b "x"', "another repo"],
		['/usr/bin/gh issue edit 132 --body "x"', "an absolute path to gh"],
		['GH_TOKEN=x gh issue edit 132 --body "x"', "behind an env assignment"],
		['npm run check && gh issue edit 132 --body "x"', "later in a chain"],
		['(gh issue edit 132 --body "x")', "inside a subshell"],
		["gh issue edit 132 -bt", "a bundle whose first letter is the body flag"],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): the guard has ONE deny message,
		// pinned by "%s carries the whole rule — %s" below, and only a body-write
		// segment can reach it.
		expect(verdict(command)).toBe("deny");
	});
});

describe("the PATCH spelling of the same write is denied too", () => {
	it.each([
		[
			'gh api --method PATCH repos/owner/repo/issues/96 -f body="new"',
			"the documented spelling",
		],
		["gh api -X PATCH repos/o/r/issues/96 -f body=x", "the -X shorthand"],
		["gh api -XPATCH repos/o/r/issues/96 -f body=x", "-X glued to its value"],
		// pflag strips one leading `=` off a shorthand's value, so both of these
		// reach gh exactly as the un-glued forms above do (mantahostels#2580).
		[
			"gh api -X=PATCH repos/o/r/issues/96 -f body=x",
			"-X joined to its value by an =",
		],
		[
			"gh api --method PATCH repos/o/r/issues/96 -f=body=x",
			"the field joined by an =",
		],
		[
			"gh api -X=PATCH repos/o/r/issues/96 -F=body=x",
			"both shorthands joined by an =",
		],
		// -i is gh api's only boolean shorthand, so it is the one letter that
		// can sit in front of another flag inside a bundle.
		[
			"gh api -iX PATCH repos/o/r/issues/96 -f body=x",
			"the method behind a boolean shorthand",
		],
		[
			"gh api -iXPATCH repos/o/r/issues/96 -f body=x",
			"the method bundled behind -i and glued",
		],
		[
			"gh api -iX=PATCH repos/o/r/issues/96 -f body=x",
			"the method bundled behind -i and joined by an =",
		],
		[
			"gh api -X PATCH repos/o/r/issues/96 -if body=x",
			"the field behind a boolean shorthand",
		],
		[
			"gh api -X PATCH repos/o/r/issues/96 -if=body=x",
			"the field bundled behind -i and joined by an =",
		],
		[
			"gh api repos/o/r/issues/96 --method=PATCH --field body=x",
			"long flags glued, endpoint first",
		],
		["gh api --method PATCH repos/o/r/issues/96 -fbody=x", "the field glued"],
		[
			"gh api --method PATCH repos/o/r/issues/96 --raw-field body=x",
			"the raw-field form",
		],
		[
			"gh api --method patch repos/o/r/issues/96 -f body=x",
			"a lowercase method",
		],
		[
			"gh api --method PATCH /repos/o/r/issues/96 -f body=x",
			"a leading slash on the endpoint",
		],
		[
			"gh api --method PATCH https://api.github.com/repos/o/r/issues/96 -f body=x",
			"the absolute API URL",
		],
		// A value-taking flag before the endpoint must not have its value read as
		// the endpoint: that allows the write through in silence.
		[
			'gh api -H "Accept: application/vnd.github+json" --method PATCH repos/o/r/issues/96 -f body=x',
			"a header first — the shape GitHub's own docs put first",
		],
		[
			"gh api --jq .body --method PATCH repos/o/r/issues/96 -f body=x",
			"a jq query first",
		],
		[
			"gh api -q .body -X PATCH repos/o/r/issues/96 -f body=x",
			"the jq shorthand first",
		],
		[
			"gh api --cache 1h --method PATCH repos/o/r/issues/96 -f body=x",
			"a cache duration first",
		],
		[
			"gh api --hostname github.com --method PATCH repos/o/r/issues/96 -f body=x",
			"a hostname first",
		],
		[
			"gh api --paginate --method PATCH repos/o/r/issues/96 -f body=x",
			"a flag that takes no value does not swallow the endpoint",
		],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): the guard has ONE deny message,
		// pinned by "%s carries the whole rule — %s" below, and only a body-write
		// segment can reach it.
		expect(verdict(command)).toBe("deny");
	});
});

describe("a PATCH at an issue whose fields cannot be read warns", () => {
	// mantahostels#103: deny on a structured fact, warn where the hook is inferring. Here the
	// payload is out of sight, so the guard cannot say whether it touches the body.
	it.each([
		[
			"gh api --method PATCH repos/o/r/issues/96 --input payload.json",
			"the payload is in a file",
		],
		[
			"gh api --method PATCH repos/o/r/issues/96 --input -",
			"the payload is on stdin",
		],
		[
			'gh api --method PATCH repos/o/r/issues/96 -f "body=new"',
			"the whole field is quoted, so the parser has blanked it",
		],
		[
			"gh api --input p.json --method PATCH repos/o/r/issues/96",
			"the payload flag comes before the endpoint",
		],
		[
			'gh api --method "PATCH" repos/o/r/issues/96 -f body=x',
			"the method itself is quoted, so it cannot be read",
		],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("warn");
	});
});

describe("the sanctioned routes are never matched", () => {
	it.each([
		// A body that does not exist yet cannot be clobbered.
		['gh issue create --title t --body "x"', "creating an issue"],
		["gh issue create --title t --body-file body.md", "creating from a file"],
		// A comment is a new resource and reads no existing state.
		['gh issue comment 96 --body "x"', "commenting"],
		["gh issue comment 96 -F -", "commenting from stdin"],
		// Field-only edits are server-side and download no body.
		["gh issue edit 96 --add-assignee @me", "the claim, on every command"],
		["gh issue edit 96 --add-label kind:ticket", "labelling"],
		["gh issue edit 96 --remove-label needs-triage", "unlabelling"],
		['gh issue edit 96 --milestone "v1"', "a milestone"],
		['gh issue edit 96 -m "v1"', "the milestone shorthand"],
		['gh issue edit 96 --title "new title"', "a title"],
		['gh issue edit 96 -t "new title"', "the title shorthand"],
		["gh issue edit 96 -tb", "a bundle whose only letter takes a value"],
		[
			"gh api -X=PATCH repos/o/r/issues/96 -f state=closed",
			"a field-only PATCH, the method joined by an =",
		],
		[
			"gh api -iX=PATCH repos/o/r/issues/96 -f state=closed",
			"a field-only PATCH bundled behind -i",
		],
		// pflag drops ONE separator, so this reaches gh as the method `=PATCH`,
		// which net/http rejects.
		[
			"gh api -X==PATCH repos/o/r/issues/96 -f body=x",
			"a second = is part of the value, not a separator",
		],
		["gh issue edit 96 --add-blocked-by 131", "a dependency edge"],
		["gh issue edit 96 --parent 51", "a parent link"],
		["gh issue close 96", "closing"],
		["gh issue view 96 --comments", "reading"],
		// A different resource, with no helper to route to.
		['gh pr edit 5 --body "x"', "a pull request body"],
		// The permitted path itself.
		[
			'node scripts/issue-body.js append 96 --text "x"',
			"the helper this guard exists to protect",
		],
		// gh api shapes that write no issue body.
		["gh api repos/o/r/issues/96", "a plain GET"],
		[
			"gh api --method PATCH repos/o/r/issues/96 -f state=closed",
			"a visible field-only PATCH",
		],
		[
			"gh api repos/o/r/issues/96 --input fields.json",
			"no method is a POST, not a body write",
		],
		[
			'gh api --method PATCH repos/o/r/issues/96 -f title="New title"',
			"a masked VALUE on a visible non-body field is still not the body",
		],
		["gh api --paginate repos/o/r/issues/96/comments", "paging a comment list"],
		[
			"gh api --method PATCH repos/o/r/issues/comments/12345 -f body=x",
			"a comment body is a different resource",
		],
		[
			"gh api --method POST repos/o/r/issues/96/comments -f body=x",
			"posting a comment",
		],
		[
			"gh api --method POST repos/o/r/issues/132/dependencies/blocked_by -F issue_id=1",
			"wiring a dependency",
		],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("a mention inside a quoted string is not a command", () => {
		expect(verdict('echo "gh issue edit 96 --body x"')).toBe("allow");
		expect(verdict("grep -rn 'gh issue edit --body' docs/")).toBe("allow");
	});

	it("a mention inside a heredoc body is data, not a command", () => {
		expect(
			verdict("cat <<'EOF' > note.md\ngh issue edit 96 --body x\nEOF"),
		).toBe("allow");
	});

	it("<< inside a quoted string does not hide a later write", () => {
		// Otherwise it opens a heredoc that swallows every line after it.
		// exempt (mantahostels#2145): the guard has ONE deny message,
		// pinned by "%s carries the whole rule — %s" below, and only a body-write
		// segment can reach it.
		expect(verdict('echo "a << b"\ngh issue edit 96 --body x')).toBe("deny");
	});

	it("judges the command form, not the cwd it runs in", () => {
		// exempt (mantahostels#2145): the guard has ONE deny message,
		// pinned by "%s carries the whole rule — %s" below, and only a body-write
		// segment can reach it.
		expect(verdict("gh issue edit 96 --body x", elsewhere)).toBe("deny");
		expect(verdict("gh issue comment 96 --body x", elsewhere)).toBe("allow");
	});
});

describe("the graphql spelling of the same write is denied too (mantahostels#284)", () => {
	it.each([
		[
			'gh api graphql -f query=\'mutation { updateIssue(input: {id: "x", body: "y"}) { issue { id } } }\'',
			"the documented spelling",
		],
		[
			"gh api graphql -f query='mutation($id:ID!,$body:String!){updateIssue(input:{id:$id,body:$body}){issue{id}}}' -f id=X -f body=text",
			"the body passed as a GraphQL variable",
		],
		[
			'gh api graphql --raw-field query=\'mutation{updateIssue(input:{id:"x",body:"y"})}\'',
			"the raw-field form",
		],
		[
			'gh api graphql -fquery=\'mutation{updateIssue(input:{id:"x",body:"y"})}\'',
			"the field glued to its flag",
		],
		[
			'gh api --method POST graphql -f query=\'mutation{updateIssue(input:{id:"x",body:"y"})}\'',
			"the method spelled out",
		],
		[
			'gh api https://api.github.com/graphql -f query=\'mutation{updateIssue(input:{id:"x",body:"y"})}\'',
			"the absolute API URL",
		],
		[
			'gh api graphql -f "query=mutation{updateIssue(input:{id:$ID,body:$BODY})}"',
			"a query only partly readable still shows the mutation",
		],
		[
			'npm run check && gh api graphql -f query=\'mutation{updateIssue(input:{id:"x",body:"y"})}\'',
			"later in a chain",
		],
		[
			'gh api graphql -f query=\'mutation { updateIssue(input: {id: "x", body : "y"}) }\'',
			"GraphQL ignores the whitespace round its colons, so the guard must too",
		],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): the guard has ONE deny message,
		// pinned by "%s carries the whole rule — %s" below, and only a body-write
		// segment can reach it.
		expect(verdict(command)).toBe("deny");
	});

	it.each([
		[
			"gh api graphql -F query=@mutation.graphql",
			"the query text is in a file",
		],
		["gh api graphql -f query=@-", "the query text is on stdin"],
		["gh api graphql --input payload.json", "the whole payload is in a file"],
		['gh api graphql -f query="$QUERY"', "the query is in a variable"],
		[
			'gh api graphql -f query="$(cat q.graphql)"',
			"the query comes from a command substitution",
		],
		[
			"gh api graphql -f query='mutation($input:UpdateIssueInput!){updateIssue(input:$input){issue{id}}}' -f input=@vars.json",
			"the whole input object arrives as one variable, so the query names no body",
		],
	])("%s — %s warns", (command) => {
		expect(verdict(command)).toBe("warn");
	});

	it.each([
		[
			'gh api graphql -f query=\'query($n:Int!){repository(owner:"o",name:"r"){issue(number:$n){userContentEdits(first:10){nodes{editedAt diff}}}}}\'',
			"the read query check-clobbered-bodies.js makes",
		],
		[
			'gh api graphql -f query=\'query{repository(owner:"o",name:"r"){issue(number:8){body}}}\'',
			"reading a body is not writing one",
		],
		[
			"gh api graphql -f query='mutation{updateIssue(input:{id:\"x\",state:CLOSED}){issue{id}}}'",
			"a field-only updateIssue writes no body",
		],
		[
			'gh api graphql -f query=\'mutation{addComment(input:{subjectId:"x",body:"y"}){clientMutationId}}\'',
			"a comment body is a different resource",
		],
		[
			"gh api graphql -f query='mutation{updateIssue(input:{id:\"x\",state:CLOSED}){issue{id body}}}'",
			"a body read back in the response is not a body written",
		],
		[
			"gh api graphql -f query='mutation{updateIssue(input:{id:\"x\",state:CLOSED}){issue{body:bodyHTML}}}'",
			"an alias in the response selection carries a colon and is still a read",
		],
	])("%s — %s is allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});
});

describeSharedParserLibrary({
	guard: GUARD,
	denyCommand: "gh issue edit 96 --body x",
	ctx: () => ({ dir, shared, elsewhere }),
});

const payload = (command: string) => ({
	session_id: "test",
	tool_name: "Bash",
	tool_input: { command },
});

describeFailOpenLog({
	guard: GUARD,
	denied: payload("gh issue edit 96 --body x"),
	fieldless: { session_id: "test", tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: payload("gh issue comment 96 --body x"),
	ctx: () => ({ dir, config, project: shared }),
});

/*
 * Keyed by fragment id, never by a literal copied out of the fragment — a
 * second copy is the drift the store exists to prevent.
 */
describe("the relocated rule reaches the session that trips the guard", () => {
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
	const { ruleText } = require("./lib/rule-text") as any;

	/** The refusal `command` earns, as the session reads it. Throws on an allow. */
	const denyReason = (command: string) => {
		const r = spawnSync(GUARD, [], {
			cwd: shared,
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command },
			}),
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: shared,
				CLAUDE_CONFIG_DIR: config,
			},
		});
		if (!r.stdout?.trim()) throw new Error(`expected a deny for: ${command}`);
		return JSON.parse(r.stdout).hookSpecificOutput
			.permissionDecisionReason as string;
	};

	it.each([
		['gh issue edit 132 --body "new text"', "the long form"],
		["gh issue edit 132 --body-file /tmp/body.md", "from a file"],
	])("%s carries the whole rule — %s", (command) => {
		expect(denyReason(command)).toContain(ruleText("issue-body-clobber"));
	});

	it("carries the helper spelling a session needs to comply", () => {
		// The deny is useless without the command that replaces the denied one.
		expect(denyReason('gh issue edit 132 --body "x"')).toContain(
			"node scripts/issue-body.js append-section",
		);
	});

	it("names the routes nothing sees, so a silent pass is not read as safe", () => {
		expect(denyReason('gh issue edit 132 --body "x"')).toContain(
			"check-clobbered-bodies.js",
		);
	});
});
