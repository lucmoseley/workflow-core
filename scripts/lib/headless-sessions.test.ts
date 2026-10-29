// @vitest-environment node
/*
 * Pins lib/headless-sessions.js through its CLI, as the dispatcher drives it,
 * with a fake `claude` through WFC_CLAUDE_BIN and a fixture secrets file
 * through WFC_SECRETS_FILE: the launch's job id, flags and child environment,
 * the key's route through the apiKeyHelper alone, the refusals by name, the
 * listing's liveness, the group stop, and the end-result reading.
 *
 * Loosen one and an overflow run leaks its key into Bash, outlives its stop,
 * reads as live on a reused pid, or bills a spent key as a success (#2607).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProcStartOf } from "./arbiter-proc.js";
import {
	ADMITTED_AUTH,
	buildAuthStatusNodeBranch,
	REFUSED_AUTH,
	writeSeatHelper,
} from "./auth-status-fake";
import { headlessStore, writeHeadlessRun } from "./headless-runs-testkit";
import { endResultOf, launch as launchRun, stop } from "./headless-sessions.js";
import { runInProcessAsync } from "./run-in-process.js";
import { TEST_TIMEOUT_MS } from "./test-ceiling";

const SCRIPT = path.join(__dirname, "headless-sessions.js");
const KEY = "sk-fake-overflow-0123456789";
const KEY_VAR = "WFC_TEST_OVERFLOW_KEY";

/* The fake records its argv and environment, runs the apiKeyHelper it was
 * handed the way `claude` does, then behaves per FAKE_MODE: `sleep` holds a
 * grandchild in its group, `stubborn` also ignores SIGTERM, `orphan` leaves
 * the grandchild behind and exits, `events` prints FAKE_EVENTS and exits.
 *
 * A run killed before teardown never stops its fake, which the launch has
 * detached (#2678 (the leaked fakes)). So the fake ends itself and its
 * grandchild once FAKE_OUT is gone or FAKE_DEADLINE_MS passes, checked
 * each second (a guess). Never a parent-death check: the launch CLI exits
 * at once, so every fake is reparented to init while its case runs. */
const FAKE = `#!/usr/bin/env node
${buildAuthStatusNodeBranch()}
const fs = require("node:fs");
const path = require("node:path");
const { execSync, spawn } = require("node:child_process");
const out = process.env.FAKE_OUT;
const argv = process.argv.slice(2);
const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
const helped = execSync(settings.apiKeyHelper, { encoding: "utf8" }).trim();
const mode = process.env.FAKE_MODE;
const deadlineMs = Number(process.env.FAKE_DEADLINE_MS);
let grandchild = null;
if (mode !== "events") {
	grandchild = spawn("sleep", [String(Math.ceil(deadlineMs / 1000))], { stdio: "ignore", detached: false }).pid;
	if (mode === "stubborn") process.on("SIGTERM", () => {});
}
fs.writeFileSync(path.join(out, "seen.json"), JSON.stringify({
	argv, env: process.env, cwd: process.cwd(), helped, grandchild,
	stdin: fs.readlinkSync("/proc/self/fd/0"),
}));
if (mode === "events") {
	process.stdout.write(fs.readFileSync(process.env.FAKE_EVENTS, "utf8"));
	process.exit(0);
}
if (mode === "orphan") process.exit(0);
const end = Date.now() + deadlineMs;
setInterval(() => {
	if (Date.now() < end && fs.existsSync(out)) return;
	try {
		process.kill(grandchild, "SIGKILL");
	} catch {
		/* already gone */
	}
	process.exit(0);
}, 1000);
`;

let tmp: string;
let home: string;
let refill: string;
let config: string;
let secrets: string;
let target: string;
let fakeOut: string;
let seat: string;
const saved = process.env.WFC_REFILL_DIR;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "headless-"));
	home = path.join(tmp, "home");
	refill = path.join(tmp, "refill");
	config = path.join(tmp, "config");
	secrets = path.join(config, "workflow-core", "secrets.env");
	target = path.join(tmp, "target");
	fakeOut = path.join(tmp, "fake-out");
	seat = path.join(home, ".claude2-api");
	for (const d of [
		path.join(home, ".claude"),
		seat,
		path.dirname(secrets),
		target,
		fakeOut,
	])
		fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(
		path.join(home, ".claude", "refill-seats"),
		`${path.join(home, ".claude2")}\n~/.claude2-api api key=${KEY_VAR} grant=200 cycle-day=20\n`,
	);
	fs.writeFileSync(secrets, `OTHER=1\n${KEY_VAR}=${KEY}\n`);
	fs.writeFileSync(path.join(tmp, "claude"), FAKE, { mode: 0o755 });
	process.env.WFC_REFILL_DIR = refill;
});

afterEach(async () => {
	const store = headlessStore(refill);
	for (const job of fs.existsSync(store) ? fs.readdirSync(store) : [])
		await stop(job, { graceMs: 0 });
	const seen = readSeenOrNull();
	if (seen?.grandchild) killQuietly(seen.grandchild);
	if (saved === undefined) delete process.env.WFC_REFILL_DIR;
	else process.env.WFC_REFILL_DIR = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function killQuietly(pid: number) {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

const env = (extra: Record<string, string> = {}) => ({
	PATH: process.env.PATH ?? "",
	HOME: home,
	WFC_REFILL_DIR: refill,
	WFC_CLAUDE_BIN: path.join(tmp, "claude"),
	WFC_SECRETS_FILE: secrets,
	FAKE_OUT: fakeOut,
	FAKE_MODE: "sleep",
	/* Past one case and its hooks, so a fake never dies mid-case. */
	FAKE_DEADLINE_MS: String(2 * TEST_TIMEOUT_MS),
	...extra,
});

const cli = (args: string[], extra: Record<string, string> = {}) =>
	runInProcessAsync(SCRIPT, args, { env: env(extra) });

const launch = (extra: Record<string, string> = {}, at = seat) =>
	cli(
		[
			"launch",
			"--seat",
			at,
			"--cwd",
			target,
			"--budget",
			"12.5",
			"/implement 7",
		],
		extra,
	);

function readSeenOrNull(): {
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	helped: string;
	grandchild: number | null;
	stdin: string;
} | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(fakeOut, "seen.json"), "utf8"));
	} catch {
		return null;
	}
}

/* A wait on a real process, not a timing assertion: the ceiling and the poll
 * are guesses, generous against a loaded machine. */
async function until(test: () => boolean | Promise<boolean>, ms = 10_000) {
	for (const end = Date.now() + ms; Date.now() < end; ) {
		if (await test()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("condition not met in time");
}

const isAlive = (pid: number) => readProcStartOf(pid) !== null;
const listed = async () => JSON.parse((await cli(["list"])).stdout);
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

/* dispatch-sessions.sh's own job-id parse, run on the launch's output. */
const dispatcherJobId = (stdout: string) =>
	spawnSync(
		"bash",
		[
			"-c",
			`head -1 | sed -E 's/\\x1b\\[[0-9;]*[A-Za-z]//g' | grep -oE '[0-9a-f]{8}' | tail -1`,
		],
		{ input: stdout, encoding: "utf8" },
	).stdout.trim();

describe("launch", () => {
	it("prints a job id the dispatcher's parse reads, and spawns claude -p with the run's flags", async () => {
		const r = await launch();
		expect(r.status).toBe(0);
		const jobId = dispatcherJobId(r.stdout);
		expect(jobId).toMatch(/^[0-9a-f]{8}$/);
		expect(r.stdout.split("\n")[0]).toBe(jobId);
		await until(() => readSeenOrNull() !== null);
		const seen = readSeenOrNull();
		if (!seen) throw new Error("fake never ran");
		expect(seen.argv[0]).toBe("-p");
		expect(seen.argv.at(-1)).toBe("/implement 7");
		expect(flag(seen.argv, "--output-format")).toBe("stream-json");
		expect(seen.argv).toContain("--verbose");
		expect(flag(seen.argv, "--max-budget-usd")).toBe("12.5");
		expect(seen.argv).not.toContain("--model");
		expect(flag(seen.argv, "--append-system-prompt")).toContain("needs input:");
		const sessionId = flag(seen.argv, "--session-id");
		expect(r.stdout.split("\n")[1]).toBe(`session ${sessionId}`);
		expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(target));
		expect(seen.stdin).toBe("/dev/null");
		expect(seen.env.CLAUDE_CONFIG_DIR).toBe(seat);
		expect(seen.env.CLAUDE_JOB_DIR).toBe(
			path.join(refill, ".headless-runs", jobId, "job"),
		);
		expect(fs.existsSync(path.join(seen.env.CLAUDE_JOB_DIR, "tmp"))).toBe(true);
	});

	it("hands the key through the settings' apiKeyHelper alone: in neither the child's environment nor the caller's", async () => {
		const r = await launch({
			ANTHROPIC_API_KEY: "sk-caller-own",
			[KEY_VAR]: "sk-caller-copy",
			CLAUDE_CODE_SESSION_ID: "caller-session",
		});
		expect(r.status).toBe(0);
		await until(() => readSeenOrNull() !== null);
		const seen = readSeenOrNull();
		if (!seen) throw new Error("fake never ran");
		expect(JSON.parse(flag(seen.argv, "--settings")).apiKeyHelper).toContain(
			SCRIPT,
		);
		expect(seen.helped).toBe(KEY);
		expect(Object.values(seen.env)).not.toContain(KEY);
		expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(seen.env[KEY_VAR]).toBeUndefined();
		expect(seen.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
		expect(r.stdout + r.stderr).not.toContain(KEY);
	});

	it("leaves the key out of the launching process's own environment", async () => {
		const before = { ...process.env };
		Object.assign(process.env, env());
		try {
			const launched = launchRun({
				seat,
				cwd: target,
				budgetUsd: 1,
				prompt: "/implement 7",
			});
			expect("record" in launched).toBe(true);
			expect(Object.values(process.env)).not.toContain(KEY);
		} finally {
			for (const k of Object.keys(process.env))
				if (!(k in before)) delete process.env[k];
			Object.assign(process.env, before);
		}
		await until(() => readSeenOrNull() !== null);
		expect(readSeenOrNull()?.helped).toBe(KEY);
	});

	it.each([
		["no secrets file", () => fs.rmSync(secrets)],
		[
			"a secrets file without the variable",
			() => fs.writeFileSync(secrets, "OTHER=1\n"),
		],
	])(
		"refuses with %s, naming the variable, and spawns nothing",
		async (_, setUp) => {
			setUp();
			const r = await launch();
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(/^REFUSED: .*WFC_TEST_OVERFLOW_KEY/);
			expect(r.stdout).toBe("");
			expect(readSeenOrNull()).toBeNull();
			expect(fs.existsSync(path.join(refill, ".headless-runs"))).toBe(false);
		},
	);

	it("refuses a plan seat, naming it as not an overflow seat", async () => {
		const r = await launch({}, path.join(home, ".claude2"));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("is not an overflow seat");
		expect(readSeenOrNull()).toBeNull();
	});
});

describe("the launch's auth (#2236)", () => {
	/* The launch strips the seat's API key and supplies its own, so an
	 * ANTHROPIC_API_KEY it inherits is admitted on an overflow seat (#2570). */
	const refused = REFUSED_AUTH.filter(([name]) => name !== "ANTHROPIC_API_KEY");

	it.each(refused)(
		"refuses under %s, spawning nothing",
		async (name, extra) => {
			const r = await launch(extra);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(new RegExp(`^REFUSED: .*${name} is set.*#2236`));
			expect(readSeenOrNull()).toBeNull();
			expect(fs.existsSync(headlessStore(refill))).toBe(false);
		},
	);

	it("refuses an apiKeyHelper in the seat's own settings", async () => {
		writeSeatHelper(seat);
		const r = await launch();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("apiKeyHelper");
		expect(readSeenOrNull()).toBeNull();
	});

	it.each([
		...ADMITTED_AUTH,
		["ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "k" }] as const,
	])("launches on %s", async (_name, extra) => {
		expect((await launch({ ...extra })).status).toBe(0);
		await until(() => readSeenOrNull() !== null);
	});
});

describe("list and stop", () => {
	it("lists a live run as an oracle-shaped record; stop ends its whole process group and drops it", async () => {
		const jobId = (await launch()).stdout.split("\n")[0] ?? "";
		await until(() => readSeenOrNull() !== null);
		const seen = readSeenOrNull();
		if (!seen?.grandchild) throw new Error("fake never ran");
		const [run] = await listed();
		expect(run).toMatchObject({
			id: jobId,
			sessionId: flag(seen.argv, "--session-id"),
			cwd: target,
			state: "working",
			kind: "headless",
		});
		expect(typeof run.pid).toBe("number");
		expect(typeof run.startedAt).toBe("number");

		const r = await cli(["stop", jobId]);
		expect(r.stdout.trim()).toBe("stopped");
		await until(() => !isAlive(seen.grandchild ?? 0));
		expect(await listed()).toEqual([]);
	});

	it("stops a group whose leader has exited, ending the task it left behind", async () => {
		const jobId =
			(await launch({ FAKE_MODE: "orphan" })).stdout.split("\n")[0] ?? "";
		await until(() => readSeenOrNull() !== null);
		const grandchild = readSeenOrNull()?.grandchild ?? 0;
		await until(async () => (await listed()).length === 0);
		expect(isAlive(grandchild)).toBe(true);
		expect((await cli(["stop", jobId])).stdout.trim()).toBe("stopped");
		await until(() => !isAlive(grandchild));
	});

	it("drops an ended run", async () => {
		const events = path.join(tmp, "events.jsonl");
		fs.writeFileSync(
			events,
			`${JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.5 })}\n`,
		);
		await launch({ FAKE_MODE: "events", FAKE_EVENTS: events });
		await until(() => readSeenOrNull() !== null);
		await until(async () => (await listed()).length === 0);
	});

	it("drops a run whose pid now belongs to another process", async () => {
		const dir = path.join(refill, ".headless-runs", "0badf00d");
		const record = (procStart: string | null) =>
			writeHeadlessRun(refill, "0badf00d", "s", {
				procStart,
				bootId: null,
				seat,
				cwd: target,
				log: path.join(dir, "out.jsonl"),
				stderr: path.join(dir, "stderr.log"),
				launchedAt: 1,
			});
		record(readProcStartOf(process.pid));
		expect((await listed()).map((a: { id: string }) => a.id)).toEqual([
			"0badf00d",
		]);
		record("1");
		expect(await listed()).toEqual([]);
	});

	/* Crosses the real clock: the escalation is a signal to a real process
	 * group, so the grace is shortened, never asserted as elapsed time. */
	it("kills a group that ignores SIGTERM once the grace period passes", async () => {
		const jobId =
			(await launch({ FAKE_MODE: "stubborn" })).stdout.split("\n")[0] ?? "";
		await until(() => readSeenOrNull() !== null);
		expect(await stop(jobId, { graceMs: 300 })).toBe("killed");
		await until(() => !isAlive(readSeenOrNull()?.grandchild ?? 0));
		expect(await listed()).toEqual([]);
	});
});

describe("end result", () => {
	const dead = spawnSync("true").pid;
	const runWith = (events: object[], stderr = "", pid = dead) => {
		const log = path.join(tmp, "out.jsonl");
		const err = path.join(tmp, "stderr.log");
		fs.writeFileSync(
			log,
			`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
		);
		fs.writeFileSync(err, stderr);
		return {
			jobId: "0badf00d",
			sessionId: "sess",
			pid,
			procStart: readProcStartOf(pid),
			bootId: null,
			pgid: pid,
			seat,
			cwd: target,
			log,
			stderr: err,
			launchedAt: 1,
		};
	};

	it("takes outcome and cost from the last of several results", () => {
		expect(
			endResultOf(
				runWith([
					{ type: "system", subtype: "init" },
					{
						type: "result",
						subtype: "success",
						is_error: false,
						result_index: 0,
						total_cost_usd: 0.4,
					},
					{ type: "system", subtype: "task_notification" },
					{
						type: "result",
						subtype: "success",
						is_error: false,
						result_index: 1,
						total_cost_usd: 1.25,
					},
				]),
			),
		).toEqual({ outcome: "success", costUsd: 1.25, sessionId: "sess" });
	});

	it("reads a credit-balance refusal as key-exhausted", () => {
		expect(
			endResultOf(
				runWith([
					{
						type: "result",
						subtype: "success",
						is_error: true,
						result: "Credit balance is too low",
						total_cost_usd: 0,
					},
				]),
			).outcome,
		).toBe("key-exhausted");
		expect(
			endResultOf(runWith([], "Error: Credit balance is too low\n")).outcome,
		).toBe("key-exhausted");
	});

	it("reads no result and a dead pid as a killed run", () => {
		expect(endResultOf(runWith([{ type: "system", subtype: "init" }]))).toEqual(
			{
				outcome: "killed",
				costUsd: null,
				sessionId: "sess",
			},
		);
	});

	it("reads a live pid as running, whatever results it has emitted", () => {
		expect(
			endResultOf(
				runWith(
					[{ type: "result", is_error: false, total_cost_usd: 0.3 }],
					"",
					process.pid,
				),
			).outcome,
		).toBe("running");
	});
});
