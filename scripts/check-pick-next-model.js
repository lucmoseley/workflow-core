#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");

const { now, runCheck } = require("./lib/check");
const { oneCopyEach, projectDirs } = require("./lib/project-dirs");
const { mainChainRecords } = require("./lib/transcript");
const {
	flatUsage,
	hasUsage,
	mergeRequest,
	pricedTokens,
} = require("./lib/session-spend");
const deliveryStamp = require("./lib/delivery-stamp");
const { caught } = require("./lib/caught.js");

const CHECKER = "pick-next-model";

const COMMAND = "pick-next";

// guess, lucmoseley/mantahostels#1334
const DEFAULT_DAYS = 7;

const WEIGHTS = { fi: 15.0, out: 75.0, cw: 18.75, cw1h: 30.0, cr: 1.5 };
const PRICED = /** @type {const} */ (["fi", "out", "cw", "cw1h", "cr"]);

const OPUS_5_5 = { fi: 0.8, out: 0.8, cw: 0.8, cw1h: 0.8, cr: 0.4 };
const HAIKU = { fi: 0.02, out: 0.02, cw: 0.02, cw1h: 0.02, cr: 0.02 };
const OPUS_5 = { fi: 1, out: 1, cw: 1, cw1h: 1, cr: 1 };

// measured 7 files capped at 1 MiB against 58 at 256 kB, #362
const HEAD_BYTES = 1024 * 1024;

// guess, above the measured 12 MB largest transcript, lucmoseley/mantahostels#1731
const WHOLE_FILE_LIMIT = 64 * 1024 * 1024;

const COMMAND_RE =
	/<command-name>\s*(?:\/\s*)?([a-zA-Z0-9_:-]+)\s*<\/command-name>/;

/**
 * @param {Record<string, number>} u
 * @param {Record<(typeof PRICED)[number], number>} rate
 * @returns {number}
 */
const usd = (u, rate) => {
	const [fi, out, cw, cw1h, cr] = pricedTokens(u);
	const tokens = { fi, out, cw, cw1h, cr };
	return PRICED.reduce((s, k) => s + tokens[k] * WEIGHTS[k] * rate[k], 0) / 1e6;
};

/**
 * @param {string | null | undefined} model
 */
function rateOf(model) {
	const l = (model || "").toLowerCase();
	if (l.includes("haiku")) return HAIKU;
	if (/opus-5-5(?!\d)/.test(l)) return OPUS_5_5;
	return OPUS_5;
}

/**
 * @param {string} file
 * @returns {{ text: string, capped: boolean }}
 */
function readHead(file) {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(HEAD_BYTES);
		const got = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
		return {
			text: buf.subarray(0, got).toString("utf8"),
			capped: got >= HEAD_BYTES,
		};
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * @param {import("./lib/transcript.js").TranscriptRecord} record
 * @returns {number | null}
 */
function timestampOf(record) {
	if (typeof record.timestamp !== "string") return null;
	const t = Date.parse(record.timestamp);
	return Number.isNaN(t) ? null : t;
}

/**
 * @param {import("./lib/transcript.js").TranscriptRecord} record
 * @param {{ models: Set<string>, requests: Map<string, import("./lib/session-spend").RequestUsage> }} into
 */
function tallyAssistant(record, { models, requests }) {
	const message = record.message || {};
	const usage = message.usage;
	if (!usage) return;
	const flat = flatUsage(usage);

	const billed = hasUsage(flat);
	const model =
		billed && typeof message.model === "string" && message.model
			? message.model
			: null;
	if (model) models.add(model);

	const id = record.requestId || message.id || record.uuid;
	if (!id) return;
	mergeRequest(requests, id, flat).model ??= model;
}

/**
 * @param {string} text
 * @returns {{ models: Set<string>, requests: Map<string, import("./lib/session-spend").RequestUsage>, startedAt: number | null }}
 */
function scanSession(text) {
	/** @type {Set<string>} */
	const models = new Set();
	/** @type {Map<string, import("./lib/session-spend").RequestUsage>} */
	const requests = new Map();
	/** @type {number | null} */
	let startedAt = null;

	for (const record of mainChainRecords(text, "main")) {
		if (startedAt === null) startedAt = timestampOf(record);
		if (record.type !== "assistant") continue;
		tallyAssistant(record, { models, requests });
	}
	return { models, requests, startedAt };
}

/**
 * @param {Set<string>} models
 * @returns {"haiku" | "opus" | "mixed" | "unknown"}
 */
function tierOf(models) {
	let opus = false;
	let haiku = false;
	let other = false;
	for (const m of models) {
		const l = m.toLowerCase();
		if (l.includes("haiku")) haiku = true;
		else if (l.includes("opus")) opus = true;
		else other = true;
	}
	if (other) return "unknown";
	if (opus && haiku) return "mixed";
	if (opus) return "opus";
	if (haiku) return "haiku";
	return "unknown";
}

/**
 * @param {string} file
 */
const unpriced = (file) => ({
	file,
	tier: "unknown",
	cost: 0,
	forfeit: 0,
	startedAt: null,
});

/** @param {number} n */
const money = (n) =>
	`$${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

/**
 * @param {string[]} dirs
 */
function listTranscripts(dirs) {
	/** @type {string[]} */
	const unreadable = [];
	/** @type {string[]} */
	const absent = [];
	/** @type {string[]} */
	const found = [];
	for (const dir of dirs) {
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			const { code, message } = caught(e);
			if (code === "ENOENT") absent.push(dir);
			else unreadable.push(`${dir} (${code || message})`);
			continue;
		}
		for (const name of names)
			if (name.endsWith(".jsonl")) found.push(path.join(dir, name));
	}
	return { unreadable, absent, found };
}

/**
 * @param {string[]} found
 * @param {number} cutoff
 */
function filesInWindow(found, cutoff) {
	let unclassified = 0;
	/** @type {string[]} */
	const files = [];
	for (const file of oneCopyEach(found)) {
		let st;
		try {
			st = fs.statSync(file);
		} catch (e) {
			if (caught(e).code !== "ENOENT") unclassified++;
			continue;
		}
		if (!st.isFile() || st.mtimeMs < cutoff) continue;
		files.push(file);
	}
	return { files, unclassified };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ dirs: string[], unreadable: string[], absent: string[] }} listing
 */
function skipWithoutCorpus(ctx, { dirs, unreadable, absent }) {
	if (unreadable.length + absent.length !== dirs.length) return;
	const why = `no transcript directory could be read (${[...unreadable, ...absent.map((d) => `${d} (absent)`)].join("; ")}), so the /pick-next launch model is unknown — not clean.`;
	if (ctx.notify) ctx.say(`PICK-NEXT-MODEL SKIPPED — ${why}`);
	ctx.skip(why);
}

/**
 * @param {string} file
 * @param {number} cutoff
 */
function priceSession(file, cutoff) {
	let text;
	try {
		const size = fs.statSync(file).size;
		if (size > WHOLE_FILE_LIMIT) return unpriced(file);
		text = fs.readFileSync(file, "utf8");
	} catch {
		return unpriced(file);
	}
	const { models, requests, startedAt } = scanSession(text);
	if (startedAt !== null && startedAt < cutoff) return null;
	let cost = 0;
	let forfeit = 0;
	for (const { usage, model } of requests.values()) {
		const own = usd(usage, rateOf(model));
		cost += own;
		forfeit += own - usd(usage, HAIKU);
	}
	return { file, tier: tierOf(models), cost, forfeit, startedAt };
}

/**
 * @param {string} file
 * @param {number} cutoff
 */
function classifyTranscript(file, cutoff) {
	let h;
	try {
		h = readHead(file);
	} catch {
		return "unclassified";
	}
	const m = COMMAND_RE.exec(h.text);
	if (!m) {
		return h.capped ? "unclassified" : null;
	}
	if (m[1] !== COMMAND) return null;
	return priceSession(file, cutoff);
}

/**
 * @param {string[]} files
 * @param {number} cutoff
 */
function readSessions(files, cutoff) {
	let unclassified = 0;
	/** @type {{ file: string, tier: string, cost: number, forfeit: number, startedAt: number | null }[]} */
	const sessions = [];
	for (const file of files) {
		const found = classifyTranscript(file, cutoff);
		if (found === "unclassified") unclassified++;
		else if (found) sessions.push(found);
	}
	return { sessions, unclassified };
}

/**
 * @param {number} total
 * @param {number} unknown
 * @param {number} days
 */
function buildCleanOkLine(total, unknown, days) {
	if (unknown > 0)
		return `${total - unknown} of ${total} /pick-next session(s) in the last ${days}d ran on Haiku; ${unknown} carried a model this cannot read or cannot price.`;
	return `every one of ${total} /pick-next session(s) in the last ${days}d ran on Haiku.`;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ mixed: number, unknownModel: number, unclassified: number }} counts
 */
function sayMissDetail(ctx, { mixed, unknownModel, unclassified }) {
	if (mixed > 0)
		ctx.say(
			`  ${mixed} of them switched model mid-session and count as a miss.`,
		);
	if (unknownModel > 0)
		ctx.say(
			`  ${unknownModel} further session(s) carry no readable model, one this checker cannot price, or could not be read past the command, and are counted neither way.`,
		);
	if (unclassified)
		ctx.say(
			`  ${unclassified} transcript(s) would not answer a stat or yield a command name, so their launch model is unread.`,
		);
	ctx.say(
		`  Only the founder can act on this: ${scriptPath("launch.sh")} pick-next routes it, the agents view does not.`,
	);
	if (ctx.notify)
		ctx.say(
			"  Agent reading this at session start: relay that line to him. Nothing else does (mantahostels#2475).",
		);
	if (!ctx.notify)
		ctx.say(
			"\n  Nothing was changed, and this sweep cannot change anything: the launch\n" +
				"  happens in Claude Code's agents view, outside the Bash tool, where no hook\n" +
				"  can see it (mantahostels#1353). Every dollar above is the four token classes weighted\n" +
				"  at each request's model's API list ratios — a cost-equivalent, never a bill (mantahostels#829) — and it\n" +
				"  reads parent turns only, so it is a floor.\n",
		);
}

runCheck({
	name: CHECKER,
	usage: "node check-pick-next-model.js [--days <n>] [--notify] [--json]",
	valueFlags: ["--days"],
	/** @param {import("./lib/check").Ctx} ctx */
	run(ctx) {
		const days = ctx.numberValue("--days", DEFAULT_DAYS, "positive");

		const cutoff = now() - days * 86_400_000;
		const dirs = projectDirs();

		const { unreadable, absent, found } = listTranscripts(dirs);
		const windowed = filesInWindow(found, cutoff);

		skipWithoutCorpus(ctx, { dirs, unreadable, absent });

		const read = readSessions(windowed.files, cutoff);
		const { sessions } = read;
		const unclassified = windowed.unclassified + read.unclassified;

		const by = (/** @type {string} */ t) =>
			sessions.filter((s) => s.tier === t);
		const opus = by("opus");
		const mixed = by("mixed");
		const unknownModel = by("unknown");
		const missed = [...opus, ...mixed];
		const spent = missed.reduce((s, m) => s + m.cost, 0);
		const forfeited = missed.reduce((s, m) => s + m.forfeit, 0);

		const data = {
			windowDays: days,
			sessions: sessions.length,
			missed: missed.length,
			opus: opus.length,
			mixed: mixed.length,
			haiku: by("haiku").length,
			unknownModel: unknownModel.length,
			unclassifiedFiles: unclassified,
			unreadableDirs: unreadable,
			absentDirs: absent,
			spent,
			forfeited,
		};

		if (unreadable.length > 0)
			ctx.warn(
				"UNREADABLE-TRANSCRIPT-DIR",
				`${unreadable.length} transcript director(ies) could not be read (${unreadable.join("; ")}), so any /pick-next session under them went unread`,
				{ unreadable },
			);

		if (missed.length === 0)
			return {
				okLine: buildCleanOkLine(sessions.length, unknownModel.length, days),
				data,
			};

		const signature = JSON.stringify(
			missed.map((m) => path.basename(m.file)).sort(),
		);
		if (deliveryStamp.alreadyDelivered(ctx, CHECKER, signature))
			return {
				okLine: `${missed.length} of ${sessions.length} /pick-next session(s) in the last ${days}d missed, every one already reported.`,
				data,
			};

		const rate = Math.round((missed.length / sessions.length) * 100);
		ctx.warn(
			"PICK-NEXT-ON-OPUS",
			`${missed.length} of ${sessions.length} /pick-next session(s) in the last ${days}d ran on a non-Haiku model (${rate}%), forfeiting ${money(forfeited)} of ${money(spent)} spent`,
			data,
		);

		ctx.say(
			`PICK-NEXT-ON-OPUS (${missed.length} of ${sessions.length}) — /pick-next sessions in the last ${days}d ran on a non-Haiku model, ${rate}% of them. ` +
				`They spent ${money(spent)}; ${money(forfeited)} of that was forfeited (each request against Haiku's price for it, #4919).`,
		);
		sayMissDetail(ctx, {
			mixed: mixed.length,
			unknownModel: unknownModel.length,
			unclassified,
		});

		deliveryStamp.markDelivered(ctx, CHECKER, signature);

		return {
			okLine: `every one of ${sessions.length} /pick-next session(s) in the last ${days}d ran on Haiku.`,
			noun: "/pick-next session(s) launched off Haiku",
			count: missed.length,
			stamp: signature,
			data,
		};
	},
});
