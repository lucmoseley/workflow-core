// @vitest-environment node
/*
 * lib/push-rules.js, guard-push-rules.js's core (#2785), in process: which
 * pushes are handed which rules, and when the review warn rides ahead of them.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeTreeClassifier } from "./git-tree-fake.js";
import { kitContextFake } from "./kit-context-fake";

type Answer =
	| "none"
	| "standard"
	| "escalated"
	| "rejected"
	| "rejectedEscalated";
type Owed = Record<string, string> | null;
type Decision = {
	injectRules?: string[];
	skip?: string[];
	prelude?: string;
	latchAfter?: string;
	latchWrites?: { name: string; text: string }[];
} | null;

const { decide } = require("./push-rules.js") as {
	decide: (command: string, ctx: object) => Decision;
};

const { ANSWERS, fakeReviewOwed } = require("./push-review-fake.js") as {
	ANSWERS: Record<Answer, Owed>;
	fakeReviewOwed: (a: Answer) => (tree: string) => Owed;
};
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string) => string;
};

const SHARED = "/repo";
const LINKED = "/repo-wt";
const ELSEWHERE = "/other";
const SID = "s1";

const ALL = [
	"push-cadence",
	"push-cadence-landing",
	"push-green-suite",
	"vercel-build-on-push",
	"ci-status-lag",
	"ci-status-lag-landing",
];

interface Over {
	modules?: string[];
	answer?: Answer;
	told?: string[];
	latches?: Record<string, string>;
	markerSum?: string;
	pushOwesCertificate?: boolean;
	deploysVercel?: boolean;
	hasSweep?: boolean;
	cwd?: string;
	vars?: Record<string, string>;
}

const treeClass = fakeTreeClassifier({
	[SHARED]: "shared",
	[LINKED]: "linked",
});

/** A context of fakes: a host meeting every premise, `landing` off. */
function harness(over: Over = {}) {
	const logs: string[] = [];
	const reviewed: string[] = [];
	const owed = fakeReviewOwed(over.answer ?? "none");
	const ctx = kitContextFake({
		fallbackCwd: over.cwd ?? SHARED,
		vars: over.vars ?? {},
		isDir: () => true,
		moduleOn: (m) => (over.modules ?? ["suites"]).includes(m),
		treeClass,
		log: (what, detail) => logs.push(detail ? `${what}\t${detail}` : what),
		told: (id) => (over.told ?? []).includes(id),
		readLatch: (name) => over.latches?.[name] ?? null,
		sessionId: SID,
		reviewOwed: (tree: string) => {
			reviewed.push(tree);
			return owed(tree);
		},
		markerSum: () => over.markerSum ?? "",
		pushOwesCertificate: () => over.pushOwesCertificate ?? true,
		deploysVercel: () => over.deploysVercel ?? true,
		hasSweep: () => over.hasSweep ?? true,
	});
	return { ctx, logs, reviewed };
}

/** The ids a decision hands over: requested, less skipped. */
const handed = (d: Decision) =>
	(d?.injectRules ?? []).filter((id) => !(d?.skip ?? []).includes(id));

const run = (command: string, over: Over = {}) =>
	decide(command, harness(over).ctx);

describe("a push is handed its rules, and refused nothing", () => {
	it.each([
		["git push origin main", "the spelling the conventions prescribe"],
		["git push", "the bare form"],
		["git push --force origin main", "a force-push is still a push"],
		["git -C . push", "reached through git's own -C"],
		["npm run test && git push origin main", "the tail of a chain"],
		["git push origin :old", "a ref deletion is a push"],
	])("%s is handed the rules — %s", (command) => {
		const d = run(command);
		expect(d).not.toHaveProperty("deny");
		expect(handed(d)).toEqual([
			"push-cadence",
			"push-green-suite",
			"vercel-build-on-push",
			"ci-status-lag",
		]);
	});

	it("requests every id this trigger owns, in priority order, and no others", () => {
		// The cap is per call, so a blanket request would spend it on whatever
		// the store held; push-cadence first carries the recipe.
		expect(run("git push origin main")?.injectRules).toEqual(ALL);
	});

	it("a push from a linked worktree is handed them too (mantahostels#1213)", () => {
		expect(handed(run("git push origin main", { cwd: LINKED }))).toContain(
			"push-cadence",
		);
	});
});

describe("things that are not a push of this repo", () => {
	it.each([
		["git push --help", "documentation pushes nothing"],
		["git push -h", "the short spelling of it"],
		[
			"git push --dry-run",
			"a rehearsal pushes nothing, and would burn the latch",
		],
		["git push -n origin main", "git push's own short spelling of it"],
		["git status", "not a push at all"],
		["git commit -m 'x' -- a.md", "a commit is #1647's trigger, not this one"],
		["echo 'run git push origin main when green'", "prose about a push"],
		["grep -r 'git push' scripts", "a search for one"],
		["timeout 60 git push origin main", "a segment's own first word is read"],
		['git "push" origin main', "a quoted subcommand is not the one asked for"],
	])("%s is handed nothing — %s", (command) => {
		expect(run(command)).toBeNull();
	});

	it("a push in another repo is none of this guard's business", () => {
		expect(run("git push origin main", { cwd: ELSEWHERE })).toBeNull();
	});

	it('a rehearsal through an unresolved tree is not handed them either — git -C "$W" push --dry-run', () => {
		expect(run('git -C "$W" push --dry-run')).toBeNull();
	});
});

describe("a push whose tree it cannot resolve is handed the rules (#319)", () => {
	it('git -C "$W" push, with W unset, is handed them, and nothing is logged', () => {
		const { ctx, logs } = harness();
		expect(handed(decide('git -C "$W" push origin main', ctx))).toContain(
			"push-cadence",
		);
		expect(logs).toEqual([]);
	});

	it("its review is read at the repo root, the tree handed over as empty", () => {
		const { ctx, reviewed } = harness();
		decide('git -C "$W" push origin main', ctx);
		expect(reviewed).toEqual([""]);
	});
});

describe("an assignment before the first || is read, so the push's tree is judged (#328)", () => {
	// #319's shape: its only `||` comes after `W=`, so W resolves.
	const shape = (w: string) =>
		`W=${w} && S=m && case "$S" in *) [ -n "$S" ] || exit 1;; esac && git -C $W push origin "$S":main`;

	it("a push from a linked worktree is handed them, its review read there", () => {
		const { ctx, reviewed } = harness();
		expect(handed(decide(shape(LINKED), ctx))).toContain("push-cadence");
		expect(reviewed).toEqual([LINKED]);
	});

	it("a push from another repo is handed nothing", () => {
		expect(run(shape(ELSEWHERE))).toBeNull();
	});
});

describe("each rule goes only to a host meeting its premise (#742)", () => {
	it.each([
		[
			"push-green-suite",
			{ pushOwesCertificate: false },
			"no certificate owed (#758)",
		],
		["push-green-suite", { modules: [] }, "suites off"],
		["vercel-build-on-push", { deploysVercel: false }, "no Vercel deploy"],
		["ci-status-lag", { hasSweep: false }, "no scheduled sweep"],
	] as [string, Over, string][])("%s is withheld on %j — %s", (id, over) => {
		const d = run("git push origin main", over);
		expect(handed(d)).not.toContain(id);
		expect(handed(d)).toContain("push-cadence");
	});

	it("a host meeting no premise is handed the cadence alone", () => {
		expect(
			handed(
				run("git push origin main", {
					modules: [],
					pushOwesCertificate: false,
					deploysVercel: false,
					hasSweep: false,
				}),
			),
		).toEqual(["push-cadence"]);
	});
});

describe("the landing module swaps in the landing route's texts (#2409)", () => {
	it("hands the -landing twins, and none of today's texts, with it on", () => {
		expect(
			handed(
				run("git push origin main:landing", { modules: ["suites", "landing"] }),
			),
		).toEqual([
			"push-cadence-landing",
			"vercel-build-on-push",
			"ci-status-lag-landing",
		]);
	});

	it("the CI-lag twin owes no sweep", () => {
		expect(
			handed(
				run("git push origin main:landing", {
					modules: ["suites", "landing"],
					hasSweep: false,
				}),
			),
		).toContain("ci-status-lag-landing");
	});
});

describe("pushed code no review covers is warned of, never refused (#1163)", () => {
	const warn = "no code review covers";
	const marker = `.claude/tmp/markers/.codereview-pass-${SID}`;

	it("is silent where no review is owed, setting no latch", () => {
		const d = run("git push origin main", { answer: "none" });
		expect(d?.prelude).toBeUndefined();
		expect(d?.latchAfter).toBeUndefined();
		expect(d?.latchWrites).toBeUndefined();
	});

	it("warns ahead of the rules, in the adapter's words, with the push still proceeding", () => {
		const o = ANSWERS.standard as Record<string, string>;
		const d = run("git push origin main", { answer: "standard" });
		expect(d).not.toHaveProperty("deny");
		expect(d?.prelude).toBe(
			`This push carries code this session changed (${o.files}) that no code review covers (#1163). ${o.tierLine} Run the code-review skill with fixed point ${o.base} now, before pushing again; its closing step runs node ${o.markerScript}, which writes ${marker}. This warn is said once a session, once more if the change turns escalated, and again for each marker written after a warn that is rejected.`,
		);
		expect(handed(d)).toContain("push-cadence");
	});

	it("quotes the validator's fault where the marker is rejected", () => {
		const d = run("git push origin main", { answer: "rejected" });
		expect(d?.prelude).toMatch(
			new RegExp(
				`^The marker ${marker.replaceAll(".", "\\.")} was rejected — its base= is not a 40-hex sha, 'main' — so it counts as no review\\. This push`,
			),
		);
	});

	it("names the marker lines an escalated change adds", () => {
		expect(run("git push", { answer: "escalated" })?.prelude).toContain(
			`which writes ${marker}. On this escalated change, record it with --tier escalated`,
		);
	});

	it("latches the standard warn, and records the marker it saw beside it", () => {
		const d = run("git push", { answer: "standard", markerSum: "abc" });
		expect(d?.latchAfter).toBe("push-review-warn");
		expect(d?.latchWrites).toEqual([
			{ name: "sum.push-review-warn", text: "abc" },
		]);
	});

	it("warns once a session", () => {
		expect(
			run("git push", { answer: "standard", told: ["push-review-warn"] })
				?.prelude,
		).toBeUndefined();
	});

	// #1696: one latch a tier.
	it("warns again when a range warned of at the standard tier turns escalated, and then no more", () => {
		const d = run("git push", {
			answer: "escalated",
			told: ["push-review-warn"],
		});
		expect(d?.prelude).toContain(warn);
		expect(d?.latchAfter).toBe("push-review-warn-escalated");
		const after = harness({
			answer: "escalated",
			told: ["push-review-warn", "push-review-warn-escalated"],
		});
		expect(decide("git push", after.ctx)?.prelude).toBeUndefined();
		// Told escalated with the marker unchanged: the adapter is not even asked.
		expect(after.reviewed).toEqual([]);
	});

	it("an escalated warn already said covers a standard one", () => {
		expect(
			run("git push", {
				answer: "standard",
				told: ["push-review-warn-escalated"],
			})?.prelude,
		).toBeUndefined();
	});

	// #1840: the marker's checksum beside the latches tells a new marker apart.
	it.each([
		["rejected", "push-review-warn", 1],
		["rejectedEscalated", "push-review-warn-escalated", 2],
	] as const)(
		"on the %s answer, warns again for each rejected marker written after the warn, and not for one unchanged",
		(answer, latch, latched) => {
			const told = ["push-review-warn", "push-review-warn-escalated"].slice(
				0,
				latched,
			);
			const fresh = run("git push", {
				answer,
				told,
				markerSum: "new",
				latches: { "sum.push-review-warn": "old" },
			});
			expect(fresh?.prelude).toContain(
				`was rejected — ${ANSWERS[answer]?.passFault}`,
			);
			expect(fresh?.latchAfter).toBe(latch);
			expect(fresh?.latchWrites).toEqual([
				{ name: "sum.push-review-warn", text: "new" },
			]);
			expect(
				run("git push", {
					answer,
					told,
					markerSum: "new",
					latches: { "sum.push-review-warn": "new" },
				})?.prelude,
			).toBeUndefined();
		},
	);

	it("a new marker that passes rearms nothing", () => {
		expect(
			run("git push", {
				answer: "standard",
				told: ["push-review-warn"],
				markerSum: "new",
				latches: { "sum.push-review-warn": "old" },
			})?.prelude,
		).toBeUndefined();
	});

	it("a marker first seen, with no checksum yet recorded, counts as changed", () => {
		expect(
			run("git push", {
				answer: "rejected",
				told: ["push-review-warn"],
				markerSum: "abc",
			})?.prelude,
		).toContain("was rejected");
	});

	it("reads the push's own tree, the first one resolved", () => {
		const { ctx, reviewed } = harness({ answer: "standard" });
		decide(`git -C ${LINKED} push && git push`, ctx);
		expect(reviewed).toEqual([LINKED]);
	});
});

/*
 * MUTATION ANCHORS. A row reads the ONE fragment its block names, its
 * whitespace collapsed, so a reflow cannot fail it and a cut clause does
 * (mantahostels#2226).
 */
const carries = (id: string, clause: string) =>
	expect(readRuleText(id).replace(/\s+/g, " ")).toContain(clause);

describe("the injected rules still carry their operative clauses", () => {
	it("a clause no fragment carries fails", () => {
		expect(() =>
			carries("push-cadence", "a clause no fragment carries"),
		).toThrow();
	});

	it.each([
		["EVERY commit on `main`", "whose work a push sends"],
		["never write `result:`", "what a successful push does not license"],
		["says nothing about the suite", "why it does not"],
	])("push-cadence keeps %s — %s", (clause) => {
		carries("push-cadence", clause);
	});

	it("push-cadence keeps its recipe as the host's own commands, in order", () => {
		// Read raw: the accessor expands the placeholders against whichever host
		// runs the suite (#742).
		const raw = fs.readFileSync(
			path.resolve(__dirname, "../../docs/agents/rules/push-cadence.txt"),
			"utf8",
		);
		expect(raw.replace(/\s+/g, " ")).toContain(
			"{command:push_check} {command:typecheck} {command:check} <the edited file's own checker> git push origin main",
		);
	});

	it.each([
		["npm run test:py", "the second recorded run"],
		["#1256", "the ticket that stamped a run with its sha"],
		["worktree", "where it also fires"],
		["Never blocks", "what it does not do"],
		[
			"CERTIFICATES OF FULL OR ADMISSIBLE `npm run test` RUNS",
			"the run the gate now asks for",
		],
		// Admissibility turns on the argv too (#998).
		["a read graph that renders", "what admissibility turns on"],
		["no full run is owed", "the whole-suite limb #2207 deleted"],
		[
			"Certificate keyed to HEAD at run END",
			"why a run over uncommitted work attests the wrong commit",
		],
		["to the tree it read", "the content key #189 added beside the sha"],
		["attested by tree", "how the push says which key matched"],
		// mantahostels#3210: the merge-base default sees the unpushed commits.
		["merge-base(HEAD, origin/main)", "the base the default diffs against"],
		["#2131", "the hole the gate cannot see, now that it is the only gate"],
		["#2031", "the ticket that ruled a filtered run is not a full one"],
	])("push-green-suite keeps %s — %s", (clause) => {
		carries("push-green-suite", clause);
	});

	it.each([
		["CI RUNS NO `next build`", "the fact the whole rule turns on"],
		["fails PRODUCTION, not CI", "what a build-only breach costs"],
		["warn-only in pre-commit", "why a clean local run is not a clean gate"],
	])("vercel-build-on-push keeps %s — %s", (clause) => {
		carries("vercel-build-on-push", clause);
	});

	it.each([
		["THIS PUSH DOES NOT TRIGGER A SUITE RUN", "the headline"],
		["#910", "the ticket that unkeyed a run from a push"],
		["npm run check:ci", "the command that asks now"],
		["ONCE after every push", "how often"],
		["never rerun it", "why a second read tells nothing new"],
		["only verdict for up to ~12 hours", "what the local checks are meanwhile"],
		["four a day", "how often the suite actually runs, since a push runs none"],
		["the newest sweep", "the run both answers are keyed to, never your sha"],
	])("ci-status-lag keeps %s — %s", (clause) => {
		carries("ci-status-lag", clause);
	});

	it.each([
		[
			"ONCE THE TESTS YOU TOUCHED PASS",
			"push-cadence-landing",
			"the route's headline",
		],
		[
			"the lander runs the full suite",
			"push-cadence-landing",
			"who runs the full suite",
		],
		["IS TESTED BY THE LANDER", "ci-status-lag-landing", "who tests it"],
	])("the landing twins keep %s — %s, %s", (clause, id) => {
		carries(id, clause);
	});
});
