// @vitest-environment node
/*
 * guard-issue-close.sh denies a close that says nothing about what is still
 * outstanding (mantahostels#185), a hand close of a roadmap card's own issue
 * (mantahostels#220), a completed close over unticked acceptance criteria
 * (#1640), and one over census rows the ticket's commits expired (#1913).
 *
 * A deny is only defensible while it cannot wedge sanctioned work, so every
 * allow-case below is a shape that would otherwise be a false positive — a
 * close that already carries the line, an abandoned issue, a command that
 * merely mentions `gh issue close`. Do not thin them out.
 *
 * `gh` is SHIMMED throughout, so no case depends on the network or on what a
 * live issue says today.
 *
 * Loosen a deny case and an issue closes with its remaining work named
 * nowhere, a card's issue closes past /card-close, or a ticket closes
 * unverified.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog, failOpenLogPath } from "./guard-log-fixture";
import {
	describeSharedParserLibrary,
	requiredLibs,
} from "./guard-parse-fixture";
import { GRAPHQL_FAKE } from "./lib/gh-stub";

const GUARD = path.resolve(__dirname, "guard-issue-close.sh");
const PARSER_LIBS = [
	...new Set([
		...requiredLibs("outstanding-line.js"),
		...requiredLibs("ticket-criteria.js"),
		...requiredLibs("census-digest.js"),
	]),
];

let dir: string;
let config: string;
let shared: string;
let binDir: string;
let elsewhere: string;

/**
 * A `gh` that answers from the environment instead of the network.
 *
 * GH_SHIM_MODE=fail exits non-zero, standing in for an unreachable GitHub — the
 * case the guard must fail open on rather than read as "the line is absent".
 *
 * It serves the whole `--json comments,title,parent,labels,body` payload, because the
 * guard makes ONE request for all three rules (mantahostels#220, #1640).
 * GH_SHIM_ISSUE_BODY is the issue's own body, as against GH_SHIM_BODIES, its
 * newest comment. GH_SHIM_TITLE and GH_SHIM_PARENT default to the shape of an
 * issue that is not a card's own issue.
 */
const writeShim = () => {
	fs.mkdirSync(binDir, { recursive: true });
	const at = path.join(binDir, "gh");
	fs.writeFileSync(
		at,
		[
			"#!/bin/sh",
			'[ -n "$GH_SHIM_COUNT" ] && echo call >>"$GH_SHIM_COUNT"',
			'[ -n "$GH_SHIM_ARGS" ] && echo "$*" >>"$GH_SHIM_ARGS"',
			'if [ "$GH_SHIM_MODE" = fail ]; then exit 1; fi',
			'if [ "$1" = api ]; then exec node "$(dirname "$0")/gql.js" "$@"; fi',
			// Per-issue overrides, keyed on the number in `gh issue view <n>`, so a
			// command closing two issues can be given two different answers.
			'n="$3"',
			'eval "t=\\$GH_SHIM_TITLE_$n"',
			'eval "b=\\$GH_SHIM_BODIES_$n"',
			'eval "p=\\$GH_SHIM_PARENT_$n"',
			'eval "l=\\$GH_SHIM_LABELS_$n"',
			'[ -z "$t" ] && t="$GH_SHIM_TITLE"',
			'[ -z "$b" ] && b="$GH_SHIM_BODIES"',
			'[ -z "$p" ] && p="$GH_SHIM_PARENT"',
			'[ -z "$l" ] && l="$GH_SHIM_LABELS"',
			'jq -nc --arg b "$b" --arg t "$t" --arg l "$l" --arg ib "$GH_SHIM_ISSUE_BODY" \\',
			'  --arg p "$p" --arg o "$GH_SHIM_OLDER" \'{',
			'    comments: ((if $o == "" then [] else [{ body: $o }] end) + [{ body: $b }]),',
			"    title: $t,",
			"    body: $ib,",
			'    labels: ($l | split(" ") | map(select(. != "")) | map({ name: . })),',
			'    parent: (if $p == "" then null else { number: ($p | tonumber) } end)',
			"  }'",
			"",
		].join("\n"),
	);
	fs.chmodSync(at, 0o755);
	fs.writeFileSync(path.join(binDir, "gql.js"), GQL_SHIM);
};

/**
 * The Outstanding-line parser's batched GraphQL read (#984), answered from the
 * environment: every cited number is an open issue unless GH_SHIM_CLOSED or
 * GH_SHIM_MISSING lists it, and GH_SHIM_GQL=fail stands in for an unreachable
 * GitHub on that read alone.
 */
const GQL_SHIM = `${GRAPHQL_FAKE}
if (process.env.GH_SHIM_GQL === "fail") {
	process.stderr.write("error connecting to api.github.com\\n");
	process.exit(1);
}
const list = (v) => (process.env[v] || "").split(" ").filter(Boolean);
process.stdout.write(
	JSON.stringify(answerGraphql(process.argv, list("GH_SHIM_CLOSED"), list("GH_SHIM_MISSING"))),
);
`;

/**
 * A roadmap holding the given cards, in the field order the real file uses. The guard
 * reads `state` out of a bounded window after the id, so the neighbouring
 * fields have to be there for the window to be exercised at all.
 */
const writeRoadmap = (cards: [string, string][]) => {
	const body = cards
		.map(
			([id, state]) =>
				`{id:"${id}",p:0,a:["tech"],kind:"decision",state:"${state}",t:"A card",m:"—",mn:"note"}`,
		)
		.join(",\n");
	fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(shared, "docs", "reference-roadmap.html"),
		`<script>const CARDS=[\n${body}\n];</script>\n`,
	);
};

/* The two framing lines this guard's two refusals open with (mantahostels#2145). Both
 * splice a rule fragment underneath, but different ones, so only the framing
 * line tells a card refusal from an outstanding-line one. */
const OUTSTANDING = "This close does not say what is still outstanding";
const CARD_STILL = "and that card is still";

/** The shim, as the guard takes it: through WFC_GH, never a PATH in front. */
const ghShim = () => path.join(binDir, "gh");

/** Runs the guard on `command`, with the shim env every case here needs. */
const spawnGuard = (
	command: string,
	env: Record<string, string> = {},
	cwd = shared,
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
			WFC_GH: ghShim(),
			CLAUDE_PROJECT_DIR: shared,
			// Unset, a test run appends to the founder's own fail-open log and
			// manufactures the very records check-guard-errors.js exists to report.
			CLAUDE_CONFIG_DIR: config,
			GH_SHIM_MODE: "ok",
			GH_SHIM_BODIES: "a resolution comment with no disposition line",
			GH_SHIM_TITLE: "An issue carrying no card-id prefix at all",
			GH_SHIM_PARENT: "",
			GH_SHIM_LABELS: "",
			...env,
		},
	});

/** The refusal `command` earns, as the session reads it. Throws on an allow. */
const denyReason = (command: string, env: Record<string, string> = {}) => {
	const r = spawnGuard(command, env);
	if (!r.stdout?.trim()) throw new Error(`expected a deny for: ${command}`);
	return JSON.parse(r.stdout).hookSpecificOutput
		.permissionDecisionReason as string;
};

const verdict = (
	command: string,
	env: Record<string, string> = {},
	cwd = shared,
) => {
	const r = spawnGuard(command, env, cwd);
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	// A crashing guard emits no verdict either, so "allow" must mean silence by
	// design rather than by accident (mantahostels#123).
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = r.stdout ?? "";
	if (/"permissionDecision"\s*:\s*"deny"/.test(out)) return "deny";
	expect(out).toBe("");
	return "allow";
};

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
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-issue-close-"));
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	binDir = path.join(dir, "bin");
	elsewhere = path.join(dir, "elsewhere");
	fs.mkdirSync(shared);
	fs.mkdirSync(elsewhere);
	// The tracker a bare `#N` on an Outstanding line resolves to.
	fs.mkdirSync(path.join(shared, ".claude"));
	fs.writeFileSync(
		path.join(shared, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, tracker: "acme/tracker" }),
	);
	writeShim();
});

describe("the close it denies", () => {
	it("denies a close whose issue carries no Outstanding line", () => {
		// exempt (mantahostels#2145): this refusal's text is pinned by "the outstanding-line
		// refusal carries the whole rule".
		expect(verdict("gh issue close 12")).toBe("deny");
	});

	it("denies it however the number is spelled and wherever the flags sit", () => {
		// `--comment "…"` is blanked to a sentinel by the shared parser before this
		// guard sees it, so a scanner that did not skip the flag's VALUE would read
		// the sentinel as the issue number and fail open on a judgeable command.
		// exempt (mantahostels#2145): pinned by "the outstanding-line refusal carries the whole
		// rule" — the same refusal, reached by other spellings of the number.
		expect(verdict('gh issue close --comment "done" 12')).toBe("deny");
		// `#12` is judged QUOTED: gh reads a quoted "#12" as issue 12. Unquoted,
		// bash reads `#12` as a comment, so the close has no argument and gh
		// closes nothing — that one is allowed, in the test below (#547).
		expect(verdict('gh issue close "#12"')).toBe("deny");
		expect(verdict("gh issue close '#12'")).toBe("deny");
		expect(verdict("gh issue close \\#12")).toBe("deny");
		expect(verdict('gh issue close "12"')).toBe("deny");
		expect(verdict("gh issue close 12 --repo owner/repo")).toBe("deny");
	});

	it("denies a close hidden behind a chain or a subshell", () => {
		// exempt (mantahostels#2145): pinned by "the outstanding-line refusal carries the whole
		// rule"; nothing but a `gh issue close` segment can reach a deny here.
		expect(verdict("npm run test && gh issue close 12")).toBe("deny");
		expect(verdict("(gh issue close 12)")).toBe("deny");
	});

	it("names the marker in the refusal, so the fix needs no other document", () => {
		const r = spawnSync(GUARD, [], {
			cwd: shared,
			encoding: "utf8",
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "gh issue close 12" },
			}),
			env: {
				...process.env,
				WFC_GH: ghShim(),
				CLAUDE_PROJECT_DIR: shared,
				CLAUDE_CONFIG_DIR: config,
				GH_SHIM_MODE: "ok",
				GH_SHIM_BODIES: "no line here",
			},
		});
		expect(r.stdout).toContain("**Outstanding:**");
		expect(r.stdout).toContain(
			"node scripts/resolve-ticket.js <n> --comment-file <file>",
		);
		// #1765: the other lines resolve-ticket refuses a comment without.
		for (const line of [
			"**Bound:**",
			"**Values:**",
			"**Practice:**",
			"**Door:**",
		])
			expect(r.stdout).toContain(line);
	});
});

describe("the closes it allows", () => {
	it("allows a close whose own --comment carries the line", () => {
		expect(
			verdict(
				'gh issue close 12 --comment "All fixed.\n**Outstanding:** none."',
			),
		).toBe("allow");
	});

	it("allows a close whose newest comment cites open issues for what is left", () => {
		const args = path.join(dir, "gh-args");
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_ARGS: args,
				GH_SHIM_BODIES:
					"## Resolution\n**Outstanding:** #181 (log rotation), other#182 (the bare-commit warn)\nmore prose",
			}),
		).toBe("allow");
		const query = fs.readFileSync(args, "utf8");
		expect(query).toContain('owner: "acme", name: "tracker"');
		expect(query).toContain('owner: "acme", name: "other"');
		expect(faults()).toEqual([]);
	});
	it("allows an issue abandoned as not planned — nothing was owed", () => {
		expect(verdict('gh issue close 12 --reason "not planned"')).toBe("allow");
		expect(verdict("gh issue close 12 --reason not-planned")).toBe("allow");
	});

	it("still judges a close that names a reason of completed", () => {
		// The not-planned skip reads the --reason value, so a guard that
		// skipped on the FLAG alone would hand every session a one-word escape.
		// exempt (mantahostels#2145): pinned by "the outstanding-line refusal carries the whole
		// rule".
		expect(verdict('gh issue close 12 --reason "completed"')).toBe("deny");
	});

	it("says nothing about any other gh subcommand", () => {
		expect(verdict('gh issue comment 12 --body "hello"')).toBe("allow");
		expect(verdict("gh issue view 12")).toBe("allow");
		expect(verdict("gh pr close 12")).toBe("allow");
	});

	it("says nothing about a command that merely mentions a close", () => {
		expect(verdict('grep -r "gh issue close" docs/')).toBe("allow");
		expect(verdict('echo "run gh issue close 12 when done"')).toBe("allow");
	});

	it("says nothing about an ordinary command", () => {
		expect(verdict("git status")).toBe("allow");
	});
});

// #984
describe("the Outstanding line it reads", () => {
	it("refuses a reason beside `none`, teaching the shape", () => {
		const command =
			'gh issue close 12 --comment "**Outstanding:** none — but the founder must check the dashboard"';
		expect(verdict(command)).toBe("deny");
		const reason = denyReason(command);
		expect(reason).toContain(OUTSTANDING);
		expect(reason).toContain("`none` stands alone");
		expect(reason).toContain("Read: this close's own --comment");
		expect(reason).toContain("`**Outstanding:** none`, or");
	});

	it("refuses a carrier that is closed, missing, or the issue being closed, naming the carrier", () => {
		const line = (items: string) => ({
			GH_SHIM_BODIES: `**Outstanding:** ${items}`,
		});
		expect(
			denyReason("gh issue close 12", {
				...line("#181 (log rotation)"),
				GH_SHIM_CLOSED: "181",
			}),
		).toContain("acme/tracker#181 is closed");
		expect(
			denyReason("gh issue close 12", {
				...line("#181 (log rotation)"),
				GH_SHIM_MISSING: "181",
			}),
		).toContain("acme/tracker#181 does not exist");
		expect(
			denyReason("gh issue close 12", line("#12 (the rest of this)")),
		).toContain("acme/tracker#12 is the issue in hand");
	});

	it("reads the newest comment only, so a stale marker above it does not count", () => {
		const env = {
			GH_SHIM_OLDER: "Progress so far.\n**Outstanding:** none",
			GH_SHIM_BODIES: "Closing now — all done.",
		};
		expect(verdict("gh issue close 12", env)).toBe("deny");
		expect(denyReason("gh issue close 12", env)).toContain(
			"#12's newest comment",
		);
	});

	it("reads the close's own --comment ahead of the issue's", () => {
		expect(
			verdict('gh issue close 12 --comment "**Outstanding:** none — fine"', {
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("deny");
		// A --comment with no marker line leaves the issue's newest comment to
		// judge — one naming the marker mid-sentence included.
		for (const said of ["Closing.", "Closing per the **Outstanding:** rule."])
			expect(
				verdict(`gh issue close 12 --comment "${said}"`, {
					GH_SHIM_BODIES: "**Outstanding:** none",
				}),
				said,
			).toBe("allow");
	});

	it("reads the issue's newest comment where the --comment's only marker sits in a fence, as the parser does (#1247)", () => {
		const fenced =
			'gh issue close 12 --comment "The form:\n~~~\n**Outstanding:** none\n~~~"';
		expect(verdict(fenced, { GH_SHIM_BODIES: "**Outstanding:** none" })).toBe(
			"allow",
		);
		expect(
			denyReason(fenced, { GH_SHIM_BODIES: "Closing now — all done." }),
		).toContain("#12's newest comment");
	});

	it("allows and records a close whose carriers GitHub could not be asked about", () => {
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_BODIES: "**Outstanding:** #181 (log rotation)",
				GH_SHIM_GQL: "fail",
			}),
		).toBe("allow");
		expect(faults().join("\n")).toMatch(
			/Outstanding open-check on #12: .*shape check only/,
		);
	});

	it("still refuses a shape miss while GitHub is unreachable", () => {
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_BODIES: "**Outstanding:** #181 and #182 are left",
				GH_SHIM_GQL: "fail",
			}),
		).toBe("deny");
	});

	it("allows and records a --comment it cannot read, never judging the newest comment in its place (#990)", () => {
		const env = { GH_SHIM_BODIES: "Closing now — all done." };
		for (const comment of ["**Outstanding:** $LEFT", "$(cat close.md)"]) {
			fs.rmSync(failOpenLogPath(config, shared), { force: true });
			expect(
				verdict(`gh issue close 12 --comment "${comment}"`, env),
				comment,
			).toBe("allow");
			expect(faults().join("\n"), comment).toMatch(
				/could not read the --comment of a gh issue close on #12/,
			);
		}
		expect(verdict('gh issue close 12 --comment "Closing now."', env)).toBe(
			"deny",
		);
		expect(
			verdict(
				'gh issue close 5 --comment "$(cat close.md)"; gh issue close 12',
				env,
			),
		).toBe("deny");
	});
});

/*
 * The second rule (mantahostels#220). A card's own issue is closed by /card-close, which
 * closes it as its LAST step, after the card is already `done` — so these cases
 * are about a hand close arriving before that.
 */
describe("the card's issue it refuses to close by hand", () => {
	// A card's own issue: the `<card-id> — <title>` prefix, and no parent.
	const cardIssue = (state: string, extra: Record<string, string> = {}) => {
		writeRoadmap([["id-match", state]]);
		return verdict("gh issue close 12", {
			GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
			GH_SHIM_PARENT: "",
			...extra,
		});
	};

	/** The refusal the cardIssue() call just made earned, against the same tree. */
	const cardReason = (extra: Record<string, string> = {}) =>
		denyReason("gh issue close 12", {
			GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
			GH_SHIM_PARENT: "",
			...extra,
		});

	it("denies a close while the card is still active", () => {
		expect(cardIssue("active")).toBe("deny");
		// cardIssue() supplies no Outstanding line, so the OTHER rule would deny
		// this too — only the framing line says which one did.
		expect(cardReason()).toContain(CARD_STILL);
	});

	it("denies it for every state that is not done", () => {
		expect(cardIssue("open")).toBe("deny");
		expect(cardReason()).toContain("still `open`");
		expect(cardIssue("parked")).toBe("deny");
		expect(cardReason()).toContain("still `parked`");
	});

	it("denies even when the close already says what is outstanding", () => {
		// The card rule runs first deliberately: /card-close writes the Outstanding
		// line itself, so answering the other rule here would send the session to
		// perfect a close it should not be making at all.
		// exempt (mantahostels#2145): with the Outstanding line supplied only the card rule can
		// fire, and its text is pinned by "the card refusal carries the whole rule,
		// and still names the card".
		expect(
			cardIssue("active", {
				GH_SHIM_BODIES: "## Resolution\n**Outstanding:** none",
			}),
		).toBe("deny");
	});

	it("allows the close once the card is done — /card-close's own last step", () => {
		// The Outstanding line is supplied because the FIRST rule still applies to
		// a card issue. Both rules bind /card-close's own step 8, which writes
		// that line itself (mantahostels#281) — see the step-8 cases below.
		expect(cardIssue("done", { GH_SHIM_BODIES: "**Outstanding:** none" })).toBe(
			"allow",
		);
	});

	it("allows a child ticket that merely inherited the card's id (mantahostels#275)", () => {
		// A parent is what tells a child from the card's own issue.
		expect(
			cardIssue("active", {
				GH_SHIM_PARENT: "145",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("allow");
	});

	it("allows a wayfinder map that borrowed the card's id (mantahostels#1490)", () => {
		// A map is unparented exactly as a card's own issue is, so the parent test
		// cannot tell them apart and every card-prefixed map read as a card issue.
		// A map is the question the card answers, never the card's own issue.
		expect(
			cardIssue("active", {
				GH_SHIM_LABELS: "takes:children wayfinder:map",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("allow");
	});

	it("still denies a card issue carrying some other wayfinder label", () => {
		// The exemption is `wayfinder:map` alone — mantahostels#275 measured the label FAMILY
		// and rejected it, and this does not reopen that.
		// exempt (mantahostels#2145): the Outstanding line is supplied, so only the card rule
		// can fire; its text is pinned by "the card refusal carries the whole rule,
		// and still names the card".
		expect(
			cardIssue("active", {
				GH_SHIM_LABELS: "wayfinder:task",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("deny");
	});

	it("still demands an Outstanding line from an exempted map", () => {
		// The exemption lifts the card rule only. The first rule binds every close.
		expect(
			cardIssue("active", {
				GH_SHIM_LABELS: "wayfinder:map",
				GH_SHIM_BODIES: "a resolution comment with no disposition line",
			}),
		).toBe("deny");
		// And it is the Outstanding refusal, not the card one the exemption lifted.
		expect(cardReason({ GH_SHIM_LABELS: "wayfinder:map" })).toContain(
			OUTSTANDING,
		);
	});

	it("says nothing about an issue whose title carries no card id", () => {
		writeRoadmap([["id-match", "active"]]);
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_TITLE: "Some issue that was never a card",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("allow");
	});

	it("allows a card issue abandoned as not planned", () => {
		writeRoadmap([["id-match", "active"]]);
		expect(
			verdict('gh issue close 12 --reason "not planned"', {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
			}),
		).toBe("allow");
	});

	it("names /card-close and the issue number in the refusal", () => {
		writeRoadmap([["id-match", "active"]]);
		const r = spawnSync(GUARD, [], {
			cwd: shared,
			encoding: "utf8",
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "gh issue close 12" },
			}),
			env: {
				...process.env,
				WFC_GH: ghShim(),
				CLAUDE_PROJECT_DIR: shared,
				CLAUDE_CONFIG_DIR: config,
				GH_SHIM_MODE: "ok",
				GH_SHIM_BODIES: "no line here",
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
				GH_SHIM_PARENT: "",
			},
		});
		expect(r.stdout).toContain("/card-close 12");
		expect(r.stdout).toContain("id-match");
		expect(r.stdout).toContain("active");
	});

	it("judges each issue in a chain against its own payload", () => {
		// One tool call can close two issues, and judge() runs per segment in one
		// process. A payload cached without its issue number lets the first close
		// answer for the second: mantahostels#12 allows on its Outstanding line, then mantahostels#34 — a
		// card issue with an active card — is read as mantahostels#12 and allowed too.
		writeRoadmap([["id-match", "active"]]);
		const chain = "gh issue close 12 && gh issue close 34";
		const payloads = {
			GH_SHIM_TITLE_12: "An issue carrying no card-id prefix at all",
			GH_SHIM_BODIES_12: "**Outstanding:** none",
			GH_SHIM_TITLE_34: "id-match — Build the hostel ID-matching layer",
			GH_SHIM_BODIES_34: "**Outstanding:** none",
		};
		expect(verdict(chain, payloads)).toBe("deny");
		// Both closes carry an Outstanding line, so the refusal must be mantahostels#34's card
		// one — and it must name mantahostels#34, not the mantahostels#12 it was cached against.
		expect(denyReason(chain, payloads)).toContain("/card-close 34");
	});

	it("asks GitHub once, not once per rule", () => {
		writeRoadmap([["id-match", "done"]]);
		const counter = path.join(dir, "gh-calls");
		verdict("gh issue close 12", {
			GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
			GH_SHIM_BODIES: "**Outstanding:** none",
			GH_SHIM_COUNT: counter,
		});
		expect(fs.readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
	});
});

/*
 * #1640: the criteria refusal resolve-ticket.js makes, held on the hand
 * spelling too and keyed on the criteria section rather than `kind:ticket`.
 */
describe("the acceptance criteria it reads", () => {
	const outstandingNone = { GH_SHIM_BODIES: "Done.\n**Outstanding:** none." };
	const unmetBody =
		"## Acceptance criteria\n\n- [x] the part that was done\n- [ ] the part that was not\n\n## Out of scope\n\n- [ ] not a criterion\n";

	it("denies a criteria-bearing issue with no kind:ticket, naming each unmet criterion", () => {
		const reason = denyReason("gh issue close 12", {
			...outstandingNone,
			GH_SHIM_LABELS: "takes:implement wayfinder:task",
			GH_SHIM_ISSUE_BODY: unmetBody,
		});
		expect(reason).toContain("This closes #12 over acceptance criteria");
		expect(reason).toContain("  - [ ] the part that was not");
		expect(reason).not.toContain("the part that was done");
		expect(reason).not.toContain("not a criterion");
		expect(faults()).toEqual([]);
	});

	it("denies a criteria heading spaced with a tab, as the library reads it", () => {
		expect(
			denyReason("gh issue close 12", {
				...outstandingNone,
				GH_SHIM_ISSUE_BODY: "## Acceptance\tcriteria\n\n- [ ] still open\n",
			}),
		).toContain("  - [ ] still open");
	});

	it("denies a bare Acceptance heading's unmet criteria (#2481)", () => {
		expect(
			denyReason("gh issue close 12", {
				...outstandingNone,
				GH_SHIM_ISSUE_BODY: "## Acceptance\n\n- [ ] still open\n",
			}),
		).toContain("  - [ ] still open");
	});

	it("judges a completed close whose --comment merely mentions not planned", () => {
		expect(
			denyReason(
				'gh issue close 12 --reason completed --comment "the rest was not planned. **Outstanding:** none."',
				{ GH_SHIM_ISSUE_BODY: unmetBody },
			),
		).toContain("  - [ ] the part that was not");
	});

	it("refuses before the Outstanding rule where both apply", () => {
		const reason = denyReason("gh issue close 12", {
			GH_SHIM_ISSUE_BODY: unmetBody,
		});
		expect(reason).toContain("acceptance criteria neither ticked nor waived");
		expect(reason).not.toContain(OUTSTANDING);
	});

	it("allows an issue whose every criterion is ticked or waived", () => {
		expect(
			verdict("gh issue close 12", {
				...outstandingNone,
				GH_SHIM_ISSUE_BODY:
					"## Acceptance criteria\n\n- [x] done\n- [ ] dropped **waived:** out of reach\n",
			}),
		).toBe("allow");
		expect(faults()).toEqual([]);
	});

	it("allows an issue with no criteria section", () => {
		expect(
			verdict("gh issue close 12", {
				...outstandingNone,
				GH_SHIM_ISSUE_BODY:
					"## What to build\n\n- [ ] a list that is not criteria\n",
			}),
		).toBe("allow");
	});

	it("records an unread issue once, where its own --comment spares the Outstanding fetch", () => {
		expect(
			verdict('gh issue close 12 --comment "**Outstanding:** none."', {
				GH_SHIM_MODE: "fail",
			}),
		).toBe("allow");
		expect(faults()).toEqual([
			"could not read #12 — acceptance criteria unchecked",
		]);
	});

	it("allows a not-planned close over unmet criteria", () => {
		expect(
			verdict('gh issue close 12 --reason "not planned"', {
				GH_SHIM_ISSUE_BODY: unmetBody,
			}),
		).toBe("allow");
	});

	it("fails open, recorded, where the criteria reader gives no verdict", () => {
		const fake = path.join(dir, "node");
		fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		expect(
			verdict('gh issue close 12 --comment "**Outstanding:** none."', {
				GH_SHIM_ISSUE_BODY: unmetBody,
				WFC_NODE: fake,
			}),
		).toBe("allow");
		expect(faults()).toContainEqual(
			expect.stringContaining("the criteria reader gave no verdict"),
		);
	});
});

/*
 * #1913: the census refusal resolve-ticket.js makes (#1876), held on the hand
 * spelling too.
 */
describe("the census rows it reads", () => {
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
	const { digestOf } = require("./lib/census-digest") as any;
	const guardRel = "scripts/guard-one.sh";
	const outstandingNone = { GH_SHIM_BODIES: "Done.\n**Outstanding:** none." };

	const git = (...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", ...args],
			{
				cwd: shared,
			},
		);
	const commit = (body: string, message: string) => {
		fs.writeFileSync(path.join(shared, guardRel), body);
		git("add", "-A");
		git("commit", "-qm", message);
	};
	const reword = () =>
		commit("#!/bin/sh\necho rule one, reworded\n", "Reword the guard (#12)");

	beforeEach(() => {
		git("init", "-q");
		fs.mkdirSync(path.join(shared, "scripts"));
		commit("#!/bin/sh\necho rule one\n", "seed");
		fs.writeFileSync(
			path.join(shared, "scripts/instruction-surface-anchors.json"),
			JSON.stringify({
				guards: { [guardRel]: { digest: digestOf(shared, guardRel) } },
			}),
		);
		git("add", "-A");
		git("commit", "-qm", "anchor");
	});

	it("denies a close whose commit expired an un-re-anchored row, naming it and the escape", () => {
		reword();
		const reason = denyReason("gh issue close 12", outstandingNone);
		expect(reason).toContain(
			"This close leaves census rows its commits expired",
		);
		expect(reason).toContain(`  ${guardRel}\n`);
		expect(reason).toContain(`--rebaseline --only ${guardRel}`);
		expect(reason).toContain("**Census:**");
		expect(reason).toContain('--reason "not planned"');
		expect(faults()).toEqual([]);
	});

	it("allows a close whose --comment carries a Census line", () => {
		reword();
		expect(
			verdict(
				'gh issue close 12 --comment "**Census:** re-measured under #13."',
				outstandingNone,
			),
		).toBe("allow");
	});

	it("allows a close whose newest comment carries a Census line", () => {
		reword();
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_BODIES:
					"Done.\n**Census:** re-measured under #13.\n**Outstanding:** none.",
			}),
		).toBe("allow");
	});

	it("allows a close whose commit only cut comments, or cited another tracker", () => {
		commit("#!/bin/sh\n# why\necho rule one\n", "Explain the guard (#12)");
		commit("#!/bin/sh\necho rule two\n", "Reword the guard (gadgets#12)");
		expect(verdict("gh issue close 12", outstandingNone)).toBe("allow");
		expect(faults()).toEqual([]);
	});

	it("allows a close naming another repo, whose #12 these commits do not cite", () => {
		reword();
		expect(
			verdict("gh issue close 12 --repo other/repo", outstandingNone),
		).toBe("allow");
	});

	it("allows a not-planned close over an expired row", () => {
		reword();
		expect(verdict('gh issue close 12 --reason "not planned"')).toBe("allow");
	});

	it("fails open, recorded, where the census read runs out of the budget", () => {
		reword();
		const shim = path.join(dir, "timeout");
		const real = execFileSync("sh", ["-c", "command -v timeout"], {
			encoding: "utf8",
		}).trim();
		fs.writeFileSync(
			shim,
			`#!/bin/sh\ncase "$*" in *census-digest.js*) exit 124 ;; esac\nexec ${real} "$@"\n`,
		);
		fs.chmodSync(shim, 0o755);
		expect(
			verdict("gh issue close 12", {
				...outstandingNone,
				WFC_TIMEOUT: shim,
			}),
		).toBe("allow");
		expect(faults()).toEqual([
			"the census reader ran out of the guard's time budget on #12 — census rows unchecked",
		]);
	});
});

/*
 * #553: a close naming another repo was judged by THIS repo's issue of the same
 * number — a deny or an allow on the wrong issue.
 */
describe("the repo a close names", () => {
	/** The verdict, and each `gh` call the guard made as its argv joined by spaces. */
	const asked = (command: string, env: Record<string, string> = {}) => {
		const at = path.join(dir, "gh-args");
		fs.rmSync(at, { force: true });
		const said = verdict(command, { ...env, GH_SHIM_ARGS: at });
		const calls = fs.existsSync(at)
			? fs.readFileSync(at, "utf8").trim().split("\n")
			: [];
		return { said, calls };
	};

	const writeTracker = (tracker: string) => {
		fs.mkdirSync(path.join(shared, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(shared, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, tracker }),
		);
	};

	it("asks GitHub for the issue on the repo the close names", () => {
		for (const command of [
			"gh issue close 12 --repo owner/other",
			"gh issue close -R owner/other 12",
			"gh issue close 12 --repo=owner/other",
			'gh issue close 12 --repo "owner/other"',
			"gh issue close 12 -R'owner/other'",
		]) {
			const { said, calls } = asked(command);
			expect(said, command).toBe("deny");
			expect(calls, command).toHaveLength(1);
			expect(calls[0], command).toMatch(
				/^issue view 12 .*--repo owner\/other$/,
			);
		}
	});

	it("names no repo where the close names none", () => {
		const { said, calls } = asked("gh issue close 12");
		expect(said).toBe("deny");
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toContain("--repo");
	});

	it("asks again for the same number on another repo", () => {
		// The payload cache is keyed on the issue; keyed on the number alone, the
		// second close would be answered from the first repo's issue. The line is
		// supplied so the first close allows and the walk reaches the second.
		const { said, calls } = asked(
			"gh issue close 12 --repo owner/other && gh issue close 12",
			{ GH_SHIM_BODIES: "**Outstanding:** none" },
		);
		expect(said).toBe("allow");
		expect(calls).toHaveLength(2);
		expect(calls[1]).not.toContain("--repo");
	});

	it("allows and records a close whose repo it cannot read", () => {
		for (const command of [
			'gh issue close 12 --repo "$REPO"',
			"gh issue close 12 --repo $REPO",
			"gh issue close 12 --repo=$(cat repo)",
		]) {
			fs.rmSync(failOpenLogPath(config, shared), { force: true });
			const { said, calls } = asked(command);
			expect(said, command).toBe("allow");
			expect(calls, command).toEqual([]);
			expect(faults().join("\n"), command).toMatch(
				/could not read the --repo value .* close allowed unchecked/,
			);
		}
	});

	describe("and the card rule", () => {
		// A card's own issue, its card still active, the Outstanding line supplied:
		// only the card rule can refuse.
		const cardClose = (command: string) => {
			writeRoadmap([["id-match", "active"]]);
			return asked(command, {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}).said;
		};

		it("stands down for an issue on a repo other than the tracker", () => {
			// This roadmap's cards and /card-close belong to the tracker, so its
			// refusal would send the session to close the tracker's #12 instead.
			writeTracker("lucmoseley/workflow-core");
			expect(cardClose("gh issue close 12 --repo owner/other")).toBe("allow");
		});

		it("still refuses the tracker's own issue, however the repo is spelled", () => {
			// exempt (mantahostels#2145): the Outstanding line is supplied, so only the card
			// rule can fire; its text is pinned by "the card refusal carries the
			// whole rule, and still names the card".
			writeTracker("lucmoseley/workflow-core");
			for (const command of [
				"gh issue close 12 --repo lucmoseley/workflow-core",
				"gh issue close 12 -R LucMoseley/Workflow-Core",
				"gh issue close 12 --repo github.com/lucmoseley/workflow-core",
				"gh issue close 12 --repo https://github.com/lucmoseley/workflow-core.git",
				"gh issue close 12 --repo git@github.com:lucmoseley/workflow-core.git",
			]) {
				expect(cardClose(command), command).toBe("deny");
			}
		});

		it("still refuses where no tracker can be read", () => {
			// exempt (mantahostels#2145): as above, only the card rule can fire.
			fs.rmSync(path.join(shared, ".claude", "workflow-core.json"));
			expect(cardClose("gh issue close 12 --repo owner/other")).toBe("deny");
		});

		it("reads an undeclared tracker off the origin remote (#1481)", () => {
			fs.writeFileSync(
				path.join(shared, ".claude", "workflow-core.json"),
				JSON.stringify({ contract: 1 }),
			);
			for (const args of [
				["init", "-q"],
				["remote", "add", "origin", "git@github.com:acme/tracker.git"],
			])
				spawnSync("git", ["-C", shared, ...args]);
			expect(cardClose("gh issue close 12 --repo owner/other")).toBe("allow");
			expect(cardClose("gh issue close 12 --repo acme/tracker")).toBe("deny");
		});
	});
});

/*
 * These read the REAL skill file rather than a copy of its close, so step
 * 8's Outstanding line (mantahostels#281) is tested where it lives: a fix that
 * lives in prose is only worth anything while the prose still says it.
 */
describe("the close /card-close itself runs (mantahostels#281)", () => {
	/** The bash of step 8, as written, with the issue number substituted in. */
	const stepEightClose = () => {
		const md = fs.readFileSync(
			path.resolve(
				__dirname,
				"..",
				".claude",
				"skills",
				"card-close",
				"SKILL.md",
			),
			"utf8",
		);
		const step = md.split(/^### 8\. /m)[1];
		if (!step) throw new Error("card-close/SKILL.md has no step 8");
		const block = step.match(/```bash\n([\s\S]*?)```/);
		if (!block) throw new Error("step 8 of card-close/SKILL.md runs no bash");
		return block[1].trim().replaceAll("$ARGUMENTS", "12");
	};

	// The state step 8 actually meets: the card was marked done in step 4, and
	// nothing before it has posted a comment carrying the line.
	const atStepEight = (command: string) => {
		writeRoadmap([["id-match", "done"]]);
		return verdict(command, {
			GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
			GH_SHIM_PARENT: "",
			GH_SHIM_BODIES: "an issue with no resolution comment on it yet",
		});
	};

	it("passes the guard as the skill file writes it", () => {
		expect(atStepEight(stepEightClose())).toBe("allow");
	});

	it("passes on the line it carries, not on anything already on the issue", () => {
		// Strip the disposition line back out and the same close is refused.
		const stripped = stepEightClose().replace(
			/\n+\*\*Outstanding:\*\*[^"]*/,
			"",
		);
		expect(stripped).not.toContain("**Outstanding:**");
		expect(atStepEight(stripped)).toBe("deny");
		// The card is `done` here, so only the Outstanding rule can be refusing.
		expect(
			denyReason(stripped, {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
				GH_SHIM_PARENT: "",
				GH_SHIM_BODIES: "an issue with no resolution comment on it yet",
			}),
		).toContain(OUTSTANDING);
	});
});

describe("the card checks it cannot make", () => {
	it("records the card unchecked when the roadmap is unreadable", () => {
		// No roadmap written at all. mantahostels#220 asked for this to be loud rather than a
		// silent allow.
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("allow");
		expect(faults().join("\n")).toMatch(
			/could not read the roadmap.*card state unchecked/,
		);
	});

	it("still reaches the Outstanding verdict when the card was unchecked", () => {
		// gl_log, not gl_open: an unreadable roadmap says nothing about comments.
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
			}),
		).toBe("deny");
		// The verdict this test names, not the card one it could not check.
		expect(
			denyReason("gh issue close 12", {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
			}),
		).toContain(OUTSTANDING);
	});

	it("records a card id the roadmap does not hold exactly once", () => {
		writeRoadmap([["other-card", "active"]]);
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("allow");
		expect(faults().join("\n")).toMatch(/id-match names 0 cards/);

		writeRoadmap([
			["id-match", "active"],
			["id-match", "done"],
		]);
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("allow");
		expect(faults().join("\n")).toMatch(/id-match names 2 cards/);
	});

	it("records a title that looks like a card id it will not parse", () => {
		// The guard's regex is stricter than check-issue-card-drift.js's, which
		// takes capitals, dots and an en dash. A title in the gap is allowed, so it
		// is recorded rather than passing as "not a card at all".
		writeRoadmap([["id-match", "active"]]);
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_TITLE: "Id-Match – Build the hostel ID-matching layer",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("allow");
		expect(faults().join("\n")).toMatch(/looks like a card id/);
	});

	it("records one fault, not two, when GitHub is unreachable", () => {
		// Both rules read the same payload, so one outage must leave one line —
		// check-guard-errors.js reports these under `npm run status`.
		verdict("gh issue close 12", { GH_SHIM_MODE: "fail" });
		expect(faults()).toHaveLength(1);
	});

	it("counts two cards sharing an id even on one line", () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(shared, "docs", "reference-roadmap.html"),
			'<script>const CARDS=[{id:"id-match",state:"active"},{id:"id-match",state:"done"}];</script>',
		);
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("allow");
		expect(faults().join("\n")).toMatch(/id-match names 2 cards/);
	});

	it("records a card whose state it cannot read", () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(shared, "docs", "reference-roadmap.html"),
			'<script>const CARDS=[{id:"id-match",t:"no state field here"}];</script>',
		);
		expect(
			verdict("gh issue close 12", {
				GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
				GH_SHIM_BODIES: "**Outstanding:** none",
			}),
		).toBe("allow");
		expect(faults().join("\n")).toMatch(/no readable state/);
	});
});

describe("the fail-opens it records", () => {
	it("allows and records a close it cannot ask GitHub about", () => {
		expect(verdict("gh issue close 12", { GH_SHIM_MODE: "fail" })).toBe(
			"allow",
		);
		expect(faults().join("\n")).toMatch(
			/could not read comments on #12 — close allowed unchecked/,
		);
	});

	it("allows and records a close when the gh WFC_GH names is missing", () => {
		fs.rmSync(ghShim());
		const r = spawnSync(GUARD, [], {
			cwd: shared,
			encoding: "utf8",
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "gh issue close 12" },
			}),
			env: {
				...process.env,
				WFC_GH: ghShim(),
				CLAUDE_PROJECT_DIR: shared,
				CLAUDE_CONFIG_DIR: config,
			},
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(faults().join("\n")).toMatch(/close allowed unchecked/);
	});

	it("allows and records a close whose issue number it cannot read", () => {
		// An unexpanded variable: judging it would mean guessing which issue.
		expect(verdict("gh issue close $ISSUE")).toBe("allow");
		expect(faults().join("\n")).toMatch(
			/could not read the issue number .* close allowed unchecked/,
		);
		// Quoted, the parser blanks it and reads it back unexpanded (#547).
		fs.rmSync(failOpenLogPath(config, shared), { force: true });
		expect(verdict('gh issue close "$ISSUE"')).toBe("allow");
		expect(faults().join("\n")).toMatch(
			/could not read the issue number .* close allowed unchecked/,
		);
	});

	it("allows an unquoted #12 without recording a fault, gh getting no argument", () => {
		// Bash strips `#12` as a comment, so gh gets no argument and closes
		// nothing: nothing went unprotected, so no fault is recorded (#547).
		expect(verdict("gh issue close #12")).toBe("allow");
		expect(faults()).toEqual([]);
	});

	it("records nothing at all on a close it judged", () => {
		// Every entry in this log claims something went unprotected, so a verdict
		// the guard actually reached must never appear in it.
		verdict("gh issue close 12");
		expect(faults()).toEqual([]);
	});
});

/*
 * The preload throws as the parser's own first line would, for the
 * subcommands CRASH_ON names.
 */
describe("a parser that crashes at load (#1255)", () => {
	const crashing = (on: string) => {
		const at = path.join(dir, "crash.js");
		fs.writeFileSync(
			at,
			[
				"const [, script, command] = process.argv;",
				'if (script?.endsWith("outstanding-line.js") && process.env.CRASH_ON.split(" ").includes(command))',
				'\tthrow new Error("parser crashed at load");',
				"",
			].join("\n"),
		);
		return {
			CRASH_ON: on,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${at}`,
		};
	};

	it("allows and records a close it cannot tell carries the line, on the has-line path", () => {
		const env = crashing("has-line outstanding");
		expect(
			verdict('gh issue close 12 --comment "**Outstanding:** none"', env),
		).toBe("allow");
		expect(faults().join("\n")).toMatch(
			/could not tell whether the --comment .* on #12 carries an Outstanding line — close allowed unchecked/,
		);
	});

	it("allows and records a close whose verdict it never got, on the outstanding path", () => {
		// The newest comment carries no line, so a running parser would refuse.
		expect(verdict("gh issue close 12", crashing("outstanding"))).toBe("allow");
		expect(faults().join("\n")).toMatch(
			/parser exited 1 without a verdict on #12 — close allowed unchecked/,
		);
		fs.rmSync(failOpenLogPath(config, shared), { force: true });
		expect(
			verdict(
				'gh issue close 12 --comment "**Outstanding:** none — fine"',
				crashing("outstanding"),
			),
		).toBe("allow");
		expect(faults().join("\n")).toMatch(/without a verdict on #12/);
	});
});

describeFailOpenLog({
	guard: GUARD,
	denied: { tool_name: "Bash", tool_input: { command: "gh issue close 12" } },
	extraLibs: PARSER_LIBS,
	fieldless: { tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: { tool_name: "Bash", tool_input: { command: "git status" } },
	ctx: () => ({
		dir,
		config,
		project: shared,
		env: {
			WFC_GH: ghShim(),
			GH_SHIM_MODE: "ok",
			GH_SHIM_BODIES: "no disposition line here",
		},
	}),
});

describeSharedParserLibrary({
	guard: GUARD,
	denyCommand: "gh issue close 12",
	extraLibs: PARSER_LIBS,
	ctx: () => ({
		dir,
		shared,
		elsewhere,
		env: {
			WFC_GH: ghShim(),
			CLAUDE_CONFIG_DIR: config,
			GH_SHIM_MODE: "ok",
			GH_SHIM_BODIES: "no disposition line here",
		},
	}),
});

/*
 * mantahostels#1649 relocated both of this guard's rules out of CLAUDE.md and into its two
 * refusals (spec mantahostels#1641). Keyed by fragment id, never by a literal copied out of
 * a fragment — a second copy is the drift the store exists to prevent.
 */
describe("the relocated rules reach the session that trips the guard", () => {
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
	const { ruleText } = require("./lib/rule-text") as any;

	it("the outstanding-line refusal carries the whole rule", () => {
		expect(denyReason("gh issue close 12")).toContain(
			ruleText("close-outstanding"),
		);
	});

	it("the outstanding-line refusal carries the exemption a deny would omit", () => {
		// A session told only "add the line" would read an abandoned issue as
		// unclosable. The escape is in the fragment, and this literal anchors it.
		expect(denyReason("gh issue close 12")).toContain('--reason "not planned"');
	});

	it("the criteria refusal carries the whole rule and the not-planned escape", () => {
		const reason = denyReason("gh issue close 12", {
			GH_SHIM_ISSUE_BODY: "## Acceptance criteria\n\n- [ ] still open\n",
		});
		expect(reason).toContain(ruleText("ticket-criteria-unticked"));
		expect(reason).toContain('--reason "not planned"');
	});

	it("the card refusal carries the whole rule, and still names the card", () => {
		writeRoadmap([["id-match", "active"]]);
		const reason = denyReason("gh issue close 12", {
			GH_SHIM_TITLE: "id-match — Build the hostel ID-matching layer",
			GH_SHIM_BODIES: "no line here",
		});
		expect(reason).toContain(ruleText("card-close-by-hand"));
		// The per-close facts stay with the guard: a fragment cannot know them.
		expect(reason).toContain("/card-close 12");
		expect(reason).toContain("id-match");
		/* A literal anchor, deliberately: the assertion above reads the fragment at
		 * test time, so deleting a clause changes both sides at once and nothing
		 * fails. This escape is the clause a wrongly-refused session needs. */
		expect(reason).toContain('--reason "not planned"');
	});
});
