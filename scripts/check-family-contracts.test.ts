// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-family-contracts.js");

let root: string;

const write = (rel: string, body: string) => {
	const at = path.join(root, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};

const registerHooks = (rel: string, commands: string[]) =>
	write(
		rel,
		JSON.stringify({
			hooks: {
				SessionStart: [
					{ hooks: commands.map((command) => ({ type: "command", command })) },
				],
			},
		}),
	);

const run = () => {
	const r = runInProcess(SCRIPT, [], {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const PLUGIN_ROOT = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");
const GATE = 'const { runCheck } = require("./lib/check");\nrunCheck(SPEC);\n';
const FILE = 'createIssue({ title: "t", labels: [], body: "b" });\n';

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "family-contracts-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-family-contracts", () => {
	it("FAILs a program gating through runCheck with no check- prefix and no opening #N", () => {
		write("scripts/sweep-things.js", `#!/usr/bin/env node\n${GATE}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 family-contract breach(es)");
		expect(r.out).toContain(
			"scripts/sweep-things.js:3 gates through runCheck with no `check-` prefix and no opening bare #N. Fix: take the `check-` prefix and that family's contract whole, or open the file with the bare #N of the issue ruling its departure (§N3, §G4).",
		);
	});

	it.each([
		["createIssue", FILE, 1],
		["an issue-create argument pair", 'gh([\n\t"issue",\n\t"create"]);\n', 2],
		["the issue filer's argv", "fileThrough(buildScriptFilerArgv({}));\n", 1],
		["fileThrough", "fileThrough(argv, body, root);\n", 1],
		[
			"a spawn of file-issue.js",
			'\nrun(path.join(__dirname, "file-issue.js"), argv);\n',
			2,
		],
	])(
		"FAILs a program filing through %s with no report- prefix",
		(_, body, line) => {
			write("scripts/answer-things.js", body);
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				`scripts/answer-things.js:${line} files a GitHub issue with no \`report-\` prefix`,
			);
		},
	);

	it("FAILs a familyless program a hook registration runs, from either registration file", () => {
		registerHooks("hooks/hooks.json", [
			`node "${PLUGIN_ROOT}"/scripts/inject-things.js --notify || true`,
		]);
		registerHooks(".claude/settings.json", [
			'node "$CLAUDE_PROJECT_DIR"/scripts/record-things.js',
		]);
		write("scripts/inject-things.js", "noop();\n");
		write("scripts/record-things.js", "noop();\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 2 family-contract breach(es)");
		expect(r.out).toContain(
			"scripts/inject-things.js:1 runs as a registered hook with no `guard-` prefix",
		);
		expect(r.out).toContain(
			"scripts/record-things.js:1 runs as a registered hook with no `guard-` prefix",
		);
	});

	it.each([
		["no call at all", "module.exports = { main };\n"],
		[
			"runCheck only in a comment or string",
			'// runCheck(SPEC)\nconst t = "runCheck(";\n',
		],
	])("FAILs a check- program that never calls runCheck, with %s", (_, body) => {
		write("scripts/check-x.js", `#!/usr/bin/env node\n${body}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"scripts/check-x.js:1 takes the `check-` prefix but never gates through runCheck, and opens with no bare #N. Fix: gate through runCheck and its five-outcome alphabet, or open the file with the bare #N of the issue ruling its departure (§N3, §N4).",
		);
	});

	it("passes a check- program off runCheck that opens on its ruling issue", () => {
		write(
			"scripts/check-x.js",
			"#!/usr/bin/env node\n// #123\nmodule.exports = {};\n",
		);
		const r = run();
		expect(r.status).toBe(0);
	});

	it("passes a departing program that opens on its ruling issue, after a shebang or not", () => {
		write("scripts/sweep-things.js", `#!/usr/bin/env node\n\n// #123\n${GATE}`);
		write("scripts/answer-things.js", `// owner/repo#45\n${FILE}`);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 2 top-level program(s), each keeping a family's contract under its prefix or its ruling issue.",
		);
	});

	it("passes family members, inert mentions, libraries, tests and skills' hook scripts", () => {
		registerHooks("hooks/hooks.json", [
			"node scripts/check-hooked.js --notify || true",
			"node scripts/guard-hooked.js",
			`node "${PLUGIN_ROOT}"/.claude/skills/x/scripts/skill-hook.js`,
		]);
		write("scripts/check-hooked.js", GATE);
		write("scripts/guard-hooked.js", "noop();\n");
		write("scripts/report-filer.js", FILE);
		write("scripts/skill-hook.js", "noop();\n");
		write(
			"scripts/explain-things.js",
			'// runCheck(SPEC) and createIssue({}) in a comment\nconst t = "runCheck( createIssue( gh issue create";\nconst hint = "file it with node " + scriptPath("file-issue.js");\n',
		);
		write("scripts/lib/sweep-lib.js", GATE);
		write("scripts/sweep-things.test.js", GATE);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 5 top-level program(s)");
	});
});
