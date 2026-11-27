const { execFileSync, spawn } = require("node:child_process");
const { gitBinary, gitSpawnOptions } = require("./git.js");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { noop } = require("./noop.js");
const { readPsRows, readTreePssKb, sampleTreePeak } = require("./admission.js");
const { caught } = require("./caught.js");
const { readBytes, readText } = require("./file-read.js");
const { MARKERS_REL, markersDir } = require("./marker-root.js");
const { appendRetained } = require("./retained-jsonl.js");
const {
	RUN_RECORD_RETAIN_MS,
	localSeconds,
	readWholePeak,
	recordRun,
} = require("./lander-run-record.js");
const { writeFd } = require("./write-fd.js");
const { CEILING_LINE } = require("./suite-ceiling.js");
const {
	parseFailingFiles,
	parseFailingTests,
	parsePlainLines,
} = require("./suite-output.js");
const {
	chargeMb: launchChargeMb,
	isWholeLanderRun,
} = require("./launch-charge.js");
const { readLiveCharged } = require("./suite-queue.js");
const { LANDER_ROLE, suiteSlot } = require("./suite-slot.js");
const { LANDER_WORKTREE } = require("./worktree-dirs.js");
const { readConfig, wholeRunShardCount } = require("./workflow-core-config.js");
const { latestTimings } = require("./latest-timings.js");
const { LANDER_RUN } = require("./session-id.js");
const { voidProof } = require("./verdict-probe.js");
const { npmBin } = require("./npm-bin.js");
const { INSTALL_TIMEOUT_MS, LOCKFILE } = require("./npm-ci-staging.js");

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

// guess, workflow-core#2403
const CHECKOUT_TIMEOUT_MS = 120 * 1000;
const HOLDER_RECORD = ".lander-memory-holders.jsonl";
// guess, workflow-core#3764
const HOLDERS_KEPT = 10;
// guess, workflow-core#3764
const HOLDER_COMMAND_CHARS = 120;
const STAMP = path.join("node_modules", ".lander-lock-hash");

/**
 * @typedef {import("./suite-slot.js").Admission} Admission
 * @typedef {{code: number|null, signal: string|null, out: string,
 *   error: string|null, peakKb: number, samples: number}} RunResult
 * @typedef {{command: string, args: string[], label?: string,
 *   env?: Record<string, string>}} Run
 * @typedef {(bin: string, args: string[], cwd: string,
 *   opts?: {timeout?: number, maxBuffer?: number}) => void} Exec
 * @typedef {object} LocalTesterOptions
 * @property {string} root
 * @property {(slot: {chargeMb: number}) => Promise<Admission>} [admit]
 * @property {Exec} [exec]
 * @property {string} [pytest]
 * @property {(pid: number) => number} [treePss]
 * @property {(dir: string) => string|null} [timings]
 * @property {() => void} [beat]
 */

/**
 * @param {string} out
 * @returns {string|null}
 */
function parseCeilingKillReason(out) {
	const line = parsePlainLines(out).find((l) => l.startsWith(CEILING_LINE));
	return line === undefined ? null : `killed: ${line}`;
}

/**
 * @param {{queueDir?: string}} [options]
 * @returns {import("./admission.js").Landers}
 */
function readLiveLanders({ queueDir } = {}) {
	const { records, unread } = readLiveCharged(
		LANDER_ROLE,
		launchChargeMb({ kind: "lander", files: [] }),
		queueDir,
	);
	return {
		live: records.map(({ pid, chargeMb }) => ({ pid, chargeMb })),
		unread,
	};
}

/**
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
			env: { ...rootlessEnv(), ...env, [LANDER_RUN]: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		/** @param {Buffer} chunk */
		const keep = (chunk) => {
			out += chunk;
			process.stderr.write(chunk);
		};
		/** @type {ReturnType<typeof sampleTreePeak> | undefined} */
		let sampler;
		const stop = () => sampler?.stop() ?? { peakKb: 0, samples: 0 };
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		child.on("spawn", () => {
			sampler = sampleTreePeak(child.pid, { treePss });
			onSpawn();
		});
		child.on("error", (err) => {
			resolve({
				code: null,
				signal: null,
				out,
				error: err.message,
				...stop(),
			});
		});
		child.on("close", (code, signal) => {
			resolve({ code, signal, out, error: null, ...stop() });
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
 * @param {unknown} err
 */
function whyFailed(err) {
	const e = caught(err);
	const last = (e.stderr ?? "").trim().split("\n").pop();
	return last || e.message;
}

/**
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
 * @param {string} dir
 * @param {Exec} exec
 */
function install(dir, exec) {
	const lock = readBytes(path.join(dir, LOCKFILE));
	if (lock.state === "absent") return;
	if (lock.state === "unreadable") throw lock.error;
	const hash = crypto.createHash("sha256").update(lock.data).digest("hex");
	const stamp = path.join(dir, STAMP);
	const stamped = readText(stamp);
	if (stamped.state === "read" && stamped.data.trim() === hash) return;
	exec(npmBin(), ["ci", "--no-audit", "--no-fund"], dir, {
		timeout: INSTALL_TIMEOUT_MS,
	});
	fs.writeFileSync(stamp, `${hash}\n`);
}

/**
 * @param {string[]} files
 * @param {string|null} test
 * @param {Run|false} python
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
 * @param {string} dir
 * @param {string} pytest
 * @param {string[]} files
 * @param {(dir: string) => string|null} timings
 * @returns {Run[][] | string}
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
	/** @type {Run} */
	const python = {
		command: "node",
		args: [pytest],
		label: `node ${path.basename(pytest)}`,
	};
	if (files.length > 0) {
		const present = files.filter((f) => fs.existsSync(path.join(dir, f)));
		if (present.length === 0) return [];
		const runs = rerunsOf(present, test, routesPython && python);
		return typeof runs === "string" ? runs : [runs];
	}
	/** @type {Run} */
	const wholePython = {
		...python,
		args: [pytest, "--full"],
		label: `${python.label} --full`,
	};
	const whole = full_test ?? test;
	if (!whole) return routesPython ? [[wholePython]] : [];
	const shards = wholeRunShardCount(config);
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
 */

/**
 * @typedef {object} SlotRuns
 * @property {() => Promise<Admission>} admit
 * @property {(pid: number) => number} treePss
 * @property {{ran: number, peakKb: number, samples: number}} tally
 * @property {() => void} beat
 */

/**
 * @param {Checkout} checkout
 * @returns {string|null}
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
 * @param {Checkout} checkout
 * @param {() => void} beat
 * @returns {string|null}
 */
function checkOutAndInstall(checkout, beat) {
	const why = checkOutOrWhy(checkout);
	if (why !== null) return why;
	beat();
	try {
		install(checkout.dir, checkout.exec);
		return null;
	} catch (err) {
		return `install failed: ${whyFailed(err)}`;
	}
}

/**
 * @param {Run[][]} groups
 * @param {Checkout} checkout
 * @param {SlotRuns} slotRuns
 * @returns {Promise<Verdict>}
 */
async function runEach(groups, checkout, { admit, treePss, tally, beat }) {
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
			const unready = checkOutAndInstall(checkout, beat);
			if (unready !== null) return { kind: "unknown", reason: unready };
			const why = await runInSlot(runs, checkout.dir, {
				spawned: slot.spawned,
				treePss,
				tally,
				failing,
				failures,
				root: checkout.root,
			});
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
 * @param {string} command
 * @param {{ code: number | null, out: string }} r
 * @param {string} root
 */
function voidProofOnNamelessRed(command, r, root) {
	const ceiling = parseCeilingKillReason(r.out);
	if (ceiling !== null) return `${command} exited ${r.code} ${ceiling}`;
	if (voidProof(`${command} exited ${r.code}`, path.join(root, MARKERS_REL)))
		writeFd(
			2,
			`local-tester: ${command} went red naming no failing file in the tree, so its verdict proof is marked failed and commits run the suite again.\n`,
		);
	return `${command} exited ${r.code} naming no failing file in the tree`;
}

/**
 * @param {Run[]} runs
 * @param {string} dir
 * @param {{spawned: () => void, treePss: (pid: number) => number,
 *   tally: SlotRuns["tally"], failing: Set<string>,
 *   failures: import("./queue-lander.js").Failure[], root: string}} into
 * @returns {Promise<string|null>}
 */
async function runInSlot(
	runs,
	dir,
	{ spawned, treePss, tally, failing, failures, root },
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
		const files = parseFailingFiles(r.out).filter((f) =>
			fs.existsSync(path.join(dir, f)),
		);
		if (files.length === 0) return voidProofOnNamelessRed(command, r, root);
		for (const f of files) failing.add(f);
		failures.push(
			...parseFailingTests(r.out).filter((t) => files.includes(t.file)),
		);
	}
	return null;
}

/**
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
 * @returns {Run[][] | string}
 */
function checkedOutRuns(checkout, pytest, files, timings) {
	return (
		checkOutOrWhy(checkout) ?? readRunsAt(checkout.dir, pytest, files, timings)
	);
}

/**
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
 * @param {string} root
 * @param {readonly string[]} files
 * @returns {number}
 */
function landerChargeMb(root, files) {
	if (!isWholeLanderRun(files))
		return launchChargeMb({ kind: "lander", files });
	const whole = launchChargeMb({ kind: "lander", files: [] });
	const measured = readWholePeak(root);
	if ("peakMb" in measured)
		return launchChargeMb({ kind: "lander", files, wholeMb: measured.peakMb });
	writeFd(
		2,
		`lander: charged ${whole} MB, not this repo's peak: ${measured.why}\n`,
	);
	return whole;
}

/**
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
	beat = noop,
}) {
	const dir = path.join(root, LANDER_WORKTREE);
	return {
		repeatsSuite: true,
		async verdict(_place, sha, files = []) {
			/** @type {Checkout} */
			const checkout = { root, dir, sha, exec };
			const groups = checkedOutRuns(checkout, pytest, files, timings);
			if (typeof groups === "string")
				return { kind: "unknown", reason: groups };
			const kind = files.length > 0 ? "named" : "whole";
			const tally = { ran: 0, peakKb: 0, samples: 0 };
			const chargeMb = landerChargeMb(root, files);
			const watched = watchMemoryShut(() => admit({ chargeMb }));
			const verdict = await runEach(groups, checkout, {
				admit: watched.admit,
				treePss,
				tally,
				beat,
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
					tester: "local",
					suiteSeconds: localSeconds(tally.samples),
				});
			if (watched.shut !== null) recordHolders(root, sha, readPsRows());
			return verdict;
		},
	};
}

/**
 * @param {string} command
 * @param {string} root
 * @returns {import("./queue-lander.js").QueueTester}
 */
const commandTester = (command, root) => ({
	verdict: (_place, sha, files = []) =>
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
	readLiveLanders,
	localTester,
	readRunsAt,
};
