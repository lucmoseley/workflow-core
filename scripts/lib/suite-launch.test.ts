// @vitest-environment node
/*
 * Direct tests for scripts/lib/suite-launch.sh (#1528): every launch spelling
 * the three suite guards share, read through guard-parse.sh's own walk so a
 * quoted word arrives masked, as it does in a guard. A misread spelling is
 * misjudged by each guard taking its kind: a suite let past the cap or
 * detached unwatched, or a command that launches nothing refused.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkScratchDir } from "./git-fixture";

const PARSE = path.resolve(__dirname, "guard-parse.sh");
const LIB = path.resolve(__dirname, "suite-launch.sh");

let dir: string;
beforeAll(() => {
	dir = mkScratchDir("suite-launch-");
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ suiteRunners: ["scripts/build-site.js"] }),
	);
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			scripts: {
				test: "node --test",
				"test:changed": "node scripts/run-vitest.js --changed",
			},
		}),
	);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** `kind|script|taken` for each segment of the command, or `none`. */
const kindOf = (command: string) => {
	const r = spawnSync(
		"bash",
		[
			"-uo",
			"pipefail",
			"-c",
			`source ${PARSE}
source ${LIB}
seen() {
  shift
  gp_unwrap "$@"
  set -- "\${_gp_unwrapped[@]}"
  if suite_launch_kind "$@"; then
    q=""
    ((_sl_queued)) && q="|queued"
    echo "$_sl_kind|$_sl_script|$_sl_taken$q"
  else echo none; fi
}
gp_begin '.tool_input.command' command
gp_walk_commands seen`,
		],
		{
			cwd: dir,
			encoding: "utf8",
			input: JSON.stringify({ tool_input: { command } }),
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: dir,
				CLAUDE_CONFIG_DIR: path.join(dir, "config"),
			},
		},
	);
	return r.stdout.trim();
};

describe("suite_launch_kind", () => {
	it.each([
		["npm test", "npm-vitest|test|2"],
		["npm run test", "npm-vitest|test|3"],
		["npm run test:changed", "npm-vitest|test:changed|3"],
		["npm run test:watch", "npm-watch|test:watch|3"],
		["npm test:py", "npm-py|test:py|2"],
		["npm run test:py", "npm-py|test:py|3"],
		[`npm run "test"`, "npm-vitest|test|3"],
		[`npm run 'test:changed' -- --queue`, "npm-vitest|test:changed|3"],
		[`npm "test"`, "npm-vitest|test|2"],
		["/usr/bin/npm run test", "npm-vitest|test|3"],
		["node scripts/run-vitest.js", "wrapper||2"],
		["node /abs/scripts/run-vitest.js a.test.ts", "wrapper||2"],
		[`node "scripts/run-vitest.js"`, "wrapper||2"],
		["node --test", "other||0"],
		["node --test scripts/x.test.js", "other||0"],
		["pytest", "other||0"],
		["pytest -q tests/", "other||0"],
		["python3 -m pytest", "other||0"],
		["python -m unittest", "other||0"],
		["python3 scripts/foo.test.py", "other||0"],
		["python3 tests/test_foo.py", "other||0"],
		[`python3 "scripts/foo.test.py"`, "other||0"],
		["node scripts/build-site.js", "other||0"],
		["node /home/u/fb/scripts/build-site.js", "other||0"],
		// The non-vitest queue (#1776): the command behind it, queued.
		["node scripts/queue-run.js -- node --test", "other||0|queued"],
		["node /p/scripts/queue-run.js -- pytest -q", "other||0|queued"],
		["node scripts/queue-run.js pytest", "other||0|queued"],
		[
			"timeout 900 node scripts/queue-run.js -- timeout 600 python3 a.test.py",
			"other||0|queued",
		],
		// An npm script `--queue` cannot reach, not running run-vitest.js.
		["node scripts/queue-run.js -- npm run test", "other||0|queued"],
		[
			"node scripts/queue-run.js -- node scripts/build-site.js",
			"other||0|queued",
		],
	])("reads %s as a launch: %s", (command, kind) => {
		expect(kindOf(command)).toBe(kind);
	});

	it.each([
		"npm run build",
		"npm run lint",
		"npm test:changed",
		"npm test:watch",
		`npm run "$SCRIPT"`,
		"node --test-reporter x.js",
		`python3 -c "import pytest"`,
		`node -e "require('x')"`,
		"node scripts/other.js",
		"vitest run",
		"node scripts/queue-run.js -- npm run test:changed",
		"node scripts/queue-run.js -- node scripts/queue-run.js -- pytest",
		"node scripts/queue-run.js -- ls",
		"node scripts/queue-run.js --",
	])("reads %s as no launch", (command) => {
		expect(kindOf(command)).toBe("none");
	});

	it("reads each segment on its own", () => {
		expect(kindOf("npm run build && pytest")).toBe("none\nother||0");
	});
});
