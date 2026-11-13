// @vitest-environment node
/*
 * Holds lib/rescue-ports-fake.ts, the ports rescue-sessions' module cases run
 * on (#5157), to the production adapters its shell wires: its oracle to
 * lib/agent-liveness.js's runOracle, and its `claude stop` to
 * lib/claude-stop.js's stopOn over spawnRaw, each against a `claude` stub
 * printing the installed harness's recordings (lib/agents-stop-fake.ts, held
 * to the harness by lib/agents-stop.contract.test.ts). Breaking it costs the
 * module cases their meaning: a listing or a failed seat the fake folds as
 * runOracle never would passes a case the probe fails on.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentsAnswer,
	buildAgentsBranch,
	buildJobRow,
	buildStopBranch,
	type Row,
} from "./agents-stop-fake";
import { writeClaudeStub } from "./claude-stub";
import { mkScratchDir } from "./git-fixture";
import { createRescuePorts } from "./rescue-ports-fake";

const { runOracle } = require("./agent-liveness.js") as {
	runOracle: (bin: string, timeoutMs: number, dirs: string[]) => string[];
};
const { stopOn } = require("./claude-stop.js");

const TIMEOUT_MS = 10_000;

let dir = "";
beforeEach(() => {
	dir = mkScratchDir("rescue-ports-");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const seat = (name: string) => path.join(dir, name);

/** What each side answers for `seats`, each listing its rows or failing. */
function both(seats: Record<string, Row[] | null>) {
	const bySeat: Record<string, AgentsAnswer> = {};
	const fake = createRescuePorts(path.join(dir, "proc"));
	for (const [name, rows] of Object.entries(seats)) {
		bySeat[seat(name)] = rows;
		if (rows === null) fake.failing(seat(name));
		else fake.listsRaw(seat(name), rows);
	}
	const bin = writeClaudeStub(path.join(dir, "claude"), [
		buildAgentsBranch(null, bySeat),
	]);
	const dirs = Object.keys(seats).map(seat);
	const settle = (run: () => string[]) => {
		try {
			return { out: run() };
		} catch (e) {
			const { message, status } = e as { message: string; status: unknown };
			return { message, status };
		}
	};
	return {
		real: settle(() => runOracle(bin, TIMEOUT_MS, dirs)),
		fake: settle(() => fake.ports.oracle(bin, TIMEOUT_MS, dirs)),
	};
}

describe("the fake oracle against runOracle on a recorded stub", () => {
	it.each<[string, Record<string, Row[] | null>]>([
		["one seat's rows", { a: [buildJobRow("abcd1234", "working")] }],
		[
			"two seats' rows, each its own",
			{
				a: [buildJobRow("abcd1234", "working")],
				b: [
					buildJobRow("ef015678", "working"),
					buildJobRow("01234567", "done"),
				],
			},
		],
		["a seat listing nothing", { a: [] }],
		["a failing seat beside a listing one", { a: [], b: null }],
		["the only seat failing", { a: null }],
	])("answers %s as runOracle does", (_what, seats) => {
		const { real, fake } = both(seats);
		expect(fake).toEqual(real);
	});
});

describe("the fake `claude stop` against stopOn on a recorded stub", () => {
	it("answers a stop that takes as the recorded one does", () => {
		const fake = createRescuePorts(path.join(dir, "proc"));
		const bin = writeClaudeStub(path.join(dir, "claude"), [
			buildStopBranch(path.join(dir, "stops"), "ok"),
		]);
		const real = stopOn(seat("a"), "abcd1234", bin);
		const faked = stopOn(seat("a"), "abcd1234", bin, {
			spawn: fake.ports.claude,
		});
		expect(real.ok).toBe(true);
		expect(faked).toEqual(real);
		expect(fake.stops).toEqual([{ job: "abcd1234", seat: seat("a") }]);
	});

	it("answers a stop that fails as a failed stop, as the stub does", () => {
		const fake = createRescuePorts(path.join(dir, "proc"));
		fake.stopFails(seat("a"));
		const bin = writeClaudeStub(path.join(dir, "claude"), [
			buildStopBranch(path.join(dir, "stops"), "busy"),
		]);
		const real = stopOn(seat("a"), "abcd1234", bin);
		const faked = stopOn(seat("a"), "abcd1234", bin, {
			spawn: fake.ports.claude,
		});
		expect(real.ok).toBe(false);
		expect(faked.ok).toBe(false);
		expect(faked.why).toMatch(/^exit 1: /);
		expect(real.why).toMatch(/^exit 1: /);
	});
});
