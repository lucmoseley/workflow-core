// @vitest-environment node
/*
 * watch-artefact.test.ts — the watcher's verdicts, read the way the parent
 * session reads them: the stdout verdict line and the exit code (#539).
 *
 * KEEPS A SPAWN (§X3): a verdict case runs two things at once, the watcher and
 * the test growing its artefact on a timeline of its own, and runInProcess
 * refuses overlapping async work. The refusal cases spawn too: the script's
 * entry is async, so in-process its crash handler would reach the worker's
 * real process.exit after runInProcess had restored it.
 *
 * The timeline starts when the watcher prints its start line, which follows
 * its baseline, so every event lands half an interval from the nearest check. A case that fails only under heavy load is that margin
 * running out, not the verdict changing.
 *
 * A parent session abandons a subagent on `STALLED` or `MISSING`, as the
 * `pick-next` and `concision-pass` skills direct: loosen a case and a working
 * agent is abandoned, or a stalled one is waited on until the ceiling.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "watch-artefact.js");
const POLL_GUARD = join(__dirname, "guard-agent-poll.js");

const EXIT = { USAGE: 2, STALLED: 3, MISSING: 4, CEILING: 5 };

/** The check interval, in seconds — a guess at a margin wide enough that a
 * check and a write do not race on a loaded machine, never measured. */
const INTERVAL_S = 0.5;
const CHUNK = "0123456789";

let root: string;
let artefact: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "watch-artefact-test-"));
	artefact = join(root, "artefact.md");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the watcher, and once it has taken its baseline calls each step at its
 * offset in intervals.
 */
function watch(
	args: string[],
	steps: [at: number, act: () => void][] = [],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [SCRIPT, ...args]);
		const timers: NodeJS.Timeout[] = [];
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			const started = stderr === "";
			stderr += d;
			if (started)
				for (const [at, act] of steps)
					timers.push(setTimeout(act, at * INTERVAL_S * 1000));
		});
		child.on("close", (status) => {
			for (const t of timers) clearTimeout(t);
			resolve({ status, stdout, stderr });
		});
	});
}

const grow = () => appendFileSync(artefact, CHUNK);

describe("verdicts", () => {
	it("stalls after exactly two checks without growth, one being not enough", async () => {
		writeFileSync(artefact, "");
		// Checks at 1..5 intervals: grow, idle, grow, idle, idle. One idle
		// check stalling would stop at size 10; three would see the 5.5 write.
		const r = await watch(
			[artefact, String(INTERVAL_S)],
			[
				[0.5, grow],
				[2.5, grow],
				[5.5, grow],
			],
		);
		expect(r.status).toBe(EXIT.STALLED);
		expect(r.stdout).toMatch(
			new RegExp(
				`^STALLED ${artefact} size=20 last-growth=\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z — .*abandon`,
			),
		);
	}, 15_000);

	it("reports a still-growing artefact at the ceiling as CEILING, not a stall", async () => {
		writeFileSync(artefact, "");
		const steps: [number, () => void][] = [];
		for (let at = 0.25; at < 6; at += 0.5) steps.push([at, grow]);
		const r = await watch(
			[artefact, String(INTERVAL_S), String(4 * INTERVAL_S)],
			steps,
		);
		expect(r.status).toBe(EXIT.CEILING);
		expect(r.stdout).toMatch(
			new RegExp(
				`^CEILING ${artefact} size=\\d+ last-growth=\\d{4}-.* — .*before two checks without growth; re-run the watch`,
			),
		);
	}, 15_000);

	it("reports an artefact absent throughout as MISSING, distinct from a stall", async () => {
		const r = await watch([artefact, "0.1"]);
		expect(r.status).toBe(EXIT.MISSING);
		expect(r.stdout).toMatch(
			new RegExp(
				`^MISSING ${artefact} size=absent last-growth=none — .*never written, deleted`,
			),
		);
	});

	it("watches a file that appears after one absent check as it would any other", async () => {
		const r = await watch([artefact, String(INTERVAL_S)], [[1.5, grow]]);
		expect(r.status).toBe(EXIT.STALLED);
		expect(r.stdout).toMatch(
			new RegExp(`^STALLED ${artefact} size=10 .* — .*abandon`),
		);
	}, 15_000);

	it("reports an artefact deleted after growing as MISSING once absent at two checks", async () => {
		const r = await watch(
			[artefact, String(INTERVAL_S)],
			[
				[0.5, grow],
				[1.5, () => rmSync(artefact)],
			],
		);
		expect(r.status).toBe(EXIT.MISSING);
		expect(r.stdout).toMatch(new RegExp(`^MISSING ${artefact} size=absent `));
	}, 15_000);

	it("calls one idle check then one absent check a stall, not MISSING", async () => {
		writeFileSync(artefact, CHUNK);
		const r = await watch(
			[artefact, String(INTERVAL_S)],
			[[1.5, () => rmSync(artefact)]],
		);
		expect(r.status).toBe(EXIT.STALLED);
		expect(r.stdout).toMatch(new RegExp(`^STALLED ${artefact} size=absent `));
	}, 15_000);
});

describe("a bad invocation", () => {
	it.each([
		["no path", []],
		["a zero interval", ["x", "0"]],
		["a non-numeric ceiling", ["x", "1", "soon"]],
	])("refuses %s with exit 2, printing no verdict", (_label, args) => {
		const r = spawnSync(process.execPath, [SCRIPT, ...args], {
			encoding: "utf8",
		});
		expect(r.status).toBe(EXIT.USAGE);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(/^watch-artefact: .*\nusage: /);
	});
});

describe("the poll guard (guard-agent-poll.js)", () => {
	/** Feeds the guard one Bash call, with its state and fail-open log private. */
	const pollGuard = (command: string) =>
		spawnSync(POLL_GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "s1",
				tool_name: "Bash",
				tool_input: { command },
			}),
			env: {
				...process.env,
				TMPDIR: join(root, "tmp"),
				CLAUDE_CONFIG_DIR: join(root, "claude-config"),
			},
		});
	const state = () => join(root, "tmp", "wfc-agent-poll", "s1");

	beforeEach(() => mkdirSync(join(root, "tmp")));

	it("never counts or refuses the watcher's invocation, however often it runs", () => {
		for (let i = 0; i < 5; i++) {
			const r = pollGuard(`node scripts/watch-artefact.js ${artefact} 120`);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
		}
		expect(existsSync(state())).toBe(false);
	});

	it("does count the hand-rolled timed check the watcher replaces", () => {
		expect(pollGuard(`sleep 120; wc -c ${artefact}`).status).toBe(0);
		expect(existsSync(state())).toBe(true);
	});
});
