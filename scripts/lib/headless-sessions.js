/*
 * headless-sessions.js — launches, lists and stops headless `claude -p` runs
 * on an overflow seat, and reads how each ended (workflow-core#2607, spec workflow-core#2570; workflow-core#4580).
 * A plan's included API credits cover `claude -p`, and not a `claude --bg`
 * job, which is interactive Claude Code (workflow-core#4578).
 *
 * LAUNCH: `claude -p` detached in its own process group, stdin on /dev/null,
 * cwd the target checkout, under the overflow seat's config dir (its plan
 * seat's, workflow-core#3701) and a fresh CLAUDE_JOB_DIR, with headless-contract.md
 * appended to its system prompt, and `--max-budget-usd` and a name where the
 * caller gives them: a resume the refill loop makes of its own run gives no
 * budget, the tick's allowance stop capping it as any overflow run (workflow-core#3698),
 * and a founder's reply is marked so that stop leaves it (workflow-core#4174). The name
 * takes OVERFLOW_PREFIX, so the run's row says it spends API credits; the
 * child is handed that prefix pinned to its session id, which
 * name-issue-session.sh keeps on each rename, and which a session the child
 * starts, under another id, does not take (workflow-core#3701). No `--model`: Opus is the
 * default (mantahostels#1093). `resume` continues a session headless on the
 * same seat and key.
 *
 * THE KEY reaches the child only through lib/overflow-key.js's
 * `apiKeyHelper` in `--settings`, so no Bash call or hook in the session sees
 * it (workflow-core#2604 (b)); the child runs without the variables buildOverflowLaunch
 * names, nor the launcher's root (lib/inherited-roots.js).
 * A key that will not read, or any launch lib/launch-auth.js refuses,
 * refuses the launch by name before anything spawns.
 *
 * THE STORE, liveness, end reading and stop are lib/headless-runs.js's.
 *
 * WFC_CLAUDE_BIN names the `claude` to spawn.
 *
 * dispatch-sessions.sh launches through the CLI.
 */

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { readCurrentBootId, readProcStartOf } = require("./arbiter-proc.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { claudeBin } = require("./claude-bin.js");
const {
	readEndResult,
	freshRunDir,
	readLiveAgents,
	readRun,
	stop,
} = require("./headless-runs.js");
const { forgetRoots } = require("./inherited-roots.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const { buildOverflowLaunch } = require("./overflow-key.js");
const { findOverflowSeat, readDeclaredSeats } = require("./refill-seats.js");
const { scriptPath } = require("./script-path.js");
const { writeFd } = require("./write-fd.js");

const CONTRACT = path.join(__dirname, "headless-contract.md");

const OVERFLOW_PREFIX = "Overflow · ";

/** @param {string} name */
const buildOverflowName = (name) =>
	name.startsWith(OVERFLOW_PREFIX) ? name : `${OVERFLOW_PREFIX}${name}`;

/** @typedef {import("./headless-runs.js").RunRecord} RunRecord */

/**
 * Launch a headless run on an overflow seat. `resume`, a session id, continues
 * that session with `prompt` as its next turn: a parked run the refill loop
 * resumes, or the founder answering one that ended on a question (workflow-core#3685).
 * @param {{keyVar: string, cwd: string, budgetUsd?: number, prompt: string,
 *   resume?: string, name?: string, founderReply?: boolean}} opts
 * @returns {{record: RunRecord}|{why: string}}
 */
function launch({
	keyVar,
	cwd,
	budgetUsd,
	prompt,
	resume,
	name,
	founderReply,
}) {
	const list = readDeclaredSeats();
	if (list.errors.length > 0) return { why: list.errors.join("\n") };
	const seat = findOverflowSeat(list, keyVar);
	if (!seat)
		return { why: `${keyVar} is not an overflow seat's key in the seat file` };
	const built = buildOverflowLaunch(seat.keyVar, {
		...process.env,
		CLAUDE_CONFIG_DIR: seat.dir,
	});
	if ("why" in built) return built;
	const { settings, env } = built;
	forgetRoots(env);
	const bin = claudeBin(env);
	const refusal = launchAuthRefusal({ bin, env, cwd, settings });
	if (refusal) return { why: refusal };

	const { jobId, dir } = freshRunDir();
	const jobDir = path.join(dir, "job");
	fs.mkdirSync(path.join(jobDir, "tmp"), { recursive: true });
	env.CLAUDE_JOB_DIR = jobDir;
	const log = path.join(dir, "out.jsonl");
	const stderr = path.join(dir, "stderr.log");
	const sessionId = resume ?? crypto.randomUUID();
	env.WFC_NAME_PREFIX = OVERFLOW_PREFIX;
	env.WFC_NAME_PREFIX_SESSION = sessionId;

	const out = fs.openSync(log, "a");
	const err = fs.openSync(stderr, "a");
	const child = spawn(
		bin,
		[
			"-p",
			resume ? "--resume" : "--session-id",
			sessionId,
			"--output-format",
			"stream-json",
			"--verbose",
			...(budgetUsd === undefined
				? []
				: ["--max-budget-usd", String(budgetUsd)]),
			"--settings",
			settings,
			...(name === undefined ? [] : ["-n", buildOverflowName(name)]),
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
		return { why: `could not spawn ${bin}` };
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
		keyVar: seat.keyVar,
		cwd,
		prompt,
		log,
		stderr,
		launchedAt: Date.now(),
		...(founderReply ? { founderReply: true } : {}),
	};
	writeFileAtomic(path.join(dir, "run.json"), `${JSON.stringify(record)}\n`);
	return { record };
}

module.exports = { launch, main };

/*
 * CLI mode, for the dispatcher. Exit 0 done, 2 usage, 1 otherwise: a refusal
 * prints `REFUSED:` first, any other fault its message alone.
 *
 *   launch --key <key var> --cwd <dir> --budget <usd> [--name <name>]
 *          [--resume <session id>] <prompt>
 *                      first line the job id; second `session <uuid>`
 *   list               the live runs, as a JSON array of liveness records
 *   stop <job id>      `stopped`, `killed`, `not running` or `unknown`
 *   result <job id>    the run's EndResult as JSON
 */
const usage = () => {
	writeFd(
		2,
		`usage: node ${scriptPath("lib/headless-sessions.js")} launch --key <key var> --cwd <dir> --budget <usd> [--name <name>] [--resume <session id>] <prompt>\n` +
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
				key: { type: "string" },
				cwd: { type: "string" },
				budget: { type: "string" },
				name: { type: "string" },
				resume: { type: "string" },
			},
		});
	} catch {
		return usage();
	}
	const { key, cwd, budget, name, resume } = parsed.values;
	const [prompt, ...extra] = parsed.positionals;
	const budgetUsd = Number(budget);
	if (!key || !cwd || !(budgetUsd > 0) || !prompt || extra.length > 0)
		return usage();
	const launched = launch({
		keyVar: key,
		cwd: path.resolve(cwd),
		budgetUsd,
		prompt,
		...(name === undefined ? {} : { name }),
		...(resume === undefined ? {} : { resume }),
	});
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
	const run = readRun(jobId);
	if (!run) {
		writeFd(2, `no headless run ${jobId}\n`);
		return 1;
	}
	writeFd(1, `${JSON.stringify(readEndResult(run))}\n`);
	return 0;
}

/** @param {string[]} argv */
async function main(argv) {
	const [command, ...rest] = argv;
	const [a] = rest;
	if (command === "launch") return launchCommand(rest);
	if (command === "list" && rest.length === 0) {
		writeFd(1, `${JSON.stringify(readLiveAgents())}\n`);
		return 0;
	}
	if (command === "stop" && a && rest.length === 1) {
		writeFd(1, `${stop(a)}\n`);
		return 0;
	}
	if (command === "result" && a && rest.length === 1) return resultCommand(a);
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
