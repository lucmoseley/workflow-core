// @vitest-environment node
/*
 * Tests for session-start-roster.js (mantahostels#2302, migrating
 * replay-notify-reports.js's roster read off its own hand-rolled scan).
 *
 * The parsing is exercised against a fixture adopter's settings.json on disk,
 * beside a scratch core's plugin hooks — the
 * module's own contract is a repoRoot path, not a pre-parsed object — plus a
 * cross-check against scripts/lib/hook-wiring.ts's reading of a fixture
 * exec-form entry.
 *
 * `replay-notify-reports.js`, itself a SessionStart hook the core registers,
 * replays only the producers this roster names; loosen
 * a case and a persisting hook drops off it, its reports written to disk and
 * never shown to a session.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	allRegistrations,
	buildCommandLine,
	readCoreHooks,
} from "./hook-wiring";
import { useScratchCore } from "./scratch-core-testkit";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const lib: any = require("./session-start-roster");
// biome-ignore lint/suspicious/noExplicitAny: as above
const ruleEmission: any = require("./rule-emission");

let dir = "";
let restoreCore: () => void;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-roster-"));
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	restoreCore = useScratchCore(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	restoreCore();
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
		expect(lib.readSessionStartRoster(dir)).toEqual([
			{ key: "ghost-jobs", script: "check-ghost-jobs.js" },
		]);
	});

	/* The gap mantahostels#2302 was filed over: the two markers split across `command`
	 * (the interpreter) and `args` (the script path and its own flag), which
	 * only a join reading both can ever see. */
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
		expect(lib.readSessionStartRoster(dir)).toEqual([
			{ key: "widget-fault", script: "check-widget-fault.js" },
		]);
	});

	/* A hook wiring a nested or dotted path is exactly what the shared
	 * WIRED_SCRIPT_RE's boundary and path handling exist to see correctly —
	 * a bespoke pattern silently dropped both from the roster. */
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
		expect(lib.readSessionStartRoster(dir)).toEqual([
			{ key: "nested", script: "check-nested.js" },
		]);
	});

	/* A bare word ending in the pattern, with no path-boundary character in
	 * front of it, must not match — WIRED_SCRIPT_RE's own anchor. */
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
		expect(lib.readSessionStartRoster(dir)).toEqual([]);
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
		expect(lib.readSessionStartRoster(dir)).toEqual([]);
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
		expect(lib.readSessionStartRoster(dir)).toEqual([]);
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
			lib.readSessionStartRoster(dir, {
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
			lib.readSessionStartRoster(dir, { self: "replay-notify-reports" }),
		).toEqual([]);
	});

	it("is empty where settings.json is absent and the plugin wires no producer", () => {
		expect(lib.readSessionStartRoster(path.join(dir, "nowhere"))).toEqual([]);
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
		expect(lib.readSessionStartRoster(dir)).toEqual([
			{ key: "own", script: "check-own.js" },
			{ key: "from-plugin", script: "check-from-plugin.js" },
		]);
	});

	it("is empty where settings.json will not parse", () => {
		fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "{ half-writ");
		expect(lib.readSessionStartRoster(dir)).toEqual([]);
	});

	it("is empty where SessionStart is present but not an array", () => {
		write({ hooks: { SessionStart: "not-an-array" } });
		expect(lib.readSessionStartRoster(dir)).toEqual([]);
	});
});

describe("agreement with scripts/lib/hook-wiring.ts", () => {
	const persisting = (line: string) =>
		line.includes("WFC_NOTIFY_PERSIST=1") && line.includes("--notify");

	/*
	 * hook-wiring.ts's own allRegistrations/buildCommandLine (TypeScript, mantahostels#2266)
	 * against this module's readSessionStartRoster (JS, routed through
	 * rule-emission.js's buildHookCommandLine). The fixture splits the two markers
	 * across `command` and `args` — the exact shape a join that dropped
	 * `args` would miss — so if session-start-roster.js's join regressed to
	 * `hook.command` alone, `wired` would still read true (hook-wiring.ts's
	 * own join is unaffected) while the roster would come back empty.
	 */
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

		expect(lib.readSessionStartRoster(dir)).toEqual([
			{ key: "widget-fault", script: "check-widget-fault.js" },
		]);
	});

	/* The real file, as a non-vacuous sanity check rather than the proof
	 * above: every persisting entry it wires today is inline-shell form, so
	 * this can only regress-guard the parse and the walk, never the
	 * args-join — that discrimination is the fixture case's alone. */
	it("names exactly the SessionStart registrations both markers reach, over the real registration", () => {
		delete process.env.WFC_SCRIPT_ROOT;
		const settings = readCoreHooks();
		const wired = allRegistrations(settings)
			.filter((r) => r.event === "SessionStart")
			.map(buildCommandLine)
			.filter(persisting)
			.flatMap((line) => [...line.matchAll(ruleEmission.WIRED_SCRIPT_RE)])
			.map((m) => m[1] as string)
			.filter((rel) => rel.startsWith("scripts/") && rel.endsWith(".js"))
			.filter((rel) => !rel.slice("scripts/".length).includes("/"))
			.map((rel) => path.basename(rel, ".js"));

		expect(wired.length).toBeGreaterThan(0);

		const roster: Array<{ key: string; script: string }> =
			lib.readSessionStartRoster(path.resolve(__dirname, "..", ".."));
		const rosterScripts = roster.map((r) => r.script.replace(/\.js$/, ""));

		for (const script of wired)
			expect(rosterScripts, `${script} missing from the roster`).toContain(
				script,
			);
		for (const script of rosterScripts)
			expect(wired, `${script} in the roster but not wired`).toContain(script);
	});
});
