#!/usr/bin/env node
const { runCheck } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");
const {
	recordRun,
	JOB_RETIRE_STALE_CONTAINERS,
} = require("./lib/detached-run.js");
const {
	gh,
	ghJson,
	ghOpenIssues,
	parseErrLine,
	parseGhFailureReason,
	raiseGhFailure,
} = require("./lib/gh");
const {
	isOpenChild,
	localParentOf,
	readSubIssues,
} = require("./lib/issue-tree");

const { takesLabel } = require("./lib/takes-label");

const CONTAINER = takesLabel("children");
const TRIAGE = takesLabel("triage");
const TO_TICKETS = takesLabel("to-tickets");
const MAP = "wayfinder:map";
const SPEC = "kind:spec";

/** @param {number} n */
const buildSpecReviewReason = (n) =>
	`its every ticket has closed, so /triage reviews its combined commits first (node ${scriptPath("spec-commits.js")} ${n}, adding --since <sha> where an earlier triage comment carries a **Reviewed through:** line), then decides whether it is discharged.`;

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

/**
 * @param {number} n
 * @param {string} from
 * @param {string} to
 */
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
	/** @type {number[]} */
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

	const toTickets = open.filter(isToTicketsCandidate);
	retagToTickets(toTickets, retag, warnUnreadable, retagged);

	if (retagged.length > 0)
		ctx.say(
			`\nRetagged ${retagged.length} routing label(s). Open a takes:triage one with /triage <n>.\n`,
		);

	return {
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

/** @param {import("./lib/check").Ctx} ctx */
function makeWarnUnreadable(ctx) {
	/** @param {Issue} iss @param {unknown} e @param {string} label */
	return (iss, e, label) => {
		const says = `#${iss.number} ${iss.title} — sub-issues unreadable (${parseErrLine(e)}), ${label} left as it stands.`;
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
			kids = readSubIssues(iss.number);
		} catch (e) {
			if (parseGhFailureReason(e) === "unreachable")
				raiseGhFailure(e, "No container was retagged.");
			warnUnreadable(iss, e, CONTAINER);
			continue;
		}
		if (!kids.some(isOpenChild)) stale.push(iss);
	}
	return stale;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {boolean} dryRun
 * @param {{ number: number, title: string, from: string, to: string }[]} retagged
 * @param {number[]} would
 */
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

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Issue} iss
 * @param {{ from: string, to: string, why: string }} move
 * @returns {boolean}
 */
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
		if (settledElsewhere(iss.number, from, to)) return true;
		const says = `#${iss.number} ${iss.title} — still ${from}; ${why}`;
		ctx.fail("RETAG-FAILED", says, {
			number: iss.number,
			title: iss.title,
		});
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
		!names.includes(CONTAINER)
	);
}

/**
 * @param {Issue[]} toTickets
 * @param {(iss: Issue, from: string, to: string, why: string) => void} retag
 * @param {(iss: Issue, e: unknown, label: string) => void} warnUnreadable
 * @param {{ number: number }[]} retagged
 */
function retagToTickets(toTickets, retag, warnUnreadable, retagged) {
	for (const iss of toTickets) {
		/** @type {Issue[]} */
		let kids;
		try {
			kids = readSubIssues(iss.number);
		} catch (e) {
			if (parseGhFailureReason(e) === "unreachable")
				raiseGhFailure(
					e,
					`${retagged.length} label(s) retagged above; no takes:to-tickets spec was reached.`,
				);
			warnUnreadable(iss, e, TO_TICKETS);
			continue;
		}
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

/**
 * #93
 * @param {import("./lib/check").Ctx} ctx
 */
function findingNoun(ctx) {
	const failedCount = ctx.findings.filter((f) => f.severity === "FAIL").length;
	const unreadCount = ctx.findings.filter(
		(f) => f.tag === "CHILDREN-UNREADABLE",
	).length;
	return failedCount
		? `label(s) that could not be retagged${unreadCount ? ` (plus ${unreadCount} issue(s) whose children could not be read, left as they stand)` : ""}`
		: "issue(s) whose children could not be read — label left as it stands";
}
