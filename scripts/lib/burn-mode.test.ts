// @vitest-environment node
/*
 * lib/burn-mode.js is burn mode's state (#4920): the one resolver for its
 * marker, and readBurnState, what the switch left on each plan, a symlinked
 * plan counted once (#187) and the marker's record of what `on` found read
 * back (mantahostels#130). Which model each layer moves to is
 * ./model-table.test.ts's. burn-mode.sh reads the marker and the plans through
 * the CLI, so it is run here as a program too.
 *
 * The dispatch remap, the launcher and the toggle all find the marker here,
 * and the refill panel reads its state: loosen a case and they disagree on
 * whether burn mode is on, or the panel reports a plan in step that is not.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBurnState } from "./burn-mode";
import { runInProcess } from "./run-in-process";

const LIB = path.resolve(__dirname, "burn-mode.js");

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
		expect(cli(["marker", "--burn"]).status).toBe(2);
	});
});
