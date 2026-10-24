/*
 * Pins when the liveness mod names a subagent stalled and clears it, that it
 * passes every step through untouched, what its `/liveness` pane shows, and
 * its floor, its two loads and the repo's switch (#865, #866, #944).
 *
 * The mod's own seam (#863 §Testing Decisions, seam 1), run by
 * `claude plugin test .claude/skills/wfc-liveness`. The ordinary vitest suite
 * never collects it: `claude-code/testing` exists only under that runner.
 * The hooks `world()` registers stand for the engine.
 *
 * THE KIT CANNOT RELOAD A MODULE (2.1.291), so a reload is stood in for by a
 * second `session.start`, which a reload raises and which restores the
 * records from `$.state`; module variables are not reset as a reload would.
 *
 * `test`, not §X1's `it`: the kit exports no `it`. Each `as never` hands the
 * kit an event or answer the test builds partly, where the kit's own types
 * want every field an engine would fill.
 *
 * .husky/pre-push refuses a push touching the mod on a failure here
 * (scripts/run-mod-tests.js, #857), and ci.yml's `Mod tests` step reddens the
 * sweep on one (#1854); nothing else runs these tests. Loosen a case and a mod that misses a stall, cries one falsely or alters a step's
 * stream reaches every adopter loading the plugin.
 */

import type { AgentInfo, AgentStatus, On, TurnStepChunk } from "claude-code";
import type { Engine, Mounted, Plugin } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { register } from "../hooks/register";

const TICK = 5000;
const CWD = "/repo";
const MINUTE = 60_000;

interface World {
	version?: string;
	listFails?: number[];
	/** The repo's `.claude/workflow-core.json`; absent when not given. */
	config?: string;
	isConfigUnreadable?: boolean;
	/** Whether the repo carries the mod's own `.claude/skills/wfc-liveness/`. */
	hasLocalCopy?: boolean;
}

function world(on: On, w: World = {}) {
	reset();
	const clock = mock.clock(on);
	const seen = {
		agents: [] as AgentInfo[],
		lists: 0,
		statuses: [] as (string | undefined)[],
		toasts: [] as string[],
		logs: [] as string[],
		/** The status line as last written; undefined when cleared or never. */
		status: () => seen.statuses.at(-1),
		submits: 0,
		commands: [] as string[],
		/** The ids of the panes open now, as `$.ui.panes()` answers. */
		panes: new Set<string>(),
		/** Each path whose existence is asked, in order. */
		exists: [] as string[],
	};
	on("fs.exists", (_$, e) => {
		seen.exists.push(e.path);
		if (e.path === `${CWD}/.claude/workflow-core.json`)
			return { value: w.config !== undefined };
		if (e.path === `${CWD}/.claude/skills/wfc-liveness`)
			return { value: w.hasLocalCopy ?? false };
		return { value: false };
	});
	on("fs.read", (_$, e) => {
		if (w.isConfigUnreadable) return { deny: "EACCES" };
		if (e.path === `${CWD}/.claude/workflow-core.json` && w.config)
			return { value: w.config };
		return { deny: "ENOENT" };
	});
	on("session.version", () => ({
		value: { version: w.version ?? "2.1.291" } as never,
	}));
	on("session.start", (_$, e) => ({ cwd: e.cwd }));
	on("agent.list", () => {
		seen.lists++;
		if (w.listFails?.includes(seen.lists))
			return { deny: "agent.list rejected" };
		return { value: seen.agents.map((agent) => ({ ...agent })) };
	});
	on("ui.status", (_$, e) => {
		seen.statuses.push(e.text);
		return { value: undefined };
	});
	on("ui.toast", (_$, e) => {
		seen.toasts.push(e.text);
		return { value: undefined };
	});
	on("ui.log", (_$, e) => {
		seen.logs.push(e.text);
		return { value: undefined };
	});
	on("command.register", (_$, e, next) => {
		const by =
			next.origin.plugin === "wfc-liveness" ? "" : ` by ${next.origin.plugin}`;
		seen.commands.push(`${e.name}${e.immediate ? " (immediate)" : ""}${by}`);
		return { value: { command: e.name } };
	});
	on("ui.open", (_$, e) => {
		seen.panes.add(e.id);
		return { value: { isPlaced: true } };
	});
	on("ui.close", (_$, e) => {
		seen.panes.delete(e.id);
		return { value: undefined };
	});
	on("ui.panes", () => ({
		value: [...seen.panes].map((id) => ({
			id,
			title: id,
			isShown: true,
			isFocused: false,
			isPlaced: true,
		})),
	}));
	on("prompt.submit", () => {
		seen.submits++;
		throw new Error("the mod must never submit a prompt");
	});
	on("turn.step", async function* (_$, e) {
		const tools = TOOLS.get(e.agentId ?? "main") ?? [];
		yield { kind: "text", index: 0, text: "working" };
		if (FAILS.has(e.agentId ?? "main")) throw new Error("stream broke");
		return {
			turnId: e.turnId,
			index: e.index,
			answer: "working",
			toolUses: tools.map((name) => ({ name, input: {} })),
			stopReason: tools.length > 0 ? "tool_use" : "end_turn",
			usage: null,
		};
	});
	on("turn.complete", (_$, e) => ({ text: e.answer }));
	const list = (
		id: string,
		status: AgentStatus,
		description = id,
		type = "general-purpose",
	) => {
		const at = seen.agents.findIndex((listed) => listed.id === id);
		const agent = { id, description, type, status };
		if (at === -1) seen.agents.push(agent);
		else seen.agents[at] = agent;
	};
	const drop = (id: string) => {
		seen.agents = seen.agents.filter((agent) => agent.id !== id);
	};
	return { clock, seen, list, drop };
}

/* Which tools each loop's next step calls, and which loops' streams fail;
 * set per test, cleared by `reset`. */
const TOOLS = new Map<string, string[]>();
const FAILS = new Set<string>();
const reset = () => {
	TOOLS.clear();
	FAILS.clear();
};

/* Reads the mod's records for their keys alone, at any `turn.complete`, and
 * logs them: the kit's engine has no `state` noun, and any plugin may read
 * another's value. */
const RECORD_READER: Plugin = {
	name: "record-reader",
	register(on) {
		on("turn.complete", async ($, e, next) => {
			const { value } = await $.state.get({
				plugin: "wfc-liveness",
				key: "records",
			});
			$.ui.log(`records held: ${Object.keys(value ?? {}).join(", ")}`, {
				to: "debug",
			});
			return next(e);
		});
	},
};

/* The load through the workflow-core plugin, beside the stand-alone load
 * under test (#944). */
const HOSTED = { plugins: [{ name: "workflow-core", register }] };
const OFF = JSON.stringify({ mods: { "wfc-liveness": false } });

interface Kit {
	session: { start: (e: never) => Promise<unknown> };
	turn: {
		step: (e: never) => AsyncGenerator<TurnStepChunk, unknown>;
		complete: (e: never) => Promise<unknown>;
	};
}

const start = ($: Kit) =>
	$.session.start({
		cwd: CWD,
		surface: "terminal",
		isInteractive: true,
	} as never);

/** Runs one model step in `agentId`'s loop (main when absent), read whole. */
const step = async ($: Kit, agentId?: string) => {
	const stream = $.turn.step({
		turnId: "t-1",
		index: 0,
		model: "claude-opus-5-5",
		messageCount: 1,
		...(agentId === undefined ? {} : { agentId }),
	} as never);
	/* Read by hand: under the kit (2.1.291) `stream.result` resolves
	 * undefined after a `for await`, the mod in the chain or not. */
	const chunks: TurnStepChunk[] = [];
	for (;;) {
		const read = await stream.next();
		if (read.done) return { chunks, result: read.value };
		chunks.push(read.value);
	}
};

describe("wfc-liveness, the status line (#865)", () => {
	test("a running agent is named stalled at 5 minutes quiet, not at 4, and its next step clears it", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		list("a-1", "running", "probe sleeper");
		TOOLS.set("a-1", ["Bash"]);
		await step($, "a-1");
		await clock.advance(4 * MINUTE);
		expect(seen.status()).toBe("1 subagent running");
		await clock.advance(MINUTE);
		expect(seen.status()).toBe(
			"1 subagent running; stalled: probe sleeper (5m quiet, running Bash)",
		);
		TOOLS.set("a-1", []);
		await step($, "a-1");
		await clock.advance(TICK);
		expect(seen.status()).toBe("1 subagent running");
		expect(seen.submits).toBe(0);
	});

	test("the status line is cleared when no agent is live", async ($, on) => {
		const { clock, seen, list, drop } = world(on);
		await start($);
		list("a-1", "running");
		await clock.advance(TICK);
		expect(seen.status()).toBe("1 subagent running");
		list("a-1", "completed");
		await clock.advance(TICK);
		expect(seen.statuses.at(-1)).toBeUndefined();
		const writes = seen.statuses.length;
		drop("a-1");
		await clock.advance(TICK * 3);
		// Written only on a change.
		expect(seen.statuses.length).toBe(writes);
	});

	test("an agent first listed with no step is judged from first sight", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		await clock.advance(10 * MINUTE);
		list("a-1", "running", "loaded mid-run");
		await clock.advance(5 * MINUTE - TICK);
		expect(seen.status()).toBe("1 subagent running");
		await clock.advance(TICK * 2);
		expect(seen.status()).toBe(
			"1 subagent running; stalled: loaded mid-run (5m quiet, between steps)",
		);
	});

	test("an agent back to running after waiting is clocked from its return", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		list("a-1", "waiting", "held by design");
		await clock.advance(10 * MINUTE);
		list("a-1", "running", "held by design");
		await clock.advance(5 * MINUTE - TICK);
		expect(seen.status()).toBe("1 subagent running");
		expect(seen.toasts).toEqual([]);
		await clock.advance(TICK * 2);
		expect(seen.status()).toContain("stalled: held by design (5m quiet");
	});

	test("waiting, idle and pending agents are never named stalled", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		list("a-1", "waiting");
		list("a-2", "pending");
		list("a-3", "idle");
		await clock.advance(30 * MINUTE);
		expect(seen.status()).toBe("0 subagents running");
		expect(seen.toasts).toEqual([]);
	});

	test("the longest stall is named first", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		list("a-1", "running", "older");
		await clock.advance(2 * MINUTE);
		list("a-2", "running", "newer");
		await clock.advance(5 * MINUTE + TICK);
		expect(seen.status()).toBe(
			"2 subagents running; stalled: older (7m quiet, between steps), newer (5m quiet, between steps)",
		);
	});

	test("a long description is cut", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		list("a-1", "running", "x".repeat(40));
		await clock.advance(5 * MINUTE + TICK);
		expect(seen.status()).toContain(`${"x".repeat(31)}… (5m quiet`);
	});

	test("one toast at a stall's onset, none while it lasts, none on recovery", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		list("a-1", "running", "probe sleeper");
		await clock.advance(5 * MINUTE + TICK);
		expect(seen.toasts).toEqual([
			"Subagent stalled: probe sleeper (5m quiet, between steps)",
		]);
		await clock.advance(20 * MINUTE);
		expect(seen.toasts.length).toBe(1);
		await step($, "a-1");
		await clock.advance(TICK);
		expect(seen.toasts.length).toBe(1);
		const marks = seen.logs.filter((l) => /stall (began|ended)/.test(l));
		expect(marks).toEqual([
			expect.stringContaining("stall began: a-1 probe sleeper"),
			expect.stringContaining("stall ended: a-1 probe sleeper (stepped again)"),
		]);
	});

	test("a stalled agent the engine drops ends its stall in the log, with its description", async ($, on) => {
		const { clock, seen, list, drop } = world(on);
		await start($);
		list("a-1", "running", "dropped one");
		await clock.advance(5 * MINUTE + TICK);
		drop("a-1");
		await clock.advance(TICK);
		expect(seen.logs).toContainEqual(
			expect.stringContaining(
				"stall ended: a-1 dropped one (no longer listed)",
			),
		);
		expect(seen.statuses.at(-1)).toBeUndefined();
	});

	test(
		"a main-loop step records nothing and is never counted as an agent's",
		{ plugins: [RECORD_READER] },
		async ($, on) => {
			const { clock, seen, list } = world(on);
			await start($);
			list("a-1", "running", "quiet one");
			TOOLS.set("main", ["Bash"]);
			await clock.advance(TICK);
			await step($);
			await clock.advance(5 * MINUTE);
			expect(seen.status()).toBe(
				"1 subagent running; stalled: quiet one (5m quiet, between steps)",
			);
			await $.turn.complete({
				answer: "",
				durationMs: 1,
				isAborted: false,
				turnId: "t-1",
				reason: "answer",
			} as never);
			expect(seen.logs).toContain("records held: a-1");
		},
	);

	test("a step from an agent not yet listed is kept, and counts once the list names it", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		TOOLS.set("a-1", ["Read"]);
		await step($, "a-1");
		await clock.advance(2 * MINUTE);
		expect(seen.status()).toBeUndefined();
		list("a-1", "running", "early stepper");
		// Clocked from its step, 3 minutes before the list named it.
		await clock.advance(3 * MINUTE);
		expect(seen.status()).toBe(
			"1 subagent running; stalled: early stepper (5m quiet, running Read)",
		);
	});

	test("an agent never listed is never shown", async ($, on) => {
		const { clock, seen } = world(on);
		await start($);
		await step($, "fork-1");
		await clock.advance(30 * MINUTE);
		// The first tick clears whatever a previous load left on the line.
		expect(seen.statuses.filter((text) => text !== undefined)).toEqual([]);
		expect(seen.toasts).toEqual([]);
		expect(await rowTexts(await mountPane($))).toEqual([]);
	});

	test("a step's chunks and result pass through unchanged", async ($, on) => {
		const { list } = world(on);
		await start($);
		list("a-1", "running");
		TOOLS.set("a-1", ["Bash", "SubagentHandback"]);
		const { chunks, result } = await step($, "a-1");
		expect(chunks).toEqual([
			expect.objectContaining({ kind: "text", index: 0, text: "working" }),
		]);
		expect(result).toEqual({
			turnId: "t-1",
			index: 0,
			answer: "working",
			toolUses: [
				{ name: "Bash", input: {} },
				{ name: "SubagentHandback", input: {} },
			],
			stopReason: "tool_use",
			usage: null,
		});
	});

	test("the engine's hand-back is not shown as a tool run", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		list("a-1", "running", "handing back");
		TOOLS.set("a-1", ["SubagentHandback"]);
		await step($, "a-1");
		await clock.advance(5 * MINUTE);
		expect(seen.status()).toContain("(5m quiet, between steps)");
	});

	test("a failing stream beneath the mod still fails, naming turn.step, and ends the step", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		list("a-1", "running", "broken");
		FAILS.add("a-1");
		/* The kit skips a test hook that throws, as a session skips a failing
		 * hook, so what reaches the caller is its bottom refusing the step. */
		await expect(step($, "a-1")).rejects.toThrow("turn.step");
		// The step ended: not left "model answering".
		await clock.advance(5 * MINUTE);
		expect(seen.status()).toContain("(5m quiet, between steps)");
	});

	test("a subagent's turn.complete answers unchanged", async ($, on) => {
		world(on);
		await start($);
		const done = await $.turn.complete({
			answer: "done",
			durationMs: 10,
			isAborted: false,
			turnId: "t-1",
			agentId: "a-1",
			reason: "answer",
		} as never);
		expect(done).toEqual({ text: "done" });
	});

	test("below 2.1.289 nothing is drawn, no timer runs and no command is registered", async ($, on) => {
		const { clock, seen, list } = world(on, { version: "2.1.288" });
		await start($);
		list("a-1", "running");
		await step($, "a-1");
		await clock.advance(10 * MINUTE);
		expect(seen.lists).toBe(0);
		expect(seen.commands).toEqual([]);
		expect(seen.statuses).toEqual([]);
		expect(seen.toasts).toEqual([]);
		expect(seen.logs).toEqual([expect.stringContaining("below 2.1.289")]);
	});

	test("a rejected agent list leaves the next tick working", async ($, on) => {
		const { clock, seen, list } = world(on, { listFails: [1] });
		await start($);
		list("a-1", "running");
		await clock.advance(TICK);
		expect(seen.statuses).toEqual([]);
		expect(seen.logs).toEqual([expect.stringContaining("tick failed")]);
		await clock.advance(TICK);
		expect(seen.status()).toBe("1 subagent running");
	});

	test("records survive a reload", async ($, on) => {
		const { clock, seen, list } = world(on);
		await start($);
		list("a-1", "running", "survivor");
		TOOLS.set("a-1", ["Bash"]);
		await step($, "a-1");
		await clock.advance(MINUTE);
		await start($);
		await clock.advance(4 * MINUTE);
		expect(seen.status()).toBe(
			"1 subagent running; stalled: survivor (5m quiet, running Bash)",
		);
	});
});

/* What a surface hands the pane's `ui.render` hook. */
const PANE_PROPS = {
	title: "Subagents",
	isFocused: false,
	bodyColumns: 60,
	placement: "dock",
	scroll: { offset: 0, bodyRows: 40 },
	view: {},
} as const;

const SURFACES = ["terminal", "desktop"] as const;

/** The founder typing `/liveness` at a fullscreen terminal. */
const runLiveness = ($: Engine) =>
	$.command.run({
		command: "liveness",
		args: "",
		origin: { kind: "composer" },
		presentation: { isFullscreen: true, columns: 200 },
	});

const mountPane = (
	$: Engine,
	surface: (typeof SURFACES)[number] = "terminal",
) =>
	$.ui.mount({
		plugin: "wfc-liveness",
		surface,
		component: "Pane",
		requestId: "liveness",
		props: PANE_PROPS,
	});

/** Each agent row's shown text, in the pane's order. */
const rowTexts = async (ui: { findAll: Mounted["findAll"] }) =>
	(await ui.findAll({ type: "Box" }))
		.filter((box) => box.key?.startsWith("agent:"))
		.map((box) => box.text);

describe("wfc-liveness, the pane (#866)", () => {
	test("/liveness opens the pane, a second run closes it, and neither submits a prompt", async ($, on) => {
		const { seen } = world(on);
		await start($);
		expect(seen.commands).toEqual(["liveness (immediate)"]);
		const opened = await runLiveness($);
		expect(opened.text).toBe("Subagents pane opened.");
		expect([...seen.panes]).toEqual(["liveness"]);
		const closed = await runLiveness($);
		expect(closed.text).toBe("Subagents pane closed.");
		expect([...seen.panes]).toEqual([]);
		expect(seen.submits).toBe(0);
	});

	test("the pane shows one row per listed agent, on terminal and desktop", async ($, on) => {
		const { clock, list } = world(on);
		await start($);
		list("a-1", "running", "probe sleeper");
		list("a-2", "running", "quiet reviewer", "code-reviewer");
		list("a-3", "waiting", "held by design");
		TOOLS.set("a-1", ["Bash"]);
		await step($, "a-1");
		await step($, "a-1");
		await clock.advance(5 * MINUTE + TICK);
		for (const surface of SURFACES) {
			const ui = await mountPane($, surface);
			expect(await rowTexts(ui)).toEqual([
				"probe sleepergeneral-purpose · running · 2 steps · running Bash 5m 05sstalled, 5m 05s quiet",
				"quiet reviewercode-reviewer · running · 0 steps · between steps 5m 00sstalled, 5m 00s quiet",
				"held by designgeneral-purpose · waiting · 0 steps",
			]);
			await ui.unmount();
		}
	});

	test("the pane's times move while it is open", async ($, on) => {
		const { clock, list } = world(on);
		await start($);
		list("a-1", "running", "mover");
		await step($, "a-1");
		const ui = await mountPane($);
		await clock.advance(TICK);
		expect((await ui.find({ key: "agent:a-1" }))?.text).toContain(
			"between steps 5s",
		);
		await clock.advance(TICK * 2);
		expect((await ui.find({ key: "agent:a-1" }))?.text).toContain(
			"between steps 15s",
		);
	});

	test("a finished, failed or killed agent keeps its row with its final status while listed", async ($, on) => {
		const { clock, list, drop } = world(on);
		await start($);
		list("a-1", "completed", "done one");
		list("a-2", "failed", "failed one");
		list("a-3", "killed", "killed one");
		await clock.advance(TICK);
		const ui = await mountPane($);
		expect(await rowTexts(ui)).toEqual([
			"done onegeneral-purpose · completed · 0 steps",
			"failed onegeneral-purpose · failed · 0 steps",
			"killed onegeneral-purpose · killed · 0 steps",
		]);
		drop("a-1");
		await clock.advance(TICK);
		expect(await rowTexts(ui)).toEqual([
			"failed onegeneral-purpose · failed · 0 steps",
			"killed onegeneral-purpose · killed · 0 steps",
		]);
	});

	test("with no agent listed the pane says so", async ($, on) => {
		const { clock } = world(on);
		await start($);
		await clock.advance(TICK);
		const ui = await mountPane($, "desktop");
		expect(await ui.find({ text: "No subagents listed." })).toBeDefined();
	});

	test("a record an older load saved, with no step count, counts on from a reload", async ($, on) => {
		const { clock, list } = world(on);
		/* The host's store, beneath the mod, holding a record as #865's
		 * module saved it: no `steps`, no `phaseSince`. */
		const store = new Map<string, unknown>([
			[
				"records",
				{
					"a-1": {
						firstListedAt: 0,
						description: "old shape",
						status: "running",
						quietSince: 0,
						isStepping: false,
						tools: [],
						isStalled: false,
					},
				},
			],
		]);
		on("state.get", (_$, e) => ({
			value: { value: store.get(e.key), version: 1 } as never,
		}));
		on("state.set", (_$, e) => {
			store.set(e.key, e.value);
			return { value: { isSet: true, version: 1 } };
		});
		await start($);
		list("a-1", "running", "old shape");
		await step($, "a-1");
		await clock.advance(TICK);
		expect(await rowTexts(await mountPane($))).toEqual([
			"old shapegeneral-purpose · running · 1 step · between steps 5s",
		]);
	});
});

describe("wfc-liveness, its two loads and the repo's switch (#944)", () => {
	test("with no config file it starts, and logs nothing", async ($, on) => {
		const { clock, seen } = world(on);
		await start($);
		await clock.advance(TICK);
		expect(seen.lists).toBe(1);
		expect(seen.commands).toEqual(["liveness (immediate)"]);
		expect(seen.logs).toEqual([]);
	});

	for (const config of [
		'{"contract": 1}',
		'{"mods": {"other-mod": false}}',
		'{"mods": {"wfc-liveness": true}}',
	])
		test(`${config} leaves it on, and logs nothing`, async ($, on) => {
			const { clock, seen } = world(on, { config });
			await start($);
			await clock.advance(TICK);
			expect(seen.lists).toBe(1);
			expect(seen.logs).toEqual([]);
		});

	test('"mods" setting it false starts nothing and says why', async ($, on) => {
		const { clock, seen, list } = world(on, { config: OFF });
		await start($);
		list("a-1", "running");
		await step($, "a-1");
		await clock.advance(10 * MINUTE);
		expect(seen.lists).toBe(0);
		expect(seen.statuses).toEqual([]);
		expect(seen.commands).toEqual([]);
		expect(seen.logs).toEqual([
			expect.stringContaining('switched off by "mods"'),
		]);
	});

	for (const [why, w] of [
		["does not parse", { config: "{ nope" }],
		["is no JSON object", { config: "[]" }],
		["gives this mod no boolean", { config: '{"mods": {"wfc-liveness": 0}}' }],
		["gives mods no object", { config: '{"mods": []}' }],
		["cannot be read", { config: OFF, isConfigUnreadable: true }],
	] as const)
		test(`a config that ${why} leaves it on, with one log line`, async ($, on) => {
			const { clock, seen } = world(on, w);
			await start($);
			await clock.advance(TICK);
			expect(seen.lists).toBe(1);
			expect(seen.logs).toEqual([
				expect.stringContaining("unreadable or malformed, read as on"),
			]);
		});

	test(
		"hosted, it starts nothing where the repo carries its own copy",
		HOSTED,
		async ($, on) => {
			const { seen } = world(on, { hasLocalCopy: true });
			await start($);
			expect(seen.commands).toEqual(["liveness (immediate)"]);
			expect(seen.logs).toEqual([
				expect.stringContaining(
					"loaded through workflow-core, but .claude/skills/wfc-liveness here loads it stand-alone",
				),
			]);
		},
	);

	test("hosted, with no copy of its own, it starts", HOSTED, async ($, on) => {
		const { seen } = world(on);
		await start($);
		expect([...seen.commands].sort()).toEqual([
			"liveness (immediate)",
			"liveness (immediate) by workflow-core",
		]);
	});

	test('"mods" turns the hosted load off too', HOSTED, async ($, on) => {
		const { clock, seen } = world(on, { config: OFF });
		await start($);
		await clock.advance(TICK);
		expect(seen.lists).toBe(0);
		expect(seen.commands).toEqual([]);
		expect(seen.logs).toEqual([
			expect.stringContaining('switched off by "mods"'),
			expect.stringContaining('switched off by "mods"'),
		]);
	});

	test(
		"below the floor neither the switch nor the guard is read",
		HOSTED,
		async ($, on) => {
			const { seen } = world(on, {
				version: "2.1.288",
				config: OFF,
				hasLocalCopy: true,
			});
			await start($);
			expect(seen.exists).toEqual([]);
			expect(seen.logs).toEqual([
				expect.stringContaining("below 2.1.289"),
				expect.stringContaining("below 2.1.289"),
			]);
		},
	);

	test("switched off, the guard is never read", HOSTED, async ($, on) => {
		const { seen } = world(on, { config: OFF, hasLocalCopy: true });
		await start($);
		expect(seen.exists).toEqual([
			"/repo/.claude/workflow-core.json",
			"/repo/.claude/workflow-core.json",
		]);
	});
});
