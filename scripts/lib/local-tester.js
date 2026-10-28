/*
 * local-tester.js — the landing queue's local tester (#2403, spec #2261): the
 * lander's tester on a private adopter and on the core's trial. It runs the
 * suite at a sha in a detached worktree the lander owns, never the shared
 * tree, so no session's unsaved edit is ever tested (mantahostels#908's
 * reason).
 *
 * Each group of runs holds one suite slot from the install to its last
 * command; a sharded whole run takes one slot per shard. A slot still shut at
 * the queue's wait bound is no verdict: the tester never runs unadmitted.
 *
 * Any step that fails before the suite reports — the checkout, the slot, the
 * install, a command that will not start, is killed, or fails naming no
 * failing file — is no verdict, never green or red.
 */

const { execFileSync, spawn } = require("node:child_process");
const { gitBinary, gitSpawnOptions } = require("./git.js");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readAvailableMb, readTreePssKb } = require("./admission.js");
const { caught } = require("./caught.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { requiredGroup } = require("./regex-group.js");
const { CEILING_LINE } = require("./suite-ceiling.js");
const { rungMb } = require("./suite-ladder.js");
const {
	gateDenies,
	readLiveRoleMarkers,
	queueJoin,
	queueLeave,
	queueSpawned,
	queueStamps,
	queueTurn,
	waitForGate,
} = require("./suite-queue.js");
const { readConfig } = require("./workflow-core-config.js");

/**
 * The lander's environment less every variable a root lookup answers before
 * cwd, so the install and suite run as CI does: rooted by their own
 * directory. A CLAUDE_PROJECT_DIR left in sent the suite to the shared tree;
 * a WFC_REPO_ROOT, the suite's test-injection point, outranked every
 * fixture's root (#2410); a CLAUDE_PLUGIN_ROOT from the hook that started the
 * lander sent init-adopter to the shared tree's self-plugin/ (#2476).
 */
const rootlessEnv = () => {
	const env = { ...process.env };
	delete env.CLAUDE_PROJECT_DIR;
	delete env.CLAUDE_PLUGIN_ROOT;
	delete env.WFC_REPO_ROOT;
	delete env.WFC_DISPATCH_ROOT;
	return env;
};

/** @typedef {import("./lander.js").Verdict} Verdict */
/** @typedef {import("./lander.js").Tester} Tester */

/* What admission holds back for a lander, by the kind of run it holds
 * (#3323): its tester's own tree peak, never a machine-wide MemAvailable dip
 * (#2508). Whole: 923 MB PSS for one full run (#2410) + 223 MB, the max less
 * the median of eight reruns of one file set (#2496) = 1,146, rounded up to
 * 1,150. Named: 552 MB, the highest rerun peak (#2496), + ~10%, set at 600 by
 * #3323. The lander run record is what a re-size reads. */
const CHARGE_MB = { whole: 1150, named: 600 };
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
/* Where the install's lockfile hash is kept: inside what it installed, so a
 * deleted `node_modules` takes its stamp with it. */
const STAMP = path.join("node_modules", ".lander-lock-hash");
const LOCKFILE = "package-lock.json";
const VITEST_FAIL = /^\s*FAIL\s+(\S+)/;
const PYTEST_FAIL = /^(?:FAILED|ERROR)\s+([^\s:]+)/;

/**
 * @typedef {{ok: true, spawned: () => void, release: () => void}
 *   | {ok: false, reason: string}} Admission
 * @typedef {{code: number|null, signal: string|null, out: string,
 *   error: string|null, peakKb: number, samples: number}} RunResult
 *   `peakKb` the run's tree-PSS peak over `samples` reads
 * @typedef {{command: string, args: string[], label?: string}} Run `label`
 *   names the run in a reason where `command` alone would not, as a shard's
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
function failingFiles(out) {
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
 *   memory?: () => import("./admission.js").MbResult, queueDir?: string}}
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
	const file = queueJoin({ queueDir, role: LANDER_ROLE, chargeMb });
	const rung = rungMb(chargeMb);
	let mem = memory();
	const outcome = await waitForGate({
		pollMs,
		timeoutMs,
		gate: (climbMb) => {
			mem = memory();
			if (!mem.ok || mem.mb - climbMb < rung)
				return {
					limb: "memory",
					...(mem.ok ? { mb: mem.mb } : {}),
					rungMb: rung,
					...(climbMb > 0 ? { climbMb } : {}),
				};
			return gate(climbMb);
		},
		turn: () => queueTurn({ queueDir }),
		...queueStamps(file, { queueDir }),
		label: "lander",
	});
	if (outcome !== "refused")
		return {
			ok: true,
			spawned: () => queueSpawned(file),
			release: () => queueLeave(file),
		};
	queueLeave(file);
	const memoryRead = mem.ok
		? `${mem.mb} MB available against ${rung} MB`
		: `memory unread: ${mem.error}`;
	return { ok: false, reason: `no suite slot by the ceiling (${memoryRead})` };
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
const shellRun = ({ command, args }, cwd, onSpawn, treePss) =>
	new Promise((resolve) => {
		const child = spawn("sh", ["-c", `${command} "$@"`, "tester", ...args], {
			cwd,
			env: rootlessEnv(),
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
 * Python test path; with `files`, `rerunsOf`'s runs. A declared
 * `fullTestShards` splits the whole run into that many `--shard=k/n` groups,
 * each under its own suite ceiling, the Python runner joining the last
 * (#2996). Read from the worktree's own config, the one the sha carries.
 * @param {string} dir
 * @param {string} pytest
 * @param {string[]} files
 * @returns {Run[][] | string} the groups, or why none can be had
 */
function readRunsAt(dir, pytest, files) {
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
		const runs = rerunsOf(files, test, routesPython && python);
		return typeof runs === "string" ? runs : [runs];
	}
	const whole = full_test ?? test;
	if (!whole) return "no test command is declared";
	const shards = config.fullTestShards ?? 1;
	/* A bare run in this clean worktree selects no touched test (#3508). */
	/** @type {Run} */
	const wholePython = {
		...python,
		args: [pytest, "--full"],
		label: `${python.label} --full`,
	};
	return Array.from({ length: shards }, (_, i) => {
		const shard = `--shard=${i + 1}/${shards}`;
		return [
			shards > 1
				? { command: whole, args: [shard], label: `${whole} ${shard}` }
				: { command: whole, args: [] },
			...(routesPython && i === shards - 1 ? [wholePython] : []),
		];
	});
}

/**
 * @typedef {object} SlotRuns
 * @property {() => Promise<Admission>} admit one suite slot
 * @property {Exec} exec
 * @property {(pid: number) => number} treePss
 * @property {{ran: number, peakKb: number, samples: number}} tally
 *   accumulator: the runs spawned, their highest tree peak and the reads it
 *   was taken over
 */

/**
 * Each group of runs in `dir`, in turn, each in a suite slot of its own
 * taken by `admit`, installing in it first: green where every run exits 0,
 * red with the files they name where one fails naming some, and no verdict
 * at the first step that reaches none.
 * @param {Run[][]} groups
 * @param {string} dir
 * @param {SlotRuns} slotRuns
 * @returns {Promise<Verdict>}
 */
async function runEach(groups, dir, { admit, exec, treePss, tally }) {
	/** @type {Set<string>} */
	const failing = new Set();
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
		if (!slot.ok) return { kind: "unknown", reason: slot.reason };
		try {
			try {
				install(dir, exec);
			} catch (err) {
				return {
					kind: "unknown",
					reason: `install failed: ${whyFailed(err)}`,
				};
			}
			const why = await runInSlot(runs, dir, {
				spawned: slot.spawned,
				treePss,
				tally,
				failing,
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
	return failing.size > 0
		? { kind: "red", files: [...failing] }
		: { kind: "green" };
}

/**
 * Each of `runs` in `dir`, in turn, adding the files a failing one names to
 * `failing` and its tree peak to `tally`.
 * @param {Run[]} runs
 * @param {string} dir
 * @param {{spawned: () => void, treePss: (pid: number) => number,
 *   tally: SlotRuns["tally"], failing: Set<string>}} into accumulator:
 *   `tally` takes the runs' peak so far and `failing` the failing files so far
 * @returns {Promise<string|null>} why a run reached no verdict, or null
 */
async function runInSlot(runs, dir, { spawned, treePss, tally, failing }) {
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
		const files = failingFiles(r.out).filter((f) =>
			fs.existsSync(path.join(dir, f)),
		);
		if (files.length === 0)
			return `${command} exited ${r.code} ${parseCeilingKillReason(r.out) ?? "naming no failing file in the tree"}`;
		for (const f of files) failing.add(f);
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
 * The lander's tester.
 * @param {LocalTesterOptions} options
 * @returns {Tester}
 */
function localTester({
	root,
	admit = suiteSlot,
	exec = execOrThrow,
	pytest = path.join(__dirname, "..", "run-pytest.js"),
	treePss = readTreePssKb,
}) {
	const dir = path.join(root, ".claude", "worktrees", "lander");
	return {
		async verdict(sha, files = []) {
			try {
				checkOut(root, dir, sha, exec);
			} catch (err) {
				return {
					kind: "unknown",
					reason: `checkout failed: ${whyFailed(err)}`,
				};
			}
			const groups = readRunsAt(dir, pytest, files);
			if (typeof groups === "string")
				return { kind: "unknown", reason: groups };
			const kind = files.length > 0 ? "named" : "whole";
			const tally = { ran: 0, peakKb: 0, samples: 0 };
			const verdict = await runEach(groups, dir, {
				admit: () => admit({ chargeMb: CHARGE_MB[kind] }),
				exec,
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
			return verdict;
		},
	};
}

module.exports = { failingFiles, readLiveLanders, localTester, suiteSlot };
