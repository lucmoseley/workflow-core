// @vitest-environment node

import { spawnSync } from "node:child_process";
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
import { keptSpawn } from "./lib/kept-spawn.js";
import { escapeRe } from "./lib/regex-group.js";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = join(__dirname, "watch-artefact.js");
const POLL_GUARD = join(__dirname, "guard-dispatch.js");

const EXIT = { USAGE: 2, STALLED: 3, MISSING: 4, CEILING: 5, DONE: 6 };

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

function watch(
	args: string[],
	steps: [at: number, act: () => void][] = [],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = keptSpawn("concurrent").spawn(process.execPath, [
			SCRIPT,
			...args,
		]);
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

	it("reports an artefact never written as MISSING at the first-write deadline, not before", async () => {
		const r = await watch([artefact, "0.1", "--first-write", "0.6"]);
		expect(r.status).toBe(EXIT.MISSING);
		expect(r.stdout).toMatch(
			new RegExp(
				`^MISSING ${artefact} size=absent last-growth=none — .*never written by the first-write deadline`,
			),
		);
	});

	it("draws no MISSING from an agent whose first write lands late but inside the deadline (#4034)", async () => {
		const r = await watch(
			[artefact, String(INTERVAL_S), "--first-write", String(5 * INTERVAL_S)],
			[[3.5, grow]],
		);
		expect(r.status).toBe(EXIT.STALLED);
		expect(r.stdout).toMatch(new RegExp(`^STALLED ${artefact} size=10 `));
	}, 15_000);

	it("raises a first-write deadline under two intervals to two", async () => {
		const r = await watch([artefact, "0.2", "--first-write", "0.05"]);
		expect(r.stderr).toContain("first write by 0.4s");
		expect(r.status).toBe(EXIT.MISSING);
	});

	it("sets a 600 s first-write deadline by default", async () => {
		const child = keptSpawn("signal").spawn(process.execPath, [
			SCRIPT,
			artefact,
			"120",
		]);
		const line = await new Promise<string>((resolve) => {
			let err = "";
			child.stderr.on("data", (d) => {
				err += d;
				if (err.includes("\n")) resolve(err);
			});
		});
		child.kill();
		expect(line).toContain("first write by 600s");
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

describe("reading the agent's own log (#5421)", () => {
	const record = (row: unknown) => `${JSON.stringify(row)}\n`;
	const toolCall = record({
		type: "assistant",
		message: {
			content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
			stop_reason: "tool_use",
		},
	});
	const toolResult = record({
		type: "user",
		message: { content: [{ type: "tool_result", tool_use_id: "t1" }] },
	});
	const turnEnd = record({
		type: "assistant",
		message: {
			content: [{ type: "text", text: "done" }],
			stop_reason: "end_turn",
		},
	});
	let log: string;
	beforeEach(() => {
		log = join(root, "agent-a1.jsonl");
		writeFileSync(artefact, CHUNK);
	});

	const CeilingS = 4.5 * INTERVAL_S;
	const watchLog = () =>
		watch([artefact, String(INTERVAL_S), String(CeilingS), "--log", log]);

	it.each([
		["an unanswered tool call", toolCall],
		["a tool result no assistant record follows", toolCall + toolResult],
	])(
		"never stalls an unchanging artefact while the log ends on %s, reaching the ceiling",
		async (_name, text) => {
			writeFileSync(log, text);
			const r = await watchLog();
			expect(r.status).toBe(EXIT.CEILING);
			expect(r.stderr).toContain(
				`reading the agent log ${log}, DONE once it reads stopped`,
			);
		},
		15_000,
	);

	const handback = record({
		type: "assistant",
		message: {
			content: [
				{ type: "tool_use", id: "h1", name: "SubagentHandback", input: {} },
			],
			stop_reason: "tool_use",
		},
	});
	const handbackResult = record({
		type: "user",
		message: { content: [{ type: "tool_result", tool_use_id: "h1" }] },
	});

	it.each([
		[
			"a turn with no tool call",
			() => writeFileSync(log, toolCall + toolResult + turnEnd),
		],
		[
			"a SubagentHandback result",
			() =>
				writeFileSync(log, toolCall + toolResult + handback + handbackResult),
		],
		[
			"a tool result, its meta file marking it finished",
			() => {
				writeFileSync(log, toolCall + toolResult);
				writeFileSync(join(root, "agent-a1.meta.json"), '{"finished":true}');
			},
		],
	])(
		"ends DONE at the start, never STALLED, on a log ending on %s (#5496)",
		async (_name, write) => {
			write();
			const r = await watchLog();
			expect(r.status).toBe(EXIT.DONE);
			expect(r.stdout).toMatch(
				new RegExp(
					`^DONE ${artefact} size=10 last-growth=none — the agent has stopped; read its report`,
				),
			);
		},
		15_000,
	);

	it("never ends DONE or STALLED on an agent paused on background work of its own, reaching the ceiling (#5554)", async () => {
		const bashCall = record({
			type: "assistant",
			isSidechain: true,
			message: {
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Bash",
						input: { command: "npm test", run_in_background: true },
					},
				],
				stop_reason: "tool_use",
			},
		});
		const launched = record({
			type: "user",
			isSidechain: true,
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "Command running in background with ID: b1.",
					},
				],
			},
		});
		writeFileSync(log, bashCall + launched + turnEnd);
		writeFileSync(join(root, "agent-a1.meta.json"), '{"finished":true}');
		const r = await watchLog();
		expect(r.status).toBe(EXIT.CEILING);
		expect(
			r.stderr.match(/paused on background work of its own/g),
		).toHaveLength(1);
	}, 15_000);

	it("ends DONE between checks, before any check or the ceiling, naming the size then (#5496)", async () => {
		writeFileSync(log, toolCall);
		const r = await watch(
			[artefact, "8", "4", "--log", log],
			[
				[1, grow],
				[2, () => appendFileSync(log, toolResult + turnEnd)],
			],
		);
		expect(r.status).toBe(EXIT.DONE);
		expect(r.stdout).toMatch(new RegExp(`^DONE ${artefact} size=20 `));
	}, 15_000);

	it("falls back to growth alone on a malformed log, saying so once", async () => {
		writeFileSync(log, "not json\n");
		const r = await watchLog();
		expect(r.status).toBe(EXIT.STALLED);
		expect(r.stderr.match(/judging on growth alone/g)).toEqual([
			"judging on growth alone",
		]);
		expect(r.stderr).toContain(`${log} holds no turn record`);
	}, 15_000);

	describe("on the log alone, for a dispatch with no artefact", () => {
		const watchLogOnly = (steps: [at: number, act: () => void][] = []) =>
			watch(
				["--no-artefact", String(INTERVAL_S), String(CeilingS), "--log", log],
				steps,
			);

		it("ends DONE once the log reads stopped", async () => {
			writeFileSync(log, toolCall);
			const r = await watchLogOnly([
				[1, () => appendFileSync(log, toolResult + turnEnd)],
			]);
			expect(r.status).toBe(EXIT.DONE);
			expect(r.stdout).toMatch(
				new RegExp(
					`^DONE ${escapeRe(log)} — the agent has stopped; read its report`,
				),
			);
		}, 15_000);

		it.each([
			["a call in flight", () => writeFileSync(log, toolCall)],
			["no log yet, never MISSING", () => rmSync(log, { force: true })],
		])(
			"ends CEILING on %s",
			async (_name, write) => {
				write();
				const r = await watchLogOnly();
				expect(r.status).toBe(EXIT.CEILING);
				expect(r.stdout).toMatch(new RegExp(`^CEILING ${escapeRe(log)} — `));
			},
			15_000,
		);

		it("keeps reading a malformed log to the ceiling, saying so once", async () => {
			writeFileSync(log, "not json\n");
			const r = await watchLogOnly();
			expect(r.status).toBe(EXIT.CEILING);
			expect(r.stderr.match(/still reading it/g)).toEqual(["still reading it"]);
			expect(r.stderr).toContain(`${log} holds no turn record`);
		}, 15_000);
	});

	it("says on its start line when no log is read", async () => {
		const r = await watch([artefact, String(INTERVAL_S)]);
		expect(r.stderr).toContain("on growth alone, no agent log");
	}, 15_000);
});

describe("a bad invocation", () => {
	it.each([
		["no path", []],
		["a zero interval", ["x", "0"]],
		["a non-numeric ceiling", ["x", "1", "soon"]],
		["a zero first-write deadline", ["x", "1", "--first-write", "0"]],
		["an empty agent log", ["x", "1", "--log="]],
	])("refuses %s with exit 2, printing no verdict", async (_label, args) => {
		const r = await runInProcessAsync(SCRIPT, args);
		expect(r.status).toBe(EXIT.USAGE);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(/^watch-artefact: .*\nusage: /);
	});

	it.each([
		["no log", ["--no-artefact", "1"], "--no-artefact needs --log"],
		[
			"no ceiling",
			["--no-artefact", "1", "--log", "l"],
			"--no-artefact needs a ceiling",
		],
		[
			"a path",
			["--no-artefact", "x", "1", "2", "--log", "l"],
			"--no-artefact takes no artefact path",
		],
		[
			"a first-write deadline",
			["--no-artefact", "1", "--log", "l", "--first-write", "5"],
			"--no-artefact has no first write to wait on",
		],
	])(
		"refuses a log-only watch given %s, saying why",
		async (_label, args, why) => {
			const r = await runInProcessAsync(SCRIPT, args);
			expect(r.status).toBe(EXIT.USAGE);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(
				new RegExp(`^watch-artefact: ${escapeRe(why)}\n`),
			);
		},
	);
});

describe("the poll guard (guard-dispatch.js's guard-agent-poll core)", () => {
	const pollGuard = (command: string) =>
		spawnSync(POLL_GUARD, [], {
			encoding: "utf8",
			input: JSON.stringify({
				hook_event_name: "PreToolUse",
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
