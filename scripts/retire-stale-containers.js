#!/usr/bin/env node
/*
 * retire-stale-containers.js — the one writer of a `takes:` label. It moves a
 * routing label that its issue's children have made false, in two directions:
 *
 *   a `takes:children` whose last child has closed  → `takes:triage`
 *   a `takes:to-tickets` that HAS a child, still open → `takes:children`
 *   a `takes:to-tickets` whose every child has closed → `takes:triage`
 *
 * A SPEC REACHING `takes:triage` names its whole-spec review in the retag line
 * (workflow-core#892) — read on a hand run only, the session-start run's output going to
 * /dev/null. What reaches the `/triage` session is inject-tracker-docs.sh.
 *
 * WHAT (a) FIXES (mantahostels#1632). `takes:children` means "open a child instead", so a
 * container whose children have all closed routes to no command at all:
 * `/pick-next` leaves it on the frontier — unblocked, unclaimed, ungated — and
 * offers nothing to type.
 *
 * WHAT (b) FIXES (mantahostels#1663). `takes:to-tickets` means "this spec still needs
 * breaking up". Left on a spec already broken up, it invites a second
 * `/to-tickets` run that duplicates the tickets — mantahostels#1450, which produced mantahostels#1642
 * and mantahostels#1643 for work already shipped. triage-labels.md had ruled the move a
 * HAND step, and the only session positioned to notice is the one
 * `/to-tickets` forbids from touching the parent.
 *
 * WHY IT MAY WRITE WHERE NOTHING ELSE MAY. mantahostels#136 bars a script from GUESSING a
 * routing value, and check-issue-labels.js therefore never writes one. Nothing
 * is guessed here: docs/agents/triage-labels.md fixes both targets outright —
 * "A spec whose tickets are all closed is not a container either — nothing open
 * carries its residual, so someone must decide whether it is discharged. That
 * is `takes:triage`", and "A spec's `takes:` moves the moment its tickets exist
 * — `takes:to-tickets` → `takes:children`, since the work now sits on the
 * tickets."
 *
 * NOT AN AUTO-CLOSE, deliberately, on either rule. Closing on "every child is
 * closed" is wrong wherever the container is a standing queue — mantahostels#1079 is one, so
 * its next move is a fresh child, not a close. Only a session reading the body
 * can tell a discharged spec from a standing queue.
 *
 * CONDITION (a) is check-issue-labels.js's STALE-CONTAINER: an open
 * `takes:children` issue with no OPEN child in ANY repository, never read off a
 * label. The open-issue list picks the candidates, but it holds this repo's
 * issues alone, so each candidate's own `/sub_issues` list confirms it before a
 * retag (workflow-core#778). An unreadable list retags nothing. A `wayfinder:map` is
 * included: an exhausted map carries `takes:children` while its specs and
 * briefs are open, and once the last closes, a `/triage` session decides
 * whether the destination was reached and closes the map (workflow-core#578). A map
 * mislabelled `takes:children` before any child was filed moves to
 * `takes:triage` too, where a session picks `takes:wayfinder`.
 *
 * CONDITION (b) is an open `takes:to-tickets` issue with at least one sub-issue,
 * open or closed. NO sub-issue at all is left alone: that is a spec genuinely
 * awaiting `/to-tickets`. A `wayfinder:map` is excluded — its children are steps
 * of a route, not tickets, and `wayfinder:map` + `takes:children` is one of
 * check-issue-labels.js's CONTRADICTIONS while any of them is open, so only a
 * human knows the map's right value.
 *
 * OPEN ISSUES ONLY for the population, one paginated call — plus one
 * `/sub_issues` call per open `takes:to-tickets` issue and per rule (a)
 * candidate. `state=all` on the main
 * query would answer both rules in one go, but that response runs to megabytes;
 * rule (a) needs no closed child at all (a container whose last child closed and
 * one that never had a child are both stranded and both want `takes:triage`),
 * and rule (b)'s population is bounded by how many specs sit un-ticketed at
 * once (mantahostels#1663).
 *
 * WHERE IT RUNS: detached at session start, as sweep-debts-detached.sh's fourth
 * job (its header carries why there and not a hook entry of its own). Being
 * detached, it races check-issue-labels.js two hook entries later, so a
 * STALE-CONTAINER reported at one session start may already be retagged by the
 * next — the expected lag, not a fault.
 *
 * A SWEEP AND NOT A HOOK ON THE CLOSE PATH, so a close made from the web UI, by
 * a script or through `gh api` is caught like one made through the Bash tool.
 *
 * Usage: node retire-stale-containers.js [--dry-run] [--warn] [--json] [--notify]
 *
 * IMPLICIT:  at every session start, asks GitHub for the open issues — and for the sub-issues of each open `takes:to-tickets` issue and each `takes:children` with no open child in this repo — then moves any `takes:children` with no open child left to `takes:triage`, and any `takes:to-tickets` that already has tickets to `takes:children` (a ticket still open) or `takes:triage` (all closed).
 * JUSTIFIED: fail-safe both ways — a stranded `takes:children` routes to no command, so it is offered to nobody and sits on the frontier indefinitely; a stale `takes:to-tickets` routes to a command that DUPLICATES work already ticketed (mantahostels#1663). Both target values are fixed by docs/agents/triage-labels.md, not chosen here, and /triage still makes every judgement about the issue itself.
 * DEFEAT:    --dry-run prints the retags and writes nothing.
 */

const { runCheck } = require("./lib/check");
const {
	recordRun,
	JOB_RETIRE_STALE_CONTAINERS,
} = require("./lib/detached-run.js");
const {
	gh,
	ghJson,
	ghOpenIssues,
	errLine,
	ghFailureReason,
	raiseGhFailure,
} = require("./lib/gh");
const { isOpenChild, localParentOf, subIssuesOf } = require("./lib/issue-tree");

const { takesLabel } = require("./lib/takes-label");

const CONTAINER = takesLabel("children");
const TRIAGE = takesLabel("triage");
const TO_TICKETS = takesLabel("to-tickets");
const MAP = "wayfinder:map";
const SPEC = "kind:spec";

/** A spec's last ticket closing is the cue for its whole-spec review (workflow-core#892).
 *  @param {number} n */
const buildSpecReviewReason = (n) =>
	`its every ticket has closed, so /triage reviews its combined commits first (node scripts/spec-commits.js ${n}, adding --since <sha> where an earlier triage comment carries a **Reviewed through:** line), then decides whether it is discharged.`;

/**
 * @typedef {{
 *   number: number,
 *   title: string,
 *   state?: string,
 *   labels?: { name: string }[],
 *   parent_issue_url?: string | null,
 *   repository_url?: string,
 *   pull_request?: object,
 * }} Issue
 */

/** @param {{ labels?: { name: string }[] }} iss */
const namesOf = (iss) => (iss.labels || []).map((l) => l.name);

/** The label state a retag exists to produce, read back off GitHub.
 *  @param {number} n @param {string} from @param {string} to */
const alreadyRetagged = (n, from, to) => {
	const names = namesOf(
		ghJson(["issue", "view", String(n), "--json", "labels"]),
	);
	return names.includes(to) && !names.includes(from);
};

runCheck({
	name: "stale-containers",
	usage:
		"node retire-stale-containers.js [--dry-run] [--warn] [--json] [--notify]",
	flags: ["--dry-run"],
	// Wrapped whole, for the reason lib/detached-run.js's header gives:
	// sweep-debts-detached.sh spawns this detached under `stdio: "ignore"` and
	// returns, so nothing else on this machine can tell a run that swept from a
	// child that never started (mantahostels#1910). A --dry-run from the command line files a
	// record too — it reached the same seam, and the file records that the code
	// ran, never what it decided.
	run: (ctx) => recordRun(JOB_RETIRE_STALE_CONTAINERS, () => runBody(ctx)),
});

/** @param {import("./lib/check").Ctx} ctx */
function runBody(ctx) {
	const open = fetchOpenIssues().filter(
		(i) => !i.pull_request && i.state === "open",
	);
	const openChildren = countOpenChildren(open);
	const warnUnreadable = makeWarnUnreadable(ctx);
	const stale = findStale(open, openChildren, warnUnreadable);

	const dryRun = ctx.has("--dry-run");
	/** @type {{ number: number, title: string, from: string, to: string }[]} */
	const retagged = [];
	/** Everything a real run would have written, dry or not — what the
	 *  --dry-run OK line counts. @type {number[]} */
	const would = [];
	const retag = makeRetag(ctx, dryRun, retagged, would);

	for (const iss of stale)
		retag(
			iss,
			CONTAINER,
			TRIAGE,
			namesOf(iss).includes(SPEC)
				? buildSpecReviewReason(iss.number)
				: "its last child has closed, so /triage decides whether it is discharged.",
		);

	// Rule (b).
	const toTickets = open.filter(isToTicketsCandidate);
	retagToTickets(toTickets, retag, warnUnreadable, retagged);

	if (retagged.length > 0)
		ctx.say(
			`\nRetagged ${retagged.length} routing label(s). Open a takes:triage one with /triage <n>.\n`,
		);

	return {
		/* Under --dry-run the standing OK line would assert the opposite of what
		 * the run just printed. */
		okLine:
			dryRun && would.length > 0
				? `${would.length} routing label(s) named above; --dry-run wrote nothing.`
				: "every takes:children container still has an open child to open instead, and every takes:to-tickets spec is still un-ticketed.",
		noun: findingNoun(ctx),
		data: {
			stale: stale.map((i) => i.number),
			toTickets: toTickets.map((i) => i.number),
			retagged,
			dryRun,
		},
	};
}

/** @returns {Issue[]} */
function fetchOpenIssues() {
	try {
		return ghOpenIssues();
	} catch (e) {
		return raiseGhFailure(e, "No container was retagged.");
	}
}

/** @param {Issue[]} open @returns {Map<number, number>} */
function countOpenChildren(open) {
	/** @type {Map<number, number>} */
	const openChildren = new Map();
	for (const iss of open) {
		const p = localParentOf(iss);
		if (p) openChildren.set(p, (openChildren.get(p) || 0) + 1);
	}
	return openChildren;
}

/** Reported, never retagged: guessing either way is exactly what
 *  mantahostels#136 bars. Every failure but an unreachable GitHub is one
 *  issue's, not the apparatus's, so it WARNs rather than going BROKEN —
 *  check-open-maps.js splits an unreadable child list the same way.
 *  @param {import("./lib/check").Ctx} ctx */
function makeWarnUnreadable(ctx) {
	/** @param {Issue} iss @param {unknown} e @param {string} label */
	return (iss, e, label) => {
		const says = `#${iss.number} ${iss.title} — sub-issues unreadable (${errLine(e)}), ${label} left as it stands.`;
		ctx.warn("CHILDREN-UNREADABLE", says, {
			number: iss.number,
			title: iss.title,
		});
		ctx.say(`  CHILDREN-UNREADABLE  ${says}`);
	};
}

/** @param {Issue[]} open @param {Map<number, number>} openChildren
 *  @param {(iss: Issue, e: unknown, label: string) => void} warnUnreadable
 *  @returns {Issue[]} */
function findStale(open, openChildren, warnUnreadable) {
	/** @type {Issue[]} */
	const stale = [];
	for (const iss of open) {
		if (!namesOf(iss).includes(CONTAINER) || openChildren.get(iss.number))
			continue;
		/** @type {Issue[]} */
		let kids;
		try {
			kids = subIssuesOf(iss.number);
		} catch (e) {
			if (ghFailureReason(e) === "unreachable")
				raiseGhFailure(e, "No container was retagged.");
			warnUnreadable(iss, e, CONTAINER);
			continue;
		}
		if (!kids.some(isOpenChild)) stale.push(iss);
	}
	return stale;
}

/** @param {import("./lib/check").Ctx} ctx @param {boolean} dryRun
 *  @param {{ number: number, title: string, from: string, to: string }[]} retagged accumulator: each landed retag is pushed
 *  @param {number[]} would accumulator: each issue the retag is tried on is pushed */
function makeRetag(ctx, dryRun, retagged, would) {
	/** @param {Issue} iss @param {string} from @param {string} to @param {string} why */
	return (iss, from, to, why) => {
		would.push(iss.number);
		if (dryRun) {
			ctx.say(`  would retag #${iss.number} ${iss.title}  ${from} → ${to}`);
			return;
		}
		if (!applyRetag(ctx, iss, { from, to, why })) return;
		retagged.push({ number: iss.number, title: iss.title, from, to });
		ctx.say(`  #${iss.number} ${iss.title}\n    ${from} → ${to} — ${why}`);
	};
}

/** Writes one retag; false where it neither landed nor was already in place,
 *  having reported the RETAG-FAILED.
 *  @param {import("./lib/check").Ctx} ctx @param {Issue} iss
 *  @param {{ from: string, to: string, why: string }} move
 *  @returns {boolean} */
function applyRetag(ctx, iss, { from, to, why }) {
	try {
		gh([
			"issue",
			"edit",
			String(iss.number),
			"--add-label",
			to,
			"--remove-label",
			from,
		]);
		return true;
	} catch {
		/* A concurrent session's sweep gets there first often enough that the
		 * failure is usually not one: ask what the labels actually are before
		 * reporting a retag that did happen as a fault. */
		if (settledElsewhere(iss.number, from, to)) return true;
		const says = `#${iss.number} ${iss.title} — still ${from}; ${why}`;
		ctx.fail("RETAG-FAILED", says, {
			number: iss.number,
			title: iss.title,
		});
		/* Findings do not print themselves: a failed retag needs a hand fix,
		 * so say the command that makes it. */
		ctx.say(
			`  RETAG-FAILED  ${says}\n    fix: gh issue edit ${iss.number} --add-label ${to} --remove-label ${from}`,
		);
		return false;
	}
}

/** @param {number} n @param {string} from @param {string} to */
function settledElsewhere(n, from, to) {
	try {
		return alreadyRetagged(n, from, to);
	} catch {
		return false;
	}
}

/** @param {Issue} iss */
function isToTicketsCandidate(iss) {
	const names = namesOf(iss);
	return (
		names.includes(TO_TICKETS) &&
		!names.includes(MAP) &&
		/* An issue carrying BOTH takes: values is already a MANY-TAKES FAIL in
		 * check-issue-labels.js, and rule (a) has just retagged its half. Both
		 * passes firing on it would leave a second two-value pair, so this one
		 * stands off and leaves it to /triage. */
		!names.includes(CONTAINER)
	);
}

/** Every `takes:to-tickets` issue is a spec, so its all-closed retag names
 *  the spec review with no `kind:spec` check.
 *  @param {Issue[]} toTickets
 *  @param {(iss: Issue, from: string, to: string, why: string) => void} retag
 *  @param {(iss: Issue, e: unknown, label: string) => void} warnUnreadable
 *  @param {{ number: number }[]} retagged */
function retagToTickets(toTickets, retag, warnUnreadable, retagged) {
	for (const iss of toTickets) {
		/** @type {Issue[]} */
		let kids;
		try {
			/* Closed ones included: rule (b) turns on that distinction. */
			kids = subIssuesOf(iss.number);
		} catch (e) {
			/* Not "No container was retagged": rule (a) has already run and its
			 * retags are already printed above, so the standing message would
			 * assert the opposite of what this run just did. */
			if (ghFailureReason(e) === "unreachable")
				raiseGhFailure(
					e,
					`${retagged.length} label(s) retagged above; no takes:to-tickets spec was reached.`,
				);
			warnUnreadable(iss, e, TO_TICKETS);
			continue;
		}
		// No sub-issue at all is a spec genuinely awaiting /to-tickets.
		if (kids.length === 0) continue;
		const anyOpen = kids.some(isOpenChild);
		retag(
			iss,
			TO_TICKETS,
			anyOpen ? CONTAINER : TRIAGE,
			anyOpen
				? "its tickets exist and one is still open, so the work sits on them."
				: buildSpecReviewReason(iss.number),
		);
	}
}

/** check.js's own count — `gating.length ? gating.length : warned.length` —
 *  reports FAILs alone the moment one exists, so a mixed RETAG-FAILED +
 *  CHILDREN-UNREADABLE run would otherwise drop the unread count (workflow-core#93).
 *  @param {import("./lib/check").Ctx} ctx */
function findingNoun(ctx) {
	const failedCount = ctx.findings.filter((f) => f.severity === "FAIL").length;
	const unreadCount = ctx.findings.filter(
		(f) => f.tag === "CHILDREN-UNREADABLE",
	).length;
	return failedCount
		? `label(s) that could not be retagged${unreadCount ? ` (plus ${unreadCount} issue(s) whose children could not be read, left as they stand)` : ""}`
		: "issue(s) whose children could not be read — label left as it stands";
}
