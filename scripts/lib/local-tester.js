/*
 * local-tester.js — the landing queue's local tester (workflow-core#2403, spec workflow-core#2261): the
 * lander's tester on a private adopter and on the core's trial. It runs the
 * suite at a sha in a detached worktree the lander owns, never the shared
 * tree, so no session's unsaved edit is ever tested (mantahostels#908's
 * reason).
 *
 * Each run holds one suite slot from the install to the last command. A slot
 * still shut at the queue's ceiling is no verdict: the tester never runs
 * unadmitted, where the queue's own wait runs anyway on the count cap.
 *
 * Any step that fails before the suite reports — the checkout, the slot, the
 * install, a command that will not start, is killed, or fails naming no
 * failing file — is no verdict, never green or red.
 */

const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { availableMb } = require("./admission.js");
const { caught } = require("./caught.js");
const { requiredGroup } = require("./regex-group.js");
const {
	gateDenies,
	liveRolePids,
	queueJoin,
	queueLeave,
	queueSpawned,
	queueTurn,
	waitForGate,
} = require("./suite-queue.js");
const { readConfig } = require("./workflow-core-config.js");

/**
 * The lander's environment less every variable a root lookup answers before
 * cwd, so the install and suite run as CI does: rooted by their own
 * directory. A CLAUDE_PROJECT_DIR left in sent the suite to the shared tree;
 * a WFC_REPO_ROOT, the suite's test-injection point, outranked every
 * fixture's root (workflow-core#2410); a CLAUDE_PLUGIN_ROOT from the hook that started the
 * lander sent init-adopter to the shared tree's self-plugin/ (workflow-core#2476).
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

/* Built as the suite ladder's rungs are (docs/environment.md §6): earlyoom's
 * 794 MB + the full run's MemAvailable dip + the 300 MB fitted margin, rounded
 * up to 50 MB. The dip, 1,821 MB, is one run of this tester at 1ff897864
 * (vitest then pytest, 27 min) with neighbours' suites live, so it is an upper
 * bound; the run's own process tree peaked at 923 MB PSS (workflow-core#2410). Session
 * admission takes the floor and margin back off (workflow-core#2416), so a replacement
 * figure keeps this shape. */
const SLOT_MB = 2950;
/* The queue marker's role, which session admission reads (workflow-core#2416). */
const LANDER_ROLE = "lander";
/* Untraced: room for `npm ci` over a slow link. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/* Untraced: room for a checkout of the whole tree. */
const GIT_TIMEOUT_MS = 120 * 1000;
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
 *   error: string|null}} RunResult
 * @typedef {{command: string, args: string[]}} Run
 * @typedef {(bin: string, args: string[], cwd: string, timeout?: number)
 *   => void} Exec git or npm, throwing on failure
 * @typedef {object} LocalTesterOptions
 * @property {string} root the canonical checkout, whose object store the
 *   worktree shares
 * @property {() => Promise<Admission>} [admit] one suite slot
 * @property {Exec} [exec]
 * @property {string} [pytest] the Python suite's runner
 */

/**
 * The failing test files a vitest or pytest run names, in the order first
 * named: vitest's `FAIL  <file> > <test>` lines and pytest's
 * `FAILED <file>::<test>` and `ERROR <file>` ones.
 * @param {string} out
 * @returns {string[]}
 */
function failingFiles(out) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
	const plain = out.replace(/\u001b\[[0-9;]*m/g, "");
	/** @type {Set<string>} */
	const files = new Set();
	for (const line of plain.split("\n"))
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
 * One suite slot: a place in the suite queue, the suite gate open, and
 * MemAvailable at SLOT_MB, all three at once. Memory that cannot be read
 * holds the slot shut. At the ceiling it refuses on either limb: the lander
 * then exits with no verdict, leaving the batch for its next run (workflow-core#2542).
 * @param {{pollMs?: number, timeoutMs?: number,
 *   gate?: () => import("./suite-queue.js").GateDenial | null,
 *   memory?: () => import("./admission.js").MbResult, queueDir?: string}}
 *   [options] `gate` answers which limb of the suite gate denies a suite, if
 *   any; the poll and ceiling default to the suite queue's
 * @returns {Promise<Admission>}
 */
async function suiteSlot({
	pollMs,
	timeoutMs,
	gate = () => gateDenies(),
	memory = availableMb,
	queueDir,
} = {}) {
	const file = queueJoin({ queueDir, role: LANDER_ROLE });
	let mem = memory();
	const outcome = await waitForGate({
		pollMs,
		timeoutMs,
		gate: () => {
			mem = memory();
			if (!mem.ok || mem.mb < SLOT_MB)
				return {
					limb: "memory",
					...(mem.ok ? { mb: mem.mb } : {}),
					rungMb: SLOT_MB,
				};
			return gate();
		},
		turn: () => queueTurn({ queueDir }),
		label: "lander",
		refuseAtCeiling: true,
	});
	if (outcome !== "refused")
		return {
			ok: true,
			spawned: () => queueSpawned(file),
			release: () => queueLeave(file),
		};
	queueLeave(file);
	const memoryRead = mem.ok
		? `${mem.mb} MB available against ${SLOT_MB} MB`
		: `memory unread: ${mem.error}`;
	return { ok: false, reason: `no suite slot by the ceiling (${memoryRead})` };
}

/**
 * The landers holding or waiting for a suite slot, for session admission to
 * hold back (workflow-core#2416).
 * @param {{queueDir?: string}} [options]
 * @returns {import("./admission.js").Landers}
 */
function liveLanders({ queueDir } = {}) {
	return { pids: liveRolePids(LANDER_ROLE, { queueDir }), slotMb: SLOT_MB };
}

/**
 * `command "$@"` under `sh` in `cwd`, its stdout and stderr passed through to
 * stderr and kept.
 * @param {Run} run
 * @param {string} cwd
 * @param {() => void} onSpawn
 * @returns {Promise<RunResult>}
 */
const shellRun = ({ command, args }, cwd, onSpawn) =>
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
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		child.on("spawn", onSpawn);
		child.on("error", (err) =>
			resolve({ code: null, signal: null, out, error: err.message }),
		);
		child.on("close", (code, signal) =>
			resolve({ code, signal, out, error: null }),
		);
	});

/** @type {Exec} */
const execOrThrow = (bin, args, cwd, timeout = GIT_TIMEOUT_MS) => {
	execFileSync(bin, args, {
		cwd,
		env: rootlessEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
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
		exec("git", ["worktree", "prune"], root);
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		exec("git", ["worktree", "add", "--detach", dir, sha], root);
		return;
	}
	exec("git", ["checkout", "--quiet", "--detach", "--force", sha], dir);
	exec("git", ["clean", "-ffdq"], dir);
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
	exec("npm", ["ci", "--no-audit", "--no-fund"], dir, INSTALL_TIMEOUT_MS);
	fs.writeFileSync(stamp, `${hash}\n`);
}

/**
 * The runs that retest `files` alone: the Python ones on the runner where
 * Python is routed, the rest on `test`.
 * @param {string[]} files
 * @param {string|null} test
 * @param {string|false} python the runner's command, false where unrouted
 * @returns {Run[] | string}
 */
function rerunsOf(files, test, python) {
	const py = python ? files.filter((f) => f.endsWith(".py")) : [];
	const rest = files.filter((f) => !py.includes(f));
	if (rest.length > 0 && !test) return "no test command is declared";
	return [
		...(test && rest.length > 0 ? [{ command: test, args: rest }] : []),
		...(python && py.length > 0 ? [{ command: python, args: py }] : []),
	];
}

/**
 * The commands a run takes at `dir`: the declared `full_test`, else `test`,
 * and the Python runner where the config routes a Python test path; with
 * `files`, `rerunsOf`'s runs. Read from the worktree's own config, the one
 * the sha carries.
 * @param {string} dir
 * @param {string} pytest
 * @param {string[]} files
 * @returns {Run[] | string} the runs, or why none can be had
 */
function runsAt(dir, pytest, files) {
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
	const python = `node ${pytest}`;
	if (files.length > 0) return rerunsOf(files, test, routesPython && python);
	const whole = full_test ?? test;
	if (!whole) return "no test command is declared";
	return [
		{ command: whole, args: [] },
		...(routesPython ? [{ command: python, args: [] }] : []),
	];
}

/**
 * Each of `runs` in `dir`, in turn: green where every one exits 0, red with
 * the files they name where one fails naming some.
 * @param {Run[]} runs
 * @param {string} dir
 * @param {() => void} spawned
 * @returns {Promise<Verdict>}
 */
async function runEach(runs, dir, spawned) {
	/** @type {Set<string>} */
	const failing = new Set();
	for (const run of runs) {
		const r = await shellRun(run, dir, spawned);
		const { command } = run;
		if (r.error !== null)
			return {
				kind: "unknown",
				reason: `${command} did not start: ${r.error}`,
			};
		if (r.code === null)
			return {
				kind: "unknown",
				reason: `${command} was killed by ${r.signal ?? "an unknown signal"}`,
			};
		if (r.code === 0) continue;
		/* A test that prints a runner's output as its fixture puts FAIL lines
		 * naming files the tree lacks into the run's output (workflow-core#2410). */
		const files = failingFiles(r.out).filter((f) =>
			fs.existsSync(path.join(dir, f)),
		);
		if (files.length === 0)
			return {
				kind: "unknown",
				reason: `${command} exited ${r.code} naming no failing file in the tree`,
			};
		for (const f of files) failing.add(f);
	}
	return failing.size > 0
		? { kind: "red", files: [...failing] }
		: { kind: "green" };
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
			const runs = runsAt(dir, pytest, files);
			if (typeof runs === "string") return { kind: "unknown", reason: runs };
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
				return await runEach(runs, dir, slot.spawned);
			} finally {
				slot.release();
			}
		},
	};
}

module.exports = { liveLanders, localTester, suiteSlot };
