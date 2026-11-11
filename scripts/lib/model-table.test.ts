// @vitest-environment node
/*
 * lib/model-table.js is the one table every model choice is translated through
 * (#4919): a standing layer, always on, that sends Sonnet work to Haiku at
 * xhigh; burn mode's layer, that sends Haiku work to Opus and Opus work to
 * Fable, at medium and low; and the off layer, that sends Fable to Opus (#4992).
 * An unknown spelling is left alone. Burn mode's marker and plan state are
 * ./burn-mode.test.ts's.
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

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	isFable,
	isOverflowSession,
	relaunchFlags,
	remapModel,
} from "./model-table";
import { runInProcess } from "./run-in-process";

const LIB = path.resolve(__dirname, "model-table.js");

const cli = (args: string[]) => runInProcess(LIB, args, { stdin: "" });

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
		["fable", "opus"],
	])("off: %s -> %s", (from, to) => {
		expect(dispatched({ model: from }, false)).toBe(to);
	});

	it.each([
		["sonnet", "opus · medium"],
		["haiku", "opus · medium"],
		["opus", "fable · low"],
		["fable", "fable"],
	])("on: %s -> %s", (from, to) => {
		expect(dispatched({ model: from }, true)).toBe(to);
	});

	it("runs every haiku call at xhigh off, whatever it asked, and sets burn's level on whatever it moves", () => {
		expect(dispatched({ model: "haiku", effort: "low" }, false)).toBe(
			"haiku · xhigh",
		);
		expect(dispatched({ model: "sonnet", effort: "medium" }, false)).toBe(
			"haiku · xhigh",
		);
		expect(dispatched({ model: "opus", effort: "high" }, true)).toBe(
			"fable · low",
		);
		expect(dispatched({ model: "haiku", effort: "xhigh" }, true)).toBe(
			"opus · medium",
		);
	});

	it("translates the code reviewer's definition model where the call names none", () => {
		expect(dispatched({ subagent_type: "code-reviewer" }, true)).toBe(
			"fable · low",
		);
		expect(dispatched({ subagent_type: "wfc:code-reviewer" }, true)).toBe(
			"fable · low",
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

	// Fable runs only through the burn layer (#4992).
	it.each(["fable", "claude-fable-5-1[1m]", "claude-fable-5-2[1m]"])(
		"off: moves %s to Opus",
		(model) => {
			expect(launched(model, false)).toBe("claude-opus-5-5[1m]");
		},
	);

	it.each(["opus", "opus[1m]", "claude-opus-5-5[1m]", "haiku"])(
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
		["a non-object", "opus"],
		["null", null],
	])("is null for %s", (_name, input) => {
		expect(remapModel(input, true)).toBeNull();
		expect(remapModel(input, false)).toBeNull();
	});
	it("is null for fable while burn mode is on, and moves it to opus while off (#4992)", () => {
		expect(remapModel({ model: "fable" }, true)).toBeNull();
		expect(remapModel({ model: "fable" }, false)?.input.model).toBe("opus");
	});
});

describe("a dispatch inheriting Fable (#4992)", () => {
	it.each([
		["no model", {}],
		["a type pinning none", { subagent_type: "general-purpose" }],
	])("pins %s to opus with burn mode off", (_n, call) => {
		const r = remapModel(call, false, "claude-fable-5-2");
		expect(r?.input.model).toBe("opus");
		expect(r?.note).toContain("would have inherited");
	});

	it("leaves it alone while burn mode is on, on a non-Fable session, and on a fork", () => {
		expect(remapModel({}, true, "claude-fable-5-2")).toBeNull();
		expect(remapModel({}, false, "claude-opus-5-5")).toBeNull();
		expect(remapModel({}, false, "")).toBeNull();
		expect(
			remapModel({ subagent_type: "fork" }, false, "claude-fable-5-2"),
		).toBeNull();
	});

	it("reads a call naming `inherit` as one naming none", () => {
		expect(
			remapModel({ model: "inherit" }, false, "claude-fable-5-2")?.input.model,
		).toBe("opus");
	});
});

describe("relaunchFlags — a saved Fable launch resumed with burn mode off (#4992)", () => {
	it("moves a saved Fable model to Opus, every other flag kept", () => {
		expect(
			relaunchFlags(["--name", "n", "--model", "claude-fable-5-2[1m]"], false),
		).toEqual(["--name", "n", "--model", "claude-opus-5-5[1m]"]);
		expect(relaunchFlags(["--model=fable", "--name", "n"], false)).toEqual([
			"--model=claude-opus-5-5[1m]",
			"--name",
			"n",
		]);
	});

	it("hands back the very array given where nothing moves", () => {
		for (const flags of [
			["--model", "claude-opus-5-5[1m]"],
			["--model", "sonnet"],
			["--name", "n"],
			["--model"],
		])
			expect(relaunchFlags(flags, false)).toBe(flags);
		const fable = ["--model", "claude-fable-5-2[1m]"];
		expect(relaunchFlags(fable, true)).toBe(fable);
	});
});

describe("isFable", () => {
	it("knows every Fable spelling and nothing else", () => {
		expect(isFable("claude-fable-5-2")).toBe(true);
		expect(isFable("claude-fable-5-2[1m]")).toBe(true);
		expect(isFable("fable")).toBe(true);
		expect(isFable("claude-opus-5-5")).toBe(false);
		expect(isFable("")).toBe(false);
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
