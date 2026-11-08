// @vitest-environment node
/*
 * Pins lib/headless-sessions.js through its CLI, as the dispatcher drives it,
 * with lib/headless-run-fake.ts's `-p` fake, held to the binary by its
 * contract, through WFC_CLAUDE_BIN and a fixture secrets file
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProcStartOf } from "./arbiter-proc.js";
import {
	ADMITTED_AUTH,
	REFUSED_AUTH,
	writeSeatHelper,
} from "./auth-status-fake";
import { writeClaudeStub } from "./claude-stub";
import {
	buildHeadlessBranch,
	buildResultRow,
	type HeadlessMode,
	readHeadlessCalls,
	writeHeadlessFake,
} from "./headless-run-fake";
import { readEndResult, stop } from "./headless-runs.js";
import { headlessStore, writeHeadlessRun } from "./headless-runs-testkit";
import { launch as launchRun } from "./headless-sessions.js";
import { runInProcessAsync } from "./run-in-process.js";

const SCRIPT = path.join(__dirname, "headless-sessions.js");
const KEY = "sk-fake-overflow-0123456789";
const KEY_VAR = "WFC_TEST_OVERFLOW_KEY";

let tmp: string;
let home: string;
let refill: string;
let config: string;
let secrets: string;
let target: string;
let fakeOut: string;
let seat: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "headless-"));
	home = path.join(tmp, "home");
	refill = path.join(tmp, "refill");
	config = path.join(tmp, "config");
	secrets = path.join(config, "workflow-core", "secrets.env");
	target = path.join(tmp, "target");
	fakeOut = path.join(tmp, "fake-out");
	seat = path.join(home, ".claude2");
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
		`${path.join(home, ".claude2")}\n~/.claude2 api key=${KEY_VAR} grant=200 cycle-day=20\n`,
	);
	fs.writeFileSync(secrets, `OTHER=1\n${KEY_VAR}=${KEY}\n`);
	writeClaudeStub(path.join(tmp, "claude"), [
		buildHeadlessBranch(path.join(tmp, "claude-p")),
	]);
	fakeMode("hold");
	vi.stubEnv("WFC_REFILL_DIR", refill);
});

afterEach(async () => {
	const store = headlessStore(refill);
	for (const job of fs.existsSync(store) ? fs.readdirSync(store) : [])
		await stop(job, { graceMs: 0 });
	const seen = readSeenOrNull();
	if (seen?.grandchild) killQuietly(seen.grandchild);
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
	...extra,
});

const cli = (args: string[], extra: Record<string, string> = {}) =>
	runInProcessAsync(SCRIPT, args, { env: env(extra) });

const launch = (extra: Record<string, string> = {}, key = KEY_VAR) =>
	cli(
		[
			"launch",
			"--key",
			key,
			"--cwd",
			target,
			"--budget",
			"12.5",
			"/implement 7",
		],
		extra,
	);

/** The `-p` fake every launch here execs (lib/headless-run-fake.ts), in
 * `mode`, its runs logged under fakeOut. */
const fakeMode = (mode: HeadlessMode) =>
	writeHeadlessFake(path.join(tmp, "claude-p"), {
		log: path.join(fakeOut, "calls.jsonl"),
		mode,
	});

const readSeenOrNull = () =>
	readHeadlessCalls(path.join(fakeOut, "calls.jsonl")).at(-1) ?? null;

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
		/* The XDG route rather than the override, which writes no .gitignore. */
		const r = await launch({ WFC_SECRETS_FILE: "", XDG_CONFIG_HOME: config });
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
		expect(
			fs.readFileSync(path.join(path.dirname(secrets), ".gitignore"), "utf8"),
		).toBe("*\n");
		expect(seen.argv).not.toContain("-n");
		expect(seen.env.WFC_NAME_PREFIX).toBe("Overflow · ");
		expect(seen.env.WFC_NAME_PREFIX_SESSION).toBe(sessionId);
		expect(seen.argv).not.toContain("--resume");
	});

	it("resumes a session on the same seat and key, under the name given with the overflow prefix once (#4580, #3701)", async () => {
		const r = await cli([
			"launch",
			"--key",
			KEY_VAR,
			"--cwd",
			target,
			"--budget",
			"3",
			"--name",
			"Overflow · /implement 7",
			"--resume",
			"0f0e0d0c-0000-4000-8000-000000000000",
			"the answer",
		]);
		expect(r.status).toBe(0);
		expect(r.stdout.split("\n")[1]).toBe(
			"session 0f0e0d0c-0000-4000-8000-000000000000",
		);
		await until(() => readSeenOrNull() !== null);
		const seen = readSeenOrNull();
		if (!seen) throw new Error("fake never ran");
		expect(seen.argv[0]).toBe("-p");
		expect(flag(seen.argv, "--resume")).toBe(
			"0f0e0d0c-0000-4000-8000-000000000000",
		);
		expect(seen.argv).not.toContain("--session-id");
		expect(seen.argv).not.toContain("--bg");
		expect(flag(seen.argv, "-n")).toBe("Overflow · /implement 7");
		expect(seen.env.WFC_NAME_PREFIX_SESSION).toBe(
			"0f0e0d0c-0000-4000-8000-000000000000",
		);
		expect(seen.helped).toBe(KEY);
		expect(seen.env.CLAUDE_CONFIG_DIR).toBe(seat);
		expect(seen.argv.at(-1)).toBe("the answer");
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
		expect(JSON.parse(flag(seen.argv, "--settings")).apiKeyHelper).toMatch(
			new RegExp(`overflow-key\\.js ${KEY_VAR} `),
		);
		expect(seen.helped).toBe(KEY);
		expect(Object.values(seen.env)).not.toContain(KEY);
		expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(seen.env[KEY_VAR]).toBeUndefined();
		expect(seen.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
		expect(r.stdout + r.stderr).not.toContain(KEY);
	});

	it("leaves the launcher's root out of the child's environment (#4595)", async () => {
		const r = await launch({
			WFC_REPO_ROOT: "/the/launcher",
			CLAUDE_PROJECT_DIR: "/the/launcher",
			WFC_DISPATCH_ROOT: "/the/launcher",
		});
		expect(r.status).toBe(0);
		await until(() => readSeenOrNull() !== null);
		const seen = readSeenOrNull();
		if (!seen) throw new Error("fake never ran");
		expect(seen.env.WFC_REPO_ROOT).toBeUndefined();
		expect(seen.env.CLAUDE_PROJECT_DIR).toBeUndefined();
		expect(seen.env.WFC_DISPATCH_ROOT).toBeUndefined();
	});

	it("leaves the key out of the launching process's own environment", async () => {
		for (const [k, v] of Object.entries(env())) vi.stubEnv(k, v);
		const launched = launchRun({
			keyVar: KEY_VAR,
			cwd: target,
			budgetUsd: 1,
			prompt: "/implement 7",
		});
		expect("record" in launched).toBe(true);
		expect(Object.values(process.env)).not.toContain(KEY);
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

	it("refuses a key no overflow line declares", async () => {
		const r = await launch({}, "WFC_NO_KEY");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("WFC_NO_KEY is not an overflow seat's key");
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
		fakeMode("orphan");
		const jobId = (await launch()).stdout.split("\n")[0] ?? "";
		await until(() => readSeenOrNull() !== null);
		const grandchild = readSeenOrNull()?.grandchild ?? 0;
		await until(async () => (await listed()).length === 0);
		expect(isAlive(grandchild)).toBe(true);
		expect((await cli(["stop", jobId])).stdout.trim()).toBe("stopped");
		await until(() => !isAlive(grandchild));
	});

	it("drops an ended run", async () => {
		fakeMode("end");
		await launch();
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
				keyVar: KEY_VAR,
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
		fakeMode("stubborn");
		const jobId = (await launch()).stdout.split("\n")[0] ?? "";
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
			keyVar: KEY_VAR,
			cwd: target,
			prompt: "/implement 7",
			log,
			stderr: err,
			launchedAt: 1,
		};
	};

	it("takes outcome and cost from the last of several results", () => {
		expect(
			readEndResult(
				runWith([
					{ type: "system", subtype: "init" },
					buildResultRow({ result_index: 0, total_cost_usd: 0.4 }),
					{ type: "system", subtype: "task_notification" },
					buildResultRow({ result_index: 1, total_cost_usd: 1.25 }),
				]),
			),
		).toEqual({ outcome: "success", costUsd: 1.25, sessionId: "sess" });
	});

	it("reads a credit-balance refusal as key-exhausted", () => {
		expect(
			readEndResult(
				runWith([
					buildResultRow({
						is_error: true,
						result: "Credit balance is too low",
						total_cost_usd: 0,
					}),
				]),
			).outcome,
		).toBe("key-exhausted");
		expect(
			readEndResult(runWith([], "Error: Credit balance is too low\n")).outcome,
		).toBe("key-exhausted");
	});

	it("reads no result and a dead pid as a killed run", () => {
		expect(
			readEndResult(runWith([{ type: "system", subtype: "init" }])),
		).toEqual({
			outcome: "killed",
			costUsd: null,
			sessionId: "sess",
		});
	});

	it("reads a live pid as running, whatever results it has emitted", () => {
		expect(
			readEndResult(
				runWith([buildResultRow({ total_cost_usd: 0.3 })], "", process.pid),
			).outcome,
		).toBe("running");
	});
});
