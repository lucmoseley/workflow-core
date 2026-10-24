#!/usr/bin/env node
/*
 * guard-session-ceiling.js — Stop hook. Reads how much standing context this
 * session is carrying, and how many turns it has taken, and speaks when it has
 * crossed a band of `docs/effort-guide.md`'s session-context policy: 100 turns
 * and 200,000 tokens are notice to wind up, and 300,000 is a tripwire —
 * reaching it means autocompaction, which should fire at ~287,000, did not
 * (#1178).
 *
 * THE 200,000 BAND REPEATS, IT DOES NOT SPEAK ONCE (mantahostels#2601) — how often,
 * the stand-down below says.
 *
 * THE TURN BAND IS A SECOND INSTRUMENT, NOT A REPLACEMENT (mantahostels#2601). It is the
 * only band heard by a session reaching 100 responses without ever crossing
 * 200,000.
 *
 * IT REPEATS TOO, BUT CAPPED AT THREE (mantahostels#2619, which carries the measurement).
 *
 * WHY IT EXISTS. Left to the session to read at a unit boundary, the policy
 * went unread (mantahostels#1731).
 *
 * COMPACTION IS THE MOVE AT THE CEILING (#1178 Q1 (A), reversing
 * mantahostels#1546), so no band hands off and none says not to compact. The
 * tripwire exists because `autoCompactWindow` silently drops a non-integer
 * value, and the `opus[1m]` default then fires at ~967,000 (mantahostels#1547).
 *
 * WHY Stop. A hook cannot see a unit boundary (mantahostels#1548), and Stop is
 * the closest proxy the harness offers — it fires when the session stops
 * calling tools — and it is also the only channel: an exit-0 hook reaches the
 * transcript and the user, never the model, so a notice must block to be read.
 *
 * THE BANDS ARE ABSOLUTE TOKENS, NOT A WINDOW FRACTION (mantahostels#1544). A 1M-window
 * parent and a `sonnet`-pinned subagent share no percentage.
 *
 * THE READING IS A FLOOR, one turn stale — the last usage record describes the
 * request already made (`scripts/session-context.js`).
 *
 * OUTSIDE THE TRIPWIRE ONLY A TURN THAT WOULD END THE SESSION IS REFUSED (#919) —
 * one carrying `result:` or no status marker, on the turn band and the 200,000
 * band alike. `waiting:` and `needs input:` pass and spend no block, so a
 * session waiting on the founder or on its own background job is not refused.
 * The tripwire refuses any turn, once; past it the wind-up band governs.
 *
 * A SESSION THAT HAS RUN `park-blocked.sh` HEARS NOTHING BELOW THE
 * TRIPWIRE (#62): the local record the script writes once it parks a ticket
 * silences the wind-up band for a main-tier session — unless a launch of its
 * own is still out.
 *
 * EVERY BAND NAMES THE SESSION'S OWN BACKGROUND WORK STILL OUT (#1179): the
 * work belongs to the unit in flight, so the session ends on `waiting:` until
 * each launch reports. The list is `lib/pending-tasks.js`'s, the reader the
 * other Stop guards use; nothing out adds nothing to the text.
 *
 * EVERY BAND CARRIES ONE INVENTORY STEP (#985, on #958's spec): before ending,
 * a session files an open issue for each founder-facing item it produced or
 * named and lists them under `waits on you:`. A band's first block prints
 * `rule:founder-deliverable` in full, a repeat a pointer to it.
 *
 * AN ENDING THAT ALREADY CARRIES IT IS NOT REFUSED (#1786): below the
 * tripwire, a `result:` ending whose inventory guard-inventory.js passes, with
 * no launch of its own out, ends without a block, spends no counter and crumbs
 * `inventory-stand-down`.
 *
 * AUTOCOMPACTIONS ARE COUNTED AND REFUSE NOTHING (#1032). Each one joins a
 * per-session set that outlives the tail read, and every block carries the
 * count. The model hears of each new one from `inject-compaction-count.js`
 * (#1148), so this guard says nothing of it unblocked.
 *
 * IMPLICIT:  reads this session's own transcript at every Stop and, once a
 *            band other than the tripwire has been crossed, the turn's status
 *            marker; once a band is crossed, reads the transcript's launches
 *            through lib/pending-tasks.js; past 200,000 also checks for
 *            park-blocked.sh's local record. Writes the compaction set.
 * JUSTIFIED: fail-safe — the founder-visible cost of overrunning is real spend,
 *            and the remedy is one turn spent committing and recording state.
 * DEFEAT:    the turn band blocks three times and the tripwire once,
 *            so a session with nothing left to commit is taught and released;
 *            past 200,000 the block repeats.
 *            Apart from the tripwire's one block, any session escapes by
 *            ending on `waiting:` or `needs input:` — the marker is read, never
 *            checked for truth, and an unreadable message passes too — or on
 *            `result:` under a well-formed inventory, which says nothing of
 *            whether the unit was finished or committed, or
 *            simply by ending again: the refusal rides the band's
 *            every-other-Stop stand-down, so a second `result:` straight after
 *            one it refused passes — a launch still out included. The launch
 *            list misses work backgrounded inside a foreground call or
 *            started from a script, and keeps a launch whose notification never
 *            came for the rest of the session.
 *            Silent under every band and on every failure path.
 */

const fs = require("node:fs");
const path = require("node:path");
const hookBlock = require("./lib/hook-block");
const { textOf } = require("./lib/hook-message");
const { markersDir } = require("./lib/marker-root");
const {
	compactionSentence,
	recordCompactions,
} = require("./lib/compaction-set");
const { scriptPath } = require("./lib/script-path");
const sessionTranscript = require("./lib/session-transcript");
const { INVENTORY } = require("./lib/inventory-format");
const { pendingTasks } = require("./lib/pending-tasks");
const { governingMarker } = require("./lib/status-marker");
const stopGuard = require("./lib/stop-guard");
const {
	autocompactions,
	countTurns,
	isSubagentTranscript,
	lastStandingContext,
} = require("./lib/transcript");

/**
 * The slice of the Stop payload this guard reads.
 * @typedef {{session_id?: string, hook_event_name?: string,
 *   transcript_path?: string, stop_hook_active?: unknown,
 *   last_assistant_message?: string}} Payload
 */

/**
 * `docs/effort-guide.md`, derived at mantahostels#1094 (wind up), mantahostels#1546 (ceiling, a
 * tripwire per #1178) and mantahostels#2601 (turns).
 *
 * `TURN_BAND` was CONFIRMED at 100 by mantahostels#2618: 200,000 tokens is first
 * reached at a median of the 104th API response, so 100 responses is where the
 * two bands coincide. Re-confirmed at mantahostels#2627 — the calibration record below.
 *
 * DO NOT RE-CALIBRATE IT OFF https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-ceiling-firing-rates.md:
 * every turn count there is one assistant RECORD, a median 2.00x a response.
 * `scripts/measure-turn-band.js` reports all three scales; re-run that instead.
 */
const WIND_UP = 200_000;
const TRIPWIRE = 300_000;
const TURN_BAND = 100;

/* #958 ruled this wording. Its format pieces live in lib/inventory-format.js,
 * which the inventory guard and the parser read too (#1249). */
const INVENTORY_STEP = `Before you end, take the inventory. Look over everything this session produced or named, and find each founder-facing item: (1) a deliverable the founder must still act on, such as a draft to send or a file to upload; (2) an act only he can do that is written only in chat or inside a comment, such as a check by eye; (3) a decision he has not answered, whose round you post on the issue that carries it. Each one must sit in an open issue: name the issue that carries it, or file one now. Chat, the status line and a closed issue's comment never count. Then end with the inventory ${INVENTORY.placement}: \`waits on you:\`, then ${INVENTORY.itemLines}, or ${INVENTORY.nothingLine}. In a background job, also end the status line with ${INVENTORY.statusTail}.`;

/**
 * The inventory step, led by the wait-for-your-own-work step and each launch
 * still out (#1179).
 * @param {import("./lib/pending-tasks").Launch[]} pending
 */
function closingSteps(pending) {
	if (pending.length === 0) return INVENTORY_STEP;
	return [
		"Your own background work is still out, and it belongs to the unit in flight, so the unit is not finished until it reports:",
		...pending.map(
			(l) =>
				`- ${l.name ? `${l.name} (${l.kind}, ${l.id})` : `${l.kind} ${l.id}`}`,
		),
		"Wait for it: end this turn on `waiting:`, read each result as it lands and act on it. End on `result:` only when nothing is still out. Stop a watcher whose subject has already reported.",
		"",
		INVENTORY_STEP,
	].join("\n");
}

/*
 * WHAT THE TWO BANDS WERE CALIBRATED ON — the baseline a re-measure compares
 * against, measured 14 Sep 2026.
 *
 *   turnBand  where 200,000 is first crossed, counted in API responses — the
 *             scale TURN_BAND is set on.
 *     crossing response  p25 75, median 99, p75 119
 *     crossing rate      0.19, the share of sessions ever crossing it at all
 *     sessions           990
 *     corpus             main-tier `cli` sessions with a user turn and a usage
 *                        record, first record Thu 3 – Mon 7 Sep 2026,
 *                        landing-straddlers excluded
 *     issue              mantahostels#2627
 *     remeasure: node scripts/measure-turn-band.js
 *
 *   windUp    standing context at response 100. The MEDIAN is flat against
 *             mantahostels#2603's five-week series of weekly medians
 *             (154,000–184,000), so neither band moved; the quartiles have no
 *             earlier counterpart.
 *     standing context   p25 162,928, median 181,515, p75 202,922
 *     sessions           184
 *     corpus             main-tier sessions reaching response 100, first
 *                        record Thu 3 – Mon 7 Sep 2026
 *     issue              mantahostels#2627
 *     remeasure: none
 *
 * MOVE EITHER FIGURE ONLY WITH A RE-MEASUREMENT. Only `turnBand` has a script:
 * `node scripts/measure-turn-band.js` (mantahostels#2618) reports the crossing response and
 * nothing else — over the WHOLE corpus, having no date window, so it cannot
 * reproduce the windowed figures above. Those, and `windUp`, came from mantahostels#2627's
 * throwaway scan, never landed, so re-deriving them means writing the scan
 * again — mantahostels#2627's comments carry its shape.
 *
 * NO DRIFT CHECKER READS IT — mantahostels#2603 ruled a standing recalibration cadence out.
 * The one automated reader is the test that keeps each `remeasure:` line naming a
 * script still on disk.
 *
 * THE TWO ENTRIES ARE TWO SCALES, and they disagree by design: on the token
 * scale they sit ~9% apart, the median session at response 100 carrying
 * ~181,500 rather than 200,000, because the crossers are the heavy tail.
 */

/** The figure as the bands print it. @param {number} v */
const n = (v) => v.toLocaleString("en-GB");

/**
 * `rule:founder-deliverable` in full on a band's first block, a pointer to it
 * on every repeat.
 * @param {boolean} firstBlock
 */
function founderDeliverableRule(firstBlock) {
	/* Required here, not at the top (#1249): founder-deliverable.js,
	 * rule-text.js or qualify-citations.js failing to load then costs only the
	 * block printing the rule, where at load it would stop this guard on every
	 * Stop, compaction records included. That cost is silent: `note("message")`
	 * still fires, so the lost block reads as a Stop that never crossed. */
	const fd = require("./lib/founder-deliverable");
	return firstBlock
		? fd.deliverableRule("guard-session-ceiling")
		: fd.deliverablePointer();
}

/**
 * Which band a reading has crossed, or `null` for none. Highest first, so at
 * most one demand reaches a turn.
 *
 * It carries no counter prefix: `lib/hook-block.test.ts` reads every prefix off
 * the `blockStop` call site as a string literal, and `lib/arbiter-markers.js`'s
 * sweep needs the same list statically, so a prefix computed here would sweep
 * nothing and leave a counter per session behind for ever.
 * @param {number} tokens
 * @param {number} turns
 * @param {{tripwire: boolean, windUp: boolean, turns: boolean}} firstBlock
 * @param {string} closing `closingSteps`' text
 * @returns {{band: "tripwire" | "wind-up" | "turns", reason: string} | null}
 */
function bandFor(tokens, turns, firstBlock, closing) {
	if (tokens >= TRIPWIRE && firstBlock.tripwire)
		return { band: "tripwire", reason: tripwireReason(tokens, closing) };
	if (tokens >= WIND_UP)
		return {
			band: "wind-up",
			reason: [
				`Standing context is ${n(tokens)} tokens — past the ${n(WIND_UP)} WIND-UP NOTICE in docs/effort-guide.md, and a floor, being one turn stale.`,
				"",
				"This is not a stop. Finish the unit of work in flight — one ticket, one bundle member — even if a compaction fires while you do, and start no new one. Commit. If the issue you were working is still open, comment its state on it and leave it open. The next unit goes to a fresh session.",
				"",
				closing,
				"",
				founderDeliverableRule(firstBlock.windUp),
				"",
				`THIS FIRES AGAIN AND AGAIN FROM HERE ON, not once (mantahostels#2601) — at every other Stop ending on \`result:\` or no status marker, the one straight after each block being stood down; \`waiting:\` and \`needs input:\` pass and spend no block (#919). Every further turn costs one of its own, so the cheap move is to finish and end rather than to read past it. Read the figure yourself with \`node ${scriptPath("session-context.js")}\`.`,
			].join("\n"),
		};
	if (turns >= TURN_BAND)
		return {
			band: "turns",
			reason: [
				`This session has made ${n(turns)} model responses — past the ${n(TURN_BAND)}-TURN NOTICE in docs/effort-guide.md, and a floor, being one turn stale. A turn here is one model response, each tool call included, not one message from the founder.`,
				"",
				`Standing context now reads ${n(tokens)} tokens. Spend is turns x standing context, so a long session costs even where that reading is low — after a compaction included.`,
				"",
				"This is a notice, not a limit and not a stop. Finish the ticket in hand — every step it still needs, its close included — even if a compaction fires while you do, then end. What it rules out is STARTING a different ticket or bundle member. Never leave the ticket in hand's remaining steps to a fresh session on the strength of this notice: a fresh session re-reads everything this one already holds, and saves nothing.",
				"",
				closing,
				"",
				founderDeliverableRule(firstBlock.turns),
				"",
				"THIS FIRES AGAIN, up to three times in all (mantahostels#2619) — at every other Stop ending on `result:` or no status marker, the one straight after each block being stood down; `waiting:` and `needs input:` pass (#919). Every further turn costs one of its own, so the cheap move is to finish and end rather than to read past it.",
			].join("\n"),
		};
	return null;
}

/**
 * The tripwire's one block. Its `TRIPWIRE in ` phrase is the needle
 * `scripts/guard-fire-needles.json` attributes a fire by — never the path
 * after it, which an install spells at the plugin root (#1452).
 * @param {number} tokens
 * @param {string} closing
 */
function tripwireReason(tokens, closing) {
	return [
		`Standing context is ${n(tokens)} tokens — past the ${n(TRIPWIRE)} TRIPWIRE in docs/effort-guide.md, and a floor, being one turn stale.`,
		"",
		"Reaching it means autocompaction did not fire before it. Check `autoCompactWindow` in the project's `.claude/settings.json`: it must be an integer, such as 320000. The key silently drops any other value, and the default then fires at ~967,000.",
		"",
		"Commit what exists, comment the unfinished state on any open issue you are working, and end your turn. Start no new unit of work.",
		"",
		closing,
		"",
		founderDeliverableRule(true),
		"",
		`This fires once per session. Read the figure yourself with \`node ${scriptPath("session-context.js")}\`.`,
	].join("\n");
}

/**
 * The paragraph every block carries once the session has autocompacted.
 * @param {number} count
 */
function compactionParagraph(count) {
	return `${compactionSentence(count)} The standing-context figure restarted from the compaction's summary, so it understates what this session has carried.`;
}

/**
 * Records a fail-open in the guard-error log `npm run check:guard-errors`
 * reads — this guard's one breadcrumb per Stop being already spent on its
 * verdict (#62, on the house rule at mantahostels#103 §6).
 * @param {string} what
 * @param {unknown} err
 */
function logFailOpen(what, err) {
	try {
		require("./lib/arbiter-core").logError(
			`guard-session-ceiling ${what}`,
			err,
		);
	} catch {
		/* A log that cannot be written must not break the Stop. */
	}
}

/**
 * Whether this main-tier session has run park-blocked.sh, by the local
 * record the script leaves once it parks a ticket.
 * @param {string} sid
 * @param {"main"|"subagent"} tier
 */
function hasParkedBlocked(sid, tier) {
	if (tier !== "main") return false;
	return fs.existsSync(
		path.join(markersDir(hookBlock.repoRoot()), `.parked-blocked-${sid}`),
	);
}

/**
 * The turn's message and governing marker where it would end the session —
 * the marker is `result:`, or there is none — else null, as where it cannot
 * be read.
 * @param {Payload} payload
 * @param {string} file the transcript
 * @returns {{message: string, marker: string} | null}
 */
function sessionEnding(payload, file) {
	const message = textOf(payload, file, (err) => logFailOpen("message", err));
	if (!message) return null;
	const { name } = governingMarker(message);
	return name === "" || name === "result:" ? { message, marker: name } : null;
}

/**
 * Whether a `result:` ending already does what the band's closing step asks:
 * its inventory passes guard-inventory.js (#1786). False where that guard
 * cannot load or throws, so the band blocks as before.
 * @param {string} message
 * @param {string} sid
 */
function hasPassingInventory(message, sid) {
	try {
		/* Required here, as founder-deliverable.js is above: only an ending a
		 * band would refuse pays for the load — and for the `gh` read of each
		 * cited issue, which passes where GitHub is unreachable, so a closed
		 * issue then stands the band down too. */
		return require("./guard-inventory").hasPassingInventory(message, sid);
	} catch (err) {
		logFailOpen("inventory", err);
		return false;
	}
}

/**
 * This session's launches still out, or `[]` where the transcript cannot be
 * read or parses to nothing, failing open (#1179 Q2 (B)).
 * @param {string} file the transcript
 */
function pendingLaunches(file) {
	try {
		const seen = pendingTasks(file);
		return seen.records ? seen.pending : [];
	} catch (err) {
		logFailOpen("pending", err);
		return [];
	}
}

/**
 * EVERY PATH BELOW FAILS OPEN AND LEAVES A BREADCRUMB (mantahostels#1731, on the house rule
 * at mantahostels#103 §6 — breaking a session is worse than missing one). The breadcrumb is
 * what stops a fail-open becoming permanent silence: a guard that quietly stops
 * reading is byte-identical on disk to one the harness never fired (mantahostels#872).
 * `check-stop-guard-outcomes.js` reads it at session start. The two paths that
 * do not appear here — an unparseable payload and a missing session id — are
 * `lib/stop-guard.js`'s, and crumb the same vocabulary from there.
 * @param {{sessionId: string, payload: Payload,
 *   note: (outcome: string, payload?: Payload) => void}} ctx
 */
function review({ sessionId: sid, payload, note }) {
	const file = sessionTranscript.resolve(payload, sid);
	if (!file) {
		note("no-transcript", payload);
		return;
	}

	let read;
	let turns = 0;
	/** @type {"main"|"subagent"} */
	let tier = "main";
	/** @type {string[]} */
	let boundaries = [];
	try {
		const text = sessionTranscript.read(file);
		tier = isSubagentTranscript(file) ? "subagent" : "main";
		read = lastStandingContext(text, tier);
		turns = countTurns(text, tier);
		boundaries = autocompactions(text, tier);
	} catch {
		note("unreadable-transcript", payload);
		return;
	}
	/* Recorded on every Stop, a stood-down or unjudgeable one included, so no
	 * boundary is missed before it scrolls out of the tail. A subagent's own
	 * are counted from its tail and kept out of its parent's set (#1785). */
	const compactions =
		tier === "main" ? recordCompactions(sid, boundaries) : boundaries.length;
	/* No usage record is NOT a low reading. Silence is the only safe answer —
	 * and `empty-message` is the vocabulary's word for a transcript that yielded
	 * nothing to judge. */
	if (!read) {
		note("empty-message", payload);
		return;
	}

	/* Noted after the verdict, so a stand-down crumbs its own outcome, and in
	 * `finally`, so a throw still leaves the one breadcrumb. */
	let outcome = "message";
	try {
		outcome = judge({ sid, payload, file, read, turns, tier, compactions });
	} finally {
		note(outcome, payload);
	}
}

/**
 * Which band, if any, refuses this Stop. `compactions` adds its paragraph to
 * whichever block goes out and opens none of its own.
 * @param {{sid: string, payload: Payload, file: string,
 *   read: {tokens: number}, turns: number, tier: "main"|"subagent",
 *   compactions: number}} ctx
 * @returns {"message" | "inventory-stand-down"} the outcome to crumb
 */
function judge({ sid, payload, file, read, turns, tier, compactions }) {
	/** @param {string} reason */
	const withCount = (reason) =>
		compactions ? `${reason}\n\n${compactionParagraph(compactions)}` : reason;

	/* Already continuing because some Stop hook blocked — a SIBLING'S or THIS
	 * GUARD'S OWN: adding a second demand to the same turn teaches neither.
	 *
	 * IT IS THIS GUARD'S OWN BLOCK MOST OF THE TIME, which is what "blocks every
	 * Stop" costs in practice: the Stop after one of ours carries the flag, so
	 * the repeating band lands on every OTHER Stop rather than every one (mantahostels#2601).
	 * The flag does not say which guard set it.
	 *
	 * Tested after the read, not before, so that every invocation leaves exactly
	 * one breadcrumb. */
	if (payload?.stop_hook_active === true) return "message";

	/* The tripwire blocks once; past it the wind-up band governs, its first
	 * block taking the pointer because the tripwire already printed the rule. */
	const tripwireSpent = hookBlock.capSpent({
		prefix: ".session-ceiling-nagged-hard-",
		sessionId: sid,
		max: 1,
	});
	const pending =
		read.tokens >= WIND_UP || turns >= TURN_BAND ? pendingLaunches(file) : [];
	const band = bandFor(
		read.tokens,
		turns,
		{
			tripwire: !tripwireSpent,
			windUp:
				!tripwireSpent &&
				!hookBlock.capSpent({
					prefix: ".session-ceiling-nagged-windup-",
					sessionId: sid,
					max: 1,
				}),
			turns: !hookBlock.capSpent({
				prefix: ".session-ceiling-nagged-turns-",
				sessionId: sid,
				max: 1,
			}),
		},
		closingSteps(pending),
	);
	if (!band) return "message";
	if (band.band === "tripwire") {
		hookBlock.blockStop({
			prefix: ".session-ceiling-nagged-hard-",
			sessionId: sid,
			reason: withCount(band.reason),
			max: 1,
		});
		return "message";
	}
	/* A session that ran the script has already left its ticket in the tracker,
	 * so the wind-up text would refuse it a turn for nothing (#53 story 46) —
	 * unless its own work is still out, which the record does not settle. */
	if (
		band.band === "wind-up" &&
		pending.length === 0 &&
		hasParkedBlocked(sid, tier)
	)
		return "message";
	/* Past the tripwire's one block, only a session-ending turn is refused
	 * (#919); returning here spends no counter. */
	const ending = sessionEnding(payload, file);
	if (!ending) return "message";
	if (
		ending.marker === "result:" &&
		pending.length === 0 &&
		hasPassingInventory(ending.message, sid)
	)
		return "inventory-stand-down";
	/* `lastBlockNotice` announces the third and last block, so the silence
	 * after it does not read as a turn got right.
	 *
	 * SPELLED OUT RATHER THAN TAKEN FROM `hookBlock.MAX_BLOCKS`, which it happens
	 * to equal: this 3 rests on mantahostels#2601's compliance ladder
	 * (mantahostels#2619), so a future change to the house default must not
	 * silently move it. */
	if (band.band === "turns") {
		hookBlock.blockStop({
			prefix: ".session-ceiling-nagged-turns-",
			sessionId: sid,
			reason: withCount(band.reason),
			max: 3,
		});
		return "message";
	}
	/* No cap: this band blocks every session-ending Stop past 200,000
	 * (mantahostels#2601). The counter is still written, so the marker sweep and
	 * the outcome reader see it as they see every other band, and it records how
	 * many turns were spent past the band. `lastBlockNotice` is unreachable here by construction. */
	hookBlock.blockStop({
		prefix: ".session-ceiling-nagged-windup-",
		sessionId: sid,
		reason: withCount(band.reason),
		max: Number.POSITIVE_INFINITY,
	});
	return "message";
}

if (require.main === module) stopGuard.onPayload({ review, record: true });
