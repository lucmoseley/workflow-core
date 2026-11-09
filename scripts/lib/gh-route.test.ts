// @vitest-environment node
/*
 * Pins gh-route.js's judgement of a tree's files, in-process (#4123).
 * check-gh-route.test.ts holds the program's boundary cases. Built on
 * in-memory text and a fake read, so each shape is judged with no tree on
 * disk. Breaking it lets a second `gh` or `claude` route past the
 * pre-commit gate, where a call off WFC_GH reaches the live tracker.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { judgeFile, judgeTree, kindOf } from "./gh-route.js";
import { isShipped } from "./plugin-tree.js";

const CORE = path.resolve(__dirname, "../..");

/** A shell or template expansion of `name`, spelt out of plain strings. */
const sub = (name: string) => ["$", `{${name}}`].join("");

/* Bodies that would breach this checker if written here, held as `.txt` it
 * never reads. */
const FIXTURE = {
	"claude-copies.js.txt": path.join(
		__dirname,
		"fixtures/gh-route/claude-copies.js.txt",
	),
	"claude-helper-stub.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/claude-helper-stub.ts.txt",
	),
	"claude-lib.js.txt": path.join(
		__dirname,
		"fixtures/gh-route/claude-lib.js.txt",
	),
	"claude-on-primitive.js.txt": path.join(
		__dirname,
		"fixtures/gh-route/claude-on-primitive.js.txt",
	),
	"claude-path-stub.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/claude-path-stub.ts.txt",
	),
	"claude-second-var.js.txt": path.join(
		__dirname,
		"fixtures/gh-route/claude-second-var.js.txt",
	),
	"claude-wfc-stub.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/claude-wfc-stub.ts.txt",
	),
	"cites.js.txt": path.join(__dirname, "fixtures/gh-route/cites.js.txt"),
	"env-read.js.txt": path.join(__dirname, "fixtures/gh-route/env-read.js.txt"),
	"gh-lib.js.txt": path.join(__dirname, "fixtures/gh-route/gh-lib.js.txt"),
	"helper-stub.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/helper-stub.ts.txt",
	),
	"literal-spawn-marked.js.txt": path.join(
		__dirname,
		"fixtures/gh-route/literal-spawn-marked.js.txt",
	),
	"literal-spawn.js.txt": path.join(
		__dirname,
		"fixtures/gh-route/literal-spawn.js.txt",
	),
	"on-primitive.js.txt": path.join(
		__dirname,
		"fixtures/gh-route/on-primitive.js.txt",
	),
	"other-helper-stub.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/other-helper-stub.ts.txt",
	),
	"other-stub.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/other-stub.ts.txt",
	),
	"path-stub-exempt.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/path-stub-exempt.ts.txt",
	),
	"path-stub-joined.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/path-stub-joined.ts.txt",
	),
	"path-stub.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/path-stub.ts.txt",
	),
	"second-var-marked.js.txt": path.join(
		__dirname,
		"fixtures/gh-route/second-var-marked.js.txt",
	),
	"second-var.js.txt": path.join(
		__dirname,
		"fixtures/gh-route/second-var.js.txt",
	),
	"second-var.ts.txt": path.join(
		__dirname,
		"fixtures/gh-route/second-var.ts.txt",
	),
	"sets.js.txt": path.join(__dirname, "fixtures/gh-route/sets.js.txt"),
	"wfc-stub.ts.txt": path.join(__dirname, "fixtures/gh-route/wfc-stub.ts.txt"),
};

const fixture = (name: keyof typeof FIXTURE) =>
	fs.readFileSync(FIXTURE[name], "utf8");

/** Judges a tree of path to text, reading each `.sh` path as shell. */
const judge = (texts: Record<string, string>) => {
	const files = Object.keys(texts).sort();
	const result = judgeTree(
		files,
		new Set(files.filter((rel) => rel.endsWith(".sh"))),
		(rel) => texts[rel] ?? "",
	);
	return {
		...result,
		sites: result.findings.map((f) => `${f.file}:${f.line}`),
	};
};

const GH_FIX = {
	"SECOND-VAR":
		"gh SECOND-VAR Fix: name the binary through WFC_GH, the one var scripts/lib/gh.js reads, as scripts/check-issue-orphans.js and scripts/link-sub-issue.sh do.",
	"SHELL-BARE": `gh SHELL-BARE Fix: run "${sub("WFC_GH:-gh")}", the var scripts/lib/gh.js reads, as scripts/link-sub-issue.sh does; or mark it \`gh-route-exempt: <why>\` where \`gh\` is only text.`,
	"PATH-STUB":
		"gh PATH-STUB Fix: point WFC_GH at the stub executable, never PATH.",
	"NODE-COPY":
		"gh NODE-COPY Fix: call `gh`, `ghJson` or their kin from scripts/lib/gh.js, as scripts/check-issue-orphans.js does.",
};

const TEXT_ONLY = 'msg="Apply it; gh issue edit 7"\n';

/* Spelt apart, so check-gh-route does not read this test as naming one. */
const SECOND_GH_VAR = ["WFC", "X", "GH"].join("_");

const tags = (rel: string, kind: "node" | "test" | "shell", source: string) =>
	judgeFile(rel, kind, source).map((f) => [f.tag, f.bin, f.line]);

describe("kindOf", () => {
	it("reads a listed shell file as shell, a test as test, other code as node, and anything else as none", () => {
		const shell = new Set(["scripts/a.sh"]);
		expect(kindOf("scripts/a.sh", shell)).toBe("shell");
		expect(kindOf("scripts/a.test.ts", shell)).toBe("test");
		expect(kindOf("scripts/a.js", shell)).toBe("node");
		expect(kindOf("scripts/a.md", shell)).toBeNull();
	});
});

describe("judgeTree", () => {
	it("reads only the files whose kind it judges, counting them, and gives each distinct fix once", () => {
		const read: string[] = [];
		const texts: Record<string, string> = {
			"scripts/a.js": 'spawn("gh", a);\nspawn("gh", b);\n',
			"scripts/b.sh": "gh issue list\n",
		};
		const result = judgeTree(
			["scripts/a.js", "scripts/b.sh", "scripts/c.md"],
			new Set(["scripts/b.sh"]),
			(rel) => {
				read.push(rel);
				return texts[rel] ?? "";
			},
		);
		expect(read).toEqual(["scripts/a.js", "scripts/b.sh"]);
		expect(result.scanned).toBe(2);
		expect(result.findings.map((f) => [f.file, f.tag, f.line])).toEqual([
			["scripts/a.js", "NODE-COPY", 1],
			["scripts/a.js", "NODE-COPY", 2],
			["scripts/b.sh", "SHELL-BARE", 1],
		]);
		expect(result.fixes).toHaveLength(2);
	});

	it("names a second var for the binary in any code file, with its fix", () => {
		const r = judge({
			"scripts/lib/archive.js": fixture("second-var.js.txt"),
			"scripts/lib/kit.ts": fixture("second-var.ts.txt"),
		});
		expect(r.sites).toEqual([
			"scripts/lib/archive.js:1",
			"scripts/lib/kit.ts:1",
		]);
		expect(r.fixes).toEqual([GH_FIX["SECOND-VAR"]]);
	});

	it("names a test prepending PATH with the directory holding its gh stub, joined apart or in place", () => {
		const r = judge({
			"scripts/a.test.ts": fixture("path-stub.ts.txt"),
			"scripts/b.test.ts": fixture("path-stub-joined.ts.txt"),
		});
		expect(r.sites).toEqual(["scripts/a.test.ts:3", "scripts/b.test.ts:2"]);
		expect(r.fixes).toEqual([GH_FIX["PATH-STUB"]]);
	});

	it("names a test support prepending PATH with the directory a helper writes its stub into by name, with each binary's fix", () => {
		const r = judge({
			"scripts/lib/kit-testkit.ts": fixture("helper-stub.ts.txt"),
			"scripts/lib/arbiter-testkit.ts": fixture("claude-helper-stub.ts.txt"),
			"scripts/lib/other-testkit.ts": fixture("other-helper-stub.ts.txt"),
		});
		expect(r.sites).toEqual([
			"scripts/lib/arbiter-testkit.ts:14",
			"scripts/lib/kit-testkit.ts:3",
		]);
		expect(r.fixes).toEqual([
			"claude PATH-STUB Fix: point WFC_CLAUDE_BIN at the stub executable, never PATH.",
			GH_FIX["PATH-STUB"],
		]);
	});

	it("names a non-test .ts prepending PATH with its gh stub's directory, itself or through a helper, and leaves a non-test .js alone (#4089)", () => {
		const r = judge({
			"scripts/lib/wiring.ts": fixture("path-stub.ts.txt"),
			"scripts/lib/kit.ts": fixture("helper-stub.ts.txt"),
			"scripts/lib/wiring.js": fixture("path-stub.ts.txt"),
		});
		expect(r.sites).toEqual([
			"scripts/lib/kit.ts:3",
			"scripts/lib/wiring.ts:3",
		]);
		expect(r.fixes).toEqual([GH_FIX["PATH-STUB"]]);
	});

	it("still reads a non-test .ts as a Node program, and honours the PATH-STUB marker there (#4089)", () => {
		const r = judge({
			"scripts/lib/spawns.ts": fixture("literal-spawn.js.txt"),
			"scripts/lib/wiring.ts": fixture("path-stub-exempt.ts.txt"),
		});
		expect(r.sites).toEqual(["scripts/lib/spawns.ts:1"]);
		expect(r.fixes).toEqual([GH_FIX["NODE-COPY"]]);
	});

	it("passes the one route: lib/gh.js, a program on it, a shell caller on WFC_GH, a stub at WFC_GH, and gh named only in comments", () => {
		const r = judge({
			"scripts/lib/gh.js": fixture("gh-lib.js.txt"),
			"scripts/on.js": fixture("on-primitive.js.txt"),
			"scripts/hook.sh": [
				"#!/usr/bin/env bash",
				`gh="${sub("WFC_GH:-gh")}"`,
				'command -v "$gh" >/dev/null || exit 0',
				'timeout 12 "$gh" issue view 7',
				"# gh issue view 7",
				"",
			].join("\n"),
			"scripts/a.test.ts": fixture("wfc-stub.ts.txt"),
			"scripts/b.test.ts": fixture("other-stub.ts.txt"),
			"scripts/cites.js": fixture("cites.js.txt"),
			"scripts/sets.js": fixture("sets.js.txt"),
		});
		expect(r.scanned).toBe(7);
		expect(r.findings).toEqual([]);
	});

	it("honours the opt-out marker only where it gives a reason", () => {
		const r = judge({
			"scripts/why.sh": `# gh-route-exempt: tells the agent what to run\n${TEXT_ONLY}`,
			"scripts/sandbox.test.ts": fixture("path-stub-exempt.ts.txt"),
			"scripts/bare.sh": `# gh-route-exempt:\n${TEXT_ONLY}`,
		});
		expect(r.sites).toEqual(["scripts/bare.sh:2"]);
		expect(r.fixes).toEqual([GH_FIX["SHELL-BARE"]]);
	});

	it("leaves a second var and a Node program's own spawn failing under the marker", () => {
		const r = judge({
			"scripts/lib/archive.js": fixture("second-var-marked.js.txt"),
			"scripts/lib/spawn.js": fixture("literal-spawn-marked.js.txt"),
		});
		expect(r.sites).toEqual([
			"scripts/lib/archive.js:2",
			"scripts/lib/spawn.js:2",
		]);
	});

	it("names each second `claude` route, with lib/claude-bin.js and its exemplar", () => {
		const r = judge({
			"scripts/arm.js": fixture("claude-copies.js.txt"),
			"scripts/lib/arm.js": fixture("claude-second-var.js.txt"),
			"scripts/a.test.ts": fixture("claude-path-stub.ts.txt"),
			"scripts/hook.sh": "#!/usr/bin/env bash\nclaude agents --json\n",
		});
		expect(r.sites).toEqual([
			"scripts/a.test.ts:3",
			"scripts/arm.js:1",
			"scripts/arm.js:2",
			"scripts/hook.sh:2",
			"scripts/lib/arm.js:1",
		]);
		expect(r.fixes).toEqual([
			"claude PATH-STUB Fix: point WFC_CLAUDE_BIN at the stub executable, never PATH.",
			"claude NODE-COPY Fix: call `claudeBin()` from scripts/lib/claude-bin.js, as scripts/run-mod-tests.js does.",
			`claude SHELL-BARE Fix: run "${sub("WFC_CLAUDE_BIN:-claude")}", the var scripts/lib/claude-bin.js reads, as scripts/dispatch-sessions.sh does; or mark it \`claude-route-exempt: <why>\` where \`claude\` is only text.`,
			"claude SECOND-VAR Fix: name the binary through WFC_CLAUDE_BIN, the one var scripts/lib/claude-bin.js reads, as scripts/run-mod-tests.js and scripts/dispatch-sessions.sh do.",
		]);
	});

	it("names in every shape's fix only files the release ships, as an adopter reads it (#4182)", () => {
		const { fixes } = judge({
			"scripts/arm.js": fixture("env-read.js.txt"),
			"scripts/lib/archive.js": fixture("second-var.js.txt"),
			"scripts/a.test.ts": fixture("path-stub.ts.txt"),
			"scripts/claude-arm.js": fixture("claude-copies.js.txt"),
			"scripts/lib/claude-arm.js": fixture("claude-second-var.js.txt"),
			"scripts/b.test.ts": fixture("claude-path-stub.ts.txt"),
			"scripts/hook.sh": "#!/usr/bin/env bash\ngh auth status\nclaude agents\n",
		});
		expect(fixes).toHaveLength(8);
		const named = fixes.flatMap((l) => l.match(/scripts\/[\w./-]*\w/g) ?? []);
		expect(named).toContain("scripts/lib/gh.js");
		expect(named.filter((rel) => !isShipped(CORE, rel))).toEqual([]);
	});

	it("passes the one `claude` route, and a shell `claude` marked as only text", () => {
		const r = judge({
			"scripts/lib/claude-bin.js": fixture("claude-lib.js.txt"),
			"scripts/on.js": fixture("claude-on-primitive.js.txt"),
			"scripts/a.test.ts": fixture("claude-wfc-stub.ts.txt"),
			"scripts/hook.sh": [
				"#!/usr/bin/env bash",
				`"${sub("WFC_CLAUDE_BIN:-claude")}" agents --json`,
				"# claude-route-exempt: only text",
				"printf 'run `claude agents --json`\\n'",
				"",
			].join("\n"),
		});
		expect(r.scanned).toBe(4);
		expect(r.findings).toEqual([]);
	});

	it("names a `command claude` the gh marker does not excuse", () => {
		const r = judge({
			"scripts/wrap.sh":
				'#!/usr/bin/env bash\n# gh-route-exempt: wraps the user\'s own shell\ncommand claude "$@"\n',
		});
		expect(r.sites).toEqual(["scripts/wrap.sh:3"]);
	});
});

describe("judgeFile", () => {
	it("names a literal spawn and a second env var read in a Node program, per binary", () => {
		expect(
			tags(
				"scripts/x.js",
				"node",
				`spawnSync("gh", []);\nconst c = process.env.WFC_CLAUDE_BIN;\nconst v = process.env.${SECOND_GH_VAR};\n`,
			),
		).toEqual([
			["NODE-COPY", "gh", 1],
			["NODE-COPY", "claude", 2],
			["SECOND-VAR", "gh", 3],
		]);
	});

	it("lets the primitive read its own var, and a program assign it", () => {
		expect(
			tags("scripts/lib/gh.js", "node", "const b = process.env.WFC_GH;\n"),
		).toEqual([]);
		/* The program text is spelt apart so no lexical check reads it as this
		 * test's own env write. */
		const assign = `${["process", "env", "WFC_GH"].join(".")} = "/stub";\n`;
		expect(tags("scripts/x.js", "node", assign)).toEqual([]);
	});

	it("names a bare shell run and probe, past comments, and honours a marker on the line or the one above", () => {
		expect(
			tags(
				"scripts/x.sh",
				"shell",
				[
					"# gh issue list",
					"out=$(gh issue list)",
					"command -v claude",
					"# gh-route-exempt: a message naming the binary",
					'echo "run"; gh auth login',
					`"${sub("WFC_GH:-gh")}" issue list`,
				].join("\n"),
			),
		).toEqual([
			["SHELL-BARE", "gh", 2],
			["SHELL-BARE", "claude", 3],
		]);
	});

	it.each([
		["at a line's start", 'gh issue view "$n" --json title'],
		["in a command substitution", 't="$(timeout 12 gh issue view "$n")"'],
		["after a pipe", "echo x | gh api user"],
		["after if", "if gh auth status; then :; fi"],
		["after !", "! gh auth status && exit 1"],
		["in backticks", "t=`gh api user`"],
		["after command", "command gh auth status"],
		["probed with command -v", "command -v gh >/dev/null || exit 0"],
		["probed with type -P", "type -P gh >/dev/null || exit 0"],
		["probed with which", "which gh >/dev/null || exit 0"],
	])("names a shell script running a bare gh %s, with its fix", (_, line) => {
		const found = judgeFile(
			"scripts/hook.sh",
			"shell",
			`#!/usr/bin/env bash\n${line}\n`,
		);
		expect(found.map((f) => [f.tag, f.bin, f.line])).toEqual([
			["SHELL-BARE", "gh", 2],
		]);
		expect(found[0]?.fixLine).toBe(GH_FIX["SHELL-BARE"]);
	});

	it("never takes a marker on a Node copy", () => {
		expect(
			tags(
				"scripts/x.js",
				"node",
				'// gh-route-exempt: no\nexecFileSync("gh", []);\n',
			),
		).toEqual([["NODE-COPY", "gh", 2]]);
	});

	it("names a test prepending to PATH a directory it joins the binary onto, directly or through a helper", () => {
		const direct = [
			'fs.writeFileSync(path.join(bin, "gh"), "");',
			`env.PATH = \`${sub("bin")}:${sub("process.env.PATH")}\`;`,
		].join("\n");
		const helper = [
			"function stub(name: string, dir = binDir) {",
			"\tfs.writeFileSync(path.join(dir, name), '');",
			"}",
			'stub("claude");',
			`env.PATH = \`${sub("binDir")}${sub("path.delimiter")}${sub("process.env.PATH")}\`;`,
		].join("\n");
		expect(tags("scripts/a.test.ts", "test", direct)).toEqual([
			["PATH-STUB", "gh", 2],
		]);
		expect(tags("scripts/a.test.ts", "test", helper)).toEqual([
			["PATH-STUB", "claude", 5],
		]);
	});

	it("keys each finding by its text and its count among identical lines, carrying its fix line", () => {
		const found = judgeFile(
			"scripts/x.js",
			"node",
			'spawn("gh", a);\nspawn("gh",   a);\n',
		);
		expect(found.map((f) => f.match)).toEqual([
			'spawn("gh", a); #1',
			'spawn("gh", a); #2',
		]);
		expect(found[0]?.fixLine).toBe(
			"gh NODE-COPY Fix: call `gh`, `ghJson` or their kin from scripts/lib/gh.js, as scripts/check-issue-orphans.js does.",
		);
		expect(found[0]?.message).toBe(
			"scripts/x.js:1 reaches `gh` off its one route (NODE-COPY). Fix: call `gh`, `ghJson` or their kin from scripts/lib/gh.js, as scripts/check-issue-orphans.js does.",
		);
	});
});
