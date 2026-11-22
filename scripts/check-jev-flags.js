#!/usr/bin/env node

const { runCheck, errMessage } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");
const deliveryStamp = require("./lib/delivery-stamp");
const hookBlock = require("./lib/hook-block");
const jevLog = require("./lib/jev-log.js");
const { readJsonl } = require("./lib/jsonl.js");
const jevTrial = require("./lib/jev-trial.js");

const CHECKER = "jev-flags";

const REPORTED = new Map([
	["flagged", { tag: "JEV-FLAG", label: "FLAG      ", count: "flagged" }],
	["outage", { tag: "JEV-OUTAGE", label: "OUTAGE    ", count: "outages" }],
	[
		"malformed",
		{ tag: "JEV-MALFORMED", label: "MALFORMED ", count: "malformed" },
	],
	["refused", { tag: "JEV-REFUSED", label: "REFUSED   ", count: "refused" }],
]);

const MAX_LISTED = 10;

/**
 * @typedef {{at?: unknown, session?: unknown, outcome?: unknown,
 *   confidence?: unknown, messageHash?: unknown,
 *   messageText?: unknown, model?: unknown, provider?: unknown}} LogLine
 */

/**
 * @param {LogLine} line
 */
function said(line) {
	return (
		REPORTED.get(String(line.outcome)) ?? {
			tag: "JEV-FLAG",
			label: "FLAG      ",
			count: "flagged",
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
	const model =
		typeof line.model === "string"
			? ` ${line.model}${typeof line.provider === "string" ? ` via ${line.provider}` : ""}`
			: "";
	const judged =
		line.outcome === "flagged" && verdicts
			? `, ${verdicts.get(String(line.messageHash))?.verdict ?? "unjudged"}`
			: "";
	return `${String(line.at)}  session ${session}  message ${hash}${confidence}${model}${judged}`;
}

const INDENT = " ".repeat(14);

const QUOTE = `${INDENT.slice(2)}| `;

/**
 * @param {LogLine} line
 * @param {Map<string, {verdict: string}>} verdicts
 * @returns {string[]}
 */
function quoteFlag(line, verdicts) {
	if (line.outcome !== "flagged") return [];
	const hash = typeof line.messageHash === "string" ? line.messageHash : null;
	if (hash && verdicts.get(hash)) return [];
	if (typeof line.messageText !== "string" || !line.messageText)
		return [
			`${INDENT}(no text stored — logged before #285, so it cannot be judged now)`,
		];
	const out = hash
		? [`${INDENT}node ${scriptPath("jev-verdict.js")} ${hash} right|wrong`]
		: [];
	for (const text of line.messageText.split("\n")) out.push(`${QUOTE}${text}`);
	return out;
}

const UNREADABLE =
	"  TRIAL — standing not computed: the verdict store would not read.\n";

/**
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
		"    (#253, #285). Limb 2 counts from its own line, which is earlier and\n" +
		"    kept every session of evidence when the trial's line moved. It\n" +
		"    voids:\n" +
		s.outageVoids.map((v) => `      ${v.from} to ${v.to}, ${v.why}.\n`).join("")
	);
}

/**
 * @param {string} root
 * @param {number | null} since
 */
function readLogs(root, since) {
	const live = readJsonl(jevLog.logPath(root));
	/** @type {import("./lib/jsonl.js").Jsonl | null} */
	let rotated = null;
	const oldestLive = live?.rows.map(jevLog.whenOf).find((ms) => ms !== null);
	if (since === null || (oldestLive !== undefined && oldestLive > since))
		rotated = readJsonl(jevLog.previousLogPath(root));
	return { live, rotated };
}

/**
 * @param {string} root
 * @param {LogLine[]} all
 */
function readStanding(root, all) {
	let verdicts = new Map();
	try {
		verdicts = jevTrial.readVerdicts(root);
		return { verdicts, standing: jevTrial.stand({ lines: all, verdicts }) };
	} catch {
		return { verdicts, standing: null };
	}
}

/**
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
 * @param {import("./lib/check").Ctx} ctx
 * @param {LogLine[]} pending
 * @param {Record<string, number>} counts
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
		`${[...REPORTED.values()].map((r) => `${r.tag} (${counts[r.count]})`).join(" / ")} — raised by the Jev advisory guard ${ctx.notify ? "since this was last shown" : "across the kept log"}:\n`,
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
			return ctx.skip(`the Jev advisory log would not read: ${errMessage(e)}`);
		}
		const { live, rotated } = logs;
		if (live === null)
			return { okLine: "the Jev advisory guard has logged nothing here yet." };

		const all = /** @type {LogLine[]} */ ([
			...(rotated?.rows ?? []),
			...live.rows,
		]);
		const torn = [rotated, live].reduce(
			(n, read) => n + (read?.bad.length ?? 0),
			0,
		);

		const { verdicts, standing } = readStanding(root, all);

		const { pending, newest } = pendingSince(all, since);

		if (pending.length === 0) {
			if (!ctx.notify)
				ctx.say(standing ? buildStandingReport(standing) : UNREADABLE);
			else if (!standing) ctx.say(UNREADABLE);
			return {
				okLine: `no unreported Jev advisory flag in ${all.length} logged turn(s).`,
				data: { logged: all.length, torn, standing },
			};
		}

		pending.sort((a, b) => (jevLog.whenOf(a) ?? 0) - (jevLog.whenOf(b) ?? 0));
		/** @type {Record<string, number>} */
		const counts = Object.fromEntries(
			[...REPORTED.values()].map((r) => [r.count, 0]),
		);
		for (const line of pending) {
			const key = said(line).count;
			counts[key] = (counts[key] ?? 0) + 1;
		}

		listPending(ctx, pending, counts, verdicts);
		ctx.say(
			"\n  A FLAG is a turn that put a choice to you in plain prose. The\n" +
				"  adoption is reversed (#175) at more than one WRONG flag in ten flagged\n" +
				"  turns over the first 20 sessions, or an outage notice in more than\n" +
				"  one session in ten. A MALFORMED line counts toward neither limb: the\n" +
				"  vendor answered in a shape the guard cannot read, which is a fix here\n" +
				"  rather than grounds for reversal (#226). Nor does a REFUSED line:\n" +
				"  the gateway turned the key away, so store a working one with\n" +
				`  node ${scriptPath("write-secret.js")} AI_GATEWAY_API_KEY (#4144).\n` +
				"\n  An unjudged flag is quoted above with the command that judges it,\n" +
				"  so the judging need not happen in the session that raised it\n" +
				"  (#285). A flag logged with no text cannot be judged at all; it\n" +
				"  says so in place of the quote.\n" +
				`\n  Log: ${jevLog.logPath(root)}\n`,
		);
		ctx.say(standing ? buildStandingReport(standing) : UNREADABLE);

		const signature = deliveryStamp.highWater(newest);
		deliveryStamp.markDelivered(ctx, CHECKER, signature);

		return {
			noun: "Jev advisory flag(s)",
			stamp: signature,
			data: {
				...counts,
				logged: all.length,
				torn,
				since,
				newest,
				standing,
			},
		};
	},
});
