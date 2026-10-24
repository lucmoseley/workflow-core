#!/usr/bin/env node
/*
 * verify-persist-replay.js — does the persist-and-replay pipeline actually
 * deliver, when every persisting producer is launched the way a session
 * start launches them? (mantahostels#1977, the verification mantahostels#1949 specifies.)
 *
 * Usage:
 *   node scripts/verify-persist-replay.js [--json] [--timeout <s>]
 *                                         [--only <key>[,<key>...]] [--no-control]
 *
 * IT RUNS THE REAL COMMANDS, NOT A FIXTURE. A session cannot start another
 * under the wiring in force and watch its SessionStart, so it is not exercised
 * by starting a session. This runs the producers' exact
 * command lines with the exact environment that block sets, concurrently, and
 * reads back what landed on disk. The unit-level guarantees are already
 * covered at their own seams (mantahostels#1973, mantahostels#1974, mantahostels#1975, mantahostels#1976); what is unproven
 * until here is the whole pipeline under real contention.
 *
 * WHAT IT CANNOT DO (mantahostels#2574, the cost of lib/persist-replay.js's THE SET IS DERIVED): a
 * producer not yet registered in the repo's hooks cannot be exercised
 * ahead of that paste, because the table this harness runs is read off the
 * same file. A table that can name a producer the hooks disagree with is
 * also a table that can silently stop naming one it agrees with, which is the
 * defect mantahostels#2574 fixes. Test a new producer's
 * command by hand (`node scripts/<it>.js --notify`) before pasting the block;
 * this harness answers only for what is already wired.
 *
 * WHY THERE ARE TWO PHASES. Phase A is the persist stampede: every producer at
 * once with WFC_NOTIFY_PERSIST=1, which must leave stdout empty and a
 * well-formed report file behind. That proves the report is well-formed, not
 * that it says what the checker would have said — a producer that persisted an
 * empty document at every run would pass phase A. Phase B re-runs the same
 * commands under plain `--notify`, where stdout IS the report, and compares.
 *
 * THE COMPARISON IS ON NORMALISED TEXT, and it has to be: every one of these
 * reports carries a clock — an age, an ISO timestamp, a duration, a sha — that
 * differs between two runs seconds apart while the finding is the same. `mask`
 * replaces those and nothing wider, so a genuine difference in what the
 * checker found still shows as a difference.
 *
 * PHASE B PARKS THE DELIVERY STAMPS AND PUTS THEM BACK. A producer's stamp
 * files are `stampFile(key)`, any hand-listed `stampKeys`, AND every name
 * phase A's own persisted report says it wrote under `stamps` (mantahostels#2277,
 * widened at mantahostels#2574 so a producer stamping under a dynamically-named set
 * needs no hand-kept list at all: PHASE A ALREADY KNOWS THE NAMES, because `stamps` rides the return
 * even though writing the actual stamp file is a no-op under persist mode).
 * A plain `--notify` run IS a delivery (lib/delivery-stamp.js): left alone,
 * phase B would both read the founder's stamps — suppressing the very text
 * this compares, so the harness would verify less each time it ran — and
 * write new ones, silencing the next real session start about a standing
 * finding it had never shown anyone. So the stamp files are moved aside for
 * phase B and restored after. THE RESIDUAL: a harness killed between the two
 * leaves them cleared, which costs one repeated report and never a swallowed
 * one; and a real session start landing inside that window delivers against no
 * stamp, for the same price.
 *
 * A DIFFERENCE IS REPORTED, NOT FAILED, in two cases. A producer whose subject
 * moves under it — the reaper takes sessions in phase A that are gone by phase
 * B, and ci-status reads a live Actions API — is marked `volatile`. A producer
 * with a defect already ticketed is marked `knownGap` and reported by number.
 * Both print their diffs for a reader to judge rather than counting a fault.
 *
 * MOST PRODUCERS ARE VOLATILE, which is the honest residual: only
 * hook-liveness, check-cleared-trackers and ghost-jobs are compared strictly —
 * `PRODUCER_META`'s `volatile` entries name the rest — so a pipeline defect
 * that corrupted one of those would print as a diff for a reader and never as
 * a fault.
 *
 * NOT A `runCheck` MEMBER, deliberately: it is a hand-run harness, not a
 * wired checker, and it exits 1 on a fault like the `measure-*` family rather
 * than carrying mantahostels#155's five-outcome alphabet.
 *
 * IT IS NOT READ-ONLY, and two of its effects are worth knowing before you run
 * it. The producers write their reports and run records into the live
 * notify-reports directory, exactly as a session start's would — that is the
 * mechanism working, not a side effect to undo. And the reaper is invoked as
 * the self-plugin's hooks file invokes it, without `--dry-run`, so each phase STOPS
 * whichever neighbouring sessions it judges finished: two reaps per run, the
 * same act a session start performs.
 *
 * IT ALSO READS THE REPO'S HOOKS and says whether the producers wired
 * there as persisting match this table — via the same
 * `lib/session-start-roster.js` join both this table and
 * `replay-notify-reports.js`'s own roster are built from (mantahostels#2574), so the two
 * cannot name different producers.
 */

const { execFile } = require("node:child_process");
const path = require("node:path");

const notify = require("./lib/notify-report.js");
const { delivered } = require("./lib/delivery-stamp.js");
const {
	persistingProducers,
	judge,
	parkStamps,
} = require("./lib/persist-replay.js");
const {
	sessionStartRoster,
	KEY_OVERRIDES,
} = require("./lib/session-start-roster.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");

/* Every producer here is read off the host repo's hooks and
 * run with `CLAUDE_PROJECT_DIR` set to match (#1) — a plugin install's own
 * files sit outside the tree a real session start would exercise. */
const REPO = hostRoot();

/** @typedef {import("./lib/persist-replay.js").Producer} Producer */
/** @typedef {import("./lib/persist-replay.js").RunOutcome} RunOutcome */

const PRODUCERS = persistingProducers(REPO);

/**
 * Run one command to completion, or to `timeoutMs`. Never rejects: a producer
 * that fails is a finding of this harness, not a crash of it.
 * @param {string[]} argv
 * @param {{ env: NodeJS.ProcessEnv, timeoutMs: number }} opts
 */
function run(argv, { env, timeoutMs }) {
	const started = Date.now();
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			argv,
			/* 32 MB, against a largest observed report of 15 kB (ci-status, listing
			 * 169 commits since the last green run): three orders of headroom, so
			 * a checker having a very bad day is read rather than truncated. */
			{ cwd: REPO, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
			(err, stdout, stderr) => {
				/** @type {number | null} */
				let code = 0;
				if (err && typeof err.code === "number") code = err.code;
				else if (err) code = null;
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code,
					/* `killed` is not on the Error type node declares for execFile's
					 * callback, though the runtime always sets it on a timeout. */
					killed: Boolean(err && /** @type {any} */ (err).killed),
					ms: Date.now() - started,
				});
			},
		);
	});
}

/**
 * Launch every producer at the same instant, as a session start does.
 * @param {Producer[]} producers
 * @param {{ persist: boolean, timeoutMs: number }} opts
 * @returns {Promise<Record<string, RunOutcome>>}
 */
function stampede(producers, { persist, timeoutMs }) {
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, CLAUDE_PROJECT_DIR: REPO };
	if (persist) env.WFC_NOTIFY_PERSIST = "1";
	else delete env.WFC_NOTIFY_PERSIST;
	return Promise.all(
		producers.map(async (p) => [
			p.key,
			await run([path.join(__dirname, p.script), "--notify"], {
				env,
				timeoutMs,
			}),
		]),
	).then((pairs) => Object.fromEntries(pairs));
}

/**
 * The producers the repo's hooks actually wire as persisting, read
 * fresh rather than off `PRODUCERS` (built once, at module load) — so a
 * hooks edit mid-run still shows up rather than being masked by the table
 * it would otherwise be compared against. In practice this can only ever
 * equal `PRODUCERS`'s own keys, `PRODUCERS` being built from the same read
 * (mantahostels#2574) — the residual is the module-load-vs-runtime race this second read
 * exists to catch.
 * @returns {string[]}
 */
function wiredRoster() {
	return sessionStartRoster(REPO, { keyOverrides: KEY_OVERRIDES })
		.map((p) => p.key)
		.sort();
}

/**
 * One line on whether the hooks wire any producer, and whether it agrees
 * with this table.
 * @param {Producer[]} producers
 */
function wiredLine(producers) {
	const wired = wiredRoster();
	if (wired.length === 0)
		return "The repo's hooks wire no persisting producer — main() has already refused to run over an empty PRODUCERS by the time this prints.";
	const expected = producers.map((p) => p.key).sort();
	const missing = expected.filter((k) => !wired.includes(k));
	const extra = wired.filter((k) => !expected.includes(k));
	if (missing.length === 0 && extra.length === 0)
		return `The repo's hooks wire the same ${wired.length} producer(s) this table holds — membership only, never their timeouts.`;
	return `The hooks' persist set has drifted from this table — wired but untested: ${extra.join(", ") || "none"}; tested but unwired: ${missing.join(", ") || "none"}.`;
}

const USAGE =
	"usage: node scripts/verify-persist-replay.js [--json] [--timeout <s>] [--only <key>[,<key>...]] [--no-control]";

/** @param {string[]} argv */
function parseArgs(argv) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: {
			"--json": "boolean",
			"--no-control": "boolean",
			"--timeout": "value",
			"--only": "value",
		},
	});
	const only = flags["--only"];
	return {
		json: flags["--json"] === true,
		control: flags["--no-control"] !== true,
		/* 180 s: five times the 34.3 s worst case mantahostels#1921 measured under the full
		 * 20-hook stampede, so this ceiling only ever fires on a hang. */
		timeoutMs: Number(flags["--timeout"] ?? 180) * 1000,
		only: typeof only === "string" ? new Set(only.split(",")) : null,
	};
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const producers = selectProducers(opts.only);
	if (!producers) {
		process.exitCode = 2;
		return;
	}

	const from = Date.now();
	const persistRuns = await stampede(producers, {
		persist: true,
		timeoutMs: opts.timeoutMs,
	});
	const to = Date.now();

	/* Read before the control phase: a plain `--notify` run writes no report,
	 * but reading first means a later failure cannot be confused for one. */
	const { reports, open } = readReports(producers);

	/** @type {Record<string, RunOutcome>} */
	const controlRuns = opts.control
		? await controlPhase(producers, reports, opts.timeoutMs)
		: {};

	const rows = producers.map((p) =>
		judgeProducer(p, {
			persistRuns,
			controlRuns,
			reports,
			open,
			window: { from, to },
		}),
	);
	const faulted = rows.filter((r) => r.faults.length);

	if (opts.json) {
		console.log(
			JSON.stringify(
				{ base: notify.base(), wired: wiredRoster(), rows },
				null,
				2,
			),
		);
	} else printTable(producers, rows, faulted, opts.control);
	/* Set rather than called: `process.exit` truncates a `--json` document
	 * mid-write when stdout is a pipe. */
	process.exitCode = faulted.length > 0 ? 1 : 0;
}

/**
 * The producers `--only` names, or every one; null, having said why on
 * stderr, where that selection is unusable.
 * @param {Set<string> | null} only
 */
function selectProducers(only) {
	const producers = only ? PRODUCERS.filter((p) => only.has(p.key)) : PRODUCERS;
	/* An unknown key would otherwise select nothing and print the success line
	 * over an empty table — a green verdict having verified nothing. */
	if (only && producers.length !== only.size) {
		const known = PRODUCERS.map((p) => p.key);
		const unknown = [...only].filter((k) => !known.includes(k));
		console.error(
			`no such producer: ${unknown.join(", ")}. Known: ${known.join(", ")}`,
		);
		return null;
	}
	/* PRODUCERS itself is now derived from the live wiring (mantahostels#2574), so an empty
	 * hook wiring already trips persistingProducers' PRODUCER_META check —
	 * this is defence in depth for the day PRODUCER_META is itself empty too.
	 * Without it, running the rest of `main` over zero producers would print
	 * the OK line having verified nothing, the same failure `--only` is
	 * guarded against above. */
	if (producers.length === 0) {
		console.error(
			"self-plugin/hooks/hooks.json wires no persisting producer — nothing to verify.",
		);
		return null;
	}
	return producers;
}

/** @param {typeof PRODUCERS} producers */
function readReports(producers) {
	/** @type {Record<string, import("./lib/notify-report.js").Report|null>} */
	const reports = {};
	/** @type {Record<string, boolean>} */
	const open = {};
	for (const p of producers) {
		reports[p.key] = notify.readReport(p.key);
		open[p.key] = notify.readRun(p.key) !== null;
	}
	return { reports, open };
}

/**
 * The live (non-persisting) stampede, run with the persisted stamps parked.
 * @param {typeof PRODUCERS} producers
 * @param {Record<string, import("./lib/notify-report.js").Report|null>} reports
 * @param {number} timeoutMs
 */
async function controlPhase(producers, reports, timeoutMs) {
	const restore = parkStamps(producers, reports);
	try {
		return await stampede(producers, { persist: false, timeoutMs });
	} finally {
		restore();
	}
}

/**
 * @param {(typeof PRODUCERS)[number]} p
 * @param {{
 *   persistRuns: Record<string, RunOutcome>,
 *   controlRuns: Record<string, RunOutcome>,
 *   reports: Record<string, import("./lib/notify-report.js").Report|null>,
 *   open: Record<string, boolean>,
 *   window: { from: number, to: number },
 * }} phases
 */
function judgeProducer(p, { persistRuns, controlRuns, reports, open, window }) {
	const persistRun = persistRuns[p.key];
	const report = reports[p.key];
	const runOpen = open[p.key];
	if (persistRun === undefined || report === undefined || runOpen === undefined)
		throw new Error(`${p.key} was launched and read, yet has no entry`);
	const stamp = report?.stamp;
	return judge(p, {
		persistRun,
		controlRun: controlRuns[p.key] ?? null,
		report,
		runOpen,
		window,
		stampSeen: Boolean(stamp && delivered(p.key, stamp)),
	});
}

/**
 * The human-readable table, diffs, faults and verdict line.
 * @param {typeof PRODUCERS} producers
 * @param {ReturnType<typeof judge>[]} rows
 * @param {ReturnType<typeof judge>[]} faulted
 * @param {boolean} control
 */
function printTable(producers, rows, faulted, control) {
	console.log(
		`persist-and-replay verification — ${producers.length} producer(s)`,
	);
	console.log(`reports under ${notify.base()}`);
	console.log(`${wiredLine(producers)}\n`);
	console.log(
		"  key                       outcome  bytes  persist  control  match",
	);
	for (const r of rows)
		console.log(
			`  ${r.key.padEnd(24)}  ${String(r.outcome ?? "-").padEnd(7)}  ${String(r.bytes).padStart(5)}  ${`${r.persistMs}ms`.padStart(7)}  ${`${r.controlMs ?? "-"}ms`.padStart(7)}  ${r.match}`,
		);
	for (const r of rows) {
		if (r.diff)
			console.log(
				`\n▸ ${r.key} differs between the two phases:\n--- persisted\n${r.diff.persisted}\n--- live\n${r.diff.control}`,
			);
	}
	for (const r of faulted)
		for (const f of r.faults) console.log(`\nFAULT ${r.key}: ${f}`);
	console.log(verdictLine(faulted.length, control));
}

/** @param {number} faultedCount @param {boolean} control */
function verdictLine(faultedCount, control) {
	if (faultedCount > 0)
		return `\nFAIL: ${faultedCount} producer(s) with faults.`;
	if (control)
		return "\nOK: every producer persisted a well-formed report reflecting its live finding.";
	return "\nOK: every producer persisted a well-formed report — its CONTENT is unchecked, --no-control having skipped the comparison.";
}

if (require.main === module) {
	main().catch((e) => {
		console.error(e?.message ?? String(e));
		process.exit(2);
	});
}
