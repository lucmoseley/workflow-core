// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBurnState } from "./burn-mode";
import { runInProcess } from "./run-in-process";

const LIB = path.resolve(__dirname, "burn-mode.js");
const FIXTURE = path.resolve(
	__dirname,
	"../fixtures/model-routing/fixture.json",
);

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

const cli = (args: string[], stdin = "", env?: NodeJS.ProcessEnv) =>
	runInProcess(LIB, args, env ? { stdin, env } : { stdin });

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

describe("readBurnState — what the switch left on the machine", () => {
	let home: string;
	const env = () => ({
		HOME: home,
		WFC_BURN_MARKER: path.join(home, "marker"),
	});
	const plan = (name: string, settings: object) => {
		fs.mkdirSync(path.join(home, name), { recursive: true });
		fs.writeFileSync(
			path.join(home, name, "settings.json"),
			JSON.stringify(settings),
		);
	};
	const markerOn = () => fs.writeFileSync(env().WFC_BURN_MARKER, "");
	beforeEach(() => {
		vi.stubEnv("WFC_MODEL_ROUTING", FIXTURE);
		home = fs.mkdtempSync(path.join(os.tmpdir(), "burn-state-"));
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("reads off, every plan agreeing, where each holds the standard writes", () => {
		plan(".claude", STANDARD);
		plan(".claude2", { ...STANDARD, keep: 1 });
		expect(readBurnState(env())).toEqual({
			on: false,
			disagreeing: [],
			error: null,
		});
	});

	it("names a plan off the routing file's model", () => {
		plan(".claude", STANDARD);
		plan(".claude2", { ...STANDARD, model: "hand-set" });
		expect(readBurnState(env()).disagreeing).toEqual([
			path.join(".claude2", "settings.json"),
		]);
	});

	it("judges the plans against the same settings while the marker reads on", () => {
		markerOn();
		plan(".claude", STANDARD);
		plan(".claude2", { ...STANDARD, model: "hand-set" });
		const state = readBurnState(env());
		expect(state.on).toBe(true);
		expect(state.disagreeing).toEqual([path.join(".claude2", "settings.json")]);
	});

	it("names a plan whose written effort departs, under any id the routing file writes, or is missing", () => {
		plan(".claude", {
			...STANDARD,
			modelSettings: {
				...STANDARD.modelSettings,
				opusish: { effortLevel: "low" },
			},
		});
		const { "test-haiku-0": _gone, ...rest } = STANDARD.modelSettings;
		plan(".claude2", { ...STANDARD, modelSettings: rest });
		plan(".claude3", {
			...STANDARD,
			modelSettings: {
				...STANDARD.modelSettings,
				other: { effortLevel: "low" },
			},
		});
		expect(readBurnState(env()).disagreeing.sort()).toEqual([
			path.join(".claude", "settings.json"),
			path.join(".claude2", "settings.json"),
		]);
	});

	it("names one symlinked file once, and skips one resolving to nothing", () => {
		plan(".claude", { ...STANDARD, model: "hand-set" });
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

	it("claims no state, and says why, where the routing file will not load", () => {
		plan(".claude", STANDARD);
		const broken = path.join(home, "routing.json");
		fs.writeFileSync(broken, "{");
		vi.stubEnv("WFC_MODEL_ROUTING", broken);
		const state = readBurnState(env());
		expect(state.on).toBeNull();
		expect(state.error).toContain(broken);
	});
});

describe("the CLI half", () => {
	it("marker honours the override, and an unknown mode prints nothing", () => {
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

	it("refuses an unknown flag", () => {
		expect(cli(["marker", "--brun"]).status).toBe(2);
	});

	it("report prints each plan, exiting 1 where one departs from the routing file's writes", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "burn-report-"));
		try {
			fs.mkdirSync(path.join(home, ".claude"));
			fs.writeFileSync(
				path.join(home, ".claude", "settings.json"),
				JSON.stringify(STANDARD),
			);
			const routed = { ...process.env, HOME: home, WFC_MODEL_ROUTING: FIXTURE };
			const ok = cli(["report"], "", routed);
			expect(ok.status).toBe(0);
			expect(ok.stdout).toContain(`model=${STANDARD.model}`);
			fs.writeFileSync(
				path.join(home, ".claude", "settings.json"),
				JSON.stringify({ ...STANDARD, model: "hand-set" }),
			);
			const off = cli(["report"], "", routed);
			expect(off.status).toBe(1);
			expect(off.stdout).toContain("not the routing file's model");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});
