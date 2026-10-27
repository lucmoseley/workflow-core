#!/usr/bin/env node
/*
 * check-jev-flags.js — say on `npm run status` what the Jev advisory guard
 * flagged, so a background job's warn is not lost (workflow-core#202). Not a SessionStart
 * hook (workflow-core#2038): the founder judges the flags, and no starting session acts on
 * them, so `npm run status` gives it its `--notify` run.
 *
 * Usage:  npm run check:jev-flags  [--root <dir>] [--notify] [--json]
 *
 * WHY IT EXISTS. `guard-jev-advisory.js` (workflow-core#203, spec workflow-core#200) warns through
 * `systemMessage`, the only channel at `Stop` that never reaches the model —
 * and a foreground terminal is the only thing that renders it. A BACKGROUND
 * JOB HAS NO TERMINAL, so every flag raised in one is written to the log and
 * read by nobody until somebody opens the file. workflow-core#175's stop condition counts
 * wrong flags in flagged turns.
 *
 * WHAT IT READS: `lib/jev-log.js`'s JSONL log for the turns, and
 * `lib/jev-trial.js`'s verdict store for what the founder made of each flag.
 * The log stays the sole record of what HAPPENED — a report of turns derived
 * from anything else would be a second thing to keep true — and the verdict
 * store holds only what the log structurally cannot, a judgement made after
 * the fact (workflow-core#253).
 *
 * WHAT IT REPORTS: the three outcomes that were meant for the founder's screen.
 * `flagged` is the warn itself. `outage` is the notice that the check could
 * not run, which is the stop condition's SECOND limb — an outage notice in
 * more than one session in ten. `malformed` is the vendor answering in a shape
 * the guard cannot read, which is NOT that limb and never counts toward
 * reversal (workflow-core#226): it is reported because a schema drift disables the check
 * until someone fixes it here. Every `skipped-*` outcome is the gate working
 * and is never reported.
 *
 * A TURN IS NAMED BY ITS SESSION AND ITS TIMESTAMP, and an UNJUDGED FLAG is
 * quoted back in full beneath that line where the guard stored its text
 * (workflow-core#285). Nothing else is: a `clear` turn, an outage and a malformed reply
 * carry no text on their log lines at all, and a flag already judged needs no
 * quoting. A flag logged before workflow-core#285 has no text to show and says so.
 *
 * "SINCE LAST SHOWN" IS THE DELIVERY STAMP, not a clock. A `--notify` run —
 * `npm run status`'s — reports only what `lib/delivery-stamp.js`'s high-water
 * mark has not yet seen, and records it; a plain hand run answers in full,
 * every flag ever logged, and stamps nothing.
 *
 * IT REPORTS AND REFUSES NOTHING — the guard's own Advisory contract (workflow-core#173).
 * WARN, never FAIL.
 *
 * A `--notify` run is SILENT WHERE THERE IS NOTHING TO SAY: an absent log, an
 * empty one and a log holding only gate skips all print nothing at all.
 */

const { runCheck, errMessage } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");
const deliveryStamp = require("./lib/delivery-stamp");
const hookBlock = require("./lib/hook-block");
const jevLog = require("./lib/jev-log.js");
const jevTrial = require("./lib/jev-trial.js");

const CHECKER = "jev-flags";

/** The outcomes meant for the founder's screen, and how each is said. */
const REPORTED = new Map([
	["flagged", { tag: "JEV-FLAG", label: "FLAG      " }],
	["outage", { tag: "JEV-OUTAGE", label: "OUTAGE    " }],
	/* One word end to end — outcome, tag and label — so the founder shown a tag
	 * can grep the log for it. */
	["malformed", { tag: "JEV-MALFORMED", label: "MALFORMED " }],
]);

/**
 * How many are itemised before the rest become a count. Ten matches
 * `check-orphan-wait-loops.js`, and the guard's own per-session warn budget of
 * three puts three sessions' worth of flags inside it.
 */
const MAX_LISTED = 10;

/**
 * One log line, as this checker reads it. Every field is optional because the
 * file is written by another script and read here without a schema: a line
 * missing what this needs is passed over, never guessed at.
 *
 * @typedef {{at?: unknown, session?: unknown, outcome?: unknown,
 *   confidence?: unknown, messageHash?: unknown,
 *   messageText?: unknown, model?: unknown, provider?: unknown}} LogLine
 */

/**
 * How a reportable line is said. Only ever called on a line already matched
 * against `REPORTED`, which is why the fallback is unreachable rather than a
 * behaviour.
 * @param {LogLine} line
 */
function said(line) {
	return (
		REPORTED.get(String(line.outcome)) ?? {
			tag: "JEV-FLAG",
			label: "FLAG      ",
		}
	);
}

/**
 * @param {LogLine} line
 * @param {Map<string, {verdict: string}>} [verdicts]
 */
function describeTurn(line, verdicts) {
	const session =
		typeof line.session === "string" ? line.session.slice(0, 8) : "unknown";
	const hash =
		typeof line.messageHash === "string" ? line.messageHash : "no hash";
	const confidence =
		typeof line.confidence === "number" ? `, p=${line.confidence}` : "";
	/* What answered (workflow-core#702); absent from every line logged before it. */
	const model =
		typeof line.model === "string"
			? ` ${line.model}${typeof line.provider === "string" ? ` via ${line.provider}` : ""}`
			: "";
	/* Only a flag has a verdict to carry; an outage or a malformed reply is
	 * nothing to judge right or wrong. */
	const judged =
		line.outcome === "flagged" && verdicts
			? `, ${verdicts.get(String(line.messageHash))?.verdict ?? "unjudged"}`
			: "";
	return `${String(line.at)}  session ${session}  message ${hash}${confidence}${model}${judged}`;
}

/**
 * How far a quoted flag is indented: past `said()`'s label column, so the quote
 * reads as hanging off the report line above it rather than as another turn.
 */
const INDENT = " ".repeat(14);

/** The same column, with the quote rule that marks the message's own lines. */
const QUOTE = `${INDENT.slice(2)}| `;

/**
 * The flagged message itself, quoted under its own report line, with the
 * command that judges it (workflow-core#285). Only for an unjudged flag.
 *
 * @param {LogLine} line
 * @param {Map<string, {verdict: string}>} verdicts
 * @returns {string[]} the lines to say, indented, or none
 */
function quoteFlag(line, verdicts) {
	if (line.outcome !== "flagged") return [];
	const hash = typeof line.messageHash === "string" ? line.messageHash : null;
	if (hash && verdicts.get(hash)) return [];
	if (typeof line.messageText !== "string" || !line.messageText)
		return [
			`${INDENT}(no text stored — logged before workflow-core#285, so it cannot be judged now)`,
		];
	const out = hash
		? [`${INDENT}node ${scriptPath("jev-verdict.js")} ${hash} right|wrong`]
		: [];
	for (const text of line.messageText.split("\n")) out.push(`${QUOTE}${text}`);
	return out;
}

/** Said in place of the standing where the verdict store would not read. */
const UNREADABLE =
	"  TRIAL — standing not computed: the verdict store would not read.\n";

/**
 * Where workflow-core#175 stands, in four lines. The status words are `holding`,
 * `pending` and `tripped`, and `pending` is the one that matters most: it
 * means the judgements still outstanding could carry limb 1 over on their
 * own.
 * @param {import("./lib/jev-trial.js").Standing} s
 * @returns {string}
 */
function buildStandingReport(s) {
	return (
		`  TRIAL — started ${s.start}; ${s.sessions} session(s) since.\n` +
		`    limb 1 (wrong flags): ${s.limb1} — ${s.wrong} wrong, ${s.right} right, ` +
		`${s.unjudged} unjudged of ${s.flagged} flagged turn(s) over the first ` +
		`${s.limb1Sessions} session(s)${s.limb1Closed ? ", now closed" : ""}; ` +
		`reverses above 1 in ${jevTrial.WRONG_IN}.\n` +
		`    limb 2 (outages):     ${s.limb2} — ${s.outageSessions} of ${s.limb2Sessions} ` +
		`session(s) since ${s.outageStart} carried one; reverses above 1 in ` +
		`${jevTrial.OUTAGE_IN}.\n` +
		"    Turns logged before the start line are excluded: the flags among\n" +
		"    them carry a digest and no text, so none of them can be judged\n" +
		"    (workflow-core#253, workflow-core#285). Limb 2 counts from its own line, which is earlier and\n" +
		"    kept every session of evidence when the trial's line moved. It\n" +
		`    voids ${s.outageVoid.from} to ${s.outageVoid.to}, the billing wall:\n` +
		"    a missing payment, not a vendor outage (workflow-core#670).\n"
	);
}

/**
 * The live log, and the rotated half where an unreported flag could sit in it.
 * Throws where either half will not read.
 * @param {string} root
 * @param {number | null} since
 */
function readLogs(root, since) {
	/** @type {{lines: LogLine[], torn: number}|null} */
	const live = jevLog.readJsonl(jevLog.logPath(root));
	/** @type {{lines: LogLine[], torn: number}|null} */
	let rotated = null;
	const oldestLive = live?.lines.map(jevLog.whenOf).find((ms) => ms !== null);
	/* The rotated half is read only where an unreported flag could be
	 * sitting in it: where nothing has been stamped at all, and where the
	 * live log's oldest line is itself newer than the stamp, which means
	 * a rotation has moved lines out from under this run. Reading it at
	 * every start would cost a second file the size of the cap for
	 * nothing. */
	if (since === null || (oldestLive !== undefined && oldestLive > since))
		rotated = jevLog.readJsonl(jevLog.previousLogPath(root));
	return { live, rotated };
}

/**
 * @param {string} root
 * @param {LogLine[]} all
 */
function readStanding(root, all) {
	let verdicts = new Map();
	let standing = null;
	try {
		verdicts = jevTrial.readVerdicts(root);
		standing = jevTrial.stand({ lines: all, verdicts });
	} catch {
		/* FAIL OPEN, chosen at workflow-core#253: the flags still get reported, unjudged,
		 * because a report is what the reader is owed and a broken
		 * verdict store is no reason to withhold one. Said below rather
		 * than swallowed: showing zeros would read as a clean trial. */
	}
	return { verdicts, standing };
}

/**
 * The reported lines newer than the stamp, and the newest stamp among them.
 * @param {LogLine[]} all
 * @param {number | null} since
 */
function pendingSince(all, since) {
	const pending = [];
	let newest = since ?? 0;
	for (const line of all) {
		if (typeof line.outcome !== "string" || !REPORTED.has(line.outcome))
			continue;
		const ms = jevLog.whenOf(line);
		if (ms === null) continue;
		if (since !== null && ms <= since) continue;
		if (ms > newest) newest = ms;
		pending.push(line);
	}
	return { pending, newest };
}

/**
 * @param {import("./lib/check").CheckContext} ctx
 * @param {LogLine[]} pending
 * @param {{ flagged: number, outages: number, malformed: number }} counts
 * @param {Map<string, {verdict: string}>} verdicts
 */
function listPending(ctx, pending, counts, verdicts) {
	const listed = pending.slice(0, MAX_LISTED);

	for (const line of pending)
		ctx.warn(said(line).tag, describeTurn(line), {
			outcome: line.outcome,
			at: line.at,
			session: line.session,
		});

	ctx.say(
		`JEV-FLAG (${counts.flagged}) / JEV-OUTAGE (${counts.outages}) / JEV-MALFORMED (${counts.malformed}) — raised by the Jev advisory guard ${ctx.notify ? "since this was last shown" : "across the kept log"}:\n`,
	);
	for (const line of listed) {
		ctx.say(`  ${said(line).label}${describeTurn(line, verdicts)}`);
		for (const quoted of quoteFlag(line, verdicts)) ctx.say(quoted);
	}
	if (pending.length > listed.length)
		ctx.say(
			`  … and ${pending.length - listed.length} more — node ${scriptPath("check-jev-flags.js")} for the whole set.`,
		);
}

runCheck({
	name: CHECKER,
	usage: "node check-jev-flags.js [--root <dir>] [--notify] [--json]",
	valueFlags: ["--root"],
	run(ctx) {
		const root = ctx.value("--root", hookBlock.repoRoot());

		const since = deliveryStamp.readSeenHighWater(ctx, CHECKER);

		let logs;
		try {
			logs = readLogs(root, since);
		} catch (e) {
			/* Either half. The log is the SUBJECT, not the apparatus, so this is
			 * lib/check.js's SKIP rather than its BROKEN. */
			return ctx.skip(`the Jev advisory log would not read: ${errMessage(e)}`);
		}
		const { live, rotated } = logs;
		if (live === null)
			return { okLine: "the Jev advisory guard has logged nothing here yet." };

		const all = [...(rotated?.lines ?? []), ...live.lines];
		const torn = (rotated?.torn ?? 0) + live.torn;

		const { verdicts, standing } = readStanding(root, all);

		const { pending, newest } = pendingSince(all, since);

		if (pending.length === 0) {
			/* A hand run is somebody asking where the trial stands, so it answers
			 * even with nothing new to report. A `--notify` run asks only what
			 * is new. */
			if (!ctx.notify)
				ctx.say(standing ? buildStandingReport(standing) : UNREADABLE);
			else if (!standing) ctx.say(UNREADABLE);
			return {
				okLine: `no unreported Jev advisory flag in ${all.length} logged turn(s).`,
				data: { logged: all.length, torn, standing },
			};
		}

		pending.sort((a, b) => (jevLog.whenOf(a) ?? 0) - (jevLog.whenOf(b) ?? 0));
		const flags = pending.filter((l) => l.outcome === "flagged");
		const outages = pending.filter((l) => l.outcome === "outage");
		const malformed = pending.filter((l) => l.outcome === "malformed");

		listPending(
			ctx,
			pending,
			{
				flagged: flags.length,
				outages: outages.length,
				malformed: malformed.length,
			},
			verdicts,
		);
		ctx.say(
			"\n  A FLAG is a turn that put a choice to you in plain prose. The\n" +
				"  adoption is reversed (workflow-core#175) at more than one WRONG flag in ten flagged\n" +
				"  turns over the first 20 sessions, or an outage notice in more than\n" +
				"  one session in ten. A MALFORMED line counts toward neither limb: the\n" +
				"  vendor answered in a shape the guard cannot read, which is a fix here\n" +
				"  rather than grounds for reversal (workflow-core#226).\n" +
				"\n  An unjudged flag is quoted above with the command that judges it,\n" +
				"  so the judging no longer has to happen in the session that raised it\n" +
				"  (workflow-core#285). A flag logged before that change carries no text and cannot\n" +
				"  be judged at all; it says so in place of the quote.\n" +
				`\n  Log: ${jevLog.logPath(root)}\n`,
		);
		ctx.say(standing ? buildStandingReport(standing) : UNREADABLE);

		const signature = deliveryStamp.highWater(newest);
		/* Stamped after the report is out, so a process killed in between repeats
		 * the notice rather than swallowing it. A no-op on a hand run and under
		 * persist mode, where the replay reader stamps once it has shown it. */
		deliveryStamp.markDelivered(ctx, CHECKER, signature);

		return {
			noun: "Jev advisory flag(s)",
			stamp: signature,
			data: {
				flagged: flags.length,
				outages: outages.length,
				malformed: malformed.length,
				logged: all.length,
				torn,
				since,
				newest,
				standing,
			},
		};
	},
});
