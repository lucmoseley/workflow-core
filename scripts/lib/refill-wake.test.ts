// @vitest-environment node
/*
 * The refill loop's wake (#2313): the watcher's coalescing and the Stop hook
 * that feeds it. The hook runs as the real script on a
 * payload, against a sandboxed WFC_REFILL_DIR.
 *
 * Loosen the hook and every session's turn end wakes the loop; loosen the
 * watcher and wakes queue up ticks or are lost until the 300 s poll.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "./agent-liveness.js";
import { loopFiles } from "./refill-loop.js";
import type { TickResult, Wake } from "./refill-wake.js";
import { runTicks, touchWake, wakeWatcher } from "./refill-wake.js";

const HOOK = path.resolve(__dirname, "..", "refill-wake.sh");
const SID = "ba316c37-99bb-4b5e-b891-5887d70d174d";

/* Real time, as inotify delivers its events on the event loop; 200 ms is a
 * guess, standing in for the tick the wakes land during. */
const INOTIFY_SETTLE_MS = 200;
const inotifyDelivered = () =>
	new Promise((r) => setTimeout(r, INOTIFY_SETTLE_MS));

const ignore = (_line: string) => undefined;

let dir: string;
let wake: string;
/** The loop's own file names, so the hook is held to them. */
let files: ReturnType<typeof loopFiles>;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-wake-"));
	vi.stubEnv("WFC_REFILL_DIR", dir);
	files = loopFiles();
	wake = files.wake;
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

/* `background_tasks` and `session_crons` are shaped as Claude Code sends them
 * to a Stop hook. */
function runHook(sessionId: string, payload: object = {}) {
	return spawnSync("bash", [HOOK], {
		input: JSON.stringify({
			session_id: sessionId,
			hook_event_name: "Stop",
			background_tasks: [],
			session_crons: [],
			...payload,
		}),
		encoding: "utf8",
		env: { ...process.env, WFC_REFILL_DIR: dir },
	});
}

function writeLoop(launches: object[]) {
	fs.writeFileSync(files.pid, "1");
	fs.writeFileSync(files.state, JSON.stringify({ launches }));
}

const open = (fields: object) => ({
	jobId: "ffffffff",
	sessionId: null,
	finishedAt: null,
	...fields,
});

const wakeLines = () =>
	fs.existsSync(wake) ? fs.readFileSync(wake, "utf8").split("\n") : [];

describe("refill-wake.sh", () => {
	it("does nothing where the loop's pidfile is absent", () => {
		fs.writeFileSync(
			files.state,
			JSON.stringify({ launches: [open({ sessionId: SID })] }),
		);
		const r = runHook(SID);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.existsSync(wake)).toBe(false);
	});

	it("appends the session for an open launch matched by session id", () => {
		writeLoop([open({ sessionId: SID })]);
		const r = runHook(SID);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(wakeLines()[0]).toMatch(new RegExp(`^\\d{13} ${SID}$`));
	});

	it("matches a launch whose session id is not yet captured by its job id", () => {
		writeLoop([open({ jobId: SID.slice(0, 8) })]);
		runHook(SID);
		expect(wakeLines()[0]).toContain(SID);
	});

	it("does nothing for a session no open launch holds", () => {
		writeLoop([
			open({ sessionId: SID, finishedAt: 5 }),
			open({ sessionId: "other-session" }),
		]);
		const r = runHook(SID);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.existsSync(wake)).toBe(false);
	});

	it("does nothing on a turn end with background work still in flight", () => {
		writeLoop([open({ sessionId: SID })]);
		const r = runHook(SID, {
			background_tasks: [{ id: "ba5dof7o6", type: "shell", status: "running" }],
		});
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.existsSync(wake)).toBe(false);
	});

	it("does nothing on a turn end with a wake-up scheduled", () => {
		writeLoop([open({ sessionId: SID })]);
		runHook(SID, { session_crons: [{ id: "c1" }] });
		expect(fs.existsSync(wake)).toBe(false);
	});

	it.each([
		["result: #2365 closed", true],
		["needs input: Q1 (the retry limit)", true],
		["waiting: the suite run", false],
	])(
		"with background work in flight, wakes on a last line of %j: %s",
		(marker, wakes) => {
			writeLoop([open({ sessionId: SID })]);
			runHook(SID, {
				background_tasks: [
					{ id: "b4hr6dh8m", type: "shell", status: "running" },
				],
				last_assistant_message: `Closed it.\n\n${marker}\n`,
			});
			expect(fs.existsSync(wake)).toBe(wakes);
		},
	);

	it("wakes on a payload carrying neither field, as an older Claude Code sends", () => {
		writeLoop([open({ sessionId: SID })]);
		runHook(SID, { background_tasks: undefined, session_crons: undefined });
		expect(wakeLines()[0]).toContain(SID);
	});

	it("does nothing on an unreadable state file", () => {
		fs.writeFileSync(files.pid, "1");
		fs.writeFileSync(files.state, "{");
		expect(runHook(SID).status).toBe(0);
		expect(fs.existsSync(wake)).toBe(false);
	});
});

describe("wakeWatcher", () => {
	it("falls back to the poll where no wake lands", async () => {
		const w = wakeWatcher(wake, { log: ignore });
		try {
			expect(await w.next(50)).toEqual({ woken: false, sessions: [] });
		} finally {
			w.close();
		}
	});

	it("ends the sleep on a wake and names its session", async () => {
		const w = wakeWatcher(wake, { log: ignore });
		try {
			const next = w.next(10_000);
			touchWake(wake, SID);
			expect(await next).toEqual({ woken: true, sessions: [SID] });
		} finally {
			w.close();
		}
	});

	it("turns wakes landing during a tick into exactly one more tick", async () => {
		const w = wakeWatcher(wake, { log: ignore });
		try {
			touchWake(wake, "a");
			touchWake(wake);
			touchWake(wake, "b");
			await inotifyDelivered();
			expect(await w.next(10_000)).toEqual({
				woken: true,
				sessions: ["a", "b"],
			});
			expect(await w.next(100)).toEqual({ woken: false, sessions: [] });
		} finally {
			w.close();
		}
	});

	it("ignores a wake line written before it began watching", async () => {
		touchWake(wake, SID);
		const w = wakeWatcher(wake, { log: ignore });
		try {
			expect(await w.next(100)).toEqual({ woken: false, sessions: [] });
		} finally {
			w.close();
		}
	});
});

describe("wakeWatcher on a failed watch", () => {
	it.each([
		[
			"cannot start",
			() => {
				throw new Error("ENOSPC");
			},
		],
		[
			"fails later",
			(...args: Parameters<typeof fs.watch>) => {
				const w = fs.watch(...args);
				setImmediate(() => w.emit("error", new Error("EMFILE")));
				return w;
			},
		],
	])("logs and falls back to the poll where the watch %s", async (_, watch) => {
		const logged: string[] = [];
		const w = wakeWatcher(wake, {
			log: (line) => logged.push(line),
			watch: watch as typeof fs.watch,
		});
		try {
			await inotifyDelivered();
			touchWake(wake, SID);
			expect(await w.next(100)).toEqual({ woken: false, sessions: [] });
			expect(logged).toEqual([
				expect.stringMatching(/^wake watch failed, polling only: Error: E/),
			]);
		} finally {
			w.close();
		}
	});
});

describe("runTicks", () => {
	const agent = (sessionId: string, state: string) =>
		({
			id: sessionId.slice(0, 8),
			kind: "background",
			sessionId,
			state,
		}) as AgentRecord;
	const noWake: Wake = { woken: false, sessions: [] };
	const woken: Wake = { woken: true, sessions: [SID] };

	function ticks(results: TickResult[]) {
		const began: Wake[] = [];
		const tick = async (begun: Wake) => {
			began.push(begun);
			return results[began.length - 1];
		};
		return { began, tick };
	}

	function watcher(wakes: Wake[]) {
		const asked: number[] = [];
		return {
			asked,
			next: async (ms: number) => {
				asked.push(ms);
				return wakes[asked.length - 1];
			},
		};
	}

	it("sleeps the 300 s fallback between ticks, measured after each", async () => {
		const t = ticks([
			{ done: false, agents: [] },
			{ done: true, agents: [] },
		]);
		const w = watcher([noWake]);
		await runTicks(t.tick, w);
		expect(w.asked).toEqual([300_000]);
		expect(t.began).toEqual([noWake, noWake]);
	});

	it("re-checks once, after the delay, where the waking session is still listed working", async () => {
		const still = [agent(SID, "working")];
		const t = ticks([
			{ done: false, agents: [] },
			{ done: false, agents: still },
			{ done: false, agents: still },
			{ done: true, agents: [] },
		]);
		const w = watcher([woken, noWake]);
		const slept: number[] = [];
		await runTicks(t.tick, w, {
			sleep: async (ms) => slept.push(ms),
		});
		expect(slept).toEqual([10_000]);
		expect(t.began).toEqual([
			noWake,
			woken,
			{ ...woken, recheck: true },
			noWake,
		]);
		expect(w.asked).toHaveLength(2);
	});

	it.each([
		["listed done", [agent(SID, "done")]],
		["parked on a question", [agent(SID, "blocked")]],
		["not listed", [agent("other-session", "working")]],
		["on an unread listing", null],
	])("does not re-check where the waking session is %s", async (_, agents) => {
		const t = ticks([
			{ done: false, agents: [] },
			{ done: false, agents },
			{ done: true, agents: [] },
		]);
		const slept: number[] = [];
		await runTicks(t.tick, watcher([woken, noWake]), {
			sleep: async (ms) => slept.push(ms),
		});
		expect(slept).toEqual([]);
	});

	it("gives a wake landing during a tick exactly one more tick, straight after", async () => {
		const w = wakeWatcher(wake, { log: ignore });
		const t = ticks([
			{ done: false, agents: [] },
			{ done: false, agents: [] },
			{ done: true, agents: [] },
		]);
		const tick = async (begun: Wake) => {
			if (t.began.length === 0) {
				touchWake(wake, "a");
				touchWake(wake, "b");
				await inotifyDelivered();
			}
			return t.tick(begun);
		};
		try {
			await runTicks(tick, w, { fallbackMs: 50 });
		} finally {
			w.close();
		}
		expect(t.began).toEqual([
			noWake,
			{ woken: true, sessions: ["a", "b"] },
			noWake,
		]);
	});
});
