#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const hookBlock = require("./lib/hook-block");
const { isBackgroundJob } = require("./lib/job-paths");
const { INVENTORY } = require("./lib/inventory-format");
const { requiredGroup } = require("./lib/regex-group");
const selectionMarker = require("./lib/selection-marker");
const stopGuard = require("./lib/stop-guard");

const REPO_ROOT = hookBlock.repoRoot();

const CONSEQUENTIAL_PREFIX = ".selection-sum-nagged-";
const SHAPE_PREFIX = ".selection-sum-shape-nagged-";

const DISPATCH_LINE =
	/^\s{0,3}(?:[-*>]\s+)?\*\*\s*(?:`\s*)?#?\d+(?:\s*,\s*(?:#\s*)?\d+)*\s*(?:`\s*)?\*\*\s*[-–—:]\s*`?takes:/im;

/**
 * @param {string} emphasis
 * @param {{ space?: string, blank?: string, bullet?: string }} [spelling]
 */
const lineOpening = (
	emphasis,
	{
		space = String.raw`\s`,
		blank = String.raw`[^\S\n\r\u2028\u2029]`,
		bullet = "[-*>]",
	} = {},
) =>
	`^${space}{0,3}(?:${bullet}${space}+(?:${emphasis}+${blank}*)?|${emphasis}+${blank}*|${blank}*)`;

const STAR_OPENING = lineOpening(String.raw`\*`);

const HOLD_LINE = new RegExp(
	STAR_OPENING + /Hold\s*(?:\*+\s*)?[-–—:]/.source,
	"im",
);

const ACCOUNTING = new RegExp(
	lineOpening("[*`]") +
		/(?:Wave\s*(?:[*`]+\s*)?(\d+)\s*(?:[*`]+\s*)?of\s*(?:[*`]+\s*)?(\d+)\s*(?:[*`]+\s*)?[-–—:]\s*(?:[*`]+\s*)?)?Frontier\s*(?:[*`]+\s*)?(\d+)\s*(?:[*`]+\s*)?:\s*(?:[*`]+\s*)?(\d+)\s*(?:[*`]+\s*)?dispatched[*`]*\s*\+\s*(?:[*`]+\s*)?(\d+)\s*(?:[*`]+\s*)?disqualified[*`]*(?:\s*\+\s*(?:[*`]+\s*)?(\d+)\s*(?:[*`]+\s*)?no[ -]command[*`]*)?(?:\s*\+\s*(?:[*`]+\s*)?(\d+)\s*(?:[*`]+\s*)?pending)?/
			.source,
	"im",
);

// lucmoseley/mantahostels#1464
const MISPLACED_TERM = /(?:^|\D)(\d+)\s*(?:[*`]+\s*)?no[ -]command/i;

const ADMISSION_CUT = new RegExp(
	STAR_OPENING +
		/Admission[ -]cut\s*(?:\*+\s*)?[-–—:]\s*(?:\*+\s*)?(?:#?\d+|none\b)/.source,
	"im",
);

const NOT_LAUNCHED_HEAD = new RegExp(
	lineOpening(String.raw`\*`, {
		space: String.raw`[ \t]`,
		blank: String.raw`[ \t]`,
		bullet: "(?:#{1,6}|[-*>])",
	}) + /Not[ -]launched(.*)$/.source,
	"gim",
);

const NOT_LAUNCHED_SEPARATOR = /^[ \t]*(?:\*+[ \t]*)?(?:[-–—:][ \t]*\**)?/;

/** @param {string} message */
function hasNotLaunched(message) {
	for (const head of message.matchAll(NOT_LAUNCHED_HEAD)) {
		const sameLine = requiredGroup(head, 1, NOT_LAUNCHED_HEAD).replace(
			NOT_LAUNCHED_SEPARATOR,
			"",
		);
		const lines = message
			.slice(head.index + head[0].length)
			.split("\n")
			.slice(1)
			.map((l) => l.replace(/^[ \t]{0,3}>[ \t]?/, ""));
		if (sameLine.trim() === "") while (lines[0]?.trim() === "") lines.shift();
		const end = lines.findIndex(
			(l) => l.trim() === "" || /^[ \t]*(?:\*\*|#{1,6}[ \t])/.test(l),
		);
		const block = [sameLine, ...(end < 0 ? lines : lines.slice(0, end))].join(
			"\n",
		);
		if (/\bnone\b|#?\d+/i.test(block)) return true;
	}
	return false;
}

const COMPLETION_MARK = new RegExp(
	STAR_OPENING + /(?:result|needs input|failed)\s*(?:\*+\s*)?:/.source,
	"im",
);

const TEMPLATE =
	"Frontier <F>: <D> dispatched + <Q> disqualified + <U> no command.";

const WAVE_TEMPLATE =
	"Wave 1 of 2 — frontier <F>: <D> dispatched + <Q> disqualified + <U> no command + <P> pending band read.";

const CLOSING_TEMPLATE =
	"Wave 2 of 2 — frontier <F>: <D> dispatched + <Q> disqualified + <U> no command.";

const CUT_TEMPLATE = "**Admission cut:** #<n>, #<n>.";

const WHY =
	"/pick-next §5: every frontier issue is either dispatched, carries one of " +
	"the three named disqualifiers — it shares a substrate, it is self-gated, " +
	"or admission has no slot left — or sits in the band no command opens, and " +
	"the three counts add to the frontier's size." +
	(fs.existsSync(path.join(REPO_ROOT, "docs", "doc-map.md"))
		? " A stamp collision on `docs/doc-map.md` is not one of the three " +
			"disqualifiers: issues sharing a stamp run together."
		: "");

const NO_COMMAND_IS =
	"`no command` is the frontier issues no `/`-command opens: `takes:human`, " +
	"plus a `takes:children` container whose last child has closed. It is a " +
	"BAND, not a fourth disqualifier — a `takes:human` issue in it is unblocked " +
	"founder work sitting idle, which is the thing lumping it into " +
	"`disqualified` hid. The run prints the figure under `no command` in its RUN " +
	"SUMMARY, and names the rotted containers: copy it rather than counting.";

/**
 * @param {string} message
 * @returns {boolean}
 */
function isDispatch(message) {
	return DISPATCH_LINE.test(message) || HOLD_LINE.test(message);
}

/**
 * @param {string} message
 * @returns {string[]}
 */
function sessionKeys(message) {
	const keys = [];
	for (const line of message.split("\n")) {
		const m = line.match(DISPATCH_LINE);
		if (!m) continue;
		const numbers = (m[0].match(/\d+/g) || [])
			.map(Number)
			.sort((a, b) => a - b);
		keys.push(numbers.join(","));
	}
	return keys;
}

/**
 * @param {string[]|null} keys
 * @returns {Set<string>}
 */
function issuesIn(keys) {
	const out = new Set();
	for (const key of keys ?? [])
		for (const n of key.split(",")) if (n) out.add(n);
	return out;
}

/**
 * @param {string} message
 * @param {{frontier: number|null, slots?: number|null, noCommand?: number|null,
  wave?: {keys: string[]}|null}|null} marker
 * @param {{backgroundJob?: boolean}} [opts]
 * @returns {{shape: string, consequential: string, wave: {keys: string[]}|"close"|null}}
 */
function review(message, marker, opts = {}) {
	if (!marker || (!marker.wave && !isDispatch(message)))
		return { shape: "", consequential: "", wave: null };
	const m = message.match(ACCOUNTING);
	const misplaced = m ? misplacedTerm(message, m) : undefined;
	const { reason, wave } = consequentialReview(
		message,
		marker,
		{ m, misplaced },
		opts,
	);
	return {
		shape: misplaced === undefined ? "" : MISPLACED_TERM_REASON,
		consequential: reason,
		wave,
	};
}

const MISPLACED_TERM_REASON =
	"This turn's accounting line carries its `no command` term after " +
	"`pending`. The order is fixed, so the line is out of the template's shape " +
	"— its count is still read.\n\n" +
	NO_COMMAND_IS +
	"\n\nRe-send the line with the terms in this order:\n\n" +
	WAVE_TEMPLATE;

/**
 * @param {string} message
 * @param {RegExpMatchArray} m
 * @returns {string|undefined}
 */
function misplacedTerm(message, m) {
	if (m[6] !== undefined) return;
	const end = (m.index ?? 0) + m[0].length;
	const line = m[0] + message.slice(end).split("\n")[0];
	const pending = /\bpending\b/i.exec(line);
	if (!pending) return;
	return line
		.slice(pending.index + pending[0].length)
		.match(MISPLACED_TERM)?.[1];
}

/**
 * @typedef {{waveIndex: number|null, waveTotal: number|null, stated: number,
 *   dispatched: number, disqualified: number, termText: string|undefined,
 *   noCommand: number, pending: number|null, counted: number}} Accounting
 * @typedef {NonNullable<Parameters<typeof review>[1]>} Marker
 * @typedef {{reason: string, wave: null}} Fault
 */

/**
 * @param {Marker} marker
 * @returns {string}
 */
function buildMissingLineReason(marker) {
	return (
		"This turn dispatches a selection set without stating §5's arithmetic. " +
		WHY +
		"\n\nAdd a line of its own, in this shape:\n\n" +
		TEMPLATE +
		(marker.frontier === null
			? ""
			: "\n\nThis run measured a frontier of " +
				marker.frontier +
				", so the numbers must read " +
				marker.frontier +
				" = dispatched + disqualified + no command" +
				(marker.noCommand === null
					? "."
					: `, with no command exactly ${marker.noCommand} — the figure the run printed.`)) +
		"\n\n" +
		NO_COMMAND_IS +
		"\n\nDo the accounting before you write it: name what disqualifies each " +
		"issue in the disqualified count." +
		"\n\nDispatching in two waves — a first wave before §4's band read " +
		"returns? Then this turn's line carries the count still pending " +
		"instead, and the closing wave states the full sum:\n\n" +
		WAVE_TEMPLATE
	);
}

/**
 * @param {RegExpMatchArray} m
 * @param {string|undefined} misplaced
 * @returns {Accounting}
 */
function readAccounting(m, misplaced) {
	const waveIndex = m[1] ? Number(m[1]) : null;
	const waveTotal = m[2] ? Number(m[2]) : null;
	const stated = Number(m[3]);
	const dispatched = Number(m[4]);
	const disqualified = Number(m[5]);
	const termText = m[6] ?? misplaced;
	const noCommand = termText === undefined ? 0 : Number(termText);
	const pending = m[7] === undefined ? null : Number(m[7]);
	const counted = dispatched + disqualified + noCommand + (pending ?? 0);
	return {
		waveIndex,
		waveTotal,
		stated,
		dispatched,
		disqualified,
		termText,
		noCommand,
		pending,
		counted,
	};
}

/**
 * @param {Accounting} a
 * @returns {Fault|null}
 */
function sumFault({
	dispatched,
	disqualified,
	termText,
	noCommand,
	pending,
	counted,
	stated,
}) {
	if (counted !== stated) {
		return {
			reason:
				"This turn's selection arithmetic does not add up: " +
				dispatched +
				" dispatched + " +
				disqualified +
				" disqualified" +
				(termText === undefined ? "" : ` + ${noCommand} no command`) +
				(pending === null ? "" : ` + ${pending} pending`) +
				" = " +
				counted +
				", but the line states a frontier of " +
				stated +
				". " +
				WHY +
				"\n\nRe-do the accounting and send it in this shape:\n\n" +
				(pending === null ? TEMPLATE : WAVE_TEMPLATE),
			wave: null,
		};
	}
	return null;
}

/**
 * @param {Accounting} a
 * @param {Marker} marker
 * @returns {Fault|null}
 */
function frontierFault({ stated, pending }, marker) {
	if (marker.frontier !== null && stated !== marker.frontier) {
		return {
			reason:
				"This turn states a frontier of " +
				stated +
				", but the `pick-next.js` run this session made measured " +
				marker.frontier +
				". " +
				WHY +
				"\n\nThe frontier is every issue the run left unexcluded — not the " +
				"shortlist `--limit` printed, and not the goal set, which is a boost " +
				"and never a filter. Both waves of a two-wave dispatch state the same " +
				"frontier, the one this run measured. Re-run the script if the frontier " +
				"has genuinely moved since; otherwise correct the line:\n\n" +
				(pending === null ? TEMPLATE : WAVE_TEMPLATE),
			wave: null,
		};
	}
	return null;
}

/**
 * @param {Accounting} a
 * @param {Marker} marker
 * @returns {Fault|null}
 */
function noCommandFault({ termText, noCommand, pending }, marker) {
	if (marker.noCommand != null && noCommand !== marker.noCommand) {
		return {
			wave: null,
			reason:
				"This turn's accounting line states " +
				(termText === undefined
					? "no `no command` term at all"
					: `\`${noCommand} no command\``) +
				", but the `pick-next.js` run this session made measured " +
				marker.noCommand +
				" frontier issue(s) that no command opens.\n\n" +
				NO_COMMAND_IS +
				"\n\nRe-run the script if the frontier has genuinely moved since; " +
				"otherwise correct the line:\n\n" +
				(pending === null ? TEMPLATE : WAVE_TEMPLATE),
		};
	}
	return null;
}

/**
 * @param {Set<string>} launched
 * @param {number} dispatched
 * @returns {Fault|null}
 */
function closingWaveFault(launched, dispatched) {
	if (launched.size > dispatched) {
		return {
			wave: null,
			reason:
				"This turn closes a two-wave dispatch stating " +
				dispatched +
				" dispatched, but an earlier wave of this run already launched " +
				launched.size +
				" issue(s): " +
				[...launched].map((n) => `#${n}`).join(", ") +
				". The closing wave's sum is the WHOLE set's — wave 1's issues are " +
				"dispatched, not disqualified, and dropping them from the count " +
				"puts them back in a bucket nothing accounts for. Re-do the " +
				"accounting over both waves:\n\n" +
				CLOSING_TEMPLATE,
		};
	}
	return null;
}

/**
 * @param {{message: string, marker: Marker, openKeys: string[]|null,
  launched: Set<string>}} ctx
 * @returns {Fault|null}
 */
function admissionCutFault({ message, marker, openKeys, launched }) {
	const sessions =
		(openKeys?.length ?? 0) +
		sessionKeys(message).filter((key) =>
			key.split(",").some((n) => !launched.has(n)),
		).length;
	if (
		marker.slots != null &&
		sessions >= 1 &&
		sessions >= marker.slots &&
		!ADMISSION_CUT.test(message) &&
		!hasNotLaunched(message)
	) {
		return {
			wave: null,
			reason:
				"This turn dispatches " +
				sessions +
				" session(s) against the " +
				marker.slots +
				" free admission slot(s) the run measured" +
				(marker.slots === 0
					? " — one is admitted whatever the headroom where nothing is running"
					: "") +
				(openKeys ? ", counting both waves of this dispatch" : "") +
				", so the set was capped by " +
				"§5's third disqualifier — admission has no slot left — and §6 owes a " +
				"line naming every candidate cut on it.\n\nUnlike the other two " +
				"disqualifiers, that set is bounded by construction: it is the overflow " +
				"past the slot count, and every issue in it is takeable right now and " +
				"would have run had a session finished a minute earlier. Left unnamed it " +
				"is indistinguishable from the substrate and self-gate sets, and the next " +
				"recompute may not revisit it, because nothing about a slot changes when " +
				"an issue closes (mantahostels#1321).\n\nAdd a line of its own, in this shape:\n\n" +
				CUT_TEMPLATE +
				"\n\nWhere the candidates genuinely ran out and nothing overflowed, say " +
				"so explicitly — `**Admission cut:** none.` — rather than omitting the " +
				"line: silence is what this check exists to refuse.\n\nA " +
				"`**Not launched:**` block naming the cut issues, or saying `none`, " +
				"stands in for the line.",
		};
	}
	return null;
}

/**
 * @param {string} message
 * @param {NonNullable<Parameters<typeof review>[2]>} opts
 * @returns {Fault|null}
 */
function completionMarkFault(message, opts) {
	if (opts.backgroundJob && !COMPLETION_MARK.test(message)) {
		const what = HOLD_LINE.test(message)
			? "holds a selection set"
			: "dispatches a selection set";
		return {
			wave: null,
			reason:
				`This turn ${what} from a background job without a ` +
				"completion mark, so the job stays filed *Working* and stays resumable. " +
				"The only durable record of the run is `.claude/tmp/markers/.pick-next/last-run.json` — a " +
				"record of the plan, never of the launch. A resumed turn re-reads it, " +
				"cannot tell a planned set from a launched one, and dispatches the same " +
				"sessions again (mantahostels#1337).\n\n" +
				"End the message with one of these, on a line of its own:\n\n" +
				`result: <one-line headline of what was dispatched> ${INVENTORY.nothingTail}\n` +
				`${INVENTORY.needsInputLine}\n` +
				"failed: <why the set could not be dispatched>\n\n" +
				"`result:` is the right one where the set is launched and nothing waits " +
				"on the founder. Do not write it on the strength of the launch command " +
				"exiting 0 — read what `scripts/dispatch-sessions.js` printed first, " +
				"since it refuses on allowance and on an already-launched set.",
		};
	}
	return null;
}

/**
 * @param {string} message
 * @param {NonNullable<Parameters<typeof review>[1]>} marker
 * @param {{m: RegExpMatchArray|null, misplaced: string|undefined}} accounting
 * @param {Parameters<typeof review>[2]} [opts]
 * @returns {{reason: string, wave: {keys: string[]}|"close"|null}}
 */
function consequentialReview(message, marker, { m, misplaced }, opts = {}) {
	const openKeys = marker.wave ? marker.wave.keys : null;

	if (!m) {
		if (openKeys)
			return { reason: buildOwedClosingWaveReason(marker), wave: null };
		return { reason: buildMissingLineReason(marker), wave: null };
	}

	const a = readAccounting(m, misplaced);
	const fault =
		sumFault(a) ?? frontierFault(a, marker) ?? noCommandFault(a, marker);
	if (fault) return fault;

	if (a.pending !== null)
		return reviewOpeningWave(message, openKeys, {
			pending: a.pending,
			waveIndex: a.waveIndex,
			waveTotal: a.waveTotal,
		});

	const launched = issuesIn(openKeys);
	return (
		closingWaveFault(launched, a.dispatched) ??
		admissionCutFault({ message, marker, openKeys, launched }) ??
		completionMarkFault(message, opts) ?? { reason: "", wave: "close" }
	);
}
/**
 * @param {string} message
 * @param {string[]|null} openKeys
 * @param {{pending: number, waveIndex: number|null, waveTotal: number|null}} wave
 * @returns {{reason: string, wave: {keys: string[]}|null}}
 */
function reviewOpeningWave(
	message,
	openKeys,
	{ pending, waveIndex, waveTotal },
) {
	if (waveIndex === null || waveTotal === null) {
		return {
			wave: null,
			reason:
				"This turn's accounting line names " +
				pending +
				" pending but carries no `Wave <k> of <n>` prefix, so nothing in it " +
				"says which wave this is — and the closing wave cannot then be told " +
				"from another opening one. Write the prefix:\n\n" +
				WAVE_TEMPLATE,
		};
	}
	if (pending < 1) {
		return {
			wave: null,
			reason:
				"This turn's accounting line carries a pending count of 0, which is " +
				"the closing wave's line written in the opening wave's shape. Nothing " +
				"is left for a further wave to decide, so state the full sum and drop " +
				"the pending term:\n\n" +
				TEMPLATE,
		};
	}
	if (waveIndex >= waveTotal) {
		return {
			wave: null,
			reason:
				"This turn's line reads `Wave " +
				waveIndex +
				" of " +
				waveTotal +
				"` — the closing wave — and still carries " +
				pending +
				" pending. The closing wave is what accounts for every frontier issue, " +
				"so it can leave none pending. Either this is not the closing wave, or " +
				"the pending count belongs in `disqualified` or `dispatched`:\n\n" +
				CLOSING_TEMPLATE,
		};
	}
	return {
		reason: "",
		wave: { keys: [...(openKeys ?? []), ...sessionKeys(message)] },
	};
}

/**
 * @param {{frontier: number|null}} marker
 * @returns {string}
 */
function buildOwedClosingWaveReason(marker) {
	return (
		"An earlier turn of this selection run dispatched a first wave and stated " +
		"a partial sum, leaving candidates pending §4's band read. That accounting " +
		"is still owed: until the closing wave states the full sum, nothing has " +
		"accounted for the pending candidates, and a wave-1 set that is never " +
		"topped up is exactly the silently short set this check exists to " +
		"refuse (mantahostels#1486).\n\n" +
		"End this turn with the closing wave's line:\n\n" +
		CLOSING_TEMPLATE +
		(marker.frontier === null
			? ""
			: "\n\nThis run measured a frontier of " +
				marker.frontier +
				", so the three counts must add to " +
				marker.frontier +
				".") +
		"\n\nStill waiting on the band read? Re-state the wave-1 line as it " +
		"stands — that keeps the wave open and this turn passes:\n\n" +
		WAVE_TEMPLATE
	);
}

/** @param {{sessionId: string, message: string}} ctx */
function judge({ sessionId, message }) {
	const marker = selectionMarker.read(REPO_ROOT, sessionId);
	const { shape, consequential, wave } = review(message, marker, {
		backgroundJob: isBackgroundJob(process.env),
	});

	// lucmoseley/mantahostels#3431
	const live = [
		{ prefix: CONSEQUENTIAL_PREFIX, reason: consequential },
		{ prefix: SHAPE_PREFIX, reason: shape },
	].filter(
		(part) =>
			part.reason && !hookBlock.capSpent({ prefix: part.prefix, sessionId }),
	);
	const [first] = live;
	if (first) {
		if (
			hookBlock.blockStop({
				prefix: first.prefix,
				sessionId,
				reason: live.map((part) => part.reason).join("\n\n"),
			})
		)
			for (const part of live.slice(1))
				hookBlock.charge({ prefix: part.prefix, sessionId });
		return;
	}

	if (wave === "close") {
		selectionMarker.closeWave(REPO_ROOT, sessionId);
	} else if (wave) {
		selectionMarker.openWave(REPO_ROOT, sessionId, wave.keys);
	}
}

if (require.main === module) stopGuard.onMessage({ review: judge });
