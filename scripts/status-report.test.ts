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
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printed, stubGhRoutes } from "./lib/gh-stub";
import { runInProcessAsync } from "./lib/run-in-process.js";

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

describe("a primitives checker answering OK", () => {
	it("prints the count line", async () => {
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

		const r = await runInProcessAsync(SCRIPT, ["--only", "primitives"], {
			cwd: core,
			env: {
				...process.env,
				...gh.env,
				GITHUB_ACTIONS: "",
				CLAUDE_PROJECT_DIR: core,
				WFC_SCRIPT_ROOT: core,
			},
		});

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("▸ primitives  — OK");
		expect(r.stdout).toContain(
			"primitives: 1 enforced, 0 open breaches, 3 new heresies since the last sweep.",
		);
		expect(r.stdout).not.toContain("nothing to report from");
	});
});
