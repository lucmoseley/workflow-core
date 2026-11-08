// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js: what a guard's digest covers, and the scan's gitignore scope.
 *
 * The checker is a hard gate in .husky/pre-commit and roadmap-digest.yml:
 * loosen a case and a rule can claim **Enforced** while its guard is missing
 * or unwired.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from check-guard-registry.test.ts, whose cost was pre-existing (#4294).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANCHORS,
	asRoot,
	build,
	committedRepo,
	type Fixture,
	hooksWiring,
	type Result,
	readAnchors,
	region,
	removeTemps,
	reviewIn,
	run,
	SELF_PLUGIN_HOOKS,
	temps,
} from "./lib/guard-registry-testkit";

afterEach(removeTemps);

describe("a guard's digest covers the libraries it sources (mantahostels#140)", () => {
	/* A guard that reaches its verdict through a shared library, as the three
	 * Bash guards do. The library is named in no rule, so it can never be
	 * anchored on its own: the checker rejects an anchor no rule mentions. */
	const withLib = (lib: string) =>
		build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
			),
			files: {
				"scripts/guard-branch.sh":
					'#!/bin/sh\nsource "$(dirname "$0")/lib/deny.sh"\nexit 2\n',
				"scripts/lib/deny.sh": lib,
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
			},
		});

	it("warns the guard is stale when only its library changed, naming the guard, not the library", () => {
		// The deny lives in the library, so a change there can falsify the rule
		// describing the guard.
		const root = withLib("deny() { exit 2; }\n");
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "deny.sh"),
			"deny() { exit 0; }\n",
		);

		const r = run(root);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].guard).toBe("scripts/guard-branch.sh");
		// The guard's own bytes did not move, so the finding names the library route too (#3122).
		expect(r.json.warnings[0].detail).toContain(
			"the guard or a library its digest hashes changed",
		);
	});

	it("still anchors the guard alone, never the library", () => {
		// An anchor for the library would fail as ORPHAN-ANCHOR: no rule names it.
		const root = withLib("deny() { exit 2; }\n");
		reviewIn(root);

		expect(Object.keys(readAnchors(root))).toEqual(["scripts/guard-branch.sh"]);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("is quiet when neither guard nor library has moved", () => {
		const root = withLib("deny() { exit 2; }\n");
		reviewIn(root);

		expect(run(root).json.warnings).toEqual([]);
	});

	it("survives a library that sources itself", () => {
		// A cycle must not hang or blow the stack; each file is hashed once.
		const root = withLib('source "$(dirname "$0")/lib/deny.sh"\n');
		reviewIn(root);

		expect(run(root).json.warnings).toEqual([]);
	});
});

describe("a JS guard's digest covers the modules it requires (mantahostels#159)", () => {
	/* session-arbiter.js's shape after mantahostels#159: a CLI named by the rule, whose
	 * behaviour sits two requires away in lib/. */
	const withModules = (leaf: string) =>
		build({
			claude: region(
				"- Release a file you are done with. **Enforced** (#126): `scripts/session-arbiter.js` releases it.",
			),
			files: {
				"scripts/session-arbiter.js":
					'const store = require("./lib/arbiter-store.js");\nstore.release();\n',
				"scripts/lib/arbiter-store.js":
					'const proc = require("./arbiter-proc.js");\nmodule.exports = { release: () => proc.holderAlive({}) };\n',
				"scripts/lib/arbiter-proc.js": leaf,
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/session-arbiter.js"),
			},
		});

	it("warns the CLI is stale when only the leaf two requires away changed, naming the CLI, not the leaf", () => {
		const root = withModules("module.exports = { holderAlive: () => true };\n");
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-proc.js"),
			"module.exports = { holderAlive: () => false };\n",
		);

		const r = run(root);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].guard).toBe("scripts/session-arbiter.js");
	});

	it("still anchors the CLI alone, never the modules under it", () => {
		const root = withModules("module.exports = { holderAlive: () => true };\n");
		reviewIn(root);

		expect(Object.keys(readAnchors(root))).toEqual([
			"scripts/session-arbiter.js",
		]);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("warns the CLI is stale when only a lib it requires without .js changed (#3795)", () => {
		const root = withModules("module.exports = { holderAlive: () => true };\n");
		fs.writeFileSync(
			path.join(root, "scripts", "session-arbiter.js"),
			'const store = require("./lib/arbiter-store");\nstore.release();\n',
		);
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			"module.exports = { release: () => false };\n",
		);

		const r = run(root);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].guard).toBe("scripts/session-arbiter.js");
	});

	it("does not follow a require that leaves lib/", () => {
		// Widening past lib/ would start hashing node_modules and every sibling
		// script.
		const root = withModules("module.exports = { holderAlive: () => true };\n");
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const proc = require("./arbiter-proc.js");\nconst other = require("../unrelated.js");\nmodule.exports = { release: () => proc.holderAlive({}) && other };\n',
		);
		fs.writeFileSync(
			path.join(root, "scripts", "unrelated.js"),
			"module.exports = 1;\n",
		);
		reviewIn(root);

		fs.writeFileSync(
			path.join(root, "scripts", "unrelated.js"),
			"module.exports = 2;\n",
		);
		expect(run(root).json.warnings).toEqual([]);
	});
});

describe("a thin shell guard's digest covers the program it runs (mantahostels#358)", () => {
	/* guard-file-claim.sh's shape: a shell guard that extracts a path and shells
	 * out, with every rule-bearing decision in the node program it runs. */
	const withDelegate = (store = 'const REFUSING = ["docs/"];\n') =>
		build({
			claude: region(
				"- A file a live session has written is taken. **Enforced** (#113): `scripts/guard-file-claim.sh` refuses the write.",
			),
			files: {
				"scripts/guard-file-claim.sh":
					'#!/bin/bash\nhere="$(dirname "$0")"\ntimeout 5 node "$here/session-arbiter.js" check "$file" "$session"\n',
				"scripts/session-arbiter.js":
					'const store = require("./lib/arbiter-store.js");\nstore.check();\n',
				"scripts/lib/arbiter-store.js": store,
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-file-claim.sh"),
			},
		});

	it("warns the guard is stale when only the store two hops away changed, naming the guard, not the store", () => {
		const root = withDelegate();
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const REFUSING = ["docs/", "scripts/"];\n',
		);

		const r = run(root);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].guard).toBe("scripts/guard-file-claim.sh");
	});

	it("still anchors the shell guard alone, never the program it runs", () => {
		const root = withDelegate();
		reviewIn(root);

		expect(Object.keys(readAnchors(root))).toEqual([
			"scripts/guard-file-claim.sh",
		]);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("is quiet when neither the guard nor anything under it has moved", () => {
		const root = withDelegate();
		reviewIn(root);

		expect(run(root).json.warnings).toEqual([]);
	});

	it("follows a program the guard runs through a variable it assigns (#2487)", () => {
		// The shape: lib="$here/lib/x.js" … node "$lib".
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nhere="$(dirname "$0")"\narbiter="$here/session-arbiter.js"\nout="$(printf x | node "$arbiter" check "$file")"\n',
		);
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const REFUSING = ["docs/", "scripts/"];\n',
		);

		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].guard).toBe("scripts/guard-file-claim.sh");
		expect(r.json.warnings[0].detail).toMatch(/re-read the rule/);
	});

	it("survives a node call naming a file that is not there", () => {
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nhere="$(dirname "$0")"\nnode "$here/absent.js" check\n',
		);
		reviewIn(root);

		// Absence is the BROKEN-CLAIM check's business, not the digest's.
		expect(run(root).json.warnings).toEqual([]);
	});
});

describe("a gate stack's digest stops at the gates it runs (#4456)", () => {
	/* .husky/pre-commit's shape: it sources its shared shell lib from the repo
	 * root, then runs gates whose libraries no rule of its own describes. */
	const header = (runs: string) =>
		[
			"#!/usr/bin/env sh",
			"# IMPLICIT:  runs every gate below and refuses the commit on a red.",
			"# JUSTIFIED: fail-safe — the last local moment before work is shared.",
			runs,
			"# DEFEAT:    WFC_ALLOW=1 skips it, the limb in scripts/lib/revert.js.",
			"",
		].join("\n");
	const stack = (runs: string) =>
		build({
			claude: region(
				"- Roadmap commits stay valid. **Enforced** (#9): `scripts/check-valid.js` in `.husky/pre-commit` refuses an invalid one.",
			),
			files: {
				".husky/pre-commit": `${header(runs)}. "\${ROOT:-.}"/scripts/lib/gate.sh\nnode "\${ROOT:-.}"/scripts/check-valid.js || exit "$?"\nnode "\${ROOT:-.}"/scripts/check-other.js || exit "$?"\n`,
				"scripts/lib/gate.sh":
					'gate() { node "$ROOT/scripts/lib/helper.js"; }\n',
				"scripts/lib/helper.js": "module.exports = 1;\n",
				"scripts/check-valid.js": 'require("./lib/valid-lib.js");\n',
				"scripts/lib/valid-lib.js": "module.exports = 1;\n",
				"scripts/check-other.js": 'require("./lib/other-lib.js");\n',
				"scripts/lib/other-lib.js": "module.exports = 1;\n",
				"scripts/lib/revert.js": 'require("./revert-dep.js");\n',
				"scripts/lib/revert-dep.js": "module.exports = 1;\n",
			},
		});
	const declared =
		"# RUNS:      gates — each program below is judged by its own row.";
	const edit = (root: string, rel: string) =>
		fs.writeFileSync(path.join(root, rel), "module.exports = 2;\n");
	const staleRows = (root: string) =>
		run(root)
			.json.warnings.filter((w) => w.kind === "STALE-PROSE")
			.map((w) => w.guard)
			.sort();

	it("follows no gate's libraries where the stack declares RUNS: gates", () => {
		const root = stack(declared);
		reviewIn(root);
		edit(root, "scripts/lib/other-lib.js");
		edit(root, "scripts/lib/valid-lib.js");

		// check-valid.js carries its own row, so its rule is still re-read.
		expect(staleRows(root)).toEqual(["scripts/check-valid.js"]);
	});

	it("follows no program a library the stack sources runs", () => {
		const root = stack(declared);
		reviewIn(root);
		edit(root, "scripts/lib/helper.js");

		expect(staleRows(root)).toEqual([]);
	});

	it("still follows the gates of a stack that declares nothing, as a thin wrapper needs", () => {
		const root = stack("#");
		reviewIn(root);
		edit(root, "scripts/lib/other-lib.js");

		expect(staleRows(root)).toEqual([".husky/pre-commit"]);
	});

	it("hashes the shell lib the stack sources from the repo root", () => {
		// The `lib/gate.sh` tail joined to .husky/ is nowhere; this file is the real one.
		const root = stack(declared);
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "gate.sh"),
			"gate() { exit 0; }\n",
		);

		expect(staleRows(root)).toEqual([".husky/pre-commit"]);
	});

	it("hashes a file its own header names, but not that file's libraries", () => {
		const root = stack(declared);
		reviewIn(root);
		edit(root, "scripts/lib/revert-dep.js");
		expect(staleRows(root)).toEqual([]);

		edit(root, "scripts/lib/revert.js");
		expect(staleRows(root)).toEqual([".husky/pre-commit"]);
	});
});

describe("gitignored scratch under a scan root (mantahostels#2243)", () => {
	/*
	 * A real git repository, because the filter asks `git check-ignore`. Only
	 * the case that needs a tracked file sets `commit`; the guard is staged in
	 * every case, as one outside the index is BROKEN-CLAIM (#4517).
	 */
	function gitRepo(
		fx: Fixture & { ignore?: string; commit?: boolean },
	): string {
		const root = build(fx);
		if (fx.ignore !== undefined)
			fs.writeFileSync(path.join(root, ".gitignore"), fx.ignore);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		git("init", "-q", ".");
		git("add", "--", "scripts/guard-branch.sh");
		if (fx.commit) {
			git("config", "user.email", "test@example.com");
			git("config", "user.name", "test");
			git("add", "-Af");
			git("commit", "-qm", "x");
		}
		return root;
	}

	const trigger = "The claim protocol is in `rule:no-such-rule`.\n";
	const files = {
		"scripts/guard-branch.sh": "#!/usr/bin/env bash\n",
		[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
	};
	const claude = region(
		"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.",
	);

	it("does not scan an ignored file", () => {
		const r = run(
			gitRepo({
				claude,
				ignore: ".claude/tmp/\n",
				files: { ...files, ".claude/tmp/review-spec-1.md": trigger },
			}),
		);
		expect(r.kinds).not.toContain("ORPHAN-TRIGGER");
		expect(r.code).toBe(0);
	});

	it("scans an untracked file that is not ignored", () => {
		/* Why the filter is not `git ls-files`: an uncommitted docs/research note
		 * is one `git add` from a commit, and --against reads the INDEX, so
		 * scoping to the tracked set would drop it while it is still the only
		 * copy anyone reads. */
		const r = run(
			gitRepo({
				claude,
				ignore: ".claude/tmp/\n",
				files: { ...files, "docs/research/note.md": trigger },
			}),
		);
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
	});

	it("skips the filter on a --root tree outside any repo, and says so", () => {
		/* The materialised --against tree: `git archive` wrote it tracked-only,
		 * so there is nothing to drop (#710). */
		const root = build({
			claude,
			files: {
				...files,
				// Present and matching, so a hand-rolled .gitignore parser
				// swapped in for `git check-ignore` would fail this case.
				".gitignore": ".claude/tmp/\n",
				".claude/tmp/review-spec-1.md": trigger,
			},
		});
		const r = run(root, ["--root", root]);
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
		expect(r.code).toBe(1);
		expect(r.report).toContain("Gitignore filter: not run");
		expect(r.report).not.toContain("FAILED OPEN");
	});

	it("fails open, and says so, where git cannot answer in a repo", () => {
		const root = gitRepo({
			claude,
			ignore: ".claude/tmp/\n",
			files: { ...files, ".claude/tmp/review-spec-1.md": trigger },
		});
		// PATH, not a WFC_ binary var (docs/code-standards-base.md §N7): the case is git missing from PATH.
		const r = run(root, [], { env: { PATH: "" } });
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
		expect(r.code).toBe(1);
		expect(r.report).toContain("Gitignore filter FAILED OPEN");
		expect(r.report).toContain("Tree read FAILED OPEN");
	});

	it("scans a tracked file that matches an ignore pattern", () => {
		/* The safety net, and the reason `--no-index` is not on the call: without
		 * it, `check-ignore` consults the index and will not call a tracked path
		 * ignored — so a broad pattern cannot quietly take a committed document
		 * out of the gate. */
		const r = run(
			gitRepo({
				claude,
				ignore: "docs/\n",
				commit: true,
				files: { ...files, "docs/research/note.md": trigger },
			}),
		);
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
	});

	it("does not read a gitignored emitter", () => {
		/* The emitter corpus is a SECOND walk over .claude/, and its read is
		 * deliberately unguarded so an unreadable emitter surfaces as BROKEN. An
		 * unreadable scratch file must therefore not reach it: .claude/tmp/ is the
		 * one directory a neighbouring session writes and deletes in while this
		 * runs. Mode 0 stands in for that race, which cannot be staged directly. */
		const root = gitRepo({
			claude,
			ignore: ".claude/tmp/\n",
			files: { ...files, ".claude/tmp/mut.sh": "#!/usr/bin/env bash\n" },
		});
		fs.chmodSync(path.join(root, ".claude", "tmp", "mut.sh"), 0o000);
		const r = run(root);
		expect(r.code).toBe(0);
	});

	/** Only a bound socket has the type on disk. */
	const runWithSocket = async (root: string, rel: string): Promise<Result> => {
		const socketPath = path.join(root, rel);
		fs.mkdirSync(path.dirname(socketPath), { recursive: true });
		const server = net.createServer();
		await new Promise<void>((done) => server.listen(socketPath, done));
		try {
			return run(root);
		} finally {
			await new Promise((done) => server.close(done));
		}
	};

	it.each([
		["gitignored", ".claude/tmp/\n", ".claude/tmp/s/systemd/private"],
		["gitignored, named like a document", ".claude/tmp/\n", ".claude/tmp/s.md"],
		["not gitignored, named like an emitter", "", ".claude/tmp/s.sh"],
		["standing as a scan root", "", "AGENTS.md"],
	])(
		"leaves the verdict clean over a socket: %s (#3974)",
		async (_name, ignore, rel) => {
			const r = await runWithSocket(gitRepo({ claude, ignore, files }), rel);
			expect(r.code).toBe(0);
			expect(r.kinds).toEqual([]);
		},
	);

	it.skipIf(asRoot)(
		"is not BROKEN over a scratch directory it cannot read (#3974)",
		() => {
			const root = gitRepo({
				claude,
				ignore: ".claude/tmp/\n",
				files: { ...files, ".claude/tmp/locked/note.md": trigger },
			});
			const locked = path.join(root, ".claude", "tmp", "locked");
			fs.chmodSync(locked, 0o000);
			try {
				expect(run(root).code).toBe(0);
			} finally {
				fs.chmodSync(locked, 0o755);
			}
		},
	);

	it.skipIf(asRoot).each([
		["cannot list", 0o000, /EACCES.*scandir.*docs\/sub/],
		["can list but not search", 0o600, /EACCES.*stat.*docs\/sub\/rules\.md/],
	])(
		"is BROKEN over a tracked directory it %s, in a repo (#3974)",
		(_name, mode, message) => {
			const root = gitRepo({
				claude,
				ignore: ".claude/tmp/\n",
				commit: true,
				files: { ...files, "docs/sub/rules.md": "A tracked document.\n" },
			});
			const sub = path.join(root, "docs", "sub");
			fs.chmodSync(sub, mode);
			try {
				const r = run(root);
				expect(r.code).toBe(2);
				expect(r.json).toMatchObject({
					outcome: "BROKEN",
					summary: expect.stringMatching(message),
				});
			} finally {
				fs.chmodSync(sub, 0o755);
			}
		},
	);

	it.each([
		["a document", "AGENTS.md", "notes/agents.md", "notes/agents.md"],
		["a directory", "docs", "notes", "notes/rules.md"],
	])(
		"scans through a scan root that is a symlink to %s (#4170)",
		(_name, link, target, doc) => {
			const root = gitRepo({ claude, files: { ...files, [doc]: trigger } });
			fs.symlinkSync(target, path.join(root, link));
			const r = run(root);
			expect(r.kinds).toContain("ORPHAN-TRIGGER");
			expect(r.code).toBe(1);
		},
	);

	/* The emitter corpus's listing (#4294): each path git lists that the walk
	 * never read stays unread, each one it read is still read. Mode 0 stands
	 * in for a read, which BROKEN then names. */
	it.skipIf(asRoot).each([
		["a tracked emitter that is a symlink", "scripts/link.sh"],
		[
			"a tracked emitter under a skipped directory",
			"scripts/node_modules/x.sh",
		],
	])("does not read %s (#4294)", (_name, rel) => {
		const root = gitRepo({
			claude,
			commit: true,
			files: { ...files, "outside/x.sh": "#!/bin/sh\n" },
		});
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		if (rel.endsWith("link.sh")) fs.symlinkSync("../outside/x.sh", abs);
		else fs.writeFileSync(abs, "#!/bin/sh\n");
		execFileSync("git", ["add", "-Af", "--", rel], { cwd: root });
		const locked = path.join(root, "outside", "x.sh");
		fs.chmodSync(locked, 0o000);
		if (!rel.endsWith("link.sh")) fs.chmodSync(abs, 0o000);
		try {
			expect(run(root).code).toBe(0);
		} finally {
			fs.chmodSync(locked, 0o755);
			if (!rel.endsWith("link.sh")) fs.chmodSync(abs, 0o755);
		}
	});

	it.skipIf(asRoot)(
		"reads an emitter in an untracked repository nested under scripts/ (#4294)",
		() => {
			const root = gitRepo({
				claude,
				files: { ...files, "scripts/nested/x.sh": "#!/bin/sh\n" },
			});
			execFileSync("git", ["init", "-q", "."], {
				cwd: path.join(root, "scripts", "nested"),
			});
			const locked = path.join(root, "scripts", "nested", "x.sh");
			fs.chmodSync(locked, 0o000);
			try {
				const r = run(root);
				expect(r.code).toBe(2);
				expect(r.json).toMatchObject({
					outcome: "BROKEN",
					summary: expect.stringMatching(/EACCES.*scripts\/nested\/x\.sh/),
				});
			} finally {
				fs.chmodSync(locked, 0o755);
			}
		},
	);

	it("scans an untracked repository nested under a scan root, which git lists as its directory alone (#4170)", () => {
		const root = gitRepo({
			claude,
			files: { ...files, "docs/nested/rules.md": trigger },
		});
		execFileSync("git", ["init", "-q", "."], {
			cwd: path.join(root, "docs", "nested"),
		});
		const r = run(root);
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
		expect(r.code).toBe(1);
	});

	/* git's untracked listing only warns past it, exit 0 (#4170). */
	it.skipIf(asRoot)(
		"is BROKEN over an untracked directory it cannot list, in a repo",
		() => {
			const root = gitRepo({
				claude,
				ignore: ".claude/tmp/\n",
				files: { ...files, "docs/sub/rules.md": "An untracked document.\n" },
			});
			const sub = path.join(root, "docs", "sub");
			fs.chmodSync(sub, 0o000);
			try {
				const r = run(root);
				expect(r.code).toBe(2);
				expect(r.json).toMatchObject({
					outcome: "BROKEN",
					summary: expect.stringMatching(/EACCES.*scandir.*docs\/sub/),
				});
			} finally {
				fs.chmodSync(sub, 0o755);
			}
		},
	);
});

describe("a row's digest is the commit's, not the worktree's (#4508)", () => {
	/* Every probe the closure makes: a hook-local lib shadowing the shared one,
	 * a sibling shadowing a run target, a require of a lib not in the tree, and
	 * a scripts/ path a gate stack's header names that no commit carries. */
	const shadows = [
		".husky/lib/gate.sh",
		".husky/scripts/check-valid.js",
		"scripts/lib/absent.js",
		"scripts/not-yet.js",
	];
	const rows = [".husky/pre-commit", "scripts/check-valid.js"];
	const commitWithWorktree = () => {
		const root = committedRepo({
			claude: region(
				"- Roadmap commits stay valid. **Enforced** (#9): `scripts/check-valid.js` in `.husky/pre-commit` refuses an invalid one.",
			),
			files: {
				".husky/pre-commit": [
					"#!/usr/bin/env sh",
					"# IMPLICIT:  runs every gate below and refuses the commit on a red.",
					"# JUSTIFIED: fail-safe — the last local moment before work is shared.",
					"# RUNS:      gates — scripts/not-yet.js joins them later.",
					"# DEFEAT:    none.",
					"#",
					'. "$ROOT"/scripts/lib/gate.sh',
					'node "$ROOT"/scripts/check-valid.js || exit "$?"',
					"",
				].join("\n"),
				"scripts/lib/gate.sh": "gate() { :; }\n",
				"scripts/check-valid.js": 'require("./lib/absent.js");\n',
				".gitignore": ".husky/lib/\n",
				[ANCHORS]: JSON.stringify(
					Object.fromEntries(rows.map((g) => [g, "0"])),
				),
			},
		});
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-"));
		temps.push(other);
		execFileSync("git", ["worktree", "add", "-q", "--detach", other], {
			cwd: root,
		});
		return { root, other };
	};
	const plant = (tree: string) => {
		for (const rel of shadows) {
			fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
			fs.writeFileSync(path.join(tree, rel), "planted\n");
		}
	};
	const digests = (tree: string) => {
		const r = run(tree);
		expect(r.kinds).toEqual([]);
		expect(r.code).toBe(0);
		expect(r.report).toContain("Re-read each rule above against its guard");
		return Object.fromEntries(
			r.json.warnings
				.filter((w) => w.kind === "STALE-PROSE")
				.map((w) => [w.guard, /now ([0-9a-f]{16})/.exec(w.detail)?.[1]]),
		);
	};

	it("gives every row one digest in two worktrees, one carrying untracked and ignored shadows", () => {
		const { root, other } = commitWithWorktree();
		plant(other);
		const clean = digests(root);

		expect(Object.keys(clean).sort()).toEqual(rows);
		expect(digests(other)).toEqual(clean);
	});

	it("writes one set of anchors from --review in both worktrees", () => {
		const { root, other } = commitWithWorktree();
		plant(other);
		reviewIn(root);
		reviewIn(other);

		expect(readAnchors(other)).toEqual(readAnchors(root));
	});

	it("re-anchors nothing where git cannot read the index", () => {
		const { root } = commitWithWorktree();
		const before = readAnchors(root);
		expect(() => reviewIn(root, [], { PATH: "" })).toThrow(
			/--review re-anchors nothing: git rev-parse failed/,
		);
		expect(readAnchors(root)).toEqual(before);
	});

	it("takes a shadow into the closure once it is in the index", () => {
		const { root, other } = commitWithWorktree();
		const clean = digests(root);
		fs.writeFileSync(path.join(other, "scripts", "lib", "absent.js"), "1\n");
		execFileSync("git", ["add", "scripts/lib/absent.js"], { cwd: other });

		expect(digests(other)["scripts/check-valid.js"]).not.toBe(
			clean["scripts/check-valid.js"],
		);
	});
});

describe("a rule's own guard is judged on the commit's tree (#4517)", () => {
	const guard = "scripts/guard-new.sh";

	it("gives the row one verdict and no digest in two worktrees, one holding the guard untracked", () => {
		const root = committedRepo({
			claude: region(
				`- New things are refused. **Enforced** (#9): \`${guard}\` denies them.`,
			),
			files: { [SELF_PLUGIN_HOOKS]: hooksWiring(guard) },
		});
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-"));
		temps.push(other);
		execFileSync("git", ["worktree", "add", "-q", "--detach", other], {
			cwd: root,
		});
		fs.mkdirSync(path.join(other, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(other, guard), "#!/usr/bin/env bash\n");
		const verdict = (tree: string) => {
			const r = run(tree);
			return {
				code: r.code,
				kinds: r.kinds,
				warned: r.json.warnings.filter((w) => w.guard === guard),
			};
		};

		const clean = verdict(root);
		expect(clean.kinds).toEqual(["BROKEN-CLAIM"]);
		expect(clean.warned).toEqual([]);
		expect(verdict(other)).toEqual(clean);
		expect(run(other).report).toContain(`\`git add ${guard}\``);
	});
});
