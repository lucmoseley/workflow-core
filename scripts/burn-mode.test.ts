// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, emptyRepoTemplate } from "./lib/git-fixture";

const SCRIPT = path.resolve(__dirname, "burn-mode.sh");
const FIXTURE = path.resolve(__dirname, "fixtures/model-routing/fixture.json");

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
const MODEL = STANDARD.model;

let dir: string;
let home: string;
let marker: string;
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
	it("writes the marker and the routing file's settings into every plan, over hand-set values, every other key kept", () => {
		const r = run("on");
		expect(r.status, r.stderr).toBe(0);
		expect(fs.existsSync(marker)).toBe(true);
		for (const plan of [".claude", ".claude2"])
			expect(read(plan)).toEqual({
				model: MODEL,
				modelSettings: {
					...STANDARD.modelSettings,
					"test-opus-2": { effortLevel: "high", other: 1 },
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
		expect(read(".claude")).toEqual({ ...STANDARD, keep: 2 });
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

	it("exits 1 naming the plan a failed on could not write, the marker set", () => {
		const plan = path.dirname(settings(".claude2"));
		fs.chmodSync(plan, 0o555);
		const r = run("on");
		fs.chmodSync(plan, 0o755);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(".claude2/settings.json");
		expect(fs.existsSync(marker)).toBe(true);
		expect(modelOf(".claude")).toBe(MODEL);
	});
});

describe("the closing warnings", () => {
	it.each(["on", "off"])(
		"%s says the dispatch routing is live with no restart",
		(mode) => {
			const r = run(mode);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`burn mode: ${mode}`);
			expect(r.stdout).toContain("next Agent call");
			expect(r.stdout).toContain("no session needs a restart");
		},
	);

	it("status prints none of it", () => {
		expect(run("status").stdout).not.toContain("next Agent call");
	});
});

describe("off", () => {
	it("writes the routing file's settings into every plan and removes the marker", () => {
		run("on");
		const r = run("off");
		expect(r.status, r.stderr).toBe(0);
		expect(fs.existsSync(marker)).toBe(false);
		expect(read(".claude2")).toEqual({
			model: MODEL,
			modelSettings: {
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
		write(".claude", withModel("hand-set"));
		const broken = path.join(dir, "routing.json");
		fs.writeFileSync(broken, "{");
		const r = run("off", home, broken);
		expect(r.status).toBe(2);
		expect(fs.existsSync(marker)).toBe(true);
		expect(modelOf(".claude")).toBe("hand-set");
	});

	it("exits 1 naming the plan it could not write, the marker removed, so a second off retries it", () => {
		const plan = path.dirname(settings(".claude2"));
		fs.chmodSync(plan, 0o555);
		const r = run("off");
		fs.chmodSync(plan, 0o755);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("departs from the routing file's settings");
		expect(r.stdout).toContain(".claude2/settings.json");
		expect(fs.existsSync(marker)).toBe(false);
		expect(modelOf(".claude2")).toBe("hand-set");
		expect(modelOf(".claude")).toBe(MODEL);
		expect(run("off").status).toBe(0);
		expect(modelOf(".claude2")).toBe(MODEL);
	});

	it("treats a plan whose settings.json is a symlink to another's as one file", () => {
		fs.rmSync(settings(".claude2"));
		fs.symlinkSync(
			path.relative(path.dirname(settings(".claude2")), settings(".claude")),
			settings(".claude2"),
		);
		const on = run("on");
		expect(on.status).toBe(0);
		const r = run("off");
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("departs");
		expect(modelOf(".claude")).toBe(MODEL);
		const listed = run("status").stdout;
		expect(listed).toContain(".claude/settings.json");
		expect(listed).not.toContain(".claude2/settings.json");
	});

	it("names and skips a plan whose settings.json resolves to nothing", () => {
		fs.rmSync(settings(".claude2"));
		fs.symlinkSync("./gone.json", settings(".claude2"));
		const r = run("on");
		expect(r.status).toBe(0);
		expect(r.stderr.split(".claude2/settings.json")).toHaveLength(2);
		expect(modelOf(".claude")).toBe(MODEL);
	});

	it("names and skips a plan whose settings.json loops", () => {
		fs.rmSync(settings(".claude2"));
		fs.symlinkSync("settings.json", settings(".claude2"));
		const r = run("on");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(".claude2/settings.json");
		expect(modelOf(".claude")).toBe(MODEL);
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
		expect(r.stdout).toContain(`model=${MODEL}`);
		expect(r.stdout).not.toContain("not the");
		expect(fs.readFileSync(settings(".claude"), "utf8")).toBe(before);
	});

	it("names a plan whose model departs from the routing file's", () => {
		run("on");
		write(".claude2", { ...STANDARD, model: "hand-set" });
		const r = run("status");
		expect(r.stdout).toContain("burn mode: on");
		expect(r.stdout).toMatch(
			new RegExp(
				`\\.claude2/settings\\.json.*not the routing file's model, ${MODEL.replace(/[[\]]/g, "\\$&")}`,
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
			"opusish effortLevel=max, not the routing file's effort, high",
		);
		expect(r.stdout).toContain(
			"test-haiku-0 effortLevel=absent, not the routing file's effort, low",
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
	const emptyRepo = defineTemplate(emptyRepoTemplate);
	const repo = (name: string) => emptyRepo.instantiate(path.join(dir, name));

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
	});

	it("writes it beside the settings files it is the record for", () => {
		runIn(repo("checkout-c"), "on");
		expect(fs.existsSync(path.join(home, ".claude", ".burn-mode"))).toBe(true);
	});
});

describe("the plan dirs", () => {
	it("leaves a non-plan .claude* dir alone through on, status and off", () => {
		fs.rmSync(settings(".claude2"));
		fs.symlinkSync(
			path.relative(path.dirname(settings(".claude2")), settings(".claude")),
			settings(".claude2"),
		);
		fs.mkdirSync(path.join(home, ".claude-exp-a"));
		write(".claude-exp-a", withModel("hand-set"));
		expect(run("on").status).toBe(0);
		expect(modelOf(".claude")).toBe(MODEL);
		expect(modelOf(".claude-exp-a")).toBe("hand-set");
		const listed = run("status").stdout;
		expect(listed).toContain(".claude/settings.json");
		expect(listed).not.toContain(".claude-exp-a");
		expect(listed).not.toContain(".claude2/settings.json");
		expect(run("off").status).toBe(0);
		expect(modelOf(".claude-exp-a")).toBe("hand-set");
	});

	it("finds the plans under a HOME that is itself a symlink", () => {
		const linked = path.join(dir, "linked-home");
		fs.symlinkSync(home, linked);
		expect(run("on", linked).status).toBe(0);
		expect(modelOf(".claude")).toBe(MODEL);
		expect(modelOf(".claude2")).toBe(MODEL);
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
