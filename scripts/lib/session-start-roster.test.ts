// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	allRegistrations,
	buildCommandLine,
	readCoreHooks,
} from "./hook-wiring";
import { WIRED_SCRIPT_RE } from "./rule-emission.js";
import { useScratchCore } from "./scratch-core-testkit";
import { readSessionStartRoster } from "./session-start-roster.js";

let dir = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-roster-"));
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	useScratchCore(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const write = (settings: unknown) =>
	fs.writeFileSync(
		path.join(dir, ".claude", "settings.json"),
		JSON.stringify(settings),
	);

describe("readSessionStartRoster", () => {
	it("picks up an inline-shell hook carrying both markers", () => {
		write({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								command:
									"WFC_NOTIFY_PERSIST=1 node " +
									'"$CLAUDE_PROJECT_DIR"/scripts/check-ghost-jobs.js --notify',
							},
						],
					},
				],
			},
		});
		expect(readSessionStartRoster(dir)).toEqual([
			{ key: "ghost-jobs", script: "check-ghost-jobs.js" },
		]);
	});

	it("picks up an exec-form hook whose markers sit in args", () => {
		write({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								command: "node",
								args: [
									"WFC_NOTIFY_PERSIST=1",
									"scripts/check-widget-fault.js",
									"--notify",
								],
							},
						],
					},
				],
			},
		});
		expect(readSessionStartRoster(dir)).toEqual([
			{ key: "widget-fault", script: "check-widget-fault.js" },
		]);
	});

	it("picks up a nested scripts/lib path by its basename, not just a top-level one", () => {
		write({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								command:
									"WFC_NOTIFY_PERSIST=1 node " +
									'"$CLAUDE_PROJECT_DIR"/scripts/lib/check-nested.js --notify',
							},
						],
					},
				],
			},
		});
		expect(readSessionStartRoster(dir)).toEqual([
			{ key: "nested", script: "check-nested.js" },
		]);
	});

	it("does not match a script path embedded in a longer word", () => {
		write({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								command:
									"WFC_NOTIFY_PERSIST=1 node " +
									"myscripts/check-ghost-jobs.js --notify",
							},
						],
					},
				],
			},
		});
		expect(readSessionStartRoster(dir)).toEqual([]);
	});

	it("ignores a hook missing --notify even where WFC_NOTIFY_PERSIST=1 is present", () => {
		write({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								command:
									"WFC_NOTIFY_PERSIST=1 node " +
									'"$CLAUDE_PROJECT_DIR"/scripts/check-ghost-jobs.js',
							},
						],
					},
				],
			},
		});
		expect(readSessionStartRoster(dir)).toEqual([]);
	});

	it("ignores an ordinary synchronous hook with neither marker", () => {
		write({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								command:
									'node "$CLAUDE_PROJECT_DIR"/scripts/check-ghost-jobs.js --notify',
							},
						],
					},
				],
			},
		});
		expect(readSessionStartRoster(dir)).toEqual([]);
	});

	it("applies a key override rather than stripping check- blindly", () => {
		write({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								command:
									"WFC_NOTIFY_PERSIST=1 node " +
									'"$CLAUDE_PROJECT_DIR"/scripts/check-cleared-trackers.js --notify',
							},
						],
					},
				],
			},
		});
		expect(
			readSessionStartRoster(dir, {
				keyOverrides: { "check-cleared-trackers": "check-cleared-trackers" },
			}),
		).toEqual([
			{ key: "check-cleared-trackers", script: "check-cleared-trackers.js" },
		]);
	});

	it("excludes the caller's own key", () => {
		write({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								command:
									"WFC_NOTIFY_PERSIST=1 node " +
									'"$CLAUDE_PROJECT_DIR"/scripts/replay-notify-reports.js --notify',
							},
						],
					},
				],
			},
		});
		expect(
			readSessionStartRoster(dir, { self: "replay-notify-reports" }),
		).toEqual([]);
	});

	it("is empty where settings.json is absent and the plugin wires no producer", () => {
		expect(readSessionStartRoster(path.join(dir, "nowhere"))).toEqual([]);
	});

	it("names the producers the core plugin wires at an adopter, beside its own (#2445)", () => {
		const persisting = (script: string) => ({
			SessionStart: [
				{
					hooks: [
						{
							command: `WFC_NOTIFY_PERSIST=1 node "$CLAUDE_PROJECT_DIR"/scripts/${script} --notify`,
						},
					],
				},
			],
		});
		useScratchCore(dir, persisting("check-from-plugin.js"));
		write({ hooks: persisting("check-own.js") });
		expect(readSessionStartRoster(dir)).toEqual([
			{ key: "own", script: "check-own.js" },
			{ key: "from-plugin", script: "check-from-plugin.js" },
		]);
	});

	it("is empty where settings.json will not parse", () => {
		fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "{ half-writ");
		expect(readSessionStartRoster(dir)).toEqual([]);
	});

	it("is empty where SessionStart is present but not an array", () => {
		write({ hooks: { SessionStart: "not-an-array" } });
		expect(readSessionStartRoster(dir)).toEqual([]);
	});
});

describe("agreement with scripts/lib/hook-wiring.ts", () => {
	const persisting = (line: string) =>
		line.includes("WFC_NOTIFY_PERSIST=1") && line.includes("--notify");

	it("agrees an exec-form entry is wired when its markers split across command and args", () => {
		write({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								command: "node",
								args: [
									"scripts/check-widget-fault.js",
									"WFC_NOTIFY_PERSIST=1",
									"--notify",
								],
							},
						],
					},
				],
			},
		});
		const settings = JSON.parse(
			fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"),
		);
		const wired = allRegistrations(settings)
			.filter((r) => r.event === "SessionStart")
			.map(buildCommandLine)
			.some(persisting);
		expect(wired).toBe(true);

		expect(readSessionStartRoster(dir)).toEqual([
			{ key: "widget-fault", script: "check-widget-fault.js" },
		]);
	});

	it("names exactly the SessionStart registrations both markers reach, over the real registration", () => {
		vi.stubEnv("WFC_SCRIPT_ROOT", undefined);
		const settings = readCoreHooks();
		const wired = allRegistrations(settings)
			.filter((r) => r.event === "SessionStart")
			.map(buildCommandLine)
			.filter(persisting)
			.flatMap((line) => [...line.matchAll(WIRED_SCRIPT_RE)])
			.map((m) => m[1] as string)
			.filter((rel) => rel.startsWith("scripts/") && rel.endsWith(".js"))
			.filter((rel) => !rel.slice("scripts/".length).includes("/"))
			.map((rel) => path.basename(rel, ".js"));

		expect(wired.length).toBeGreaterThan(0);

		const roster: Array<{ key: string; script: string }> =
			readSessionStartRoster(path.resolve(__dirname, "..", ".."));
		const rosterScripts = roster.map((r) => r.script.replace(/\.js$/, ""));

		for (const script of wired)
			expect(rosterScripts, `${script} missing from the roster`).toContain(
				script,
			);
		for (const script of rosterScripts)
			expect(wired, `${script} in the roster but not wired`).toContain(script);
	});
});
