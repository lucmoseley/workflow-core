#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");

const { errorLog, rootlessErrorLog } = require("./lib/arbiter-store");
const { readProcStartOf } = require("./lib/arbiter-proc");
const { rotateLog } = require("./lib/log-rotate");
const deliveryStamp = require("./lib/delivery-stamp");
const { caught } = require("./lib/caught.js");

const CHECKER = "guard-errors";

/**
 * @param {string | null} raw
 * @returns {Record<string, string>}
 */
function readSeen(raw) {
	if (raw === null) return {};
	try {
		const seen = JSON.parse(raw);
		return seen && typeof seen === "object" && !Array.isArray(seen) ? seen : {};
	} catch {
		return {};
	}
}

const INERT_CHECKER = "guard-errors-inert";
const INERT_SIGNATURE = "inert";

const MAX_REPORTED = 20;

/**
 * @param {string} line
 */
function entryFor(line) {
	const [when, where, what] = line.split("\t");
	if (when !== undefined && where !== undefined && what !== undefined) {
		const at = Date.parse(when);
		if (Number.isFinite(at)) return { when, where, what, at };
	}
	return {
		when: "(no timestamp)",
		where: "log",
		what: `torn line — a writer died mid-append: ${line.slice(0, 160)}`,
		at: Number.NaN,
	};
}

/**
 * @param {{when: string, where: string, what: string}[]} entries
 */
function groupFaults(entries) {
	const groups = [];
	const byKey = new Map();
	for (const e of entries) {
		const key = `${e.where}\t${e.what}`;
		let g = byKey.get(key);
		if (!g) {
			g = {
				where: e.where,
				what: e.what,
				count: 0,
				first: e.when,
				last: e.when,
			};
			byKey.set(key, g);
			groups.push(g);
		}
		g.count++;
		g.last = e.when;
	}
	return groups;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {ReturnType<typeof groupFaults>} groups
 */
function sayGroups(ctx, groups) {
	for (const g of groups.slice(0, MAX_REPORTED)) {
		const when =
			g.count > 1 ? `${g.first} … ${g.last}  (${g.count}×)` : g.first;
		ctx.say(`  ${when}  ${g.where}\n    ${g.what}`);
	}
	if (groups.length > MAX_REPORTED)
		ctx.say(`  ... and ${groups.length - MAX_REPORTED} more`);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ days: number, logPath: string }} args
 */
function reportRootlessFailOpens(ctx, { days, logPath }) {
	const whole = readRootlessLog(ctx, logPath);
	if (whole === null) return;
	try {
		const entries = recentRootless(whole, Date.now() - days * 86_400_000);
		if (entries.length > 0) sayRootless(ctx, entries, logPath);
	} finally {
		const problem = rotateLog(logPath, whole.length);
		if (problem) {
			ctx.warn("LOG-ROTATION", problem);
			ctx.say(`${problem}\n`);
		}
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} logPath
 */
function readRootlessLog(ctx, logPath) {
	try {
		return fs.readFileSync(logPath);
	} catch (e) {
		const { code } = caught(e);
		if (code === "ENOENT") return null;
		ctx.fail(
			"GUARD-ROOT",
			`${logPath} exists and cannot be read (${code ?? e}) — whatever fail-opens it holds cannot be evaluated`,
			{ logPath, code },
		);
		ctx.say(
			`${logPath} exists and cannot be read (${code ?? e}).\n` +
				"It holds the fail-opens recorded with no repo root, so an all-clear below\n" +
				"would be about the wrong thing.\n",
		);
		return null;
	}
}

/**
 * @param {Buffer} whole
 * @param {number} cutoff
 */
function recentRootless(whole, cutoff) {
	return whole
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map(entryFor)
		.filter((entry) => !(Number.isFinite(entry.at) && entry.at < cutoff));
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {ReturnType<typeof entryFor>[]} entries
 * @param {string} logPath
 */
function sayRootless(ctx, entries, logPath) {
	const groups = groupFaults(entries);
	for (const g of groups)
		ctx.fail(
			"GUARD-ROOT",
			`${g.count > 1 ? `${g.count}× ` : ""}no repo root — ${g.what}`,
			g,
		);
	ctx.say(
		`${entries.length} fail-open(s) were recorded with no repo root at all.\n` +
			"The guard that wrote each could name no project to file it under and no rule\n" +
			"latch of its own; an unreadable scripts/lib/guard-root.sh is what does that.\n" +
			"Which project each came from is unrecoverable, so this is reported in all of them.\n",
	);
	sayGroups(ctx, groups);
	ctx.say(`\nLog: ${logPath}`);
}

const digestOf = (/** @type {Buffer} */ bytes) =>
	crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);

/**
 * @param {string} raw
 * @param {number} cutoff
 */
function recentWithOffsets(raw, cutoff) {
	let offset = 0;
	/** @type {(ReturnType<typeof entryFor> & { start: number })[]} */
	const recent = [];
	for (const line of raw.split("\n")) {
		const start = offset;
		offset += Buffer.byteLength(line) + 1;
		if (!line) continue;
		const entry = entryFor(line);
		if (Number.isFinite(entry.at) && entry.at < cutoff) continue;
		recent.push({ ...entry, start });
	}
	return recent;
}

/**
 * @template {{ start: number }} E
 * @param {E[]} recent
 * @param {Buffer} buf
 * @param {string | undefined} stamped
 */
function unreported(recent, buf, stamped) {
	const [offsetRaw, seenDigest] = (stamped ?? "").split("\t");
	let seen = Number(offsetRaw) || 0;
	if (seen > buf.length || digestOf(buf.subarray(0, seen)) !== seenDigest)
		seen = 0;
	return recent.filter((e) => e.start >= seen);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ days: number, logPath: string, whole: Buffer }} args
 */
function reportFailOpens(ctx, { days, logPath, whole }) {
	const cutoff = Date.now() - days * 86_400_000;
	const buf = whole.subarray(0, whole.lastIndexOf(0x0a) + 1);
	const size = buf.length;
	const recent = recentWithOffsets(buf.toString("utf8"), cutoff);

	if (whole.length > size)
		recent.push({
			when: "(no timestamp)",
			where: "log",
			what: `unterminated final line — either a writer is mid-append or one died there: ${whole
				.subarray(size, size + 640)
				.toString("utf8")
				.slice(0, 160)}`,
			at: Number.NaN,
			start: size,
		});

	if (recent.length === 0)
		return { okLine: `no guard fail-opens in the last ${days} days.` };

	const stored = readSeen(deliveryStamp.readStamp(CHECKER));
	const signature = JSON.stringify({
		...stored,
		[logPath]: `${size}\t${digestOf(buf)}`,
	});
	let report = recent;

	if (deliveryStamp.readSeenStamp(ctx, CHECKER) !== null) {
		report = unreported(recent, buf, stored[logPath]);
		if (report.length === 0)
			return { okLine: `no new guard fail-opens in the last ${days} days.` };
	}

	const groups = groupFaults(report);
	const guards = new Set(report.map((e) => e.where));

	for (const g of groups)
		ctx.fail(
			"GUARD-ERROR",
			`${g.count > 1 ? `${g.count}× ` : ""}${g.where} — ${g.what}`,
			g,
		);

	ctx.say(
		`${report.length} guard fail-open(s) from ${guards.size} source(s) in the last ${days} days.\n` +
			"Every one of these ALLOWED an action it could not check, so whatever the guard protects was unprotected at the time.\n",
	);
	sayGroups(ctx, groups);
	ctx.say(`\nLog: ${logPath}`);
	if (fs.existsSync(`${logPath}.1`))
		ctx.say(`\nOlder entries, rotated aside: ${logPath}.1`);

	deliveryStamp.markDelivered(ctx, CHECKER, signature);

	return {
		stamp: signature,
		noun: `distinct guard fail-open(s) in the last ${days} days`,
		data: { logPath, days, groups, errors: report },
	};
}

runCheck({
	name: CHECKER,
	usage: "node check-guard-errors.js [--days <n>] [--notify]",
	valueFlags: ["--days"],
	run(ctx) {
		const days = ctx.has("--days") ? Number(ctx.value("--days")) : 7;
		if (!Number.isFinite(days) || days <= 0)
			ctx.usageError("--days must be a positive number.");

		const logPath = errorLog();

		/** @type {string | null} */
		let inertStamp = null;

		const lib = "lib/guard-log.sh";
		const at = path.join(__dirname, lib);
		try {
			fs.accessSync(at, fs.constants.R_OK);
		} catch {
			ctx.fail(
				"GUARD-LIBRARY",
				`${lib} is missing or unreadable — the hooks that source it allow everything through, and cannot log that they did`,
				{ path: at },
			);
			ctx.say(
				`scripts/${lib} is missing or unreadable.\n` +
					"Hooks sourcing it fail open in silence, so the log below cannot be trusted to be empty for the right reason.\n",
			);
		}

		reportRootlessFailOpens(ctx, {
			days,
			logPath: rootlessErrorLog(),
		});

		if (
			readProcStartOf(process.pid) === null &&
			!deliveryStamp.alreadyDelivered(ctx, INERT_CHECKER, INERT_SIGNATURE)
		) {
			const msg =
				"cannot read /proc for this very process, so session liveness cannot be\n" +
				"evaluated at all. The file-claim guard is inert on this platform: it refuses\n" +
				"nothing and logs nothing, so an empty log proves nothing about that one.\n" +
				"No other guard asks whether a session is alive, so the rest are unaffected.";
			ctx.warn("INERT", msg);
			ctx.say(`${msg}\n`);
			deliveryStamp.markDelivered(ctx, INERT_CHECKER, INERT_SIGNATURE);
			inertStamp = INERT_SIGNATURE;
		}

		/**
		 * @param {import("./lib/check").CheckResult} result
		 */
		const withInertStamp = (result) =>
			inertStamp && ctx.findings.every((f) => f.tag === "INERT")
				? {
						...result,
						stamps: { ...result.stamps, [INERT_CHECKER]: inertStamp },
					}
				: result;

		if (!fs.existsSync(logPath))
			return withInertStamp({
				okLine: `no guard fail-opens logged (${logPath} does not exist).`,
				noun: "reason the guards cannot be evaluated",
			});

		let reported = false;
		/** @type {Buffer | undefined} */
		let whole;
		try {
			whole = fs.readFileSync(logPath);
			const out = reportFailOpens(ctx, { days, logPath, whole });
			reported = true;
			return withInertStamp(out);
		} finally {
			if (reported && whole) {
				const problem = rotateLog(logPath, whole.length);
				if (problem) {
					ctx.warn("LOG-ROTATION", problem);
					ctx.say(`${problem}\n`);
				}
			}
		}
	},
});
