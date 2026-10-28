// @vitest-environment node
/*
 * Pins what check-primitives.js refuses in a primitives table, and its count
 * line, each count unreadable in turn (#3451).
 *
 * Black-box over fixture roots, never this repo: a plugin root holding a base
 * table (reached through WFC_SCRIPT_ROOT, lib/script-path.js's test seam) and
 * a host root holding a local one. Where the two are one directory, the run
 * is the core's own, and a base fault FAILs; apart, it is an adopter's, and a
 * base fault only warns.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here
 * loosens that gate.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printed, stubGhRoutes, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-primitives.js");

const HEADER =
	"| Job | Primitive | Exemplar | Rule | Enforcing check |\n|---|---|---|---|---|\n";

let dir: string;

const write = (root: string, rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
};

/* A check program printing a runCheck envelope with `n` FAIL findings and
 * one WARN, which is no breach. */
const fakeCheck = (n: number) =>
	`process.stdout.write(JSON.stringify({ outcome: ${n > 0 ? '"FAIL"' : '"OK"'}, findings: [...Array.from({ length: ${n} }, () => ({ severity: "FAIL" })), { severity: "WARN" }] }));\n`;

const base = (rows: string) =>
	`# Code standards base\n\n## §0 How to use this\n\n## §N — programs\n\n### §N6 · Output is synchronous — **hard**\n\n## Primitives\n\n${HEADER}${rows}\n## §X — tests\n`;

const local = (rows: string) =>
	`# Local\n\n### §LX1 · A local rule — **judgement**\n\n## Primitives\n\n${HEADER}${rows}`;

const BASE_ROW =
	"| Writing output | `writeFd` | `scripts/lib/write-fd.js` | §N6 | `scripts/check-out.js` |\n";

const plugin = (root: string, rows = BASE_ROW) => {
	write(root, "docs/code-standards-base.md", base(rows));
	write(root, "scripts/lib/write-fd.js", "");
	write(root, "scripts/check-out.js", fakeCheck(2));
};

const sweepGh = () =>
	stubGhRoutes(path.join(dir, "gh"), {
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
		"repos/{owner}/{repo}/issues/7/sub_issues": printed(
			JSON.stringify([[{ number: 8 }, { number: 9 }, { number: 10 }]]),
		),
	});

const run = (
	pluginRoot: string,
	hostRoot: string,
	args: string[] = [],
	gh = sweepGh(),
) => {
	const r = runInProcess(SCRIPT, ["--root", hostRoot, ...args], {
		cwd: hostRoot,
		env: {
			...process.env,
			...gh.env,
			GITHUB_ACTIONS: "",
			CLAUDE_PROJECT_DIR: hostRoot,
			WFC_SCRIPT_ROOT: pluginRoot,
		},
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "primitives-"));
	fs.mkdirSync(path.join(dir, "gh"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("check-primitives", () => {
	it("OKs a clean pair of tables and prints the count line", () => {
		const core = path.join(dir, "core");
		plugin(core);
		write(
			core,
			"docs/code-standards.md",
			local(
				"| A local job | `x` | `lib/x.ts` | §LX1, §N6 | Standards axis criterion |\n",
			),
		);
		write(core, "lib/x.ts", "");
		const r = run(core, core);
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 2 primitives row(s), every path and § id real. primitives: 1 enforced, 2 open breaches, 3 new heresies since the last sweep.",
		);
	});

	it("FAILs a missing exemplar, naming the row and the path", () => {
		const core = path.join(dir, "core");
		plugin(core);
		fs.rmSync(path.join(core, "scripts/lib/write-fd.js"));
		const r = run(core, core);
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			'docs/code-standards-base.md:13 (row "Writing output"): its exemplar `scripts/lib/write-fd.js` does not exist',
		);
	});

	it("FAILs a missing enforcing check path, naming the row", () => {
		const core = path.join(dir, "core");
		plugin(core);
		fs.rmSync(path.join(core, "scripts/check-out.js"));
		const r = run(core, core, ["--paths-only"]);
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			'(row "Writing output"): its enforcing check `scripts/check-out.js` does not exist',
		);
	});

	it("FAILs a § id no standards file defines, naming the row", () => {
		const core = path.join(dir, "core");
		plugin(
			core,
			"| Writing output | `writeFd` | `scripts/lib/write-fd.js` | §N9 | `scripts/check-out.js` |\n",
		);
		const r = run(core, core, ["--paths-only"]);
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			'(row "Writing output"): its Rule cell cites §N9, which no standards file defines — cite the § that states the primitive',
		);
	});

	it("FAILs a base row citing a local § id, which the base cannot see", () => {
		const core = path.join(dir, "core");
		plugin(
			core,
			"| Writing output | `writeFd` | `scripts/lib/write-fd.js` | §LX1 | `scripts/check-out.js` |\n",
		);
		write(core, "docs/code-standards.md", local(""));
		const r = run(core, core, ["--paths-only"]);
		expect(r.status).toBe(1);
		expect(r.out).toContain("its Rule cell cites §LX1");
	});

	it("FAILs a local row naming a base row's job", () => {
		const core = path.join(dir, "core");
		plugin(core);
		write(
			core,
			"docs/code-standards.md",
			local(
				"| writing  output | `mine` | `scripts/lib/write-fd.js` | §N6 | Standards axis criterion |\n",
			),
		);
		const r = run(core, core, ["--paths-only"]);
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			'docs/code-standards.md:9 (row "writing  output"): it names the job of the base row at line 13, whose primitive is `writeFd`',
		);
	});

	it("FAILs a Primitives heading whose table header is misspelt, rather than reading it empty", () => {
		const core = path.join(dir, "core");
		plugin(core);
		write(
			core,
			"docs/code-standards.md",
			"# Local\n\n## Primitives\n\n| Job | Primitive | Exemplar |\n|---|---|---|\n",
		);
		const r = run(core, core);
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"docs/code-standards.md: its Primitives table's header is not | Job | Primitive | Exemplar | Rule | Enforcing check |",
		);
		expect(r.out).toContain(
			"enforced unknown (the local table is unreadable), open breaches unknown (the local table is unreadable)",
		);
	});

	it("resolves a local row at the host root and a base row at the plugin root, a base fault only warning in an adopter", () => {
		const pluginRoot = path.join(dir, "plugin");
		const host = path.join(dir, "host");
		plugin(pluginRoot);
		fs.rmSync(path.join(pluginRoot, "scripts/lib/write-fd.js"));
		write(
			host,
			"docs/code-standards.md",
			local(
				"| A local job | `x` | `lib/x.ts` | §LX1 | Standards axis criterion |\n",
			),
		);
		write(host, "lib/x.ts", "");
		const r = run(pluginRoot, host, ["--paths-only"]);
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN: 1 primitives table fault(s)");
		expect(r.out).toContain(
			"its exemplar `scripts/lib/write-fd.js` does not exist — point the cell at the file that does the job now, or drop the row — the plugin's to fix",
		);
		expect(r.out).not.toContain("lib/x.ts");
	});

	it("is BROKEN where the base cannot be read", () => {
		const r = run(path.join(dir, "nowhere"), dir);
		expect(r.status).toBe(2);
		expect(r.out).toContain(
			`the code standards base is unreadable at the plugin root (${path.join(dir, "nowhere", "docs/code-standards-base.md")}) — nothing was judged`,
		);
	});

	it("prints no count line and calls no gh under --paths-only", () => {
		const core = path.join(dir, "core");
		plugin(core);
		const gh = stubGhScript(path.join(dir, "gh"), "", { failing: true });
		const r = run(core, core, ["--paths-only"], gh);
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 1 primitives row(s), every path and § id real.",
		);
		expect(r.out).not.toContain("primitives: ");
	});

	describe("a count it cannot read prints as unknown with its reason, never 0", () => {
		it("open breaches, where a check prints no envelope", () => {
			const core = path.join(dir, "core");
			plugin(core);
			write(core, "scripts/check-out.js", "process.exitCode = 2;\n");
			const r = run(core, core);
			expect(r.status).toBe(0);
			expect(r.out).toContain(
				"open breaches unknown (scripts/check-out.js: it printed no --json envelope (exit 2))",
			);
		});

		it("open breaches, where a check answers BROKEN", () => {
			const core = path.join(dir, "core");
			plugin(core);
			write(
				core,
				"scripts/check-out.js",
				'process.stdout.write(JSON.stringify({ outcome: "BROKEN", findings: [] }));\n',
			);
			const r = run(core, core);
			expect(r.out).toContain(
				"open breaches unknown (scripts/check-out.js: it answered BROKEN)",
			);
		});

		it("new heresies, where gh cannot be reached", () => {
			const core = path.join(dir, "core");
			plugin(core);
			const gh = stubGhScript(path.join(dir, "gh"), "", { failing: true });
			const r = run(core, core, [], gh);
			expect(r.status).toBe(0);
			expect(r.out).toContain(
				"2 open breaches, new heresies since the last sweep unknown (the tracker did not answer",
			);
		});

		it("new heresies, where no sweep issue has closed", () => {
			const core = path.join(dir, "core");
			plugin(core);
			const gh = stubGhRoutes(path.join(dir, "gh"), {
				"issue list*": printed("[]"),
			});
			const r = run(core, core, [], gh);
			expect(r.out).toContain(
				"new heresies since the last sweep unknown (no *Heresy sweep due* issue has closed yet)",
			);
		});
	});
});
