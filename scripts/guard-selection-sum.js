#!/usr/bin/env node
/*
 * guard-selection-sum.js — Stop hook. Blocks a selection session that dispatches
 * work without stating the arithmetic `.claude/skills/pick-next/SKILL.md` §5
 * requires:
 *
 *     Frontier 60: 5 dispatched + 51 disqualified + 4 no command.
 *
 * A hook rather than a written rule (mantahostels#844, which built it, on mantahostels#422's criterion —
 * written down, and failed on the runs after it).
 *
 * HOW IT KNOWS THIS IS A SELECTION SESSION. Not from the message, and not from
 * `CLAUDE_JOB_DIR`, which is set in every background job. `scripts/pick-next.js`
 * mints a per-session marker as it runs, carrying the frontier size that run
 * measured; a session with no marker is never examined at all. A run made to
 * exercise the tooling opts out with `--no-log` (mantahostels#628) and mints nothing. See `scripts/lib/selection-marker.js`.
 *
 * WHAT IT CHECKS. Six things, and only on a message that actually dispatches
 * or declares a hold:
 *   1. the accounting line is present at all;
 *   2. dispatched + disqualified + no command equals the frontier the line states;
 *   3. that frontier equals the one the run measured, without which an
 *      invented but internally consistent sum passes;
 *   4. the `no command` term equals the one the run measured — the frontier
 *      issues no `/`-command opens, `takes:human` plus a `takes:children`
 *      container rotted to zero open children (mantahostels#1622, built at mantahostels#1626). Pinned exactly, like the
 *      frontier, because unlike the disqualified count the run measures it. A
 *      line omitting the term states 0, and a marker minted before the field
 *      existed leaves it unpinned;
 *   5. where the set filled the machine — as many sessions dispatched as the run
 *      measured free slots, or more — §6's admission-cut line, or the
 *      not-launched block that replaces it (workflow-core#592), is present. Zero
 *      measured slots counts: `admissionFrom` admits one whatever the headroom
 *      where no session is running, which is the sharpest cap there is (mantahostels#1321,
 *      the run that lost a session to it).
 *   6. in a background job, the message carries a completion mark — `result:`,
 *      `needs input:` or `failed:`. §7 launches the set, so a dispatch message
 *      with no mark leaves the job filed *Working* and therefore resumable.
 *
 * TWO STAKE TIERS, TWO BUDGETS (mantahostels#3431). Every check above, and every wave-line
 * fault below, is consequential: its miss lets a short or invented set stand, or
 * files the job wrongly. Two wave faults were ambiguous and are consequential on
 * that ground: a wave-1 line with no `Wave <k> of <n>` prefix, which lets a
 * closing wave still carrying `pending` pass as an opening one; and `0 pending`,
 * which opens a wave that owes no completion mark. The one shape limb is a `no command` term written after
 * `pending` — its count is still read, so nothing false passes. Each tier has its
 * own cap of 3, and a turn carrying both is refused once, naming both.
 *
 * WHY THE SIXTH (mantahostels#1337). An unmarked dispatch turn leaves the job filed
 * *Working* and so resumable, and the resumed turn re-derives the same set from
 * `.pick-next/last-run.json` — a record of the PLAN, never of the LAUNCH — and
 * dispatches it again. It accepts three marks, not just `result:`: a dispatch
 * turn can legitimately end blocked, and only a turn with no mark at all leaves
 * the job neither finished nor waiting.
 *
 * TWO WAVES, ONE RUN (mantahostels#1486). `/pick-next` may dispatch the candidates that
 * need no merge decision before §4's band read returns, and top the set up
 * afterwards. So a first-wave message states a partial sum, naming what is still
 * pending, and the closing wave states the full one:
 *
 *     Wave 1 of 2 — frontier 60: 3 dispatched + 37 disqualified + 4 no command + 16 pending band read.
 *     Wave 2 of 2 — frontier 60: 5 dispatched + 51 disqualified + 4 no command.
 *
 * Both waves resolve against the one marker. The opening
 * wave records its launched sessions on it, which buys three things: the
 * admission `>=` trigger tests the WHOLE set rather than firing on wave 1's
 * partial count; a closing wave that restates a launched line is not counted
 * twice, the record being per session rather than a tally; and while a wave is
 * open EVERY turn of that session owes an accounting line, so a first wave that
 * is never topped up is blocked rather than passing silently. A turn still
 * waiting on the band read re-states the wave-1 line to keep the wave open.
 *
 * The opening wave owes no completion mark: it ends waiting for the band read
 * to wake it, and *Working* is the right filing for that. mantahostels#1337's re-dispatch
 * hazard is carried instead by the recorded keys and by
 * `scripts/dispatch-sessions.sh`'s duplicate drop.
 *
 * IT DEMANDS THE LINE, NOT A NON-EMPTY ONE. §6 prints `none` where nothing
 * overflowed. mantahostels#1321 proposed omitting the line in that case; omission is exactly
 * what no hook can tell from the silence it was built to catch, so the line is
 * required and `none` is an admissible answer to it.
 *
 * IT FIRES ON `>=`, NOT EQUALITY. §5 sends the reader to `node
 * scripts/admission.js` for a fresh slot count immediately before writing §6's
 * lines, and sessions only ever finish during §4's band read — so the marker's
 * figure is a floor and a set legitimately larger than it still filled the
 * machine.
 *
 * KNOWN RESIDUALS. The counts are still read, never verified against the issues
 * named, on the other two disqualifiers: a session can state a true-looking sum
 * whose substrate and self-gate disqualifiers it never named, and no hook can see
 * that. Under-dispatch BELOW the measured slot count is not checked — capacity
 * left idle with no disqualifier named is the same silent failure, but a
 * genuinely exhausted frontier looks identical from here, so it stays fail-open
 * (mantahostels#1321's open question, settled that way). A run whose admission figure was
 * unreadable records no slot count and arms nothing on this limb. A dispatch
 * message spelled outside §6's contract — no bold issue numbers, no `takes:`
 * value — is not recognised as one and passes unexamined. And a marker that
 * cannot be written or read disarms the guard silently, deliberately: every
 * failure path here exits 0. On the wave limb specifically: a marker that cannot
 * be updated leaves the wave unrecorded, so the closing wave is never demanded
 * and the admission trigger sees wave 2 alone; the `pending` count is read,
 * never verified against the band read that is supposed to be deciding it; a
 * second `pick-next.js` run mid-session mints a fresh marker and so discharges
 * an open wave, which is right — that run is a new accounting — but nothing says
 * so; and **the open-wave demand needs a next turn to fire on**, so a session
 * whose band read dies and never wakes it leaves the short set standing, which
 * is why §4's dead-band fallback says the closing wave is still owed.
 *
 * IMPLICIT:  reads the session's ending message at every Stop and blocks a selection session that dispatches work without stating the frontier arithmetic — its three terms including the count of frontier work no command opens, both of the measured ones pinned to the run's own figures — without naming the candidates its admission cap cut, or — in a background job — without a completion mark; and, once that session has dispatched a first wave, blocks every turn of it until the closing wave states the full sum.
 * JUSTIFIED: fail-safe — the error is silently one-sided: a candidate held back costs a session nobody ever sees (mantahostels#844).
 * DEFEAT:    none — the block clears by stating the arithmetic, the admission-cut line or not-launched block where the set filled the machine, and a completion mark where the run is a background job; an open wave's block clears by closing it, or by re-stating its partial line while the band read runs.
 */

const fs = require("node:fs");
const path = require("node:path");
const hookBlock = require("./lib/hook-block");
const { INVENTORY } = require("./lib/inventory-format");
const { requiredGroup } = require("./lib/regex-group");
const selectionMarker = require("./lib/selection-marker");
const stopGuard = require("./lib/stop-guard");

/* The selection marker sits beside the block counters, so both come from the
 * one resolver. */
const REPO_ROOT = hookBlock.repoRoot();

/* One block counter per stake tier (mantahostels#3431, under `docs/agents/guard-authoring.md`
 * *A budget is reserved by stake tier*). The consequential one keeps the
 * pre-split name, so a session's spent blocks carry across the change. */
const CONSEQUENTIAL_PREFIX = ".selection-sum-nagged-";
const SHAPE_PREFIX = ".selection-sum-shape-nagged-";

/* §6's dispatch line: bold issue number(s), a dash, then the takes: value.
 * `**341, 353, 366** - takes:implement.` Backticks and a leading bullet are
 * tolerated because the contract's own template carries them. */
const DISPATCH_LINE =
	/^\s{0,3}(?:[-*>]\s+)?\*\*\s*`?\s*#?\d+(?:\s*,\s*#?\s*\d+)*\s*`?\s*\*\*\s*[-–—:]\s*`?takes:/im;

/* §6's hold line: the set is empty, and the accounting is owed just as much —
 * a hold is the claim that every frontier issue is disqualified. */
const HOLD_LINE = /^\s{0,3}(?:[-*>]\s+)?\**\s*Hold\s*\**\s*[-–—:]/im;

/* The accounting itself. Bold and backticks are tolerated on the numbers, the
 * label and the whole line, the skill's own example being backticked (workflow-core#1025); the
 * order is fixed, so a near miss is blocked and handed the template to paste.
 *
 * Three optional parts. Two carry the two-wave dispatch (mantahostels#1486): a `Wave <k> of
 * <n> —` prefix, and a trailing `+ <p> pending` term that makes the line a
 * partial sum. The third is mantahostels#1626's `+ <u> no command` term, which sits BEFORE
 * `pending` — a wave-1 line carries both, and `pending` stays last because it is
 * the term that disappears when the wave closes. Groups: 1 wave index, 2 wave
 * total, 3 frontier, 4 dispatched, 5 disqualified, 6 no command (absent on a
 * line written before the run measured it), 7 pending (absent on a closing or
 * single-wave line). */
const ACCOUNTING =
	/^\s{0,3}(?:[-*>]\s+)?[*`]*\s*(?:Wave\s*[*`]*\s*(\d+)\s*[*`]*\s*of\s*[*`]*\s*(\d+)\s*[*`]*\s*[-–—:]\s*[*`]*\s*)?Frontier\s*[*`]*\s*(\d+)\s*[*`]*\s*:\s*[*`]*\s*(\d+)\s*[*`]*\s*dispatched[*`]*\s*\+\s*[*`]*\s*(\d+)\s*[*`]*\s*disqualified[*`]*(?:\s*\+\s*[*`]*\s*(\d+)\s*[*`]*\s*no[ -]command[*`]*)?(?:\s*\+\s*[*`]*\s*(\d+)\s*[*`]*\s*pending)?/im;

/* §6's admission-cut line: the candidates cut on §5's third disqualifier, by
 * number — or `none` where the set filled the machine and nothing overflowed. */
/* A `no command` term after `pending`, which the accounting regex cannot
 * reach — see `misplacedTerm`. `[\s\S]` rather than the `s` (dotAll) flag: this file's target predates
 * ES2018, and `[\s\S]*?` matches the same "any character, non-greedy" span
 * without it (mantahostels#1464). */
const MISPLACED_TERM = /\bpending\b[\s\S]*?(\d+)\s*[*`]*\s*no[ -]command/i;

const ADMISSION_CUT =
	/^\s{0,3}(?:[-*>]\s+)?\**\s*Admission[ -]cut\s*\**\s*[-–—:]\s*\**\s*(?:#?\d+|none\b)/im;

/* The not-launched block (workflow-core#592), which replaces the admission-cut line: its
 * header, as a label or a heading. The block runs on to the first blank line —
 * one straight after the header excepted — or to a line opening `**` or `# `. */
const NOT_LAUNCHED_HEAD =
	/^[ \t]{0,3}(?:#{1,6}[ \t]+|[-*>][ \t]+)?\**[ \t]*Not[ -]launched[ \t]*\**[ \t]*(?:[-–—:][ \t]*\**)?(.*)$/gim;

/**
 * Whether the message carries a not-launched block that names an issue or says
 * `none`. Residual: lexical, so any number in the block counts — a dispatched
 * issue's, or one in a reason like `shares a file with #341` — and so does
 * `none of them`.
 * @param {string} message
 */
function hasNotLaunched(message) {
	for (const head of message.matchAll(NOT_LAUNCHED_HEAD)) {
		const sameLine = requiredGroup(head, 1, NOT_LAUNCHED_HEAD);
		const lines = message
			.slice(head.index + head[0].length)
			.split("\n")
			.slice(1)
			/* A `>`-quoted block (workflow-core#594's review): its bare `>` line is the blank
			 * that ends it. */
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

/* Not end-anchored, deliberately: the mark may sit anywhere in the message.
 * Residual — a message writing `result:` mid-body and then promising further
 * work satisfies this limb. Anchoring it to the last line would refuse honest
 * messages that close with a sign-off, and `guard-priced-options.js` already
 * refuses a `result:` paired with an approval-seeking phrase. */
const COMPLETION_MARK =
	/^\s{0,3}(?:[-*>]\s+)?\**\s*(?:result|needs input|failed)\s*\**\s*:/im;

const TEMPLATE =
	"Frontier <F>: <D> dispatched + <Q> disqualified + <U> no command.";

const WAVE_TEMPLATE =
	"Wave 1 of 2 — frontier <F>: <D> dispatched + <Q> disqualified + <U> no command + <P> pending band read.";

const CLOSING_TEMPLATE =
	"Wave 2 of 2 — frontier <F>: <D> dispatched + <Q> disqualified + <U> no command.";

const CUT_TEMPLATE = "**Admission cut:** #<n>, #<n>.";

/* The skill is named by its command, which resolves in any repo; the
 * stamp-collision sentence only where the host keeps a doc map to collide on
 * (workflow-core#1010). */
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
 * Does this message dispatch work, or declare a hold?
 * @param {string} message
 * @returns {boolean}
 */
function isDispatch(message) {
	return DISPATCH_LINE.test(message) || HOLD_LINE.test(message);
}

/**
 * One key per session the message dispatches — §6's "member" counts sessions,
 * not issues, so a merged bundle's one line yields one key however many numbers
 * it carries. That is the unit admission slots are priced in.
 *
 * The key is the line's issue numbers, sorted and joined, so a closing wave that
 * restates a line the first wave already launched is recognised as the same
 * session rather than counted twice (mantahostels#1486).
 * @param {string} message
 * @returns {string[]}
 */
function sessionKeys(message) {
	const keys = [];
	for (const line of message.split("\n")) {
		const m = line.match(DISPATCH_LINE);
		if (!m) continue;
		/* Off the bolded head alone, never the whole line: the trailing clause
		 * carries issue numbers of its own — "mantahostels#341 first: it blocks mantahostels#412". */
		const numbers = (m[0].match(/\d+/g) || [])
			.map(Number)
			.sort((a, b) => a - b);
		keys.push(numbers.join(","));
	}
	return keys;
}

/**
 * Every issue number carried by a set of session keys.
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
 * Both stake tiers' judgement on one turn (mantahostels#3431). Each tier is reviewed whatever
 * the other found, so a shape slip never pre-empts a consequential defect.
 * @param {string} message the outgoing assistant message
 * @param {{frontier: number|null, slots?: number|null, noCommand?: number|null,
 *   wave?: {keys: string[]}|null}|null} marker this session's selection marker
 * @param {{backgroundJob?: boolean}} [opts] backgroundJob: this run is a background job, so its
 *   filed state is what makes it resumable.
 * @returns {{shape: string, consequential: string, wave: {keys: string[]}|"close"|null}}
 *   each tier's block reason, or '' where that tier allows the stop; `wave` is the
 *   state the caller should persist — an open wave's launched sessions, `"close"`
 *   where the closing wave has just stated the full sum, or null where nothing changed.
 */
function review(message, marker, opts = {}) {
	/* An open wave outranks the dispatch-shape test: the closing sum is owed
	 * whatever this turn's message looks like. */
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
 * The count of a `no command` term the accounting regex could not reach because
 * it follows `pending` — read off the accounting line alone, never the prose
 * around it.
 * @param {string} message
 * @param {RegExpMatchArray} m the accounting match
 * @returns {string|undefined}
 */
function misplacedTerm(message, m) {
	if (m[6] !== undefined) return;
	const end = (m.index ?? 0) + m[0].length;
	const line = m[0] + message.slice(end).split("\n")[0];
	return line.match(MISPLACED_TERM)?.[1];
}

/**
 * @typedef {{waveIndex: number|null, waveTotal: number|null, stated: number,
 *   dispatched: number, disqualified: number, termText: string|undefined,
 *   noCommand: number, pending: number|null, counted: number}} Accounting
 * @typedef {NonNullable<Parameters<typeof review>[1]>} Marker
 * @typedef {{reason: string, wave: null}} Fault
 */

/**
 * The reason a dispatch with no accounting line, and no open wave, is refused.
 * @param {Marker} marker
 * @returns {string}
 */
function missingLineReason(marker) {
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
 * The accounting match's figures, read out.
 * @param {RegExpMatchArray} m the accounting match
 * @param {string|undefined} misplaced a `no command` count written after `pending`
 * @returns {Accounting}
 */
function readAccounting(m, misplaced) {
	const waveIndex = m[1] ? Number(m[1]) : null;
	const waveTotal = m[2] ? Number(m[2]) : null;
	const stated = Number(m[3]);
	const dispatched = Number(m[4]);
	const disqualified = Number(m[5]);
	/* Absent means the line states no third term, which is the claim that none
	 * of the frontier sits in the band — so it counts as 0 in the sum and is
	 * pinned against the marker like any other value. Residual: a session that
	 * never heard of the term looks identical to one asserting zero, so against
	 * a marker minted before mantahostels#1626 an unaware two-term line passes silently. */
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
 * @returns {Fault|null} where the line's terms do not add up to its frontier
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
				/* Echoed only where the line stated it: quoting `+ 0 no command`
				 * back at a two-term line reads as a term it wrote. */
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
 * @returns {Fault|null} where the line's frontier is not the one the run measured
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
 * Pinned exactly, like the frontier above and for the same reason: a term
 * the run measured is not a figure the message gets to invent. It comes
 * after the frontier check so a mid-run close, which moves both figures,
 * gets one correction rather than two (mantahostels#1622). An older marker carries no
 * figure and leaves this unpinned.
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
 * The closing wave accounts for the whole set, wave 1's issues included, so
 * its `dispatched` cannot be smaller than what already went out.
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
 * Gated on a session having been dispatched, not on the slot count being
 * positive, so a run dispatching against `freeSlots` of 0 still arms this.
 * A hold dispatches none and so never reaches it.
 *
 * Across two waves the count is the whole set's, first wave included — the
 * `>=` trigger asks whether the SET filled the machine, and a wave read on
 * its own is always short of it. A closing-wave line naming only issues
 * wave 1 already launched is a restatement and adds nothing, however it is
 * spelled: a merged bundle restated as one line per member counts zero, not
 * one per member.
 * @param {{message: string, marker: Marker, openKeys: string[]|null,
 *   launched: Set<string>}} ctx
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
 * Last, so the arithmetic above is corrected first and the session is never
 * handed two demands at once.
 * @param {string} message
 * @param {NonNullable<Parameters<typeof review>[2]>} opts
 * @returns {Fault|null}
 */
function completionMarkFault(message, opts) {
	if (opts.backgroundJob && !COMPLETION_MARK.test(message)) {
		/* A hold reaches here too — `isDispatch` matches it — so the opening
		 * sentence must not assert a launch that a hold never made. */
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
				"exiting 0 — read what `scripts/dispatch-sessions.sh` printed first, " +
				"since it refuses on allowance and on an already-launched set.",
		};
	}
	return null;
}

/**
 * The consequential tier. Its limbs keep their order and it reports the first
 * hit, so a session is never handed two corrections to one sum.
 * @param {string} message
 * @param {NonNullable<Parameters<typeof review>[1]>} marker
 * @param {{m: RegExpMatchArray|null, misplaced: string|undefined}} accounting
 *   `m` is the accounting match; `misplaced` a `no command` count written
 *   after `pending`
 * @param {Parameters<typeof review>[2]} [opts]
 * @returns {{reason: string, wave: {keys: string[]}|"close"|null}}
 */
function consequentialReview(message, marker, { m, misplaced }, opts = {}) {
	const openKeys = marker.wave ? marker.wave.keys : null;

	if (!m) {
		if (openKeys)
			return { reason: buildOwedClosingWaveReason(marker), wave: null };
		return { reason: missingLineReason(marker), wave: null };
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
 * A wave-1 line: the sum is partial by construction, so the admission-cut and
 * completion-mark limbs both stand down (header, TWO WAVES) and the launched
 * sessions are recorded against the run's marker for the closing wave to add to.
 * @param {string} message
 * @param {string[]|null} openKeys sessions an earlier wave of this run already launched
 * @param {{pending: number, waveIndex: number|null, waveTotal: number|null}} wave
 *   `pending` is the candidates whose disqualification the band read has still
 *   to decide
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
	if (waveIndex !== null && waveTotal !== null && waveIndex >= waveTotal) {
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
 * The block a turn gets when it ends while a wave of this run is still open.
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

/**
 * The whole of this guard's judgement on one turn; `lib/stop-guard.js` owns
 * everything around it.
 * @param {{sessionId: string, message: string}} ctx
 */
function judge({ sessionId, message }) {
	const marker = selectionMarker.read(REPO_ROOT, sessionId);
	const { shape, consequential, wave } = review(message, marker, {
		backgroundJob: Boolean(process.env.CLAUDE_JOB_DIR),
	});

	/* ONE BLOCK CARRYING BOTH TIERS' DEFECTS, EACH TIER CHARGING ITS OWN COUNTER
	 * (mantahostels#3431, the mantahostels#2786 shape). A counter at its cap contributes nothing, so three
	 * term-position blocks never silence a wrong sum. */
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

	/* Only ever on a turn owing no live block, emitted or not: a blocked wave-1 message is corrected and
	 * re-sent, and recording its sessions would credit a wave that never went
	 * out. Both calls are best-effort — an unwritable marker disarms the wave
	 * limb and leaves the rest of the guard standing, which is the same
	 * fail-open discipline as the mint itself. */
	if (wave === "close") {
		selectionMarker.closeWave(REPO_ROOT, sessionId);
	} else if (wave) {
		selectionMarker.openWave(REPO_ROOT, sessionId, wave.keys);
	}
}

if (require.main === module) stopGuard.onMessage({ review: judge });
