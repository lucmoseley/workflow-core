// @vitest-environment node
/*
 * Pins that npm run status prints the primitives count line on a clean run
 * (#4120). Black-box over a fixture core, reached through WFC_SCRIPT_ROOT, so
 * the run's figures are the fixture's and this repo's whole-tree counts, a
 * minute's work, are never taken. Breaking it hides the one line the founder
 * reads to tell whether the primitives are holding (#3365 story 28).
 *
 * The line is built in "lib/primitives-table.js", reached through
 * "check-primitives.js"; naming both here selects this test when either changes.
 *
 * It also pins the read-only default (#4449): a bare run passes no checker
 * `--write`, so history-trim, one of WRITERS, appends nothing to its watch
 * file, and `--write` reaches it. The other writers' bare runs are held
 * silent by their own tests (check-band-drift, check-orphaned-edits).
 *
 * spawn-kept: the adopter's case proves the script npm runs, so npm is its child.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withStatusScript } from "./lib/adopter-skeleton.js";
import { printed, stubGhRoutes } from "./lib/gh-stub";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { seatEnv } from "./lib/seat-testkit";

const SCRIPT = path.join(__dirname, "status-report.js");

const BASE = `# Code standards base

## Primitives

| Job | Primitive | Exemplar | Rule | Enforcing check |
|---|---|---|---|---|
| Writing output | \`writeFd\` | \`scripts/lib/write-fd.js\` | §N6 | \`scripts/check-out.js\` |

### §N6 · Output is synchronous — **hard**
`;

const CLEAN_CHECK = `process.stdout.write(JSON.stringify({ outcome: "OK", findings: [] }));\n`;

let dir: string;
let core: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-report-"));
	core = path.join(dir, "core");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(core, rel)), { recursive: true });
	fs.writeFileSync(path.join(core, rel), body);
};

/** A clean core and one closed sweep, with the env that reaches them. */
const buildCleanCoreEnv = () => {
	write("docs/code-standards-base.md", BASE);
	write("scripts/lib/write-fd.js", "");
	write("scripts/check-out.js", CLEAN_CHECK);
	fs.mkdirSync(path.join(dir, "gh"));
	const gh = stubGhRoutes(path.join(dir, "gh"), {
		"issue list*": printed(
			JSON.stringify([
				{
					number: 7,
					title: "Heresy sweep due",
					labels: [],
					closedAt: "2026-10-01T00:00:00Z",
					createdAt: "2026-09-01T00:00:00Z",
				},
			]),
		),
		"issue view 7 --json comments": printed(
			JSON.stringify({
				comments: [{ body: "**Filed:** 3 heresies: #8, #9, #10" }],
			}),
		),
	});
	return {
		...process.env,
		...gh.env,
		GITHUB_ACTIONS: "",
		WFC_SCRIPT_ROOT: core,
	};
};

const COUNT_LINE =
	"primitives: 1 enforced, 0 open breaches, 3 new heresies since the last sweep.";

describe("a primitives checker answering OK", () => {
	it("prints the count line", async () => {
		const env = buildCleanCoreEnv();

		const r = await runInProcessAsync(SCRIPT, ["--only", "primitives"], {
			cwd: core,
			env: { ...env, CLAUDE_PROJECT_DIR: core },
		});

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("▸ primitives  — OK");
		expect(r.stdout).toContain(COUNT_LINE);
		expect(r.stdout).not.toContain("nothing to report from");
	});

	it("prints it through the script an adopter is given, by npm run status (#4151)", () => {
		const env = buildCleanCoreEnv();
		const adopter = path.join(dir, "adopter");
		fs.mkdirSync(path.join(adopter, "scripts", "lib"), { recursive: true });
		fs.writeFileSync(
			path.join(adopter, "package.json"),
			withStatusScript("{}\n") as string,
		);
		fs.copyFileSync(
			path.join(__dirname, "lib", "resolve-core.js"),
			path.join(adopter, "scripts", "lib", "resolve-core.js"),
		);

		const r = spawnSync(
			"npm",
			["run", "status", "--", "--only", "primitives"],
			{
				cwd: adopter,
				encoding: "utf8",
				env: {
					...env,
					CLAUDE_PROJECT_DIR: adopter,
					WORKFLOW_CORE_DIR: path.resolve(__dirname, ".."),
				},
			},
		);

		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(COUNT_LINE);
	});
});

describe("a bare run writes nothing; --write reaches the writers (#4449)", () => {
	const runTrim = (args: string[]) => {
		const home = path.join(dir, "home");
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", "history.jsonl"),
			`${JSON.stringify({ display: "x", timestamp: Date.now(), sessionId: "s" })}\n`,
		);
		const watch = path.join(dir, "watch.jsonl");
		return runInProcessAsync(SCRIPT, ["--only", "history-trim", ...args], {
			env: {
				...process.env,
				HOME: home,
				...seatEnv(home),
				GITHUB_ACTIONS: "",
				WFC_HISTORY_TRIM_WATCH: watch,
			},
		}).then((r) => ({ ...r, recorded: fs.existsSync(watch) }));
	};

	it("records no reading without --write", async () => {
		const r = await runTrim([]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("history-trim");
		expect(r.recorded).toBe(false);
	});

	it("records it with --write", async () => {
		const r = await runTrim(["--write"]);
		expect(r.status).toBe(0);
		expect(r.recorded).toBe(true);
	});
});
