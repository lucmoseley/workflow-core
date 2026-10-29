/*
 * headless-sessions.js — launches, lists and stops headless `claude -p` runs
 * on an overflow seat, and reads how each ended (#2607, spec #2570).
 *
 * LAUNCH: `claude -p` detached in its own process group, stdin on /dev/null,
 * cwd the target checkout, under the seat's config dir and a fresh
 * CLAUDE_JOB_DIR, with headless-contract.md appended to its system prompt and
 * `--max-budget-usd` the caller's headroom. No `--model`: Opus is the default
 * (mantahostels#1093).
 *
 * THE KEY reaches the child only through an `apiKeyHelper` in `--settings`,
 * this module's `key` command, which prints the seat's named variable from
 * the secrets file (lib/env-file.js).
 * It is in neither the caller's environment nor the child's, so no Bash call
 * or hook in the session sees it (#2604 (b)); the launch removes any
 * ANTHROPIC_API_KEY or seat variable it inherits. A missing file or
 * variable refuses the launch by name before anything spawns, since the
 * helper runs only after; so does any other auth in force on the seat
 * (lib/launch-auth.js).
 *
 * THE STORE is beside the refill loop's files (lib/refill-dir.js): one
 * directory per run, named by its 8-hex job id, holding `run.json`, the
 * stream-json log, stderr and the job dir.
 *
 * LIVE is the recorded pid still running with its recorded start time on this
 * boot (lib/arbiter-proc.js), which rules out a reused pid. A run can emit a
 * `result` per turn while a background task keeps it alive (#2604 (a)), so a
 * `result` never says the run ended; the last one gives its outcome and cost.
 *
 * WFC_CLAUDE_BIN names the `claude` to spawn.
 *
 * dispatch-sessions.sh launches through the CLI, lib/overflow-budget.js
 * settles ended runs through readStoredRuns() and endResultOf(), and
 * lib/agent-liveness.js merges readLiveAgents() into every listing (#2608).
 * Unbuilt caller: the shared stop library routes a headless record to stop()
 * (#2353).
 */

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const {
	readCurrentBootId,
	holderAlive,
	readProcStartOf,
} = require("./arbiter-proc.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { claudeBin } = require("./claude-bin.js");
const { readEnvFileValue, secretsFile } = require("./env-file.js");
const { readJsonl } = require("./jsonl.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const { refillPath } = require("./refill-dir.js");
const { readDeclaredSeats, seatOf } = require("./refill-seats.js");
const { scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");
const { writeFd } = require("./write-fd.js");

const CONTRACT = path.join(__dirname, "headless-contract.md");
/* Untraced: long enough for a session to finish its current write. */
const STOP_GRACE_MS = 10_000;
/* Untraced: short against the grace, long enough not to spin. */
const STOP_POLL_MS = 100;
/* 4 bytes print as the 8 hex characters dispatch-sessions.sh's job-id parse
 * takes from a launch's first line. */
const JOB_ID_BYTES = 4;
const JOB_ID = /^[0-9a-f]{8}$/;
/* Anthropic's refusal once an organisation's credits are spent (#2551). */
const KEY_EXHAUSTED = /credit balance is too low|billing_error/i;

/**
 * @typedef {object} RunRecord
 * @property {string} jobId
 * @property {string} sessionId
 * @property {number} pid
 * @property {string|null} procStart /proc/<pid>/stat's start time
 * @property {string|null} bootId
 * @property {number} pgid
 * @property {string} seat config dir
 * @property {string} cwd
 * @property {string} log stream-json output
 * @property {string} stderr
 * @property {number} launchedAt ms
 *
 * @typedef {{id: string, sessionId: string, pid: number, cwd: string,
 *   startedAt: number, state: "working", kind: "headless"}} HeadlessAgent
 *   shaped as lib/agent-liveness.js's AgentRecord
 *
 * @typedef {object} EndResult
 * @property {"running"|"success"|"error"|"key-exhausted"|"killed"} outcome
 * @property {number|null} costUsd the last `result`'s cumulative cost
 * @property {string} sessionId
 */

const storeDir = () => refillPath(".headless-runs");

/**
 * Why the seat's key cannot be read, or null where it can. Names the variable
 * and the file, never the value.
 * @param {string} keyVar
 * @returns {{file: string}|{why: string}}
 */
function keyCheck(keyVar) {
	const file = secretsFile();
	try {
		if (readEnvFileValue(file, keyVar) !== null) return { file };
		return { why: `${keyVar} is not set in ${file}` };
	} catch (err) {
		return caught(err).code === "ENOENT"
			? { why: `no ${file} to read ${keyVar} from` }
			: {
					why: `cannot read ${file} for ${keyVar}: ${caught(err).message}`,
				};
	}
}

/**
 * A fresh run directory under the store, named by a new job id.
 * @returns {{jobId: string, dir: string}}
 */
function freshRunDir() {
	fs.mkdirSync(storeDir(), { recursive: true });
	for (;;) {
		const jobId = crypto.randomBytes(JOB_ID_BYTES).toString("hex");
		const dir = path.join(storeDir(), jobId);
		try {
			fs.mkdirSync(dir);
			return { jobId, dir };
		} catch (err) {
			if (caught(err).code !== "EEXIST") throw err;
		}
	}
}

/**
 * Launch a headless run on an overflow seat. `resume`, a session id, continues
 * that session with `prompt` as its next turn, as the founder answering one
 * that ended on a question (#3685).
 * @param {{seat: string, cwd: string, budgetUsd: number, prompt: string,
 *   resume?: string}} opts
 * @returns {{record: RunRecord}|{why: string}}
 */
function launch({ seat: seatDir, cwd, budgetUsd, prompt, resume }) {
	const list = readDeclaredSeats();
	if (list.errors.length > 0) return { why: list.errors.join("\n") };
	const seat = seatOf(list, seatDir);
	if (seat.kind !== "overflow")
		return { why: `${seat.dir} is not an overflow seat in the seat file` };
	const key = keyCheck(seat.keyVar);
	if ("why" in key) return key;

	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, CLAUDE_CONFIG_DIR: seat.dir };
	/* The caller's session id would make the child claim to be the caller. */
	delete env.CLAUDE_CODE_SESSION_ID;
	delete env.ANTHROPIC_API_KEY;
	delete env[seat.keyVar];
	const refusal = launchAuthRefusal({
		bin: claudeBin(),
		env,
		cwd,
		overflow: true,
	});
	if (refusal) return { why: refusal };

	const { jobId, dir } = freshRunDir();
	const jobDir = path.join(dir, "job");
	fs.mkdirSync(path.join(jobDir, "tmp"), { recursive: true });
	env.CLAUDE_JOB_DIR = jobDir;
	const log = path.join(dir, "out.jsonl");
	const stderr = path.join(dir, "stderr.log");
	const sessionId = resume ?? crypto.randomUUID();
	const helper = [process.execPath, __filename, "key", seat.keyVar, key.file]
		.map(shellQuote)
		.join(" ");

	const out = fs.openSync(log, "a");
	const err = fs.openSync(stderr, "a");
	const child = spawn(
		claudeBin(),
		[
			"-p",
			resume ? "--resume" : "--session-id",
			sessionId,
			"--output-format",
			"stream-json",
			"--verbose",
			"--max-budget-usd",
			String(budgetUsd),
			"--settings",
			JSON.stringify({ apiKeyHelper: helper }),
			"--append-system-prompt",
			fs.readFileSync(CONTRACT, "utf8"),
			prompt,
		],
		{ cwd, env, detached: true, stdio: ["ignore", out, err] },
	);
	fs.closeSync(out);
	fs.closeSync(err);
	const pid = child.pid;
	if (pid === undefined) {
		fs.rmSync(dir, { recursive: true, force: true });
		return { why: `could not spawn ${claudeBin()}` };
	}
	child.unref();

	/** @type {RunRecord} */
	const record = {
		jobId,
		sessionId,
		pid,
		procStart: readProcStartOf(pid),
		bootId: readCurrentBootId(),
		pgid: pid,
		seat: seat.dir,
		cwd,
		log,
		stderr,
		launchedAt: Date.now(),
	};
	writeFileAtomic(path.join(dir, "run.json"), `${JSON.stringify(record)}\n`);
	return { record };
}

/**
 * Every run in the store; none where the store is absent. A run directory
 * whose record is not yet written, mid-launch, is skipped.
 * @returns {RunRecord[]}
 * @throws where the store or a record cannot be read
 */
function readStoredRuns() {
	let names;
	try {
		names = fs.readdirSync(storeDir());
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		throw err;
	}
	return names.flatMap((name) => runOf(name) ?? []);
}

/** @param {RunRecord} r */
const isLive = (r) =>
	holderAlive({ pid: r.pid, procStart: r.procStart, bootId: r.bootId });

/**
 * The live runs, each as a liveness record.
 * @returns {HeadlessAgent[]}
 * @throws where the store cannot be read
 */
function readLiveAgents() {
	return readStoredRuns()
		.filter(isLive)
		.map((r) => ({
			id: r.jobId,
			sessionId: r.sessionId,
			pid: r.pid,
			cwd: r.cwd,
			startedAt: r.launchedAt,
			state: "working",
			kind: "headless",
		}));
}

/**
 * The job's record; null for a job the store has none for.
 * @param {string} jobId
 * @returns {RunRecord|null}
 * @throws where the record cannot be read
 */
function runOf(jobId) {
	if (!JOB_ID.test(jobId)) return null;
	try {
		return JSON.parse(
			fs.readFileSync(path.join(storeDir(), jobId, "run.json"), "utf8"),
		);
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		throw err;
	}
}

/** @param {number} pgid */
function isGroupAlive(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		return caught(err).code === "EPERM";
	}
}

/**
 * SIGTERM to the run's process group, then SIGKILL to what is left after the
 * grace period.
 * @param {string} jobId
 * @param {{graceMs?: number}} [opts]
 * @returns {Promise<"unknown"|"not running"|"stopped"|"killed">}
 */
async function stop(jobId, { graceMs = STOP_GRACE_MS } = {}) {
	const run = runOf(jobId);
	if (!run) return "unknown";
	/* A background task can outlive its leader in the group (#2604 (a)). A
	 * pgid with members left is never reused, so signalling it is safe. */
	const groupLeft =
		run.bootId === readCurrentBootId() && isGroupAlive(run.pgid);
	if (!isLive(run) && !groupLeft) return "not running";
	process.kill(-run.pgid, "SIGTERM");
	for (const end = Date.now() + graceMs; Date.now() < end; ) {
		if (!isGroupAlive(run.pgid)) return "stopped";
		await new Promise((r) => setTimeout(r, STOP_POLL_MS));
	}
	if (!isGroupAlive(run.pgid)) return "stopped";
	process.kill(-run.pgid, "SIGKILL");
	return "killed";
}

/**
 * How a run ended, or that it is still running.
 * @param {RunRecord} run
 * @returns {EndResult}
 */
function endResultOf(run) {
	const results = (readJsonl(run.log)?.rows ?? []).filter(
		(e) => e.type === "result",
	);
	const last = results.reduce(
		(a, e) =>
			a === null || Number(e.result_index ?? 0) >= Number(a.result_index ?? 0)
				? e
				: a,
		/** @type {Record<string, unknown>|null} */ (null),
	);
	const costUsd =
		typeof last?.total_cost_usd === "number" ? last.total_cost_usd : null;
	const base = { costUsd, sessionId: run.sessionId };
	if (isLive(run)) return { outcome: "running", ...base };
	let stderr = "";
	try {
		stderr = fs.readFileSync(run.stderr, "utf8");
	} catch {
		/* no stderr is no refusal in it (#2607) */
	}
	const failed = last?.is_error
		? `${last.result ?? ""} ${last.error ?? ""}`
		: "";
	if (KEY_EXHAUSTED.test(`${failed} ${stderr}`))
		return { outcome: "key-exhausted", ...base };
	if (!last) return { outcome: "killed", ...base };
	return { outcome: last.is_error ? "error" : "success", ...base };
}

module.exports = {
	endResultOf,
	launch,
	main,
	readLiveAgents,
	runOf,
	stop,
	readStoredRuns,
};

/*
 * CLI mode, for the dispatcher. Exit 0 done, 2 usage, 1 otherwise: a refusal
 * prints `REFUSED:` first, any other fault its message alone.
 *
 *   launch --seat <dir> --cwd <dir> --budget <usd> <prompt>
 *                      first line the job id; second `session <uuid>`
 *   list               the live runs, as a JSON array of liveness records
 *   stop <job id>      `stopped`, `killed`, `not running` or `unknown`
 *   result <job id>    the run's EndResult as JSON
 *   key <var> <file>   the variable's value: the child's apiKeyHelper
 */
const usage = () => {
	writeFd(
		2,
		`usage: node ${scriptPath("lib/headless-sessions.js")} launch --seat <dir> --cwd <dir> --budget <usd> <prompt>\n` +
			"       … list | stop <job id> | result <job id>\n",
	);
	return 2;
};

/** @param {string[]} args */
function launchCommand(args) {
	let parsed;
	try {
		parsed = parseArgs({
			args,
			allowPositionals: true,
			options: {
				seat: { type: "string" },
				cwd: { type: "string" },
				budget: { type: "string" },
			},
		});
	} catch {
		return usage();
	}
	const { seat, cwd, budget } = parsed.values;
	const [prompt, ...extra] = parsed.positionals;
	const budgetUsd = Number(budget);
	if (!seat || !cwd || !(budgetUsd > 0) || !prompt || extra.length > 0)
		return usage();
	const launched = launch({ seat, cwd: path.resolve(cwd), budgetUsd, prompt });
	if ("why" in launched) {
		writeFd(2, `REFUSED: ${launched.why}\n`);
		return 1;
	}
	const { jobId, sessionId } = launched.record;
	writeFd(1, `${jobId}\nsession ${sessionId}\n`);
	return 0;
}

/** @param {string} jobId */
function resultCommand(jobId) {
	const run = runOf(jobId);
	if (!run) {
		writeFd(2, `no headless run ${jobId}\n`);
		return 1;
	}
	writeFd(1, `${JSON.stringify(endResultOf(run))}\n`);
	return 0;
}

/** @param {string} name @param {string} file */
function keyCommand(name, file) {
	const value = readEnvFileValue(file, name);
	if (value === null) return 1;
	writeFd(1, `${value}\n`);
	return 0;
}

/** @param {string[]} argv */
async function main(argv) {
	const [command, ...rest] = argv;
	const [a, b] = rest;
	if (command === "launch") return launchCommand(rest);
	if (command === "list" && rest.length === 0) {
		writeFd(1, `${JSON.stringify(readLiveAgents())}\n`);
		return 0;
	}
	if (command === "stop" && a && rest.length === 1) {
		writeFd(1, `${await stop(a)}\n`);
		return 0;
	}
	if (command === "result" && a && rest.length === 1) return resultCommand(a);
	if (command === "key" && a && b && rest.length === 2) return keyCommand(a, b);
	return usage();
}

if (require.main === module)
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			writeFd(2, `${caught(err).message}\n`);
			process.exitCode = 1;
		},
	);
