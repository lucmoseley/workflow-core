// @vitest-environment node
/*
 * lib/burn-mode.js is the one table burn mode remaps models through — the
 * Agent-call aliases, the launch spellings, and the settings.json effort: Sonnet
 * moves up to Opus, Opus is never moved to Fable, and an unknown spelling is
 * left alone (#355).
 *
 * The hook's shell half is tested in ../guard-dispatch-rewrite.test.ts,
 * the launcher's in ../dispatch-sessions-launch.test.ts, the toggle's in
 * ../burn-mode.test.ts. Here the table's functions are called in process, and
 * its CLI run as a program, since the shell halves read it through that CLI.
 *
 * `lib/dispatch-rewrite.js`, `dispatch-sessions.sh` and the `burn-mode`
 * skill's toggle all remap through this table: loosen a case here and burn
 * mode spends allowance on the wrong model, or leaves Sonnet work unmoved.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EFFORT_MODEL,
	EFFORT_OFF,
	EFFORT_ON,
	readBurnState,
	remapModel,
} from "./burn-mode";
import { runInProcess } from "./run-in-process";

const LIB = path.resolve(__dirname, "burn-mode.js");

const cli = (args: string[], stdin = "", env?: NodeJS.ProcessEnv) =>
	runInProcess(LIB, args, env ? { stdin, env } : { stdin });

/** The model an Agent call naming `model` is dispatched on. */
const dispatched = (model: string) =>
	remapModel({ model })?.input.model ?? model;

/** The launch spelling the CLI's `launch` mode prints for `model`. */
const launched = (model: string) => {
	const r = cli(["launch", model]);
	expect(r.status, r.stderr).toBe(0);
	return r.stdout.trim();
};

describe("the dispatch ladder — Sonnet up to Opus, exact match", () => {
	it.each([
		["sonnet", "opus"],
		["opus", "opus"],
		["fable", "fable"],
		["haiku", "haiku"],
	])("%s -> %s", (from, to) => {
		expect(dispatched(from)).toBe(to);
	});

	it("never guesses at a spelling it does not know", () => {
		expect(dispatched("opus[1m]")).toBe("opus[1m]");
		expect(dispatched("gpt-4")).toBe("gpt-4");
	});
});

describe("the launch ladder", () => {
	it.each([
		["sonnet", "claude-opus-5-5[1m]"],
		["sonnet[1m]", "claude-opus-5-5[1m]"],
		["claude-sonnet-5[1m]", "claude-opus-5-5[1m]"],
		["claude-sonnet-5-5", "claude-opus-5-5[1m]"],
		["claude-sonnet-5-5[1m]", "claude-opus-5-5[1m]"],
		["opusplan", "claude-opus-5-5[1m]"],
	])("%s -> %s", (from, to) => {
		expect(launched(from)).toBe(to);
	});

	/* An Opus launch picks its effort up from settings.json, which burn mode
	 * has already moved, so the spelling itself stays. */
	it.each([
		"opus",
		"opus[1m]",
		"claude-opus-5-5[1m]",
		"fable",
		"claude-fable-5-1[1m]",
		"haiku",
	])("leaves %s alone", (model) => {
		expect(launched(model)).toBe(model);
	});
});

describe("the marker mode — one resolver for every reader", () => {
	const marker = (env: Record<string, string>) => cli(["marker"], "", env);

	it("takes the override verbatim", () => {
		expect(marker({ WFC_BURN_MARKER: "/scratch/.burn-mode" }).stdout).toBe(
			"/scratch/.burn-mode\n",
		);
	});

	it("otherwise names .burn-mode under ~/.claude", () => {
		expect(marker({ HOME: "/home/someone" }).stdout).toBe(
			"/home/someone/.claude/.burn-mode\n",
		);
	});

	it.each([
		["unset", {}],
		["whitespace", { HOME: "  " }],
		["relative", { HOME: "home/someone" }],
	])(
		"exits 2 on a %s HOME, so a caller can fail open on purpose",
		(_n, env) => {
			const r = marker(env);
			expect(r.status).toBe(2);
			expect(r.stdout).toBe("");
		},
	);
});

describe("the settings.json effort", () => {
	it("on is Opus 5.5 at high, off the guide's standing medium", () => {
		expect(EFFORT_MODEL).toBe("claude-opus-5-5");
		expect(EFFORT_ON).toBe("high");
		expect(EFFORT_OFF).toBe("medium");
	});
});

describe("remapModel — burn mode's transform over one Agent call", () => {
	it("moves the model and carries every other field through", () => {
		const out = remapModel({
			model: "sonnet",
			prompt: "Do it.",
			description: "d",
			subagent_type: "general-purpose",
		});
		expect(out?.input).toEqual({
			model: "opus",
			prompt: "Do it.",
			description: "d",
			subagent_type: "general-purpose",
		});
		expect(out?.note).toContain("from `sonnet` to `opus`");
	});

	it.each([
		["no model named", { prompt: "x" }],
		["an empty model", { model: "  ", prompt: "x" }],
		[
			"a fork, which ignores the field",
			{ model: "sonnet", subagent_type: "fork" },
		],
		["opus, which burn mode leaves as opus", { model: "opus" }],
		["fable, off the ladder", { model: "fable" }],
		["a model off the ladder", { model: "haiku" }],
		["a non-object", "opus"],
		["null", null],
	])("is null for %s", (_name, input) => {
		expect(remapModel(input)).toBeNull();
	});
});

describe("readBurnState — what the switch left on the machine", () => {
	let home: string;
	const env = () => ({
		HOME: home,
		WFC_BURN_MARKER: path.join(home, "marker"),
	});
	const plan = (name: string, effortLevel: string) => {
		fs.mkdirSync(path.join(home, name), { recursive: true });
		fs.writeFileSync(
			path.join(home, name, "settings.json"),
			JSON.stringify({ modelSettings: { [EFFORT_MODEL]: { effortLevel } } }),
		);
	};
	const markerOn = () => fs.writeFileSync(env().WFC_BURN_MARKER, "{}");

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "burn-state-"));
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("reads off, every plan agreeing, off the standing effort", () => {
		plan(".claude", EFFORT_OFF);
		expect(readBurnState(env())).toEqual({
			on: false,
			disagreeing: [],
			error: null,
		});
	});

	it("names a plan left at the burn effort with the marker gone", () => {
		plan(".claude", EFFORT_OFF);
		plan(".claude2", EFFORT_ON);
		expect(readBurnState(env()).disagreeing).toEqual([
			path.join(".claude2", "settings.json"),
		]);
	});

	it("names a plan not moved while the marker reads on", () => {
		markerOn();
		plan(".claude", EFFORT_ON);
		plan(".claude2", EFFORT_OFF);
		const state = readBurnState(env());
		expect(state.on).toBe(true);
		expect(state.disagreeing).toEqual([path.join(".claude2", "settings.json")]);
	});

	it("names one symlinked file once, and skips one resolving to nothing", () => {
		plan(".claude", EFFORT_ON);
		fs.mkdirSync(path.join(home, ".claude2"));
		fs.symlinkSync(
			path.join(home, ".claude", "settings.json"),
			path.join(home, ".claude2", "settings.json"),
		);
		fs.mkdirSync(path.join(home, ".claude3"));
		fs.symlinkSync(
			path.join(home, "gone.json"),
			path.join(home, ".claude3", "settings.json"),
		);
		expect(readBurnState(env()).disagreeing).toEqual([
			path.join(".claude", "settings.json"),
		]);
	});

	it("counts a file that will not parse as disagreeing, either way", () => {
		fs.mkdirSync(path.join(home, ".claude"));
		fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{");
		expect(readBurnState(env()).disagreeing).toHaveLength(1);
		markerOn();
		expect(readBurnState(env()).disagreeing).toHaveLength(1);
	});

	it("claims no state, and says why, where the marker cannot be placed", () => {
		const state = readBurnState({});
		expect(state.on).toBeNull();
		expect(state.error).toEqual(expect.any(String));
	});
});

describe("the CLI half", () => {
	it("launch prints the remapped spelling", () => {
		expect(cli(["launch", "sonnet"]).stdout.trim()).toBe("claude-opus-5-5[1m]");
	});

	it("marker honours the override, and prints nothing on failure", () => {
		expect(
			cli(["marker"], "", {
				...process.env,
				WFC_BURN_MARKER: "/x/y/.burn-mode",
			}).stdout.trim(),
		).toBe("/x/y/.burn-mode");
		const r = cli(["nonsense"]);
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
	});

	it("an unknown mode or a missing argument exits 2", () => {
		expect(cli(["nonsense"]).status).toBe(2);
		expect(cli(["launch"]).status).toBe(2);
	});
});
