// @vitest-environment node
/*
 * Pins that burn-mode.sh writes the routing file's settings for the target
 * mode into every plan — its session `model`, and the effort under every id
 * and other name the mode's `modelSettings` names — over any hand-set value,
 * leaving every other key alone; that `on` and `off` re-apply when run twice;
 * that a routing file that will not load stops the switch before any write;
 * that `off` exits 1 keeping the marker where a plan is left out of step; and
 * that `status` writes nothing (#126, #127, #4919, #5032).
 *
 * The routing is the fixture's, by WFC_MODEL_ROUTING (lib/model-table.test.ts
 * names its rows), so no case pins a real routing value. Every write lands in
 * a scratch HOME and a scratch marker — the real ones are the machine's live
 * default.
 *
 * The burn-mode skill runs it, and lib/dispatch-rewrite.js and
 * dispatch-sessions.sh read its marker: loosen a case and an `off` can leave a
 * plan burning allowance unannounced.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "burn-mode.sh");
const FIXTURE = path.resolve(__dirname, "fixtures/model-routing/fixture.json");

/** The fixture's writes for each mode. */
const STANDARD = {
	model: "test-haiku-1[1m]",
	modelSettings: {
		"test-haiku-1": { effortLevel: "low" },
		"test-haiku-0": { effortLevel: "low" },
		"test-opus-2": { effortLevel: "high" },
		"test-opus-1": { effortLevel: "high" },
		opusish: { effortLevel: "high" },
	},
};
const BURN = {
	model: "test-sonnet-1[1m]",
	modelSettings: {
		"test-haiku-1": { effortLevel: "max" },
		"test-haiku-0": { effortLevel: "max" },
		"test-opus-2": { effortLevel: "medium" },
		"test-opus-1": { effortLevel: "medium" },
		opusish: { effortLevel: "medium" },
		"test-fable-1": { effortLevel: "xhigh" },
	},
};
const ON_MODEL = BURN.model;
const OFF_MODEL = STANDARD.model;

let dir: string;
let home: string;
let marker: string;
/** `claude`, listing no session, so `off`'s move of live sessions
 * (scripts/burn-off-sessions.js) never reaches the machine's own. */
let stub: string;

const settings = (plan: string) => path.join(home, plan, "settings.json");
const read = (plan: string) =>
	JSON.parse(fs.readFileSync(settings(plan), "utf8"));
const modelOf = (plan: string) => read(plan).model;
const write = (plan: string, json: object) =>
	fs.writeFileSync(settings(plan), JSON.stringify(json));
const withModel = (model: string) => ({ model });

const run = (arg: string, asHome = home, routing = FIXTURE) => {
	const r = spawnSync(SCRIPT, [arg], {
		encoding: "utf8",
		env: {
			...process.env,
			HOME: asHome,
			WFC_BURN_MARKER: marker,
			WFC_CLAUDE_BIN: stub,
			WFC_MODEL_ROUTING: routing,
		},
	});
	if (r.status === null) throw new Error(`script did not run: ${r.error}`);
	return r;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-mode-"));
	home = path.join(dir, "home");
	marker = path.join(dir, "burn-mode");
	stub = path.join(dir, "claude");
	fs.writeFileSync(stub, "#!/bin/sh\nprintf '[]'\n", { mode: 0o755 });
	for (const plan of [".claude", ".claude2"]) {
		fs.mkdirSync(path.join(home, plan), { recursive: true });
		write(plan, {
			model: "hand-set",
			modelSettings: {
				"test-opus-2": { effortLevel: "low", other: 1 },
				"unrelated-id": { effortLevel: "max" },
			},
			effortLevel: "medium",
			keep: 1,
		});
	}
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("on", () => {
	it("writes the marker and the burn settings into every plan, over hand-set values, every other key kept", () => {
		const r = run("on");
		expect(r.status, r.stderr).toBe(0);
		expect(fs.existsSync(marker)).toBe(true);
		for (const plan of [".claude", ".claude2"])
			expect(read(plan)).toEqual({
				model: ON_MODEL,
				modelSettings: {
					...BURN.modelSettings,
					"test-opus-2": { effortLevel: "medium", other: 1 },
					"unrelated-id": { effortLevel: "max" },
				},
				effortLevel: "medium",
				keep: 1,
			});
	});

	it("re-applies when run while on, so an edited value is rewritten", () => {
		run("on");
		write(".claude", { model: "drifted", keep: 2 });
		expect(run("on").status).toBe(0);
		expect(read(".claude")).toEqual({ ...BURN, keep: 2 });
	});

	it("stops with exit 2, writing nothing, on a routing file that will not load", () => {
		const broken = path.join(dir, "routing.json");
		fs.writeFileSync(broken, JSON.stringify({ models: {} }));
		const before = fs.readFileSync(settings(".claude"), "utf8");
		const r = run("on", home, broken);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("names no alias");
		expect(fs.existsSync(marker)).toBe(false);
		expect(fs.readFileSync(settings(".claude"), "utf8")).toBe(before);
	});

	it("leaves the marker through a failed on, so off undoes the plans it moved", () => {
		const plan = path.dirname(settings(".claude2"));
		fs.chmodSync(plan, 0o555);
		const r = run("on");
		fs.chmodSync(plan, 0o755);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(".claude2/settings.json");
		expect(fs.existsSync(marker)).toBe(true);
		expect(run("off").status).toBe(0);
		expect(modelOf(".claude")).toBe(OFF_MODEL);
	});
});

describe("the closing warnings", () => {
	// #568
	it.each(["on", "off"])(
		"%s says a restart is needed and names both stale sessions",
		(mode) => {
			const r = run(mode);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`burn mode: ${mode}`);
			expect(r.stdout).toMatch(/restart/i);
			expect(r.stdout).toContain("bg-spare");
			expect(r.stdout).toMatch(/agents view/);
			expect(r.stdout).toMatch(/launch line/);
			expect(r.stdout).toMatch(/throwaway/);
		},
	);

	it("status prints neither", () => {
		const r = run("status");
		expect(r.stdout).not.toContain("bg-spare");
		expect(r.stdout).not.toMatch(/launch line/);
	});
});

describe("off", () => {
	it("writes the standard settings into every plan and removes the marker", () => {
		run("on");
		const r = run("off");
		expect(r.status, r.stderr).toBe(0);
		expect(fs.existsSync(marker)).toBe(false);
		expect(read(".claude2")).toEqual({
			model: OFF_MODEL,
			modelSettings: {
				...BURN.modelSettings,
				...STANDARD.modelSettings,
				"test-opus-2": { effortLevel: "high", other: 1 },
				"unrelated-id": { effortLevel: "max" },
			},
			effortLevel: "medium",
			keep: 1,
		});
	});

	it("re-applies when run while off, over a hand-set value", () => {
		expect(run("off").status).toBe(0);
		write(".claude", { model: "hand-set" });
		expect(run("off").status).toBe(0);
		expect(read(".claude")).toEqual(STANDARD);
	});

	it("stops with exit 2, writing nothing and keeping the marker, on a routing file that will not load", () => {
		run("on");
		const broken = path.join(dir, "routing.json");
		fs.writeFileSync(broken, "{");
		const r = run("off", home, broken);
		expect(r.status).toBe(2);
		expect(fs.existsSync(marker)).toBe(true);
		expect(modelOf(".claude")).toBe(ON_MODEL);
	});

	it("exits 1 naming the plan it could not write, keeping the marker, so a second off retries it", () => {
		run("on");
		const plan = path.dirname(settings(".claude2"));
		fs.chmodSync(plan, 0o555);
		const r = run("off");
		fs.chmodSync(plan, 0o755);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("still departs from the standard settings");
		expect(r.stdout).toContain(".claude2/settings.json");
		expect(fs.existsSync(marker)).toBe(true);
		expect(modelOf(".claude2")).toBe(ON_MODEL);
		expect(modelOf(".claude")).toBe(OFF_MODEL);
		expect(run("off").status).toBe(0);
		expect(modelOf(".claude2")).toBe(OFF_MODEL);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("treats a plan whose settings.json is a symlink to another's as one file", () => {
		fs.rmSync(settings(".claude2"));
		// Built, not spelt: a literal here would read to the extractor as this
		// test reading the repo's own .claude/settings.json.
		fs.symlinkSync(
			path.relative(path.dirname(settings(".claude2")), settings(".claude")),
			settings(".claude2"),
		);
		const on = run("on");
		expect(on.status).toBe(0);
		const r = run("off");
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("still departs");
		expect(modelOf(".claude")).toBe(OFF_MODEL);
		// The alias is gone AND the real file is still listed — a status
		// listing no plan at all would satisfy the negative on its own.
		const listed = run("status").stdout;
		expect(listed).toContain(".claude/settings.json");
		expect(listed).not.toContain(".claude2/settings.json");
	});

	/* A settings.json symlinked to nothing is named and skipped, rather than
	 * emitting an empty path that jq then refuses without naming it. */
	it("names and skips a plan whose settings.json resolves to nothing", () => {
		fs.rmSync(settings(".claude2"));
		fs.symlinkSync("./gone.json", settings(".claude2"));
		const r = run("on");
		expect(r.status).toBe(0);
		expect(r.stderr.split(".claude2/settings.json")).toHaveLength(2);
		expect(modelOf(".claude")).toBe(ON_MODEL);
		expect(run("off").status).toBe(0);
		expect(modelOf(".claude")).toBe(OFF_MODEL);
	});

	it("names and skips a plan whose settings.json loops", () => {
		fs.rmSync(settings(".claude2"));
		fs.symlinkSync("settings.json", settings(".claude2"));
		const r = run("on");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(".claude2/settings.json");
		expect(modelOf(".claude")).toBe(ON_MODEL);
	});

	it("is idempotent — off when already off still exits 0", () => {
		expect(run("off").status).toBe(0);
	});
});

describe("status", () => {
	it("reports off and each plan's model without writing", () => {
		run("off");
		const before = fs.readFileSync(settings(".claude"), "utf8");
		const r = run("status");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("burn mode: off");
		expect(r.stdout).toContain(`model=${OFF_MODEL}`);
		expect(r.stdout).not.toContain("not the");
		expect(fs.readFileSync(settings(".claude"), "utf8")).toBe(before);
	});

	it("names a plan whose model departs from the mode's", () => {
		run("on");
		write(".claude2", { ...BURN, model: OFF_MODEL });
		const r = run("status");
		expect(r.stdout).toContain("burn mode: on");
		expect(r.stdout).toMatch(
			new RegExp(
				`\\.claude2/settings\\.json.*not the burn model, ${ON_MODEL.replace(/[[\]]/g, "\\$&")}`,
			),
		);
		expect(r.stdout).not.toMatch(/\.claude\/settings\.json.*not the/);
	});

	it("names a plan whose written effort departs, and one with the entry missing", () => {
		run("off");
		write(".claude", {
			...STANDARD,
			modelSettings: {
				...STANDARD.modelSettings,
				opusish: { effortLevel: "max" },
			},
		});
		const { "test-haiku-0": _gone, ...rest } = STANDARD.modelSettings;
		write(".claude2", { ...STANDARD, modelSettings: rest });
		const r = run("status");
		expect(r.stdout).toContain(
			"opusish effortLevel=max, not the standard effort, high",
		);
		expect(r.stdout).toContain(
			"test-haiku-0 effortLevel=absent, not the standard effort, low",
		);
	});

	it("names a plan absent a model key as absent, and one that will not parse", () => {
		write(".claude", {});
		fs.writeFileSync(settings(".claude2"), "{");
		const r = run("status");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("model=absent");
		expect(r.stdout).toContain("settings will not parse");
	});
});

describe("the marker is one per machine, not one per checkout", () => {
	const repo = (name: string) => {
		const at = path.join(dir, name);
		fs.mkdirSync(at, { recursive: true });
		spawnSync("git", ["init", "-q"], { cwd: at });
		return at;
	};

	/* CLAUDE_PROJECT_DIR is dropped because the resolver reads it first
	 * (lib/host-root.js): inherited, both scratch checkouts would have
	 * resolved to the real repo, and the write would land on the live marker. */
	const runIn = (at: string, arg: string) => {
		const { CLAUDE_PROJECT_DIR: _drop, ...env } = process.env;
		return spawnSync(SCRIPT, [arg], {
			cwd: at,
			encoding: "utf8",
			env: {
				...env,
				HOME: home,
				WFC_BURN_MARKER: "",
				WFC_CLAUDE_BIN: stub,
				WFC_MODEL_ROUTING: FIXTURE,
			},
		});
	};

	it("an on in one checkout is ended by an off in another", () => {
		const a = repo("checkout-a");
		const b = repo("checkout-b");
		expect(runIn(a, "on").status).toBe(0);
		expect(runIn(b, "status").stdout).toContain("burn mode: on");
		expect(runIn(b, "off").status).toBe(0);
		expect(runIn(a, "status").stdout).toContain("burn mode: off");
		expect(modelOf(".claude")).toBe(OFF_MODEL);
	});

	it("writes it beside the settings files it is the record for", () => {
		runIn(repo("checkout-c"), "on");
		expect(fs.existsSync(path.join(home, ".claude", ".burn-mode"))).toBe(true);
	});
});

/* #2532: a `.claude*` dir that is no `.claude<digits>` — the arm-test dirs —
 * is no plan, so burn mode neither moves nor records it. */
describe("the plan dirs", () => {
	it("leaves a non-plan .claude* dir alone through on, status and off", () => {
		fs.rmSync(settings(".claude2"));
		fs.symlinkSync(
			path.relative(path.dirname(settings(".claude2")), settings(".claude")),
			settings(".claude2"),
		);
		fs.mkdirSync(path.join(home, ".claude-exp-a"));
		write(".claude-exp-a", withModel(OFF_MODEL));
		expect(run("on").status).toBe(0);
		expect(modelOf(".claude")).toBe(ON_MODEL);
		expect(modelOf(".claude-exp-a")).toBe(OFF_MODEL);
		const listed = run("status").stdout;
		expect(listed).toContain(".claude/settings.json");
		expect(listed).not.toContain(".claude-exp-a");
		expect(listed).not.toContain(".claude2/settings.json");
		write(".claude-exp-a", withModel(ON_MODEL));
		expect(run("off").status).toBe(0);
		expect(modelOf(".claude")).toBe(OFF_MODEL);
		expect(modelOf(".claude-exp-a")).toBe(ON_MODEL);
	});

	it("finds the plans under a HOME that is itself a symlink", () => {
		const linked = path.join(dir, "linked-home");
		fs.symlinkSync(home, linked);
		expect(run("on", linked).status).toBe(0);
		expect(modelOf(".claude")).toBe(ON_MODEL);
		expect(modelOf(".claude2")).toBe(ON_MODEL);
	});

	it("refuses on, recording nothing, when HOME cannot be read", () => {
		const r = run("on", path.join(dir, "no-such-home"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`burn-mode: cannot list the plans under ${path.join(dir, "no-such-home")}`,
		);
		expect(fs.existsSync(marker)).toBe(false);
	});
});

describe("usage", () => {
	it("refuses an unknown verb, naming the three it takes", () => {
		const r = run("maybe");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("on|off|status");
	});
});
