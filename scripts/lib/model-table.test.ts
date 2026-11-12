// @vitest-environment node
/*
 * lib/model-table.js translates every model choice through the routing file
 * (#5032): a dispatch, a launch and a plan's settings, per mode. The mechanism
 * is tested here on a fixture routing file whose values are unlike the real
 * ones, passed by WFC_MODEL_ROUTING, so a value edit to the real file breaks
 * nothing here; the real file is held to its shape alone, at the end.
 *
 * The fixture's routed-away model is `sonnet`: standard mode moves it, and
 * burn mode runs on it.
 *
 * The hook's shell half is tested in ../guard-dispatch-rewrite.test.ts,
 * the launcher's in ../dispatch-sessions-launch.test.ts, the toggle's in
 * ../burn-mode.test.ts. Here the table's functions are called in process, and
 * its CLI run as a program, since the shell halves read it through that CLI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	isOverflowSession,
	isRoutedAway,
	loadRouting,
	modeSettings,
	relaunchFlags,
	remapModel,
} from "./model-table";
import { runInProcess } from "./run-in-process";

const LIB = path.resolve(__dirname, "model-table.js");
const FIXTURE = path.resolve(
	__dirname,
	"../fixtures/model-routing/fixture.json",
);
const REAL = path.resolve(__dirname, "model-routing.json");

beforeEach(() => {
	vi.stubEnv("WFC_MODEL_ROUTING", FIXTURE);
});

const cli = (args: string[], routing = FIXTURE) =>
	runInProcess(LIB, args, {
		stdin: "",
		env: { ...process.env, WFC_MODEL_ROUTING: routing },
	});

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

describe("a named dispatch, routed by the mode's row", () => {
	it.each([
		["haiku", "haiku · low"],
		["sonnet", "opus"],
		["opus", "opus · high"],
		["fable", "fable · max"],
	])("standard: %s -> %s", (from, to) => {
		expect(dispatched({ model: from }, false)).toBe(to);
	});

	it.each([
		["haiku", "fable · high"],
		["sonnet", "sonnet · max"],
		["opus", "sonnet"],
		["fable", "haiku"],
	])("burn: %s -> %s", (from, to) => {
		expect(dispatched({ model: from }, true)).toBe(to);
	});

	it("replaces the call's effort where the row sets one, and keeps it where the row's is null", () => {
		expect(dispatched({ model: "opus", effort: "xhigh" }, false)).toBe(
			"opus · high",
		);
		expect(dispatched({ model: "opus", effort: "medium" }, true)).toBe(
			"sonnet · medium",
		);
		expect(remapModel({ model: "opus", effort: "high" }, false)).toBeNull();
	});

	it("routes the code reviewer's definition-pinned model where the call names none", () => {
		expect(dispatched({ subagent_type: "code-reviewer" }, false)).toBe(
			"opus · high",
		);
		expect(dispatched({ subagent_type: "wfc:code-reviewer" }, true)).toBe(
			"sonnet",
		);
	});

	it("reads a call's model by the one spelling rule, and never guesses at one it does not know", () => {
		expect(dispatched({ model: "test-opus-1[1m]" }, false)).toBe("opus · high");
		expect(remapModel({ model: "gpt-4" }, true)).toBeNull();
		expect(remapModel({ model: "claude-opus-5-5" }, true)).toBeNull();
	});
});

describe("remapModel — the table's transform over one Agent call", () => {
	it("moves the model and effort and carries every other field through", () => {
		const out = remapModel(
			{
				model: "haiku",
				prompt: "Do it.",
				description: "d",
				subagent_type: "general-purpose",
			},
			true,
		);
		expect(out?.input).toEqual({
			model: "fable",
			effort: "high",
			prompt: "Do it.",
			description: "d",
			subagent_type: "general-purpose",
		});
		expect(out?.note).toContain("Burn mode moved this dispatch from `haiku`");
		expect(out?.note).toContain("off` ends it");
		expect(remapModel({ model: "opus" }, false)?.note).toContain(
			"The standing model table moved this dispatch",
		);
	});

	it("credits burn mode only with a move its rows make that the standard rows do not (#5006)", () => {
		const routing = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
		routing.modes.burn.route.opus = routing.modes.standard.route.opus;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-same-"));
		const file = path.join(dir, "routing.json");
		fs.writeFileSync(file, JSON.stringify(routing));
		vi.stubEnv("WFC_MODEL_ROUTING", file);
		try {
			const out = remapModel({ model: "opus", effort: "low" }, true);
			expect(out?.input.effort).toBe("high");
			expect(out?.note).toContain(
				"The standing model table moved this dispatch",
			);
			expect(out?.note).not.toContain("Burn mode");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		["no model named", { prompt: "x" }],
		["an empty model", { model: "  ", prompt: "x" }],
		[
			"a fork, which ignores the field",
			{ model: "opus", subagent_type: "fork" },
		],
		["a non-object", "opus"],
		["null", null],
	])("is null for %s", (_name, input) => {
		expect(remapModel(input, true)).toBeNull();
		expect(remapModel(input, false)).toBeNull();
	});
});

describe("a dispatch inheriting a routed-away session model (#4992)", () => {
	it.each([
		["no model", {}],
		["a type pinning none", { subagent_type: "general-purpose" }],
		["`inherit`", { model: "inherit" }],
	])("pins %s to the standard row in standard mode", (_n, call) => {
		const r = remapModel(call, false, "test-sonnet-1[1m]");
		expect(r?.input.model).toBe("opus");
		expect(r?.input.effort).toBeUndefined();
		expect(r?.note).toContain("would have inherited");
	});

	it("leaves it alone in burn mode, on a session not routed away, and on a fork", () => {
		expect(remapModel({}, true, "test-sonnet-1")).toBeNull();
		expect(remapModel({}, false, "test-fable-1")).toBeNull();
		expect(remapModel({}, false, "test-opus-2")).toBeNull();
		expect(remapModel({}, false, "")).toBeNull();
		expect(
			remapModel({ subagent_type: "fork" }, false, "test-sonnet-1"),
		).toBeNull();
	});
});

describe("the one spelling rule", () => {
	it.each([
		["opus", "opus"],
		["opus[1m]", "opus"],
		["test-opus-2", "opus"],
		["test-opus-2[1m]", "opus"],
		["test-opus-1", "opus"],
		["opusish[1m]", "opus"],
		[" test-haiku-0 ", "haiku"],
		["test-sonnet-0[1m]", "sonnet"],
		["claude-opus-5-5", ""],
		["opus[200k]", ""],
		["", ""],
	])("%s runs as %s", (spelling, alias) => {
		const r = cli(["alias", spelling]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(`${alias}\n`);
	});
});

describe("isRoutedAway — a model only burn mode puts work on", () => {
	it("holds for a model standard mode moves and burn mode runs on, in every spelling", () => {
		for (const s of ["sonnet", "test-sonnet-0[1m]", "test-sonnet-1"])
			expect(isRoutedAway(s)).toBe(true);
	});

	it("is false for a model standard mode keeps, or one burn mode never runs on", () => {
		for (const s of ["haiku", "test-fable-1", "opusish", "nonsense", ""])
			expect(isRoutedAway(s)).toBe(false);
	});
});

describe("relaunchFlags — a saved routed-away launch resumed in standard mode (#4992)", () => {
	it("moves the saved model to the standard row's launch spelling, joined or split, every other flag kept", () => {
		expect(
			relaunchFlags(["--name", "n", "--model", "test-sonnet-1[1m]"], false),
		).toEqual(["--name", "n", "--model", "test-opus-2[1m]"]);
		expect(relaunchFlags(["--model=sonnet", "--name", "n"], false)).toEqual([
			"--model=test-opus-2[1m]",
			"--name",
			"n",
		]);
	});

	it("hands back the very array given where nothing moves", () => {
		for (const flags of [
			["--model", "test-haiku-1[1m]"],
			["--model", "test-fable-1"],
			["--name", "n"],
			["--model"],
		])
			expect(relaunchFlags(flags, false)).toBe(flags);
		const away = ["--model", "test-sonnet-1[1m]"];
		expect(relaunchFlags(away, true)).toBe(away);
	});
});

describe("modeSettings — what a mode writes into every plan", () => {
	it("names the session's launch spelling, and each effort under the id and every other name", () => {
		expect(modeSettings(false)).toEqual({
			model: "test-haiku-1[1m]",
			modelSettings: {
				"test-haiku-1": { effortLevel: "low" },
				"test-haiku-0": { effortLevel: "low" },
				"test-opus-2": { effortLevel: "high" },
				"test-opus-1": { effortLevel: "high" },
				opusish: { effortLevel: "high" },
			},
		});
		expect(modeSettings(true).model).toBe("test-sonnet-1[1m]");
		expect(modeSettings(true).modelSettings["test-fable-1"]).toEqual({
			effortLevel: "xhigh",
		});
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
	it("launch renders the row's target as its id with [1m]", () => {
		expect(launched("sonnet", false)).toBe("test-opus-2[1m]");
		expect(launched("test-sonnet-0[1m]", false)).toBe("test-opus-2[1m]");
		expect(launched("opus[1m]", true)).toBe("test-sonnet-1[1m]");
		expect(launched("haiku", true)).toBe("test-fable-1[1m]");
		expect(launched("fable", true)).toBe("test-haiku-1[1m]");
	});

	it("launch keeps a spelling its row keeps on its own alias, or one it does not know, as given", () => {
		expect(launched("haiku", false)).toBe("haiku");
		expect(launched("test-haiku-0[1m]", false)).toBe("test-haiku-0[1m]");
		expect(launched("test-opus-1", false)).toBe("test-opus-1");
		expect(launched("sonnet[1m]", true)).toBe("sonnet[1m]");
		expect(launched("gpt-4", true)).toBe("gpt-4");
	});

	it("session reads an absent model as the mode's session model", () => {
		expect(cli(["session", ""]).stdout.trim()).toBe("test-haiku-1[1m]");
		expect(cli(["session", "", "--burn"]).stdout.trim()).toBe(
			"test-sonnet-1[1m]",
		);
		expect(cli(["session", "opus", "--burn"]).stdout.trim()).toBe(
			"test-sonnet-1[1m]",
		);
	});

	it("alias prints the alias a spelling runs as, or nothing", () => {
		expect(cli(["alias", "opusish[1m]"]).stdout).toBe("opus\n");
		const none = cli(["alias", "gpt-4"]);
		expect(none.status).toBe(0);
		expect(none.stdout).toBe("\n");
	});

	it("admits on an overflow seat only the overflow alias and its current id, bare or 1M", () => {
		for (const s of ["opus", "opus[1m]", "test-opus-2", "test-opus-2[1m]"])
			expect(cli(["admits", s]).status, s).toBe(0);
		for (const s of ["test-opus-1", "opusish", "haiku", "opus[200k]"])
			expect(cli(["admits", s]).status, s).toBe(1);
	});

	it("settings prints the mode's writes as JSON", () => {
		const r = cli(["settings", "--burn"]);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).model).toBe("test-sonnet-1[1m]");
	});

	it("an unknown mode or a missing argument exits 2", () => {
		expect(cli(["nonsense"]).status).toBe(2);
		expect(cli(["launch"]).status).toBe(2);
		expect(cli(["admits"]).status).toBe(2);
		expect(cli(["settings", "extra"]).status).toBe(2);
	});

	it("reads --burn wherever it stands, and refuses an unknown flag", () => {
		expect(cli(["launch", "--burn", "haiku"]).stdout.trim()).toBe(
			"test-fable-1[1m]",
		);
		expect(cli(["launch", "haiku", "--brun"]).status).toBe(2);
	});
});

describe("a routing file that will not load", () => {
	let dir: string;
	const write = (name: string, body: unknown) => {
		const file = path.join(dir, name);
		fs.writeFileSync(
			file,
			typeof body === "string" ? body : JSON.stringify(body),
		);
		return file;
	};
	const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-"));
	});
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	it.each([
		["not JSON", () => "{", "will not read as JSON"],
		[
			"an alias missing from a mode",
			() => {
				const f = fixture();
				delete f.modes.burn.route.sonnet;
				return f;
			},
			"modes.burn.route has no row for sonnet",
		],
		[
			"an unknown `to`",
			() => {
				const f = fixture();
				f.modes.standard.route.opus.to = "gpt";
				return f;
			},
			"modes.standard.route.opus.to is not a known alias",
		],
		[
			"an effort that is no level",
			() => {
				const f = fixture();
				f.modes.burn.route.haiku.effort = "huge";
				return f;
			},
			"modes.burn.route.haiku.effort",
		],
		[
			"a settings effort that is null",
			() => {
				const f = fixture();
				f.modes.standard.modelSettings.haiku = null;
				return f;
			},
			"modes.standard.modelSettings.haiku is not an effort level",
		],
		[
			"a name two aliases claim",
			() => {
				const f = fixture();
				f.models.fable.also = ["opusish"];
				return f;
			},
			"`opusish` names both",
		],
	])("throws on %s, naming the file and the fault", (name, body, fault) => {
		const file = write(`${name.replace(/\W+/g, "-")}.json`, body());
		expect(() => loadRouting({ WFC_MODEL_ROUTING: file })).toThrow(`${file}: `);
		expect(() => loadRouting({ WFC_MODEL_ROUTING: file })).toThrow(fault);
		const r = cli(["launch", "opus"], file);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(fault);
	});

	it("says a missing routing file cannot be read, not that it is bad JSON", () => {
		const file = path.join(dir, "absent.json");
		expect(() => loadRouting({ WFC_MODEL_ROUTING: file })).toThrow(
			`${file}: cannot be read — ENOENT`,
		);
	});
});

describe("the real routing file — its shape, never its values", () => {
	it("loads, routes every alias in both modes to a known alias at a valid level", () => {
		const routing = loadRouting({ WFC_MODEL_ROUTING: REAL });
		const aliases = Object.keys(routing.models);
		const levels = ["low", "medium", "high", "xhigh", "max"];
		for (const mode of Object.values(routing.modes)) {
			expect(aliases).toContain(mode.session);
			expect(Object.keys(mode.route).sort()).toEqual([...aliases].sort());
			for (const row of Object.values(mode.route)) {
				expect(aliases).toContain(row.to);
				if (row.effort !== null) expect(levels).toContain(row.effort);
			}
			for (const [alias, level] of Object.entries(mode.modelSettings)) {
				expect(aliases).toContain(alias);
				expect(levels).toContain(level);
			}
		}
	});
});
