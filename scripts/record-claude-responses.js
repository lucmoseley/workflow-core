#!/usr/bin/env node
/*
 * record-claude-responses.js — re-records the installed launcher's responses
 * the refill loop reads, as fixtures:
 *   - scripts/fixtures/bg-resume.json: the two `claude --bg --resume <session
 *     id> "<prompt>"` responses lib/bg-resume.js parses (#2968), of a job
 *     still running, which starts a copy, and of a stopped one, which wakes
 *     in place;
 *   - scripts/fixtures/agents-stop.json: the job's `claude agents --json` rows
 *     as it works, once settled, while a second job waits on its question
 *     (#3005) and while a third waits on a permission prompt (#3008), which
 *     lib/agent-liveness.js and lib/block-cause.js read, and
 *     `claude stop`'s answers to that job and to an id no daemon holds, which
 *     lib/claude-stop.js reads (#2988);
 *   - scripts/fixtures/claude-attach.json: `claude attach`'s exit off a
 *     terminal, and pty_type.py's, which the refill loop's typed resume
 *     reads, typing at it on one (#3014), both at the job waiting on its
 *     question;
 *   - scripts/fixtures/usage-probe.json: the bar lines `claude -p "/usage"`
 *     prints and the seat cache it rewrites, which lib/usage-probe.js,
 *     lib/allowance.js and lib/seat-utilisation.js read (#3266, #3282), off one
 *     probe of this session's seat run as lib/usage-probe.js runs it, to its
 *     end.
 *
 * Run it by hand after a harness upgrade, then `npm run test --
 * scripts/lib/bg-resume.contract.test.ts scripts/lib/agents-stop.contract.test.ts
 * scripts/lib/claude-attach.contract.test.ts
 * scripts/lib/usage-probe.contract.test.ts`.
 * It launches one throwaway Haiku session in the repo root and resumes it
 * while it works, then again once stopped, launches a second told to ask one
 * question and a third told to run one command it must ask leave for, and
 * stops every job it started, so it spends up to six short turns. The command never
 * runs: the prompt is never answered. The `/usage` probe spends no turn, but
 * first waits up to two minutes for the seat's cache to age into a refresh.
 *
 * In no family (§N3): it writes a fixture, but makes live sessions to do it,
 * so it is no `generate-*` a gate may run.
 */

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
const { configDir } = require("./lib/config-dir.js");
const { hostRoot } = require("./lib/host-root.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
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
const ATTACH_FIXTURE = path.join(__dirname, "fixtures", "claude-attach.json");
const USAGE_FIXTURE = path.join(__dirname, "fixtures", "usage-probe.json");
const RECORDED_BY = "node scripts/record-claude-responses.js";
/* An 8-hex job id no daemon issued, for `claude stop`'s "No job matching". */
const NO_JOB = "00000000";
const PROMPT = "Reply with the single word ok. Use no tools.";
const ASK =
	"Ask me one question, whether I prefer red or blue, with the AskUserQuestion tool. Use no other tool.";
/* Under `--permission-mode manual` a Bash write prompts. */
const PERMISSION_ASK =
	"Run exactly this Bash command and nothing else: touch /tmp/wfc-permission-probe. Use no other tool.";
/* A guess: one such Haiku turn took about 25 s here, under load. */
const WAIT_MS = 180_000;
/* A guess: lib/reaper.js stops a done job within a tick, so the poll is
 * short enough not to miss the done row before it goes. */
const POLL_MS = 1000;

/**
 * @param {string[]} args
 * @param {number} [timeout]
 */
function claude(args, timeout) {
	const r = spawnSync(claudeBin(), args, {
		cwd: hostRoot(),
		encoding: "utf8",
		timeout,
	});
	if (r.error) throw r.error;
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** @typedef {{sessionId: string, state: string} & Record<string, unknown>} Row */

/* What the fixture carries in place of this machine's values (§G7.3): each
 * of the job's identity, place and time. */
const SYNTHETIC = {
	id: "5e55101d",
	sessionId: "5e55101d-0000-4000-8000-000000000000",
	cwd: "/repo",
	name: "a recorded session",
	pid: 4242,
	startedAt: 1_700_000_000_000,
	/* The copy's job id, as `id` is the original's. */
	copyId: "5e55c0b1",
};

/** @param {Row} row */
const shapeOf = (row) =>
	`${row.state}/${row.status}/${Object.keys(row).sort().join()}`;

/**
 * Every row of a recorded job the listing printed, one per distinct shape.
 * @type {Map<string, Row>}
 */
const shapes = new Map();

/**
 * The listing's row for job `id`, its shape kept in `shapes` where it is
 * job `kept`'s.
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

/**
 * `row` with SYNTHETIC's values; a field whose type changed throws.
 * @param {Row} row
 */
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
 * Poll the listing until job `id`'s row, undefined once it has gone, meets
 * `done`; throws `fails` after WAIT_MS.
 * @param {string} id
 * @param {string} kept  the job whose row shapes are kept
 * @param {(row: Row|undefined) => boolean} done
 * @param {string} fails
 * @returns {Promise<Row|undefined>}
 */
async function until(id, kept, done, fails) {
	const by = Date.now() + WAIT_MS;
	while (Date.now() < by) {
		const row = listRowKeepingShape(id, kept);
		if (done(row)) return row;
		await new Promise((wake) => setTimeout(wake, POLL_MS));
	}
	throw new Error(`job ${id} ${fails} after ${WAIT_MS} ms`);
}

/**
 * Until job `id` has gone or no longer reads working: done, stopped, or
 * reaped.
 * @param {string} id
 * @param {string} kept
 */
const settled = (id, kept) =>
	until(id, kept, (row) => row?.state !== "working", "still working");

/**
 * Job `id`'s first row whose state `done` accepts.
 * @param {string} id
 * @param {(state: string) => boolean} done
 * @param {string} fails
 * @returns {Promise<Row>}
 */
const untilState = async (id, done, fails) =>
	/** @type {Row} */ (
		await until(id, id, (row) => row !== undefined && done(row.state), fails)
	);

/**
 * The job id `claude --bg --model haiku [...flags] <prompt>` started.
 * @param {string} prompt
 * @param {string[]} [flags]
 */
function launch(prompt, flags = []) {
	const launched = claude(["--bg", "--model", "haiku", ...flags, prompt]);
	const id = /backgrounded · ([\w-]+)/.exec(launched.stdout)?.[1];
	if (!id)
		throw new Error(
			`the launch named no job: ${launched.stdout}${launched.stderr}`,
		);
	return id;
}

/**
 * One resume of `sessionId`, its job `original`, which starts a copy where
 * `copy` holds and wakes `original` in place where it does not; another
 * answer throws, since the fixture's ids would be the wrong ones.
 * @param {string} sessionId
 * @param {string} original
 * @param {boolean} copy
 */
function resume(sessionId, original, copy) {
	const r = claude(["--bg", "--resume", sessionId, PROMPT]);
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

/**
 * `claude attach <id>` off a terminal, then typed at through pty_type.py as
 * the refill loop types its resume; each one's exit. pty_type.py exits 0 once
 * the line is written, taken or not: the loop checks the session's timeline
 * for it, so the contract judges the exit alone.
 * @param {string} id
 */
function attachExits(id) {
	/* The typed attach's bound as a hang guard: off a terminal no draw or
	 * typed line is waited on, so only `claude attach`'s start-up runs, which
	 * that bound's margin covers. */
	const offTerminal = claude(["attach", id], ATTACH_TIMEOUT_MS);
	const [file, args, opts] = buildTypedAttach(id, PROMPT);
	const onTerminal = spawnSync(file, args, {
		...opts,
		cwd: hostRoot(),
		encoding: "utf8",
	});
	if (onTerminal.error) throw onTerminal.error;
	return {
		offTerminal: { status: offTerminal.status },
		onTerminal: { status: onTerminal.status },
	};
}

/**
 * `claude stop` on each of `ids`, every one tried; why each that failed did.
 * @param {string[]} ids
 */
function stopAll(ids) {
	const failed = [];
	for (const id of ids) {
		const r = claude(["stop", id]);
		if (r.status !== 0) failed.push(`${id}: ${r.stderr.trim()}`);
	}
	return failed;
}

/**
 * The shapes of the fixture's rows that `rows` hold none of: a shape the
 * listing printed last run and not this one, which the contract no longer
 * holds the fake to.
 * @param {Row[]} rows
 */
function lostShapes(rows) {
	const now = new Set(rows.map(shapeOf));
	try {
		const before = JSON.parse(fs.readFileSync(AGENTS_STOP_FIXTURE, "utf8"));
		return [...new Set(before.rows.map(shapeOf))].filter((s) => !now.has(s));
	} catch (e) {
		const c = caught(e);
		/* No fixture yet is a first recording, with no shape to lose. Any
		 * other failure warns rather than throws (#3014): the lost-shape
		 * check is advisory, and throwing would discard a recording its live
		 * sessions already paid for. */
		if (c.code !== "ENOENT")
			writeFd(
				2,
				`could not read ${AGENTS_STOP_FIXTURE} for its shapes: ${c.message}\n`,
			);
		return [];
	}
}

/* The probe rewrites the cache only once its stamp is 58-117 s old (#2189),
 * so a stamp past the band's top makes the recorded refresh certain. */
const USAGE_REFRESH_AGE_MS = 120_000;
/* The cached bars lib/allowance.js and lib/seat-utilisation.js read (#3282). */
const USAGE_KINDS = ["session", "weekly_all", "weekly_scoped"];
/* What the fixture carries in place of the seat's account and stamp. The
 * bars' percents and reset times stay real: the reset text's format is what
 * lib/allowance.js parses. */
const SYNTHETIC_USAGE = {
	accountUuid: "5e55acc0-0000-4000-8000-000000000000",
	fetchedAtMs: 1_700_000_000_000,
};

/** The seat's `cachedUsageUtilization`, raw. @param {string} seat */
function readUsageCacheOf(seat) {
	const cache = JSON.parse(
		fs.readFileSync(path.join(seat, ".claude.json"), "utf8"),
	).cachedUsageUtilization;
	if (typeof cache?.fetchedAtMs !== "number")
		throw new Error(`${seat}/.claude.json holds no stamped usage cache`);
	return cache;
}

/** One `/usage` probe of this session's seat, run to its end once the
 * cache is old enough to refresh, as the fixture records it. */
async function recordUsage() {
	const seat = configDir();
	/* Re-read after each wait: another session's probe may refresh it. */
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

/**
 * @param {string} file
 * @param {object} recorded
 */
function writeFixture(file, recorded) {
	fs.writeFileSync(file, `${JSON.stringify(recorded, null, "\t")}\n`);
	writeFd(1, `recorded ${file}\n`);
}

async function main() {
	const refusal = launchAuthRefusal({
		bin: claudeBin(),
		env: process.env,
		cwd: hostRoot(),
	});
	if (refusal) throw new Error(refusal);
	const harness = claude(["--version"]).stdout.split(" ")[0];
	const original = launch(PROMPT);
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
		const asker = launch(ASK);
		started.push(asker);
		await untilState(asker, (state) => state === "blocked", "never blocked");
		const permissionJob = launch(PERMISSION_ASK, [
			"--permission-mode",
			"manual",
		]);
		started.push(permissionJob);
		await until(
			permissionJob,
			permissionJob,
			(row) => row?.status === "waiting",
			"never waited on a prompt",
		);
		const attached = attachExits(asker);
		const rows = [...shapes.values()];
		/* The contract's finished and terminal cases need a done row, and
		 * lib/block-cause.js's a blocked one and a waiting one. */
		for (const state of ["working", "done", "blocked"])
			if (!rows.some((r) => r.state === state))
				throw new Error(
					`the listing never showed ${started.join(" or ")} ${state}`,
				);
		if (!rows.some((r) => r.waitingFor))
			throw new Error(`the listing never showed ${permissionJob} waitingFor`);
		const lost = lostShapes(rows);
		if (lost.length > 0)
			writeFd(
				2,
				`the listing showed none of these recorded shapes this run: ${lost.join("; ")}\n`,
			);
		/* The job ids, and the session's name its launch line prints. */
		const syntheticText = (/** @type {string} */ text) =>
			text
				.replaceAll(copy.startedAs, SYNTHETIC.copyId)
				.replaceAll(original, SYNTHETIC.id)
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
		/* A job reaped or already stopped answers "No job matching". */
		const unstopped = stopAll(started).filter(
			(why) => !why.includes("No job matching"),
		);
		if (unstopped.length > 0)
			writeFd(2, `still running, stop by hand: ${unstopped.join("; ")}\n`);
	}
	/* Last, once every job is stopped, so its wait or a failure costs no
	 * other fixture. */
	writeFixture(USAGE_FIXTURE, {
		recordedBy: RECORDED_BY,
		harness,
		...(await recordUsage()),
	});
}

main().catch((e) => {
	writeFd(2, `${caught(e).message}\n`);
	process.exit(1);
});
