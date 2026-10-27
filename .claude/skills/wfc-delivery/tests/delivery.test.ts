/*
 * Pins that the delivery mod forks deliver-to-session.js only inside a
 * main-loop turn, and there only when a watched store changes or its 10-minute
 * CI interval comes round, offers each non-empty report once as a row the
 * model reads, obeys its floor and its two loads, and reads no repo-wide
 * switch (#854, #855, #856, #944, #1467, #3247).
 *
 * The mod's own seam (#849 §Testing Decisions, seam 2), run by
 * `claude plugin test .claude/skills/wfc-delivery`. The ordinary vitest suite
 * never collects it: `claude-code/testing` exists only under that runner.
 * The hooks `world()` registers stand for the engine.
 *
 * THE TEST'S `session.append` HOOK SEES EVERY ROW THE MOD APPENDS FROM
 * 2.1.293 ONLY (#896).
 *
 * `test`, not §X1's `it`: the kit exports no `it`.
 *
 * .husky/pre-push refuses a push touching the mod on a failure here
 * (scripts/run-mod-tests.js, #857), and ci.yml's `Mod tests` step reddens the
 * sweep on one (#1854); nothing else runs these tests. Loosen a case and a mod that drops, repeats or never fetches a report reaches every
 * adopter loading the plugin.
 */

import type { On } from "claude-code";
import { describe, expect, mock, test } from "claude-code/testing";
import { register } from "../hooks/register";

const TICK = 30_000;
const CWD = "/repo";
const CI_INTERVAL = 10 * 60_000;
const PATHS = JSON.stringify({
	notifyReports: "/store",
	requests: "/req",
	locks: "/locks",
});
const REPORT = "▸ ci-status\nmain is red at a1b2c3d";
const REQUEST =
	"▸ release-request\nAnother session is waiting on a file this one holds:";

interface World {
	version?: string;
	/** What each `--reports` run prints, in order; then nothing. */
	prints?: string[];
	/** What each `--requests` run prints, in order; then nothing. */
	requestPrints?: string[];
	/** Which `--reports` runs (1-based) reject. */
	failRuns?: number[];
	/** What each `--ci` run prints, in order; then nothing. */
	ciPrints?: string[];
	/** Which `--ci` runs (1-based) time out. */
	failCiRuns?: number[];
	/** Which appends (1-based) reject. */
	failAppends?: number[];
	/** Which appends (1-based) a plugin above refuses. */
	denyAppends?: number[];
	/** Whether the repo carries the mod's own `.claude/skills/wfc-delivery/`. */
	hasLocalCopy?: boolean;
	/** Held open until the test releases it: the first `--reports` run. */
	heldRun?: Promise<void>;
}

function world(on: On, w: World = {}) {
	const clock = mock.clock(on);
	const seen = {
		reportRuns: 0,
		requestRuns: 0,
		ciRuns: 0,
		ciTimeouts: [] as (number | undefined)[],
		pathRuns: 0,
		stats: 0,
		submits: 0,
		mtime: { "/store": 1, "/req": 1, "/locks": 1 } as Record<string, number>,
		logs: [] as string[],
		appendCalls: 0,
		/** The text of each row appended, rejected and refused ones aside. */
		rows: [] as string[],
		/** Each path whose existence is asked, in order. */
		exists: [] as string[],
		/** Each `--paths` run, as `<plugin> <script> in <cwd> as <session id>`. */
		scripts: [] as string[],
		forks: () =>
			seen.pathRuns + seen.reportRuns + seen.requestRuns + seen.ciRuns,
	};
	const prints = [...(w.prints ?? [])];
	const requestPrints = [...(w.requestPrints ?? [])];
	const ciPrints = [...(w.ciPrints ?? [])];
	const heldRuns = w.heldRun === undefined ? [] : [w.heldRun];
	// A call on `$` is answered `{ value }`; `{ deny }` rejects the caller.
	on("session.version", () => ({
		value: { version: w.version ?? "2.1.289" } as never,
	}));
	on("session.id", () => ({ value: "s-1" }));
	on("session.surfaces", () => ({ value: [] }));
	on("ui.toast", () => ({ value: undefined }));
	on("ui.log", (_$, e) => {
		seen.logs.push(e.text);
		return { value: undefined };
	});
	on("session.start", (_$, e) => ({ cwd: e.cwd }));
	on("turn.start", (_$, e) => ({ turnId: e.turnId }));
	on("turn.complete", (_$, e) => ({ text: e.answer }));
	on("session.append", (_$, e, next) => {
		seen.appendCalls++;
		/* A hook that throws or breaks the envelope is skipped and the row kept,
		 * so a rejection is had from the bottom, which takes text blocks only
		 * (#896). Residual: a build whose bottom takes images stores these rows,
		 * and the rejection tests fail rather than pass unforced. */
		if (w.failAppends?.includes(seen.appendCalls))
			return next({
				...e,
				message: {
					...e.message,
					content: [
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: "AA==" },
						},
					],
				},
			});
		if (w.denyAppends?.includes(seen.appendCalls)) return { deny: "refused" };
		seen.rows.push(
			e.message.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
		);
		return next(e);
	});
	on("prompt.submit", () => {
		seen.submits++;
		throw new Error("the mod must never submit a prompt");
	});
	on("fs.exists", (_$, e) => {
		seen.exists.push(e.path);
		if (e.path === `${CWD}/.claude/skills/wfc-delivery`)
			return { value: w.hasLocalCopy ?? false };
		return { value: false };
	});
	on("fs.read", () => ({ deny: "ENOENT" }));
	on("fs.stat", (_$, e) => {
		seen.stats++;
		return {
			value: {
				kind: "dir",
				size: 0,
				mtimeMs: seen.mtime[e.path] ?? -1,
				isLink: false,
			},
		} as const;
	});
	on("process.run", async (_$, e, next) => {
		const out = (stdout: string) => ({
			value: {
				exitCode: 0,
				stdout,
				stderr: "",
				isStdoutTruncated: false,
				isStderrTruncated: false,
			},
		});
		if (e.argv.includes("--paths")) {
			seen.pathRuns++;
			seen.scripts.push(
				`${next.origin.plugin} ${e.argv[1]} in ${e.init?.cwd} as ${e.init?.env?.CLAUDE_CODE_SESSION_ID}`,
			);
			return out(PATHS);
		}
		if (e.argv.includes("--ci")) {
			seen.ciRuns++;
			seen.ciTimeouts.push(e.init?.timeoutMs);
			if (w.failCiRuns?.includes(seen.ciRuns))
				return { deny: "process.run timed out" };
			return out(ciPrints.shift() ?? "");
		}
		if (e.argv.includes("--requests")) {
			seen.requestRuns++;
			return out(requestPrints.shift() ?? "");
		}
		seen.reportRuns++;
		await heldRuns.shift();
		if (w.failRuns?.includes(seen.reportRuns))
			return { deny: "process.run rejected" };
		return out(prints.shift() ?? "");
	});
	return { clock, seen };
}

/* The load through the workflow-core plugin, beside the stand-alone load
 * under test (#944). */
const HOSTED = { plugins: [{ name: "workflow-core", register }] };

interface Kit {
	session: { start: (e: never) => Promise<unknown> };
	turn: {
		start: (e: never) => Promise<unknown>;
		complete: (e: never) => Promise<unknown>;
	};
}

const sessionStart = ($: Kit) =>
	$.session.start({
		cwd: CWD,
		surface: null,
		isInteractive: false,
	} as never);

const start = async ($: Kit) => {
	await sessionStart($);
	await turnStart($);
};

const turnStart = ($: Kit, agentId?: string) =>
	$.turn.start({ text: "", turnId: "t-1", agentId } as never);

const turnEnd = ($: Kit, agentId?: string) =>
	$.turn.complete({
		answer: "done",
		reason: "answer",
		isAborted: false,
		durationMs: 1,
		turnId: "t-1",
		agentId,
	} as never);

describe("wfc-delivery, a thin loop over the delivery script (#854)", () => {
	test("non-empty output is offered as one row", async ($, on) => {
		const { clock, seen } = world(on, { prints: [REPORT] });
		await start($);
		await clock.advance(TICK);
		expect(seen.reportRuns).toBe(1);
		expect(seen.rows).toEqual([expect.stringContaining("ci-status")]);
		expect(seen.submits).toBe(0);
	});

	test("empty output appends nothing", async ($, on) => {
		const { clock, seen } = world(on, { prints: ["", "\n"] });
		await start($);
		await clock.advance(TICK);
		seen.mtime["/store"] = 2;
		await clock.advance(TICK);
		expect(seen.reportRuns).toBe(2);
		expect(seen.appendCalls).toBe(0);
		expect(seen.submits).toBe(0);
	});

	test("below 2.1.289 nothing is started or appended", async ($, on) => {
		const { clock, seen } = world(on, { version: "2.1.288", prints: [REPORT] });
		await start($);
		await clock.advance(TICK * 4);
		expect(seen.stats + seen.forks()).toBe(0);
		expect(seen.appendCalls).toBe(0);
		expect(seen.logs).toEqual([expect.stringContaining("below 2.1.289")]);
	});

	test("an unchanged stat forks nothing", async ($, on) => {
		const { clock, seen } = world(on);
		await start($);
		await clock.advance(TICK);
		const forks = seen.forks();
		await clock.advance(TICK * 5);
		/* Three directories a tick (the store, the register and the claims),
		 * on the turn's start and six intervals. */
		expect(seen.stats).toBe(21);
		expect(seen.forks()).toBe(forks);
		seen.mtime["/store"] = 2;
		await clock.advance(TICK);
		expect(seen.reportRuns).toBe(2);
		expect(seen.submits).toBe(0);
	});

	test("a rejected run leaves the next tick working", async ($, on) => {
		const { clock, seen } = world(on, { prints: [REPORT], failRuns: [1] });
		await start($);
		expect(seen.reportRuns).toBe(1);
		expect(seen.appendCalls).toBe(0);
		await clock.advance(TICK);
		expect(seen.reportRuns).toBe(2);
		expect(seen.rows).toEqual([expect.stringContaining("ci-status")]);
	});

	test("a rejected append is offered again next tick, the script not re-run", async ($, on) => {
		const { clock, seen } = world(on, { prints: [REPORT], failAppends: [1] });
		await start($);
		expect(seen.rows).toEqual([]);
		expect(seen.logs).toEqual([expect.stringContaining("offer 1 of 3")]);
		await clock.advance(TICK);
		expect(seen.rows).toEqual([expect.stringContaining("ci-status")]);
		expect(seen.reportRuns).toBe(1);
		expect(seen.submits).toBe(0);
	});

	test("a row rejected three times is dropped", async ($, on) => {
		const { clock, seen } = world(on, {
			prints: [REPORT],
			failAppends: [1, 2, 3],
		});
		await start($);
		await clock.advance(TICK * 6);
		expect(seen.appendCalls).toBe(3);
		expect(seen.rows).toEqual([]);
	});

	test("a row a plugin above refuses is dropped, not offered again", async ($, on) => {
		const { clock, seen } = world(on, { prints: [REPORT], denyAppends: [1] });
		await start($);
		await clock.advance(TICK * 3);
		expect(seen.appendCalls).toBe(1);
		expect(seen.logs).toEqual([expect.stringContaining("refused, dropped")]);
	});

	test("a held row never stops a newer report being fetched", async ($, on) => {
		const { clock, seen } = world(on, {
			prints: [REPORT, "▸ reap-finished-sessions\nstopped 2"],
			failAppends: [1],
		});
		await start($);
		seen.mtime["/store"] = 2;
		await clock.advance(TICK);
		expect(seen.reportRuns).toBe(2);
		expect(seen.rows).toEqual([
			expect.stringContaining("ci-status\nmain is red at a1b2c3d\n\n▸ reap"),
		]);
		expect(seen.logs).toContainEqual(
			expect.stringContaining("delivered ci-status, reap-finished-sessions"),
		);
	});

	test("a request against a held file is offered as one row (#855)", async ($, on) => {
		const { clock, seen } = world(on, { requestPrints: [REQUEST] });
		await start($);
		await clock.advance(TICK);
		expect(seen.requestRuns).toBe(1);
		expect(seen.rows).toEqual([expect.stringContaining("release-request")]);
		expect(seen.submits).toBe(0);
	});

	test("a changed request register forks the requests source alone (#855)", async ($, on) => {
		const { clock, seen } = world(on);
		await start($);
		await clock.advance(TICK);
		seen.mtime["/req"] = 2;
		await clock.advance(TICK);
		expect(seen.requestRuns).toBe(2);
		expect(seen.reportRuns).toBe(1);
	});

	test("a changed claim store forks the requests source alone (#855)", async ($, on) => {
		const { clock, seen } = world(on);
		await start($);
		await clock.advance(TICK);
		seen.mtime["/locks"] = 2;
		await clock.advance(TICK);
		expect(seen.requestRuns).toBe(2);
		expect(seen.reportRuns).toBe(1);
	});

	test("a failing reports run never starves the requests source (#855)", async ($, on) => {
		const { clock, seen } = world(on, {
			failRuns: [1],
			requestPrints: [REQUEST],
		});
		await start($);
		await clock.advance(TICK);
		expect(seen.requestRuns).toBe(1);
		expect(seen.rows).toEqual([expect.stringContaining("release-request")]);
	});

	test("the CI re-check runs only on its 10-minute interval (#856)", async ($, on) => {
		const { clock, seen } = world(on);
		await start($);
		await clock.advance(CI_INTERVAL - TICK);
		expect(seen.ciRuns).toBe(0);
		await clock.advance(TICK * 2);
		expect(seen.ciRuns).toBe(1);
		await clock.advance(CI_INTERVAL - TICK * 2);
		expect(seen.ciRuns).toBe(1);
		await clock.advance(TICK * 2);
		expect(seen.ciRuns).toBe(2);
		expect(seen.submits).toBe(0);
	});

	test("the CI re-check's timeout sits above the script's own bounds (#856)", async ($, on) => {
		const { clock, seen } = world(on);
		await start($);
		await clock.advance(CI_INTERVAL + TICK);
		expect(seen.ciTimeouts).toEqual([expect.any(Number)]);
		// The script's 8 s gate plus its 15 s bound on the check.
		expect(seen.ciTimeouts[0]).toBeGreaterThan(23_000);
	});

	test("a changed CI verdict is offered as one row (#856)", async ($, on) => {
		const { clock, seen } = world(on, {
			ciPrints: ["▸ ci-recheck\nCI is red on main"],
		});
		await start($);
		await clock.advance(CI_INTERVAL + TICK);
		expect(seen.rows).toEqual([expect.stringContaining("ci-recheck")]);
		expect(seen.submits).toBe(0);
	});

	test("a timed-out CI run delivers nothing, and the next interval asks again (#856)", async ($, on) => {
		const { clock, seen } = world(on, {
			failCiRuns: [1],
			ciPrints: ["▸ ci-recheck\nCI is red on main"],
		});
		await start($);
		await clock.advance(CI_INTERVAL + TICK);
		expect(seen.ciRuns).toBe(1);
		expect(seen.appendCalls).toBe(0);
		await clock.advance(CI_INTERVAL - TICK * 2);
		expect(seen.ciRuns).toBe(1);
		await clock.advance(TICK * 2);
		expect(seen.ciRuns).toBe(2);
		expect(seen.rows).toEqual([expect.stringContaining("ci-recheck")]);
	});
});

describe("wfc-delivery runs only inside a main-loop turn (#3247)", () => {
	test("before its first turn it stats and spawns nothing", async ($, on) => {
		const { clock, seen } = world(on, { prints: [REPORT] });
		await sessionStart($);
		await clock.advance(CI_INTERVAL * 2);
		expect(seen.stats + seen.forks()).toBe(0);
	});

	test("once its turn has ended it stats and spawns nothing", async ($, on) => {
		const { clock, seen } = world(on);
		await start($);
		await clock.advance(TICK);
		await turnEnd($);
		const stats = seen.stats;
		const forks = seen.forks();
		seen.mtime["/store"] = 2;
		seen.mtime["/req"] = 2;
		await clock.advance(CI_INTERVAL * 3);
		expect(seen.stats).toBe(stats);
		expect(seen.forks()).toBe(forks);
		expect(seen.ciRuns).toBe(0);
	});

	test("a turn ending mid-tick stops the tick's later forks and its append", async ($, on) => {
		let release: () => void = () => undefined;
		const heldRun = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { clock, seen } = world(on, { prints: [REPORT], heldRun });
		await sessionStart($);
		const turn = turnStart($);
		await clock.advance(0);
		await turnEnd($);
		release();
		await turn;
		await clock.advance(CI_INTERVAL);
		expect(seen.reportRuns).toBe(1);
		expect(seen.requestRuns).toBe(0);
		expect(seen.appendCalls).toBe(0);
	});

	test("a turn that starts before session.start has finished still starts the loop", async ($, on) => {
		const { clock, seen } = world(on);
		await turnStart($);
		await sessionStart($);
		await clock.advance(0);
		seen.mtime["/store"] = 2;
		await clock.advance(TICK);
		expect(seen.reportRuns).toBe(2);
	});

	test("the turn's first row is appended before turn.start resolves", async ($, on) => {
		const { seen } = world(on, { requestPrints: [REQUEST] });
		await start($);
		expect(seen.rows).toEqual([expect.stringContaining("release-request")]);
		expect(seen.ciRuns).toBe(0);
	});

	test("a subagent's turn ending leaves the loop running", async ($, on) => {
		const { clock, seen } = world(on);
		await start($);
		await turnEnd($, "a-1");
		seen.mtime["/store"] = 2;
		await clock.advance(TICK);
		expect(seen.reportRuns).toBe(2);
	});

	test("the next turn's start ticks at once, and its next tick re-checks CI", async ($, on) => {
		const { clock, seen } = world(on, { requestPrints: ["", REQUEST] });
		await start($);
		await turnEnd($);
		seen.mtime["/req"] = 2;
		await clock.advance(CI_INTERVAL);
		expect(seen.requestRuns).toBe(1);
		await turnStart($);
		expect(seen.requestRuns).toBe(2);
		expect(seen.ciRuns).toBe(0);
		expect(seen.rows).toEqual([expect.stringContaining("release-request")]);
		await clock.advance(TICK);
		expect(seen.ciRuns).toBe(1);
	});
});

describe("wfc-delivery after a lost hooks worker (#3251)", () => {
	test("a main-loop turn keeps whether it runs; a subagent's turn does not", async ($, on) => {
		world(on);
		const kept: unknown[] = [];
		on("state.set", (_$, e) => {
			kept.push(`${e.key} ${e.value}`);
			return { value: { isSet: true, version: 1 } };
		});
		await start($);
		await turnStart($, "a-1");
		await turnEnd($, "a-1");
		await turnEnd($);
		expect(kept).toEqual(["isTurnRunning true", "isTurnRunning false"]);
	});

	/* THE KIT CANNOT RELOAD A MODULE, so the fresh load is stood in for by a
	 * test that never starts a turn, its host store holding what the lost
	 * load's turn.start kept. */
	test("a session.start that runs again mid-turn, with no new turn.start, still ticks", async ($, on) => {
		const { clock, seen } = world(on);
		on("state.get", () => ({ value: { value: true, version: 1 } as never }));
		await sessionStart($);
		await clock.advance(0);
		seen.mtime["/store"] = 2;
		await clock.advance(TICK);
		expect(seen.reportRuns).toBe(2);
	});
});

describe("wfc-delivery and its two loads (#944)", () => {
	test("with no config file it starts, and logs only the delivery", async ($, on) => {
		const { clock, seen } = world(on, { prints: [REPORT] });
		await start($);
		await clock.advance(TICK);
		expect(seen.rows).toEqual([expect.stringContaining("ci-status")]);
		expect(seen.logs).toEqual([expect.stringContaining("delivered")]);
	});

	test(
		"stand-alone it runs the session folder's script; hosted, the host plugin's",
		HOSTED,
		async ($, on) => {
			const { clock, seen } = world(on);
			await start($);
			await clock.advance(TICK);
			expect([...seen.scripts].sort()).toEqual([
				"wfc-delivery /repo/scripts/deliver-to-session.js in /repo as s-1",
				expect.stringMatching(
					/^workflow-core \/.+\/workflow-core\/scripts\/deliver-to-session\.js in \/repo as s-1$/,
				),
			]);
		},
	);

	test(
		"hosted, it starts nothing where the repo carries its own copy",
		HOSTED,
		async ($, on) => {
			const { clock, seen } = world(on, { hasLocalCopy: true });
			await start($);
			await clock.advance(TICK);
			expect(seen.scripts).toEqual([
				"wfc-delivery /repo/scripts/deliver-to-session.js in /repo as s-1",
			]);
			expect(seen.logs).toEqual([
				expect.stringContaining(
					"loaded through workflow-core, but .claude/skills/wfc-delivery here loads it stand-alone",
				),
			]);
		},
	);

	test("below the floor the guard is never read", HOSTED, async ($, on) => {
		const { seen } = world(on, { version: "2.1.288", hasLocalCopy: true });
		await start($);
		expect(seen.exists).toEqual([]);
		expect(seen.logs).toEqual([
			expect.stringContaining("below 2.1.289"),
			expect.stringContaining("below 2.1.289"),
		]);
	});
});
