// @vitest-environment node
/*
 * Pins the queue lander's two pre-commit gate sets (#4545): `--gates=merge`
 * runs only the guard-registry and test-read-edges gates, `--gates=batch`
 * every other gate bar one the lander's Actions run repeats, and no argument
 * every gate. The parse, the two merge gates, the merge set's exit and two
 * later gates — guard-test-isolation, which Actions repeats, and host-root,
 * which it does not — are cut from the real hook and run over stub checkers.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	cutGateFragment,
	registerTempCleanup,
	stagedRepo,
} from "./lib/precommit-gate-harness";
import { cutHookBlock, LIB } from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();

const CHECKERS = [
	"scripts/check-guard-registry.js",
	"scripts/generate-test-read-edges.js",
	"scripts/check-guard-test-isolation.js",
	"scripts/check-host-root.js",
];

const SCRIPT = [
	LIB,
	"JS_TEST_ERE='\\.(test|spec)\\.[cm]?[jt]sx?$'",
	cutHookBlock("wfc_gates=all", "esac"),
	cutGateFragment("scripts/check-guard-registry.js"),
	cutGateFragment("scripts/generate-test-read-edges.js"),
	cutHookBlock('if [ "$wfc_gates" = merge ]; then', "fi"),
	cutGateFragment("scripts/check-guard-test-isolation.js"),
	cutGateFragment("scripts/check-host-root.js"),
].join("\n\n");

/** The checkers the hook ran on `args`, in order, and its exit code. */
function run(...args: string[]): { code: number; ran: string[] } {
	const stub = (name: string) =>
		`require("node:fs").appendFileSync("ran.log", "${name}\\n");\n`;
	const { root } = stagedRepo(
		"gate-sets-",
		temps,
		Object.fromEntries(CHECKERS.map((c) => [c, stub(c)])),
		{ "scripts/a.test.ts": "x\n" },
	);
	const r = spawnSync("sh", ["-ec", SCRIPT, "pre-commit", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log = path.join(root, "ran.log");
	return {
		code: r.status ?? 1,
		ran: fs.existsSync(log)
			? fs.readFileSync(log, "utf8").trim().split("\n")
			: [],
	};
}

describe("the pre-commit gate sets", () => {
	it("runs every gate with no argument, as git calls it", () => {
		expect(run()).toEqual({ code: 0, ran: CHECKERS });
	});

	it("runs only the guard-registry and test-read-edges gates on a lander merge", () => {
		expect(run("--gates=merge")).toEqual({
			code: 0,
			ran: [
				"scripts/check-guard-registry.js",
				"scripts/generate-test-read-edges.js",
			],
		});
	});

	it("runs a gate Actions does not repeat on the batch, and skips one it does", () => {
		expect(run("--gates=batch")).toEqual({
			code: 0,
			ran: ["scripts/check-host-root.js"],
		});
	});

	it("runs every gate on an argument it does not know", () => {
		expect(run("--gates=all")).toEqual({ code: 0, ran: CHECKERS });
	});
});
