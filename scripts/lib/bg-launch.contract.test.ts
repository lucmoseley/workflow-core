// @vitest-environment node
/*
 * Holds the readers of a fresh `claude --bg <flags> -- <prompt>` and of
 * `claude rm <id>` (#4343) — lib/seat-claude.js's verdict, which
 * guard-main-checkout-job.js acts on, and lib/bg-launch-id.sh's job id, which
 * start-session.sh attaches to and dispatch-sessions.sh records — to one case list, run against the installed
 * harness's recorded answers (scripts/fixtures/bg-launch.json, re-recorded by
 * `node scripts/record-claude-responses.js`), against lib/bg-launch-fake.ts,
 * which those programs' and run-arm-test.js's suites' `claude` stubs print, and, on the
 * founder's machine, against the real `claude` where a call is free. Breaking
 * it costs the relaunch out of the main checkout: an answer the guard
 * misreads leaves two jobs on one prompt, or the original unremoved, an id
 * start-session.sh misreads attaches to no job, and one dispatch-sessions.sh
 * misreads records a launch pick-next.js cannot find alive.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAnswerBranch,
	buildLaunchNodeAnswer,
	buildRmBranch,
	type LaunchKind,
	type RmKind,
	recorded,
	writeLaunchAnswer,
} from "./bg-launch-fake";
import {
	buildBgBranch,
	claudeLiveSkipReason,
	writeClaudeStub,
} from "./claude-stub";
import { buildSeatEnv, runClaude } from "./seat-claude.js";
import { shellQuote } from "./sh-quote.js";

const ID_READER = path.join(__dirname, "bg-launch-id.sh");
const FAKE_ID = "ab12cd34";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-launch-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** `claude <args>` as guard-main-checkout-job.js runs it, on a stub whose
 * body is `lines`, or on `bin`. */
const runOn = (args: string[], lines: string[], bin?: string) =>
	runClaude(args, {
		env: buildSeatEnv(process.env, dir),
		bin: bin ?? writeClaudeStub(path.join(dir, "claude"), lines, 9),
	});

/** The job id start-session.sh reads off a launch's stdout. */
const readLaunchId = (stdout: string) =>
	spawnSync("bash", ["-c", `source ${shellQuote(ID_READER)}; bg_launch_id`], {
		input: `${stdout}\n`,
		encoding: "utf8",
	}).stdout.trim();

/* Each kind's marking flag and, where its program fixes it, the flag's
 * place; `positional` carries none. */
const launchCases: {
	kind: LaunchKind;
	flag?: string;
	at?: number;
	prompted: boolean;
}[] = [
	{ kind: "prompted", flag: "--", at: -2, prompted: true },
	{ kind: "idle", flag: "--name", at: -2, prompted: false },
	{ kind: "positional", prompted: true },
	{ kind: "named", flag: "-n", prompted: true },
];
const MARKS = ["--", "--name", "-n"];
const PROMPT = recorded.launches.prompted.argv.at(-1);

describe.each(launchCases)(
	"the $kind launch",
	({ kind, flag, at, prompted }) => {
		const r = recorded.launches[kind];

		it("was recorded in its program's shape", () => {
			expect(r.argv[0]).toBe("--bg");
			expect(r.argv.filter((a) => MARKS.includes(a))).toEqual(
				flag ? [flag] : [],
			);
			if (at !== undefined) expect(r.argv.at(at)).toBe(flag);
			expect(r.argv.at(-1) === PROMPT).toBe(prompted);
			expect(r.status).toBe(0);
		});

		it(`reads ${recorded.harness}'s recorded answer`, () => {
			const read = runOn(r.argv, [buildAnswerBranch(r)]);
			expect(read.failed).toBeNull();
			expect(readLaunchId(read.stdout)).toBe(r.id);
		});

		it("reads the fake of it", () => {
			const read = runOn(r.argv, [
				buildBgBranch(writeLaunchAnswer(dir, FAKE_ID, kind)),
			]);
			expect(read.failed).toBeNull();
			expect(readLaunchId(read.stdout)).toBe(FAKE_ID);
		});

		it("reads the Node stub's fake of it", () => {
			const bin = path.join(dir, "claude.js");
			fs.writeFileSync(
				bin,
				`#!/usr/bin/env node\n${buildLaunchNodeAnswer(JSON.stringify(FAKE_ID), kind)}\n`,
				{ mode: 0o755 },
			);
			const read = runOn(r.argv, [], bin);
			expect(read.failed).toBeNull();
			expect(readLaunchId(read.stdout)).toBe(FAKE_ID);
		});
	},
);

/* A name after the id may hold a hex run of its own. */
it("reads the job id, not a hex run in the name after it", () => {
	expect(
		readLaunchId(`backgrounded · ${FAKE_ID} · Overflow · /wayfinder deadbeef`),
	).toBe(FAKE_ID);
});

/* A launch on a terminal colours its id. */
it("reads a job id between colour escapes", () => {
	expect(
		readLaunchId(
			`backgrounded · \u001b[36m${FAKE_ID}\u001b[39m · a-name (idle — send a prompt to start)`,
		),
	).toBe(FAKE_ID);
});

const removalCases: { kind: RmKind; ok: boolean }[] = [
	{ kind: "ok", ok: true },
	{ kind: "noJob", ok: false },
];

describe.each(removalCases)("the $kind removal", ({ kind, ok }) => {
	it(`reads ${recorded.harness}'s recorded answer`, () => {
		const r = recorded.removals[kind];
		expect(runOn(["rm", r.id], [buildAnswerBranch(r)]).failed === null).toBe(
			ok,
		);
	});

	it("reads the fake of it", () => {
		const r = runOn(["rm", FAKE_ID], [buildRmBranch(kind)]);
		expect(r.failed === null).toBe(ok);
		if (!ok) expect(r.out).toContain(FAKE_ID);
	});
});

/*
 * The free call, against the installed `claude` on the case's own empty
 * config dir: a removal of an id no daemon issued (§G7.2). The launch and a
 * live removal have no live case: each starts or ends a session.
 */
// Residual: off the founder's machine this skips, and the fixture goes unchecked.
it.skipIf(claudeLiveSkipReason())(
	"the installed claude answers a removal of no job as the recording does",
	() => {
		const { id } = recorded.removals.noJob;
		const r = runOn(["rm", id], [], "claude");
		expect(r.failed).not.toBeNull();
		expect(r.out).toBe(
			`${recorded.removals.noJob.stdout}${recorded.removals.noJob.stderr}`.trim(),
		);
	},
	30_000,
);
