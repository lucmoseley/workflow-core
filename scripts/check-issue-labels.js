#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { isRouteStep } = require("./lib/decision-labels");
const { worktreeRoot } = require("./lib/host-root");
const {
	resolveGate,
	citedSays,
	recomputedSays,
	judgeOverrideOf,
	overrideFingerprint,
	overrideReviewOf,
	overrideReviewedLine,
	gateRefsOf,
} = require("./lib/issue-gate");
const { readBasisFaults, unreadNote } = require("./lib/basis-cited-read");
const { isInOtherRepo, parseRepoOfUrl, refLabel } = require("./lib/issue-ref");
const { readShipped } = require("./lib/shipped-tickets");
const {
	isHeldWithoutReads,
	readIssueStrict,
	readPaidHold,
} = require("./lib/issue-hold");
const { NOT_READY_OPENING } = require("./lib/prose-blockers");
const {
	parseErrLine,
	ghClosedIssuesWithLabel,
	parseGhFailureReason,
	ghGetRetrying,
	ghOpenIssues,
	ISSUE_READ_CONCURRENCY,
	mapLimit,
	raiseGhFailure,
} = require("./lib/gh");
const {
	isOpenChild,
	localParentOf,
	readSubIssues,
} = require("./lib/issue-tree");
const { scriptPath } = require("./lib/script-path");
const {
	CLOSE_WHEN_LINE,
	CLOSE_WHEN_MARKER,
	COMMAND_VALUES,
	OUTSIDE_MARKER,
	TRIED_MIN,
	TRIED_MIN_ROUTES,
	outsideLineFault,
	hasRefusedOutsideAct,
	takesLabel,
	UNTRIED_FAULTS,
} = require("./lib/takes-label");

const HUMAN_LABEL = takesLabel("human");
const CHILDREN_LABEL = takesLabel("children");

const FOUNDER_COMMAND_GATE =
	/\bfounder\b[^—.;]*?\b(types?|typing|runs?|running|invokes?|fires?|launches?)\b[^—.;]*?[\s`(]\/([a-z][a-z0-9-]*)/i;
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
	"SURFACE-UNTRIED": [
		`takes:human whose Outside line names a screen a session can drive, and whose body lists no ${TRIED_MIN_ROUTES} routes tried`,
		UNTRIED_FAULTS["SURFACE-UNTRIED"].fix,
	],
	"REFUSED-UNTRIED": [
		`takes:human whose Outside line's only founder act is a refused one, and whose body lists no ${TRIED_MIN_ROUTES} calls tried`,
		UNTRIED_FAULTS["REFUSED-UNTRIED"].fix,
	],
	"NOT-A-FOUNDER-ACT": [
		`takes:human whose Outside line names none of the founder's own acts, and whose body lists no ${TRIED_MIN} methods tried`,
		`name the act from the list in docs/agents/triage-labels.md §\`takes:\`, or add a \`Tried:\` list of at least ${TRIED_MIN} methods run; neither true, an agent can do it — relabel takes:implement (#1077)`,
	],
	"OBSERVE-ONLY": [
		`takes:human whose Outside line's only founder part is to observe a result, and whose body lists no ${TRIED_MIN} methods tried`,
		`try what \`${scriptPath("lib/rule-text.sh")} observe-first\` names and close on it; only where every route failed, add a \`Tried:\` list of at least ${TRIED_MIN} methods run (#4114)`,
	],
	"NO-CLOSE-WHEN": [
		`takes:human whose body has no \`**${CLOSE_WHEN_MARKER}**\` line saying what finishes it`,
		`append the line — what finishes it, and what the closing comment records (${scriptPath("lib/rule-text.sh")} founder-deliverable)`,
	],
};

/** @param {string} name */
const isCommand = (name) =>
	COMMAND_VALUES.includes(name) ||
	fs.existsSync(path.join(worktreeRoot(), ".claude", "skills", name)) ||
	fs.existsSync(path.join(worktreeRoot(), ".claude", "commands", `${name}.md`));

const HUMAN_REVIEW_DAYS = 14;
/** @param {string} iso */
const ageDays = (iso) => (Date.now() - Date.parse(iso)) / 86_400_000;

/**
 * @typedef {import("./lib/check").Ctx} Ctx
 * @typedef {{number: number, title: string, url: string, has: string[],
 *   severity: string, tag: string, says: string, fix: string}} TakesFault
 * @typedef {{number: number, title: string, url: string, has: string[],
 *   parent: number, parentLabel: string, needs: string}} Unlabelled
 */

const RULES = [
	{
		parent: "wayfinder:map",
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
	{
		has: "wayfinder:map",
		takes: CHILDREN_LABEL,
		when: (/** @type {{ openSteps: number }} */ s) => s.openSteps > 0,
		why: "/wayfinder works the map itself while any open child carries a wayfinder:<type>",
	},
	{
		has: "manual-finding",
		takes: HUMAN_LABEL,
		why: "a full manual-sync run discharges it, inside Claude Code",
	},
];

/** @param {string[]} names */
const takesOf = (names) => names.filter((n) => n.startsWith("takes:"));

// guess: sized for a SessionStart hook's stdout, lucmoseley/mantahostels#1148
const NOTIFY_CAP = 3;

/** @param {TakesFault[]} list */
const gatingFirst = (list) =>
	[...list].sort(
		(a, b) => (a.severity === "WARN" ? 1 : 0) - (b.severity === "WARN" ? 1 : 0),
	);

/**
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
 * @param {any} iss
 * @returns {string[]}
 */
const namesOf = (iss) =>
	(iss.labels || []).map((/** @type {any} */ l) => l.name || l);

/**
 * @param {any[]} issues
 * @returns {any[]}
 */
function readClosedParents(issues) {
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
 * @returns {any[]}
 */
function readIssues() {
	/** @type {any[]} */
	let issues = [];
	try {
		const open = ghOpenIssues();
		issues = [...open, ...readClosedParents(open)];
	} catch (e) {
		raiseGhFailure(e);
	}
	return issues;
}

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
 * @param {TakesFault[]} takesFaults
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
	const isHumanErrand = own.includes(HUMAN_LABEL);
	const humanBody = String(iss.body ?? "");
	const human = isHumanErrand ? outsideLineFault(humanBody) : null;
	if (human) raise("FAIL", human.fault, ...HUMAN_FAULTS[human.fault]);
	else if (isHumanErrand && !CLOSE_WHEN_LINE.test(humanBody))
		raise("FAIL", "NO-CLOSE-WHEN", ...HUMAN_FAULTS["NO-CLOSE-WHEN"]);
}

/**
 * @param {ReturnType<typeof resolveGate>} gates
 * @returns {string|null}
 */
function gateMarkerOf(gates) {
	if (gates.gateOnHolds) return "Gated on";
	if (!gates.conflict && gates.gate && !gates.gate.malformed)
		return "Gated until";
	return null;
}

// guess, over a measured 1.6 s for four issues, #5007
const CITED_STATUS_MS = 60_000;

/**
 * @param {any[]} issues
 * @param {Ctx} ctx
 * @returns {Map<number, import("./lib/issue-gate").BasisFault[]>}
 */
function readGateCitations(issues, ctx) {
	const gated = issues.filter(
		(iss) =>
			!iss.pull_request &&
			iss.state === "open" &&
			gateMarkerOf(resolveGate(iss.body)),
	);
	const read = readBasisFaults(
		gated.map((iss) => ({ body: iss.body, own: iss.number })),
		{ timeoutMs: CITED_STATUS_MS },
	);
	if (read.unread.length > 0)
		ctx.say(
			`${unreadNote(
				"Unread: the issues open gates' bases cite",
				read.unread.map((w) => w.key),
				read.why,
			)}\n`,
		);
	return new Map(gated.map((iss, i) => [iss.number, read.faults[i] ?? []]));
}

/**
 * @param {any} iss
 * @param {Raise} raise
 * @param {import("./lib/issue-gate").BasisFault[]} faults
 */
function checkGates(iss, raise, faults) {
	const gates = resolveGate(iss.body);
	const typed = FOUNDER_COMMAND_GATE.exec(
		gates.gateOn?.condition ?? "",
	)?.[2]?.toLowerCase();
	if (typed && isCommand(typed))
		raise(
			"FAIL",
			"COMMAND-GATE",
			`gated on the founder typing /${typed} — a dispatched session types it too, so the gate only stops dispatch`,
			COMMAND_VALUES.includes(typed)
				? `relabel takes:${typed} and delete the Gated on line`
				: "delete the Gated on line and give it the takes: value of the command that opens it",
		);
	const marker = gateMarkerOf(gates);
	if (!marker) return;
	if (faults.some((f) => f.kind === "no-basis"))
		raise(
			"WARN",
			"NO-GATE-BASIS",
			`**${marker}:** line with no \`**Gate basis:**\` — nothing says what data sets its date or window`,
			`add a \`**Gate basis:**\` line directly beneath the ${marker} line, to the template in docs/agents/issue-tracker.md §Gating an issue`,
		);
	for (const f of faults)
		if (f.kind === "unnamed-window")
			raise(
				"WARN",
				"NO-GATE-BASIS",
				`writes the window "${f.text}", which its \`**Gate basis:**\` does not name`,
				"name the window in the basis, with the data that sets it",
			);
		else if (f.kind === "no-warrant")
			raise(
				"WARN",
				"NO-GATE-BASIS",
				`\`**Gate basis:**\` with no warrant — "${f.text}"${citedSays(f)}`,
				"rewrite the basis to carry one of the three warrants in docs/agents/issue-tracker.md §Gating an issue",
			);
		else if (f.kind === "window-mismatch")
			raise(
				"WARN",
				"NO-GATE-BASIS",
				`\`**Gate basis:**\` whose own figures do not give its window — "${f.text}"${recomputedSays(f)}`,
				"re-gate to the window the basis's own figures give, or correct the figures",
			);
}

/**
 * @param {any} iss
 * @param {Raise} raise
 * @param {ReturnType<typeof readShipped>} shipped
 */
function checkShippedGate(iss, raise, shipped) {
	if (!shipped?.cited.has(iss.number)) return;
	const own = parseRepoOfUrl(iss.repository_url);
	const adopter = gateRefsOf(iss.body, own).filter((r) =>
		isInOtherRepo(r, own),
	);
	if (adopter.length === 0) return;
	const named = adopter.map((r) => refLabel(r, own)).join(", ");
	raise(
		"WARN",
		"SHIPPED-GATED",
		`its build shipped in ${shipped.tag}, yet it is gated on ${named} — a shipped ticket held open to watch an adopter consume it, which can close a loop no link shows`,
		`close it, and leave the proof to ${named}, the adopter ticket that consumes the build`,
	);
}

/**
 * @param {{body?: string|null}} iss
 * @param {Raise} raise
 */
function checkJudgeOverride(iss, raise) {
	const body = iss.body ?? "";
	const reason = judgeOverrideOf(body)?.reason;
	if (!reason) return;
	const fingerprint = overrideFingerprint(reason);
	const reviewed = overrideReviewOf(body);
	if (reviewed === fingerprint) return;
	raise(
		"WARN",
		"GATE-JUDGE-OVERRIDE",
		`a session overrode the gate judge's model reading of this body — "${reason}"${reviewed ? ` (its reviewed line records ${reviewed}, which does not match this reason)` : ""}`,
		`read the body against the reason: where the model was right, give the wait a \`**Gate basis:**\` that derives its window and delete the override line and any reviewed line; where it was wrong, leave the override line and add or replace beneath it \`${overrideReviewedLine(fingerprint)}\``,
	);
}

/** @param {any} iss @param {string[]} own @param {Raise} raise */
function checkHumanIdle(iss, own, raise) {
	const idleDays = ageDays(iss.updated_at);
	if (own.includes(HUMAN_LABEL) && idleDays >= HUMAN_REVIEW_DAYS)
		raise(
			"WARN",
			"HUMAN-UNREVIEWED",
			`takes:human untouched for ${Math.floor(idleDays)} days — re-test the outside act`,
			"try an in-session route (a 403 names one permission, not the act); where the act is a multi-step walk, walk it with the founder in chat as a founder hand-over (docs/agents/triage-labels.md §`takes:`); comment with what you tried, or relabel",
		);
}

/** @param {any} iss @param {string[]} own @param {Raise} raise */
function checkAgentStep(iss, own, raise) {
	const body = String(iss.body ?? "");
	if (
		own.includes(HUMAN_LABEL) &&
		body.includes("! gh ") &&
		!hasRefusedOutsideAct(body)
	)
		raise(
			"WARN",
			"AGENT-STEP",
			"takes:human whose steps include a `! gh ` line a session can run, and whose Outside line names no refused act",
			`run the step and record it with its date, or move it to a blocking ticket; the body's steps are founder acts only (${scriptPath("lib/rule-text.sh")} founder-deliverable)`,
		);
}

/** @param {any} iss @param {Raise} raise */
function checkStaleContainer(iss, raise) {
	/** @type {any[] | null} */
	let kids = null;
	try {
		kids = readSubIssues(iss.number);
	} catch (e) {
		if (parseGhFailureReason(e) === "unreachable") raiseGhFailure(e);
		raise(
			"WARN",
			"CHILDREN-UNREADABLE",
			`takes:children with no open child in this repo, and its sub-issues unreadable (${parseErrLine(e)})`,
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
	if (own.includes("kind:brief") && specs)
		raise(
			"WARN",
			"SPECCED-BRIEF",
			"kind:brief still holding its open kind:spec — the move up under its map was never run",
			specs === 1
				? `check the brief's rulings are in the spec body, then \`node ${scriptPath("promote-spec.js")} ${iss.number}\``
				: `${specs} open kind:spec children — close or re-parent all but one by hand, then \`node ${scriptPath("promote-spec.js")} ${iss.number}\``,
		);
}

/**
 * @param {any} iss
 * @param {string[]} own
 * @param {ChildCounts & {gateFaults: Map<number,
 *   import("./lib/issue-gate").BasisFault[]>,
 *   shipped: ReturnType<typeof readShipped>}} counts
 * @param {Raise} raise
 */
function checkTakesFaults(iss, own, counts, raise) {
	const children = counts.openChildren.get(iss.number) || 0;
	checkTakesCount(own, raise);
	checkContradictions(own, counts.openSteps.get(iss.number) || 0, raise);
	checkHumanBody(iss, own, raise);
	checkGates(iss, raise, counts.gateFaults.get(iss.number) ?? []);
	checkShippedGate(iss, raise, counts.shipped);
	checkJudgeOverride(iss, raise);
	checkHumanIdle(iss, own, raise);
	checkAgentStep(iss, own, raise);
	checkContainer(iss, own, children, raise);
	checkSpeccedBrief(iss, own, counts.openSpecs.get(iss.number) || 0, raise);
}

/**
 * @param {any} iss
 * @param {string[]} own
 * @param {Map<number, any>} byNumber
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

/**
 * @param {any} iss
 * @param {Set<number>} openNumbers
 * @returns {Promise<Parameters<Raise> | null>}
 */
async function proseBlockedFault(iss, openNumbers) {
	const at = {
		openLocal: openNumbers,
		ownRepo: parseRepoOfUrl(iss.repository_url),
		readIssue: readIssueStrict,
	};
	if (await isHeldWithoutReads(iss, at)) return null;
	const latest = await ghGetRetrying(
		`repos/{owner}/{repo}/issues/${iss.number}/comments?per_page=1&page=${iss.comments}`,
		{ strict: true },
	);
	if (!latest.ok)
		return [
			"WARN",
			"BLOCKED-UNREADABLE",
			`latest comment unreadable (${latest.error}), so a prose-only not-ready comment is unjudged`,
			`re-run, or read it yourself: gh api repos/{owner}/{repo}/issues/${iss.number}/comments`,
		];
	const comment = latest.out.at(-1);
	if (!comment)
		return [
			"WARN",
			"BLOCKED-UNREADABLE",
			"latest comment answered an empty page, so a prose-only not-ready comment is unjudged",
			`re-run, or read it yourself: gh api repos/{owner}/{repo}/issues/${iss.number}/comments`,
		];
	const opening = NOT_READY_OPENING.exec(String(comment.body ?? ""))?.[1];
	if (!opening) return null;
	const hold = await readPaidHold(iss, at);
	if (!hold.ok)
		return [
			"WARN",
			"BLOCKED-UNREADABLE",
			`latest comment opens **${opening}, and ${hold.what}`,
			hold.fix,
		];
	if (hold.held) return null;
	return [
		"WARN",
		"PROSE-BLOCKED",
		`latest comment opens **${opening}, but no open blocker and no holding gate line — the shortlist offers it again`,
		`add a native blocked-by edge to the issue whose work it waits on (\`node ${scriptPath("link-blocker.js")} <n> <blocker>\`), filing that issue unassigned first where none exists; or, for an event no issue does, a \`**Gated on:** <condition> — check: <command> — abandon if: <clause>\` line with \`**Gate basis:**\` beneath it (waiting:external is not a gate)`,
	];
}

/**
 * @param {{iss: any, raise: Raise}[]} commented
 * @param {Set<number>} openNumbers
 */
async function raiseProseBlocked(commented, openNumbers) {
	const judged = await mapLimit(
		commented,
		ISSUE_READ_CONCURRENCY,
		async (c) => ({
			raise: c.raise,
			fault: await proseBlockedFault(c.iss, openNumbers),
		}),
	);
	for (const { raise, fault } of judged) if (fault) raise(...fault);
}

const SPEC = {
	name: "issue-labels",
	usage: "node check-issue-labels.js [--warn] [--json] [--notify]",
	async run(/** @type {Ctx} */ ctx) {
		const issues = readIssues();

		/** @type {Map<number, any>} */
		const byNumber = new Map();
		for (const iss of issues)
			if (!iss.pull_request) byNumber.set(iss.number, iss);

		const counts = {
			...countOpenChildren(issues),
			gateFaults: readGateCitations(issues, ctx),
			shipped: readShipped(worktreeRoot()),
		};

		/** @type {Unlabelled[]} */
		const unlabelled = [];
		/** @type {TakesFault[]} */
		const takesFaults = [];
		/** @type {{iss: any, raise: Raise}[]} */
		const commented = [];
		/** @type {Set<number>} */
		const openNumbers = new Set();
		let scanned = 0;
		let openScanned = 0;
		for (const iss of issues) {
			if (iss.pull_request) continue;
			if (iss.state !== "open") continue;
			openScanned++;
			openNumbers.add(iss.number);
			const own = namesOf(iss);
			const raise = faultRaiser(iss, own, takesFaults);
			checkTakesFaults(iss, own, counts, raise);
			if (iss.comments > 0) commented.push({ iss, raise });
			const rows = scanParentFamily(iss, own, byNumber);
			if (rows) {
				scanned++;
				unlabelled.push(...rows);
			}
		}

		await raiseProseBlocked(commented, openNumbers);

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
};

const main = () => runCheck(SPEC);

module.exports = { main };
if (require.main === module) main();
