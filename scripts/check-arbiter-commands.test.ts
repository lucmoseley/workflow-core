// @vitest-environment node
/*
 * Pins which sites check-arbiter-commands.js finds spelling an arbiter command
 * by hand, and which text it leaves alone (#3990, #3992).
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets the
 * next command print a path its shell splits or an install cannot run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-arbiter-commands.js");

/* A `$` of its own, so a fixture's `${word}` is text in the program it writes. */
const DOLLAR = "$";

let root: string;

const program = (rel: string, body: string) => {
	const at = path.join(root, "scripts", rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};

const run = () => {
	const r = runInProcess(SCRIPT, [], {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-commands-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-arbiter-commands", () => {
	it.each([
		["a scriptPath of the arbiter", 'scriptPath("session-arbiter.js");\n'],
		[
			"a literal command with a raw word",
			`const m = \`node scripts/session-arbiter.js release ${DOLLAR}{rel}\`;\n`,
		],
		[
			"a literal command with a hand-quoted word",
			`const m = \`node scripts/session-arbiter.js release '${DOLLAR}{rel}'\`;\n`,
		],
		[
			"a word after a placeholder",
			`const m = \`node scripts/session-arbiter.js claim <path> ${DOLLAR}{sid}\`;\n`,
		],
		[
			"a command concatenated",
			'const m = "node scripts/session-arbiter.js release " + rel;\n',
		],
		[
			"a word glued to fixed text",
			`const m = \`node scripts/session-arbiter.js claim docs/doc-map.md#${DOLLAR}{id}\`;\n`,
		],
		[
			"a word after a quoted argument",
			`const m = \`node scripts/session-arbiter.js claim "<path>" ${DOLLAR}{sid}\`;\n`,
		],
		[
			"a word after two spaces",
			`const m = \`node scripts/session-arbiter.js release  ${DOLLAR}{rel}\`;\n`,
		],
		[
			"a quoted script path",
			`const m = \`node "${DOLLAR}{root}/scripts/session-arbiter.js" release ${DOLLAR}{rel}\`;\n`,
		],
		[
			"a variable named for the arbiter",
			`const m = \`node ${DOLLAR}{ARBITER} release ${DOLLAR}{rel}\`;\n`,
		],
		["a corePath of the arbiter", 'corePath("scripts/session-arbiter.js");\n'],
		[
			"a word the tag would quote twice",
			`const m = buildArbiterCommand\`release ${DOLLAR}{shellQuote(rel)}\`;\n`,
		],
		[
			"a literal path with a placeholder",
			'const m = "node scripts/session-arbiter.js release --generator <path>";\n',
		],
		[
			"a literal path concatenated on to prose",
			'const m = "node scripts/session-arbiter.js list\\n\\n" + more;\n',
		],
		[
			"a literal path before an interpolation past the command's end",
			`const m = \`node scripts/session-arbiter.js list — ${DOLLAR}{more}\`;\n`,
		],
		[
			"a dot-relative literal path",
			'const m = "node ./scripts/session-arbiter.js list";\n',
		],
		[
			"a double-quoted literal path after a flag",
			'const m = `node --trace-warnings "scripts/session-arbiter.js" list`;\n',
		],
		[
			"a literal path after a flag with a value",
			'const m = "node --max-old-space-size=4096 scripts/session-arbiter.js list";\n',
		],
		[
			"a literal path after two spaces",
			'const m = "node  scripts/session-arbiter.js list";\n',
		],
		[
			"a parent-relative literal path",
			'const m = "node ../scripts/session-arbiter.js list";\n',
		],
		["a bare file name", 'const m = "node session-arbiter.js list";\n'],
	])("FAILs %s, naming the tag and its file", (_name, body) => {
		program("a.js", body);
		const { status, out } = run();
		expect(status).toBe(1);
		expect(out).toContain("FAIL: 1 hand-spelt arbiter command(s)");
		expect(out).toContain("scripts/a.js:1");
		expect(out).toContain("buildArbiterCommand");
		expect(out).toContain("scripts/lib/build-arbiter-command.js");
	});

	it.each([
		["the tag", `const m = buildArbiterCommand\`release ${DOLLAR}{rel}\`;\n`],
		[
			"a path named in prose, which runs nothing",
			'const m = "`scripts/session-arbiter.js` holds the store";\n',
		],
		[
			"a variable named for something else",
			`const m = \`node ${DOLLAR}{OTHER} release ${DOLLAR}{rel}\`;\n`,
		],
		[
			"a usage line, which runs nothing",
			`const m = \`usage: session-arbiter.js ${DOLLAR}{line}\`;\n`,
		],
		[
			"a comment",
			`// node scripts/session-arbiter.js release ${DOLLAR}{rel}\n`,
		],
	])("passes %s", (_name, body) => {
		program("a.js", body);
		expect(run().status).toBe(0);
	});

	it.each([
		[
			"above",
			'// arbiter-literal-exempt: corePaths spells it\nconst m = "node scripts/session-arbiter.js list";\n',
		],
		[
			"on",
			'const m = "node scripts/session-arbiter.js list"; // arbiter-literal-exempt: corePaths spells it\n',
		],
	])("passes a literal marked %s its line", (_where, body) => {
		program("a.js", body);
		expect(run().status).toBe(0);
	});

	it("refuses a marker with no reason", () => {
		program(
			"a.js",
			'// arbiter-literal-exempt:\nconst m = "node scripts/session-arbiter.js list";\n',
		);
		expect(run().status).toBe(1);
	});

	it("excuses no word by the marker, and reports its line once", () => {
		program(
			"a.js",
			`// arbiter-literal-exempt: corePaths spells it\nconst m = \`node scripts/session-arbiter.js release ${DOLLAR}{rel}\`;\n`,
		);
		const { status, out } = run();
		expect(status).toBe(1);
		expect(out).toContain("FAIL: 1 hand-spelt arbiter command(s)");
	});

	it("skips the builder and a test", () => {
		program(
			"lib/build-arbiter-command.js",
			'scriptPath("session-arbiter.js");\n',
		);
		program("a.test.js", 'scriptPath("session-arbiter.js");\n');
		expect(run().status).toBe(0);
	});
});
