// @vitest-environment node
/*
 * code-edges.js's Python reach (#4864): the files an import loads, the paths
 * it tried first, and the imports it cannot place. Loosen a case and the pass
 * store caches a test whose spawned script's module changed. Each case builds
 * a real temporary tree, since the walk resolves a module by reading the
 * disk.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { edgesOf, reachOf } = require("./code-edges.js");

let root = "";
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A tree holding `files`, and the importer `tool/t.py` reading `code`. */
function tree(code: string, files: string[]) {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ce-")));
	for (const rel of [...files, "tool/t.py"]) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), rel === "tool/t.py" ? code : "");
	}
	const file = path.join(root, "tool/t.py");
	const faults: string[] = [];
	const rel = (ps: string[]) => ps.map((p) => path.relative(root, p));
	const { edges, shadows } = reachOf(file, code, (m: string) => faults.push(m));
	return { edges: rel(edges), shadows: rel(shadows), faults };
}

describe("a dotted import", () => {
	it("reaches the package and each submodule it names", () => {
		expect(
			tree("import pkg.sub\n", ["tool/pkg/__init__.py", "tool/pkg/sub.py"])
				.edges,
		).toEqual(["tool/pkg/__init__.py", "tool/pkg/sub.py"]);
	});

	it("reaches a submodule package's __init__.py and one below a namespace directory", () => {
		expect(
			tree("import pkg.sub.deep.leaf\n", [
				"tool/pkg/__init__.py",
				"tool/pkg/sub/__init__.py",
				"tool/pkg/sub/deep/leaf.py",
			]).edges,
		).toEqual([
			"tool/pkg/__init__.py",
			"tool/pkg/sub/__init__.py",
			"tool/pkg/sub/deep/leaf.py",
		]);
	});

	it("reaches a from-imported name that is a submodule, and not one that is an attribute", () => {
		expect(
			tree("from pkg import sub, attr\n", [
				"tool/pkg/__init__.py",
				"tool/pkg/sub.py",
			]).edges,
		).toEqual(["tool/pkg/__init__.py", "tool/pkg/sub.py"]);
	});

	it("names a dotted part's package as a shadow of its module", () => {
		expect(
			tree("import pkg.sub\n", ["tool/pkg/__init__.py", "tool/pkg/sub.py"])
				.shadows,
		).toContain("tool/pkg/sub/__init__.py");
	});

	/* #4790 pass 2 review, finding 6: a from-imported name's package form
	 * went unwatched once its module was found. */
	it("names what a from-imported name tried before its module as a shadow", () => {
		expect(
			tree("from pkg import sub\n", ["tool/pkg/__init__.py", "tool/pkg/sub.py"])
				.shadows,
		).toContain("tool/pkg/sub/__init__.py");
	});

	it("names a relative import's from-imported names' shadows", () => {
		const found = tree("from . import sub\n", ["tool/sub.py"]);
		expect(found.edges).toEqual(["tool/sub.py"]);
		expect(found.shadows).toEqual(["tool/sub/__init__.py"]);
	});

	it("faults a from-imported name a namespace package does not hold", () => {
		expect(tree("from ns import gone\n", ["tool/ns/other.py"]).faults).toEqual([
			"imports gone from ns, a namespace package that holds no gone",
		]);
	});

	it("faults a submodule the walk cannot place", () => {
		const { faults } = tree("import pkg.gone\n", ["tool/pkg/__init__.py"]);
		expect(faults).toEqual([
			"imports pkg.gone, whose gone the walk cannot place",
		]);
	});
});

describe("a sys.path entry the file adds", () => {
	it.each([
		['os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")'],
		['str(Path(__file__).resolve().parent.parent / "lib")'],
		['HERE / ".." / "lib"'],
	])("places a module found through sys.path.insert(0, %s)", (expr) => {
		const code = [
			"from pathlib import Path",
			"HERE = Path(__file__).parent",
			`sys.path.insert(\n    0, ${expr}\n)`,
			"import helper  # noqa: E402",
		].join("\n");
		const { edges, faults } = tree(code, ["lib/helper.py"]);
		expect({ edges, faults }).toEqual({
			edges: ["lib/helper.py"],
			faults: [],
		});
	});

	it("searches the newest insert first and names what it tried before the module", () => {
		const code = [
			'sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "b"))',
			'sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "a"))',
			"import helper",
		].join("\n");
		const found = tree(code, ["a/other.py", "b/helper.py", "tool/helper.py"]);
		expect(found.edges).toEqual(["b/helper.py"]);
		expect(found.shadows).toEqual([
			"a/helper/__init__.py",
			"a/helper.py",
			"b/helper/__init__.py",
		]);
	});

	it("searches an appended entry after the importer's own directory", () => {
		const code =
			'sys.path.append(os.path.join(os.path.dirname(__file__), "..", "lib"))\nimport helper\n';
		expect(tree(code, ["lib/helper.py", "tool/helper.py"]).edges).toEqual([
			"tool/helper.py",
		]);
	});

	it.each([
		["sys.path.insert(0, sys.argv[1])"],
		['sys.path.insert(0, "relative")'],
		["sys.path.insert(1, os.path.dirname(__file__))"],
		["sys.path[:0] = [LIB]"],
		["sys.path.pop(0)"],
		["del sys.path[0]"],
	])("faults every later import but a builtin module's after %s", (edit) => {
		const { faults } = tree(
			`${edit}\nimport sys\nimport json\nimport helper\n`,
			["tool/helper.py"],
		);
		expect(faults).toEqual([
			"imports json after a sys.path edit the walk cannot read",
			"imports helper after a sys.path edit the walk cannot read",
		]);
	});

	/* #4790 pass 2 review, finding 5: the unreadable front entry may hold a
	 * json.py, so a stdlib name cached past it. */
	it("places a stdlib import past an unreadable entry appended after the stdlib's", () => {
		const { faults } = tree(
			"sys.path.append(sys.argv[1])\nimport json\nimport helper\n",
			[],
		);
		expect(faults).toEqual([
			"imports helper after a sys.path edit the walk cannot read",
		]);
	});

	it("counts every file an indented insert may or may not have put first", () => {
		const code = [
			"if CHECK:",
			'    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))',
			"import helper",
		].join("\n");
		expect(tree(code, ["lib/helper.py", "tool/helper.py"]).edges).toEqual([
			"lib/helper.py",
			"tool/helper.py",
		]);
	});

	it("places a function's import on the search path as the file leaves it too", () => {
		const code = [
			"def run():",
			"    import helper",
			'sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))',
		].join("\n");
		expect(tree(code, ["lib/helper.py", "tool/helper.py"]).edges).toEqual([
			"tool/helper.py",
			"lib/helper.py",
		]);
	});

	it("faults a third-party package the tree does not hold", () => {
		expect(tree("import playwright\n", []).faults).toEqual([
			"imports playwright, which is neither stdlib nor found beside it or on a sys.path entry it adds",
		]);
	});
});

/* #4790 pass 2 review, finding 4: each of these dropped its import with no
 * fault, so the pass store cached a test past a change to helper.py. */
describe("a statement the parse may miss", () => {
	it.each([
		[
			"a one-line compound statement's body",
			"try: import helper\nexcept ImportError: pass\n",
		],
		[
			"an import after a comment holding a triple quote",
			'# a """ in prose\nimport helper\n',
		],
	])("places %s", (_shape, code) => {
		const { edges, faults } = tree(code, ["tool/helper.py"]);
		expect({ edges: [...new Set(edges)], faults }).toEqual({
			edges: ["tool/helper.py"],
			faults: [],
		});
	});

	it("faults a file ending inside an open bracket", () => {
		expect(tree("import helper\nx = (\n", ["tool/helper.py"]).faults).toEqual([
			"ends inside an open bracket, so its last statement goes unread",
		]);
	});

	it("faults an import it cannot parse", () => {
		expect(
			tree("if f(lambda: 1): import helper\n", ["tool/helper.py"]).faults,
		).toEqual([
			"imports through 1): import helper, which the walk cannot parse",
		]);
	});

	/* #4790 pass 3 review, finding 3: a load with no import keyword raised
	 * no fault. */
	it.each([
		['spec = importlib.util.spec_from_file_location("m", P)'],
		["spec.loader.exec_module(m)"],
		["runpy.run_path(P)"],
		["exec(open(P).read())"],
		['__import__("helper")'],
	])("faults %s, a load that names no import", (load) => {
		expect(tree(`${load}\n`, ["tool/helper.py"]).faults).toHaveLength(1);
	});
});

describe("a file the walk cannot read", () => {
	it("faults JSX or TSX code rather than answering no edges", () => {
		const faults: string[] = [];
		reachOf("/x/a.tsx", 'import "./b.js";\n', (m: string) => faults.push(m));
		expect(faults).toEqual(["is .tsx code, whose loads the walk cannot read"]);
	});

	it("answers a data file no edges and no fault", () => {
		const faults: string[] = [];
		expect(reachOf("/x/a.json", "{}", (m: string) => faults.push(m))).toEqual({
			edges: [],
			shadows: [],
			unread: [],
			python: false,
		});
		expect(faults).toEqual([]);
	});
});

/* #4790 pass 2 review, finding 1: scripts/host-root-byte-identity.test.ts
 * imported host_root inside `python3 -c`, so editing host_root.py left it
 * cached. */
describe("an interpreter handed its program inline", () => {
	const unseen = (code: string, file = "/x/a.test.ts") =>
		reachOf(file, code, () => undefined).unread;

	it.each([
		[
			'spawnSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); from host_root import host_root", LIB]);',
		],
		['spawnSync("python3", ["-I", "-c", CODE]);'],
		[
			`spawnSync(process.execPath, [\n\t"-e",\n\t\`require(\${JSON.stringify(p)})\`,\n]);`,
		],
		['spawnSync("node", ["--eval", "require(process.argv[1])", p]);'],
		['spawnSync("python3", ["-"], { input: code });'],
		['spawnSync("python3", ["-", "import sys"], { input: code });'],
		["execSync(`python3 -c 'import helper'`);"],
		/* #4790 pass 3 review, finding 2: an escape hid the load's line
		 * start, and one the reader does not undo hides the text. */
		['spawnSync("python3", ["-c", "import sys\\nimport host_root"]);'],
		[
			"spawnSync(process.execPath, [\"-e\", \"require('node:fs')\\nrequire('./x')\"]);",
		],
		['spawnSync("python3", ["-c", "import sys\\x0aimport host_root"]);'],
	])("names %s", (code) => {
		expect(unseen(code)).toHaveLength(1);
	});

	it.each([
		['spawnSync("git", ["-c", "user.name=t", "commit"]);'],
		['spawnSync("grep", ["-e", "x", file]);'],
		['spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)", s]);'],
		[
			"spawnSync(process.execPath, [\"-e\", \"require('node:fs').writeFileSync(1, 'x')\"]);",
		],
		['spawnSync("python3", ["-c", "import sys; print(sys.argv[1])", x]);'],
		['spawnSync("python3", ["-c", "import sys\\nprint(1)"]);'],
		['spawnSync("python3", [script, "-c", "x"]);'],
		['// spawnSync("python3", ["-c", "import helper"]);'],
	])("lets pass %s, which loads no file", (code) => {
		expect(unseen(code)).toEqual([]);
	});

	/* #4790 pass 3 review, finding 4: the row of a builtin-only inline
	 * python must still rest on python3. */
	it("marks the reach of a Python spawn it lets pass as running python3", () => {
		expect(
			reachOf(
				"/x/a.test.ts",
				'spawnSync("python3", ["-c", "import sys"]);',
				() => undefined,
			).python,
		).toBe(true);
	});

	it("reads a Python list's spawn too", () => {
		expect(
			unseen(
				'subprocess.run([sys.executable, "-c", "import helper"])\n',
				"/x/t.py",
			),
		).toHaveLength(1);
	});
});

/* #4790 pass 3 review, finding 1: park-blocked.sh's `node -e` required
 * issue-hold.js off its argument, which no walk read, so
 * park-blocked.test.ts stayed cached after issue-hold.js changed. */
describe("a shell script's inline program", () => {
	const SelfDirLines = [
		`SELF_DIR="\${BASH_SOURCE[0]%/*}"`,
		`[[ "$SELF_DIR" == "\${BASH_SOURCE[0]}" ]] && SELF_DIR=.`,
		'SELF_DIR="$(cd "$SELF_DIR" && pwd)"',
	].join("\n");
	const sh = (code: string) => reachOf("/x/s/park.sh", code, () => undefined);

	it("reaches the file a node program requires off an argument read as a path, as park-blocked.sh's", () => {
		const { unread, edges } = sh(
			[
				SelfDirLines,
				"printf '%s' \"$body\" | node -e '",
				"  const { readOwnHold } = require(process.argv[1]);",
				'\' "$SELF_DIR/lib/issue-hold.js" "$issue" 2>/dev/null',
			].join("\n"),
		);
		expect(unread).toEqual([]);
		expect(edges).toEqual(["/x/s/lib/issue-hold.js"]);
	});

	it.each([
		[
			`$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)/lib/c.js`,
			"/x/lib/c.js",
		],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		["${BASH_SOURCE[0]%/*}/c.js", "/x/s/c.js"],
	])("reads %s as a path", (arg, want) => {
		expect(sh(`node -p 'require(process.argv[1]).X' "${arg}"\n`).edges).toEqual(
			[want],
		);
	});

	it.each([
		[
			"an argument it cannot read as a path",
			`node -e 'require(process.argv[1])' "$UNSET/x.js"\n`,
		],
		[
			"a caller's $0",
			`node -e 'require(process.argv[1])' "$(dirname "$0")/x.js"\n`,
		],
		[
			"a variable set to two paths",
			`D="\${BASH_SOURCE[0]%/*}"\nD="/tmp"\nnode -e 'require(process.argv[1])' "$D/x.js"\n`,
		],
		["a double-quoted program", `node -e "require('./x')"\n`],
		["a relative load", `node -e 'require("./x")'\n`],
		["a Python program loading a module", `python3 -c 'import helper'\n`],
	])("names a spawn through %s unread", (_what, code) => {
		expect(sh(code).unread).toHaveLength(1);
	});

	/* The same review's sweep: 162 tests reached a script sourcing or
	 * running a sibling through `"$here/…"`, which no walk read. */
	it("reaches a code path spelled off a variable naming the file's directory", () => {
		expect(
			sh(
				[
					SelfDirLines,
					'source "$SELF_DIR/lib/guard-root.sh"',
					'lines="$(node "$SELF_DIR/lib/msg.js" "$f")"',
					'cfg="$(cd "$SELF_DIR/.." && pwd)/c.js"',
					'node "$cfg"',
				].join("\n"),
			).edges.sort(),
		).toEqual(["/x/c.js", "/x/s/lib/guard-root.sh", "/x/s/lib/msg.js"]);
	});

	it("skips a comment line", () => {
		expect(sh("# node -e 'require(x)'\n").unread).toEqual([]);
	});
});

/* #4790 pass 3 review round 3, finding 1: a load spelled off a variable the
 * walk dropped without a word. concision-backstop-sensitive.test.ts runs
 * code-signal.sh's `node "$CS_MATCHER"`, sensitive-paths.js, which no row
 * held; the rule since: a load word the walk cannot read is unread. */
describe("a shell script's loads", () => {
	const dirOf = (v: string) =>
		`${v}="\${BASH_SOURCE[0]%/*}"\n[[ "$${v}" == "\${BASH_SOURCE[0]}" ]] && ${v}=.`;
	const sh = (code: string, file = "/x/s/a.sh") =>
		reachOf(file, code, () => undefined);

	it.each([
		[
			"code-signal.sh's matcher, through `cd … 2>/dev/null && pwd` and an unset after",
			`${dirOf("_cs_dir")}\n_cs_dir="$(cd "$_cs_dir" 2>/dev/null && pwd)"\nCS_MATCHER="$_cs_dir/sensitive-paths.js"\nCS_ARBITER="\${_cs_dir%/*}/session-arbiter.js"\nunset _cs_dir\nf() {\n  node "$CS_MATCHER" --stdin 2>"$err"\n  node "$CS_ARBITER" own-paths\n}\n`,
			["/x/s/sensitive-paths.js", "/x/session-arbiter.js"],
		],
		[
			"review-agent-type.sh's guard root, sourced before its unset",
			`${dirOf("_rat_here")}\nif ! declare -F gr_root >/dev/null 2>&1; then\n  source "$_rat_here/guard-root.sh"\nfi\nunset _rat_here\n`,
			["/x/s/guard-root.sh"],
		],
		[
			"dispatch-sessions.sh's `here`, made absolute off $PWD",
			`${dirOf("here")}\n[[ "$here" == /* ]] || here="$PWD/$here"\nsource "$here/lib/interop-probe.sh" 2>/dev/null\n`,
			["/x/s/lib/interop-probe.sh"],
		],
		[
			"bg-run.sh's directory, through `cd … >/dev/null 2>&1 && pwd`",
			`${dirOf("SCRIPT_DIR")}\nSCRIPT_DIR="$(cd "$SCRIPT_DIR" >/dev/null 2>&1 && pwd)"\nsource "$SCRIPT_DIR/lib/guard-root.sh"\n`,
			["/x/s/lib/guard-root.sh"],
		],
		[
			"an inherited variable's default",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'hook="${WFC_TIER_HOOK:-${BASH_SOURCE[0]%/*}/d.js}"\nnode "$hook" --only x\n',
			["/x/s/d.js"],
		],
		[
			"a function running its arguments",
			`${dirOf("here")}\noutlive_live node "$here/sweep.js"\n`,
			["/x/s/sweep.js"],
		],
	])("reads %s", (_what, code, want) => {
		const reach = sh(code);
		expect(reach.unread).toEqual([]);
		expect([...reach.edges, ...reach.shadows]).toEqual(
			expect.arrayContaining(want),
		);
	});

	it.each([
		[
			"a variable unset before the load",
			`${dirOf("_h")}\nunset _h\nsource "$_h/g.sh"\n`,
		],
		[
			"a path off a command's output",
			'source "$(git rev-parse --show-toplevel)/a.sh"\n',
		],
		["a variable the walk cannot read", 'node "$UNSET/x.js"\n'],
		["a path built off an argument", 'node "$1/x.js"\n'],
		["a path relative to the working directory", "node scripts/x.js\n"],
		["a program on stdin", "printf x | node\n"],
		["a heredoc program", "python3 <<'EOF'\nimport helper\nEOF\n"],
		["a shell's command string", "bash -c 'source ./a.sh'\n"],
		["a module off python3's search path", "python3 -m helper\n"],
		["a function running an unread load", 'hb node "$UNSET/x.js"\n'],
		/* Finding 2: hook-bound.sh, precommit-gate.sh and relink-store.sh. A
		 * default naming the caller's $0, the working directory or an
		 * argument is no path the walk can read; the gate suites run the
		 * hooks in a throwaway repository. */
		[
			"hook-bound.sh's runner, off the caller's $0",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'hb_runner="$(cd "${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}" 2>/dev/null && pwd)/scripts/lib/run-budgeted.js" || hb_runner=""\nhook_bound() { command node "$hb_runner" --hook "$@"; }\n',
		],
		[
			"precommit-gate.sh's formatters, off the working directory",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'node "${WFC_PLUGIN_ROOT:-.}/scripts/lib/formatters.js" shell-files\n',
		],
		[
			"relink-store.sh's script, off an argument",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'rs_script="${WFC_PLUGIN_ROOT:-$1}/scripts/session-checkout.js"\nnode "$rs_script" relink\n',
		],
	])("names %s unread", (_what, code) => {
		expect(sh(code).unread).toHaveLength(1);
	});

	it.each([
		["a load the caller hands in whole", 'node "$1"\n"$@"\n'],
		[
			"a command an inherited variable names",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'gh="${WFC_GH:-gh}"\n"$gh" api x\n',
		],
		[
			"a variable holding a command's name",
			'found=false\nfound=true\nif "$found"; then :; fi\n',
		],
		["a `case` pattern", 'case "$x" in\n  /*|"$y") echo hi ;;\nesac\n'],
		["a `[[` test", '[[ "$x" == /* &&\n  "$y" != "$z" ]] && echo hi\n'],
		["a heredoc's body", 'cat <<EOF\nsource "$X/a.sh"\nEOF\n'],
		["an array of data", "PROSE=(\n  . ':(exclude)*.js'\n)\n"],
		["arithmetic", "if (( $# > 0 )); then :; fi\n"],
	])("reads %s as no load", (_what, code) => {
		expect(sh(code).unread).toEqual([]);
	});

	it("walks a script with no extension by its #! line, as a git hook", () => {
		expect(
			sh('#!/usr/bin/env sh\nnode "$UNSET/x.js"\n', "/x/.husky/pre-commit")
				.unread,
		).toHaveLength(1);
	});

	/* Finding R3-ST1: a walk for edges alone must not need python3 to read a
	 * shell script's inline Python program. */
	it("reads a shell script's edges where no python3 is on PATH", () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ce-")));
		const probe = path.join(root, "probe.js");
		fs.writeFileSync(
			probe,
			`const { edgesOf } = require(${JSON.stringify(require.resolve("./code-edges.js"))});\nprocess.stdout.write(JSON.stringify(edgesOf("/x/s/a.sh", "python3 -c 'import sys'\\n", () => {})));\n`,
		);
		/* spawn-kept: python3's version is read once per process, so a walk
		 * with no python3 on PATH needs a process that never read it. */
		const r = spawnSync(process.execPath, [probe], {
			encoding: "utf8",
			env: { PATH: root },
		});
		expect(r.stderr).toBe("");
		expect(JSON.parse(r.stdout)).toEqual([]);
	});

	it("hands edgesOf's callers the edges alone", () => {
		expect(
			edgesOf("/x/s/a.sh", 'node "$UNSET/x.js"\n', () => undefined),
		).toEqual([]);
	});
});
