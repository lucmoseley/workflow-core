// @vitest-environment node
/*
 * The refill loop's `run` driven end to end (#2435): tick()'s wiring into
 * lib/refill-loop.js's settleTick, which #2286 tests only from fixtures, and
 * run()'s exit on a returned stop or a stop's wake.
 *
 * The program and its lib/ closure are copied into a sandbox `scripts/`, its
 * children stubbed beside it: admission, the allowance cap, the reap, the
 * shortlist, the gate check and the dispatcher are all found from the
 * program's own directory. The copy is no git checkout, so run() adopts no
 * newer code, and the morning review's root is the sandbox, with no config,
 * so no tick files a review on a real tracker.
 *
 * Loosen it and a frozen control reader handed to settleTick, or a run()
 * that keeps ticking past a stop, passes unseen.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { programLibs } from "./guard-parse-fixture";
import { runInProcessAsync } from "./lib/run-in-process.js";

/* One session, never a waker: an empty listing reads as unread, and a
 * listed waker holds its wake for the 10 s re-check. */
const LISTED = { sessionId: "other", kind: "background", state: "idle" };

let dir: string;
/* A run that outlived its stop is left its sandbox: deleting it under the
 * running loop exits the worker, hiding the failure. */
let outlived = false;
let scripts: string;
let repo: string;
let seat: string;

const at = (name: string) => path.join(dir, name);

const lines = (file: string) =>
	fs.existsSync(file)
		? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
		: [];

/** A node stub at `name` in the sandbox scripts/. */
const stub = (name: string, body: string) =>
	fs.writeFileSync(path.join(scripts, name), body);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-loop-run-"));
	scripts = at("code/scripts");
	fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
	for (const f of [
		"refill-loop.js",
		...programLibs("refill-loop.js").map((l) => `lib/${l}`),
	])
		fs.copyFileSync(path.join(__dirname, f), path.join(scripts, f));

	repo = at("repo");
	fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".claude", "workflow-core.json"), "{}\n");
	seat = at("seat");
	fs.mkdirSync(seat);
	// Fresh and low, so no tick probes /usage or waits on a full seat.
	fs.writeFileSync(
		path.join(seat, ".claude.json"),
		JSON.stringify({
			cachedUsageUtilization: {
				fetchedAtMs: Date.now(),
				utilization: {
					limits: [
						{ kind: "session", percent: 10 },
						{ kind: "weekly_all", percent: 10 },
					],
				},
			},
		}),
	);
	fs.writeFileSync(
		at(".refill-loop-control.json"),
		JSON.stringify({
			startedAt: Date.now(),
			stopRequested: false,
			seats: [seat],
			scope: { mode: "normal", repos: [repo], exclude: [], goals: {} },
		}),
	);
	// Swept just now, so no tick starts a gate sweep.
	fs.writeFileSync(
		at(".refill-gate-readings.json"),
		JSON.stringify({ lastSweepAt: Date.now() }),
	);

	stub(
		"admission.js",
		`require("node:fs").appendFileSync(${JSON.stringify(at("ticks"))}, "tick\\n");
process.stdout.write(JSON.stringify({ ok: true, slots: Number(process.env.FAKE_SLOTS) }));\n`,
	);
	stub(
		"allowance.js",
		"process.stdout.write(JSON.stringify({ cap: { launch: 1 } }));\n",
	);
	stub("reap-finished-sessions.js", "");
	stub("check-gates.js", "");
	stub(
		"pick-next.js",
		`process.stdout.write(JSON.stringify({
	frontier: [{ number: 5, urgent: false, goal: false, stallDays: 0, asksQuestions: false, reach: 0, collision: "", takes: ["implement"], labels: [] }],
	retroBundles: [],
	pulledIn: [],
	pulledInUnread: [],
}));\n`,
	);
	/* What `stop` writes: the control's flag, then a wake line. Not `stop`
	 * itself, which wakes only a loop whose pid's command line names the
	 * program, and this one runs inside the test worker. */
	const control = JSON.stringify(at(".refill-loop-control.json"));
	stub(
		"request-stop.js",
		`const fs = require("node:fs");
fs.writeFileSync(${control}, JSON.stringify({ ...JSON.parse(fs.readFileSync(${control}, "utf8")), stopRequested: true }));
fs.appendFileSync(${JSON.stringify(at(".refill-loop-wake"))}, \`\${Date.now()}\\n\`);\n`,
	);
	stub(
		"dispatch-sessions.sh",
		`printf '%s\\n' "$*" >> ${JSON.stringify(at("dispatches"))}
node ${JSON.stringify(path.join(scripts, "request-stop.js"))}\n`,
	);
	fs.writeFileSync(
		at("claude"),
		`#!/bin/bash\nif [ "$1" = "agents" ]; then echo '${JSON.stringify([LISTED])}'; exit 0; fi\nexit 1\n`,
		{ mode: 0o755 },
	);
});

afterEach(() => {
	if (!outlived) fs.rmSync(dir, { recursive: true, force: true });
	outlived = false;
});

const run = (slots: number) =>
	runInProcessAsync(path.join(scripts, "refill-loop.js"), ["run"], {
		cwd: dir,
		env: {
			...process.env,
			WFC_REFILL_DIR: dir,
			CLAUDE_PROJECT_DIR: dir,
			HOME: dir,
			CLAUDE_CONFIG_DIR: seat,
			WFC_CLAUDE_BIN: at("claude"),
			WFC_PRESENCE_MARKER: at("no-presence"),
			GITHUB_ACTIONS: "",
			FAKE_SLOTS: String(slots),
		},
	});

/* A guess: some 30 times a case's 0.7 s run, and well inside the loop's
 * fallback sleep (lib/refill-wake.js's FALLBACK_MS), so a loop still running
 * past it is waiting on that sleep, not ending. */
const SETTLE_MS = 20 * 1000;

const requestStop = () =>
	spawnSync(process.execPath, [path.join(scripts, "request-stop.js")]);

/** Whether `promise` settles inside SETTLE_MS, with its value where it does. */
const within = async <T>(promise: Promise<T>) => {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<{ done: false }>((resolve) => {
		timer = setTimeout(() => resolve({ done: false }), SETTLE_MS);
	});
	try {
		return await Promise.race([
			promise.then((value) => ({ done: true as const, value })),
			late,
		]);
	} finally {
		clearTimeout(timer);
	}
};

/**
 * `running`'s result, or a throw naming `what` once SETTLE_MS passes first. A
 * run still going is asked to stop once more and given SETTLE_MS again.
 */
const settled = async <T>(running: Promise<T>, what: string): Promise<T> => {
	const first = await within(running);
	if (first.done) return first.value;
	requestStop();
	outlived = !(await within(running)).done;
	throw new Error(`${what}: still running`);
};

/** Resolves once the stub admission has been asked `n` times. */
const ticked = async (n: number) => {
	const deadline = Date.now() + SETTLE_MS;
	while (lines(at("ticks")).length < n) {
		if (Date.now() > deadline) throw new Error(`tick ${n} never ran`);
		// A guess: short against a tick, cheap against the ceiling.
		await new Promise((r) => setTimeout(r, 50));
	}
};

const stopped = () =>
	JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8")).stopped;

describe("run (#2435)", () => {
	it("ends at the tick whose dispatch a stop landed in, recorded explicit", async () => {
		const r = await settled(run(1), "run after a mid-dispatch stop");
		expect(r.status).toBe(0);
		expect(lines(at("dispatches"))).toEqual(["opus /implement 5"]);
		expect(lines(at("ticks"))).toHaveLength(1);
		expect(stopped()).toMatchObject({ reason: "explicit" });
		// The sandbox has no file-morning-review.js: a run of it logs an exit.
		expect(r.stdout).not.toMatch(/morning review( reversals)?: exit/);
	});

	it("ticks on a wake line, logging its waker, and ends on a stop's wake", async () => {
		const running = run(0);
		await ticked(1);
		fs.appendFileSync(at(".refill-loop-wake"), `${Date.now()} waker-1\n`);
		await ticked(2);
		requestStop();
		const r = await settled(running, "run after a stop's wake");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("woken by waker-1");
		expect(r.stdout).not.toContain("the agents listing was unread");
		expect(lines(at("ticks"))).toHaveLength(3);
		expect(lines(at("dispatches"))).toEqual([]);
		expect(stopped()).toMatchObject({ reason: "explicit" });
	});
});
