// @vitest-environment node
/*
 * Pins the grouped child the refill loop's shortlist read runs in (#2677):
 * past its cap, or past its output cap, the whole group dies, a grandchild
 * included, and a group still live when its caller exits dies with it.
 * Loosen a case and one slow checkout's read, or the `gh` calls it started,
 * holds the loop's tick or outlives the loop. The synchronous form kills the
 * group for the lander's revert commit (#3916), with a SIGTERM and a grace
 * first (#3923).
 *
 * Every case crosses the real clock: what is pinned is a real kill of real
 * processes, which no injected clock reaches. The file runs past the 10 s
 * budget because the cap case waits out HUNG_CAP_MS: a shorter cap can kill
 * the stub before it starts the grandchild that case pins.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDead, isGroupDead, waitFor } from "./process-fixture.js";

const { execGroupedSync, runGrouped } = require("./grouped-child.js");

const LIB = path.resolve(__dirname, "grouped-child.js");
const SUPERVISOR = path.resolve(__dirname, "grouped-child-supervisor.js");

/* Only bounds a hung shell: the run under it exits by itself, or is killed by
 * something sooner. */
const UNREACHED_TIMEOUT_MS = 60_000;

/* Long enough for the stub to start and write its group id first: under the
 * machine's load a node start runs to seconds (vitest.config.ts's x39.6
 * median spawn slowdown), and the 90 s test timeout bounds it from above. */
const HUNG_CAP_MS = 15_000;
/* A killed orphan stays a zombie, still in its group, until init reaps it;
 * how long that takes under load is unmeasured, so this is a guess. */
const REAP_WAIT_MS = 20_000;
const REAP_POLL_MS = 100;

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "grouped-child-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const hungStub = (pgidFile: string) => {
	const stub = path.join(home, "hung.js");
	fs.writeFileSync(
		stub,
		`const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pgidFile)}, String(process.pid));
setTimeout(() => {}, 120000);
`,
	);
	return stub;
};

const groupAlive = (pgid: number) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw e;
	}
};

const groupGone = async (pgid: number) => {
	const until = Date.now() + REAP_WAIT_MS;
	while (groupAlive(pgid) && Date.now() < until)
		await new Promise((r) => setTimeout(r, REAP_POLL_MS));
	return !groupAlive(pgid);
};

const catchThrown = (call: () => unknown) => {
	try {
		call();
	} catch (e) {
		return e as NodeJS.ErrnoException & { stderr: string; status: number };
	}
	throw new Error("expected a throw");
};

const opts = (over: Record<string, unknown> = {}) => ({
	cwd: home,
	env: process.env,
	timeoutMs: HUNG_CAP_MS,
	maxBuffer: 1e6,
	...over,
});

describe("a grouped child", () => {
	it("returns what a run that finishes printed, and its exit", async () => {
		const run = await runGrouped(
			process.execPath,
			["-e", "process.stdout.write('ok'); process.stderr.write('e\\n')"],
			opts(),
		);
		expect(run).toEqual({
			code: 0,
			signal: null,
			stdout: "ok",
			stderr: "e\n",
			killedFor: null,
			killedCode: null,
			unkilled: null,
			spawnCode: null,
		});
	});

	it("names the spawn code of a file that will not start", async () => {
		const run = await runGrouped(path.join(home, "no-such-file"), [], opts());
		expect(run.spawnCode).toBe("ENOENT");
		expect(run.code).toBeNull();
	});

	it("past its cap, settles timed out and kills the whole group, the grandchild with it", async () => {
		const pgidFile = path.join(home, "pgid");
		const run = await runGrouped(
			process.execPath,
			[hungStub(pgidFile)],
			opts(),
		);
		expect(run.killedFor).toBe(`timed out after ${HUNG_CAP_MS / 1000} s`);
		expect(await groupGone(Number(fs.readFileSync(pgidFile, "utf8")))).toBe(
			true,
		);
	});

	it("past its output cap, is killed rather than read on", async () => {
		const run = await runGrouped(
			process.execPath,
			[
				"-e",
				"process.stdout.write('x'.repeat(1000)); setTimeout(() => {}, 120000)",
			],
			opts({ maxBuffer: 100 }),
		);
		expect(run.killedFor).toBe("stdout past 100 bytes");
	});

	it("kills a synchronous run's whole group at its timeout, throwing the timeout with the stderr so far (#3916)", () => {
		const pidFile = path.join(home, "pid");
		const thrown = catchThrown(() =>
			execGroupedSync(
				"sh",
				["-c", `sleep 60 & echo $! > '${pidFile}'; echo last >&2; wait`],
				/* A guess: room for the shell to start its child under load. */
				{ timeout: 3000 },
			),
		);
		expect(thrown.code).toBe("ETIMEDOUT");
		expect(thrown.stderr).toBe("last\n");
		const child = Number(fs.readFileSync(pidFile, "utf8"));
		expect(waitFor(() => isDead(child))).toBe(true);
	});

	it("kills a synchronous run's descendant that ignores SIGTERM once the grace is out (#3923)", () => {
		const pidFile = path.join(home, "pid");
		catchThrown(() =>
			execGroupedSync(
				"sh",
				[
					"-c",
					`sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 0.1; done' & wait`,
				],
				/* Guesses: room for the shell to start its child under load, and a
				 * grace short enough to keep the case quick. */
				{ timeout: 3000, graceMs: 500 },
			),
		);
		const child = Number(fs.readFileSync(pidFile, "utf8"));
		expect(isDead(child)).toBe(true);
	});

	it("throws what a synchronous run printed before its kill, not its dying shells' report (#3923)", () => {
		const thrown = catchThrown(() =>
			execGroupedSync(
				"sh",
				["-c", `trap 'exit 143' TERM; echo last >&2; sleep 60; wait`],
				/* A guess: room for the shell to start its child under load. */
				{ timeout: 3000 },
			),
		);
		expect(thrown.stderr).toBe("last\n");
	});

	it("gives a synchronous run's wrapper the grace to kill the group it started (#3923)", () => {
		const pidFile = path.join(home, "pid");
		const wrapper = path.join(home, "wrapper.sh");
		fs.writeFileSync(
			wrapper,
			`setsid sh -c 'echo $$ > "${pidFile}"; exec sleep 60' &
gid=$!
trap 'kill -TERM -"$gid"; wait "$gid"; exit 143' TERM
wait "$gid"
`,
		);
		catchThrown(() =>
			execGroupedSync("sh", ["-c", `sh '${wrapper}' & wait`], {
				/* A guess: room for the wrapper to start its group under load. */
				timeout: 3000,
			}),
		);
		const descendant = Number(fs.readFileSync(pidFile, "utf8"));
		expect(isDead(descendant)).toBe(true);
	});

	it("kills the group of a supervisor that takes SIGTERM (#3923)", async () => {
		const pidFile = path.join(home, "pid");
		/* spawn-kept: the case sends this process a real signal. */
		const supervisor = spawn(process.execPath, [SUPERVISOR], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		await new Promise<void>((done) =>
			supervisor.stdin.end(
				JSON.stringify({
					file: "sh",
					args: ["-c", `echo $$ > '${pidFile}'; sleep 60`],
					opts: {
						timeoutMs: UNREACHED_TIMEOUT_MS,
						maxBuffer: 100,
						graceMs: 500,
					},
				}),
				done,
			),
		);
		expect(
			waitFor(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0),
		).toBe(true);
		const pgid = Number(fs.readFileSync(pidFile, "utf8"));
		supervisor.kill("SIGTERM");
		expect(waitFor(() => isGroupDead(pgid))).toBe(true);
	});

	it("kills a synchronous run's whole group past its output cap (#3916)", () => {
		const pidFile = path.join(home, "pid");
		const thrown = catchThrown(() =>
			execGroupedSync(
				"sh",
				[
					"-c",
					`sleep 60 & echo $! > '${pidFile}'; head -c 2000 /dev/zero; wait`,
				],
				{ timeout: UNREACHED_TIMEOUT_MS, maxBuffer: 100 },
			),
		);
		expect(thrown.code).toBe("ENOBUFS");
		const child = Number(fs.readFileSync(pidFile, "utf8"));
		expect(waitFor(() => isDead(child))).toBe(true);
	});

	it("leaves a synchronous run's background child alone when it exits by itself (#3916)", () => {
		const pidFile = path.join(home, "pid");
		const out = execGroupedSync(
			"sh",
			["-c", `sleep 60 >/dev/null 2>&1 & echo $! > '${pidFile}'; echo done`],
			{ timeout: UNREACHED_TIMEOUT_MS },
		);
		expect(out).toBe("done\n");
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		expect(isDead(pid)).toBe(false);
		process.kill(pid, "SIGKILL");
	});

	it("throws a synchronous run's non-zero exit with its stderr (#3916)", () => {
		const thrown = catchThrown(() =>
			execGroupedSync("sh", ["-c", "echo refused >&2; exit 3"], {
				timeout: UNREACHED_TIMEOUT_MS,
			}),
		);
		expect(thrown.status).toBe(3);
		expect(thrown.stderr).toBe("refused\n");
	});

	it("dies with a caller that exits while it runs", async () => {
		const pgidFile = path.join(home, "pgid");
		const caller = path.join(home, "caller.js");
		fs.writeFileSync(
			caller,
			`const { runGrouped } = require(${JSON.stringify(LIB)});
runGrouped(process.execPath, [${JSON.stringify(hungStub(pgidFile))}], {
	cwd: ${JSON.stringify(home)}, env: process.env, timeoutMs: 600000, maxBuffer: 1e6,
});
const wait = setInterval(() => {
	if (require("node:fs").existsSync(${JSON.stringify(pgidFile)})) process.exit(0);
}, 50);
`,
		);
		// spawn-kept: the case is the caller process exiting while its child runs.
		execFileSync(process.execPath, [caller], { stdio: "ignore" });
		expect(await groupGone(Number(fs.readFileSync(pgidFile, "utf8")))).toBe(
			true,
		);
	});
});
