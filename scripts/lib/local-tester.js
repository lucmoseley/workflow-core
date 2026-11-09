/*
 * local-tester.js — the landing queue's local tester (#2403, spec #2261): the
 * lander's tester on a private adopter and on the core's trial. It runs the
 * suite at a sha in a detached worktree the lander owns, never the shared
 * tree, so no session's unsaved edit is ever tested (mantahostels#908's
 * reason).
 *
 * Each group of runs holds one suite slot from a fresh checkout and install to
 * its last command; a sharded whole run takes one slot per shard. A slot still shut at
 * the queue's wait bound is a transient no verdict, which asking again later
 * can turn to one: the tester never runs unadmitted.
 *
 * Any step that fails before the suite reports — the checkout, the slot, the
 * install, a command that will not start, is killed, or fails naming no
 * failing file — is no verdict, never green or red.
 *
 * commandTester is the tester queue-lander.js's `--tester <command>` swaps in.
 */

const { execFileSync, spawn } = require("node:child_process");
const { gitBinary, gitSpawnOptions } = require("./git.js");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readPsRows, readTreePssKb } = require("./admission.js");
const { readAvailableMb } = require("./meminfo.js");
const { caught } = require("./caught.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { requiredGroup } = require("./regex-group.js");
const { writeFd } = require("./write-fd.js");
const { CEILING_LINE } = require("./suite-ceiling.js");
const { rungMb } = require("./suite-ladder.js");
const {
	gateDenies,
	readLiveRoleMarkers,
	queueSeat,
} = require("./suite-queue.js");
const { LANDER_WORKTREE } = require("./lander-worktree.js");
const { readConfig } = require("./workflow-core-config.js");
const { latestTimings } = require("./latest-timings.js");

/**
 * The lander's environment less every variable a root lookup answers before
 * cwd, so the install and suite run as CI does: the tree under test rooted by
 * its own directory, the host root by the main checkout owning it. A CLAUDE_PROJECT_DIR left in sent the suite to the main checkout;
 * a WFC_REPO_ROOT, the suite's test-injection point, outranked every
 * fixture's root (#2410); a CLAUDE_PLUGIN_ROOT from the hook that started the
 * lander sent init-adopter to the main checkout's self-plugin/ (#2476).
 */
const rootlessEnv = () => {
	const env = { ...process.env };
	delete env.CLAUDE_PROJECT_DIR;
	delete env.CLAUDE_PLUGIN_ROOT;
	delete env.WFC_REPO_ROOT;
	delete env.WFC_DISPATCH_ROOT;
	return env;
};

/** @typedef {import("./queue-lander.js").Verdict} Verdict */
/** @typedef {import("./queue-lander.js").QueueTester} QueueTester */

/* What admission holds back for a lander, by the kind of run it holds
 * (#3323), and what the queues' climb charges its marker (#3973): its
 * tester's own tree peak, never a machine-wide MemAvailable dip (#2508). Off
 * the lander run record, each run's tree PSS sampled every 2 s from its
 * spawn, 28 Oct - 5 Nov 2026, with no margin, the rung holding
 * DRAW_MARGIN_MB. Whole: the highest of 48 runs, 2,627 MB, from the 4 Nov
 * tree suite-queue.js `PEAK_MB` reads as an outlier; #4771 re-derives it.
 * Named: the highest of 341 runs of 1-6 files, 937 MB. A named run past
 * those 6 files is unmeasured and charged whole. Residual: a spike between
 * two samples is charged short. */
const CHARGE_MB = { whole: 2630, named: 940 };
const NAMED_MEASURED_FILES = 6;
/* The queue marker's role, which session admission reads (#2416). */
const LANDER_ROLE = "lander";
/* Untraced: room for `npm ci` over a slow link. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/* Untraced: room for a checkout of the whole tree. */
const CHECKOUT_TIMEOUT_MS = 120 * 1000;
/* Untraced: how often a run's tree PSS is sampled for its peak. */
const PEAK_SAMPLE_MS = 2000;
/* Each tester run's kind, file count and tree peak, under the canonical
 * checkout's markers (#3323). Untraced: 90 days, room for many runs to
 * re-size the charges from. */
const RUN_RECORD = ".lander-runs.jsonl";
const RUN_RECORD_RETAIN_MS = 90 * DAY_MS;
/* The largest processes at each memory-shut slot, under the same markers and
 * for as long (#3764). Untraced: ten of them and 120 characters of each
 * command. */
const HOLDER_RECORD = ".lander-memory-holders.jsonl";
const HOLDERS_KEPT = 10;
const HOLDER_COMMAND_CHARS = 120;
/* Where the install's lockfile hash is kept: inside what it installed, so a
 * deleted `node_modules` takes its stamp with it. */
const STAMP = path.join("node_modules", ".lander-lock-hash");
const LOCKFILE = "package-lock.json";
const VITEST_FAIL = /^\s*FAIL\s+(\S+)/;
const PYTEST_FAIL = /^(?:FAILED|ERROR)\s+([^\s:]+)/;
/* A name ends on a non-space, or is one space where nothing else is left;
 * `(.+?)\s*$` would retry the trailing match from every character (#4109). */
const VITEST_TEST =
	/^\s*FAIL\s+(\S+)\s+(?:>\s+)?(\S(?:.*\S)?|[^\S\n\r\u2028\u2029](?=[\n\r\u2028\u2029]*$))\s*$/;
const PYTEST_TEST =
	/^(?:FAILED|ERROR)\s+([^\s:]+)::(.(?:.*?\S)??)(?:\s+-\s+(\S(?:.*\S)?|(?=$)))?\s*$/;
const VITEST_END = /^[✓×❯⎯↓]/;
const DIFF_LINE = /^[-+]\s/;
const DIFF_HEADER = /^(?:- Expected|\+ Received)\b/;
/* Untraced: room for an assertion's first lines, kept short for the heartbeat
 * and the tickets that carry it. */
const MESSAGE_CHARS = 300;
/* Untraced: 64 bits, as a signature only compares one test's few failures. */
const SIGNATURE_HEX = 16;

/**
 * @typedef {{ok: true, spawned: () => void, release: () => void}
 *   | {ok: false, reason: string, memoryShut?: boolean}} Admission
 *   `memoryShut` where the memory limb still denied at the ceiling
 * @typedef {{code: number|null, signal: string|null, out: string,
 *   error: string|null, peakKb: number, samples: number}} RunResult
 *   `peakKb` the run's tree-PSS peak over `samples` reads
 * @typedef {{command: string, args: string[], label?: string,
 *   env?: Record<string, string>}} Run `label` names the run in a reason
 *   where `command` alone would not, as a shard's; `env` adds to its
 *   environment
 * @typedef {(bin: string, args: string[], cwd: string,
 *   opts?: {timeout?: number, maxBuffer?: number}) => void} Exec
 *   git or npm, throwing on failure
 * @typedef {object} LocalTesterOptions
 * @property {string} root the canonical checkout, whose object store the
 *   worktree shares
 * @property {(slot: {chargeMb: number}) => Promise<Admission>} [admit] one
 *   suite slot, charged as the run it holds
 * @property {Exec} [exec]
 * @property {string} [pytest] the Python suite's runner
 * @property {(pid: number) => number} [treePss] the tree PSS under `pid`, kB
 * @property {(dir: string) => string|null} [timings] the per-file timings
 *   file every shard of one whole run at `dir` packs by, null for none
 */

/**
 * A run's output as lines, its ANSI colour stripped.
 * @param {string} out
 * @returns {string[]}
 */
const parsePlainLines = (out) =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
	out.replace(/\u001b\[[0-9;]*m/g, "").split("\n");

/**
 * The failing test files a vitest or pytest run names, in the order first
 * named: vitest's `FAIL  <file> > <test>` lines and pytest's
 * `FAILED <file>::<test>` and `ERROR <file>` ones.
 * @param {string} out
 * @returns {string[]}
 */
function parseFailingFiles(out) {
	/** @type {Set<string>} */
	const files = new Set();
	for (const line of parsePlainLines(out))
		for (const re of [VITEST_FAIL, PYTEST_FAIL]) {
			const m = line.match(re);
			if (m) {
				files.add(requiredGroup(m, 1, re));
				break;
			}
		}
	return [...files];
}

/**
 * What tells one failure from another, read off its whole error before any cut
 * for display. Less what differs between two runs of one failure: an absolute
 * path's directories, as the tip's run is CI's and a bisect's local; shas, from
 * 7 hex digits, git's shortest default abbreviation; and numbers, as a line
 * number moves with any edit above it. Residual (#3937): one file's two
 * offenders on different lines read as one failure, a message otherwise moved
 * by a commit reads as a new failure there, naming that commit in place of the
 * one that broke the test, one differing run to run holds on the culprit's
 * second run, and a list of offenders compares whole, so a merged side red on
 * only some of the tip's reads as not red and the merge is reverted.
 * @param {string} text
 */
const buildSignature = (text) =>
	crypto
		.createHash("sha256")
		.update(
			text
				.replace(/(?<![\w.])(?:\/[^\s/:'"`]+)+\//g, "")
				.replace(/\b[0-9a-f]{7,40}\b/g, "#")
				.replace(/\d+/g, "#"),
		)
		.digest("hex")
		.slice(0, SIGNATURE_HEX);

/**
 * The failing tests a vitest or pytest run names, each with its error: on
 * pytest's `FAILED <file>::<test> - <message>` line, or after vitest's
 * `FAIL  <file> > <test>` lines, one error printing under every test it failed.
 * Vitest's error is its first line and its diff's `+` and `-` lines, as a
 * `toEqual([])` on a list of offenders prints one first line for any offender.
 * @param {string} out
 * @returns {import("./queue-lander.js").Failure[]}
 */
function parseFailingTests(out) {
	/** @type {Map<string, import("./queue-lander.js").Failure>} */
	const tests = new Map();
	/** @param {RegExpMatchArray} m @param {RegExp} re */
	const named = (m, re) => {
		const file = requiredGroup(m, 1, re);
		const test = requiredGroup(m, 2, re);
		const key = `${file}\0${test}`;
		const failure = tests.get(key) ?? { file, test };
		tests.set(key, failure);
		return failure;
	};
	/** @type {OpenError} */
	const open = { unread: [], lines: [] };
	for (const line of parsePlainLines(out)) {
		const v = line.match(VITEST_TEST);
		const p = line.match(PYTEST_TEST);
		if (v) {
			if (open.lines.length > 0) closeError(open);
			open.unread.push(named(v, VITEST_TEST));
		} else if (p) {
			closeError(open);
			if (p[3]) withError(named(p, PYTEST_TEST), p[3]);
			else named(p, PYTEST_TEST);
		} else readErrorLine(open, line);
	}
	closeError(open);
	return [...tests.values()];
}

/**
 * @typedef {{unread: import("./queue-lander.js").Failure[], lines: string[]}}
 *   OpenError the tests awaiting an error, and that error's lines so far
 */

/** @param {OpenError} open accumulator: emptied, its tests given its error */
function closeError(open) {
	if (open.lines.length > 0)
		for (const failure of open.unread)
			withError(failure, open.lines.join(" / "));
	open.unread = [];
	open.lines = [];
}

/**
 * @param {OpenError} open accumulator
 * @param {string} line
 */
function readErrorLine(open, line) {
	const text = line.trim();
	if (text === "" || open.unread.length === 0) return;
	/* A bare `ERROR <file>` line names a file, and is no test's error. */
	if (VITEST_END.test(text) || PYTEST_FAIL.test(line)) closeError(open);
	else if (
		open.lines.length === 0 ||
		(DIFF_LINE.test(text) && !DIFF_HEADER.test(text))
	)
		open.lines.push(text);
}

/**
 * @param {import("./queue-lander.js").Failure} failure accumulator
 * @param {string} text
 */
function withError(failure, text) {
	failure.message = text.slice(0, MESSAGE_CHARS);
	failure.signature = buildSignature(text);
}

/**
 * A run's ceiling-kill line, where the suite ceiling killed it (#2696): no
 * verdict, with no culprit to bisect for, and the ceiling named.
 * @param {string} out
 * @returns {string|null}
 */
function parseCeilingKillReason(out) {
	const line = parsePlainLines(out).find((l) => l.startsWith(CEILING_LINE));
	return line === undefined ? null : `killed: ${line}`;
}

/**
 * One suite slot: a place in the suite queue, the suite gate open, and
 * MemAvailable at `rungMb(chargeMb)` (docs/environment.md §6, #2416), all
 * three at once. Memory that cannot be read holds the slot shut. An open slot
 * is stamped admitted, so no other waiter launches beside it before its suite
 * spawns (#2650). At the ceiling it
 * refuses on either limb: the lander then exits with no verdict, leaving the
 * batch for its next run (#2542).
 * @param {{chargeMb: number, pollMs?: number, timeoutMs?: number,
 *   gate?: (climbMb: number) => import("./suite-queue.js").GateDenial | null,
 *   memory?: () => import("./meminfo.js").MbResult, queueDir?: string}}
 *   options `gate` answers which limb of the suite gate denies a suite, if
 *   any; the poll and ceiling default to the suite queue's
 * @returns {Promise<Admission>}
 */
async function suiteSlot({
	chargeMb,
	pollMs,
	timeoutMs,
	gate = (climbMb) => gateDenies([], undefined, null, climbMb),
	memory = readAvailableMb,
	queueDir,
}) {
	const seat = queueSeat({
		queue: { queueDir },
		join: { role: LANDER_ROLE, chargeMb },
	});
	const rung = rungMb(chargeMb);
	let mem = memory();
	let memoryShut = false;
	const outcome = await seat.wait({
		pollMs,
		timeoutMs,
		gate: (climbMb) => {
			mem = memory();
			memoryShut = !mem.ok || mem.mb - climbMb < rung;
			if (memoryShut)
				return {
					limb: "memory",
					...(mem.ok ? { mb: mem.mb } : {}),
					rungMb: rung,
					...(climbMb > 0 ? { climbMb } : {}),
				};
			return gate(climbMb);
		},
		label: "lander",
	});
	if (outcome !== "refused")
		return { ok: true, spawned: seat.spawned, release: seat.leave };
	const memoryRead = mem.ok
		? `${mem.mb} MB available against ${rung} MB`
		: `memory unread: ${mem.error}`;
	return {
		ok: false,
		reason: `no suite slot by the ceiling (${memoryRead})`,
		memoryShut,
	};
}

/**
 * The landers holding or waiting for a suite slot, each with the charge its
 * marker carries, for session admission to hold back (#2416, #3323). A marker
 * whose charge is not a number is held the larger.
 * @param {{queueDir?: string}} [options]
 * @returns {import("./admission.js").Landers}
 */
function readLiveLanders({ queueDir } = {}) {
	return readLiveRoleMarkers(LANDER_ROLE, { queueDir }).map((r) => ({
		pid: r.pid,
		chargeMb: Number.isFinite(r.chargeMb)
			? Number(r.chargeMb)
			: CHARGE_MB.whole,
	}));
}

/**
 * `command "$@"` under `sh` in `cwd`, its stdout and stderr passed through to
 * stderr and kept, its tree PSS sampled for the peak.
 * @param {Run} run
 * @param {string} cwd
 * @param {() => void} onSpawn
 * @param {(pid: number) => number} treePss
 * @returns {Promise<RunResult>}
 */
const shellRun = ({ command, args, env }, cwd, onSpawn, treePss) =>
	new Promise((resolve) => {
		const child = spawn("sh", ["-c", `${command} "$@"`, "tester", ...args], {
			cwd,
			env: { ...rootlessEnv(), ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		/** @param {Buffer} chunk */
		const keep = (chunk) => {
			out += chunk;
			process.stderr.write(chunk);
		};
		let peakKb = 0;
		let samples = 0;
		/** @type {NodeJS.Timeout | undefined} */
		let sampler;
		const sample = () => {
			if (child.pid === undefined) return;
			peakKb = Math.max(peakKb, treePss(child.pid));
			samples += 1;
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		child.on("spawn", () => {
			sample();
			sampler = setInterval(sample, PEAK_SAMPLE_MS);
			onSpawn();
		});
		child.on("error", (err) => {
			clearInterval(sampler);
			resolve({
				code: null,
				signal: null,
				out,
				error: err.message,
				peakKb,
				samples,
			});
		});
		child.on("close", (code, signal) => {
			clearInterval(sampler);
			resolve({ code, signal, out, error: null, peakKb, samples });
		});
	});

/** @type {Exec} */
const execOrThrow = (bin, args, cwd, opts) => {
	execFileSync(bin, args, {
		timeout: CHECKOUT_TIMEOUT_MS,
		...opts,
		cwd,
		env: rootlessEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
};

/**
 * Why an exec failed, its stderr's last line where it left one.
 * @param {unknown} err
 */
function whyFailed(err) {
	const e = caught(err);
	const last = (e.stderr ?? "").trim().split("\n").pop();
	return last || e.message;
}

/**
 * The lander's worktree checked out clean at `sha`, made first where it is
 * missing. Ignored files, the install among them, are kept.
 * @param {string} root
 * @param {string} dir
 * @param {string} sha
 * @param {Exec} exec
 */
function checkOut(root, dir, sha, exec) {
	if (!fs.existsSync(path.join(dir, ".git"))) {
		fs.rmSync(dir, { recursive: true, force: true });
		exec(gitBinary(), ["worktree", "prune"], root, gitSpawnOptions());
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		exec(
			gitBinary(),
			["worktree", "add", "--detach", dir, sha],
			root,
			gitSpawnOptions(),
		);
		return;
	}
	exec(
		gitBinary(),
		["checkout", "--quiet", "--detach", "--force", sha],
		dir,
		gitSpawnOptions(),
	);
	exec(gitBinary(), ["clean", "-ffdq"], dir, gitSpawnOptions());
}

/**
 * `npm ci` where the lockfile's hash differs from the one the last install
 * stamped; nothing where the tree has no lockfile.
 * @param {string} dir
 * @param {Exec} exec
 */
function install(dir, exec) {
	const lock = path.join(dir, LOCKFILE);
	if (!fs.existsSync(lock)) return;
	const hash = crypto
		.createHash("sha256")
		.update(fs.readFileSync(lock))
		.digest("hex");
	const stamp = path.join(dir, STAMP);
	try {
		if (fs.readFileSync(stamp, "utf8").trim() === hash) return;
	} catch {
		/* no stamp: never installed, or the install was removed */
	}
	exec("npm", ["ci", "--no-audit", "--no-fund"], dir, {
		timeout: INSTALL_TIMEOUT_MS,
	});
	fs.writeFileSync(stamp, `${hash}\n`);
}

/**
 * The runs that retest `files` alone: the Python ones on the runner where
 * Python is routed, the rest on `test`.
 * @param {string[]} files
 * @param {string|null} test
 * @param {Run|false} python the runner's run, false where unrouted
 * @returns {Run[] | string}
 */
function rerunsOf(files, test, python) {
	const py = python ? files.filter((f) => f.endsWith(".py")) : [];
	const rest = files.filter((f) => !py.includes(f));
	if (rest.length > 0 && !test) return "no test command is declared";
	return [
		...(test && rest.length > 0 ? [{ command: test, args: rest }] : []),
		...(python && py.length > 0
			? [{ ...python, args: [...python.args, ...py] }]
			: []),
	];
}

/**
 * The commands a run takes at `dir`, one group per suite slot: the declared
 * `full_test`, else `test`, and the Python runner where the config routes a
 * Python test path; with `files`, `rerunsOf`'s runs of those `dir` holds,
 * and no group where it holds none. A declared
 * `fullTestShards` splits the whole run into that many `--shard=k/n` groups,
 * each under its own suite ceiling, the Python runner joining the last
 * (#2996), all packing by the one file `timings` names through
 * `WFC_SHARD_TIMINGS` (#4579). Where neither `full_test` nor `test` is declared, the Python runner
 * alone, and where that is unrouted too, no group: a repo declaring no suite
 * has nothing to fail, so its sha is green, which the commit gate keeps true
 * by refusing a test file while no test command is declared (#2412). Read
 * from the worktree's own config, the one the sha carries.
 * @param {string} dir
 * @param {string} pytest
 * @param {string[]} files
 * @param {(dir: string) => string|null} timings
 * @returns {Run[][] | string} the groups, or why none can be had
 */
function readRunsAt(dir, pytest, files, timings) {
	let config;
	try {
		config = readConfig({ root: dir, quiet: true });
	} catch (err) {
		return `the config at the sha will not read: ${caught(err).message}`;
	}
	const { test, full_test } = config.commands;
	const routesPython = Object.values(config.pythonRoutes ?? {}).includes(
		"test",
	);
	/* An argument, not shell text, so a plugin path with a space reaches node
	 * whole. */
	/** @type {Run} */
	const python = {
		command: "node",
		args: [pytest],
		label: `node ${path.basename(pytest)}`,
	};
	if (files.length > 0) {
		/* A file the tree lacks has no test to fail here: the base check of a
		 * test file new in the tip (#4347). actions-tester.js's namedVerdict
		 * holds the same rule. Residual: a path misnamed by the red that asked reads
		 * green here, never no verdict. */
		const present = files.filter((f) => fs.existsSync(path.join(dir, f)));
		if (present.length === 0) return [];
		const runs = rerunsOf(present, test, routesPython && python);
		return typeof runs === "string" ? runs : [runs];
	}
	/* A bare run in this clean worktree selects no touched test (#3508). */
	/** @type {Run} */
	const wholePython = {
		...python,
		args: [pytest, "--full"],
		label: `${python.label} --full`,
	};
	const whole = full_test ?? test;
	if (!whole) return routesPython ? [[wholePython]] : [];
	const shards = config.fullTestShards ?? 1;
	const packedBy = shards > 1 ? timings(dir) : null;
	const env = packedBy === null ? {} : { env: { WFC_SHARD_TIMINGS: packedBy } };
	return Array.from({ length: shards }, (_, i) => {
		const shard = `--shard=${i + 1}/${shards}`;
		return [
			shards > 1
				? { command: whole, args: [shard], label: `${whole} ${shard}`, ...env }
				: { command: whole, args: [] },
			...(routesPython && i === shards - 1 ? [wholePython] : []),
		];
	});
}

/**
 * @typedef {{root: string, dir: string, sha: string, exec: Exec}} Checkout
 *   the lander's tree `dir` of the main checkout `root`, to be at `sha`
 */

/**
 * @typedef {object} SlotRuns
 * @property {() => Promise<Admission>} admit one suite slot
 * @property {(pid: number) => number} treePss
 * @property {{ran: number, peakKb: number, samples: number}} tally
 *   accumulator: the runs spawned, their highest tree peak and the reads it
 *   was taken over
 */

/**
 * @param {Checkout} checkout
 * @returns {string|null} why the checkout failed, or null
 */
function checkOutOrWhy({ root, dir, sha, exec }) {
	try {
		checkOut(root, dir, sha, exec);
		return null;
	} catch (err) {
		return `checkout failed: ${whyFailed(err)}`;
	}
}

/**
 * The tree checked out again, rebuilt where it went during the slot wait
 * (#4421), and installed.
 * @param {Checkout} checkout
 * @returns {string|null} why it could not be readied, or null
 */
function checkOutAndInstall(checkout) {
	const why = checkOutOrWhy(checkout);
	if (why !== null) return why;
	try {
		install(checkout.dir, checkout.exec);
		return null;
	} catch (err) {
		return `install failed: ${whyFailed(err)}`;
	}
}

/**
 * Each group of runs at the checkout, in turn, each in a suite slot of its
 * own taken by `admit`, checking out and installing in it first: green where
 * every run exits 0, red with the files they name where one fails naming
 * some, and no verdict at the first step that reaches none.
 * @param {Run[][]} groups
 * @param {Checkout} checkout
 * @param {SlotRuns} slotRuns
 * @returns {Promise<Verdict>}
 */
async function runEach(groups, checkout, { admit, treePss, tally }) {
	/** @type {Set<string>} */
	const failing = new Set();
	/** @type {import("./queue-lander.js").Failure[]} */
	const failures = [];
	for (const runs of groups) {
		/** @type {Admission} */
		let slot;
		try {
			slot = await admit();
		} catch (err) {
			return {
				kind: "unknown",
				reason: `no suite slot: ${caught(err).message}`,
			};
		}
		if (!slot.ok)
			return { kind: "unknown", reason: slot.reason, transient: true };
		try {
			const unready = checkOutAndInstall(checkout);
			if (unready !== null) return { kind: "unknown", reason: unready };
			const why = await runInSlot(runs, checkout.dir, {
				spawned: slot.spawned,
				treePss,
				tally,
				failing,
				failures,
			});
			/* No verdict, never red, though an earlier shard failed: a red
			 * would send the lander to rerun those files alone, and a pass
			 * there would land a shard no run judged. */
			if (why !== null)
				return {
					kind: "unknown",
					reason:
						failing.size > 0
							? `${why}, after ${[...failing].join(", ")} failed`
							: why,
				};
		} finally {
			slot.release();
		}
	}
	if (failing.size === 0) return { kind: "green" };
	return {
		kind: "red",
		files: [...failing],
		...(failures.length > 0 ? { failures } : {}),
	};
}

/**
 * Each of `runs` in `dir`, in turn, adding the files a failing one names to
 * `failing` and its tree peak to `tally`.
 * @param {Run[]} runs
 * @param {string} dir
 * @param {{spawned: () => void, treePss: (pid: number) => number,
 *   tally: SlotRuns["tally"], failing: Set<string>,
 *   failures: import("./queue-lander.js").Failure[]}} into accumulator
 * @returns {Promise<string|null>} why a run reached no verdict, or null
 */
async function runInSlot(
	runs,
	dir,
	{ spawned, treePss, tally, failing, failures },
) {
	for (const run of runs) {
		const r = await shellRun(run, dir, spawned, treePss);
		tally.peakKb = Math.max(tally.peakKb, r.peakKb);
		tally.samples += r.samples;
		const command = run.label ?? run.command;
		if (r.error !== null) return `${command} did not start: ${r.error}`;
		tally.ran += 1;
		if (r.code === null)
			return `${command} was killed by ${r.signal ?? "an unknown signal"}`;
		if (r.code === 0) continue;
		/* A test that prints a runner's output as its fixture puts FAIL lines
		 * naming files the tree lacks into the run's output (#2410). */
		const files = parseFailingFiles(r.out).filter((f) =>
			fs.existsSync(path.join(dir, f)),
		);
		if (files.length === 0)
			return `${command} exited ${r.code} ${parseCeilingKillReason(r.out) ?? "naming no failing file in the tree"}`;
		for (const f of files) failing.add(f);
		failures.push(
			...parseFailingTests(r.out).filter((t) => files.includes(t.file)),
		);
	}
	return null;
}

/**
 * One line of the lander run record (#3323). A line that does not land is
 * said on stderr and costs the verdict nothing.
 * @param {string} root
 * @param {{sha: string, kind: keyof typeof CHARGE_MB, files: number,
 *   shards: number, peakMb: number, samples: number,
 *   verdict: Verdict["kind"]}} run
 */
function recordRun(root, run) {
	const file = path.join(markersDir(root), RUN_RECORD);
	const landed = appendRetained(
		file,
		{ at: new Date().toISOString(), ...run },
		RUN_RECORD_RETAIN_MS,
	);
	if (!landed) process.stderr.write(`lander: run record unwritten: ${file}\n`);
}

/**
 * One line of what held memory at a memory-shut slot, its RSS largest first.
 * Like the run record, a line that cannot be had or land is said on stderr and
 * costs the verdict nothing.
 * @param {string} root
 * @param {string} sha
 * @param {import("./admission.js").PsRead} ps
 */
function recordHolders(root, sha, ps) {
	if (!ps.ok) {
		writeFd(2, `lander: memory holders unread: ${ps.error}\n`);
		return;
	}
	const holders = [...ps.rows]
		.sort((a, b) => b.rssKb - a.rssKb)
		.slice(0, HOLDERS_KEPT)
		.map((r) => ({
			pid: r.pid,
			rssMb: Math.floor(r.rssKb / 1024),
			command: r.args.slice(0, HOLDER_COMMAND_CHARS),
		}));
	const file = path.join(markersDir(root), HOLDER_RECORD);
	const line = { at: new Date().toISOString(), sha, holders };
	if (!appendRetained(file, line, RUN_RECORD_RETAIN_MS))
		writeFd(2, `lander: memory holders unwritten: ${file}\n`);
}

/**
 * @param {Checkout} checkout
 * @param {string} pytest
 * @param {string[]} files
 * @param {(dir: string) => string|null} timings
 * @returns {Run[][] | string} the groups, or why none can be had
 */
function checkedOutRuns(checkout, pytest, files, timings) {
	return (
		checkOutOrWhy(checkout) ?? readRunsAt(checkout.dir, pytest, files, timings)
	);
}

/**
 * The cached newest green run's timings.
 * @param {string} dir
 * @returns {string|null}
 */
function readLatestTimings(dir) {
	const { file, failed } = latestTimings(dir);
	if (failed !== null)
		writeFd(
			2,
			`lander: shard timings not refreshed (${failed}) — ${file ?? "splitting by file count"}\n`,
		);
	return file;
}

/**
 * @param {() => Promise<Admission>} admit
 * @returns {{admit: () => Promise<Admission>, shut: string|null}}
 */
function watchMemoryShut(admit) {
	/** @type {{admit: () => Promise<Admission>, shut: string|null}} */
	const watched = {
		shut: null,
		admit: async () => {
			const slot = await admit();
			if (!slot.ok && slot.memoryShut) watched.shut = slot.reason;
			return slot;
		},
	};
	return watched;
}

/**
 * The queue lander's tester.
 * @param {LocalTesterOptions} options
 * @returns {QueueTester}
 */
function localTester({
	root,
	admit = suiteSlot,
	exec = execOrThrow,
	pytest = path.join(__dirname, "..", "run-pytest.js"),
	treePss = readTreePssKb,
	timings = readLatestTimings,
}) {
	const dir = path.join(root, LANDER_WORKTREE);
	return {
		async verdict(sha, files = []) {
			/** @type {Checkout} */
			const checkout = { root, dir, sha, exec };
			const groups = checkedOutRuns(checkout, pytest, files, timings);
			if (typeof groups === "string")
				return { kind: "unknown", reason: groups };
			const kind = files.length > 0 ? "named" : "whole";
			const tally = { ran: 0, peakKb: 0, samples: 0 };
			const chargeKind = files.length > NAMED_MEASURED_FILES ? "whole" : kind;
			const watched = watchMemoryShut(() =>
				admit({ chargeMb: CHARGE_MB[chargeKind] }),
			);
			const verdict = await runEach(groups, checkout, {
				admit: watched.admit,
				treePss,
				tally,
			});
			if (tally.ran > 0)
				recordRun(root, {
					sha,
					kind,
					files: files.length,
					shards: kind === "whole" ? groups.length : 1,
					peakMb: Math.round(tally.peakKb / 1024),
					samples: tally.samples,
					verdict: verdict.kind,
				});
			if (watched.shut !== null) recordHolders(root, sha, readPsRows());
			return verdict;
		},
	};
}

/**
 * The tester `--tester <command>` names, run in `root`, the whole suite or
 * only the files where they are given.
 * @param {string} command
 * @param {string} root
 * @returns {import("./queue-lander.js").QueueTester}
 */
const commandTester = (command, root) => ({
	verdict: (sha, files = []) =>
		new Promise((resolve) => {
			const child = spawn(
				"sh",
				["-c", `${command} "$@"`, "tester", sha, ...files],
				{ cwd: root, stdio: ["ignore", "pipe", "inherit"] },
			);
			let out = "";
			child.stdout.on("data", (chunk) => {
				out += chunk;
			});
			child.on("error", (err) =>
				resolve({
					kind: "unknown",
					reason: `tester did not start: ${err.message}`,
				}),
			);
			child.on("close", (code, signal) => {
				if (code === 0) resolve({ kind: "green" });
				else if (code === 1)
					resolve({
						kind: "red",
						files: out
							.split("\n")
							.map((l) => l.trim())
							.filter(Boolean),
					});
				else
					resolve({
						kind: "unknown",
						reason: `tester ended ${signal ?? `exit ${code}`}`,
					});
			});
		}),
});

module.exports = {
	commandTester,
	parseFailingFiles,
	parseFailingTests,
	readLiveLanders,
	localTester,
	suiteSlot,
};
