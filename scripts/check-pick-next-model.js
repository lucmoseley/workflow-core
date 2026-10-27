#!/usr/bin/env node
/*
 * check-pick-next-model.js — report the `/pick-next` sessions that ran on a
 * non-Sonnet model, and what that forfeited.
 *
 * Usage:  npm run check:pick-next-model  [--days <n>] [--notify] [--json]
 *
 * WHAT IT IS FOR (mantahostels#2449, on mantahostels#1334's finding and mantahostels#1353's fix). `/pick-next` is a
 * Sonnet row: `scripts/launch.sh pick-next` routes it correctly and nothing
 * about the launcher is wrong. The founder launches it by hand from Claude
 * Code's agents view instead, which carries no `--model` flag and inherits
 * `~/.claude2/settings.json`'s Opus default — so 120 of 121 post-fix sessions
 * still ran on Opus.
 *
 * THE DOLLAR FIGURE IS THIS RUN'S, NOT A CONSTANT TO CHECK AGAINST. It moves
 * with the corpus, and it is NOT the scan's ~$603/week-equivalent: that figure
 * folded each session's `subagents/agent-*.jsonl` in, where this reads main-
 * chain records only (below). Reconcile a surprising figure by re-deriving it,
 * never by comparing it to a number written in a comment.
 *
 * AFTER THE FACT, BECAUSE NOTHING CAN BE BEFORE IT. mantahostels#1353 already ruled this
 * residual unfixable by hook: no PreToolUse guard sees the agents view.
 *
 * WHO READS THE WARN, AND WHY IT IS WORDED AS A RELAY (mantahostels#2475). Under --notify
 * this is a SessionStart hook, so its stdout lands in an AGENT's context, never
 * the founder's terminal — an imperative addressed to him reaches nobody, and
 * the session it does reach cannot relaunch itself. mantahostels#1353 leaves no mechanism
 * that could route it to him directly, so the agent relaying it is the only
 * carrier there is, and the --notify branch asks for exactly that.
 *
 * WARN, NEVER FAIL, and silent at zero. The miss is the founder's to act on by
 * changing how he launches; a gate here would refuse commits over a habit.
 *
 * A SEVEN-DAY WINDOW, NOT THIRTY (mantahostels#2449). The figure this exists to keep in
 * front of the founder is a WEEK-EQUIVALENT, so a seven-day window reports that
 * number directly rather than extrapolating one out of a longer reading.
 * `--days <n>` moves it on a hand run.
 *
 * HOW A SESSION'S COMMAND IS READ, AND WHY IT IS A HEAD READ. The command is the
 * first `<command-name>` block in the transcript. Reading every transcript in
 * the window whole on every run is not affordable, so a file is filtered on
 * mtime first and then only its first megabyte is read: a file capped without a
 * command block is counted and reported as unclassified rather than assumed
 * innocent.
 *
 * MIXED COUNTS AS A MISS, and is reported as its own number: a session with any
 * Opus turn in it spent Opus rates for that turn, so folding it into "clean"
 * would let a session that switched mid-run read as a success.
 *
 * A TIER THIS CANNOT PRICE IS `unknown`, NEVER A MISS (mantahostels#2476) — tierOf()'s
 * docstring carries why, and it is close to theoretical today.
 *
 * NOT ON SessionStart TODAY. No .claude/settings.json on any plan names this
 * file, and the one live route is `npm run status` (scripts/status-report.js),
 * which runs it WITHOUT --notify. So every --notify branch below — the
 * throttle, the SKIP line, the relay line — is correct and dormant, awaiting
 * the re-wiring mantahostels#2574 holds.
 *
 * THE WARN IS THROTTLED ON THE SET OF MISSES (mantahostels#2476), via lib/delivery-stamp.js
 * and by identity, not on a clock and not on a high-water mark: see the call
 * site for the two misses a high-water mark silenced for good. Under --notify
 * only, so it is dormant on the route above.
 *
 * THE DOLLAR FIGURE IS A FLOOR, TWICE OVER. It is a weighting of four token
 * classes at each request's own model's API list ratios, never a bill (mantahostels#829).
 * And it reads MAIN-CHAIN records
 * only: a second directory walk over each session's `subagents/agent-*.jsonl`
 * is not affordable on every run.
 *
 * AN UNREADABLE TRANSCRIPT DIRECTORY IS A SKIP, NOT "0 MISSES" — the corpus
 * lives under CLAUDE_CONFIG_DIR, outside the repo, SUBJECT on lib/check.js's
 * subject-vs-apparatus split. A TOTAL failure says so under --notify,
 * where lib/check.js would otherwise print a SKIP as silence (mantahostels#2476).
 *
 * LOCAL ONLY. A CI runner has no transcript corpus and reports SKIP.
 *
 * IMPLICIT:  nothing today — off SessionStart (above), so the only route asks for it. Once re-wired: injects the count of `/pick-next` sessions in the last 7 days that ran on a non-Sonnet model, and the cost-equivalent that forfeited. It reads transcripts and changes nothing.
 * JUSTIFIED: fail-safe — the launch happens outside the Bash tool, so no guard can refuse it and nothing else reports the debt; a run that cannot read the corpus reports nothing rather than calling the rate zero.
 * DEFEAT:    none at the hook; --days <n> moves the window on a hand run.
 */

const fs = require("node:fs");
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

/** This checker's name, which is also the key its delivery stamp is held under. */
const CHECKER = "pick-next-model";

/** The command whose launch model this checker is about. */
const COMMAND = "pick-next";

/** Default window. See the header for why it is seven days and not thirty. */
const DEFAULT_DAYS = 7;

/*
 * $ per Mtok, Opus 5 API list ratios. COPIED VERBATIM from
 * scripts/measure-burn/scan_burn.py's WEIGHTS dict rather than
 * re-derived, so the two readings of this corpus agree on the price of a
 * token. `cw1h` is the 1-hour cache write, 2x fresh input (workflow-core#1203).
 * RESIDUAL: nothing checks the copy; a change to either dict owes the other.
 */
const WEIGHTS = { fi: 15.0, out: 75.0, cw: 18.75, cw1h: 30.0, cr: 1.5 };
/* In `pricedTokens`' order, `cw` being the 5-minute write. */
const PRICED = /** @type {const} */ (["fi", "out", "cw", "cw1h", "cr"]);

/*
 * Each model's price per token class as a fraction of WEIGHTS (docs/effort-guide.md
 * §Model ids and prices). Opus 5.5 is 0.8 of Opus 5 on every class but a cache
 * read, where it is 0.4 (workflow-core#359). Sonnet is 0.4 on every class
 * (mantahostels#1088) and prices the counterfactual; the forfeit is each Opus
 * request's own cost less that.
 */
const OPUS_5_5 = { fi: 0.8, out: 0.8, cw: 0.8, cw1h: 0.8, cr: 0.4 };
const SONNET = { fi: 0.4, out: 0.4, cw: 0.4, cw1h: 0.4, cr: 0.4 };
const OPUS_5 = { fi: 1, out: 1, cw: 1, cw1h: 1, cr: 1 };

/*
 * How far into a transcript the first `<command-name>` block is looked for.
 * 1 MiB, measured at workflow-core#362: it left 7 files capped without a command where
 * 256 kB left 58.
 */
const HEAD_BYTES = 1024 * 1024;

/*
 * The ceiling on a whole-transcript read, for the handful of files that turn out
 * to be `/pick-next` sessions. The largest transcript on this machine is 12 MB
 * (mantahostels#1731); this is a bound on a pathological one, not on any file seen.
 */
const WHOLE_FILE_LIMIT = 64 * 1024 * 1024;

/*
 * CLOSING TAG REQUIRED, as all three existing extractors in this repo require it
 * (scripts/lib/encoding-use.js:44, measure-session-ceilings/measure.py,
 * measure-effort-arms/scan_medium_frame.py) — an unclosed `<command-name>`
 * mentioned in prose or in a tool_result body is not a command this session ran.
 * The leading slash and the surrounding whitespace stay optional, which
 * encoding-use.js does not allow: this reads a raw byte range rather than a
 * parsed user record, so it must take the tag however it is spelled.
 *
 * RESIDUAL: a CLOSED tag anywhere in the first megabyte still matches, including
 * one inside a tool_result — a session that reads this file, or the checker's
 * own test, is booked as a /pick-next session. Closing that needs record-scoped
 * extraction, which costs the head read this checker's affordability rests on.
 */
const COMMAND_RE =
	/<command-name>\s*\/?\s*([a-zA-Z0-9_:-]+)\s*<\/command-name>/;

/**
 * The cost-equivalent of one request's token classes at a model's rates.
 *
 * @param {Record<string, number>} u  a `mergeRequest` entry's usage
 * @param {Record<(typeof PRICED)[number], number>} rate
 * @returns {number}
 */
const usd = (u, rate) => {
	const [fi, out, cw, cw1h, cr] = pricedTokens(u);
	const tokens = { fi, out, cw, cw1h, cr };
	return PRICED.reduce((s, k) => s + tokens[k] * WEIGHTS[k] * rate[k], 0) / 1e6;
};

/**
 * A request's own rates. Only reached for a session tierOf() priced, so the
 * model is Opus or Sonnet.
 * Residual: an Opus cheaper than Opus 5 other than 5.5 — a future one — is
 * priced at Opus 5 and breaks the floor until it gets its own row here.
 *
 * @param {string | null | undefined} model
 */
function rateOf(model) {
	const l = (model || "").toLowerCase();
	if (l.includes("sonnet")) return SONNET;
	if (/opus-5-5(?!\d)/.test(l)) return OPUS_5_5;
	return OPUS_5;
}

/**
 * The first `HEAD_BYTES` of a file, and whether the read hit that cap.
 *
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
 * @param {any} record
 * @returns {number | null}
 */
function timestampOf(record) {
	if (typeof record.timestamp !== "string") return null;
	const t = Date.parse(record.timestamp);
	return Number.isNaN(t) ? null : t;
}

/**
 * Add one assistant record's model to `models` and its usage to `requests`.
 *
 * @param {any} record
 * @param {{ models: Set<string>, requests: Map<string, import("./lib/session-spend").RequestUsage> }} into accumulator: models and requests are both filled
 */
function tallyAssistant(record, { models, requests }) {
	const message = record.message || {};
	const usage = message.usage;
	if (!usage) return;
	const flat = flatUsage(usage);

	/* A record that bought nothing casts no vote on the launch model. The
	 * harness writes an API error back as a real, non-sidechain assistant
	 * record whose `message.model` is the literal `<synthetic>` and whose four
	 * token classes are all zero. tierOf() reads a string it recognises as
	 * neither tier as `unknown` (mantahostels#2476), so one of these in an
	 * otherwise Sonnet session would book the whole session `unknown` —
	 * dropping it out of the Sonnet count rather than into a miss. Excluding
	 * them here leaves the billing below untouched — a zero record adds
	 * nothing to a MAX. */
	const billed = hasUsage(flat);
	const model =
		billed && typeof message.model === "string" && message.model
			? message.model
			: null;
	if (model) models.add(model);

	/* `requestId` and `message.id` are 1:1 (scan_burn.py's own --audit fact 1),
	 * so either is the same key. A record carrying neither becomes its own unit
	 * off its uuid, which over-counts rather than silently merging two requests
	 * — the same call scan_burn.py makes, and the safer direction for a figure
	 * this reports as a floor. */
	const id = record.requestId || message.id || record.uuid;
	if (!id) return;
	mergeRequest(requests, id, flat).model ??= model;
}

/**
 * The models a session's own turns ran on, and one billable unit per requestId
 * with each token field MAXed across that request's records — scan_burn.py's
 * rule, restated over `mainChainRecords` rather than over a second JSONL parser.
 *
 * Keyed on requestId within ONE file, so the cross-file collision scan_burn.py's
 * `(path, requestId)` key exists to avoid cannot arise.
 *
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
 * Which model tier a session ran on.
 *
 * `mixed` is its own answer rather than being folded into either: a session with
 * any Opus turn spent Opus rates for it, and one that cannot be read at all is
 * not a session that ran on Sonnet.
 *
 * A model string that is NEITHER is `unknown` — not `opus` (mantahostels#2476). WEIGHTS
 * below prices Opus and nothing else, so booking a Haiku or Fable session as
 * Opus would inflate the dollar figure this file's header calls a floor, in the
 * one direction it promises never to go. `unknown` already means "counted
 * neither way": the session stays in the rate's denominator, its cost is left
 * out of the forfeit, and the report says how many there were. It takes the
 * whole session, an otherwise-Opus one included.
 *
 * @param {Set<string>} models
 * @returns {"sonnet" | "opus" | "mixed" | "unknown"}
 */
function tierOf(models) {
	let opus = false;
	let sonnet = false;
	let other = false;
	for (const m of models) {
		const l = m.toLowerCase();
		if (l.includes("sonnet")) sonnet = true;
		else if (l.includes("opus")) opus = true;
		else other = true;
	}
	if (other) return "unknown";
	if (opus && sonnet) return "mixed";
	if (opus) return "opus";
	if (sonnet) return "sonnet";
	return "unknown";
}

/**
 * A /pick-next session whose model could not be read, so nothing was priced.
 *
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
 * Every `.jsonl` under the projects directories, and which directories were
 * absent or refused.
 *
 * @param {string[]} dirs
 */
function listTranscripts(dirs) {
	/** Directories that EXIST and refused to be read. */
	/** @type {string[]} */
	const unreadable = [];
	/* Directories that are simply not there. `projectDirs()` keeps a config
	 * dir that does not exist (arbiter-core.js's sessionDirs, same call), so
	 * on any machine without `~/.claude2` and `~/.claude3` those are ABSENT —
	 * not refused. Counting those as unreadable would WARN on every run,
	 * permanently. They still count towards the SKIP below, which is what
	 * keeps a CI runner (no corpus at all) off "0 misses". */
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
 * The transcripts last written inside the window, and how many would not
 * answer a stat.
 *
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
			/* Gone between the readdir and the stat — a session's transcript
			 * rotated or removed under the scan. Inert: the file no longer
			 * exists, so it is not a session this window could read either way.
			 * Anything else is a file that IS there and would not answer, which
			 * is exactly what `unclassified` reports. */
			if (caught(e).code !== "ENOENT") unclassified++;
			continue;
		}
		/* mtime, not the session's own start: a transcript last written before
		 * the window opened cannot have started inside it, and this is what
		 * keeps the scan off ~57% of the corpus. The parsed start timestamp
		 * below is what actually decides membership. */
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
	/* Every projects directory refused or is absent. The corpus is outside
	 * the repo, so this is SUBJECT — SKIP, never "no misses" (lib/check.js's
	 * split), and it is also how a CI
	 * runner with no corpus at all reports SKIP rather than a clean sweep. */
	if (unreadable.length + absent.length !== dirs.length) return;
	const why = `no transcript directory could be read (${[...unreadable, ...absent.map((d) => `${d} (absent)`)].join("; ")}), so the /pick-next launch model is unknown — not clean.`;
	/* SAID BEFORE THE THROW, AND ONLY UNDER --notify (mantahostels#2476). lib/check.js
	 * suppresses a SKIP's summary line under --notify exactly as it does an
	 * OK's, so a total corpus failure reached a session start as silence —
	 * byte-identical to a clean window, which is the one thing the
	 * subject-vs-apparatus split exists to keep apart. Here rather than
	 * after, because ctx.skip() throws and nothing below it runs; and
	 * notify-only, because the plain route already prints the summary and a
	 * second copy of it would be the only change there.
	 *
	 * TWO ROUTES THIS IS A SECOND COPY ON ANYWAY, both --notify's own.
	 * Persist mode is --notify plus WFC_NOTIFY_PERSIST=1, so the line is
	 * captured into the persisted text and this becomes the first SKIP to
	 * persist a NON-EMPTY one — lib/check.js's persistReport comment says
	 * an OK or SKIP persists empty, and that is now not quite true — an
	 * accepted residual.
	 * Under --json-text --notify the same words ride
	 * in both `text` and `summary`. */
	if (ctx.notify) ctx.say(`PICK-NEXT-MODEL SKIPPED — ${why}`);
	ctx.skip(why);
}

/**
 * A /pick-next session read whole and priced — or null where it started
 * before the window.
 *
 * @param {string} file
 * @param {number} cutoff
 */
function priceSession(file, cutoff) {
	/* PAST HERE THE COMMAND HAS BEEN READ, so a failure below is not an
	 * unclassified file: this IS a /pick-next session, and only its MODEL is
	 * unknown. It goes in `sessions` as `unknown` — the bucket that already
	 * means "counted neither way" — rather than into `unclassified`, whose
	 * line says the command name would not yield, which would be untrue of
	 * it, and which would leave it out of the rate's denominator too. Cost 0
	 * because nothing was priced, which understates rather than inflates. */
	let text;
	try {
		const size = fs.statSync(file).size;
		if (size > WHOLE_FILE_LIMIT) return unpriced(file);
		text = fs.readFileSync(file, "utf8");
	} catch {
		return unpriced(file);
	}
	const { models, requests, startedAt } = scanSession(text);
	/* A session whose first record carries no readable timestamp is kept: its
	 * mtime already put it inside the window, and dropping it would silently
	 * shrink the miss count. */
	if (startedAt !== null && startedAt < cutoff) return null;
	let cost = 0;
	let forfeit = 0;
	for (const { usage, model } of requests.values()) {
		const own = usd(usage, rateOf(model));
		cost += own;
		forfeit += own - usd(usage, SONNET);
	}
	return { file, tier: tierOf(models), cost, forfeit, startedAt };
}

/**
 * Read one transcript's command: "unclassified" where it would not yield one,
 * null where it is not /pick-next or fell outside the window, else the session.
 *
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
		/* Capped without a command is a file this scan could not classify.
		 * Shorter than the cap is a session that carries no command block at
		 * all — an ordinary interactive session, and not a miss. */
		return h.capped ? "unclassified" : null;
	}
	if (m[1] !== COMMAND) return null;
	return priceSession(file, cutoff);
}

/**
 * Every /pick-next session in the window, and how many files would not yield
 * a command name.
 *
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
		return `${total - unknown} of ${total} /pick-next session(s) in the last ${days}d ran on Sonnet; ${unknown} carried a model this cannot read or cannot price.`;
	return `every one of ${total} /pick-next session(s) in the last ${days}d ran on Sonnet.`;
}

/**
 * Print the miss report's lines after its headline.
 *
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
		"  Only the founder can act on this: scripts/launch.sh pick-next routes it, the agents view does not.",
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
		/** Files that would not answer a stat, plus files in the window that would not yield a command name. */
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
			sonnet: by("sonnet").length,
			unknownModel: unknownModel.length,
			unclassifiedFiles: unclassified,
			unreadableDirs: unreadable,
			absentDirs: absent,
			spent,
			forfeited,
		};

		/* Said whichever way the run goes, and in both modes: a directory that
		 * refused is scope this reading never looked at, and a count computed over
		 * the rest is not a clean sweep of the whole. */
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

		/* THROTTLED ON THE SET OF MISSES (mantahostels#2476). Unthrottled, this WARN repeated
		 * at every delivery with the miss rate at ~100% and no way to acknowledge
		 * it, and a nudge the reader has learnt to skip reports nothing. The
		 * signature is the sorted set of missed transcript names, compared by
		 * IDENTITY — check-ghost-jobs.js's shape. lib/delivery-stamp.js owns the
		 * store and the --notify-only gating, so a hand run, npm run status,
		 * pre-commit and CI always answer in full.
		 *
		 * A HIGH-WATER MARK ON THE NEWEST MISS WAS WRONG, and this replaces it.
		 * Two misses it would have silenced for good: a session that turns up as a
		 * miss AFTER a newer one is stamped, which is precisely what `mixed`
		 * exists for — it switched to Opus late, so its START is older than the
		 * mark — and a new miss whose first record carries no readable timestamp,
		 * which moves a maximum not at all.
		 *
		 * THE PRICE IS ONE EXTRA NOTICE: a miss ageing out of the window changes
		 * the set too, so the report returns once when nothing new has gone wrong. */
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
			`${missed.length} of ${sessions.length} /pick-next session(s) in the last ${days}d ran on a non-Sonnet model (${rate}%), forfeiting ${money(forfeited)} of ${money(spent)} spent`,
			data,
		);

		ctx.say(
			`PICK-NEXT-ON-OPUS (${missed.length} of ${sessions.length}) — /pick-next sessions in the last ${days}d ran on a non-Sonnet model, ${rate}% of them. ` +
				`They spent ${money(spent)}; ${money(forfeited)} of that was forfeited (each request against Sonnet's price for it, mantahostels#1088).`,
		);
		sayMissDetail(ctx, {
			mixed: mixed.length,
			unknownModel: unknownModel.length,
			unclassified,
		});

		/* Stamped only after the report is out, so a process killed in between
		 * repeats the notice rather than swallowing it. A no-op under persist mode,
		 * where the replay reader stamps once it has actually shown the report —
		 * hence `stamp` in the result too. */
		deliveryStamp.markDelivered(ctx, CHECKER, signature);

		return {
			okLine: `every one of ${sessions.length} /pick-next session(s) in the last ${days}d ran on Sonnet.`,
			noun: "/pick-next session(s) launched off Sonnet",
			count: missed.length,
			stamp: signature,
			data,
		};
	},
});
