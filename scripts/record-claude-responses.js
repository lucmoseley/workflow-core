#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseResumed } = require("./lib/bg-resume.js");
const { caught } = require("./lib/caught.js");
const {
	ATTACH_TIMEOUT_MS,
	buildTypedAttach,
} = require("./lib/claude-attach.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { NO_JOB_ANSWER } = require("./lib/claude-stop.js");
const { configDir } = require("./lib/config-dir.js");
const { readText } = require("./lib/file-read.js");
const { sessionTree } = require("./lib/host-root.js");
const { jobDirPath, readJobRecord } = require("./lib/job-paths.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const {
	ASK,
	PERMISSION_ASK,
	PROMPT,
	SCRIPTED_PROMPT,
} = require("./lib/recorder-prompts.js");
const { carrySessionBar } = require("./lib/session-bar-carry.js");
const {
	PROBE_ARGV,
	PROBE_CWD,
	PROBE_TIMEOUT_MS,
} = require("./lib/usage-probe.js");
const { writeFd } = require("./lib/write-fd.js");

const RESUME_FIXTURE = path.join(__dirname, "fixtures", "bg-resume.json");
const AGENTS_STOP_FIXTURE = path.join(
	__dirname,
	"fixtures",
	"agents-stop.json",
);
const LAUNCH_FIXTURE = path.join(__dirname, "fixtures", "bg-launch.json");
const ATTACH_FIXTURE = path.join(__dirname, "fixtures", "claude-attach.json");
const USAGE_FIXTURE = path.join(__dirname, "fixtures", "usage-probe.json");
const RECORDED_BY = "node scripts/record-claude-responses.js";
const NO_JOB = "00000000";
// #2968 measured ~25 s a Haiku turn
const WAIT_MS = 180_000;
// #2968 guess
const POLL_MS = 1000;

/**
 * @param {string[]} args
 * @param {number} [timeout]
 */
function claude(args, timeout) {
	const r = spawnSync(claudeBin(), args, { encoding: "utf8", timeout });
	if (r.error) throw r.error;
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** @typedef {{sessionId: string, state: string} & Record<string, unknown>} Row */

const SYNTHETIC = {
	id: "5e55101d",
	sessionId: "5e55101d-0000-4000-8000-000000000000",
	cwd: "/repo",
	name: "a recorded session",
	pid: 4242,
	startedAt: 1_700_000_000_000,
	copyId: "5e55c0b1",
	removedId: "5e55de1e",
	idleId: "5e551d1e",
	namedId: "5e55a3ed",
	positionalId: "5e55b05e",
};

/** @param {Row} row */
const shapeOf = (row) =>
	`${row.state}/${row.status}/${Object.keys(row).sort().join()}`;

/** @type {Map<string, Row>} */
const shapes = new Map();

/**
 * @param {string} id
 * @param {string} kept
 * @returns {Row|undefined}
 */
function listRowKeepingShape(id, kept) {
	const agents = claude(["agents", "--json"]);
	if (agents.status !== 0)
		throw new Error(`claude agents failed: ${agents.stderr}`);
	const row = JSON.parse(agents.stdout).find(
		(/** @type {{id: string}} */ a) => a.id === id,
	);
	if (row?.id === kept) {
		shapes.set(shapeOf(row), row);
	}
	return row;
}

/** @param {Row} row */
function synthetic(row) {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => {
			if (!(key in SYNTHETIC)) return [key, value];
			const stand = SYNTHETIC[/** @type {keyof typeof SYNTHETIC} */ (key)];
			if (typeof stand !== typeof value)
				throw new Error(`the listing's ${key} is a ${typeof value} now`);
			return [key, stand];
		}),
	);
}

/**
 * @param {string} id
 * @param {string} kept
 * @param {(row: Row|undefined) => boolean} done
 * @param {string} fails
 * @returns {Promise<Row|undefined>}
 */
const until = (id, kept, done, fails) =>
	pollUntil(() => listRowKeepingShape(id, kept), done, `job ${id} ${fails}`);

/**
 * @template T
 * @param {() => T} probe
 * @param {(answer: T) => boolean} done
 * @param {string} fails
 * @returns {Promise<T>}
 */
async function pollUntil(probe, done, fails) {
	const by = Date.now() + WAIT_MS;
	while (Date.now() < by) {
		const answer = probe();
		if (done(answer)) return answer;
		await new Promise((wake) => setTimeout(wake, POLL_MS));
	}
	throw new Error(`${fails} after ${WAIT_MS} ms`);
}

/**
 * @param {string} id
 * @param {string} kept
 */
const settled = (id, kept) =>
	until(id, kept, (row) => row?.state !== "working", "still working");

/**
 * @param {string} id
 * @param {(state: string) => boolean} done
 * @param {string} fails
 * @returns {Promise<Row>}
 */
const untilState = async (id, done, fails) =>
	/** @type {Row} */ (
		await until(id, id, (row) => row !== undefined && done(row.state), fails)
	);

const IDLE_NAME = "a-recorded-launch";
const OWN_ID_NAME = "a-recorded-resume";

const NAMED_NAME = "Overflow · a-recorded-launch";

/**
 * @param {string} sessionId
 * @param {string} original
 */
async function resumeRemoved(sessionId, original) {
	await untilRecord(
		original,
		(rec) => rec?.state !== "working",
		"still working",
	);
	for (const cmd of ["stop", "rm"]) {
		const r = claude([cmd, original]);
		if (r.status !== 0)
			throw new Error(`could not ${cmd} ${original}: ${r.stderr.trim()}`);
	}
	const r = resume(sessionId, original, false, [
		"--name",
		OWN_ID_NAME,
		"--model",
		"haiku",
	]);
	await untilRecord(
		original,
		(rec) => rec?.name === OWN_ID_NAME,
		`never took the name ${OWN_ID_NAME}`,
	);
	return r;
}

/**
 * @param {string} id
 * @param {(rec: {state?: unknown, name?: unknown}|null) => boolean} done
 * @param {string} fails
 */
const untilRecord = (id, done, fails) =>
	pollUntil(() => readJobRecord(configDir(), id), done, `job ${id} ${fails}`);

/**
 * @param {string} prompt
 * @param {string[]} [flags]
 */
const launch = (prompt, flags = []) =>
	launchArgv(["--bg", "--model", "haiku", ...flags, "--", prompt]);

/**
 * @param {ReturnType<typeof launchArgv>} launched
 * @param {string} id
 */
const syntheticLaunch = (launched, id) => ({
	argv: launched.argv,
	id,
	status: launched.status,
	stdout: launched.stdout.replaceAll(launched.id, id),
	stderr: launched.stderr.replaceAll(launched.id, id),
});

/** @param {string[]} argv */
function launchArgv(argv) {
	const launched = claude(argv);
	const id = /backgrounded · ([\w-]+)/.exec(launched.stdout)?.[1];
	if (launched.status !== 0 || !id)
		throw new Error(
			`the launch named no job (exit ${launched.status}): ${launched.stdout}${launched.stderr}`,
		);
	return { id, argv, ...launched };
}

/**
 * @param {string} sessionId
 * @param {string} original
 * @param {boolean} copy
 * @param {string[]} [flags]
 */
function resume(sessionId, original, copy, flags = []) {
	const r = claude(["--bg", "--resume", sessionId, ...flags, SCRIPTED_PROMPT]);
	const started = parseResumed(r);
	if (r.status !== 0 || !started)
		throw new Error(
			`the resume of ${original} named no job (exit ${r.status}): ${r.stdout}${r.stderr}`,
		);
	if (started.copy !== copy || (started.jobId === original) === copy)
		throw new Error(
			`the resume of ${original} ${copy ? "woke it" : "started a copy"}: ${r.stdout}${r.stderr}`,
		);
	return {
		resumed: original,
		stdout: r.stdout,
		stderr: r.stderr,
		startedAs: started.jobId,
	};
}

/** @param {string} id */
function attachExits(id) {
	const offTerminal = claude(["attach", id], ATTACH_TIMEOUT_MS);
	const [file, args, opts] = buildTypedAttach(id, SCRIPTED_PROMPT);
	const onTerminal = spawnSync(file, args, { ...opts, encoding: "utf8" });
	if (onTerminal.error) throw onTerminal.error;
	return {
		offTerminal: { status: offTerminal.status },
		onTerminal: { status: onTerminal.status },
	};
}

/** @param {string[]} ids */
function stopAll(ids) {
	const failed = [];
	for (const id of ids) {
		const r = claude(["stop", id]);
		if (r.status !== 0) failed.push(`${id}: ${r.stderr.trim()}`);
	}
	return failed;
}

/** @param {Row[]} rows */
function lostShapes(rows) {
	const now = new Set(rows.map(shapeOf));
	try {
		const before = JSON.parse(fs.readFileSync(AGENTS_STOP_FIXTURE, "utf8"));
		return [...new Set(before.rows.map(shapeOf))].filter((s) => !now.has(s));
	} catch (e) {
		const c = caught(e);
		if (c.code !== "ENOENT")
			writeFd(
				2,
				`could not read ${AGENTS_STOP_FIXTURE} for its shapes: ${c.message}\n`,
			);
		return [];
	}
}

const USAGE_REFRESH_AGE_MS = 120_000;
const USAGE_KINDS = ["session", "weekly_all", "weekly_scoped"];
const SYNTHETIC_USAGE = {
	accountUuid: "5e55acc0-0000-4000-8000-000000000000",
	fetchedAtMs: 1_700_000_000_000,
};

/** @param {string} seat */
function readUsageCacheOf(seat) {
	const cache = JSON.parse(
		fs.readFileSync(path.join(seat, ".claude.json"), "utf8"),
	).cachedUsageUtilization;
	if (typeof cache?.fetchedAtMs !== "number")
		throw new Error(`${seat}/.claude.json holds no stamped usage cache`);
	return cache;
}

async function recordUsage() {
	const seat = configDir();
	for (
		let ageMs = Date.now() - readUsageCacheOf(seat).fetchedAtMs;
		ageMs < USAGE_REFRESH_AGE_MS;
		ageMs = Date.now() - readUsageCacheOf(seat).fetchedAtMs
	)
		await new Promise((done) => setTimeout(done, USAGE_REFRESH_AGE_MS - ageMs));
	const startMs = Date.now();
	const r = spawnSync(claudeBin(), PROBE_ARGV, {
		cwd: PROBE_CWD,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: PROBE_TIMEOUT_MS,
	});
	if (r.error) throw r.error;
	if (r.status !== 0)
		throw new Error(`claude -p /usage exited ${r.status}: ${r.stderr.trim()}`);
	const cache = readUsageCacheOf(seat);
	if (!(cache.fetchedAtMs > startMs))
		throw new Error(`claude -p /usage left ${seat}'s cache stamp unmoved`);
	return {
		refreshedAfterMs: cache.fetchedAtMs - startMs,
		printed: r.stdout.split("\n").filter((l) => l.startsWith("Current ")),
		cache: {
			...cache,
			...SYNTHETIC_USAGE,
			utilization: {
				limits: cache.utilization.limits.filter(
					(/** @type {{kind: string}} */ l) => USAGE_KINDS.includes(l.kind),
				),
			},
		},
	};
}

function previousRecording() {
	const read = readText(USAGE_FIXTURE);
	if (read.state === "absent") return null;
	if (read.state === "unreadable") throw read.error;
	return JSON.parse(read.data);
}

/**
 * @param {string} file
 * @param {object} recorded
 */
function writeFixture(file, recorded) {
	fs.writeFileSync(file, `${JSON.stringify(recorded, null, "\t")}\n`);
	writeFd(1, `recorded ${file}\n`);
}

function launchCwd() {
	const tree = sessionTree({ cwd: process.cwd() });
	if (tree === null || mainCheckout(tree) === tree)
		throw new Error(
			"run it from a session worktree: guard-main-checkout-job.js relaunches a job started in the main checkout (#4340)",
		);
	return tree;
}

async function main() {
	process.chdir(launchCwd());
	const refusal = launchAuthRefusal({
		bin: claudeBin(),
		env: process.env,
		cwd: process.cwd(),
		bg: true,
	});
	if (refusal) throw new Error(refusal);
	const harness = claude(["--version"]).stdout.split(" ")[0];
	if (!harness) throw new Error("claude --version printed no version");
	const launched = launch(PROMPT);
	const original = launched.id;
	const started = [original];
	try {
		const working = await untilState(original, () => true, "never listed");
		const copy = resume(working.sessionId, original, true);
		started.push(copy.startedAs);
		await settled(original, original);
		await settled(copy.startedAs, original);
		const stopped = claude(["stop", original]);
		if (stopped.status !== 0)
			throw new Error(`could not stop ${original}: ${stopped.stderr.trim()}`);
		const noJob = claude(["stop", NO_JOB]);
		const woke = resume(working.sessionId, original, false);
		await settled(woke.startedAs, original);
		const stoppedAgain = claude(["stop", original]);
		if (stoppedAgain.status !== 0)
			throw new Error(
				`could not stop ${original}: ${stoppedAgain.stderr.trim()}`,
			);
		fs.rmSync(jobDirPath(configDir(), original), { recursive: true });
		const continued = resume(working.sessionId, original, false);
		await settled(continued.startedAs, original);
		const ownId = await resumeRemoved(working.sessionId, original);
		await settled(ownId.startedAs, original);
		const asker = launch(ASK).id;
		started.push(asker);
		await untilState(asker, (state) => state === "blocked", "never blocked");
		const permissionJob = launch(PERMISSION_ASK, [
			"--permission-mode",
			"manual",
		]).id;
		started.push(permissionJob);
		await until(
			permissionJob,
			permissionJob,
			(row) => row?.status === "waiting",
			"never waited on a prompt",
		);
		const attached = attachExits(asker);
		const rows = [...shapes.values()];
		for (const state of ["working", "done", "blocked"])
			if (!rows.some((r) => r.state === state))
				throw new Error(
					`the listing never showed ${started.join(" or ")} ${state}`,
				);
		if (!rows.some((r) => r.waitingFor))
			throw new Error(`the listing never showed ${permissionJob} waitingFor`);
		const idle = launchArgv(["--bg", "--agent", "claude", "--name", IDLE_NAME]);
		started.push(idle.id);
		const idleRemoved = claude(["rm", idle.id]);
		if (idleRemoved.status !== 0)
			throw new Error(
				`could not remove ${idle.id}: ${idleRemoved.stderr.trim()}`,
			);
		const positional = launchArgv(["--bg", "--model", "haiku", PROMPT]);
		started.push(positional.id);
		const named = launchArgv([
			"--bg",
			"--model",
			"haiku",
			"-n",
			NAMED_NAME,
			PROMPT,
		]);
		started.push(named.id);
		const removed = claude(["rm", permissionJob]);
		if (removed.status !== 0)
			throw new Error(
				`could not remove ${permissionJob}: ${removed.stderr.trim()}`,
			);
		await until(
			permissionJob,
			original,
			(row) => row === undefined,
			"still listed after its removal",
		);
		const noRemoval = claude(["rm", NO_JOB]);
		const lost = lostShapes(rows);
		if (lost.length > 0)
			writeFd(
				2,
				`the listing showed none of these recorded shapes this run: ${lost.join("; ")}\n`,
			);
		const syntheticText = (/** @type {string} */ text) =>
			text
				.replaceAll(copy.startedAs, SYNTHETIC.copyId)
				.replaceAll(original, SYNTHETIC.id)
				.replaceAll(permissionJob, SYNTHETIC.removedId)
				.replace(/^(backgrounded · \S+) · .+$/m, `$1 · ${SYNTHETIC.name}`);
		const syntheticResponse = (/** @type {typeof copy} */ r) => ({
			resumed: SYNTHETIC.id,
			stdout: syntheticText(r.stdout),
			stderr: syntheticText(r.stderr),
			startedAs: syntheticText(r.startedAs),
		});
		writeFixture(RESUME_FIXTURE, {
			recordedBy: RECORDED_BY,
			harness,
			responses: {
				copy: syntheticResponse(copy),
				woke: syntheticResponse(woke),
				continued: syntheticResponse(continued),
				ownId: syntheticResponse(ownId),
			},
		});
		writeFixture(LAUNCH_FIXTURE, {
			recordedBy: RECORDED_BY,
			harness,
			launches: {
				prompted: {
					argv: launched.argv,
					id: SYNTHETIC.id,
					status: launched.status,
					stdout: syntheticText(launched.stdout),
					stderr: syntheticText(launched.stderr),
				},
				idle: syntheticLaunch(idle, SYNTHETIC.idleId),
				positional: syntheticLaunch(positional, SYNTHETIC.positionalId),
				named: syntheticLaunch(named, SYNTHETIC.namedId),
			},
			removals: {
				ok: {
					id: SYNTHETIC.removedId,
					status: removed.status,
					stdout: syntheticText(removed.stdout),
					stderr: syntheticText(removed.stderr),
				},
				noJob: { id: NO_JOB, ...noRemoval },
			},
		});
		writeFixture(ATTACH_FIXTURE, {
			recordedBy: RECORDED_BY,
			harness,
			responses: attached,
		});
		writeFixture(AGENTS_STOP_FIXTURE, {
			recordedBy: RECORDED_BY,
			harness,
			rows: rows.map(synthetic),
			stops: {
				ok: {
					id: SYNTHETIC.id,
					status: stopped.status,
					stdout: syntheticText(stopped.stdout),
					stderr: syntheticText(stopped.stderr),
				},
				noJob: { id: NO_JOB, ...noJob },
			},
		});
	} finally {
		const unstopped = stopAll(started).filter(
			(why) => !NO_JOB_ANSWER.test(why),
		);
		if (unstopped.length > 0)
			writeFd(2, `still running, stop by hand: ${unstopped.join("; ")}\n`);
	}
	const usage = carrySessionBar(
		{ recordedBy: RECORDED_BY, harness, ...(await recordUsage()) },
		previousRecording(),
	);
	if (usage.sessionBar)
		writeFd(
			2,
			`the seat listed no session bar: kept ${usage.sessionBar.harness}'s, which this harness's shape goes unchecked against\n`,
		);
	writeFixture(USAGE_FIXTURE, usage);
}

main().catch((e) => {
	writeFd(2, `${caught(e).message}\n`);
	process.exit(1);
});
