// @vitest-environment node
/*
 * lib/issue-close.js, the guard-issue-close core (#2798), in process: it
 * denies a close that says nothing about what is still outstanding
 * (mantahostels#185), a hand close of a roadmap card's own issue
 * (mantahostels#220), a completed close over unticked acceptance criteria
 * (#1640), one over census rows the ticket's commits expired (#1913), and one
 * whose commits are unpushed (#3101).
 *
 * A deny is only defensible while it cannot wedge sanctioned work, so every
 * allow-case below is a shape that would otherwise be a false positive — a
 * close that already carries the line, an abandoned issue, a command that
 * merely mentions `gh issue close`. Do not thin them out.
 *
 * gh is the shared fake (§G7), its answers swapped into the fixtures
 * gh.contract.test.ts holds to the real gh, so no case depends on the network
 * or on what a live issue says today. The roadmap, the tracker config and
 * the census read are the real adapters lib/issue-close-host.js builds, over
 * a temp directory and real git; the clock is an injected `now`. The entry's
 * own cases — the JSON it prints, the hook line, the failure policy — are
 * guard-issue-close.test.ts's.
 *
 * Loosen a deny case and an issue closes with its remaining work named
 * nowhere, a card's issue closes past /card-close, or a ticket closes
 * unverified.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type GhAnswer,
	GRAPHQL_FAKE,
	ghAnswer,
	ghComputed,
	ghFake,
	ghServe,
} from "./gh-fake";
import { hexShaCommit } from "./hex-sha-fixture";
import { kitContextFake } from "./kit-context-fake";
import { readRuleText } from "./rule-text";

type Decision = { deny: string } | null;
const { decide } = require("./issue-close.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { buildHostPorts } = require("./issue-close-host.js") as {
	buildHostPorts: (root: string) => Record<string, unknown> & {
		census: (n: number, ms: number) => unknown;
		landing: (
			n: number,
			comment: string,
			ms: number,
			cwd?: string,
		) => { refusal: string } | { outOfBudget: true };
	};
};

const ISSUE_BODY = path.join(__dirname, "fixtures/gh/issue-body.json");
const LOGGED_OUT = path.join(__dirname, "fixtures/gh/logged-out.json");

const answerGraphql = ghComputed<
	(argv: string[], closed: string[], missing: string[]) => GhAnswer
>(GRAPHQL_FAKE, "answerGraphql");

let dir: string;
let shared: string;
let faults: string[];
let calls: string[];
let clock: number;

/** One issue as `gh issue view --json comments,title,parent,labels,body`
 *  describes it. `comments` is oldest first. */
interface Issue {
	title?: string;
	comments?: string[];
	body?: string;
	labels?: string[];
	parent?: number;
}

/** What gh answers this run's calls. `issue` is every number's, `issues` one
 *  number's over it; `closed` and `missing` the open-check's carriers that
 *  are not open; `fail` a gh that cannot answer, `gqlFail` one that cannot
 *  answer the open-check alone, `absent` one that cannot be started; `slow`
 *  the ms each call costs on the clock. */
interface Gh {
	issue?: Issue;
	issues?: Record<string, Issue>;
	closed?: string[];
	missing?: string[];
	fail?: boolean;
	gqlFail?: boolean;
	absent?: boolean;
	slow?: number;
}

const DEFAULT_ISSUE: Required<Omit<Issue, "parent">> = {
	title: "An issue carrying no card-id prefix at all",
	comments: ["a resolution comment with no disposition line"],
	body: "",
	labels: [],
};

/** A fixture's answer with its stdout swapped, for a value the case owns. */
function answering(stdout: string): string {
	const at = path.join(dir, `answer-${calls.length}.json`);
	fs.writeFileSync(at, JSON.stringify({ ...ghAnswer(ISSUE_BODY), stdout }));
	return at;
}

const ghPort = (setup: Gh) => (args: string[]) => {
	calls.push(args.join(" "));
	clock += setup.slow ?? 0;
	if (setup.absent)
		throw Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" });
	if (setup.fail) return ghFake(LOGGED_OUT)(args);
	if (args[0] === "api") {
		if (setup.gqlFail) return ghFake(LOGGED_OUT)(args);
		return ghServe(
			answerGraphql(args, setup.closed ?? [], setup.missing ?? []),
		)(args);
	}
	const issue = {
		...DEFAULT_ISSUE,
		...setup.issue,
		...setup.issues?.[args[2] ?? ""],
	};
	const payload = {
		comments: issue.comments.map((body) => ({ body })),
		title: issue.title,
		body: issue.body,
		labels: issue.labels.map((name) => ({ name })),
		parent: issue.parent ? { number: issue.parent } : null,
	};
	return ghFake(answering(JSON.stringify(payload)))(args);
};

const host = () => buildHostPorts(shared);

const run = (
	command: string,
	setup: Gh = {},
	ports: Record<string, unknown> = {},
) =>
	decide(
		command,
		kitContextFake({
			...host(),
			fallbackCwd: shared,
			vars: { ...process.env },
			isDir: (p: string) =>
				fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
			log: (what: string) => faults.push(what),
			gh: ghPort(setup),
			now: () => clock,
			...ports,
		}),
	);

const verdict = (
	command: string,
	setup: Gh = {},
	ports: Record<string, unknown> = {},
) => (run(command, setup, ports) ? "deny" : "allow");

/** The refusal `command` earns, as the session reads it. Throws on an allow. */
const readDenyReason = (command: string, setup: Gh = {}) => {
	const d = run(command, setup);
	if (!d) throw new Error(`expected a deny for: ${command}`);
	return d.deny;
};

/** The issue's newest comment, the rest of the default issue kept. */
const newest = (body: string, more: Gh = {}): Gh => ({
	...more,
	issue: { ...more.issue, comments: [body] },
});

/**
 * A roadmap holding the given cards, in the field order the real file uses.
 * The state is read out of a bounded window after the id, so the
 * neighbouring fields have to be there for the window to be exercised at all.
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

const writeTracker = (config: object) =>
	fs.writeFileSync(
		path.join(shared, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, ...config }),
	);

/* The framing lines this guard's refusals open with (mantahostels#2145).
 * Two splice a rule fragment underneath, but different ones, so only the
 * framing line tells a card refusal from an outstanding-line one. */
const OUTSTANDING = "This close does not say what is still outstanding";
const CARD_STILL = "and that card is still";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-close-"));
	shared = path.join(dir, "shared");
	faults = [];
	calls = [];
	clock = 0;
	fs.mkdirSync(path.join(shared, ".claude"), { recursive: true });
	// The tracker a bare `#N` on an Outstanding line resolves to.
	writeTracker({ tracker: "acme/tracker" });
	// A host is a checkout with a pushed ref: the landing read faults without one (#3101).
	for (const args of [
		["init", "-q"],
		["commit", "-q", "--allow-empty", "-m", "seed"],
		["update-ref", "refs/remotes/origin/main", "HEAD"],
	])
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", ...args],
			{
				cwd: shared,
			},
		);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the close it denies", () => {
	it("denies a close whose issue carries no Outstanding line", () => {
		// exempt (mantahostels#2145): this refusal's text is pinned by "the
		// outstanding-line refusal carries the whole rule".
		expect(verdict("gh issue close 12")).toBe("deny");
	});

	it("denies it however the number is spelled and wherever the flags sit", () => {
		// `--comment "…"` is blanked to a sentinel by the shared parser, so a
		// scanner that did not skip the flag's VALUE would read the sentinel as
		// the issue number and fail open on a judgeable command (mantahostels#477).
		// exempt (mantahostels#2145): pinned by "the outstanding-line refusal
		// carries the whole rule" — the same refusal, reached by other spellings.
		expect(verdict('gh issue close --comment "done" 12')).toBe("deny");
		// `#12` is judged QUOTED: gh reads a quoted "#12" as issue 12. Unquoted,
		// bash reads `#12` as a comment, so the close has no argument and gh
		// closes nothing — that one is allowed, below (#547).
		expect(verdict('gh issue close "#12"')).toBe("deny");
		expect(verdict("gh issue close '#12'")).toBe("deny");
		expect(verdict("gh issue close \\#12")).toBe("deny");
		expect(verdict('gh issue close "12"')).toBe("deny");
		expect(verdict("gh issue close 12 --repo owner/repo")).toBe("deny");
		expect(calls.every((c) => c.startsWith("issue view 12 "))).toBe(true);
	});

	it("reads a --duplicate-of value as the duplicate, not a second issue closed (#2920)", () => {
		// The first bare word is the issue, so only a flag ahead of it can
		// hand the scan its value in the issue's place.
		expect(verdict("gh issue close 5 --duplicate-of 999")).toBe("deny");
		expect(verdict("gh issue close --duplicate-of 999 5")).toBe("deny");
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.startsWith("issue view 5 "))).toBe(true);
	});

	it("denies a close hidden behind a chain or a subshell", () => {
		// exempt (mantahostels#2145): pinned by "the outstanding-line refusal
		// carries the whole rule"; nothing but a `gh issue close` segment can
		// reach a deny here.
		expect(verdict("npm run test && gh issue close 12")).toBe("deny");
		expect(verdict("(gh issue close 12)")).toBe("deny");
		expect(verdict("/usr/bin/gh issue close 12")).toBe("deny");
	});

	it("names the marker and the one-call route in the refusal, so the fix needs no other document", () => {
		const reason = readDenyReason("gh issue close 12", newest("no line here"));
		expect(reason).toContain("**Outstanding:**");
		expect(reason).toContain(
			"node scripts/resolve-ticket.js <n> --comment-file <file>",
		);
		// #1765: the other lines resolve-ticket refuses a comment without.
		for (const line of [
			"**Bound:**",
			"**Values:**",
			"**Practice:**",
			"**Door:**",
		])
			expect(reason).toContain(line);
	});

	it("quotes the close it refuses, each quoted span as gh got it", () => {
		expect(readDenyReason('gh issue close 12 --comment "Closing."')).toContain(
			`${OUTSTANDING} in the form this guard reads: gh issue close 12 --comment "…"`,
		);
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
		expect(
			verdict(
				"gh issue close 12",
				newest(
					"## Resolution\n**Outstanding:** #181 (log rotation), other#182 (the bare-commit warn)\nmore prose",
				),
			),
		).toBe("allow");
		const query = calls.find((c) => c.startsWith("api graphql")) ?? "";
		expect(query).toContain('owner: "acme", name: "tracker"');
		expect(query).toContain('owner: "acme", name: "other"');
		expect(faults).toEqual([]);
	});

	it("allows an issue abandoned as not planned — nothing was owed", () => {
		expect(verdict('gh issue close 12 --reason "not planned"')).toBe("allow");
		expect(verdict("gh issue close 12 --reason not-planned")).toBe("allow");
		expect(verdict("gh issue close 12 -r 'NOT PLANNED'")).toBe("allow");
	});

	it("searches the raw command for not planned only where the --reason value cannot be read", () => {
		expect(
			verdict('gh issue close 12 --reason "$WHY" --comment "not planned"'),
		).toBe("allow");
		expect(verdict('gh issue close 12 --reason "$WHY"')).toBe("deny");
		expect(verdict("gh issue close 12 --reason")).toBe("deny");
	});

	it("still judges a close that names a reason of completed", () => {
		// The not-planned skip reads the --reason value, so a guard that
		// skipped on the FLAG alone would hand every session a one-word escape.
		// exempt (mantahostels#2145): pinned by "the outstanding-line refusal
		// carries the whole rule".
		expect(verdict('gh issue close 12 --reason "completed"')).toBe("deny");
	});

	it("says nothing about any other gh subcommand", () => {
		expect(verdict('gh issue comment 12 --body "hello"')).toBe("allow");
		expect(verdict("gh issue view 12")).toBe("allow");
		expect(verdict("gh pr close 12")).toBe("allow");
		expect(calls).toEqual([]);
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
		const reason = readDenyReason(
			'gh issue close 12 --comment "**Outstanding:** none — but the founder must check the dashboard"',
		);
		expect(reason).toContain(OUTSTANDING);
		expect(reason).toContain("`none` stands alone");
		expect(reason).toContain("Read: this close's own --comment.");
		expect(reason).toContain("`**Outstanding:** none`, or");
	});

	it("refuses a carrier that is closed, missing, or the issue being closed, naming the carrier", () => {
		const cites = newest("**Outstanding:** #181 (log rotation)");
		expect(
			readDenyReason("gh issue close 12", { ...cites, closed: ["181"] }),
		).toContain("acme/tracker#181 is closed");
		expect(
			readDenyReason("gh issue close 12", { ...cites, missing: ["181"] }),
		).toContain("acme/tracker#181 does not exist");
		expect(
			readDenyReason(
				"gh issue close 12",
				newest("**Outstanding:** #12 (the rest of this)"),
			),
		).toContain("acme/tracker#12 is the issue in hand");
	});

	it("resolves a bare carrier against the repo the close names", () => {
		expect(
			readDenyReason(
				"gh issue close 12 -R https://github.com/Owner/Other.git",
				newest("**Outstanding:** #181 (log rotation)", { closed: ["181"] }),
			),
		).toContain("owner/other#181 is closed");
	});

	it("reads the newest comment only, so a stale marker above it does not count", () => {
		const setup: Gh = {
			issue: {
				comments: [
					"Progress so far.\n**Outstanding:** none",
					"Closing now — all done.",
				],
			},
		};
		expect(readDenyReason("gh issue close 12", setup)).toContain(
			"Read: #12's newest comment — an older one does not count.",
		);
	});

	it("reads the close's own --comment ahead of the issue's", () => {
		const lined = newest("**Outstanding:** none");
		expect(
			verdict(
				'gh issue close 12 --comment "**Outstanding:** none — fine"',
				lined,
			),
		).toBe("deny");
		// A --comment with no marker line leaves the issue's newest comment to
		// judge — one naming the marker mid-sentence included.
		for (const said of ["Closing.", "Closing per the **Outstanding:** rule."])
			expect(
				verdict(`gh issue close 12 --comment "${said}"`, lined),
				said,
			).toBe("allow");
	});

	it("reads the issue's newest comment where the --comment's only marker sits in a fence, as the parser does (#1247)", () => {
		const fenced =
			'gh issue close 12 --comment "The form:\n~~~\n**Outstanding:** none\n~~~"';
		expect(verdict(fenced, newest("**Outstanding:** none"))).toBe("allow");
		expect(readDenyReason(fenced, newest("Closing now — all done."))).toContain(
			"#12's newest comment",
		);
	});

	it("allows and records a close whose carriers GitHub could not be asked about", () => {
		expect(
			verdict(
				"gh issue close 12",
				newest("**Outstanding:** #181 (log rotation)", { gqlFail: true }),
			),
		).toBe("allow");
		expect(faults.join("\n")).toMatch(
			/^Outstanding open-check on #12: .*shape check only$/,
		);
	});

	it("still refuses a shape miss while GitHub is unreachable", () => {
		expect(
			verdict(
				"gh issue close 12",
				newest("**Outstanding:** #181 and #182 are left", { gqlFail: true }),
			),
		).toBe("deny");
	});

	it("allows and records a --comment it cannot read, never judging the newest comment in its place (#990)", () => {
		const done = newest("Closing now — all done.");
		for (const comment of ["**Outstanding:** $LEFT", "$(cat close.md)"]) {
			faults = [];
			expect(
				verdict(`gh issue close 12 --comment "${comment}"`, done),
				comment,
			).toBe("allow");
			expect(faults, comment).toEqual([
				"could not read the --comment of a gh issue close on #12 — close allowed unchecked",
			]);
		}
		expect(verdict('gh issue close 12 --comment "Closing now."', done)).toBe(
			"deny",
		);
		// Logged, not ended: a later close in the same call is still judged.
		expect(
			verdict(
				'gh issue close 5 --comment "$(cat close.md)"; gh issue close 12',
				done,
			),
		).toBe("deny");
	});
});

/*
 * The second rule (mantahostels#220). A card's own issue is closed by
 * /card-close, which closes it as its LAST step, after the card is already
 * `done` — so these cases are about a hand close arriving before that.
 */
describe("the card's issue it refuses to close by hand", () => {
	const CardTitle = "id-match — Build the hostel ID-matching layer";
	// A card's own issue: the `<card-id> — <title>` prefix, and no parent.
	const cardIssue = (state: string, extra: Issue = {}) => {
		writeRoadmap([["id-match", state]]);
		return run("gh issue close 12", { issue: { title: CardTitle, ...extra } });
	};
	const said = (state: string, extra: Issue = {}) =>
		cardIssue(state, extra)?.deny ?? "allow";

	it("denies a close while the card is still active", () => {
		// No Outstanding line is supplied, so the OTHER rule would deny this too
		// — only the framing line says which one did.
		expect(said("active")).toContain(CARD_STILL);
	});

	it("denies it for every state that is not done", () => {
		expect(said("open")).toContain("still `open`");
		expect(said("parked")).toContain("still `parked`");
	});

	it("denies even when the close already says what is outstanding", () => {
		// The card rule runs first deliberately: /card-close writes the
		// Outstanding line itself, so answering the other rule here would send
		// the session to perfect a close it should not be making at all.
		expect(
			said("active", { comments: ["## Resolution\n**Outstanding:** none"] }),
		).toContain(CARD_STILL);
	});

	it("allows the close once the card is done — /card-close's own last step", () => {
		// The FIRST rule still applies to a card issue: both bind /card-close's
		// own step 8, which writes that line itself (mantahostels#281).
		expect(said("done", { comments: ["**Outstanding:** none"] })).toBe("allow");
	});

	it("allows a child ticket that merely inherited the card's id (mantahostels#275)", () => {
		// A parent is what tells a child from the card's own issue.
		expect(
			said("active", { parent: 145, comments: ["**Outstanding:** none"] }),
		).toBe("allow");
	});

	it("allows a wayfinder map that borrowed the card's id (mantahostels#1490)", () => {
		// A map is unparented exactly as a card's own issue is, so the parent
		// test cannot tell them apart. A map is never the card's own issue.
		expect(
			said("active", {
				labels: ["takes:children", "wayfinder:map"],
				comments: ["**Outstanding:** none"],
			}),
		).toBe("allow");
	});

	it("still denies a card issue carrying some other wayfinder label", () => {
		// The exemption is `wayfinder:map` alone — mantahostels#275 measured the
		// label FAMILY and rejected it, and this does not reopen that.
		expect(
			said("active", {
				labels: ["wayfinder:task"],
				comments: ["**Outstanding:** none"],
			}),
		).toContain(CARD_STILL);
	});

	it("still demands an Outstanding line from an exempted map", () => {
		// The exemption lifts the card rule only. The first rule binds every
		// close, and it is the Outstanding refusal that fires.
		expect(said("active", { labels: ["wayfinder:map"] })).toContain(
			OUTSTANDING,
		);
	});

	it("says nothing about an issue whose title carries no card id", () => {
		writeRoadmap([["id-match", "active"]]);
		expect(
			verdict("gh issue close 12", {
				issue: {
					title: "Some issue that was never a card",
					comments: ["**Outstanding:** none"],
				},
			}),
		).toBe("allow");
		expect(faults).toEqual([]);
	});

	it("allows a card issue abandoned as not planned", () => {
		writeRoadmap([["id-match", "active"]]);
		expect(
			verdict('gh issue close 12 --reason "not planned"', {
				issue: { title: CardTitle },
			}),
		).toBe("allow");
	});

	it("names /card-close, the card and its state in the refusal", () => {
		const reason = said("active", { comments: ["no line here"] });
		expect(reason).toContain(
			"This closes the issue for roadmap card `id-match`, and that card is still `active`, not `done`: gh issue close 12",
		);
		expect(reason).toContain("Close it with **/card-close 12** instead.");
	});

	it("judges each issue in a chain against its own payload", () => {
		// One tool call can close two issues. A payload cached without its issue
		// number lets the first close answer for the second: #12 allows on its
		// Outstanding line, then #34 — a card issue with an active card — is
		// read as #12 and allowed too.
		writeRoadmap([["id-match", "active"]]);
		const reason = readDenyReason("gh issue close 12 && gh issue close 34", {
			issues: {
				"12": { comments: ["**Outstanding:** none"] },
				"34": { title: CardTitle, comments: ["**Outstanding:** none"] },
			},
		});
		// It must name #34, not the #12 it was cached against.
		expect(reason).toContain("/card-close 34");
	});

	it("asks GitHub once, not once per rule", () => {
		writeRoadmap([["id-match", "done"]]);
		verdict("gh issue close 12", {
			issue: { title: CardTitle, comments: ["**Outstanding:** none"] },
		});
		expect(calls).toHaveLength(1);
	});
});

/*
 * #1640: the criteria refusal resolve-ticket.js makes, held on the hand
 * spelling too and keyed on the criteria section rather than `kind:ticket`.
 */
describe("the acceptance criteria it reads", () => {
	const lined = (body: string, labels: string[] = []): Gh => ({
		issue: { comments: ["Done.\n**Outstanding:** none."], body, labels },
	});
	const unmetBody =
		"## Acceptance criteria\n\n- [x] the part that was done\n- [ ] the part that was not\n\n## Out of scope\n\n- [ ] not a criterion\n";

	it("denies a criteria-bearing issue with no kind:ticket, naming each unmet criterion", () => {
		const reason = readDenyReason(
			"gh issue close 12",
			lined(unmetBody, ["takes:implement", "wayfinder:task"]),
		);
		expect(reason).toContain(
			"This closes #12 over acceptance criteria neither ticked nor waived: gh issue close 12\n\n  - [ ] the part that was not\n\nRe-run the close",
		);
		expect(reason).not.toContain("the part that was done");
		expect(reason).not.toContain("not a criterion");
		expect(faults).toEqual([]);
	});

	it("denies a criteria heading spaced with a tab, as the library reads it", () => {
		expect(
			readDenyReason(
				"gh issue close 12",
				lined("## Acceptance\tcriteria\n\n- [ ] still open\n"),
			),
		).toContain("  - [ ] still open");
		expect(
			readDenyReason(
				"gh issue close 12",
				lined("##\tAcceptance criteria\n\n- [ ] still open\n"),
			),
		).toContain("  - [ ] still open");
	});

	it("denies a bare Acceptance heading's unmet criteria (#2481)", () => {
		expect(
			readDenyReason(
				"gh issue close 12",
				lined("## Acceptance\n\n- [ ] still open\n"),
			),
		).toContain("  - [ ] still open");
	});

	it("judges a completed close whose --comment merely mentions not planned", () => {
		expect(
			readDenyReason(
				'gh issue close 12 --reason completed --comment "the rest was not planned. **Outstanding:** none."',
				{ issue: { body: unmetBody } },
			),
		).toContain("  - [ ] the part that was not");
	});

	it("refuses before the Outstanding rule where both apply", () => {
		const reason = readDenyReason("gh issue close 12", {
			issue: { body: unmetBody },
		});
		expect(reason).toContain("acceptance criteria neither ticked nor waived");
		expect(reason).not.toContain(OUTSTANDING);
	});

	it("allows an issue whose every criterion is ticked or waived", () => {
		expect(
			verdict(
				"gh issue close 12",
				lined(
					"## Acceptance criteria\n\n- [x] done\n- [ ] dropped **waived:** out of reach\n",
				),
			),
		).toBe("allow");
		expect(faults).toEqual([]);
	});

	it("allows an issue with no criteria section", () => {
		expect(
			verdict(
				"gh issue close 12",
				lined("## What to build\n\n- [ ] a list that is not criteria\n"),
			),
		).toBe("allow");
		expect(faults).toEqual([]);
	});

	it("records an unread issue once, where its own --comment spares the Outstanding fetch", () => {
		expect(
			verdict('gh issue close 12 --comment "**Outstanding:** none."', {
				fail: true,
			}),
		).toBe("allow");
		expect(faults).toEqual([
			"could not read #12 — acceptance criteria unchecked",
		]);
	});

	it("allows a not-planned close over unmet criteria", () => {
		expect(
			verdict('gh issue close 12 --reason "not planned"', {
				issue: { body: unmetBody },
			}),
		).toBe("allow");
	});
});

/*
 * #1913: the census refusal resolve-ticket.js makes (#1876), held on the hand
 * spelling too.
 */
describe("the census rows it reads", () => {
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
	const { digestOf } = require("./census-digest") as any;
	const guardRel = "scripts/guard-one.sh";
	const lined = newest("Done.\n**Outstanding:** none.");

	const git = (...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", ...args],
			{ cwd: shared },
		);
	const commit = (body: string, message: string) => {
		fs.writeFileSync(path.join(shared, guardRel), body);
		git("add", "-A");
		git("commit", "-qm", message);
		git("update-ref", "refs/remotes/origin/main", "HEAD");
	};
	const reword = () =>
		commit("#!/bin/sh\necho rule one, reworded\n", "Reword the guard (#12)");

	beforeEach(() => {
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
		const reason = readDenyReason("gh issue close 12", lined);
		expect(reason).toContain(
			"This close leaves census rows its commits expired: gh issue close 12\n\n#12's commits changed",
		);
		expect(reason).toContain(`  ${guardRel}\n`);
		expect(reason).toContain(`--rebaseline --only ${guardRel}`);
		expect(reason).toContain(
			"**Census:** <why not re-anchored, and which ticket owns it>\" to the comment. The close's own --comment, or else the issue's newest comment, carries it.",
		);
		expect(reason).toContain('--reason "not planned"');
		expect(faults).toEqual([]);
	});

	it("denies a close whose commit changed only the core a measured wrapper composes (#3129)", () => {
		const wrapper = "scripts/guard-three.js";
		const core = path.join(shared, "scripts/lib/three.js");
		fs.mkdirSync(path.dirname(core));
		fs.writeFileSync(
			path.join(shared, wrapper),
			'const { decide } = require("./lib/three.js");\n',
		);
		fs.writeFileSync(core, "module.exports = { decide: () => null };\n");
		fs.writeFileSync(
			path.join(shared, "scripts/instruction-surface-anchors.json"),
			JSON.stringify({
				guards: { [wrapper]: { digest: digestOf(shared, wrapper) } },
			}),
		);
		git("add", "-A");
		git("commit", "-qm", "anchor the wrapper");
		fs.writeFileSync(
			core,
			'module.exports = { decide: () => ({ deny: "no" }) };\n',
		);
		git("commit", "-qam", "Deny in the core (#12)");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		expect(readDenyReason("gh issue close 12", lined)).toContain(
			`  ${wrapper}\n`,
		);
	});

	it("denies a close whose commit reworded only a rule a measured core's host reaches through a deeper lib (#3167)", () => {
		const core = "scripts/lib/four.js";
		const lib = (name: string) => path.join(shared, "scripts/lib", name);
		fs.mkdirSync(lib(""));
		fs.writeFileSync(
			lib("four.js"),
			"module.exports = { decide: () => null };\n",
		);
		fs.writeFileSync(
			lib("four-host.js"),
			'const { refusal } = require("./deeper.js");\nmodule.exports = { buildHostPorts: () => ({ refusal }) };\n',
		);
		fs.writeFileSync(
			lib("deeper.js"),
			'module.exports = { refusal: () => readRuleTextOr("deep", "x") };\n',
		);
		fs.writeFileSync(
			lib("guard-cores.json"),
			JSON.stringify({
				PreToolUse: [
					{
						name: "four",
						core: "four.js",
						tools: "Bash",
						failure: "open",
						host: "four-host.js",
					},
				],
			}),
		);
		fs.mkdirSync(path.join(shared, "docs/agents/rules"), { recursive: true });
		fs.writeFileSync(
			path.join(shared, "docs/agents/rules/deep.txt"),
			"Deep.\n",
		);
		fs.writeFileSync(
			path.join(shared, "scripts/instruction-surface-anchors.json"),
			JSON.stringify({
				guards: { [core]: { digest: digestOf(shared, core) } },
			}),
		);
		git("add", "-A");
		git("commit", "-qm", "anchor the core");
		fs.writeFileSync(
			path.join(shared, "docs/agents/rules/deep.txt"),
			"Deeper.\n",
		);
		git("commit", "-qam", "Reword the deep rule (#12)");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		expect(readDenyReason("gh issue close 12", lined)).toContain(`  ${core}\n`);
	});

	it("allows a close whose --comment carries a Census line", () => {
		reword();
		expect(
			verdict(
				'gh issue close 12 --comment "**Census:** re-measured under #13."',
				lined,
			),
		).toBe("allow");
	});

	it("allows a close whose newest comment carries a Census line", () => {
		reword();
		expect(
			verdict(
				"gh issue close 12",
				newest(
					"Done.\n**Census:** re-measured under #13.\n**Outstanding:** none.",
				),
			),
		).toBe("allow");
	});

	it("allows a close whose commit only cut comments, or cited another tracker", () => {
		commit("#!/bin/sh\n# why\necho rule one\n", "Explain the guard (#12)");
		commit("#!/bin/sh\necho rule two\n", "Reword the guard (gadgets#12)");
		expect(verdict("gh issue close 12", lined)).toBe("allow");
		expect(faults).toEqual([]);
	});

	it("allows a close naming another repo, whose #12 these commits do not cite", () => {
		reword();
		expect(verdict("gh issue close 12 --repo other/repo", lined)).toBe("allow");
	});

	it("allows a not-planned close over an expired row", () => {
		reword();
		expect(verdict('gh issue close 12 --reason "not planned"')).toBe("allow");
	});

	it("fails open, recorded, where the census read runs out of the budget", () => {
		reword();
		// The real read, handed no time: its git ceiling passes before git runs.
		expect(
			verdict("gh issue close 12", lined, {
				census: (n: number) => host().census(n, 0),
			}),
		).toBe("allow");
		expect(faults).toEqual([
			"the census reader ran out of the guard's time budget on #12 — census rows unchecked",
		]);
	});

	it("denies on HEAD's anchors where only a neighbour's dirty copy is broken (#3521)", () => {
		reword();
		fs.writeFileSync(
			path.join(shared, "scripts/instruction-surface-anchors.json"),
			"{ not json",
		);
		expect(readDenyReason("gh issue close 12", lined)).toContain(
			`  ${guardRel}\n`,
		);
		expect(faults).toEqual([]);
	});

	it("fails open, recorded, where the census read faults", () => {
		reword();
		fs.writeFileSync(
			path.join(shared, "scripts/instruction-surface-anchors.json"),
			"{ not json",
		);
		git("commit", "-qam", "Break the anchors");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		expect(verdict("gh issue close 12", lined)).toBe("allow");
		expect(faults).toEqual([
			"the census reader gave no verdict on #12 — census rows unchecked",
		]);
	});

	it("fails open, recorded, where the newest comment that might carry the Census line is unread", () => {
		reword();
		expect(
			verdict('gh issue close 12 --comment "**Outstanding:** none."', {
				fail: true,
			}),
		).toBe("allow");
		expect(faults).toEqual([
			"could not read #12's newest comment for a Census line — census rows unchecked",
			"could not read #12 — acceptance criteria unchecked",
		]);
	});
});

describe("the commits the pushed ref lacks (#3101)", () => {
	const lined = newest("Done.\n**Outstanding:** none.");
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", ...args],
			{ cwd: shared },
		);
	const commit = (message: string) => {
		fs.appendFileSync(path.join(shared, "a.txt"), `${message}\n`);
		git("add", "-A");
		git("commit", "-qm", message);
	};
	const push = () => git("update-ref", "refs/remotes/origin/landing", "HEAD");

	beforeEach(() => {
		vi.stubEnv("WFC_MODULES", undefined);
		// The port judges by the host it holds, never a session's own (#3327).
		vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
		writeTracker({ tracker: "acme/tracker", modules: ["landing"] });
		push();
		commit("Fix the stop (#12)");
	});

	it("denies a close whose commit is unpushed, naming it and the escape", () => {
		const reason = readDenyReason("gh issue close 12", lined);
		expect(reason).toContain(
			"This close reports work that has not landed: gh issue close 12\n\n#12's commit is not on origin/landing",
		);
		expect(reason).toContain(" Fix the stop (#12)\n");
		expect(reason).toContain("**Unlanded:**");
		expect(faults).toEqual([]);
	});

	it("allows it once pushed", () => {
		push();
		expect(verdict("gh issue close 12", lined)).toBe("allow");
	});

	it("allows a close whose --comment or newest comment carries an Unlanded line", () => {
		expect(
			verdict(
				'gh issue close 12 --comment "**Unlanded:** a neighbour\'s cite."',
				lined,
			),
		).toBe("allow");
		expect(
			verdict(
				"gh issue close 12",
				newest("**Unlanded:** a neighbour's cite.\n**Outstanding:** none."),
			),
		).toBe("allow");
	});

	it("denies a close whose --comment names a commit off HEAD that origin/landing lacks (#3092)", () => {
		push();
		git("checkout", "-q", "-b", "side");
		commit("Fix the stop");
		const sha = String(git("rev-parse", "HEAD")).trim();
		git("checkout", "-q", "-");
		const reason = readDenyReason(
			`gh issue close 12 --comment "Fixed in ${sha}."`,
			lined,
		);
		expect(reason).toContain(
			`  ${String(git("rev-parse", "--short", sha)).trim()} Fix the stop\n`,
		);
	});

	it("denies a close whose --comment names such a commit by an all-digit short sha (#3230)", () => {
		push();
		git("checkout", "-q", "-b", "side");
		const { sha, short } = hexShaCommit(shared, "Fix the stop", "digits");
		git("checkout", "-q", "-");
		const reason = readDenyReason(
			`gh issue close 12 --comment "Fixed in ${short}."`,
			lined,
		);
		expect(reason).toContain(
			`  ${String(git("rev-parse", "--short", sha)).trim()} Fix the stop\n`,
		);
	});

	it("reads the HEAD of the linked worktree the close runs from", () => {
		push();
		const wt = path.join(dir, "wt");
		git("worktree", "add", "-q", "--detach", wt);
		execFileSync(
			"git",
			[
				"-c",
				"user.email=t@t",
				"-c",
				"user.name=t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"Mend the gate (#12)",
			],
			{ cwd: wt },
		);
		expect(buildHostPorts(shared).landing(12, "", 4000, wt)).toEqual({
			refusal: expect.stringContaining("#12's commit is not on origin/landing"),
		});
	});

	it("allows a not-planned close over an unpushed commit", () => {
		expect(verdict('gh issue close 12 --reason "not planned"')).toBe("allow");
	});

	it("fails open, recorded, where the landing read runs out of the budget", () => {
		expect(
			verdict("gh issue close 12", lined, {
				landing: (n: number, c: string) => host().landing(n, c, 0),
			}),
		).toBe("allow");
		expect(faults).toEqual([
			"the landing reader ran out of the guard's time budget on #12 — landing unchecked",
		]);
	});
});

/*
 * #553: a close naming another repo was judged by THIS repo's issue of the
 * same number — a deny or an allow on the wrong issue.
 */
describe("the repo a close names", () => {
	it("asks GitHub for the issue on the repo the close names", () => {
		for (const command of [
			"gh issue close 12 --repo owner/other",
			"gh issue close -R owner/other 12",
			"gh issue close 12 --repo=owner/other",
			'gh issue close 12 --repo "owner/other"',
			"gh issue close 12 -R'owner/other'",
		]) {
			calls = [];
			expect(verdict(command), command).toBe("deny");
			expect(calls, command).toEqual([
				"issue view 12 --json comments,title,parent,labels,body --repo owner/other",
			]);
		}
	});

	it("names no repo where the close names none", () => {
		expect(verdict("gh issue close 12")).toBe("deny");
		expect(calls).toEqual([
			"issue view 12 --json comments,title,parent,labels,body",
		]);
	});

	it("asks again for the same number on another repo", () => {
		// The payload cache is keyed on the issue; keyed on the number alone,
		// the second close would be answered from the first repo's issue.
		expect(
			verdict(
				"gh issue close 12 --repo owner/other && gh issue close 12",
				newest("**Outstanding:** none"),
			),
		).toBe("allow");
		expect(calls).toEqual([
			"issue view 12 --json comments,title,parent,labels,body --repo owner/other",
			"issue view 12 --json comments,title,parent,labels,body",
		]);
	});

	it("allows and records a close whose repo it cannot read", () => {
		for (const command of [
			'gh issue close 12 --repo "$REPO"',
			"gh issue close 12 --repo $REPO",
			"gh issue close 12 --repo=$(cat repo)",
		]) {
			faults = [];
			expect(verdict(command), command).toBe("allow");
			expect(calls, command).toEqual([]);
			expect(faults, command).toEqual([
				"could not read the --repo value of a gh issue close — close allowed unchecked",
			]);
		}
	});

	describe("and the card rule", () => {
		// A card's own issue, its card still active, the Outstanding line
		// supplied: only the card rule can refuse.
		const cardClose = (command: string) => {
			writeRoadmap([["id-match", "active"]]);
			return verdict(command, {
				issue: {
					title: "id-match — Build the hostel ID-matching layer",
					comments: ["**Outstanding:** none"],
				},
			});
		};

		it("stands down for an issue on a repo other than the tracker", () => {
			// This roadmap's cards and /card-close belong to the tracker, so its
			// refusal would send the session to close the tracker's #12 instead.
			writeTracker({ tracker: "lucmoseley/workflow-core" });
			expect(cardClose("gh issue close 12 --repo owner/other")).toBe("allow");
		});

		it("still refuses the tracker's own issue, however the repo is spelled", () => {
			writeTracker({ tracker: "lucmoseley/workflow-core" });
			for (const command of [
				"gh issue close 12 --repo lucmoseley/workflow-core",
				"gh issue close 12 -R LucMoseley/Workflow-Core",
				"gh issue close 12 --repo github.com/lucmoseley/workflow-core",
				"gh issue close 12 --repo https://github.com/lucmoseley/workflow-core.git",
				"gh issue close 12 --repo git@github.com:lucmoseley/workflow-core.git",
			])
				expect(cardClose(command), command).toBe("deny");
		});

		it("still refuses where no tracker can be read", () => {
			fs.rmSync(path.join(shared, ".claude", "workflow-core.json"));
			expect(cardClose("gh issue close 12 --repo owner/other")).toBe("deny");
		});

		it("reads an undeclared tracker off the origin remote (#1481)", () => {
			writeTracker({});
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
 * 8's Outstanding line (mantahostels#281) is tested where it lives: a fix
 * that lives in prose is only worth anything while the prose still says it.
 */
describe("the close /card-close itself runs (mantahostels#281)", () => {
	/** The bash of step 8, as written, with the issue number substituted in. */
	const readStepEightClose = () => {
		const md = fs.readFileSync(
			path.resolve(__dirname, "../../.claude/skills/card-close/SKILL.md"),
			"utf8",
		);
		const step = md.split(/^### 8\. /m)[1];
		if (!step) throw new Error("card-close/SKILL.md has no step 8");
		const block = step.match(/```bash\n([\s\S]*?)```/);
		if (!block?.[1])
			throw new Error("step 8 of card-close/SKILL.md runs no bash");
		return block[1].trim().replaceAll("$ARGUMENTS", "12");
	};

	// The state step 8 actually meets: the card was marked done in step 4,
	// and nothing before it has posted a comment carrying the line.
	const atStepEight = (command: string) => {
		writeRoadmap([["id-match", "done"]]);
		return run(command, {
			issue: {
				title: "id-match — Build the hostel ID-matching layer",
				comments: ["an issue with no resolution comment on it yet"],
			},
		});
	};

	it("passes the guard as the skill file writes it", () => {
		expect(atStepEight(readStepEightClose())).toBeNull();
	});

	it("passes on the line it carries, not on anything already on the issue", () => {
		// Strip the disposition line back out and the same close is refused —
		// by the Outstanding rule, the card being `done`.
		const stripped = readStepEightClose().replace(
			/\n+\*\*Outstanding:\*\*[^"]*/,
			"",
		);
		expect(stripped).not.toContain("**Outstanding:**");
		expect(atStepEight(stripped)?.deny).toContain(OUTSTANDING);
	});
});

describe("the card checks it cannot make", () => {
	const Card = {
		issue: {
			title: "id-match — Build the hostel ID-matching layer",
			comments: ["**Outstanding:** none"],
		},
	};

	it("records the card unchecked when the roadmap is unreadable", () => {
		// No roadmap written at all. mantahostels#220 asked for this to be loud
		// rather than a silent allow.
		expect(verdict("gh issue close 12", Card)).toBe("allow");
		expect(faults).toEqual([
			"could not read the roadmap, so card id-match — card state unchecked",
		]);
	});

	it("still reaches the Outstanding verdict when the card was unchecked", () => {
		// Logged, not ended: an unreadable roadmap says nothing about comments.
		expect(
			readDenyReason("gh issue close 12", {
				issue: { title: "id-match — Build the hostel ID-matching layer" },
			}),
		).toContain(OUTSTANDING);
	});

	it("records a card id the roadmap does not hold exactly once", () => {
		writeRoadmap([["other-card", "active"]]);
		expect(verdict("gh issue close 12", Card)).toBe("allow");
		expect(faults).toEqual([
			"id-match names 0 cards on the roadmap, so it — card state unchecked",
		]);
		faults = [];
		writeRoadmap([
			["id-match", "active"],
			["id-match", "done"],
		]);
		expect(verdict("gh issue close 12", Card)).toBe("allow");
		expect(faults.join("\n")).toMatch(/id-match names 2 cards/);
	});

	it("records a title that looks like a card id it will not parse", () => {
		// The pattern is stricter than check-issue-card-drift.js's, which takes
		// capitals, dots and an en dash. A title in the gap is allowed, so it is
		// recorded rather than passing as "not a card at all".
		writeRoadmap([["id-match", "active"]]);
		expect(
			verdict("gh issue close 12", {
				issue: {
					title: "Id-Match – Build the hostel ID-matching layer",
					comments: ["**Outstanding:** none"],
				},
			}),
		).toBe("allow");
		expect(faults).toEqual([
			'title "Id-Match – Build the hostel ID-matching " looks like a card id this guard will not parse, so it — card state unchecked',
		]);
	});

	it("records one fault, not two, when GitHub is unreachable", () => {
		// Every rule reads the same payload, so one outage must leave one line —
		// check-guard-errors.js reports these under `npm run status`.
		expect(verdict("gh issue close 12", { fail: true })).toBe("allow");
		expect(faults).toEqual([
			"could not read comments on #12 — close allowed unchecked",
		]);
	});

	it("counts two cards sharing an id even on one line", () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(shared, "docs", "reference-roadmap.html"),
			'<script>const CARDS=[{id:"id-match",state:"active"},{id:"id-match",state:"done"}];</script>',
		);
		expect(verdict("gh issue close 12", Card)).toBe("allow");
		expect(faults.join("\n")).toMatch(/id-match names 2 cards/);
	});

	it("records a card whose state it cannot read", () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(shared, "docs", "reference-roadmap.html"),
			'<script>const CARDS=[{id:"id-match",t:"no state field here"}];</script>',
		);
		expect(verdict("gh issue close 12", Card)).toBe("allow");
		expect(faults).toEqual([
			"card id-match has no readable state, so it — card state unchecked",
		]);
	});

	it("reads the state inside the 200-character window after the id, never the next card's", () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(shared, "docs", "reference-roadmap.html"),
			`<script>const CARDS=[{id:"id-match",t:"${"x".repeat(200)}",state:"active"}];</script>`,
		);
		expect(verdict("gh issue close 12", Card)).toBe("allow");
		expect(faults).toEqual([
			"card id-match has no readable state, so it — card state unchecked",
		]);
	});
});

describe("the fail-opens it records", () => {
	it("allows and records a close it cannot ask GitHub about", () => {
		expect(verdict("gh issue close 12", { fail: true })).toBe("allow");
		expect(faults).toEqual([
			"could not read comments on #12 — close allowed unchecked",
		]);
	});

	it("allows and records a close when gh cannot be started", () => {
		expect(verdict("gh issue close 12", { absent: true })).toBe("allow");
		expect(faults).toEqual([
			"could not read comments on #12 — close allowed unchecked",
		]);
	});

	it("allows and records a close whose issue number it cannot read", () => {
		// An unexpanded variable: judging it would mean guessing which issue.
		// Quoted, the parser blanks it and reads it back unexpanded (#547).
		for (const command of [
			"gh issue close $ISSUE",
			'gh issue close "$ISSUE"',
		]) {
			faults = [];
			expect(verdict(command), command).toBe("allow");
			expect(faults, command).toEqual([
				"could not read the issue number from a gh issue close — close allowed unchecked",
			]);
		}
	});

	it("allows an unquoted #12 without recording a fault, gh getting no argument", () => {
		// Bash strips `#12` as a comment, so gh gets no argument and closes
		// nothing: nothing went unprotected, so no fault is recorded (#547).
		expect(verdict("gh issue close #12")).toBe("allow");
		expect(verdict('gh issue close ""')).toBe("allow");
		expect(faults).toEqual([]);
	});

	it("records nothing at all on a close it judged", () => {
		// Every entry in this log claims something went unprotected, so a
		// verdict the guard actually reached must never appear in it.
		verdict("gh issue close 12");
		expect(faults).toEqual([]);
	});
});

/*
 * The run budget: each call gets what is left of 30 s, at most 4 s, as its
 * timeout, and a call with under 1 s left is not made but recorded.
 */
describe("the time budget it runs under", () => {
	it("hands each gh call what is left of the budget, at most 4 s", () => {
		const timeouts: number[] = [];
		const gh = ghPort(newest("**Outstanding:** #181 (log rotation)"));
		verdict(
			"gh issue close 12",
			{},
			{
				gh: (args: string[], ms: number) => {
					timeouts.push(ms);
					clock += 3000;
					return gh(args);
				},
			},
		);
		expect(timeouts).toEqual([4000, 4000]);
	});

	it("allows and records a close whose Outstanding line it has no time left to judge", () => {
		expect(verdict("gh issue close 12", { slow: 29_500 })).toBe("allow");
		expect(faults).toEqual([
			"no time left in the guard's budget to judge #12's Outstanding line — close allowed unchecked",
		]);
	});

	it("skips and records the census and landing reads where no time is left for them", () => {
		expect(
			verdict(
				"gh issue close 12",
				newest("**Outstanding:** #181 (x)", { slow: 14_600 }),
			),
		).toBe("allow");
		expect(faults).toEqual([
			"no time left in the guard's budget to read whether #12's commits landed — unchecked",
			"no time left in the guard's budget to read #12's census rows — unchecked",
		]);
	});

	it("makes no gh call with under a second left, and records the close unchecked", () => {
		// The call starts at 0; every later reading is 29.001 s on.
		const readings = [0];
		expect(
			verdict(
				"gh issue close 12",
				{},
				{ now: () => readings.shift() ?? 29_001 },
			),
		).toBe("allow");
		expect(calls).toEqual([]);
		expect(faults).toEqual([
			"could not read comments on #12 — close allowed unchecked",
		]);
	});
});

/*
 * mantahostels#1649 relocated this guard's rules out of CLAUDE.md and into
 * its refusals (spec mantahostels#1641). Keyed by fragment id, never by a
 * literal copied out of a fragment — a second copy is the drift the store
 * exists to prevent.
 */
describe("the relocated rules reach the session that trips the guard", () => {
	it("the outstanding-line refusal carries the whole rule", () => {
		expect(readDenyReason("gh issue close 12")).toContain(
			readRuleText("close-outstanding"),
		);
	});

	it("the outstanding-line refusal carries the exemption a deny would omit", () => {
		// A session told only "add the line" would read an abandoned issue as
		// unclosable. The escape is in the fragment, and this literal anchors it.
		expect(readDenyReason("gh issue close 12")).toContain(
			'--reason "not planned"',
		);
	});

	it("the criteria refusal carries the whole rule and the not-planned escape", () => {
		const reason = readDenyReason("gh issue close 12", {
			issue: { body: "## Acceptance criteria\n\n- [ ] still open\n" },
		});
		expect(reason).toContain(readRuleText("ticket-criteria-unticked"));
		expect(reason).toContain('--reason "not planned"');
	});

	it("the card refusal carries the whole rule, and still names the card", () => {
		writeRoadmap([["id-match", "active"]]);
		const reason = readDenyReason("gh issue close 12", {
			issue: {
				title: "id-match — Build the hostel ID-matching layer",
				comments: ["no line here"],
			},
		});
		expect(reason).toContain(readRuleText("card-close-by-hand"));
		// The per-close facts stay with the guard: a fragment cannot know them.
		expect(reason).toContain("/card-close 12");
		expect(reason).toContain("id-match");
		/* A literal anchor, deliberately: the assertion above reads the fragment
		 * at test time, so deleting a clause changes both sides at once and
		 * nothing fails. This escape is the clause a wrongly-refused session
		 * needs. */
		expect(reason).toContain('--reason "not planned"');
	});

	it("still refuses, naming the fragment, where the rule store cannot give it", () => {
		const unreadable = {
			ruleText: () => {
				throw new Error("no fragment");
			},
		};
		writeRoadmap([["id-match", "active"]]);
		expect(
			run(
				"gh issue close 12",
				{ issue: { title: "id-match — Build the hostel ID-matching layer" } },
				unreadable,
			)?.deny,
		).toContain("docs/agents/rules/card-close-by-hand.txt");
		expect(run("gh issue close 12", {}, unreadable)?.deny).toContain(
			"docs/agents/rules/close-outstanding.txt",
		);
		expect(
			run(
				"gh issue close 12",
				{ issue: { body: "## Acceptance\n\n- [ ] still open\n" } },
				unreadable,
			)?.deny,
		).toContain("docs/agents/rules/ticket-criteria-unticked.txt");
		expect(faults).toEqual([]);
	});
});
