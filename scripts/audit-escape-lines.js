#!/usr/bin/env node
/*
 * audit-escape-lines.js — did the `Checked:`/`Unmeasured:` lines that got a
 * close question past the close-rivals check bear on the fact separating its
 * options? A vendor model judges each, in batch (workflow-core#671 step 3).
 *
 * Usage:  node scripts/audit-escape-lines.js [--root <dir>] [--notify] [--json]
 *         node scripts/audit-escape-lines.js --judge [--root <dir>]
 *           [--transcripts <dir>] [--gap-ms <n>]
 *
 * WHY IT EXISTS. `guard-priced-options.js` reads that an escape line is there,
 * never what it says. workflow-core#671 dropped the first-sight refusal and moved the
 * judging here, after the fact, where it refuses nothing. ITS FIRST JOB IS
 * THE BEFORE/AFTER: the `pre-660` window (workflow-core#488 to workflow-core#660, first-sight lines
 * passed unrefused) is the baseline the workflow-core#671 loosening is kept or reversed
 * on, against the `660` and `671` windows; `1061` refuses every close
 * question once again, so its after-refusal lines are not workflow-core#671's.
 *
 * THE JUDGE is Jev over the Vercel AI Gateway, the route, key and gitleaks
 * sweep `guard-jev-advisory.js` exports — nothing leaves unswept, and only
 * the question block itself is sent. ITS OWN ACCURACY IS UNMEASURED, riding
 * on workflow-core#667. An outage or malformed reply is logged and the item retried on a
 * later run.
 *
 * `--judge` scans every seat's transcripts for this repo (`lib/escape-audit.js`
 * owns what counts), rewrites the items index, then asks about each item with
 * no answer yet: one call every `GAP_MS`, `ATTEMPTS` per item a run, the run
 * capped at `RUN_MS` and held by a lock file so two never overlap.
 *
 * The report (the default, read on `npm run status`) prints, per window and
 * first-sight/after-refusal, how many were judged, the share judged to bear,
 * and how many wait. `--notify`, at session start, prints nothing (workflow-core#2038).
 *
 * IN NO FAMILY (code-standards §N3, §G4): the report is a `check-*` in all
 * but name, through `runCheck`, but `--judge` is a long batch that prints
 * one JSON line and exits 1 on a thrown error, which no family's contract
 * covers.
 *
 * IMPLICIT:  at every session start, at most once in six hours, starts a detached batch that reads every seat's transcripts for this repo and sends each close question block that passed on an escape line, gitleaks-swept, to the Vercel AI Gateway.
 * JUSTIFIED: fail-safe — it refuses nothing, a missing key, SDK or gitleaks sends nothing, and a store that will not read reports that rather than zeros; workflow-core#671 made the loosening reversible on this evidence.
 * DEFEAT:    `WFC_ESCAPE_AUDIT=0` for a session stops the batch starting.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const { parseOrExit } = require("./lib/cli-args");
const audit = require("./lib/escape-audit");
const hookBlock = require("./lib/hook-block");
const { markersDir } = require("./lib/marker-root.js");
const { oneCopyEach, projectDirs } = require("./lib/project-dirs");
const { scriptPath } = require("./lib/script-path.js");

const CHECKER = "escape-audit";
const ENV_SWITCH = "WFC_ESCAPE_AUDIT";

/* A run's wall-time ceiling, the gap between calls, and the tries per item
 * per run: a failed item waits for the next run rather than hammering a
 * gateway that is down. All four figures here are chosen, not measured (workflow-core#671). */
const RUN_MS = 10 * 60_000;
const GAP_MS = 2000;
const ATTEMPTS = 2;
/* Jev's own `ABORT_MS` is 3 s for a hook with a 15 s budget; a batch has
 * none, so it waits longer before calling a reply lost. */
const ABORT_MS = 20_000;
/* Four starts a day at most, against a store that grows by a handful of
 * rounds a day: often enough that a verdict lands the day its round does. */
const KICK_MS = 6 * 60 * 60_000;
/* A boolean question's own midpoint; no threshold study stands behind it. */
const BEARS_AT = 0.5;
/* A lock older than a run can last belongs to a process that died. */
const LOCK_STALE_MS = RUN_MS + 5 * 60_000;

const LOCK_NAME = ".escape-audit-lock";
const KICK_NAME = ".escape-audit-kicked";

const QUESTION_KEY = "bears_on_separator";
const QUESTIONS = {
	[QUESTION_KEY]: {
		type: "boolean",
		instructions:
			"This is a question an assistant put to a project founder, offering lettered options priced as rivals, the top two close enough that the recommendation could flip. It carries a `Checked:` line (what the assistant ran to separate the options, and what it showed) or an `Unmeasured:` line (the fact that would separate them, and why no cheap check reaches it). Does that line bear on the fact that actually separates the two highest-priced options — would what it reports or names tell you which of those two is right?",
		criteria: {
			true: "the line reports a check, or names a fact, that would change which of the top two options is right",
			false:
				"the line reports a check or names a fact that does not separate the top two options, restates the options, gives a generic reason, or reports only a search of past rulings or of what the code or a tool does today, which separates options only where they are otherwise equal (workflow-core#1457)",
		},
	},
};

/**
 * Every top-level transcript under `dirs`, one copy of each.
 * @param {string[]} dirs
 * @returns {string[]}
 */
function readTranscripts(dirs) {
	/** @type {string[]} */
	const files = [];
	for (const dir of dirs) {
		try {
			for (const f of fs.readdirSync(dir))
				if (f.endsWith(".jsonl")) files.push(path.join(dir, f));
		} catch {
			/* a seat with no sessions here (workflow-core#671) */
		}
	}
	return oneCopyEach(files);
}

/**
 * Take the lock, or return false where a live run holds it.
 * @param {string} file
 */
function lock(file) {
	for (let tries = 0; tries < 2; tries++) {
		try {
			fs.writeFileSync(file, String(process.pid), { flag: "wx" });
			return true;
		} catch {
			let age = 0;
			try {
				age = Date.now() - fs.statSync(file).mtimeMs;
			} catch {
				/* the holder released it between the two calls (workflow-core#671) */
				continue;
			}
			if (age < LOCK_STALE_MS) return false;
			fs.rmSync(file, { force: true });
		}
	}
	return false;
}

/**
 * Ask the judge about one block: `bears`/`misses`, or throw.
 * @param {string} key
 * @param {string} text
 * @param {any} gw `guard-jev-advisory.js`'s `gateway` export
 * @returns {Promise<{outcome: "bears" | "misses", probability: number}>}
 */
async function ask(key, text, gw) {
	const { probability: p } = await gw.askJev({
		key,
		message: text,
		questions: QUESTIONS,
		questionKey: QUESTION_KEY,
		abortMs: ABORT_MS,
	});
	return {
		outcome: p >= BEARS_AT ? "bears" : "misses",
		probability: Number(p.toFixed(2)),
	};
}

/**
 * Every item in the transcripts, first copy of each key kept, and how many
 * transcripts would not read.
 * @param {string[]} dirs
 * @param {Parameters<typeof audit.itemsIn>[2]} deps
 * @returns {{unique: import("./lib/escape-audit").Item[], unreadable: number}}
 */
function scanItems(dirs, deps) {
	/** @type {import("./lib/escape-audit").Item[]} */
	const items = [];
	let unreadable = 0;
	for (const file of readTranscripts(dirs)) {
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			/* counted into the index, which the report prints (workflow-core#671) */
			unreadable++;
			continue;
		}
		items.push(...audit.itemsIn(text, path.basename(file, ".jsonl"), deps));
	}
	const seen = new Set();
	const unique = items.filter((i) => !seen.has(i.key) && seen.add(i.key));
	return { unique, unreadable };
}

/**
 * @typedef {object} JudgeRun
 * @property {string} root
 * @property {string} key the gateway key
 * @property {typeof import("./guard-jev-advisory").gateway} gw
 * @property {number} gapMs
 * @property {{asked: number, answered: number, failed: number}} counts across the whole run
 */

/**
 * Judge one item and log its verdict: gitleaks' refusal where it has one,
 * else the judge's answer or why there is none.
 * @param {JudgeRun} run accumulator: counts.answered or counts.failed is bumped; the rest is read
 * @param {import("./lib/escape-audit").Item} item
 */
async function judgeItem(run, item) {
	const swept = run.gw.sweepRefusal({ message: item.text });
	if (swept) {
		audit.appendVerdict(run.root, {
			key: item.key,
			at: new Date().toISOString(),
			outcome: swept,
		});
		return;
	}
	const { outcome, probability } = await askWithRetries(run, item.text);
	if (outcome === "bears" || outcome === "misses") run.counts.answered++;
	else run.counts.failed++;
	audit.appendVerdict(run.root, {
		key: item.key,
		at: new Date().toISOString(),
		outcome,
		...(probability === undefined ? {} : { probability }),
	});
}

/**
 * Up to `ATTEMPTS` asks, every one after the run's first waiting `gapMs`.
 * @param {JudgeRun} run accumulator: counts.asked is bumped per ask; the rest is read
 * @param {string} text
 * @returns {Promise<{outcome: import("./lib/escape-audit").Verdict["outcome"], probability: number | undefined}>}
 */
async function askWithRetries(run, text) {
	/** @type {import("./lib/escape-audit").Verdict["outcome"]} */
	let outcome = "outage";
	let probability;
	for (let a = 0; a < ATTEMPTS; a++) {
		if (run.counts.asked) await new Promise((r) => setTimeout(r, run.gapMs));
		run.counts.asked++;
		try {
			({ outcome, probability } = await ask(run.key, text, run.gw));
			break;
		} catch (e) {
			outcome = run.gw.isMalformedReply(e) ? "malformed" : "outage";
		}
	}
	return { outcome, probability };
}

/**
 * The batch: scan, index, judge what is unanswered.
 * @param {{root: string, dirs: string[], gapMs?: number}} spec
 * @returns {Promise<{items: number, unreadable?: number, asked: number, answered: number, failed: number, reason?: string}>}
 */
async function judge({ root, dirs, gapMs = GAP_MS }) {
	const lockFile = path.join(markersDir(root), LOCK_NAME);
	if (!lock(lockFile))
		return { items: 0, asked: 0, answered: 0, failed: 0, reason: "locked" };
	const started = Date.now();
	try {
		const deps = {
			rivalPair: require("./lib/close-rivals").rivalPair,
			splitQuestions: require("./lib/round-marker").splitQuestions,
		};
		const { unique, unreadable } = scanItems(dirs, deps);
		audit.writeItems(root, unique, unreadable);

		const { gateway: gw } = require("./guard-jev-advisory");
		const key = gw.readKey(root);
		if (!key || gw.sdkMissing())
			return {
				items: unique.length,
				unreadable,
				asked: 0,
				answered: 0,
				failed: 0,
				reason: key ? "sdk" : "key",
			};
		const verdicts = audit.readVerdicts(root);
		/** @type {JudgeRun} */
		const run = {
			root,
			key,
			gw,
			gapMs,
			counts: { asked: 0, answered: 0, failed: 0 },
		};
		for (const item of unique) {
			if (audit.ANSWERED.has(verdicts.get(item.key)?.outcome ?? "")) continue;
			if (Date.now() - started > RUN_MS) break;
			await judgeItem(run, item);
		}
		const { asked, answered, failed } = run.counts;
		return { items: unique.length, unreadable, asked, answered, failed };
	} finally {
		fs.rmSync(lockFile, { force: true });
	}
}

/**
 * Start a detached `--judge` where one is due, failing open.
 * @param {string} root
 */
function kick(root) {
	if (["0", "false", "off"].includes(process.env[ENV_SWITCH] ?? "")) return;
	const marker = path.join(markersDir(root), KICK_NAME);
	try {
		if (Date.now() - fs.statSync(marker).mtimeMs < KICK_MS) return;
	} catch {
		/* never kicked (workflow-core#671) */
	}
	try {
		fs.writeFileSync(marker, new Date().toISOString());
		spawn(process.execPath, [__filename, "--judge", "--root", root], {
			cwd: root,
			detached: true,
			stdio: "ignore",
		}).unref();
	} catch {
		/* the next session start tries again (workflow-core#671) */
	}
}

/**
 * The standing's counts, one row per window and sight, for `sayRows` to print.
 * @param {Omit<import("./lib/escape-audit").Item, "text">[]} items
 * @param {Map<string, import("./lib/escape-audit").Verdict>} verdicts
 */
function tally(items, verdicts) {
	/** @type {Map<string, {judged: number, bears: number, pending: number, withheld: number}>} */
	const rows = new Map();
	for (const window of audit.WINDOWS)
		for (const sight of ["first", "after-refusal"])
			rows.set(`${window} ${sight}`, {
				judged: 0,
				bears: 0,
				pending: 0,
				withheld: 0,
			});
	for (const item of items) {
		const row = rows.get(`${item.window} ${item.sight}`);
		if (!row) continue;
		const v = verdicts.get(item.key)?.outcome;
		if (v === "bears" || v === "misses") {
			row.judged++;
			if (v === "bears") row.bears++;
		} else if (v === "finding") row.withheld++;
		else row.pending++;
	}
	return rows;
}

const USAGE =
	"node audit-escape-lines.js [--root <dir>] [--notify] [--json] | --judge [--root <dir>] [--transcripts <dir>] [--gap-ms <n>]";

/**
 * `--judge` runs the batch; anything else is the report.
 * @returns {Promise<void>}
 */
async function main() {
	const argv = process.argv.slice(2);
	if (!argv.includes("--judge")) return report();
	/* Shorthand, since check.declared-flags.test.ts reads `flags:` followed by
	 * anything but an array as a runCheck declaration. */
	/** @type {Record<string, import("./lib/cli-args").FlagType>} */
	const flags = {
		"--judge": "boolean",
		"--root": "value",
		"--transcripts": "value",
		"--gap-ms": "value",
	};
	const given = parseOrExit(argv, { usage: USAGE, flags }).flags;
	const dir = given["--transcripts"];
	const root = given["--root"];
	const gapMs = given["--gap-ms"];
	const result = await judge({
		root: typeof root === "string" ? root : hookBlock.repoRoot(),
		dirs: typeof dir === "string" ? [dir] : projectDirs(),
		gapMs: typeof gapMs === "string" ? Number(gapMs) : GAP_MS,
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

/**
 * One line per window and sight that holds anything.
 * @param {import("./lib/check").CheckContext} ctx
 * @param {ReturnType<typeof tally>} rows
 */
function sayRows(ctx, rows) {
	for (const [name, r] of rows) {
		if (!r.judged && !r.pending && !r.withheld) continue;
		const share = r.judged ? `${Math.round((100 * r.bears) / r.judged)}%` : "—";
		ctx.say(
			`  ${name.padEnd(22)} ${String(r.judged).padStart(3)} judged, ${share.padStart(4)} bore; ${r.pending} pending${r.withheld ? `, ${r.withheld} withheld by gitleaks` : ""}`,
		);
	}
}

/**
 * The report's run: at session start only the batch kick, since no session
 * acts on the standing (workflow-core#2038); by hand, read the stores and print it.
 * @param {import("./lib/check").CheckContext} ctx
 * @returns {import("./lib/check").CheckResult | void}
 */
function reportRun(ctx) {
	const root = ctx.value("--root", hookBlock.repoRoot());
	if (ctx.notify) {
		kick(root);
		return {
			okLine: `the standing is on node ${scriptPath("status-report.js")}.`,
		};
	}
	let index;
	let verdicts;
	try {
		index = audit.readItems(root);
		verdicts = audit.readVerdicts(root);
	} catch (e) {
		return ctx.skip(
			`the escape-line audit's stores would not read: ${errMessage(e)}`,
		);
	}
	if (!index) return { okLine: "the escape-line audit has not run here yet." };

	const rows = tally(index.items, verdicts);
	ctx.say(
		"ESCAPE-AUDIT — close questions let past on a Checked:/Unmeasured: line, judged by Jev on whether the line bore on the fact separating the top two options (workflow-core#671):\n",
	);
	sayRows(ctx, rows);
	ctx.say(
		"\n  pre-660 is the baseline: first-sight lines not yet refused (workflow-core#660).\n" +
			"  660 refused every close question once; 671 refused only a missing or\n" +
			"  unchanged line; 1061 refuses every close question once again.\n" +
			"  The judge's own accuracy is unmeasured (workflow-core#667).\n" +
			(index.unreadable
				? `  ${index.unreadable} transcript(s) would not read, so these counts are short.\n`
				: "") +
			`\n  Verdicts: ${audit.verdictsPath(root)}\n`,
	);
	return {
		okLine: `${verdicts.size} escape-line verdict(s) on ${index.items.length} item(s), indexed ${index.at}.`,
		data: { indexedAt: index.at, rows: Object.fromEntries(rows) },
	};
}

function report() {
	runCheck({
		name: CHECKER,
		usage: USAGE,
		valueFlags: ["--root"],
		run: reportRun,
	});
}

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		process.stderr.write(`audit-escape-lines: ${errMessage(e)}\n`);
		process.exitCode = 1;
	});
