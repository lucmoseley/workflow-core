// @vitest-environment node
/*
 * Holds lib/arm-claude-fake.ts, the in-process `claude` lib/run-arm.js's
 * module cases run on (#5149), to the production adapter, lib/child-spawn.js's
 * `spawnRaw`. One case list reads each call through lib/arm-claude.js, the
 * calls run-arm.js makes: run against the fake; against `spawnRaw` on a
 * `claude` stub printing
 * the installed harness's recordings (scripts/fixtures/agents-stop.json,
 * scripts/fixtures/bg-launch.json), which lib/agents-stop.contract.test.ts
 * and lib/bg-launch.contract.test.ts hold to the harness; and, on the
 * founder's machine, against the real `claude` where a call is free. Breaking
 * it costs the runner's module cases their meaning: a listing, launch or stop
 * the fake answers as the harness never would passes a case the runner fails
 * on a night's runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAgentsBranch,
	buildJobRow,
	buildStopBranch,
	recorded,
} from "./agents-stop-fake";
import {
	createArmClaudeFake,
	FAKE_VERSION,
	launchedJob,
} from "./arm-claude-fake";
import { REFUSED_AUTH } from "./auth-status-fake";
import { buildAnswerBranch, buildRecordedAnswer } from "./bg-launch-fake";
import {
	buildVersionBranch,
	claudeLiveSkipReason,
	writeClaudeStub,
} from "./claude-stub";

const { spawnRaw } = require("./child-spawn.js");
const { stopOn } = require("./claude-stop.js");
const { readClaudeVersionOrWhy } = require("./claude-version.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const arm = require("./arm-claude.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "arm-claude-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const STOP_ID = recorded.stops.ok.id;
const NO_JOB_ID = recorded.stops.noJob.id;

const portsOn = (spawn: unknown) => ({
	env: { ...process.env, PATH: process.env.PATH },
	claude: spawn,
	node: () => {
		throw new Error("no node program in a claude contract case");
	},
	clock: () => 0,
	now: () => 0,
	sleep: () => undefined,
	out: () => undefined,
	err: () => undefined,
	hostRoot: () => dir,
});

/**
 * The stub's `--bg` branch: the recorded positional launch, naming job
 * `launchedJob(1)` as the fake's first launch does.
 */
const bgBranch = () => {
	const { stdout, stderr } = buildRecordedAnswer(launchedJob(1), "positional");
	return `if [ "$1" = "--bg" ]; then ${buildAnswerBranch({ status: 0, stdout, stderr })}; fi`;
};

interface Side {
	bin: string;
	spawn: unknown;
}

const stubSide = (rows: object[] | null): Side => {
	const log = path.join(dir, "stops");
	const bin = writeClaudeStub(path.join(dir, "claude"), [
		buildVersionBranch(recorded.harness),
		buildAgentsBranch(rows === null ? null : (rows as never)),
		buildStopBranch(log, { [path.join(dir, "gone")]: "noJob" }),
		bgBranch(),
	]);
	return { bin, spawn: spawnRaw };
};

const fakeSide = (rows: object[] | null): Side => {
	const fake = createArmClaudeFake({
		listing: () => rows as never,
		stop: (job) => (job === NO_JOB_ID ? "noJob" : "ok"),
	});
	return { bin: path.join(dir, "claude"), spawn: fake.spawn };
};

const ROWS = [
	buildJobRow("j-working", "working"),
	buildJobRow("j-done", "done"),
	buildJobRow("j-blocked", "blocked"),
];

const verdicts = (side: Side) => {
	const p = portsOn(side.spawn);
	const version = readClaudeVersionOrWhy(side.bin, side.spawn);
	const seat = path.join(dir, "seat");
	fs.mkdirSync(seat, { recursive: true });
	const states = arm.readJobStates(p, seat, side.bin);
	const stop = stopOn(seat, STOP_ID, side.bin, { spawn: side.spawn });
	const gone = stopOn(path.join(dir, "gone"), NO_JOB_ID, side.bin, {
		spawn: side.spawn,
	});
	const sandbox = path.join(dir, "sandbox");
	fs.mkdirSync(path.join(sandbox, "bin"), { recursive: true });
	const started = arm.start(
		{ ...p, env: { ...process.env, CLAUDE_CODE_SESSION_ID: "" } },
		{ id: "r1", configDir: seat, sandbox },
		{ repo: dir, prompt: "/implement 1" },
		side.bin,
	);
	return {
		version: "version" in version,
		states: states && [...states].map(([id, j]) => [id, j.state, j.kind]),
		stop: { ok: stop.ok, noJob: stop.noJob ?? false },
		gone: { ok: gone.ok, noJob: gone.noJob },
		job: started.ok ? started.record.job : started.why,
	};
};

describe.each([
	["a listing of the recorded states", ROWS],
	["an unreadable listing", null],
] as const)("%s", (_, rows) => {
	it("reads the same off the fake as off the recording", () => {
		const fromStub = verdicts(stubSide(rows as never));
		const fromFake = verdicts(fakeSide(rows as never));
		expect(fromFake).toEqual(fromStub);
		expect(fromStub.version).toBe(true);
		expect(fromStub.stop).toEqual({ ok: true, noJob: false });
		expect(fromStub.gone).toEqual({ ok: false, noJob: true });
		expect(fromStub.job).toBe(launchedJob(1));
		expect(fromStub.states === null).toBe(rows === null);
	});
});

it("refuses each launch environment the auth fake refuses, as the stub's does", () => {
	for (const [, env] of REFUSED_AUTH)
		for (const side of [stubSide(ROWS), fakeSide(ROWS)])
			expect(
				launchAuthRefusal({
					bin: side.bin,
					env: { ...process.env, ...env },
					cwd: dir,
					spawn: side.spawn,
				}),
			).toContain("would not bill the subscription");
});

it("prints no version for a binary named silent, as a stub exiting 1 does", () => {
	const silent = path.join(dir, "silent");
	writeClaudeStub(silent, []);
	const fake = createArmClaudeFake({ silent: [silent] });
	expect(readClaudeVersionOrWhy(silent, fake.spawn)).toEqual(
		readClaudeVersionOrWhy(silent, spawnRaw),
	);
});

it("prints its version in the harness's form", () => {
	const fake = createArmClaudeFake();
	expect(readClaudeVersionOrWhy("claude", fake.spawn)).toEqual({
		version: FAKE_VERSION,
	});
});

/* The suite's scratch CLAUDE_CONFIG_DIR (#838) holds no login, so the real
 * binary reads logged out there: the fake's no-login mode stands beside it. */
describe("against the real claude", () => {
	const skip = claudeLiveSkipReason();
	it.skipIf(skip !== undefined)(
		`reads the version, auth and listing as off the fake${skip ? ` (skipped: ${skip})` : ""}`,
		() => {
			const seat = path.join(dir, "seat");
			fs.mkdirSync(seat);
			const env = { ...process.env, CLAUDE_CONFIG_DIR: seat };
			const fake = createArmClaudeFake({ listing: () => [] });
			const read = (spawn: unknown) => {
				const states = arm.readJobStates(portsOn(spawn), seat, "claude");
				return {
					version: "version" in readClaudeVersionOrWhy("claude", spawn),
					auth: launchAuthRefusal({
						bin: "claude",
						env: { ...env, WFC_FAKE_AUTH_NO_LOGIN: "1" },
						cwd: dir,
						spawn,
					}),
					listing: states && [...states.keys()],
				};
			};
			const live = read(spawnRaw);
			expect(read(fake.spawn)).toEqual(live);
			expect(live.version).toBe(true);
			expect(live.auth).toContain("the seat is not logged in");
		},
	);
});
