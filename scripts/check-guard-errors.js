#!/usr/bin/env node
/*
 * check-guard-errors.js — report a PreToolUse guard that has been failing open.
 *
 * Usage:  npm run check:guard-errors  [--days <n>] [--notify]
 *
 * EVERY PreToolUse GUARD, since mantahostels#147. Each one fails open by house rule (mantahostels#103
 * §6) — a missing jq, an unparseable payload, a library it cannot read all ALLOW
 * the action — so a disarmed guard is indistinguishable from a guard finding
 * nothing wrong. They all now share one record, written by
 * scripts/lib/guard-log.sh:
 *
 *   <ISO 8601 UTC>\t<guard script name>\t<what was allowed unchecked>[\t<detail>]
 *
 * The optional fourth field is per-record detail (#320), deliberately unread
 * here: grouping on it would split one burst into a group per record. Read the
 * log itself for it.
 *
 * scripts/session-arbiter.js writes its own internal faults to the same log in
 * the same shape, so field 2 is the only thing that says which of them spoke.
 *
 * --notify is the quiet path, passed only by a hand run: prints nothing and
 * exits 0 when there is nothing new, so a repeated run never becomes noise the
 * reader learns to skip. "New" means further into the log than what was last
 * reported, never anything measured on the clock — a wall-clock cooldown would
 * swallow an error logged an hour after the last notice.
 *
 * The stamp is per PROJECT, not per session, so of the 10-12 concurrent sessions
 * the first to start after an error is the one told, and not necessarily the one
 * that caused it. The reader is the founder, who is in all of them, and a
 * per-session stamp would report the same fault a dozen times.
 *
 * ONE STAMP FILE, ONE ENTRY PER LOG (mantahostels#2244). scripts/lib/delivery-stamp.js keeps
 * one file per checker for the whole MACHINE, and more than one log can be
 * stamped: every plan shares the first plan's (#383), but a config dir that is
 * no plan keeps its own.
 *
 * LOCAL ONLY — deliberately not a CI job. This reads scripts/session-arbiter.js's error log under ~/.claude, which
 * exists only on the machine the sessions ran on; a runner would find an empty
 * file and report all-clear forever.
 *
 * REPORTS ONLY. Exit 1 means "a human should look at these", never that
 * something must be fixed before a commit lands. Under --notify every outcome
 * exits 0, BROKEN included — scripts/lib/check.js's exitFor, for every checker
 * (mantahostels#155 — the checker family's exit-code and severity model —
 * decision 3).
 *
 * IMPLICIT:  on `npm run status` (lifted off SessionStart into scripts/status-report.js), reads the shared guard-error log and reports any PreToolUse guard that has been failing open.
 * JUSTIFIED: fail-safe — a guard that fails open is indistinguishable from one finding nothing wrong (mantahostels#103 §6), so silence is the failure mode.
 * DEFEAT:    none; --notify is silent while no guard has logged an error in the window.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");

// The arbiter's own modules, not its CLI: session-arbiter.js exports nothing
// (mantahostels#158, built by mantahostels#159).
const { errorLog, rootlessErrorLog } = require("./lib/arbiter-store");
const { readProcStartOf } = require("./lib/arbiter-proc");
const { rotateLog } = require("./lib/log-rotate");
const deliveryStamp = require("./lib/delivery-stamp");
const { caught } = require("./lib/caught.js");

/** This checker's name, shared with its delivery-stamp file. */
const CHECKER = "guard-errors";

/**
 * The stamp's map of log path to `<offset>\t<digest>` — empty where nothing is
 * stamped, or where what is stamped will not parse, both of which mean report
 * everything.
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

/*
 * The INERT warning's stamp is a second one, under a checker name of its own,
 * because the two say different things and clear on different events: the
 * report's stamp advances with the log, this one never moves once the platform
 * has been named. `run()` hands it to the reader as `stamps`, alongside the
 * `stamp` this checker's own report carries (mantahostels#1975, mantahostels#2277).
 */
const INERT_CHECKER = "guard-errors-inert";
const INERT_SIGNATURE = "inert";

/**
 * The cap on how many fault GROUPS either report prints.
 *
 * identify() logs once per session, but 10-12 sessions a day over a 7-day
 * window still runs past anything a reader takes in — and in --notify the whole
 * report is injected into a session's context.
 */
const MAX_REPORTED = 20;

/**
 * One log line as a record, or as the report of its own tear.
 *
 * No parseable timestamp means a writer was killed mid-append and its partial
 * line merged with the next; fewer than three fields, that it was cut short
 * with no line after it (#1342). The entries it mangled are unrecoverable, so the
 * tear itself is the report; dropping it would pass over real faults in
 * silence. No timestamp also means no age, so no --days window can apply — both
 * callers keep such a line whatever their cutoff.
 * @param {string} line
 */
function entryFor(line) {
	// Field 4 dropped on purpose — the header says why.
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
 * Identical faults collapsed to one group with a count (mantahostels#147). Every guard on
 * the Bash matcher runs on EVERY Bash call, so a single missing jq writes a line
 * per guard per call. Ungrouped, MAX_REPORTED would show that one fault twenty
 * times and hide every other fault behind it.
 *
 * The key is guard + message, never the timestamp: repetition is the signal that
 * a fault is ongoing rather than historical, and the span is kept for exactly
 * that.
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
		// The log is append-only and read in order, so the newest wins.
		g.last = e.when;
	}
	return groups;
}

/**
 * The capped body of either report.
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
 * The records gl_log wrote with NO REPO ROOT AT ALL (mantahostels#2438), and the only reader
 * of them.
 *
 * lib/guard-log.sh derives its directory from the root, so a guard that resolves
 * none — in practice one whose lib/guard-root.sh is unreadable, that being the
 * tier's own disarm signal, though the record itself proves only that the root
 * was empty — has no project to file under. Those records go to a fixed
 * directory beside the per-project ones, in the first seat's store (#383).
 *
 * REPORTED IN EVERY PROJECT, on every plan, because with no root there is
 * nothing to say which one — or which plan — it was (mantahostels#2514).
 *
 * UNSTAMPED, so it repeats on every run for the whole --days window
 * even after the fault is fixed — nothing else ever clears the file, and that
 * window is the only thing that ends the report.
 *
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
		// Rotated, exactly as the main log is (mantahostels#181): this log is written
		// by the every-Bash-call guards too. Judged on the size read.
		const problem = rotateLog(logPath, whole.length);
		if (problem) {
			ctx.warn("LOG-ROTATION", problem);
			ctx.say(`${problem}\n`);
		}
	}
}

/**
 * One rootless log's bytes, or null where it is absent or — reported as
 * GUARD-ROOT — unreadable.
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} logPath
 */
function readRootlessLog(ctx, logPath) {
	try {
		return fs.readFileSync(logPath);
	} catch (e) {
		const { code } = caught(e);
		if (code === "ENOENT") return null;
		// Fail open AND SAY SO (mantahostels#174): unreadable must not read as absent.
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
 * Every line of `whole` inside the window.
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
 * Each entry carries the byte offset it starts at, because that — not its
 * timestamp — is what --notify reports against. The log is append-only, so an
 * offset orders entries by arrival whatever the clock did. A timestamp cannot:
 * lib/guard-log.sh stamps whole seconds, so two faults in one second are
 * indistinguishable, and WSL2 steps its clock backwards on resume, so a fault can
 * arrive stamped earlier than one already reported. Under a high-water mark on
 * time, both cases suppress the newer fault permanently.
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
 * The entries of `recent` past the last delivered offset, `stamped` being
 * this log's `<offset>\t<digest>` stamp entry.
 * @template {{ start: number }} E
 * @param {E[]} recent
 * @param {Buffer} buf
 * @param {string | undefined} stamped
 */
function unreported(recent, buf, stamped) {
	const [offsetRaw, seenDigest] = (stamped ?? "").split("\t");
	let seen = Number(offsetRaw) || 0;
	// The offset is only meaningful over the same bytes, so it is stamped with a
	// digest of everything it covers. A truncated log can be LONGER than the
	// offset again by the next run — one line replaced by a longer one —
	// so a length check alone would read on into unrelated content and skip real
	// errors. A digest that does not match means start again: at worst one repeat.
	if (seen > buf.length || digestOf(buf.subarray(0, seen)) !== seenDigest)
		seen = 0;
	return recent.filter((e) => e.start >= seen);
}

/**
 * Everything downstream of reading the log: parse, window, group, report.
 *
 * SEPARATE FROM run() SO ROTATION CAN BE STRUCTURAL (mantahostels#206). Rotation must happen
 * on every path that read the file — a log left over from a runaway since fixed
 * holds nothing inside the window, so the check returns early and would re-read
 * those megabytes on every run forever. A `finally` around this call
 * covers any return added later, wherever in here it sits.
 *
 * `whole` is the log's raw bytes, read by the caller because rotation is judged
 * against the size that was read.
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ days: number, logPath: string, whole: Buffer }} args
 */
function reportFailOpens(ctx, { days, logPath, whole }) {
	const cutoff = Date.now() - days * 86_400_000;
	// Read as bytes, because the offsets below are byte offsets and the log carries
	// non-ASCII: sliced as a JS string, one em dash puts every later offset out.
	// Parse and stamp only through the LAST newline: the bytes after it may be a
	// line another writer is appending right now, and stamping over bytes never
	// parsed loses that line for good once it completes — it would sit below the
	// stamp on every later run.
	const buf = whole.subarray(0, whole.lastIndexOf(0x0a) + 1);
	const size = buf.length;
	const recent = recentWithOffsets(buf.toString("utf8"), cutoff);

	/*
	 * Bytes past the last newline are reported, never parsed and never stamped.
	 * Dropping them silently is how a log holding ONE truncated fault reported
	 * "no guard fail-opens" and exited 0: with no newline anywhere, lastIndexOf
	 * returns -1 and the slice above comes back empty.
	 *
	 * A line another writer is appending RIGHT NOW looks identical to one whose
	 * writer died — a full disk truncates mid-record and it never completes. So
	 * this reports both and takes the false alarm: the tail stays below the
	 * stamp, so a line that does complete is reported again, properly parsed.
	 *
	 * The tail is bounded before decoding, not after: a writer that never emitted
	 * a newline can leave one the size of the file, and decoding all of it to
	 * print 160 characters is how a diagnostic becomes the fault. 640 bytes is
	 * the worst case for 160 UTF-8 characters.
	 */
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

	// The stamp this run would report under: every other plan's entry as it stands,
	// plus this run's own — how far into ITS log it read, and a digest of exactly
	// those bytes. Merged rather than replaced, or a write here drops the entries
	// this plan knows nothing about.
	const stored = readSeen(deliveryStamp.readStamp(CHECKER));
	const signature = JSON.stringify({
		...stored,
		[logPath]: `${size}\t${digestOf(buf)}`,
	});
	let report = recent;

	// Null on a hand run, in CI, and under persist mode, where this run is not the
	// delivery — in each case nothing is filtered and the whole window is reported.
	if (deliveryStamp.readSeenStamp(ctx, CHECKER) !== null) {
		report = unreported(recent, buf, stored[logPath]);
		// Nothing further into the log than the last report: an OK outcome, which
		// --notify prints nothing for.
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

	// No severity prefix: check.js owns the one `SEVERITY:` line a run emits.
	ctx.say(
		`${report.length} guard fail-open(s) from ${guards.size} source(s) in the last ${days} days.\n` +
			"Every one of these ALLOWED an action it could not check, so whatever the guard protects was unprotected at the time.\n",
	);
	sayGroups(ctx, groups);
	ctx.say(`\nLog: ${logPath}`);
	// Rotation is the one thing that puts entries somewhere this report does not
	// read, so a reader asking "was a guard ever disarmed" would otherwise have
	// to know the policy to find the older half.
	if (fs.existsSync(`${logPath}.1`))
		ctx.say(`\nOlder entries, rotated aside: ${logPath}.1`);

	// Stamped only AFTER the report is out. Stamping first loses the report entirely
	// if this process dies in between — a kill, a closed terminal — and those
	// errors would then be suppressed for good. A no-op under persist mode,
	// where the reader stamps instead (mantahostels#1975).
	deliveryStamp.markDelivered(ctx, CHECKER, signature);

	return {
		stamp: signature,
		// "distinct", because each finding is now a GROUP: the summary counts
		// faults and the report body counts occurrences, and one broken jq makes
		// those two numbers wildly different.
		noun: `distinct guard fail-open(s) in the last ${days} days`,
		// Both shapes: `groups` is what the report shows, `errors` the raw lines
		// behind it, because a consumer counting occurrences and one counting
		// distinct faults are both legitimate readings.
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

		/* Set where the INERT warning fires this run, so every return path below
		 * can hand it to the reader as `stamps`. */
		/** @type {string | null} */
		let inertStamp = null;

		/*
		 * The one fail-open no hook can record is its own logger going missing:
		 * with scripts/lib/guard-log.sh unreadable every bash hook sourcing it
		 * degrades to a silent allow, writing nothing to the log this check reads,
		 * so an all-clear below would be manufactured by the very fault it is
		 * looking for. Probed here instead (mantahostels#147).
		 *
		 * Deliberately not a wiring check: whether each guard exists and is
		 * triggered from self-plugin/hooks/hooks.json is check-guard-registry.js's job, and
		 * two checks asserting the same thing means one of them rots unnoticed.
		 */
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

		/*
		 * The whole subsystem reads liveness from /proc. Where that is unreadable
		 * every holder scores as dead, no claim is ever refused, and nothing is
		 * logged — so this check would report all-clear forever over a guard doing
		 * nothing at all. Linux/WSL only today, which is why it is an intrinsic WARN
		 * and never gates.
		 *
		 * In --notify it is said ONCE and then stamped: the condition is a property
		 * of the platform, not an event, so repeating it on every --notify run is the
		 * noise --notify exists to avoid.
		 */
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
		 * Merges the INERT stamp into whichever result this run returns, so the
		 * reader gets it under persist mode too, where markDelivered above no-ops.
		 *
		 * WITHHELD WHERE A LIBRARY PROBE ALSO FIRED. The reader suppresses a whole
		 * report once EVERY stamp in its map is already delivered
		 * (replay-notify-reports.js) — sound only where the map covers everything
		 * the report can say. GUARD-LIBRARY never stamps (mantahostels#147: it is a standing
		 * fault, not an event, and "said every run" is the point), so attaching
		 * the INERT stamp while one is also in `ctx.findings` would let an
		 * already-delivered INERT suppress a GUARD-LIBRARY line that changed this
		 * run. RESIDUAL: LOG-ROTATION fires in `run()`'s own `finally`, after this
		 * closure has already run, so a rotation notice landing in the same text
		 * as an already-delivered INERT stamp is not covered by this check.
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
				// Reached with the INERT warning or a library probe already raised, in
				// which case this is the noun the summary counts.
				noun: "reason the guards cannot be evaluated",
			});

		// The read is INSIDE the try, so no gap exists between it and the rotation
		// that a later early return could be placed in.
		let reported = false;
		/** @type {Buffer | undefined} */
		let whole;
		try {
			whole = fs.readFileSync(logPath);
			const out = reportFailOpens(ctx, { days, logPath, whole });
			reported = true;
			return withInertStamp(out);
		} finally {
			// A THROW is the one thing that does not rotate. check.js catches an
			// unexpected throw as the checker being broken, so nothing was reported;
			// renaming the log aside would move entries this run never printed into a
			// .1 the check never reads, and no later run would report them either.
			// `&& whole` is type-only: reported is true only once whole is assigned.
			if (reported && whole) {
				// Said every run, not once: the next reader pays the same cost again.
				const problem = rotateLog(logPath, whole.length);
				if (problem) {
					ctx.warn("LOG-ROTATION", problem);
					ctx.say(`${problem}\n`);
				}
			}
		}
	},
});
