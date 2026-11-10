// @vitest-environment node
/*
 * lib/burn-mode.js is the one table every model choice is translated through
 * (#4919): a standing layer, always on, that sends Sonnet work to Haiku at
 * xhigh; and burn mode's layer, that sends Haiku work to Opus and Opus work to
 * Fable, each at medium. An unknown spelling is left alone.
 *
 * The hook's shell half is tested in ../guard-dispatch-rewrite.test.ts,
 * the launcher's in ../dispatch-sessions-launch.test.ts, the toggle's in
 * ../burn-mode.test.ts. Here the table's functions are called in process, and
 * its CLI run as a program, since the shell halves read it through that CLI.
 *
 * `lib/dispatch-rewrite.js`, `dispatch-sessions.sh` and the `burn-mode`
 * skill's toggle all remap through this table: loosen a case here and work
 * runs on the wrong model or at the wrong effort.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOverflowSession, readBurnState, remapModel } from "./burn-mode";
import { runInProcess } from "./run-in-process";

const LIB = path.resolve(__dirname, "burn-mode.js");

const cli = (args: string[], stdin = "", env?: NodeJS.ProcessEnv) =>
	runInProcess(LIB, args, env ? { stdin, env } : { stdin });

/** The model and effort an Agent call is dispatched on. */
const dispatched = (call: Record<string, unknown>, burn: boolean) => {
	const out = remapModel(call, burn)?.input ?? call;
	return `${out.model ?? ""}${out.effort ? ` · ${out.effort}` : ""}`;
};

/** The launch spelling the CLI's `launch` mode prints for `model`. */
const launched = (model: string, burn: boolean) => {
	const r = cli(["launch", model, ...(burn ? ["--burn"] : [])]);
	expect(r.status, r.stderr).toBe(0);
	return r.stdout.trim();
};

describe("the dispatch table, exact match", () => {
	it.each([
		["sonnet", "haiku · xhigh"],
		["haiku", "haiku · xhigh"],
		["opus", "opus"],
		["fable", "fable"],
	])("off: %s -> %s", (from, to) => {
		expect(dispatched({ model: from }, false)).toBe(to);
	});

	it.each([
		["sonnet", "opus · medium"],
		["haiku", "opus · medium"],
		["opus", "fable · medium"],
		["fable", "fable"],
	])("on: %s -> %s", (from, to) => {
		expect(dispatched({ model: from }, true)).toBe(to);
	});

	it("runs every haiku call at xhigh off, whatever it asked, and sets medium on whatever burn moves", () => {
		expect(dispatched({ model: "haiku", effort: "low" }, false)).toBe(
			"haiku · xhigh",
		);
		expect(dispatched({ model: "sonnet", effort: "medium" }, false)).toBe(
			"haiku · xhigh",
		);
		expect(dispatched({ model: "opus", effort: "high" }, true)).toBe(
			"fable · medium",
		);
		expect(dispatched({ model: "haiku", effort: "xhigh" }, true)).toBe(
			"opus · medium",
		);
	});

	it("translates the code reviewer's definition model where the call names none", () => {
		expect(dispatched({ subagent_type: "code-reviewer" }, true)).toBe(
			"fable · medium",
		);
		expect(dispatched({ subagent_type: "wfc:code-reviewer" }, true)).toBe(
			"fable · medium",
		);
		expect(remapModel({ subagent_type: "code-reviewer" }, false)).toBeNull();
	});

	it("never guesses at a spelling it does not know", () => {
		expect(dispatched({ model: "opus[1m]" }, true)).toBe("opus[1m]");
		expect(dispatched({ model: "gpt-4" }, true)).toBe("gpt-4");
	});
});

describe("the launch table", () => {
	it.each([
		["sonnet", "claude-haiku-5-5[1m]"],
		["sonnet[1m]", "claude-haiku-5-5[1m]"],
		["claude-sonnet-5[1m]", "claude-haiku-5-5[1m]"],
		["claude-sonnet-5-5", "claude-haiku-5-5[1m]"],
		["claude-sonnet-5-5[1m]", "claude-haiku-5-5[1m]"],
		["opusplan", "claude-haiku-5-5[1m]"],
	])("off: %s -> %s", (from, to) => {
		expect(launched(from, false)).toBe(to);
	});

	it.each(["opus", "opus[1m]", "claude-opus-5-5[1m]", "haiku", "fable"])(
		"off: leaves %s alone",
		(model) => {
			expect(launched(model, false)).toBe(model);
		},
	);

	it.each([
		["sonnet", "claude-opus-5-5[1m]"],
		["haiku", "claude-opus-5-5[1m]"],
		["claude-haiku-5-5[1m]", "claude-opus-5-5[1m]"],
		["opus", "claude-fable-5-2[1m]"],
		["opus[1m]", "claude-fable-5-2[1m]"],
		["claude-opus-5-5[1m]", "claude-fable-5-2[1m]"],
	])("on: %s -> %s", (from, to) => {
		expect(launched(from, true)).toBe(to);
	});

	it.each(["fable", "claude-fable-5-1[1m]", "claude-fable-5-2[1m]"])(
		"on: leaves %s alone",
		(model) => {
			expect(launched(model, true)).toBe(model);
		},
	);
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

describe("remapModel — the table's transform over one Agent call", () => {
	it("moves the model and effort and carries every other field through", () => {
		const out = remapModel(
			{
				model: "sonnet",
				prompt: "Do it.",
				description: "d",
				subagent_type: "general-purpose",
			},
			true,
		);
		expect(out?.input).toEqual({
			model: "opus",
			effort: "medium",
			prompt: "Do it.",
			description: "d",
			subagent_type: "general-purpose",
		});
		expect(out?.note).toContain("Burn mode moved this dispatch from `sonnet`");
		expect(remapModel({ model: "sonnet" }, false)?.note).toContain(
			"The standing model table moved this dispatch",
		);
	});

	it.each([
		["no model named", { prompt: "x" }],
		["an empty model", { model: "  ", prompt: "x" }],
		[
			"a fork, which ignores the field",
			{ model: "sonnet", subagent_type: "fork" },
		],
		["fable, which neither layer moves", { model: "fable" }],
		["a non-object", "opus"],
		["null", null],
	])("is null for %s", (_name, input) => {
		expect(remapModel(input, true)).toBeNull();
		expect(remapModel(input, false)).toBeNull();
	});
});

describe("isOverflowSession — burn mode never reaches an overflow seat", () => {
	it("holds only for the session id the variable is pinned to", () => {
		const env = { WFC_OVERFLOW_SESSION: "s1" };
		expect(isOverflowSession(env, "s1")).toBe(true);
		expect(isOverflowSession(env, "s2")).toBe(false);
		expect(isOverflowSession({}, "")).toBe(false);
	});
});

describe("readBurnState — what the switch left on the machine", () => {
	let home: string;
	const env = () => ({
		HOME: home,
		WFC_BURN_MARKER: path.join(home, "marker"),
	});
	const plan = (name: string, model?: string) => {
		fs.mkdirSync(path.join(home, name), { recursive: true });
		fs.writeFileSync(
			path.join(home, name, "settings.json"),
			JSON.stringify(model === undefined ? {} : { model }),
		);
	};
	const offModel = "claude-opus-5-5[1m]";
	const onModel = "claude-fable-5-2[1m]";
	const markerOn = () => fs.writeFileSync(env().WFC_BURN_MARKER, "{}");

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "burn-state-"));
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("reads off, every plan agreeing, on the standing model or none", () => {
		plan(".claude", offModel);
		plan(".claude2");
		expect(readBurnState(env())).toEqual({
			on: false,
			disagreeing: [],
			error: null,
		});
	});

	it("names a plan left on the burn model with the marker gone", () => {
		plan(".claude", offModel);
		plan(".claude2", onModel);
		expect(readBurnState(env()).disagreeing).toEqual([
			path.join(".claude2", "settings.json"),
		]);
	});

	it("names a plan not moved while the marker reads on", () => {
		markerOn();
		plan(".claude", onModel);
		plan(".claude2", offModel);
		const state = readBurnState(env());
		expect(state.on).toBe(true);
		expect(state.disagreeing).toEqual([path.join(".claude2", "settings.json")]);
	});

	it("reads a plan in step on the burn target of what on found there", () => {
		plan(".claude", offModel);
		plan(".claude2", "claude-opus-5-5[1m]");
		const real = (name: string) =>
			fs.realpathSync(path.join(home, name, "settings.json"));
		fs.writeFileSync(
			env().WFC_BURN_MARKER,
			JSON.stringify({
				model: { [real(".claude")]: offModel, [real(".claude2")]: "haiku" },
			}),
		);
		plan(".claude", onModel);
		expect(readBurnState(env()).disagreeing).toEqual([]);
	});

	it("names one symlinked file once, and skips one resolving to nothing", () => {
		plan(".claude", onModel);
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
	it("launch prints the remapped spelling, the burn layer only with --burn", () => {
		expect(cli(["launch", "sonnet"]).stdout.trim()).toBe(
			"claude-haiku-5-5[1m]",
		);
		expect(cli(["launch", "sonnet", "--burn"]).stdout.trim()).toBe(
			"claude-opus-5-5[1m]",
		);
	});

	it("session reads an absent model as the standing default", () => {
		expect(cli(["session", ""]).stdout.trim()).toBe("claude-opus-5-5[1m]");
		expect(cli(["session", "", "--burn"]).stdout.trim()).toBe(
			"claude-fable-5-2[1m]",
		);
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

	it("reads --burn wherever it stands, and refuses an unknown flag", () => {
		expect(cli(["launch", "--burn", "sonnet"]).stdout.trim()).toBe(
			"claude-opus-5-5[1m]",
		);
		expect(cli(["launch", "sonnet", "--brun"]).status).toBe(2);
	});
});
