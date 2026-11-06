// @vitest-environment node
/*
 * Tests for scripts/lib/guard-reach.js: the edges one file's text names, and
 * the closure walked over them. The four digests that read it test their own
 * policy over these edges, never the parsing (#4233).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { parseEdges, walkReach, walkReachAll } = require("./guard-reach.js");

interface Edge {
	kind: string;
	to: string;
	bindings?: string[];
}

const ROOT = path.join(__dirname, "..", "..");

/** The `to` of each edge of `kind` that `text` at `rel` names. */
const targets = (
	rel: string,
	text: string,
	kind: string,
	opts: Record<string, unknown> = {},
): string[] =>
	parseEdges(rel, text, { ...opts, kinds: [kind] }).map((e: Edge) => e.to);

const inTree = (...paths: string[]) => {
	const tree = new Set(paths);
	return (p: string) => tree.has(p);
};

describe("source edges", () => {
	it("reads each spelling of the sourcing file's own directory", () => {
		expect(
			targets(
				"scripts/guard-x.sh",
				'source "$here/lib/a.sh"\nsource "$(dirname "$0")/lib/b.sh"\n',
				"source",
			),
		).toEqual(["scripts/lib/a.sh", "scripts/lib/b.sh"]);
		expect(
			targets(
				"scripts/lib/x.sh",
				`. "\${BASH_SOURCE[0]%/*}/c.sh"\nsource "$(dirname "\${BASH_SOURCE[0]}")/d.sh"\n`,
				"source",
			),
		).toEqual(["scripts/lib/c.sh", "scripts/lib/d.sh"]);
	});

	it("resolves the real libs' own lib-to-lib spellings (mantahostels#2488)", () => {
		const real = (rel: string) =>
			targets(rel, fs.readFileSync(path.join(ROOT, rel), "utf8"), "source");
		expect(real("scripts/lib/guard-log.sh")).toEqual([
			"scripts/lib/guard-root.sh",
		]);
		expect(real("scripts/lib/review-standards.sh")).toEqual([
			"scripts/lib/guard-root.sh",
			"scripts/lib/script-path.sh",
			"scripts/lib/guard-log.sh",
		]);
	});

	it("reads a root-relative spelling from .husky/ against the root where the sibling is nowhere (#4456)", () => {
		const isFile = inTree("scripts/lib/gate.sh");
		expect(
			targets(
				".husky/pre-commit",
				`. "$root/scripts/lib/gate.sh"\n. "\${ROOT:-.}"/scripts/lib/gate.sh\n`,
				"source",
				{ isFile },
			),
		).toEqual(["scripts/lib/gate.sh"]);
		expect(
			targets(".husky/pre-commit", '. "$here/lib/gate.sh"\n', "source", {
				isFile,
			}),
		).toEqual(["scripts/lib/gate.sh"]);
	});

	it("prefers the sibling where both readings are in the tree", () => {
		expect(
			targets(".husky/pre-commit", '. "$here/lib/gate.sh"\n', "source", {
				isFile: inTree(".husky/lib/gate.sh", "scripts/lib/gate.sh"),
			}),
		).toEqual([".husky/lib/gate.sh"]);
	});

	it("reads a source after a command separator", () => {
		expect(
			targets(
				"scripts/guard-x.sh",
				'[ -f x ] && source "$here/lib/a.sh"\n',
				"source",
			),
		).toEqual(["scripts/lib/a.sh"]);
	});

	it("skips a commented line, a shellcheck directive and a path it cannot settle", () => {
		expect(
			targets(
				"scripts/guard-x.sh",
				[
					'# source "$here/lib/dead.sh"',
					"# shellcheck source=lib/rule-text.sh",
					'source "$lib"',
					"source /etc/profile.sh",
					'source "$here/../../out.sh"',
				].join("\n"),
				"source",
			),
		).toEqual([]);
	});

	it("reads a source line once", () => {
		expect(
			targets(
				"scripts/guard-x.sh",
				'source "$here/lib/a.sh"\nsource "$here/lib/a.sh"\n',
				"source",
			),
		).toEqual(["scripts/lib/a.sh"]);
	});
});

// A regex match is synchronous, so only a process timeout can stop a
// backtracking one (#2188, #3383). Each text is 240k-660k characters: read
// linearly it takes under 50 ms, read once per head it
// is some 10^10 steps, so 10 s leaves a loaded machine 200x headroom and a
// quadratic read none.
describe("a long line of heads that reach nothing", () => {
	it.each([
		["source", "source ".repeat(80_000)],
		["source", ". $".repeat(80_000)],
		["require", 'require("./'.repeat(60_000)],
		["require", '{ = require("./a")'.repeat(30_000)],
	])("reads %s edges in linear time", (kind, text) => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				`const { parseEdges } = require(${JSON.stringify(require.resolve("./guard-reach.js"))}); parseEdges("scripts/x.sh", require("node:fs").readFileSync(0, "utf8"), { kinds: [process.argv[1]] });`,
				kind,
			],
			{ input: text, timeout: 10_000 },
		);
		expect(r.signal).toBeNull();
		expect(r.status).toBe(0);
	});
});

describe("require edges", () => {
	it("reads both spellings, adding .js to the extensionless one (#3795)", () => {
		expect(
			targets(
				"scripts/guard-x.js",
				'require("./lib/a.js");\nrequire("./lib/b");\nrequire(\'../c\');\n',
				"require",
			),
		).toEqual(["scripts/lib/a.js", "scripts/lib/b.js", "c.js"]);
	});

	it("keeps an extension other than .js as spelt", () => {
		expect(
			targets("scripts/x.js", 'require("./lib/data.json");\n', "require"),
		).toEqual(["scripts/lib/data.json"]);
	});

	it("skips a require on a // line or a block comment's line, and reads a second on one line", () => {
		expect(
			targets(
				"scripts/lib/store.js",
				[
					'const a = require("./a.js"), b = require("./b.js");',
					'// const old = require("./old.js");',
					' * require("./doc.js")',
					'/* require("./doc2.js") */',
				].join("\n"),
				"require",
			),
		).toEqual(["scripts/lib/a.js", "scripts/lib/b.js"]);
	});

	it("names what a destructuring require binds", () => {
		const edges = parseEdges(
			"scripts/guard-x.js",
			'const { decide, other: alias } = require("./lib/core");\nconst whole = require("./lib/kit.js");\n',
			{ kinds: ["require"] },
		);
		expect(edges).toEqual([
			{
				kind: "require",
				to: "scripts/lib/core.js",
				bindings: ["decide", "other", "alias"],
			},
			{ kind: "require", to: "scripts/lib/kit.js" },
		]);
	});
});

describe("node-run edges", () => {
	const guard = (body: string, opts = {}) =>
		targets(
			"scripts/guard-x.sh",
			`#!/bin/bash\nhere="$(dirname "$0")"\n${body}\n`,
			"node-run",
			opts,
		);

	it("reads a self-relative run, and none spelt from a bare path (mantahostels#358)", () => {
		expect(
			guard(
				'timeout 5 node "$here/session-arbiter.js" check\necho "Use: node scripts/issue-body.js append"',
			),
		).toEqual(["scripts/session-arbiter.js"]);
	});

	it("skips a run commented out either way", () => {
		expect(
			guard(
				'# node "$here/legacy.js" check\n// const c = "node $here/legacy2.js";',
			),
		).toEqual([]);
	});

	it("reads a run whose expansion names the root against the root, a scripts/ tail only", () => {
		expect(
			guard('node "$root/scripts/session-arbiter.js" check', {
				isFile: inTree("scripts/session-arbiter.js"),
			}),
		).toEqual(["scripts/session-arbiter.js"]);
		expect(
			guard('node "$root/other/x.js"', { isFile: inTree("other/x.js") }),
		).toEqual(["scripts/other/x.js"]);
	});

	it("reads a run through a variable the file assigns (#2487), in a substitution too", () => {
		expect(
			guard(
				'arbiter="$here/session-arbiter.js"  # the judge\nout="$(printf x | node "$arbiter" check)"',
			),
		).toEqual(["scripts/session-arbiter.js"]);
	});

	it("reads every program a variable assigned twice names", () => {
		expect(
			guard(
				'script="$here/a.js"\nnode "$script" check\nscript="$here/b.js"\nnode "$script"',
			),
		).toEqual(["scripts/a.js", "scripts/b.js"]);
	});

	it("skips a variable's path that node never runs", () => {
		expect(guard('hint="$here/issue-body.js"\necho "Use: $hint"')).toEqual([]);
	});
});

describe("launch edges (#4567)", () => {
	const launches = (body: string, ...tree: string[]) =>
		targets(
			"scripts/zz/run.sh",
			`here="$(dirname "$0")"\n${body}\n`,
			"launch",
			{
				isFile: inTree(...tree),
			},
		);

	it("reads the spellings node-run declines: bash, sh, exec, command position, a .sh target and a root-relative path", () => {
		expect(
			launches(
				[
					"bash scripts/zz/a.sh",
					'sh "$here/b.sh"',
					'exec node "$here/c.js"',
					'"$here/d.sh" --flag',
					"node scripts/zz/e.js",
				].join("\n"),
				"scripts/zz/a.sh",
				"scripts/zz/b.sh",
				"scripts/zz/c.js",
				"scripts/zz/d.sh",
				"scripts/zz/e.js",
			),
		).toEqual([
			"scripts/zz/a.sh",
			"scripts/zz/b.sh",
			"scripts/zz/c.js",
			"scripts/zz/d.sh",
			"scripts/zz/e.js",
		]);
	});

	it("reads a defaulted expansion, a dirname prefix and a run inside a quoted substitution", () => {
		expect(
			launches(
				[
					`node "\${PLUGIN_ROOT:-.}/scripts/zz/fmt.js"`,
					'node "$(dirname "$0")/auth.js"',
					`out="$(printf '%s' "$x" | node "$here/piped.js" --json)"`,
				].join("\n"),
				"scripts/zz/fmt.js",
				"scripts/zz/auth.js",
				"scripts/zz/piped.js",
			),
		).toEqual([
			"scripts/zz/auth.js",
			"scripts/zz/fmt.js",
			"scripts/zz/piped.js",
		]);
	});

	it("resolves a prefixed path against its own directory first, a bare one against the root only", () => {
		expect(
			launches(
				'node "$here/x.js"\nnode y.js',
				"scripts/zz/x.js",
				"x.js",
				"scripts/zz/y.js",
			),
		).toEqual(["scripts/zz/x.js"]);
	});

	it("is no edge to a path outside the tree, to the file itself, or in a comment or heredoc", () => {
		expect(
			launches(
				[
					'node "$here/missing.js"',
					'bash "$here/run.sh"',
					'# node "$here/commented.js"',
					"cat <<EOF",
					'node "$here/heredoc.js"',
					"EOF",
				].join("\n"),
				"scripts/zz/run.sh",
				"scripts/zz/commented.js",
				"scripts/zz/heredoc.js",
			),
		).toEqual([]);
	});
});

describe("manifest-core and host edges", () => {
	const manifest = {
		PreToolUse: [
			{ name: "a", core: "guard-a-core.js", host: "guard-a-host.js" },
			{ name: "b", core: "guard-b-core.js" },
		],
	};

	it("gives the dispatch kit its manifest and every core and host it binds", () => {
		expect(
			targets("scripts/lib/guard-dispatch.js", "", "manifest-core", {
				manifest: () => manifest,
			}),
		).toEqual([
			"scripts/lib/guard-cores.json",
			"scripts/lib/guard-a-core.js",
			"scripts/lib/guard-a-host.js",
			"scripts/lib/guard-b-core.js",
		]);
	});

	it("gives a core the host its row binds, and reads no manifest where none is wanted", () => {
		expect(
			targets("scripts/lib/guard-a-core.js", "", "host", {
				manifest: () => manifest,
			}),
		).toEqual(["scripts/lib/guard-a-host.js"]);
		expect(
			targets("scripts/lib/guard-b-core.js", "", "host", {
				manifest: () => manifest,
			}),
		).toEqual([]);
		const unasked = () => {
			throw new Error("manifest read");
		};
		expect(
			targets("scripts/guard-x.js", "", "manifest-core", { manifest: unasked }),
		).toEqual([]);
		expect(
			targets("scripts/guard-x.js", "", "require", { manifest: unasked }),
		).toEqual([]);
	});
});

describe("rule-file edges", () => {
	it("reads each emission's rule file, readRuleParagraph's included (#4033)", () => {
		expect(
			targets(
				"scripts/guard-x.js",
				'readRuleText("alpha");\nreadRuleParagraph("founder-handover", HEAD);\nconst d = { injectRules: ["gamma"] };\n',
				"rule-file",
			),
		).toEqual([
			"docs/agents/rules/alpha.txt",
			"docs/agents/rules/founder-handover.txt",
			"docs/agents/rules/gamma.txt",
		]);
		expect(
			targets("scripts/guard-x.sh", 'msg="$(rule_text beta)"\n', "rule-file"),
		).toEqual(["docs/agents/rules/beta.txt"]);
	});
});

describe("walkReach", () => {
	const files: Record<string, string> = {
		"scripts/guard.js": 'require("./lib/a");\nrequire("./lib/b.js");\n',
		"scripts/lib/a.js": 'require("./b.js");\nrequire("./c.js");\n',
		"scripts/lib/b.js": 'require("./a");\n',
		"scripts/lib/c.js": 'require("./gone.js");\nrequire("../../outside.js");\n',
	};
	const reader = (calls: string[][]) => (paths: string[]) => {
		calls.push(paths);
		return paths.map((p) => files[p] ?? null);
	};

	it("reaches each file once, level by level, through a cycle", () => {
		const calls: string[][] = [];
		const reached = walkReach(["scripts/guard.js"], reader(calls), {
			follow: ["require"],
		});
		expect([...reached.keys()]).toEqual([
			"scripts/guard.js",
			"scripts/lib/a.js",
			"scripts/lib/b.js",
			"scripts/lib/c.js",
			"scripts/lib/gone.js",
			"outside.js",
		]);
		expect(calls).toEqual([
			["scripts/guard.js"],
			["scripts/lib/a.js", "scripts/lib/b.js"],
			["scripts/lib/c.js"],
			["scripts/lib/gone.js", "outside.js"],
		]);
		expect(reached.get("scripts/lib/gone.js")).toBeNull();
	});

	it("walks only the edges its policy keeps and the kinds it follows", () => {
		const reached = walkReach(["scripts/guard.js"], reader([]), {
			follow: ["require"],
			keep: (e: Edge) =>
				e.to.startsWith("scripts/lib/") && !e.to.includes("c."),
		});
		expect([...reached.keys()]).toEqual([
			"scripts/guard.js",
			"scripts/lib/a.js",
			"scripts/lib/b.js",
		]);
		expect([
			...walkReach(["scripts/guard.js"], reader([]), {
				follow: ["source"],
			}).keys(),
		]).toEqual(["scripts/guard.js"]);
	});

	it("resolves each file's edges against the tree and manifest it is given", () => {
		const reached = walkReach(
			["scripts/lib/guard-dispatch.js"],
			(paths: string[]) => paths.map(() => ""),
			{
				follow: ["manifest-core"],
				read: {
					manifest: () => ({
						PreToolUse: [{ name: "a", core: "guard-a-core.js" }],
					}),
				},
			},
		);
		expect([...reached.keys()]).toEqual([
			"scripts/lib/guard-dispatch.js",
			"scripts/lib/guard-cores.json",
			"scripts/lib/guard-a-core.js",
		]);
	});

	it("reads each level of several walks in one batch (#3411)", () => {
		const batches: string[][][] = [];
		const reached = walkReachAll(
			[["scripts/guard.js"], ["scripts/lib/c.js"]],
			(levels: string[][]) => {
				batches.push(levels);
				return levels.map((paths) => paths.map((p) => files[p] ?? null));
			},
			{ follow: ["require"] },
		);
		expect(batches[0]).toEqual([["scripts/guard.js"], ["scripts/lib/c.js"]]);
		expect(batches).toHaveLength(4);
		expect([...reached[1].keys()]).toEqual([
			"scripts/lib/c.js",
			"scripts/lib/gone.js",
			"outside.js",
		]);
	});
});
