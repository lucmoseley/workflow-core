// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js: stale prose and `--review`, the anchors' writer.
 *
 * The checker is a hard gate in .husky/pre-commit and roadmap-digest.yml:
 * loosen a case and a rule can claim **Enforced** while its guard is missing
 * or unwired.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from check-guard-registry.test.ts, whose cost was pre-existing (#4294).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	ANCHORS,
	build,
	committedRepo,
	type Fixture,
	hooksWiring,
	lock,
	NEIGHBOUR,
	ownLocks,
	readAnchors,
	region,
	removeTemps,
	reviewEnv,
	reviewIn,
	run,
	SELF_PLUGIN_HOOKS,
	TWO_GUARDS,
	templateOf,
	temps,
} from "./lib/guard-registry-testkit";
import { runInProcess } from "./lib/run-in-process";

afterEach(removeTemps);

describe("stale prose — has the guard moved since anyone confirmed the sentence", () => {
	const guardFixture: Fixture = {
		claude: region(
			"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
		),
		files: {
			"scripts/guard-branch.sh": "#!/bin/sh\nexit 2\n",
			[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
		},
	};

	function guardRepo(): string {
		return build(guardFixture);
	}

	it("warns that a guard nobody has confirmed the prose against is unanchored, naming the guard", () => {
		const r = run(guardRepo());
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["UNANCHORED"]);
		expect(r.json.warnings[0].guard).toBe("scripts/guard-branch.sh");
	});

	it("--review clears the warning and records the guard's digest", () => {
		const root = guardRepo();
		const out = reviewIn(root);
		expect(out).toContain("anchored scripts/guard-branch.sh");
		expect(out).toContain("describes: CLAUDE.md");
		expect(Object.keys(readAnchors(root))).toEqual(["scripts/guard-branch.sh"]);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("--review inside a linked worktree hashes and writes that worktree, not CLAUDE_PROJECT_DIR's tree (#3386)", () => {
		const shared = committedRepo(guardFixture);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: shared, encoding: "utf8" });
		const tree = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-wt-"));
		temps.push(tree);
		git("worktree", "add", "-q", "--detach", tree);
		/* The shared tree's guard differs, as a neighbour's uncommitted edit. */
		fs.writeFileSync(
			path.join(shared, "scripts", "guard-branch.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		const r = runInProcess(
			path.join(tree, "scripts", "check-guard-registry.js"),
			["--review", "scripts/guard-branch.sh"],
			{ cwd: tree, env: reviewEnv(shared, { WFC_ANCHOR_LOCKS: "[]" }) },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("anchored scripts/guard-branch.sh");
		expect(fs.existsSync(path.join(shared, ANCHORS))).toBe(false);
		reviewIn(shared);
		const neighbourAnchors = readAnchors(shared);
		git("checkout", "--", "scripts/guard-branch.sh");
		reviewIn(shared);
		expect(readAnchors(tree)).toEqual(readAnchors(shared));
		expect(readAnchors(tree)).not.toEqual(neighbourAnchors);
	});

	describe("a non-git export nested in the checkout (#3450)", () => {
		/* The checkout ignores its scratch, so a filter asked of the enclosing
		 * repo would drop every document in the export. */
		function nestedExport() {
			const shared = committedRepo({
				...guardFixture,
				files: { ...guardFixture.files, ".gitignore": ".claude/tmp/\n" },
			});
			const exportDir = path.join(shared, ".claude", "tmp", "export");
			fs.mkdirSync(exportDir, { recursive: true });
			const tar = path.join(shared, ".claude", "tmp", "head.tar");
			execFileSync("git", ["archive", "-o", tar, "HEAD"], { cwd: shared });
			execFileSync("tar", ["-xf", tar, "-C", exportDir]);
			return { shared, exportDir };
		}

		it.each([["--review"], ["--against", "HEAD"]])(
			"refuses %s, naming the checkout it would read",
			(...args) => {
				const { shared, exportDir } = nestedExport();
				const r = runInProcess(
					path.join(exportDir, "scripts", "check-guard-registry.js"),
					args,
					{
						cwd: exportDir,
						env: reviewEnv(shared, { WFC_ANCHOR_LOCKS: "[]" }),
					},
				);
				expect(r.status).toBe(2);
				const out = `${r.stdout}${r.stderr}`;
				expect(out).toContain(
					`a copy nested in ${fs.realpathSync(shared)} with no repository of its own`,
				);
				expect(out).toContain("git worktree add --detach <dir> HEAD");
				expect(fs.existsSync(path.join(shared, ANCHORS))).toBe(false);
				expect(fs.existsSync(path.join(exportDir, ANCHORS))).toBe(false);
			},
		);

		it("reads the export under --root, unfiltered by the checkout's ignore rules", () => {
			const { exportDir } = nestedExport();
			const r = run(exportDir, ["--root", exportDir], { cwd: exportDir });
			expect(r.code).toBe(0);
			expect(r.report).toContain("1 guard-registry region(s)");
			expect(r.report).toContain("Gitignore filter: not run");
		});
	});

	/*
	 * A SPAWN, KEPT FOR A REAL FD (§X3): the in-process runner captures writes
	 * before any pipe sees them, so only a spawn shows what reaches a session's
	 * Bash pipe. node drops what is still buffered on one at process.exit, and
	 * 64 KiB is the pipe buffer: 1,500 missing paths clear it, and the summary
	 * is written last.
	 */
	it("prints a report longer than the pipe buffer whole, summary included (#1444)", () => {
		const root = guardRepo();
		const missing = Array.from(
			{ length: 1500 },
			(_, i) => `scripts/guard-never-written-${String(i).padStart(4, "0")}.sh`,
		);
		// spawn-kept: a real fd — the pipe buffer, as above.
		const r = spawnSync(
			process.execPath,
			[
				path.join(root, "scripts", "check-guard-registry.js"),
				"--review",
				...missing,
			],
			{
				cwd: root,
				encoding: "utf8",
				env: reviewEnv(root, { WFC_ANCHOR_LOCKS: "[]" }),
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout.length).toBeGreaterThan(64 * 1024);
		expect(r.stdout).toContain(
			"skipped scripts/guard-never-written-1499.sh — file does not exist",
		);
		expect(r.stdout.trimEnd()).toMatch(
			/0 path\(s\) re-anchored in [^\n]*\. Re-anchoring asserts everything printed as anchored above was re-read against the file\.$/,
		);
	});

	it("warns when the guard changes and its registry sentence does not, as STALE-PROSE", () => {
		const root = guardRepo();
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-branch.sh"),
			"#!/bin/sh\n# now it only warns\nexit 0\n",
		);
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].detail).toContain("since the last review");
	});

	it("stops warning by itself when the guard is changed back", () => {
		// A content digest, not a commit sha: a revert restores the reviewed
		// bytes, and re-reviewing an unchanged guard would be a rubber stamp.
		const root = guardRepo();
		reviewIn(root);
		const guard = path.join(root, "scripts", "guard-branch.sh");
		const original = fs.readFileSync(guard, "utf8");
		fs.writeFileSync(guard, "#!/bin/sh\nexit 0\n");
		expect(run(root).json.warnings).toHaveLength(1);
		fs.writeFileSync(guard, original);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("names every rule describing the changed guard, not just the first", () => {
		const root = build({
			claude: region(
				"- Claiming. **Enforced** (#113): `scripts/guard-file-claim.sh` denies the write.",
				"- Warning. **Enforced** (#120): the same `scripts/guard-file-claim.sh` hook warns of a neighbour's claim.",
			),
			files: {
				"scripts/guard-file-claim.sh": "#!/bin/sh\nexit 2\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-file-claim.sh"),
			},
		});
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			"#!/bin/sh\nexit 0\n",
		);
		const w = run(root).json.warnings;
		expect(w).toHaveLength(1);
		expect(w[0].rules).toHaveLength(2);
	});

	it("anchors a guard named inside a longer backticked command", () => {
		// The release rule (mantahostels#121, mantahostels#126) says `node scripts/session-arbiter.js
		// release <path>` — the pending staleness instance the ticket cites. An
		// extractor that only reads whole-span paths misses exactly that case.
		const root = build({
			claude: region(
				"- Release it: `node scripts/session-arbiter.js release <path>`. **Unenforced** (#121): nothing makes a session call it.",
			),
			files: { "scripts/session-arbiter.js": "// arbiter\n" },
		});
		expect(run(root).json.warnings[0].guard).toBe("scripts/session-arbiter.js");
	});

	it("does not anchor a config file a rule mentions in passing", () => {
		// The release rule recounts a session holding `.claude/settings.json` for
		// hours. Anchoring that would warn on every unrelated settings edit —
		// unclearable wallpaper. An unwired guard is UNWIRED's job, not this one.
		const root = build({
			claude: region(
				"- A session held `.claude/settings.json` too long. **Unenforced** (#121): nothing makes it release.",
			),
			files: { [SELF_PLUGIN_HOOKS]: hooksWiring() },
		});
		expect(run(root).json.warnings).toEqual([]);
	});

	it("reports an anchor no rule names any more, and a bare --review drops it", () => {
		const root = guardRepo();
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, ANCHORS),
			JSON.stringify({
				"scripts/guard-branch.sh": readAnchors(root)["scripts/guard-branch.sh"],
				"scripts/guard-gone.sh": "deadbeefdeadbeef",
			}),
		);
		expect(run(root).json.warnings.map((w) => w.kind)).toEqual([
			"ORPHAN-ANCHOR",
		]);
		expect(reviewIn(root)).toContain("dropped scripts/guard-gone.sh");
		expect(run(root).json.warnings).toEqual([]);
	});

	it("refuses a run over an anchors file that is not a JSON object of digests, and a targeted --review leaves it as it was (#4177)", () => {
		const root = guardRepo();
		const malformed = '{"scripts/guard-branch.sh": 1}\n';
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(root, ANCHORS), malformed);
		const r = run(root);
		expect(r.code).toBe(2);
		expect(JSON.stringify(r.json)).toContain(
			`${ANCHORS} is not a JSON object of digests`,
		);
		expect(() => reviewIn(root, ["scripts/guard-branch.sh"])).toThrow(
			/--review exited 2/,
		);
		expect(fs.readFileSync(path.join(root, ANCHORS), "utf8")).toBe(malformed);
	});

	it("--review <path> re-anchors only that guard", () => {
		const root = build({
			claude: region(
				"- One. **Enforced** (#1): `scripts/guard-a.sh`.",
				"- Two. **Enforced** (#2): `scripts/guard-b.sh`.",
			),
			files: {
				"scripts/guard-a.sh": "#!/bin/sh\nexit 0\n",
				"scripts/guard-b.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring(
					"scripts/guard-a.sh",
					"scripts/guard-b.sh",
				),
			},
		});
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-a.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-b.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		expect(run(root).json.warnings).toHaveLength(2);
		reviewIn(root, ["scripts/guard-a.sh"]);
		const w = run(root).json.warnings;
		expect(w).toHaveLength(1);
		expect(w[0].guard).toBe("scripts/guard-b.sh");
	});

	describe("--review --stale, the list and the re-anchor in one call (#4170)", () => {
		/* Refused before any scan or write, so one bare tree serves every row. */
		let bare = "";
		beforeAll(() => {
			bare = build({ claude: region() });
			/* Out of `temps`, which afterEach empties after the first case. */
			temps.splice(temps.indexOf(bare), 1);
		});
		afterAll(() => fs.rmSync(bare, { recursive: true, force: true }));

		function staleA(): string {
			const root = build({
				claude: region(
					"- One. **Enforced** (#1): `scripts/guard-a.sh`.",
					"- Two. **Enforced** (#2): `scripts/guard-b.sh`.",
				),
				files: {
					"scripts/guard-a.sh": "#!/bin/sh\nexit 0\n",
					"scripts/guard-b.sh": "#!/bin/sh\nexit 0\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring(
						"scripts/guard-a.sh",
						"scripts/guard-b.sh",
					),
				},
			});
			reviewIn(root);
			fs.writeFileSync(
				path.join(root, "scripts", "guard-a.sh"),
				"#!/bin/sh\nexit 1\n",
			);
			return root;
		}

		it("re-anchors only the stale row, printing the rule it asserts was re-read", () => {
			const root = staleA();
			const before = readAnchors(root)["scripts/guard-b.sh"];
			const out = reviewIn(root, ["--stale"]);
			expect(out).toContain("anchored scripts/guard-a.sh");
			expect(out).toContain("describes: CLAUDE.md:");
			expect(out).not.toContain("anchored scripts/guard-b.sh");
			expect(readAnchors(root)["scripts/guard-b.sh"]).toBe(before);
			expect(run(root).json.warnings).toEqual([]);
		});

		it("drops an orphan row, one no rule names any more", () => {
			const root = staleA();
			reviewIn(root, ["--stale"]);
			fs.writeFileSync(
				path.join(root, ANCHORS),
				JSON.stringify({
					...readAnchors(root),
					"scripts/guard-gone.sh": "deadbeefdeadbeef",
				}),
			);
			expect(reviewIn(root, ["--stale"])).toContain(
				"dropped scripts/guard-gone.sh",
			);
			expect(readAnchors(root)).not.toHaveProperty("scripts/guard-gone.sh");
			expect(run(root).json.warnings).toEqual([]);
		});

		it("leaves the anchors file untouched where no row is stale", () => {
			const root = staleA();
			reviewIn(root, ["--stale"]);
			const before = fs.readFileSync(path.join(root, ANCHORS), "utf8");
			expect(reviewIn(root, ["--stale"])).toContain("No stale row");
			expect(fs.readFileSync(path.join(root, ANCHORS), "utf8")).toBe(before);
		});

		it.each([
			[["--stale"], "--stale only qualifies --review."],
			[
				["--review", "--stale", "scripts/guard-a.sh"],
				"--stale re-anchors the rows the scan finds stale, so it takes no path.",
			],
		])("refuses %j as BROKEN, naming the misuse", (args, message) => {
			const r = runInProcess(
				path.join(bare, "scripts", "check-guard-registry.js"),
				args,
				{ env: reviewEnv(bare) },
			);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(message);
		});
	});

	/*
	 * mantahostels#2636's fixture. Two guards, so a per-path run has something it must
	 * leave alone — and a real git repo, because the claim check reads the
	 * working tree's dirty set before it reads any claim.
	 */
	const twoGuards = templateOf(() =>
		committedRepo({
			claude: region(
				"- One. **Enforced** (#1): `scripts/guard-a.sh`.",
				"- Two. **Enforced** (#2): `scripts/guard-b.sh`.",
			),
			files: {
				"scripts/guard-a.sh": "#!/bin/sh\nexit 0\n",
				"scripts/guard-b.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring(
					"scripts/guard-a.sh",
					"scripts/guard-b.sh",
				),
			},
		}),
	);

	const self = "self-session";

	function env(locks: unknown[]): Record<string, string> {
		return {
			CLAUDE_CODE_SESSION_ID: self,
			WFC_ANCHOR_LOCKS: JSON.stringify(locks),
		};
	}

	/** Dirty in git's eyes, and a different digest from the committed bytes. */
	function dirty(root: string, guard: string): void {
		fs.writeFileSync(path.join(root, "scripts", guard), "#!/bin/sh\nexit 1\n");
	}

	it("--review <path> leaves every entry but the named one byte-identical (mantahostels#2636)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = fs.readFileSync(path.join(root, ANCHORS), "utf8");
		// Both move on disk; only one is named, so only one may be rewritten.
		dirty(root, "guard-a.sh");
		dirty(root, "guard-b.sh");
		reviewIn(root, ["scripts/guard-a.sh"], env(ownLocks(root, self)));
		const after = fs.readFileSync(path.join(root, ANCHORS), "utf8");
		expect(after).not.toBe(before);
		const strip = (raw: string) =>
			raw
				.split("\n")
				.filter((l) => !l.includes('"scripts/guard-a.sh"'))
				.join("\n");
		expect(strip(after)).toBe(strip(before));
	});

	it("counts what the run wrote, not what the anchors file holds (mantahostels#2636)", () => {
		const root = twoGuards();
		reviewIn(root);
		const out = reviewIn(root, ["scripts/guard-a.sh"], env([]));
		expect(out).toContain("1 path(s) re-anchored");
		expect(out).toContain("1 existing entry was left byte-identical");
		expect(reviewIn(root, [], env([]))).toContain("2 path(s) re-anchored");
	});

	it("will not anchor a path a live neighbour holds dirty, and says whose", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(
			root,
			["scripts/guard-a.sh"],
			env([lock("scripts/guard-a.sh")]),
		);
		expect(out).toContain("not anchored scripts/guard-a.sh");
		expect(out).toContain(NEIGHBOUR);
		expect(out).toContain("0 path(s) re-anchored");
		expect(out).toContain("Re-run once the holder releases");
		expect(readAnchors(root)).toEqual(before);
	});

	it("anchors the named path when the claim is on a DIFFERENT file", () => {
		// The positive half of the pair: a skip that fired on everything would
		// pass the case above and fail this one.
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		dirty(root, "guard-b.sh");
		const out = reviewIn(
			root,
			["scripts/guard-a.sh"],
			env([
				lock("scripts/guard-b.sh"),
				...ownLocks(root, self, ["scripts/guard-b.sh"]),
			]),
		);
		expect(out).toContain("anchored scripts/guard-a.sh");
		expect(out).toContain("1 path(s) re-anchored");
		expect(readAnchors(root)["scripts/guard-a.sh"]).not.toBe(
			before["scripts/guard-a.sh"],
		);
	});

	it("tells a reader a GONE holder will never release", () => {
		const root = twoGuards();
		reviewIn(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(
			root,
			["scripts/guard-a.sh"],
			env([lock("scripts/guard-a.sh", { alive: false })]),
		);
		expect(out).toContain("(GONE)");
		expect(out).toContain("commit or revert the file");
		expect(out).not.toContain("Re-run once the holder releases");
	});

	it("a bare --review carries a held path's anchor over rather than dropping it", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		reviewIn(root, [], env([lock("scripts/guard-a.sh")]));
		// Dropped, it would read as UNANCHORED — a worse claim than a stale one.
		expect(readAnchors(root)["scripts/guard-a.sh"]).toBe(
			before["scripts/guard-a.sh"],
		);
		expect(run(root).json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
	});

	it("anchors nothing dirty when it could not ask who holds what, and says so (#3339)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(root, [], { CLAUDE_CODE_SESSION_ID: "" });
		expect(out).toContain("claim check skipped — this session is unidentified");
		expect(out).toContain(
			"not anchored scripts/guard-a.sh — scripts/guard-a.sh is dirty and not claimed by this session",
		);
		expect(out).toContain("anchored scripts/guard-b.sh @");
		expect(readAnchors(root)).toEqual(before);
	});

	it("anchors nothing through a dirty input no claim covers, so no anchor departs from HEAD's digest (#3339)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(root, [], env([]));
		expect(out).toContain(
			"not anchored scripts/guard-a.sh — scripts/guard-a.sh is dirty and not claimed by this session",
		);
		expect(out).toContain("claim scripts/guard-a.sh if yours (");
		expect(out).not.toContain("Re-run once the holder releases");
		expect(readAnchors(root)).toEqual(before);
		reviewIn(root, [], env(ownLocks(root, self)));
		expect(readAnchors(root)["scripts/guard-a.sh"]).not.toBe(
			before["scripts/guard-a.sh"],
		);
	});

	it("--sole-writer reads every dirty input as the caller's, as init-adopter's fresh tree needs", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(root, ["--sole-writer"], env([]));
		expect(out).toContain("anchored scripts/guard-a.sh @");
		expect(readAnchors(root)["scripts/guard-a.sh"]).not.toBe(
			before["scripts/guard-a.sh"],
		);
	});

	it("--own reads a named dirty input as the caller's, though no claim names it (#4078)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(
			root,
			["scripts/guard-a.sh", "--own", "scripts/guard-a.sh"],
			env([]),
		);
		expect(out).toContain("anchored scripts/guard-a.sh @");
		expect(readAnchors(root)["scripts/guard-a.sh"]).not.toBe(
			before["scripts/guard-a.sh"],
		);
		expect(readAnchors(root)["scripts/guard-b.sh"]).toBe(
			before["scripts/guard-b.sh"],
		);
	});

	it("--own takes no path a live neighbour holds dirty (#4078)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(
			root,
			["scripts/guard-a.sh", "--own", "scripts/guard-a.sh"],
			env([lock("scripts/guard-a.sh")]),
		);
		expect(out).toContain("not anchored scripts/guard-a.sh");
		expect(readAnchors(root)).toEqual(before);
	});

	describe("a row already stale at HEAD (#4756)", () => {
		/* guard-branch.sh sources lib/deny.sh: anchored and committed, then the
		 * library changes in a commit that leaves the row stale. */
		function staleAtHead(): { root: string; git: (...a: string[]) => string } {
			const root = committedRepo(TWO_GUARDS);
			const git = (...args: string[]) =>
				execFileSync("git", args, { cwd: root, encoding: "utf8" });
			reviewIn(root, [], env([]));
			git("add", ANCHORS);
			git("commit", "-qm", "anchor");
			fs.writeFileSync(
				path.join(root, "scripts/lib/deny.sh"),
				"deny() { exit 3; }\n",
			);
			git("commit", "-qam", "change the library unread");
			return { root, git };
		}

		it("names the row and the inputs changed since its anchor was written", () => {
			const { root, git } = staleAtHead();
			const writer = git("log", "-1", "--format=%h", "HEAD~1").trim();
			fs.writeFileSync(
				path.join(root, "scripts/guard-branch.sh"),
				'#!/bin/sh\nsource "$(dirname "$0")/lib/deny.sh"\nexit 1\n',
			);
			const out = reviewIn(
				root,
				["scripts/guard-branch.sh", "--own", "scripts/guard-branch.sh"],
				env([]),
			);
			expect(out).toContain("Already stale at HEAD");
			const row = out
				.split("\n")
				.find((l) => l.startsWith("  scripts/guard-branch.sh — anchored at"));
			/* The library HEAD changed is named; the guard, this commit's own
			 * uncommitted change, is not. */
			expect(row).toBe(
				`  scripts/guard-branch.sh — anchored at ${git("rev-parse", "--short=9", writer).trim()}; changed since: scripts/lib/deny.sh`,
			);
			expect(out).not.toContain("  scripts/guard-amend.sh —");
		});

		it("names nothing where only this commit's change moved the row", () => {
			const { root, git } = staleAtHead();
			reviewIn(root, ["scripts/guard-branch.sh"], env([]));
			git("commit", "-qam", "re-anchor");
			dirty(root, "guard-amend.sh");
			const out = reviewIn(
				root,
				["scripts/guard-amend.sh", "--own", "scripts/guard-amend.sh"],
				env([]),
			);
			expect(out).toContain("anchored scripts/guard-amend.sh @");
			expect(out).not.toContain("Already stale at HEAD");
		});
	});

	it("--own is refused where the claims went unread, so a neighbour's hold is unknown (#4078)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const r = runInProcess(
			path.join(root, "scripts", "check-guard-registry.js"),
			["--review", "scripts/guard-a.sh", "--own", "scripts/guard-a.sh"],
			{ env: reviewEnv(root, { ...env([]), WFC_ANCHOR_LOCKS: "null" }) },
		);
		expect(r.status).toBe(2);
		expect(r.stdout).toContain(
			"--own refused — the claim store would not be read",
		);
		expect(readAnchors(root)).toEqual(before);
	});

	it("offers no claim for a dirty input the arbiter does not watch, as under .husky/ (#4078)", () => {
		const root = committedRepo({
			claude: region("- Hook. **Unenforceable**: `.husky/pre-commit`."),
			files: { ".husky/pre-commit": "#!/bin/sh\nexit 0\n" },
		});
		reviewIn(root, [], env([]));
		fs.writeFileSync(
			path.join(root, ".husky/pre-commit"),
			"#!/bin/sh\nexit 1\n",
		);
		const out = reviewIn(root, [".husky/pre-commit"], env([]));
		expect(out).toContain(
			"no claim can name .husky/pre-commit, which the arbiter does not watch",
		);
		expect(out).not.toContain("claim .husky/pre-commit if yours");
	});

	it("--sole-writer is refused where another session holds a live claim, or the claims went unread (#3339)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const soleWriter = (claimsEnv: Record<string, string>) =>
			runInProcess(
				path.join(root, "scripts", "check-guard-registry.js"),
				["--review", "--sole-writer"],
				{ env: reviewEnv(root, claimsEnv) },
			);
		const held = soleWriter(env([lock("scripts/guard-b.sh")]));
		expect(held.status).toBe(2);
		expect(held.stdout).toContain(
			"--sole-writer refused — another session holds a claim in this tree",
		);
		const unidentified = soleWriter({
			CLAUDE_CODE_SESSION_ID: "",
			WFC_ANCHOR_LOCKS: JSON.stringify([lock("scripts/guard-b.sh")]),
		});
		expect(unidentified.status).toBe(2);
		expect(unidentified.stdout).toContain(
			"--sole-writer refused — another session holds a claim in this tree",
		);
		const unread = soleWriter({ ...env([]), WFC_ANCHOR_LOCKS: "null" });
		expect(unread.status).toBe(2);
		expect(unread.stdout).toContain(
			"--sole-writer refused — the claim store would not be read",
		);
		expect(readAnchors(root)).toEqual(before);
	});

	it("--sole-writer anchors for an unidentified caller where no other session holds a claim, as init run from a terminal needs (#3474)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(root, ["--sole-writer"], {
			CLAUDE_CODE_SESSION_ID: "",
			WFC_ANCHOR_LOCKS: "[]",
		});
		expect(out).toContain("anchored scripts/guard-a.sh @");
		expect(out).not.toContain("claim check skipped");
		expect(readAnchors(root)["scripts/guard-a.sh"]).not.toBe(
			before["scripts/guard-a.sh"],
		);
	});

	it("reads a staged rename's old name as a dirty input (#3339)", () => {
		const root = committedRepo(TWO_GUARDS, (r) => reviewIn(r));
		const before = readAnchors(root);
		execFileSync(
			"git",
			["mv", "scripts/lib/deny.sh", "scripts/lib/deny-moved.sh"],
			{ cwd: root },
		);
		const out = reviewIn(root, ["scripts/guard-branch.sh"], env([]));
		expect(out).toContain(
			"scripts/lib/deny.sh is dirty and not claimed by this session",
		);
		expect(readAnchors(root)).toEqual(before);
	});

	describe("mid-merge, a closure file staged at a parent's blob (#4529)", () => {
		const base = "deny() { exit 2; }\n\n\n\nwarn() { exit 0; }\n";
		const git = (root: string, ...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		const write = (root: string, rel: string, body: string) =>
			fs.writeFileSync(path.join(root, rel), body);
		/* deny.sh changed on both sides, so the session claims its re-read;
		 * extra.sh only on the side coming in. */
		const midMerge = templateOf(() => {
			const root = committedRepo(
				{
					...TWO_GUARDS,
					files: {
						...TWO_GUARDS.files,
						"scripts/guard-branch.sh":
							'#!/bin/sh\nsource "$(dirname "$0")/lib/deny.sh"\nsource "$(dirname "$0")/lib/extra.sh"\nexit 2\n',
						"scripts/lib/deny.sh": base,
						"scripts/lib/extra.sh": "extra() { :; }\n",
					},
				},
				(r) => reviewIn(r, [], { WFC_ANCHOR_LOCKS: "[]" }),
			);
			git(root, "checkout", "-qb", "theirs");
			write(root, "scripts/lib/deny.sh", base.replace("exit 0", "exit 1"));
			write(root, "scripts/lib/extra.sh", "extra() { exit 1; }\n");
			git(root, "commit", "-qam", "theirs");
			git(root, "checkout", "-q", "-");
			write(root, "scripts/lib/deny.sh", base.replace("exit 2", "exit 3"));
			git(root, "commit", "-qam", "ours");
			git(root, "merge", "-q", "--no-commit", "--no-ff", "theirs");
			return root;
		});
		const claimAllButIncoming = (root: string) =>
			env(ownLocks(root, self, ["scripts/lib/extra.sh"]));
		const review = (root: string) =>
			reviewIn(root, ["scripts/guard-branch.sh"], claimAllButIncoming(root));

		it("re-anchors the row to the merged index's digest, and the merge then commits", () => {
			const root = midMerge();
			const before = readAnchors(root)["scripts/guard-branch.sh"];
			const out = review(root);
			expect(out).toContain("anchored scripts/guard-branch.sh @");
			expect(out).not.toContain("not claimed by this session");
			expect(readAnchors(root)["scripts/guard-branch.sh"]).not.toBe(before);
			git(root, "add", ANCHORS);
			git(root, "commit", "-q", "--no-edit");
			expect(run(root).kinds).not.toContain("STALE-PROSE");
		});

		it.each([
			["edited in the working tree", false],
			["edited and staged", true],
		])(
			"still refuses, by name, a closure file %s to match neither parent",
			(_, staged) => {
				const root = midMerge();
				const before = readAnchors(root);
				write(root, "scripts/lib/extra.sh", "extra() { exit 4; }\n");
				if (staged) git(root, "add", "scripts/lib/extra.sh");
				expect(review(root)).toContain(
					"scripts/lib/extra.sh is dirty and not claimed by this session",
				);
				expect(readAnchors(root)).toEqual(before);
			},
		);

		it("still refuses a closure file the merge left conflicted", () => {
			const root = midMerge();
			git(root, "reset", "-q", "--hard");
			const before = readAnchors(root);
			write(root, "scripts/lib/extra.sh", "extra() { exit 5; }\n");
			git(root, "commit", "-qam", "ours again");
			const r = spawnSync("git", ["merge", "-q", "--no-commit", "theirs"], {
				cwd: root,
			});
			expect(r.status).not.toBe(0);
			expect(
				git(root, "ls-files", "-u", "--", "scripts/lib/extra.sh"),
			).not.toBe("");
			expect(review(root)).toContain(
				"scripts/lib/extra.sh is dirty and not claimed by this session",
			);
			expect(readAnchors(root)).toEqual(before);
		});
	});

	it("reads a dead neighbour's claim aged past use as nobody's, not as a pass (#3339)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = readAnchors(root);
		dirty(root, "guard-a.sh");
		const aged = {
			...lock("scripts/guard-a.sh", { alive: false }),
			claimedAt: "2000-01-01T00:00:00.000Z",
		};
		const out = reviewIn(root, ["scripts/guard-a.sh"], env([aged]));
		expect(out).toContain("is dirty and not claimed by this session");
		expect(readAnchors(root)).toEqual(before);
	});

	it("keeps a stale anchor from masking a real enforcement failure", () => {
		// Staleness is advisory; the false-claim checks are not.
		const root = build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh`.",
			),
			files: { "scripts/guard-branch.sh": "#!/bin/sh\nexit 0\n" },
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNWIRED"]);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["UNANCHORED"]);
	});
});
