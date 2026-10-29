// @vitest-environment node
/*
 * Pins which files check-gh-route.js finds reaching `gh` or `claude` off its
 * one route, lib/gh.js and WFC_GH or lib/claude-bin.js and WFC_CLAUDE_BIN,
 * over the whole tree, and that its refusal names the primitive and its
 * exemplar (#3455, #3559).
 *
 * Fabricated files in a throwaway directory, never this checkout, so a case's
 * findings are only its own. The Node and TypeScript bodies live in
 * lib/fixtures/gh-route/ as `.txt`, which the checker never reads, so this file
 * holds no breach of its own.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets a
 * `gh` or `claude` call escape every test's stub and reach the live tracker or
 * the live sessions.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-gh-route.js");

let root: string;

const file = (rel: string, body: string) => {
	const at = path.join(root, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};

const FIXTURE = {
	"claude-copies.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/claude-copies.js.txt",
	),
	"claude-lib.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/claude-lib.js.txt",
	),
	"claude-on-primitive.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/claude-on-primitive.js.txt",
	),
	"claude-path-stub.ts.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/claude-path-stub.ts.txt",
	),
	"claude-second-var.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/claude-second-var.js.txt",
	),
	"claude-wfc-stub.ts.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/claude-wfc-stub.ts.txt",
	),
	"cites.js.txt": path.join(__dirname, "lib/fixtures/gh-route/cites.js.txt"),
	"env-read.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/env-read.js.txt",
	),
	"gh-lib.js.txt": path.join(__dirname, "lib/fixtures/gh-route/gh-lib.js.txt"),
	"literal-spawn-marked.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/literal-spawn-marked.js.txt",
	),
	"literal-spawn.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/literal-spawn.js.txt",
	),
	"on-primitive.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/on-primitive.js.txt",
	),
	"other-stub.ts.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/other-stub.ts.txt",
	),
	"path-stub-exempt.ts.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/path-stub-exempt.ts.txt",
	),
	"path-stub-joined.ts.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/path-stub-joined.ts.txt",
	),
	"path-stub.ts.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/path-stub.ts.txt",
	),
	"second-var-marked.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/second-var-marked.js.txt",
	),
	"second-var.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/second-var.js.txt",
	),
	"second-var.ts.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/second-var.ts.txt",
	),
	"sets.js.txt": path.join(__dirname, "lib/fixtures/gh-route/sets.js.txt"),
	"wfc-stub.ts.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/wfc-stub.ts.txt",
	),
};

const fixture = (rel: string, name: keyof typeof FIXTURE) =>
	file(rel, fs.readFileSync(FIXTURE[name], "utf8"));

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const TEXT_ONLY = 'msg="Apply it; gh issue edit 7"\n';

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-route-"));
	// shellFiles() asks git which files are vendored.
	execFileSync("git", ["init", "-q"], { cwd: root });
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-gh-route", () => {
	it("FAILs a local copy of the spawn, naming file, line, lib/gh.js and its exemplar", () => {
		fixture("scripts/arm.js", "env-read.js.txt");
		fixture("scripts/lib/spawn.js", "literal-spawn.js.txt");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 2 second binary route(s)");
		expect(r.out).toContain(
			"2 second binary route(s): scripts/arm.js:2, scripts/lib/spawn.js:1.",
		);
		expect(r.out).toContain(
			"Fix: call `gh`, `ghJson` or their kin from scripts/lib/gh.js, as scripts/check-issue-orphans.js does.",
		);
	});

	it("FAILs a second var for the binary, in any code file", () => {
		fixture("scripts/lib/debts.js", "second-var.js.txt");
		fixture("scripts/lib/kit.ts", "second-var.ts.txt");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"2 second binary route(s): scripts/lib/debts.js:1, scripts/lib/kit.ts:1.",
		);
		expect(r.out).toContain(
			"Fix: name the binary through WFC_GH, the one var scripts/lib/gh.js reads, as scripts/check-issue-orphans.js and scripts/link-sub-issue.sh do.",
		);
	});

	it.each([
		["at a line's start", 'gh issue view "$n" --json title\n'],
		["in a command substitution", 't="$(timeout 12 gh issue view "$n")"\n'],
		["after a pipe", "echo x | gh api user\n"],
		["after if", "if gh auth status; then :; fi\n"],
		["after !", "! gh auth status && exit 1\n"],
		["in backticks", "t=`gh api user`\n"],
		["after command", "command gh auth status\n"],
		["probed with command -v", "command -v gh >/dev/null || exit 0\n"],
		["probed with type -P", "type -P gh >/dev/null || exit 0\n"],
		["probed with which", "which gh >/dev/null || exit 0\n"],
	])("FAILs a shell script running a bare gh %s", (_, line) => {
		file("scripts/hook.sh", `#!/usr/bin/env bash\n${line}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 second binary route(s): scripts/hook.sh:2.");
		expect(r.out).toContain(
			`Fix: run "\${WFC_GH:-gh}", the var scripts/lib/gh.js reads, as scripts/link-sub-issue.sh does`,
		);
	});

	it("FAILs a pre-commit hook, its local half and an extensionless shell script running a bare gh", () => {
		file(".husky/pre-commit", "#!/bin/sh\ngh auth status || exit 1\n");
		file(".husky/pre-commit.local", "#!/bin/sh\ngh auth status || exit 1\n");
		file("scripts/lib/tool", "#!/usr/bin/env bash\ngh auth status\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"3 second binary route(s): .husky/pre-commit:2, .husky/pre-commit.local:2, scripts/lib/tool:2.",
		);
		expect(r.out).toContain(`Fix: run "\${WFC_GH:-gh}"`);
	});

	it("FAILs a test prepending PATH with the directory holding its gh stub", () => {
		fixture("scripts/a.test.ts", "path-stub.ts.txt");
		fixture("scripts/b.test.ts", "path-stub-joined.ts.txt");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"2 second binary route(s): scripts/a.test.ts:3, scripts/b.test.ts:2.",
		);
		expect(r.out).toContain(
			"Fix: point WFC_GH at the stub, with `stubGhScript` or `stubGhRoutes` from scripts/lib/gh-stub.ts, as scripts/check-issue-orphans.test.ts does.",
		);
	});

	it("passes the one route: lib/gh.js, a program on it, a shell caller on WFC_GH, a stub at WFC_GH, and gh named only in comments", () => {
		fixture("scripts/lib/gh.js", "gh-lib.js.txt");
		fixture("scripts/on.js", "on-primitive.js.txt");
		file(
			"scripts/hook.sh",
			[
				"#!/usr/bin/env bash",
				`gh="\${WFC_GH:-gh}"`,
				'command -v "$gh" >/dev/null || exit 0',
				'timeout 12 "$gh" issue view 7',
				"# gh issue view 7",
				"",
			].join("\n"),
		);
		fixture("scripts/a.test.ts", "wfc-stub.ts.txt");
		fixture("scripts/b.test.ts", "other-stub.ts.txt");
		fixture("scripts/cites.js", "cites.js.txt");
		fixture("scripts/sets.js", "sets.js.txt");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 7 file(s), every `gh` call on WFC_GH and every `claude` call on WFC_CLAUDE_BIN.",
		);
	});

	it("honours the opt-out marker only where it gives a reason", () => {
		file(
			"scripts/why.sh",
			`# gh-route-exempt: tells the agent what to run\n${TEXT_ONLY}`,
		);
		fixture("scripts/sandbox.test.ts", "path-stub-exempt.ts.txt");
		file("scripts/bare.sh", `# gh-route-exempt:\n${TEXT_ONLY}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 second binary route(s): scripts/bare.sh:2.");
		expect(r.out).toContain("or mark it `gh-route-exempt: <why>`");
	});

	it("leaves a second var and a Node program's own spawn failing under the marker", () => {
		fixture("scripts/lib/debts.js", "second-var-marked.js.txt");
		fixture("scripts/lib/spawn.js", "literal-spawn-marked.js.txt");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"2 second binary route(s): scripts/lib/debts.js:2, scripts/lib/spawn.js:2.",
		);
	});
	it("FAILs each second `claude` route, naming lib/claude-bin.js and its exemplar", () => {
		fixture("scripts/arm.js", "claude-copies.js.txt");
		fixture("scripts/lib/arm.js", "claude-second-var.js.txt");
		fixture("scripts/a.test.ts", "claude-path-stub.ts.txt");
		file("scripts/hook.sh", "#!/usr/bin/env bash\nclaude agents --json\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"5 second binary route(s): scripts/a.test.ts:3, scripts/arm.js:1, scripts/arm.js:2, scripts/hook.sh:2, scripts/lib/arm.js:1.",
		);
		expect(r.out).toContain(
			"claude NODE-COPY Fix: call `claudeBin()` from scripts/lib/claude-bin.js, as scripts/run-mod-tests.js does.",
		);
		expect(r.out).toContain(
			"claude SECOND-VAR Fix: name the binary through WFC_CLAUDE_BIN",
		);
		expect(r.out).toContain(
			`claude SHELL-BARE Fix: run "\${WFC_CLAUDE_BIN:-claude}"`,
		);
		expect(r.out).toContain(
			"claude PATH-STUB Fix: point WFC_CLAUDE_BIN at the stub, as scripts/run-mod-tests.test.ts does.",
		);
	});

	it("passes the one `claude` route, and a shell `claude` marked as only text", () => {
		fixture("scripts/lib/claude-bin.js", "claude-lib.js.txt");
		fixture("scripts/on.js", "claude-on-primitive.js.txt");
		fixture("scripts/a.test.ts", "claude-wfc-stub.ts.txt");
		file(
			"scripts/hook.sh",
			[
				"#!/usr/bin/env bash",
				`"\${WFC_CLAUDE_BIN:-claude}" agents --json`,
				"# claude-route-exempt: only text",
				"printf 'run `claude agents --json`\\n'",
				"",
			].join("\n"),
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 4 file(s)");
	});

	it("FAILs a `command claude` the gh marker does not excuse", () => {
		file(
			"scripts/wrap.sh",
			'#!/usr/bin/env bash\n# gh-route-exempt: wraps the user\'s own shell\ncommand claude "$@"\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 second binary route(s): scripts/wrap.sh:3.");
	});
});

describe("--index (#3687)", () => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, stdio: "pipe" });
	const bare = "#!/usr/bin/env bash\ngh issue list\n";

	beforeEach(() => {
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		file(
			"scripts/hook.sh",
			`#!/usr/bin/env bash\n"\${WFC_GH:-gh}" issue list\n`,
		);
		git("add", ".");
		git("commit", "-qm", "seed");
	});

	it("passes a bare `gh` in an untracked shell file and in an unstaged edit", () => {
		file(".husky/loose.sh", bare);
		file("scripts/hook.sh", bare);
		expect(run().status).toBe(1);
		const r = run("--index");
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 1 file(s)");
	});

	it("refuses the same `gh` once staged, naming its file and line", () => {
		file(".husky/loose.sh", bare);
		git("add", ".husky/loose.sh");
		const r = run("--index", "--json");
		expect(r.status).toBe(1);
		expect(JSON.parse(r.out).findings).toMatchObject([
			{ tag: "SHELL-BARE", file: ".husky/loose.sh", line: 2 },
		]);
		expect(JSON.parse(r.out).findings[0].message).toContain(
			`Fix: run "\${WFC_GH:-gh}"`,
		);
	});
});
