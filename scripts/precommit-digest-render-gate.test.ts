// @vitest-environment node
/*
 * The pre-commit digest-render gate (mantahostels#2890), exercised as the shell it is.
 *
 * docs/roadmap-digest.md is `derived` in docs/doc-map.md §A. This gate renders
 * fresh and refuses bytes that differ.
 *
 * UNVERIFIED here: that roadmap-digest.yml runs this checker (mantahostels#2895).
 *
 * The checker is stubbed in each fixture so its exit code is ours to drive;
 * the adopter and core blocks pin which generator copy the render goes through.
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a digest no
 * render reproduces lands, read by pick-next and manual-sync as the roadmap's
 * state, until the sweeps' digest-render step reaches it up to ~12 hours later.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	armingPattern,
	cutGateScript,
	expectFixtureSupplies,
	gateHead,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { coreCall, HOOK } from "./lib/precommit-gate-testkit";

const CHECKER = "scripts/check-digest-render.js";
const VERSION_CHECKER = "scripts/check-digest-version.js";
const ROADMAP = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";
const GEN = ".claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js";

const STUB_MARKER = "STUB-RENDER-CHECK-RAN";

const temps = registerTempCleanup();

function write(root: string, rel: string, body: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
}

/** All three paths the gate stages out, present in the first commit. */
const TRIPLE = {
	[ROADMAP]: "html committed\n",
	[DIGEST]: "digest committed\n",
	[GEN]: "generator committed\n",
};

/**
 * A repo holding one commit, a stubbed checker, and whatever `staged` names.
 *
 * The stub prints its marker and the CONTENT of every file argument, which is
 * how a case tells the index copy from the working tree's.
 */
function fixture(opts: {
	checkerExit: number;
	committed?: Record<string, string>;
	staged?: Record<string, string>;
	deleted?: string[];
	dirty?: Record<string, string>;
}): TempRepo {
	const checker = `console.log("${STUB_MARKER}");
const fs = require("node:fs");
for (const a of process.argv.slice(2)) {
	if (fs.existsSync(a) && fs.statSync(a).isFile())
		console.log("ARG " + fs.readFileSync(a, "utf8").trim());
}
process.exit(${opts.checkerExit});
`;
	const repo = stagedRepo(
		"digest-render-gate-",
		temps,
		{ [CHECKER]: checker, ...opts.committed },
		opts.staged ?? {},
	);
	const { root, git } = repo;
	for (const rel of opts.deleted ?? []) git("rm", "-q", "--", rel);
	// Written AFTER staging, so the worktree and the index disagree on purpose.
	for (const [rel, body] of Object.entries(opts.dirty ?? {}))
		write(root, rel, body);
	return repo;
}

function runGate(
	cwd: string,
	fragment: string = cutGateScript(CHECKER),
	pluginRoot?: string,
): { code: number; output: string } {
	// Never inherited: a WFC_PLUGIN_ROOT in the runner's environment would turn
	// every core case into an adopter one.
	const env = { ...process.env };
	delete env.WFC_PLUGIN_ROOT;
	if (pluginRoot !== undefined) env.WFC_PLUGIN_ROOT = pluginRoot;
	try {
		// `2>&1` over the whole block because both the skip notice and hold
		// mode's replay go to stderr, which execFileSync does not hand back.
		const out = execFileSync("sh", ["-ec", `{\n${fragment}\n:\n} 2>&1\n`], {
			cwd,
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, output: out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

/* In `hold` mode the checker's output is replayed only on a failure, so every
 * case asking WHETHER the checker ran drives it to exit 1 and reads the
 * replay. A green stub proves nothing about arming — it is silent either way. */
const armed = (opts: Parameters<typeof fixture>[0]) => fixture(opts);

describe("the pre-commit digest-render gate", () => {
	it("is wired into .husky/pre-commit", () => {
		expect(HOOK).toContain(coreCall("node", CHECKER));
	});

	it("supplies exactly the scripts the gate invokes", () => {
		expectFixtureSupplies(CHECKER, [CHECKER]);
	});

	// The stamp comparison is the cheaper and more legible failure, so a commit
	// that fails both reports that one.
	it("runs after the digest-version gate", () => {
		const lines = HOOK.split("\n");
		const callOf = (checker: string) =>
			lines.findIndex(
				(l) => l.includes(checker) && !l.trimStart().startsWith("#"),
			);
		expect(callOf(VERSION_CHECKER)).toBeGreaterThan(-1);
		expect(callOf(CHECKER)).toBeGreaterThan(callOf(VERSION_CHECKER));
	});

	it("runs the checker for a commit staging the roadmap", () => {
		const { root } = armed({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [ROADMAP]: "html edited\n" },
		});

		const { code, output } = runGate(root);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	// The failure the gate exists for: a hand-edit to the derived file.
	it("runs the checker for a commit staging the digest", () => {
		const { root } = armed({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "digest edited by hand\n" },
		});

		const { code, output } = runGate(root);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	// Armed on the generator too: a behaviour-changing edit committed alone
	// would leave main carrying a digest no render reproduces, and the next
	// roadmap commit would be refused for a fault it did not cause.
	it("runs the checker for a commit staging the generator alone", () => {
		const { root } = armed({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [GEN]: "generator edited\n" },
		});

		const { code, output } = runGate(root);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("carries the regeneration command in the refusal", () => {
		const { root } = armed({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "digest edited by hand\n" },
		});

		expect(runGate(root).output).toContain("--out docs/roadmap-digest.md");
	});

	// `hold` mode: the checker prints an OK line on every run, and a green line
	// on every roadmap commit is noise.
	it("says nothing when the checker passes", () => {
		const { root } = armed({
			checkerExit: 0,
			committed: TRIPLE,
			staged: { [ROADMAP]: "html edited\n" },
		});

		const { code, output } = runGate(root);
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	// BROKEN (exit 2) is the generator unable to run, and must block the commit
	// as a finding does. Pinned exactly, or a `|| exit 1` mutation passes here.
	it("fails the commit with 2 when the checker reports BROKEN", () => {
		const { root } = armed({
			checkerExit: 2,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
		});

		const { code, output } = runGate(root);
		expect(code).toBe(2);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the checker for a commit touching none of the three", () => {
		const { root } = armed({
			// Exit 1, so a gate that wrongly ran it fails loudly.
			checkerExit: 1,
			committed: TRIPLE,
			staged: { "app/page.tsx": "x\n" },
		});

		const { code, output } = runGate(root);
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	it("does not fire on a path that only resembles one of the three", () => {
		const { root } = armed({
			checkerExit: 1,
			committed: TRIPLE,
			staged: {
				[`vendor/${ROADMAP}`]: "x\n",
				[`${DIGEST}.bak`]: "x\n",
				[`${GEN}.orig`]: "x\n",
			},
		});

		expect(runGate(root).code).toBe(0);
	});

	it("judges the staged bytes, not the ones in the working tree", () => {
		const { root } = armed({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "INDEX-DIGEST\n" },
			dirty: { [DIGEST]: "NEIGHBOUR-HALF-WRITTEN\n" },
		});

		const { output } = runGate(root);
		expect(output).toContain("ARG INDEX-DIGEST");
		expect(output).not.toContain("NEIGHBOUR");
	});

	// The generator is staged out too, so a parallel session's half-saved
	// gen-roadmap-digest.js is never the one that renders.
	it("renders through the index's generator, not the working tree's", () => {
		const { root } = armed({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
			dirty: { [GEN]: "NEIGHBOUR-HALF-WRITTEN\n" },
		});

		const { output } = runGate(root);
		expect(output).toContain("ARG generator committed");
		expect(output).not.toContain("NEIGHBOUR");
	});

	// Apparatus missing is not a finding: warn and let the commit through.
	it("skips, without failing, when a path is not in the index", () => {
		const { root } = armed({
			checkerExit: 1,
			committed: { [ROADMAP]: "html\n", [DIGEST]: "digest\n" },
			staged: { [DIGEST]: "x\n" },
		});

		const { code, output } = runGate(root);
		expect(code).toBe(0);
		expect(output).toContain("skipped the digest-render check");
		// the skip names the path that was missing, not the whole list
		expect(output).toContain(GEN);
		expect(output).not.toContain(STUB_MARKER);
	});
});

/**
 * A plugin tree holding the generator, which the stub checker prints, and the
 * fixture root's stub checker, which the hook runs from the plugin wherever
 * WFC_PLUGIN_ROOT is set (#1839).
 */
function pluginTree(checkerFrom: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-render-plugin-"));
	temps.push(dir);
	write(dir, GEN, "PLUGIN-GENERATOR\n");
	write(dir, CHECKER, fs.readFileSync(path.join(checkerFrom, CHECKER), "utf8"));
	return dir;
}

/** A linked worktree of the fixture, staging the generator's deletion. */
function coreWorktree(git: TempRepo["git"]): string {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "digest-render-wt-"));
	temps.push(parent);
	const wt = path.join(parent, "wt");
	git("worktree", "add", "-q", "--detach", wt);
	write(wt, DIGEST, "x\n");
	execFileSync("git", ["add", "--", DIGEST], { cwd: wt });
	execFileSync("git", ["rm", "-q", "--", GEN], { cwd: wt });
	return wt;
}

/*
 * In an adopter the generator is the plugin's (#551).
 */
describe("the digest-render gate in an adopter", () => {
	it("passes a commit deleting the host's generator copy", () => {
		const { root } = fixture({
			checkerExit: 0,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
			deleted: [GEN],
		});

		const { code, output } = runGate(root, undefined, pluginTree(root));
		expect(output).not.toContain("DELETES");
		expect(code).toBe(0);
	});

	it("renders that commit's digest through the plugin's generator", () => {
		const { root } = fixture({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
			deleted: [GEN],
		});

		const { code, output } = runGate(root, undefined, pluginTree(root));
		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
		expect(output).toContain("ARG PLUGIN-GENERATOR");
	});

	it("ignores a host copy of the generator", () => {
		const { root } = fixture({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
		});

		const { code, output } = runGate(root, undefined, pluginTree(root));
		expect(code).toBe(1);
		expect(output).toContain("ARG PLUGIN-GENERATOR");
		expect(output).not.toContain("ARG generator committed");
	});

	it("names the plugin's generator, quoted, in the regeneration command", () => {
		const { root } = fixture({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
		});
		const plugin = pluginTree(root);

		expect(runGate(root, undefined, plugin).output).toContain(
			`node "${plugin}/${GEN}" docs/reference-roadmap.html --out`,
		);
	});

	// An adopter runs this same hook with $WFC_PLUGIN_ROOT exported by its
	// shim (#1839), so the checker it calls is the plugin's, never the repo's.
	it("passes the deletion through the hook as an adopter runs it, to the plugin's checker", () => {
		const { root } = fixture({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
			deleted: [GEN],
		});
		const plugin = pluginTree(root);
		fs.rmSync(path.join(root, CHECKER));

		const { code, output } = runGate(root, undefined, plugin);
		expect(code).toBe(1);
		expect(output).not.toContain("DELETES");
		expect(output).toContain("ARG PLUGIN-GENERATOR");
	});
});

describe("the digest-render gate in the core", () => {
	it("still refuses a commit deleting the generator, naming the check that reads it", () => {
		const { root } = fixture({
			checkerExit: 0,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
			deleted: [GEN],
		});

		const { code, output } = runGate(root);
		expect(code).toBe(1);
		expect(output).toContain(`the digest-render check reads ${GEN}`);
		expect(output).toContain("this commit DELETES it");
	});

	// WFC_PLUGIN_ROOT naming this repo's own top is the core, not an adopter.
	it("still refuses it with WFC_PLUGIN_ROOT set to the repo itself", () => {
		const { root } = fixture({
			checkerExit: 0,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
			deleted: [GEN],
		});

		const { code, output } = runGate(root, undefined, root);
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
	});

	// Nor is a linked worktree whose WFC_PLUGIN_ROOT names the canonical
	// checkout: that would render through the canonical tree's copy on disk.
	it("still refuses it from a worktree, WFC_PLUGIN_ROOT naming the checkout", () => {
		const { root, git } = fixture({ checkerExit: 0, committed: TRIPLE });
		const wt = coreWorktree(git);

		const { code, output } = runGate(wt, undefined, root);
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
	});
});

describe("mutations of the gate are caught by the cases above", () => {
	const mutate = (find: string | RegExp, replace: string): string => {
		const original = cutGateScript(CHECKER);
		const mutant = original.replace(find, replace);
		expect(mutant, `mutation '${find}' did not apply`).not.toBe(original);
		return mutant;
	};

	it("stops failing the commit when the exit is dropped", () => {
		const { root } = fixture({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
		});

		expect(runGate(root, mutate(/exit "\$sg_(status|exit)"/g, ":")).code).toBe(
			0,
		);
	});

	it("runs out of scope when its path filter is dropped", () => {
		const { root } = fixture({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { "app/page.tsx": "x\n" },
		});

		// Read off the block; the literal it yields is replaced in the whole script.
		const { code, output } = runGate(
			root,
			mutate(gateHead(CHECKER), "if true; then\n"),
		);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("fires on a look-alike when the pattern loses its leading anchor", () => {
		const { root } = fixture({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [`vendor/${ROADMAP}`]: "x\n" },
		});

		const { code, output } = runGate(
			root,
			mutate(armingPattern(CHECKER), armingPattern(CHECKER).replace(/^\^/, "")),
		);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	// Drop the generator from the staged-out list and the gate renders through
	// whatever is on disk, which is what the parallel-session case forbids.
	it("reads the working tree's generator when it is dropped from the stage-out", () => {
		const { root } = fixture({
			checkerExit: 1,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
			dirty: { [GEN]: "NEIGHBOUR-HALF-WRITTEN\n" },
		});

		const mutant = mutate(
			'dr_paths="$dr_paths $dr_gen_rel"',
			'dr_gen="$dr_gen_rel"',
		);
		expect(runGate(root, mutant).output).toContain("NEIGHBOUR");
	});

	it("refuses the adopter's deletion when the plugin branch is dropped", () => {
		const { root } = fixture({
			checkerExit: 0,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
			deleted: [GEN],
		});

		const mutant = mutate(/\[ -n "\$\{WFC_PLUGIN_ROOT:-\}" \]/, "false");
		const { code, output } = runGate(root, mutant, pluginTree(root));
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
	});

	it("treats the core as an adopter when the own-top test is dropped", () => {
		const { root } = fixture({
			checkerExit: 0,
			committed: TRIPLE,
			staged: { [DIGEST]: "x\n" },
			deleted: [GEN],
		});

		const mutant = mutate(
			'[ "$dr_plugin" != "$(pwd -P)" ] && [ "$dr_plugin" != "$dr_canon" ]',
			"true",
		);
		expect(runGate(root, mutant, root).code).toBe(0);
	});

	it("treats a core worktree as an adopter when the checkout test is dropped", () => {
		const { root, git } = fixture({ checkerExit: 0, committed: TRIPLE });
		const wt = coreWorktree(git);

		const mutant = mutate(' && [ "$dr_plugin" != "$dr_canon" ]', "");
		expect(runGate(wt, mutant, root).code).toBe(0);
	});
});
