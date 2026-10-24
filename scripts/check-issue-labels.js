#!/usr/bin/env node
/*
 * check-issue-labels.js — reports routing faults on open issues: a child
 * missing the family its parent fixes, a `takes:` that is absent, duplicated,
 * contradicted by the issue's own kind, or gone stale, a `**Gated on:**`
 * whose condition is the founder typing a slash command (#411), a gate
 * line carrying no `**Gate basis:**` (#577), a `kind:brief` still holding
 * the spec it should have handed up to its map (#609), and a ticket left
 * `**Blocked` in a comment alone, which the shortlist cannot read (#2309).
 *
 * `takes:` says which command opens the issue, and every open issue carries
 * exactly one — so absence is a defect, not a state meaning "/triage it"
 * (docs/agents/triage-labels.md §`takes:`). This is its only reader (mantahostels#227).
 *
 * A child of a `wayfinder:map` takes a `wayfinder:<type>`; a child of a
 * `kind:spec` takes `kind:ticket`.
 *
 * Prevention on the Bash route is scripts/guard-issue-create-label.sh, which
 * denies a `gh issue create` carrying no `takes:` label, or one outside the
 * seven (mantahostels#453). That hook sees Bash tool calls only, so
 * this script is the sole control for the three routes it cannot reach: a
 * script, the GitHub web UI, and `gh api --method POST …/issues`.
 *
 * THIS SCRIPT NEVER WRITES: the parent fixes the *family*, never the member.
 * `wayfinder:grilling` versus `wayfinder:task` is a judgement about how the
 * ticket will be resolved, and a script guessing it would assert one nobody made.
 * Same for a `takes:` — mantahostels#136 (nothing asks a mid-session issue for its labels)
 * ruled the label not always knowable at creation.
 *
 * RULES BELOW ARE MIRRORED IN BASH, in scripts/place-new-issue.sh's label block —
 * unavoidable across the hook seam. Change the scoping in one and change it in
 * the other, or the prompt asks for a label this check does not want.
 *
 * Parentage and labels both come off the issues list, and never off each issue's
 * /sub_issues: that is one call per issue and defaults to per_page=30. The one
 * exception is STALE-CONTAINER, which means no open child in ANY repository:
 * the list holds this repo's issues alone, so a `takes:children` with no open
 * child in it has its own /sub_issues read, every page, before it is reported
 * (#778). PROSE-BLOCKED is the other: each open issue with comments has
 * its latest comment read, and one opening `**Blocked` with no gate line its
 * `blocked_by` edges.
 *
 * NEVER THE WHOLE TRACKER (mantahostels#1899). check-issue-orphans.js reads ghAllIssues;
 * this one must not. The scan below reads open issues only, plus the
 * closed rows carrying a RULES parent label, which is the one thing an open-only
 * read would otherwise lose: a closed parent still fixes its open child's label
 * family. Both extra calls are skipped when every parent is already in hand.
 *
 * Usage: node check-issue-labels.js [--warn] [--json] [--notify]
 *
 * --notify is the quiet path, wired to nothing:
 * silent unless there is a finding, exit 0 whatever the outcome, and — alone
 * in the family — capped, naming NOTIFY_CAP offenders per list and counting
 * the rest.
 *
 * Outcomes follow the family alphabet in scripts/lib/check.js: an unreachable
 * GitHub is SKIP (exit 0), any other gh failure is BROKEN (exit 2, mantahostels#164 —
 * the ticket that drew that line), and an
 * unlabelled child is a FAIL finding (exit 1, or 0 under --warn).
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), asks GitHub for the open issues — and for the sub-issues of each `takes:children` with no open child among them — and reports label faults — an absent, duplicated, contradicted or stale `takes:`, a `takes:human` naming no outside act, naming a repo file as its product, lacking a `**Close when:**` line, or untouched for 14 days, a `**Gated on:**` whose condition is the founder typing a slash command, a gate line with no `**Gate basis:**`, a brief still holding its spec, a latest comment opening `**Blocked` on an issue with no open blocker and no holding gate line, and a child missing its parent's family.
 * JUSTIFIED: fail-safe — an issue with no `takes:` is routed to no command, and every reader of the label reads it rather than fixing it.
 * DEFEAT:    none; --notify is silent when no open issue carries a fault.
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { hostRoot } = require("./lib/host-root");
const { resolveGate } = require("./lib/issue-gate");
const {
	errLine,
	ghClosedIssuesWithLabel,
	ghFailureReason,
	ghGetRetrying,
	ghOpenIssues,
	ISSUE_READ_CONCURRENCY,
	mapLimit,
	raiseGhFailure,
} = require("./lib/gh");
const { isOpenChild, localParentOf, subIssuesOf } = require("./lib/issue-tree");
const { scriptPath } = require("./lib/script-path");
const {
	CLOSE_WHEN_LINE,
	CLOSE_WHEN_MARKER,
	OUTSIDE_MARKER,
	TAKES_VALUES,
	TRIED_MIN,
	outsideLineFault,
	NO_COMMAND_VALUES,
	takesLabel,
} = require("./lib/takes-label");

const HUMAN_LABEL = takesLabel("human");
const CHILDREN_LABEL = takesLabel("children");

/*
 * A `**Gated on:**` whose condition is the founder typing a slash command
 * (#411). The premise is false — `disable-model-invocation` bars the Skill
 * tool only, and scripts/dispatch-sessions.sh types the prompt — yet
 * pick-next.js holds a gated issue out of the frontier and no judge can read
 * that condition met, so the one sentence silently stops dispatch. No part of the
 * match may cross a sentence. Read on a well-formed condition only: a
 * malformed gate holds nothing (scripts/lib/issue-gate.js resolveGate).
 *
 * Unseen, and accepted: the passive ("`/to-spec` is typed by the founder"),
 * a verb outside the list, and an actor other than "founder". The slash word
 * must be a real command (isCommand below), so a path or product route
 * (`/tmp`, `/book`) passes.
 */
const FOUNDER_COMMAND_GATE =
	/\bfounder\b[^—.;]*?\b(types?|typing|runs?|running|invokes?|fires?|launches?)\b[^—.;]*?[\s`(]\/([a-z][a-z0-9-]*)/i;
/* The commands a `takes:` value names: every value but the two no command opens. */
const TAKES_COMMANDS = new Set(
	TAKES_VALUES.filter((v) => !NO_COMMAND_VALUES.includes(v)),
);
/** @type {Record<NonNullable<ReturnType<typeof outsideLineFault>>["fault"] | "NO-CLOSE-WHEN", [string, string]>} */
const HUMAN_FAULTS = {
	"NO-OUTSIDE-ACT": [
		`takes:human whose body has no \`${OUTSIDE_MARKER}\` line naming the act`,
		"add the line naming the act, or relabel it if you cannot name one",
	],
	"BARRED-NOT-IMPOSSIBLE": [
		"takes:human whose Outside line names a prohibition rather than an act",
		"test the bar rather than restating it — `test -w <path>`, or read the rule; a real bar is takes:wayfinder, an unreal one takes:implement",
	],
	"REPO-FILE-ACT": [
		"takes:human whose outside act produces a file in this repository",
		"an agent writes the file and the founder reviews it — relabel takes:implement, or takes:wayfinder for the review",
	],
	"NOT-A-FOUNDER-ACT": [
		`takes:human whose Outside line names none of the founder's own acts, and whose body lists no ${TRIED_MIN} methods tried`,
		`name the act from the list in docs/agents/triage-labels.md §\`takes:\`, or add a \`Tried:\` list of at least ${TRIED_MIN} methods run; neither true, an agent can do it — relabel takes:implement (#1077)`,
	],
	"NO-CLOSE-WHEN": [
		`takes:human whose body has no \`**${CLOSE_WHEN_MARKER}**\` line saying what finishes it`,
		`append the line — what finishes it, and what the closing comment records (${scriptPath("lib/rule-text.sh")} founder-deliverable)`,
	],
};

/** @param {string} name */
const isCommand = (name) =>
	TAKES_COMMANDS.has(name) ||
	fs.existsSync(path.join(hostRoot(), ".claude", "skills", name)) ||
	fs.existsSync(path.join(hostRoot(), ".claude", "commands", `${name}.md`));

/* The cadence check-stale-claims.js already uses for an issue nobody has
 * touched (mantahostels#3358). */
const HUMAN_REVIEW_DAYS = 14;
/* A missing or unparseable stamp yields NaN, which no comparison passes — so
 * it never warns — unreachable in practice, GitHub's REST rows always carrying
 * `updated_at`. */
/** @param {string} iso */
const ageDays = (iso) => (Date.now() - Date.parse(iso)) / 86_400_000;

/**
 * The two report rows. Both carry the issue's own labels in `has`, which is
 * what the printed line quotes back.
 *
 * @typedef {import("./lib/check").CheckContext} Ctx
 * @typedef {{number: number, title: string, url: string, has: string[],
 *   severity: string, tag: string, says: string, fix: string}} TakesFault
 * @typedef {{number: number, title: string, url: string, has: string[],
 *   parent: number, parentLabel: string, needs: string}} Unlabelled
 */

/*
 * Each rule: a label on the parent that fixes a family, and the prefix a child
 * must carry from it. `kind:ticket` is an exact name rather than a prefix
 * because `kind:` has other members a child of a spec must not take.
 */
/** A step on a map's route: any `wayfinder:` label. */
const isRouteStep = (/** @type {string[]} */ l) =>
	l.some((n) => n.startsWith("wayfinder:"));

const RULES = [
	{
		parent: "wayfinder:map",
		/*
		 * A spec under a map is a structural node, not a step on the route, so it
		 * takes no type. A nested map needs no clause here — `wayfinder:map` is
		 * itself in the family. A `kind:brief` is exempt the
		 * same way: the hand-off an exhausted map files per deliverable, awaiting
		 * its spec (#578). Both exemptions are copied into place-new-issue.sh and
		 * file-issue.js.
		 */
		exempt: (/** @type {string[]} */ l) =>
			l.includes("kind:spec") || l.includes("kind:brief"),
		wants: isRouteStep,
		needs: "a wayfinder:<type> (research / prototype / grilling / task)",
	},
	{
		parent: "kind:spec",
		wants: (/** @type {string[]} */ l) => l.includes("kind:ticket"),
		needs: "kind:ticket",
	},
];

/*
 * Combinations no `takes:` value can be right in — NOT every disagreement with
 * another label. A `takes:` deliberately overrides one that merely disagrees
 * (mantahostels#172 is `wayfinder:task` and takes /implement).
 */
const CONTRADICTIONS = [
	{
		has: "kind:spec",
		takes: takesLabel("implement"),
		why: "a spec is a parent document, not a unit of work",
	},
	{
		has: "kind:spec",
		takes: takesLabel("to-spec"),
		why: "it is already a spec",
	},
	/*
	 * NOT listed: `kind:ticket` with `takes:to-tickets`. An oversized ticket
	 * really can need breaking up, so the override rule covers it.
	 */
	/*
	 * Only while a step of the route is still open. A map whose every open child
	 * is a spec or a brief is exhausted, and `takes:children` is its right value
	 * (#578).
	 */
	{
		has: "wayfinder:map",
		takes: CHILDREN_LABEL,
		when: (/** @type {{ openSteps: number }} */ s) => s.openSteps > 0,
		why: "/wayfinder works the map itself while any open child carries a wayfinder:<type>",
	},
	/*
	 * A finding is discharged by `manual-sync` in full mode, so it is never work
	 * done outside Claude Code (mantahostels#2810, mantahostels#3146). Only
	 * `takes:human` is wrong: report-manual-staleness.js files its own findings
	 * `takes:triage`, which this entry leaves alone.
	 */
	{
		has: "manual-finding",
		takes: HUMAN_LABEL,
		why: "a full manual-sync run discharges it, inside Claude Code",
	},
];

/** @param {string[]} names */
const takesOf = (names) => names.filter((n) => n.startsWith("takes:"));

/*
 * How many offenders --notify names before it stops, sized for a SessionStart
 * hook's stdout (mantahostels#1148, which capped it). Every other path
 * prints the lot — there a human is working the whole list. Findings are never
 * capped: --json and the Actions annotations still carry all of them.
 */
const NOTIFY_CAP = 3;

/* FAIL before WARN, so the slots the cap leaves go to what gates. */
/** @param {TakesFault[]} list */
const gatingFirst = (list) =>
	[...list].sort(
		(a, b) => (a.severity === "WARN" ? 1 : 0) - (b.severity === "WARN" ? 1 : 0),
	);

/**
 * Print one finding per line via `line`, capping the list under --notify and
 * saying how many were withheld. The recipe carries --warn: without it the
 * rerun exits 1 on the very findings it was asked to show.
 *
 * @template T
 * @param {Ctx} ctx
 * @param {T[]} list
 * @param {(i: T) => string} line
 */
const sayCapped = (ctx, list, line) => {
	const shown = ctx.notify ? list.slice(0, NOTIFY_CAP) : list;
	for (const i of shown) ctx.say(line(i));
	const rest = list.length - shown.length;
	if (rest)
		ctx.say(
			`  … and ${rest} more — node scripts/${path.basename(__filename)} --warn to see them all.`,
		);
};

/**
 * @param {any} iss A GitHub issue as the API returns it.
 * @returns {string[]}
 */
const namesOf = (iss) =>
	(iss.labels || []).map((/** @type {any} */ l) => l.name || l);

/**
 * The closed parents `issues` lacks.
 * @param {any[]} issues
 * @returns {any[]}
 */
function closedParents(issues) {
	/*
	 * The parents the open set does not already contain — closed, by
	 * elimination. Fetched by RULES label rather than by number: one call per
	 * label whatever the count, against one call per parent that grows with
	 * the backlog. A parent carrying neither label constrains nothing, so a
	 * fetch that misses it costs no finding.
	 */
	const inHand = new Set(
		issues.filter((i) => !i.pull_request).map((i) => i.number),
	);
	const missing = issues.some((i) => {
		if (i.pull_request) return false;
		const p = localParentOf(i);
		return p !== null && !inHand.has(p);
	});
	if (!missing) return [];
	const parents = [];
	for (const rule of RULES)
		for (const iss of ghClosedIssuesWithLabel(rule.parent))
			if (!inHand.has(iss.number)) {
				inHand.add(iss.number);
				parents.push(iss);
			}
	return parents;
}

/**
 * The open issues, plus the closed parents a RULES label makes matter.
 * @returns {any[]}
 */
function readIssues() {
	/** @type {any[]} */
	let issues = [];
	try {
		const open = ghOpenIssues();
		issues = [...open, ...closedParents(open)];
	} catch (e) {
		raiseGhFailure(e);
	}
	return issues;
}

/*
 * Open LOCAL children per issue, counted structurally rather than read off
 * a label — the only way to see a `takes:children` whose last child
 * closed.
 */
/** @param {any[]} issues */
function countOpenChildren(issues) {
	/** @type {Map<number, number>} */
	const openChildren = new Map();
	/** @type {Map<number, number>} */
	const openSteps = new Map();
	/** @type {Map<number, number>} */
	const openSpecs = new Map();
	for (const iss of issues) {
		if (iss.pull_request || iss.state !== "open") continue;
		const p = localParentOf(iss);
		if (!p) continue;
		openChildren.set(p, (openChildren.get(p) || 0) + 1);
		const names = namesOf(iss);
		if (isRouteStep(names)) openSteps.set(p, (openSteps.get(p) || 0) + 1);
		if (names.includes("kind:spec"))
			openSpecs.set(p, (openSpecs.get(p) || 0) + 1);
	}
	return { openChildren, openSteps, openSpecs };
}

/** @typedef {ReturnType<typeof countOpenChildren>} ChildCounts */
/** @typedef {(severity: string, tag: string, says: string, fix: string) => void} Raise */

/**
 * @param {any} iss
 * @param {string[]} own
 * @param {TakesFault[]} takesFaults accumulator: each fault the raiser is
 *   called with is pushed here
 * @returns {Raise}
 */
const faultRaiser = (iss, own, takesFaults) => (severity, tag, says, fix) => {
	takesFaults.push({
		number: iss.number,
		title: iss.title,
		url: iss.html_url,
		has: own,
		severity,
		tag,
		says,
		fix,
	});
};

/** @param {string[]} own @param {Raise} raise */
function checkTakesCount(own, raise) {
	const takes = takesOf(own);
	if (takes.length === 0)
		raise(
			"FAIL",
			"NO-TAKES",
			"no takes: label — nothing says which command opens it",
			"/triage it, or add the takes: value you would type",
		);
	else if (takes.length > 1)
		raise(
			"FAIL",
			"MANY-TAKES",
			`carries ${takes.join(", ")} — exactly one says what to type`,
			"drop all but the one that opens it",
		);
}

/** @param {string[]} own @param {number} openSteps @param {Raise} raise */
function checkContradictions(own, openSteps, raise) {
	const steps = { openSteps };
	for (const c of CONTRADICTIONS)
		if (
			own.includes(c.has) &&
			own.includes(c.takes) &&
			(!c.when || c.when(steps))
		)
			raise(
				"FAIL",
				"CONTRADICTED",
				`${c.takes} on a ${c.has} — ${c.why}`,
				"change whichever of the two is wrong",
			);
}

/** @param {any} iss @param {string[]} own @param {Raise} raise */
function checkHumanBody(iss, own, raise) {
	/*
	 * The create guard asks this line of a new takes:human body (mantahostels#2775) and
	 * of a takes:human applied by `gh issue edit --add-label` (mantahostels#3555), but
	 * misses a GraphQL or script create and a body it cannot parse. No issue
	 * is exempt (mantahostels#3352). The Close-when line is judged only once
	 * the Outside line passes, in the guard's order (#983).
	 */
	const isHumanErrand = own.includes(HUMAN_LABEL);
	const humanBody = String(iss.body ?? "");
	const human = isHumanErrand ? outsideLineFault(humanBody) : null;
	if (human) raise("FAIL", human.fault, ...HUMAN_FAULTS[human.fault]);
	else if (isHumanErrand && !CLOSE_WHEN_LINE.test(humanBody))
		raise("FAIL", "NO-CLOSE-WHEN", ...HUMAN_FAULTS["NO-CLOSE-WHEN"]);
}

/** @param {any} iss @param {Raise} raise */
function checkGates(iss, raise) {
	const gates = resolveGate(iss.body);
	const typed = FOUNDER_COMMAND_GATE.exec(
		gates.gateOn?.condition ?? "",
	)?.[2]?.toLowerCase();
	if (typed && isCommand(typed))
		raise(
			"FAIL",
			"COMMAND-GATE",
			`gated on the founder typing /${typed} — a dispatched session types it too, so the gate only stops dispatch`,
			TAKES_COMMANDS.has(typed)
				? `relabel takes:${typed} and delete the Gated on line`
				: "delete the Gated on line and give it the takes: value of the command that opens it",
		);
	/*
	 * A WARN (#577): a gate without a basis still routes correctly. A
	 * malformed or conflicting gate is pick-next.js's to report.
	 */
	/** @type {string | null} */
	let marker = null;
	if (gates.gateOnHolds) marker = "Gated on";
	else if (!gates.conflict && gates.gate && !gates.gate.malformed)
		marker = "Gated until";
	if (marker && !gates.basis)
		raise(
			"WARN",
			"NO-GATE-BASIS",
			`**${marker}:** line with no \`**Gate basis:**\` — nothing says what data sets its date or window`,
			`add \`**Gate basis:** <the data that sets it, and why nothing sooner fits>\` directly beneath the ${marker} line`,
		);
}

/** @param {any} iss @param {string[]} own @param {Raise} raise */
function checkHumanIdle(iss, own, raise) {
	/*
	 * takes:human is the one value with no command and no reviewer, so a
	 * wrong one is examined by nobody (mantahostels#3358). A WARN, never a FAIL: a
	 * genuine errand (pay, sign, email) can legitimately wait longer than
	 * this. `updated_at` moves on any comment, label or body touch, so a
	 * relabel or a sweep's edit restarts the clock without a look — this
	 * asks for one, it never proves one happened.
	 */
	const idleDays = ageDays(iss.updated_at);
	if (own.includes(HUMAN_LABEL) && idleDays >= HUMAN_REVIEW_DAYS)
		raise(
			"WARN",
			"HUMAN-UNREVIEWED",
			`takes:human untouched for ${Math.floor(idleDays)} days — re-test the outside act`,
			"try an in-session route (a 403 names one permission, not the act); where the act is a multi-step walk, walk it with the founder in chat as a founder hand-over (docs/agents/triage-labels.md §`takes:`); comment with what you tried, or relabel",
		);
}

/** @param {any} iss @param {Raise} raise */
function checkStaleContainer(iss, raise) {
	/* An unread list could hold the open child, so it reports no
	 * STALE-CONTAINER (#778). */
	/** @type {any[] | null} */
	let kids = null;
	try {
		kids = subIssuesOf(iss.number);
	} catch (e) {
		if (ghFailureReason(e) === "unreachable") raiseGhFailure(e);
		raise(
			"WARN",
			"CHILDREN-UNREADABLE",
			`takes:children with no open child in this repo, and its sub-issues unreadable (${errLine(e)})`,
			`re-run, or read them yourself: gh api repos/{owner}/{repo}/issues/${iss.number}/sub_issues --paginate`,
		);
	}
	if (kids && !kids.some(isOpenChild))
		raise(
			"FAIL",
			"STALE-CONTAINER",
			"takes:children with no open child left to open instead",
			"close it, or give it the takes: its own residual needs",
		);
}

/**
 * @param {any} iss @param {string[]} own @param {number} children
 * @param {Raise} raise
 */
function checkContainer(iss, own, children, raise) {
	if (own.includes(CHILDREN_LABEL) && !children) {
		checkStaleContainer(iss, raise);
	} else if (
		/*
		 * The inverse, and a WARN because it has legitimate cases: an issue
		 * can hold real work of its own alongside open children. A
		 * `wayfinder:map` is the standing one.
		 */
		children &&
		!own.includes(CHILDREN_LABEL) &&
		!own.includes("wayfinder:map")
	)
		raise(
			"WARN",
			"UNMARKED-CONTAINER",
			`${children} open child(ren) but no takes:children`,
			"label it takes:children if nothing here is workable itself",
		);
}

/**
 * @param {any} iss @param {string[]} own @param {number} specs
 * @param {Raise} raise
 */
function checkSpeccedBrief(iss, own, specs, raise) {
	/*
	 * A WARN: the pair still routes correctly, the spec by its own takes:.
	 * What is lost is the map listing the spec rather than a placeholder
	 * (#606).
	 */
	if (own.includes("kind:brief") && specs)
		raise(
			"WARN",
			"SPECCED-BRIEF",
			"kind:brief still holding its open kind:spec — the move up under its map was never run",
			/* promote-spec.js refuses a brief with more than one spec child. */
			specs === 1
				? `check the brief's rulings are in the spec body, then \`node scripts/promote-spec.js ${iss.number}\``
				: `${specs} open kind:spec children — close or re-parent all but one by hand, then \`node scripts/promote-spec.js ${iss.number}\``,
		);
}

/**
 * Every `takes:` and gate fault on one open issue, raised in report order.
 * @param {any} iss @param {string[]} own @param {ChildCounts} counts
 * @param {Raise} raise
 */
function checkTakesFaults(iss, own, counts, raise) {
	const children = counts.openChildren.get(iss.number) || 0;
	checkTakesCount(own, raise);
	checkContradictions(own, counts.openSteps.get(iss.number) || 0, raise);
	checkHumanBody(iss, own, raise);
	checkGates(iss, raise);
	checkHumanIdle(iss, own, raise);
	checkContainer(iss, own, children, raise);
	checkSpeccedBrief(iss, own, counts.openSpecs.get(iss.number) || 0, raise);
}

/**
 * A row for each RULES family the issue's parent fixes and the issue lacks —
 * or null where the issue has no local parent at all.
 * @param {any} iss @param {string[]} own @param {Map<number, any>} byNumber
 * @returns {Unlabelled[]|null}
 */
function scanParentFamily(iss, own, byNumber) {
	const parentNumber = localParentOf(iss);
	if (parentNumber === null) return null;
	/** @type {Unlabelled[]} */
	const unlabelled = [];
	const parent = byNumber.get(parentNumber);
	if (!parent) return unlabelled;
	const parentLabels = namesOf(parent);
	for (const rule of RULES) {
		if (!parentLabels.includes(rule.parent)) continue;
		if (rule.exempt?.(own)) continue;
		if (rule.wants(own)) continue;
		unlabelled.push({
			number: iss.number,
			title: iss.title,
			url: iss.html_url,
			parent: parent.number,
			parentLabel: rule.parent,
			needs: rule.needs,
			has: own,
		});
	}
	return unlabelled;
}

/** @param {Ctx} ctx @param {Unlabelled[]} unlabelled */
function reportUnlabelled(ctx, unlabelled) {
	for (const i of unlabelled)
		ctx.fail(
			"UNLABELLED",
			`#${i.number} ${i.title} — under #${i.parent} (${i.parentLabel}), needs ${i.needs}`,
			i,
			/* `needs` is in the key and the title is not (mantahostels#2490): a child
			 * re-parented into a different label family owes a DIFFERENT label, so
			 * that is a new finding a reader should be told about. */
			`UNLABELLED\t#${i.number}\t${i.needs}`,
		);

	if (unlabelled.length === 0) return;
	ctx.say(
		`UNLABELLED (${unlabelled.length}) — parent fixes a label family the child does not carry:`,
	);
	sayCapped(
		ctx,
		unlabelled,
		(i) =>
			`  #${i.number} ${i.title}\n    under #${i.parent} (${i.parentLabel}) — needs ${i.needs}\n    carries: ${i.has.length > 0 ? i.has.join(", ") : "no labels at all"}\n    ${i.url}`,
	);
	ctx.say(
		"\n  Pick the member yourself — the parent fixes the family, not the type:\n" +
			"    gh issue edit <child> --add-label <label>\n" +
			"  wayfinder:research is AFK and resolved by a /research subagent;\n" +
			"  prototype and grilling need a human in the loop; task is manual work\n" +
			"  that unblocks a decision. Rules: docs/agents/triage-labels.md.\n",
	);
}

/** @param {Ctx} ctx @param {TakesFault[]} takesFaults */
function reportTakesFaults(ctx, takesFaults) {
	for (const i of takesFaults)
		ctx[i.severity === "WARN" ? "warn" : "fail"](
			i.tag,
			`#${i.number} ${i.title} — ${i.says}`,
			i,
		);

	if (takesFaults.length === 0) return;
	ctx.say(
		`takes: FAULTS (${takesFaults.length}) — which command opens the issue is unreadable or wrong:`,
	);
	sayCapped(
		ctx,
		gatingFirst(takesFaults),
		(i) =>
			`  ${i.tag}  #${i.number} ${i.title}\n    ${i.says}\n    fix: ${i.fix}\n    ${i.url}`,
	);
	ctx.say(
		"\n  Values and what each means: docs/agents/triage-labels.md §takes:.\n" +
			"    gh issue edit <n> --add-label takes:<value> [--remove-label takes:<other>]\n",
	);
}

/*
 * A ticket a launched session found not ready, left with a comment opening
 * `**Blocked` and nothing pick-next.js reads: no open native blocker and no
 * holding gate line (#2309, ruled at #2212). A WARN: the issue still routes.
 * guard-tracker-rules.sh's opens_blocked matches the same opening.
 */
const BLOCKED_COMMENT = /^\s*\*\*Blocked/;

/**
 * The issue's PROSE-BLOCKED fault, or its read failure, as Raise's
 * arguments; null where it has neither.
 * @param {any} iss
 * @returns {Promise<Parameters<Raise> | null>}
 */
async function proseBlockedFault(iss) {
	const gates = resolveGate(iss.body);
	if (gates.gateHolds || gates.gateOnHolds) return null;
	/* The last page at one comment a page is the latest comment. */
	const latest = await ghGetRetrying(
		`repos/{owner}/{repo}/issues/${iss.number}/comments?per_page=1&page=${iss.comments}`,
		{ strict: true },
	);
	if (!latest.ok)
		return [
			"WARN",
			"BLOCKED-UNREADABLE",
			`latest comment unreadable (${latest.error}), so a prose-only Blocked is unjudged`,
			`re-run, or read it yourself: gh api repos/{owner}/{repo}/issues/${iss.number}/comments`,
		];
	/* An empty page is a comment deleted since the list, not a silence. */
	const comment = latest.out.at(-1);
	if (!comment)
		return [
			"WARN",
			"BLOCKED-UNREADABLE",
			"latest comment answered an empty page, so a prose-only Blocked is unjudged",
			`re-run, or read it yourself: gh api repos/{owner}/{repo}/issues/${iss.number}/comments`,
		];
	if (!BLOCKED_COMMENT.test(String(comment.body ?? ""))) return null;
	/* Strict: an empty answer would read as no blocker and raise a false finding. */
	const edges = await ghGetRetrying(
		`repos/{owner}/{repo}/issues/${iss.number}/dependencies/blocked_by`,
		{ strict: true },
	);
	if (!edges.ok)
		return [
			"WARN",
			"BLOCKED-UNREADABLE",
			`latest comment opens **Blocked, and its blockers are unreadable (${edges.error})`,
			`re-run, or read them yourself: gh api repos/{owner}/{repo}/issues/${iss.number}/dependencies/blocked_by`,
		];
	if (edges.out.some((/** @type {any} */ b) => b.state === "open")) return null;
	return [
		"WARN",
		"PROSE-BLOCKED",
		"latest comment opens **Blocked, but no open blocker and no holding gate line — the shortlist offers it again",
		"add a native blocked-by edge to the issue whose work it waits on, filing that issue unassigned first where none exists; or, for an event no issue does, a `**Gated on:** <condition> — check: <command> — abandon if: <clause>` line with `**Gate basis:**` beneath it (waiting:external is not a gate)",
	];
}

/**
 * Raise each issue's PROSE-BLOCKED fault in input order, so the report's order
 * never rides on which read answered first.
 * @param {{iss: any, raise: Raise}[]} commented
 */
async function raiseProseBlocked(commented) {
	const judged = await mapLimit(
		commented,
		ISSUE_READ_CONCURRENCY,
		async (c) => ({
			raise: c.raise,
			fault: await proseBlockedFault(c.iss),
		}),
	);
	for (const { raise, fault } of judged) if (fault) raise(...fault);
}

runCheck({
	name: "issue-labels",
	usage: "node check-issue-labels.js [--warn] [--json] [--notify]",
	async run(/** @type {Ctx} */ ctx) {
		const issues = readIssues();

		/* Keyed by number, holding the issue as the API returns it — `any` because
		 * the row is an untyped API shape and only the `iss.*` fields read
		 * below matter. */
		/** @type {Map<number, any>} */
		const byNumber = new Map();
		for (const iss of issues)
			if (!iss.pull_request) byNumber.set(iss.number, iss);

		const counts = countOpenChildren(issues);

		/** @type {Unlabelled[]} */
		const unlabelled = [];
		/** @type {TakesFault[]} */
		const takesFaults = [];
		/** @type {{iss: any, raise: Raise}[]} */
		const commented = [];
		let scanned = 0;
		let openScanned = 0;
		for (const iss of issues) {
			if (iss.pull_request) continue; // one number space, two kinds of thing
			if (iss.state !== "open") continue;
			openScanned++;
			const own = namesOf(iss);
			const raise = faultRaiser(iss, own, takesFaults);
			checkTakesFaults(iss, own, counts, raise);
			if (iss.comments > 0) commented.push({ iss, raise });
			/* Counted off the link, not off the lookup: a parent carrying no RULES
			 * label is deliberately unfetched above, and reporting it as un-scanned
			 * would read as a gap in coverage rather than as nothing to check. */
			const rows = scanParentFamily(iss, own, byNumber);
			if (rows) {
				scanned++;
				unlabelled.push(...rows);
			}
		}

		await raiseProseBlocked(commented);

		/*
		 * Not under --notify, built for a SessionStart hook: a scan summary with
		 * nothing to report is a line every session would pay for and none acts
		 * on. The findings below still speak there.
		 */
		if (!ctx.notify)
			ctx.say(
				`Checked ${openScanned} open issue(s) for a takes: fault, ${scanned} of them with a parent to inherit a label family from.\n`,
			);

		reportUnlabelled(ctx, unlabelled);
		reportTakesFaults(ctx, takesFaults);

		return {
			okLine:
				"every open issue carries one takes:, and every child the label family its parent fixes.",
			noun: "label fault(s) on open issues",
			data: {
				unlabelled,
				unlabelledCount: unlabelled.length,
				takesFaults,
				takesFaultCount: takesFaults.length,
				scanned,
				openScanned,
			},
		};
	},
});
