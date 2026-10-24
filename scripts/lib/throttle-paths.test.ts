// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	historyFile,
	refreshStamp,
	stateFile,
	throttleEnv,
} from "./throttle-paths.js";

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "throttle-paths-"));
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

describe("the throttling paths (#2098)", () => {
	it("sit under HOME's .claude, whatever the repo root", () => {
		const env = { HOME: home };
		expect(stateFile(env)).toBe(
			path.join(home, ".claude", ".self-throttling-state.json"),
		);
		expect(refreshStamp(env)).toBe(`${stateFile(env)}.refresh`);
		expect(historyFile(env)).toBe(
			path.join(home, ".claude", ".self-throttling-history.jsonl"),
		);
	});

	it("yield to each override", () => {
		const env = {
			HOME: home,
			WFC_THROTTLE_STATE: "/s",
			WFC_THROTTLE_REFRESH_STAMP: "/r",
			WFC_THROTTLE_HISTORY: "/h",
		};
		expect([stateFile(env), refreshStamp(env), historyFile(env)]).toEqual([
			"/s",
			"/r",
			"/h",
		]);
	});

	it("fall back off HOME where HOME is relative", () => {
		expect(stateFile({ HOME: "rel" })).not.toContain(
			path.join("rel", ".claude"),
		);
	});

	it("hand a child this process's three paths", () => {
		const env = { HOME: home };
		expect(throttleEnv(env)).toEqual({
			WFC_THROTTLE_STATE: stateFile(env),
			WFC_THROTTLE_REFRESH_STAMP: refreshStamp(env),
			WFC_THROTTLE_HISTORY: historyFile(env),
		});
	});
});
