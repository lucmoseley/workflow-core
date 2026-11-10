// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js: `--against HEAD` refusing the commit that expires an anchor (#2617).
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
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFaultyGit } from "./lib/git-fault-fake";
import {
	ANCHORS,
	anchorExpiryKit,
	committedRepo,
	hooksWiring,
	lock,
	readAnchors,
	region,
	removeTemps,
	reviewIn,
	run,
	SELF_PLUGIN_HOOKS,
	temps,
} from "./lib/guard-registry-testkit";

const { DISPATCH_ENTRY, MANIFEST_REL } = require("./lib/guard-cores.js") as {
	DISPATCH_ENTRY: string;
	MANIFEST_REL: string;
};

afterEach(removeTemps);

describe("--against HEAD refuses the commit that expires an anchor (#2617)", () => {
	const { stagingRepo, claims, gate, review, added } = anchorExpiryKit();
	it("refuses a library change that expires a guard's anchor, naming the path, its rule, the --review line and the pathspec", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/lib/deny.sh": "deny() { exit 0; }\n" });
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(added(r)).toEqual([
			expect.stringContaining(
				"scripts/guard-branch.sh — the guard or a library its digest hashes changed since",
			),
		]);
		expect(r.report).toContain("STALE-PROSE  scripts/guard-branch.sh");
		expect(r.report).toContain("rule:  CLAUDE.md:");
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review scripts/guard-branch.sh",
		);
		expect(r.report).toContain(`put ${ANCHORS} in this commit's pathspec`);
	});

	it("passes the same change once its re-anchor is staged with it", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" });
		expect(gate(root).code).toBe(1);
		review(root, ["scripts/guard-amend.sh"]);
		stage({}, [ANCHORS]);
		const r = gate(root);
		expect(r.code).toBe(0);
		expect(added(r)).toEqual([]);
	});

	it("passes a commit over a row already stale at HEAD", () => {
		const { root, git, stage } = stagingRepo();
		stage({ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" });
		git("commit", "-qm", "stale at HEAD");
		stage({
			"CLAUDE.md": `${fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")}\n`,
		});
		const r = gate(root);
		expect(r.code).toBe(0);
		expect(added(r)).toEqual([]);
	});

	it("stands down a path a live neighbour holds dirty, and says whose", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/lib/deny.sh": "deny() { exit 0; }\n" });
		// Dirty in the working tree only: the neighbour's, not this commit's.
		fs.writeFileSync(
			path.join(root, "scripts", "guard-branch.sh"),
			'#!/bin/sh\nsource "$(dirname "$0")/lib/deny.sh"\nexit 3\n',
		);
		const r = gate(root, [lock("scripts/guard-branch.sh")]);
		expect(r.code).toBe(0);
		expect(r.report).toContain("not refusing scripts/guard-branch.sh");
		expect(r.report).toContain("neighbour-session");
	});

	it("stands down a row whose LIBRARY a live neighbour holds dirty, not only its guard", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/lib/deny.sh": "deny() { exit 0; }\n" });
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "deny.sh"),
			"deny() { exit 5; }\n",
		);
		const r = gate(root, [lock("scripts/lib/deny.sh")]);
		expect(r.code).toBe(0);
		expect(r.report).toContain(
			"not refusing scripts/guard-branch.sh — scripts/lib/deny.sh is dirty and claimed by neighbour-session",
		);
	});

	it("--review skips the same row the gate stands down, where only its LIBRARY is held, and still anchors a guard that does not read it (#2853)", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/lib/deny.sh": "deny() { exit 0; }\n" });
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "deny.sh"),
			"deny() { exit 5; }\n",
		);
		const before = readAnchors(root);
		const out = reviewIn(
			root,
			["scripts/guard-branch.sh", "scripts/guard-amend.sh"],
			claims([lock("scripts/lib/deny.sh")]),
		);
		expect(out).toContain(
			"not anchored scripts/guard-branch.sh — scripts/lib/deny.sh is dirty and claimed by neighbour-session",
		);
		expect(out).toMatch(/^\s*anchored scripts\/guard-amend\.sh/m);
		expect(out).toContain("1 path(s) re-anchored");
		expect(readAnchors(root)).toEqual(before);
	});

	it('says so where the staged read behind the "(through …)" notes fails, and still refuses (#2853)', () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/lib/deny.sh": "deny() { exit 0; }\n" });
		const failing = writeFaultyGit(
			{ words: ["diff", "--cached", "--name-only", "-z", "HEAD"] },
			{ exit: 7 },
		);
		temps.push(failing.dir);
		const r = run(root, ["--against", "HEAD"], {
			cwd: root,
			env: { ...claims(), WFC_GIT: failing.git },
		});
		expect(r.code).toBe(1);
		expect(r.report).toContain(
			"the paths each row went stale through not named — git diff --cached failed (exit 7).",
		);
		expect(r.report).toContain("STALE-PROSE  scripts/guard-branch.sh\n");
	});

	it("names the library a guard went stale through", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/lib/deny.sh": "deny() { exit 0; }\n" });
		expect(gate(root).report).toContain(
			"STALE-PROSE  scripts/guard-branch.sh (through scripts/lib/deny.sh)",
		);
	});

	it("says so where the working tree differs from the staged bytes a re-anchor must match", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/lib/deny.sh": "deny() { exit 0; }\n" });
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "deny.sh"),
			"deny() { exit 4; }\n",
		);
		review(root, ["scripts/guard-branch.sh"]);
		stage({}, [ANCHORS]);
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(r.report).toContain(
			"scripts/lib/deny.sh in the working tree differs from the staged copy, and --review hashes the working tree",
		);
	});

	it("says so where a re-anchor already run is left out of the commit", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" });
		review(root, ["scripts/guard-amend.sh"]);
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(r.report).toContain(
			`${ANCHORS} in the working tree differs from the staged copy`,
		);
	});

	it("refuses a rule newly naming a guard nobody anchored, as UNANCHORED", () => {
		const { root, stage } = stagingRepo();
		stage({
			"CLAUDE.md": region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
				"- Never amend. **Enforced** (#111): `scripts/guard-amend.sh` denies it.",
				"- Never rebase. **Enforced** (#112): `scripts/guard-rebase.sh` denies it.",
			),
			"scripts/guard-rebase.sh": "#!/bin/sh\nexit 2\n",
			[SELF_PLUGIN_HOOKS]: hooksWiring(
				"scripts/guard-branch.sh",
				"scripts/guard-amend.sh",
				"scripts/guard-rebase.sh",
			),
		});
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(r.report).toContain("UNANCHORED  scripts/guard-rebase.sh");
		expect(r.report).toContain("--review scripts/guard-rebase.sh");
	});

	it("refuses a commit that orphans an anchor, which --review <path> then drops", () => {
		const { root, stage } = stagingRepo();
		stage({
			"CLAUDE.md": region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
			),
			[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
		});
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(r.report).toContain("ORPHAN-ANCHOR  scripts/guard-amend.sh");
		expect(review(root, ["scripts/guard-amend.sh"])).toContain(
			"dropped scripts/guard-amend.sh — no rule names it and no wiring reaches it",
		);
		stage({}, [ANCHORS]);
		expect(gate(root).code).toBe(0);
	});

	it("refuses a commit that adds a dispatcher core in the manifest alone, naming the dispatcher (#3124)", () => {
		const guard = DISPATCH_ENTRY;
		const manifest = MANIFEST_REL;
		const rows = (...cores: string[]) =>
			JSON.stringify({
				PreToolUse: cores.map((core) => ({
					name: core,
					core: `${core}.js`,
					tools: "Bash",
					failure: "open",
				})),
			});
		const root = committedRepo(
			{
				claude: region(
					`- One dispatcher. **Enforced** (#2786): \`${guard}\` runs the cores.`,
				),
				files: {
					[guard]: 'require("./lib/guard-dispatch.js");\n',
					"scripts/lib/guard-dispatch.js": "// the kit\n",
					[manifest]: rows("a"),
					"scripts/lib/a.js": "// a\n",
					"scripts/lib/b.js": "// b\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring(guard),
				},
			},
			(repo) => reviewIn(repo, [], claims()),
		);
		expect(gate(root).code).toBe(0);
		fs.writeFileSync(path.join(root, manifest), rows("a", "b"));
		execFileSync("git", ["add", "--", manifest], { cwd: root });
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(r.report).toContain(`STALE-PROSE  ${guard}`);
		expect(r.report).toContain(`--review ${guard}`);
	});
});

describe("--against HEAD reads HEAD under HEAD's own checker, so a digest-code change that expires a row is refused (#4807)", () => {
	const { stagingRepo, gate, review, added } = anchorExpiryKit();
	const checker = "scripts/check-guard-registry.js";
	const loop = "for (const lib of sourcedBy(rel, text, root, !stack).sort())";
	/* The fixture's own checker, its digest of guard-branch.sh widened to fold
	 * guard-amend.sh in, every anchor and guard as committed. */
	const widen = (root: string) => {
		const code = fs.readFileSync(path.join(root, checker), "utf8");
		if (!code.includes(loop)) throw new Error(`no ${loop} in ${checker}`);
		return {
			[checker]: code.replace(
				loop,
				'for (const lib of [...sourcedBy(rel, text, root, !stack), ...(rel === "scripts/guard-branch.sh" ? ["scripts/guard-amend.sh"] : [])].sort())',
			),
		};
	};

	it("refuses the change, naming the one row it expired and that it may be re-anchored unread", () => {
		const { root, stage } = stagingRepo();
		stage(widen(root));
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(added(r)).toEqual([
			expect.stringContaining("scripts/guard-branch.sh"),
		]);
		expect(r.report).toContain("STALE-PROSE  scripts/guard-branch.sh");
		expect(r.report).not.toContain("STALE-PROSE  scripts/guard-amend.sh");
		expect(r.report).toContain(
			"none of its files changed: this commit changed how its digest is computed, so it may be re-anchored without a re-read (#4807)",
		);
	});

	it("passes the same change with that row re-anchored", () => {
		const { root, stage } = stagingRepo();
		stage(widen(root));
		review(root, ["scripts/guard-branch.sh"]);
		stage({}, [ANCHORS]);
		const r = gate(root);
		expect(r.code).toBe(0);
		expect(added(r)).toEqual([]);
	});
});
