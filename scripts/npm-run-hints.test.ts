// @vitest-environment node
/*
 * How the npm-run-hints scan reads a file's text, and the hints a script
 * prints at an install-shaped root (#1289). The scan over the shipped tree
 * itself is `npm-run-hints-scan.test.ts` (#1900).
 *
 * Loosen a case and the scan can pass a hint an adopter cannot run, or a
 * guard can print `npm run` at an install where npm finds no such script.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hintsIn } from "./lib/npm-run-hints-testkit";
import { runInProcess } from "./lib/run-in-process";

describe("reading a file's text for hints (#1289)", () => {
	it("flags a printed hint and passes a comment, a declared name and an exemption", () => {
		const text = [
			'say("See: npm run check:guard-errors");',
			"// npm run check:labels, in a comment",
			'say("npm run test -- --changed");',
		].join("\n");
		expect(hintsIn("scripts/x.js", text)).toEqual([
			"scripts/x.js:1: npm run check:guard-errors",
		]);
		expect(
			hintsIn("scripts/x.sh", "# npm run status\necho 'npm run status'"),
		).toEqual(["scripts/x.sh:2: npm run status"]);
		expect(
			hintsIn(
				"scripts/generate-rule-fragments.js",
				"`npm run gen:rule-fragments`",
			),
		).toEqual([]);
		expect(
			hintsIn("docs/agents/rules/x.txt", "# run `npm run status`"),
		).toEqual(["docs/agents/rules/x.txt:1: npm run status"]);
	});
});

describe("a hint at an install-shaped root (#1289)", () => {
	let dir: string;
	let root: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-run-hints-"));
		root = path.join(dir, "plugins", "w f c");
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const run = (script: string, args: string[]) => {
		const r = runInProcess(path.join(__dirname, script), args, {
			cwd: dir,
			env: {
				...process.env,
				WFC_SCRIPT_ROOT: root,
				WFC_REPO_ROOT: dir,
				CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
				CLAUDE_CODE_SESSION_ID: "s1",
			},
		});
		return { status: r.status, out: `${r.stdout}${r.stderr}` };
	};
	const at = (name: string) => `'${root}/scripts/${name}'`;

	it.each([
		["status-report.js", ["--bogus"], 2, "status-report.js"],
		["check-cleared-trackers.js", ["--bogus"], 2, "check-cleared-trackers.js"],
		["jev-verdict.js", ["0000000000", "right"], 1, "jev-verdict.js"],
		["jev-verdict.js", ["--bogus"], 2, "jev-verdict.js"],
		["deliver-to-session.js", ["--bogus"], 2, "deliver-to-session.js"],
		["warm-fraction.js", [], 0, "pick-next.js"],
		["warm-fraction.js", ["--bogus"], 2, "warm-fraction.js"],
		[
			"generate-doc-map-section-a.js",
			["--bogus"],
			2,
			"generate-doc-map-section-a.js",
		],
	])("%s %j names %s at the plugin root", (script, args, status, named) => {
		const r = run(script, args);
		expect(r.status).toBe(status);
		expect(r.out).toContain(`node ${at(named)}`);
		expect(r.out).not.toContain("npm run");
	});

	it("names the plugin-root checker from the stale-write-back gate", () => {
		const r = spawnSync(
			"bash",
			[path.join(__dirname, "stale-write-back-gate.sh")],
			{
				cwd: dir,
				encoding: "utf8",
				env: {
					...process.env,
					WFC_PLUGIN_ROOT: "/plugins/wfc",
					GIT_CEILING_DIRECTORIES: dir,
					CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
					CLAUDE_CODE_SESSION_ID: "s1",
				},
			},
		);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"See: node /plugins/wfc/scripts/check-guard-errors.js",
		);
	});
});
