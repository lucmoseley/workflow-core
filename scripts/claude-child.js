#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { scriptPath } = require("./lib/script-path.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { now } = require("./lib/clock.js");

const stamp = () => new Date(now()).toISOString();
const { ownIdentity, readProcStartOf } = require("./lib/arbiter-proc.js");
const { CHROME_TIMEOUT_MS_A_PAGE } = require("./lib/child-spawn.js");
const {
	CLOSE_PROMPT,
	TRIM_PROMPT,
	chromeOutcome,
	chromeStandingLines,
	createTabTally,
} = require("./lib/chrome-child.js");
const {
	UUID,
	deleteRecord,
	readRecord,
	writeRecord,
} = require("./lib/chrome-child-store.js");
const {
	closeCaps,
	closeSession,
	listHeld,
	sweep,
} = require("./lib/chrome-close.js");
const { STREAM_ARGS, startStreamChild } = require("./lib/chrome-stream.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { configDirs } = require("./lib/arbiter-store.js");
const { JUDGE_ARGS, JUDGE_TIMEOUT_EXIT } = require("./lib/gate-judge-mode.js");
const { buildSeatEnv } = require("./lib/seat-claude.js");
const { realKey } = require("./lib/deref.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { spawnOutliving } = require("./lib/user-scope.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = [
	`usage: node ${scriptPath("claude-child.js")} usage --config-dir <dir>`,
	`       node ${scriptPath("claude-child.js")} chrome --config-dir <dir> --pages <1-6> --prompt-file <f> [--hand-over]`,
	`       node ${scriptPath("claude-child.js")} chrome-close (--session <uuid> [--trap] | --sweep | --held)`,
	`       node ${scriptPath("claude-child.js")} judge --config-dir <dir> --timeout-ms <n> < prompt`,
].join("\n");

// #1070 guess
const USAGE_TIMEOUT_MS = 60_000;
const MAX_PAGES = 6;
/** @param {number} pages */
const maxTurns = (pages) => 10 * pages + 5;

/**
 * @param {string} message
 * @param {1 | 2 | typeof JUDGE_TIMEOUT_EXIT} code
 * @returns {never}
 */
function fail(message, code) {
	writeFd(2, `claude-child: ${message}\n`);
	process.exit(code);
}

/** @param {string} seat */
const isSeat = (seat) => configDirs().some((s) => realKey(s) === realKey(seat));

/** @param {string | true | undefined} given */
function seatOrFail(given) {
	if (typeof given !== "string" || given === "")
		fail(`--config-dir is required.\n${USAGE}`, 2);
	if (!isSeat(given))
		fail(
			`--config-dir '${given}' is not one of this machine's seats: ${configDirs().join(", ")}.`,
			2,
		);
	return given;
}

/** @param {string | true | undefined} given */
function pagesOrFail(given) {
	const pages = Number(given);
	if (typeof given !== "string" || !/^\d+$/.test(given) || pages < 1)
		fail(`--pages is a whole number from 1 to ${MAX_PAGES}.`, 2);
	if (pages > MAX_PAGES)
		fail(
			`--pages is at most ${MAX_PAGES} a child; split the task over several children.`,
			2,
		);
	return pages;
}

/** @param {string | true | undefined} given */
function promptOrFail(given) {
	if (typeof given !== "string" || given === "")
		fail(`--prompt-file is required.\n${USAGE}`, 2);
	try {
		return fs.readFileSync(given, "utf8");
	} catch (e) {
		return fail(
			`could not read the prompt file ${given} (${caught(e).message}).`,
			2,
		);
	}
}

/**
 * @param {string} name
 * @returns {string}
 */
function emptyDir(name) {
	let dir = os.tmpdir();
	try {
		const { username, uid } = os.userInfo();
		dir = path.join(dir, `wfc-${name}-${username}`);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || stat.uid !== uid)
			throw new Error("it is not this user's own directory");
		for (const entry of fs.readdirSync(dir))
			fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
	} catch (e) {
		throw new Error(
			`the child's working directory ${dir} could not be made empty (${caught(e).message}).`,
			{ cause: e },
		);
	}
	return dir;
}

/** @param {string | true | undefined} given */
function timeoutOrFail(given) {
	const ms = Number(given);
	if (typeof given !== "string" || !/^\d+$/.test(given) || ms < 1)
		fail("--timeout-ms is a whole number of milliseconds, 1 or more.", 2);
	return ms;
}

/**
 * @param {string} sessionId
 */
function startTrapCloser(sessionId) {
	spawnOutliving(
		process.execPath,
		[__filename, "chrome-close", "--session", sessionId, "--trap"],
		{ stdio: "ignore" },
	).unref();
}

/** @typedef {import("./lib/chrome-child-store.js").ChildRecord} ChildRecord */

/**
 * @param {string} sessionId
 * @param {string} seat
 * @returns {ChildRecord}
 */
function firstRecord(sessionId, seat) {
	const record = {
		sessionId,
		seat,
		launcherPid: process.pid,
		launcherStart: ownIdentity().procStart,
		childPid: null,
		childStart: null,
		startedAt: stamp(),
		attempts: 0,
	};
	writeRecord(record);
	return record;
}

/**
 * @param {ChildRecord} record
 * @param {number} pid
 * @param {string[]} said
 */
function recordChild(record, pid, said) {
	record.childPid = pid;
	record.childStart = readProcStartOf(pid);
	try {
		writeRecord(record);
	} catch (e) {
		said.push(
			`could not write the child's pid to its record (${caught(e).message}).`,
		);
	}
}

/**
 * @param {{bin: string, args: string[], env: NodeJS.ProcessEnv, seat: string,
 *   prompt: string, limitMs: number, handOver: boolean}} launch
 */
async function runChrome({ bin, args, env, seat, prompt, limitMs, handOver }) {
	const sessionId = crypto.randomUUID();
	/** @type {Record<string, unknown> | undefined} */
	let result;
	/** @type {string[]} */
	const said = [];
	let printed = false;
	/** @param {Partial<Parameters<typeof chromeOutcome>[0]>} over */
	const print = (over) => {
		if (printed) return;
		printed = true;
		const out = chromeOutcome({
			sessionId,
			result,
			left: [],
			held: [],
			status: null,
			signal: null,
			stopped: false,
			limitMs: undefined,
			killedBy: undefined,
			failed: undefined,
			said,
			closeCommand: `node ${scriptPath("claude-child.js")} chrome-close --session ${sessionId}`,
			...over,
		});
		writeFd(2, out.stderr);
		writeFd(1, out.stdout);
		process.exitCode = out.exit;
	};
	/** @type {(failed: string) => never} */
	const failWith = (failed) => {
		print({ failed });
		process.exit();
	};
	/** @type {ChildRecord} */
	let record;
	try {
		record = firstRecord(sessionId, seat);
	} catch (e) {
		failWith(`could not write the child's record (${caught(e).message}).`);
	}
	const tally = createTabTally();
	const run = startStreamChild(
		bin,
		[...args, "--session-id", sessionId],
		{ env },
		(row) => tally.read(row),
	);
	run.child.on("error", (e) => {
		deleteRecord(sessionId);
		failWith(`the child did not finish (${e.message}).`);
	});
	if (run.child.pid) recordChild(record, run.child.pid, said);

	/**
	 * @param {Partial<import("./lib/chrome-child-store.js").ChildRecord>} [over]
	 */
	const keep = (over = {}) => {
		const tabs = tally.left();
		try {
			writeRecord({ ...(readRecord(sessionId) ?? record), tabs, ...over });
		} catch (e) {
			// #5386
			said.push(`could not update the child's record (${caught(e).message}).`);
		}
		return tabs;
	};

	trapSignals(
		() => {
			run.signalGroup("SIGTERM");
			return keep();
		},
		sessionId,
		said,
		print,
	);

	run.send(prompt);
	const first = await run.turn({
		capMs: limitMs,
		graceMs: closeCaps().graceMs,
	});
	const limited = first.capped ? limitMs : undefined;
	result = first.result;
	if (!result) {
		const end = await stopOrWait(run);
		// #5352
		const left = keep();
		if (left.length === 0 && end.status === 0 && !end.signal)
			deleteRecord(sessionId);
		return print({ ...end, left, limitMs: limited });
	}

	let left = tally.left();
	if (left.length > 0 && !run.gone && !(handOver && left.length === 1)) {
		run.send(handOver ? TRIM_PROMPT : CLOSE_PROMPT);
		await run.turn(closeCaps());
		left = tally.left();
	}

	if (left.length === 0) {
		const [status, signal] = await run.finish();
		deleteRecord(sessionId);
		return print({ status, signal, limitMs: limited });
	}
	const end = await stopOrWait(run);
	if (!handOver) {
		keep();
		return print({ ...end, left, limitMs: limited });
	}
	const heldTab = left.at(-1);
	keep({
		heldSince: stamp(),
		...(heldTab ? { heldTab } : {}),
	});
	return print({ ...end, held: left, limitMs: limited });
}

/**
 * @param {() => import("./lib/chrome-child.js").OpenTab[]} stop
 * @param {string} sessionId
 * @param {string[]} said
 * @param {(over: {left: import("./lib/chrome-child.js").OpenTab[], killedBy: NodeJS.Signals}) => void} print
 */
function trapSignals(stop, sessionId, said, print) {
	for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
		process.on(signal, () => {
			const left = stop();
			try {
				startTrapCloser(sessionId);
			} catch (e) {
				// #5386
				said.push(
					`no closer started (${caught(e).message}); the next session-start sweep closes the tabs.`,
				);
			}
			print({ left, killedBy: signal });
			process.exit(1);
		});
}

/**
 * @param {ReturnType<typeof startStreamChild>} run
 */
async function stopOrWait(run) {
	const stopped = !run.gone;
	const [status, signal] = stopped ? await run.stop() : await run.exited;
	return { stopped, status, signal };
}

/**
 * @param {string} seat
 * @param {string} cwd
 * @returns {import("./lib/chrome-close.js").Launch | string}
 */
function seatLaunch(seat, cwd) {
	const env = buildSeatEnv(process.env, seat);
	const bin = claudeBin(env);
	return launchAuthRefusal({ bin, env, cwd, bg: false }) ?? { bin, env, cwd };
}

/**
 * @param {string} seat
 * @returns {import("./lib/chrome-close.js").Launch | string}
 */
function launchFor(seat) {
	if (!isSeat(seat))
		return `the record's seat ${seat} is not one of this machine's seats`;
	let cwd;
	try {
		cwd = emptyDir("chrome-close");
	} catch (e) {
		return caught(e).message;
	}
	return seatLaunch(seat, cwd);
}

/** @param {Record<string, string | true>} flags */
async function runChromeClose(flags) {
	if (flags["--config-dir"] !== undefined)
		fail("chrome-close takes no --config-dir: a record names its seat.", 2);
	const session = flags["--session"];
	const forms = [session, flags["--sweep"], flags["--held"]];
	if (forms.filter((f) => f !== undefined).length !== 1)
		fail(
			`chrome-close takes one of --session, --sweep or --held.\n${USAGE}`,
			2,
		);
	if (flags["--trap"] && session === undefined)
		fail("--trap goes with --session.", 2);
	let end;
	if (session !== undefined) {
		if (typeof session !== "string" || !UUID.test(session))
			fail(`--session '${session}' is not a session id.`, 2);
		end = await closeSession(session, {
			trap: flags["--trap"] === true,
			launchFor,
		});
	} else if (flags["--sweep"]) end = await sweep({ launchFor });
	else end = listHeld();
	writeFd(1, `${JSON.stringify(end.line)}\n`);
	process.exitCode = end.exit;
}

/**
 * @param {string} seat
 * @param {Record<string, string | true>} flags
 */
function launchChrome(seat, flags) {
	const pages = pagesOrFail(flags["--pages"]);
	const handOver = flags["--hand-over"] === true;
	const prompt = promptOrFail(flags["--prompt-file"]);
	const launch = seatLaunch(seat, process.cwd());
	if (typeof launch === "string") return fail(launch, 2);
	const { bin, env } = launch;
	return runChrome({
		bin,
		args: [
			"-p",
			"--chrome",
			"--tools",
			"",
			"--allowedTools",
			"mcp__claude-in-chrome__*",
			"--disallowedTools",
			"mcp__claude-in-chrome__file_upload",
			"--max-turns",
			String(maxTurns(pages)),
			...STREAM_ARGS,
			"--append-system-prompt",
			chromeStandingLines(handOver),
		],
		env,
		seat,
		prompt,
		limitMs:
			Number(process.env.WFC_CHROME_CHILD_LIMIT_MS) ||
			CHROME_TIMEOUT_MS_A_PAGE * pages,
		handOver,
	});
}

async function main() {
	const startedAt = Date.now();
	const { command, flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--config-dir": "value" },
		commands: {
			usage: { usage: USAGE },
			chrome: {
				usage: USAGE,
				flags: {
					"--pages": "value",
					"--prompt-file": "value",
					"--hand-over": "boolean",
				},
			},
			"chrome-close": {
				usage: USAGE,
				flags: {
					"--session": "value",
					"--trap": "boolean",
					"--sweep": "boolean",
					"--held": "boolean",
				},
			},
			judge: { usage: USAGE, flags: { "--timeout-ms": "value" } },
		},
	});
	if (command === "chrome-close") return runChromeClose(flags);
	const seat = seatOrFail(flags["--config-dir"]);

	/** @type {string[]} */
	let args;
	/** @type {import("node:child_process").SpawnSyncOptions} */
	let opts = {};
	/** @type {number | undefined} */
	let boundMs;
	if (command === "judge") {
		boundMs = timeoutOrFail(flags["--timeout-ms"]);
		args = JUDGE_ARGS;
		let cwd;
		try {
			cwd = emptyDir("gate-judge");
		} catch (e) {
			return fail(caught(e).message, 2);
		}
		opts = { stdio: "inherit", cwd, killSignal: "SIGKILL" };
	} else if (command === "usage") {
		args = ["-p", "/usage", "--permission-mode", "manual"];
		opts = {
			stdio: ["ignore", "inherit", "inherit"],
			timeout: USAGE_TIMEOUT_MS,
		};
	} else return launchChrome(seat, flags);

	const cached =
		command === "usage"
			? ` Read the cached bars instead: node ${scriptPath("allowance.js")} --config-dir ${seat}`
			: "";
	const launch = seatLaunch(
		seat,
		typeof opts.cwd === "string" ? opts.cwd : process.cwd(),
	);
	if (typeof launch === "string") return fail(`${launch}${cached}`, 2);
	const { bin, env } = launch;
	if (boundMs !== undefined)
		opts.timeout = Math.max(1, boundMs - (Date.now() - startedAt));
	const r = spawnSync(bin, args, { ...opts, env });
	if (
		boundMs !== undefined &&
		r.error &&
		"code" in r.error &&
		r.error.code === "ETIMEDOUT"
	)
		fail(
			`the child was killed at its ${boundMs} ms bound.`,
			JUDGE_TIMEOUT_EXIT,
		);
	if (r.error)
		fail(`the child did not finish (${r.error.message}).${cached}`, 1);
	if (r.signal) fail(`the child was killed by ${r.signal}.`, 1);
	process.exitCode = r.status ?? 1;
}

main().catch((e) => fail(caught(e).message, 1));
