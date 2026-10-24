// @vitest-environment node
/*
 * A staged DELETION of a gate's own required input, refused (mantahostels#2894).
 *
 * `gate_stage_out` reads every required path out of the index. Unreadable, it
 * failed and `staged_gate` warned and passed — apparatus missing is not a
 * finding. But "unreadable" covered two states, and only one of them is
 * apparatus: a path that was never in the index, and a path THIS COMMIT
 * DELETES. So `git rm docs/roadmap-digest.md` committed by pathspec landed,
 * printing nothing but a skip line, and the digest — `derived` in
 * docs/doc-map.md §A, read by pick-next, manual-sync and CLAUDE.md §Ground
 * truth — left the repo unseen by every gate.
 *
 * THE FIX IS IN THE SHARED LIBRARY, not in one gate, so the cases below drive
 * TWO callers: the digest-version gate (`live`, `status`) and the
 * superseded-needle gate (`hold`, flat 1, and an `opt:` path). A fix in
 * .husky/pre-commit's digest block alone would pass the first suite and fail
 * the second.
 *
 * A THIRD GATE reached neither, and mantahostels#2902 brought it in: the doc-map gate,
 * spelled out in .husky/pre-commit rather than declared, asking for its input
 * with `git checkout-index` instead of gate_stage_out.
 *
 * Every checker is stubbed to exit 1 and print a marker: the refusal happens
 * BEFORE the checker runs, so a case asserting the marker's absence is
 * asserting that the gate refused rather than merely that it exited non-zero.
 *
 * Throwaway repos throughout — the shared tree's index is repo-global (mantahostels#63).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	cutGateScript,
	expectFixtureSupplies,
	newRepo,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { HOOK } from "./lib/precommit-gate-testkit";

const VERSION_ANCHOR = "scripts/check-digest-version.js";
const SUPERSEDED_ANCHOR = "--broken-only";
const DOC_MAP_ANCHOR = "scripts/check-doc-map.js";

const ROADMAP = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";
const MAP = "docs/doc-map.md";
const NEEDLES = "docs/doc-map-superseded.json";

const STUB_MARKER = "STUB-CHECKER-RAN";
const ESCAPE = "WFC_ALLOW_GATE_INPUT_DELETE";
const DOLLAR = "$";

const temps = registerTempCleanup();

function write(root: string, rel: string, body: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
}

/**
 * A repo holding one commit, stubbed checkers, and whatever `staged` and
 * `deleted` name.
 *
 * `git rm --cached` rather than `git rm`: it stages the deletion and leaves the
 * worktree file alone, which is the harder case — a gate reading the worktree
 * instead of the index would still find the file and pass, so a case that
 * refuses here is refusing on the index.
 */
function fixture(opts: {
	checkers: string[];
	committed: Record<string, string>;
	staged?: Record<string, string>;
	deleted?: string[];
}): TempRepo {
	const stubs = Object.fromEntries(
		opts.checkers.map((c) => [
			c,
			`console.log("${STUB_MARKER}");\nprocess.exit(1);\n`,
		]),
	);
	const repo = stagedRepo(
		"gate-input-deletion-",
		temps,
		{ ...stubs, ...opts.committed },
		opts.staged ?? {},
	);
	for (const rel of opts.deleted ?? [])
		repo.git("rm", "-q", "--cached", "--", rel);
	return repo;
}

/**
 * A repo parked mid-merge with `docs/roadmap-digest.md` UNMERGED.
 *
 * Two branches edit the digest, then merge. git leaves the path at stages 2 and
 * 3 with no stage 0, so `git cat-file -p :<path>` fails exactly as it does for
 * a deleted path — which is why the filter that tells the two apart is tested.
 */
function conflicted(): TempRepo {
	const { root, git } = newRepo("gate-input-deletion-merge-", temps);
	for (const c of VERSION_CHECKERS)
		write(root, c, `console.log("${STUB_MARKER}");\nprocess.exit(1);\n`);
	write(root, ROADMAP, "html\n");
	write(root, DIGEST, "base\n");
	git("add", "--", ".");
	git("commit", "-qm", "seed");
	git("checkout", "-q", "-b", "other");
	write(root, DIGEST, "theirs\n");
	git("commit", "-qm", "theirs", "--", DIGEST);
	git("checkout", "-q", "-");
	write(root, DIGEST, "ours\n");
	git("commit", "-qm", "ours", "--", DIGEST);
	try {
		git("merge", "--no-edit", "other");
		throw new Error("the fixture's merge was expected to conflict");
	} catch (e) {
		// execFileSync throws on git's non-zero exit, which IS the conflict.
		if ((e as Error).message.includes("expected to conflict")) throw e;
	}
	return { root, git };
}

function runGate(
	cwd: string,
	fragment: string,
	env: Record<string, string> = {},
): { code: number; output: string } {
	try {
		// `2>&1` over the whole block: the skip line, the refusal and hold
		// mode's replay all go to stderr, which execFileSync does not hand back.
		const out = execFileSync("sh", ["-ec", `{\n${fragment}\n:\n} 2>&1\n`], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...env },
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

const versionGate = () => cutGateScript(VERSION_ANCHOR);
const supersededGate = () => cutGateScript(SUPERSEDED_ANCHOR);
const docMapGate = () => cutGateScript(DOC_MAP_ANCHOR);

const PAIR = { [ROADMAP]: "html\n", [DIGEST]: "digest\n" };
const VERSION_CHECKERS = ["scripts/check-digest-version.js"];
const SUPERSEDED_CHECKERS = ["scripts/check-superseded-values.js"];
const DOC_MAP_CHECKERS = [
	"scripts/check-doc-map.js",
	"scripts/checker-new-faults.js",
];

describe("a staged deletion of a gate's required input", () => {
	// mantahostels#2071: a fixture short of a script the gate invokes dies MODULE_NOT_FOUND,
	// which reads as a refusal and proves nothing.
	it("supplies exactly the scripts each gate under test invokes", () => {
		expectFixtureSupplies(VERSION_ANCHOR, VERSION_CHECKERS);
		expectFixtureSupplies(SUPERSEDED_ANCHOR, SUPERSEDED_CHECKERS);
	});

	// mantahostels#2894's reproduction: `git rm docs/roadmap-digest.md`.
	it("refuses the commit as a deletion, before the checker runs", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
		expect(output).not.toContain(STUB_MARKER);
	});

	it("names the deleted file and the way through", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		const { output } = runGate(root, versionGate());
		expect(output).toContain(DIGEST);
		expect(output).toContain("git checkout HEAD --");
		expect(output).toContain(`${ESCAPE}=1`);
	});

	// The `hold`-mode, flat-exit, `opt:`-carrying caller. A fix written into the
	// digest block alone passes the cases above and fails this one.
	it("refuses on a second staged_gate caller too, before the checker runs", () => {
		const { root } = fixture({
			checkers: SUPERSEDED_CHECKERS,
			committed: { [MAP]: "map\n", [NEEDLES]: "{}\n" },
			deleted: [MAP],
		});

		const { code, output } = runGate(root, supersededGate());
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
		expect(output).not.toContain(STUB_MARKER);
	});

	// The label is the gate's own, so a reader knows which check spoke.
	it("carries the gate's label in the refusal", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		expect(runGate(root, versionGate()).output).toContain(
			"the digest-version check reads",
		);
	});

	/*
	 * A rename reaches the refusal, and only because the arming condition takes
	 * `--no-renames` (mantahostels#2903).
	 *
	 * git's rename detection collapses the delete and the add into one R entry,
	 * and a bare `git diff --cached --name-only` prints only the NEW name — so
	 * the gate's arming grep, which matches the old path literally, never fired.
	 * Under --no-renames the old path is back in the output and the rename
	 * arrives as the deletion it is for every reader resolving the digest by
	 * literal path.
	 */
	it("refuses when the file is renamed rather than deleted, naming it as deleted, before its checker runs", () => {
		const { root, git } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
		});
		git("mv", DIGEST, "docs/roadmap-digest-renamed.md");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("DELETES");
		expect(output).toContain(DIGEST);
		expect(output).not.toContain(STUB_MARKER);
	});

	// The roadmap is the pair's other half, and renaming it alone must arm the
	// same gate — a rename OUT of the repo's docs/ tree included, which no
	// prefix-matching arming grep would otherwise see.
	it("refuses when the roadmap is renamed, out of docs/ included, naming the roadmap as deleted", () => {
		const { root, git } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
		});
		git("mv", ROADMAP, "elsewhere.html");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("DELETES");
		expect(output).toContain(ROADMAP);
	});

	// --no-renames adds paths and removes none, so an ungated file's rename
	// matches no gate's pattern and arms nothing — the gate must stay silent
	// rather than refusing every `git mv` in the repo.
	it("does not arm on an ordinary rename of an ungated file", () => {
		const { root, git } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { ...PAIR, "docs/notes.md": "notes\n" },
		});
		git("mv", "docs/notes.md", "docs/notes-renamed.md");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(0);
		expect(output).not.toContain("DELETES");
		expect(output).not.toContain(STUB_MARKER);
	});

	// The "Renaming it?" hint, on a rename alongside an edit: the digest is
	// edited and the roadmap moved, and the refusal names moving as the cause.
	it("names renaming as a cause when a gated path is moved", () => {
		const { root, git } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			staged: { [DIGEST]: "digest edited\n" },
		});
		git("mv", ROADMAP, "docs/reference-roadmap-renamed.html");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("Renaming it?");
		expect(output).toContain(ROADMAP);
	});

	// A refusal listing a path that is merely absent would send a reader to
	// restore a file no commit removed.
	it("names only the deleted path, not one that was never in the index", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { [ROADMAP]: "html\n", [DIGEST]: "digest\n" },
			deleted: [DIGEST, ROADMAP],
		});

		// Both deleted: both are named, and the roadmap is not silently dropped.
		const { output } = runGate(root, versionGate());
		expect(output).toContain(DIGEST);
		expect(output).toContain(ROADMAP);
	});
});

describe("the escape", () => {
	it("lets the deletion through when it is set", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		const { code, output } = runGate(root, versionGate(), { [ESCAPE]: "1" });
		expect(code).toBe(0);
		expect(output).toContain(`${ESCAPE} is set`);
		// The `, ` accumulator separator is stripped here as it is in the
		// refusal — "to delete, docs/…" reads as a truncated list.
		expect(output).toContain(`to delete ${DIGEST}.`);
		// Still a skip, never a run: the input it needs is gone either way.
		expect(output).toContain("skipped the digest-version check");
		expect(output).not.toContain(STUB_MARKER);
	});

	/* Any non-empty value, as .husky/pre-commit's own WFC_ALLOW_BRANCH takes:
	 * a `=1` test would refuse a founder who typed `=yes` and read the refusal
	 * as the escape not working. */
	it("takes any non-empty value", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		expect(runGate(root, versionGate(), { [ESCAPE]: "yes" }).code).toBe(0);
	});

	it("does not stand the gate down when it is empty", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		expect(runGate(root, versionGate(), { [ESCAPE]: "" }).code).toBe(1);
	});
});

describe("apparatus genuinely missing is unchanged", () => {
	// The second acceptance criterion of mantahostels#2894: a checkout that never held the
	// file still skips and passes.
	it("skips and passes when the path was never in the index", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { [ROADMAP]: "html\n" },
			staged: { [ROADMAP]: "html edited\n" },
		});

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(0);
		expect(output).toContain("skipped the digest-version check");
		expect(output).toContain(DIGEST);
		expect(output).not.toContain("DELETES");
	});

	// An `opt:` path's absence is what its checker is built to read, so a
	// deletion of one is judged there and the gate still runs.
	it("still runs the checker when an opt: path is deleted", () => {
		const { root } = fixture({
			checkers: SUPERSEDED_CHECKERS,
			committed: { [MAP]: "map\n", [NEEDLES]: "{}\n" },
			staged: { [MAP]: "map edited\n" },
			deleted: [NEEDLES],
		});

		const { code, output } = runGate(root, supersededGate());
		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("DELETES");
	});

	// mantahostels#2894's fix must not refuse a merge conflict's resolution: `cat-file -p
	// :<path>` fails on an unmerged path for want of a stage-0 blob, and the
	// whole hook stack runs on `git merge` here.
	it("skips and passes on an unmerged path mid-conflict", () => {
		const { root } = conflicted();

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(0);
		expect(output).toContain("skipped the digest-version check");
		expect(output).not.toContain("DELETES");
	});

	// A repo with no commit at all has no HEAD, and `git diff --cached` then
	// compares against the empty tree rather than failing.
	it("skips and passes on the first commit of a fresh repo", () => {
		const { root, git } = newRepo("gate-input-deletion-fresh-", temps);
		for (const c of VERSION_CHECKERS)
			write(root, c, `console.log("${STUB_MARKER}");\nprocess.exit(1);\n`);
		write(root, ROADMAP, "html\n");
		git("add", "--", ".");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(0);
		expect(output).toContain("skipped the digest-version check");
		expect(output).not.toContain("DELETES");
	});

	it("runs the checker normally when nothing is deleted", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			staged: { [DIGEST]: "digest edited\n" },
		});

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("DELETES");
	});
});

describe("mutations of the library are caught by the cases above", () => {
	const mutate = (find: string | RegExp, replace: string): string => {
		const original = versionGate();
		const mutant = original.replace(find, replace);
		expect(mutant, `mutation '${find}' did not apply`).not.toBe(original);
		return mutant;
	};

	const deletedFixture = () =>
		fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		}).root;

	it("stops refusing when the exit is dropped", () => {
		// gate_check_deleted's exit, after its refusal message: the library holds
		// other `exit 1` lines, staged_names's among them (#1504).
		const mutant = mutate(
			'gate_refuse_deleted "$1"\n    exit 1\n',
			'gate_refuse_deleted "$1"\n',
		);
		expect(runGate(deletedFixture(), mutant).code).toBe(0);
	});

	it("stops refusing when GATE_DELETED is never populated", () => {
		const mutant = mutate(
			'GATE_DELETED="$GATE_DELETED, $gate_p"',
			'GATE_DELETED="$GATE_DELETED"',
		);
		expect(runGate(deletedFixture(), mutant).code).toBe(0);
	});

	// The deletion test itself: made unconditional, a path that was merely
	// never in the index starts refusing.
	it("refuses a never-present path as deleted when the deletion test is unconditional", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { [ROADMAP]: "html\n" },
			staged: { [ROADMAP]: "html edited\n" },
		});

		const mutant = mutate('[ -n "$gate_del" ]', "true");
		const { code, output } = runGate(root, mutant);
		expect(code).toBe(1);
		expect(output).toContain("DELETES");
	});

	/*
	 * TWO MUTANTS ARE DELIBERATELY ABSENT, each because it was tried and the
	 * behaviour it claimed did not happen.
	 *
	 * `--diff-filter=D` -> `DU`: mid-conflict the gate still skipped, so the
	 * filter is not what keeps an unmerged path out — `git diff --cached`
	 * simply reports no entry for one under either filter. The filter stays as
	 * a narrowing of intent, and the positive mid-conflict case above is what
	 * actually guards the behaviour.
	 *
	 * `--literal-pathspecs` dropped: no gated path holds `?`, `*`, `[` or a
	 * leading `:`, so no fixture over the real path list can tell the two
	 * spellings apart. The flag is prospective — a filename is not a pathspec —
	 * spellings apart. The flag is prospective — a filename is not a pathspec.
	 */

	it("stops honouring the escape when its test is inverted", () => {
		// Assembled rather than written out: a literal `${…}` inside a quoted
		// string is Biome's noTemplateCurlyInString, and this one is shell.
		const escapeTest = (flag: string) => `[ ${flag} "${DOLLAR}{${ESCAPE}:-}" ]`;
		const mutant = mutate(escapeTest("-z"), escapeTest("-n"));
		expect(runGate(deletedFixture(), mutant, { [ESCAPE]: "1" }).code).toBe(1);
	});
});

/*
 * THE DOC-MAP GATE IS THE THIRD CALLER, AND IT REACHED NONE OF THE ABOVE
 * (mantahostels#2902).
 *
 * .husky/pre-commit spells that gate out rather than declaring it — mantahostels#1793 left
 * it that way for its `--map-dirty` flag, temp index and untracked-entry
 * replay — and it asks for its input with `git checkout-index` and a file test
 * rather than `gate_stage_out`. So `git rm --cached docs/doc-map.md` took the
 * skip line, `dm_status` stayed 0, and the commit landed: the repo's authority
 * model, always loaded and read before any tracked-document edit, out of the
 * tree with nothing printed but a warning.
 *
 * Measured pre-fix at exit 0, the skip line, no checker run (mantahostels#2902). The fix
 * calls gate_stage_out for the MAP ALONE down the not-readable limb, so these
 * cases run against the same gate_check_deleted the two callers above use.
 */

/**
 * A repo whose index names `docs/doc-map.md` at a blob the object store
 * doesn't hold — the OTHER cause of `checkout-index` failing outright,
 * distinct from the file simply never being staged.
 *
 * `update-index --cacheinfo` overwrites the index entry with a sha no `git
 * add` ever wrote an object for, so `checkout-index -a` (and `cat-file -p
 * :docs/doc-map.md`, which `gate_stage_out` reads next) both fail — but `git
 * diff --cached --diff-filter=D` sees a modified path, not a deleted one, so
 * the gate must skip and pass rather than refuse.
 */
function badBlobMap(): TempRepo {
	const { root, git } = newRepo("gate-input-deletion-map-badblob-", temps);
	for (const c of DOC_MAP_CHECKERS)
		write(root, c, `console.log("${STUB_MARKER}");\nprocess.exit(1);\n`);
	write(root, MAP, "map\n");
	git("add", "--", ".");
	git("commit", "-qm", "seed");
	git(
		"update-index",
		"--add",
		"--cacheinfo",
		"100644,1111111111111111111111111111111111111111,docs/doc-map.md",
	);
	return { root, git };
}

/** A repo parked mid-merge with `docs/doc-map.md` UNMERGED — as `conflicted()`
 * above, over the path this gate reads. */
function conflictedMap(): TempRepo {
	const { root, git } = newRepo("gate-input-deletion-map-merge-", temps);
	for (const c of DOC_MAP_CHECKERS)
		write(root, c, `console.log("${STUB_MARKER}");\nprocess.exit(1);\n`);
	write(root, MAP, "base\n");
	git("add", "--", ".");
	git("commit", "-qm", "seed");
	git("checkout", "-q", "-b", "other");
	write(root, MAP, "theirs\n");
	git("commit", "-qm", "theirs", "--", MAP);
	git("checkout", "-q", "-");
	write(root, MAP, "ours\n");
	git("commit", "-qm", "ours", "--", MAP);
	try {
		git("merge", "--no-edit", "other");
		throw new Error("the fixture's merge was expected to conflict");
	} catch (e) {
		if ((e as Error).message.includes("expected to conflict")) throw e;
	}
	return { root, git };
}

describe("the doc-map gate, which spells itself out", () => {
	it("supplies exactly the scripts the gate under test invokes", () => {
		expectFixtureSupplies(DOC_MAP_ANCHOR, DOC_MAP_CHECKERS);
	});

	// mantahostels#2902's reproduction: `git rm --cached docs/doc-map.md`.
	it("refuses the commit as a deletion, before the checker runs", () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
			deleted: [MAP],
		});

		const { code, output } = runGate(root, docMapGate());
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
		expect(output).not.toContain(STUB_MARKER);
	});

	// The map renamed OUT of docs/ — the case this gate's `^docs/` arming grep
	// could not see at all until it took --no-renames (mantahostels#2903).
	it("refuses when the map is renamed out of docs/, naming it as deleted, before the checker runs", () => {
		const { root, git } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
		});
		git("mv", MAP, "elsewhere.md");

		const { code, output } = runGate(root, docMapGate());
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
		expect(output).toContain(MAP);
		expect(output).not.toContain(STUB_MARKER);
	});

	it("names the deleted file and the way through", () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
			deleted: [MAP],
		});

		const { output } = runGate(root, docMapGate());
		expect(output).toContain(MAP);
		expect(output).toContain("git checkout HEAD --");
		expect(output).toContain(`${ESCAPE}=1`);
		expect(output).toContain("the doc-map check reads");
	});

	it("lets the deletion through when the escape is set", () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
			deleted: [MAP],
		});

		const { code, output } = runGate(root, docMapGate(), { [ESCAPE]: "1" });
		expect(code).toBe(0);
		expect(output).toContain(`${ESCAPE} is set`);
		expect(output).toContain("skipped the doc-map check");
		expect(output).not.toContain(STUB_MARKER);
	});

	/*
	 * mantahostels#2902's second acceptance criterion. This gate's `dm_readable=0` has TWO
	 * causes, and neither may refuse: the file test failing (below), and
	 * `checkout-index` failing outright ("skips and passes when checkout-index
	 * fails on a missing blob", below).
	 *
	 * THIS CASE COVERS THE FILE TEST ALONE — another docs/ path arms the gate,
	 * `checkout-index` succeeds, and the map it was asked for was never in the
	 * index.
	 */
	it("skips and passes when the map was never in the index", () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { "docs/other.md": "x\n" },
			staged: { "docs/other.md": "x edited\n" },
		});

		const { code, output } = runGate(root, docMapGate());
		expect(code).toBe(0);
		expect(output).toContain("skipped the doc-map check");
		expect(output).not.toContain("DELETES");
	});

	// The OTHER cause: mantahostels#2902's second acceptance criterion, fixture at mantahostels#2911.
	it("skips and passes when checkout-index fails on a missing blob", () => {
		const { root } = badBlobMap();

		const { code, output } = runGate(root, docMapGate());
		expect(code).toBe(0);
		expect(output).toContain("skipped the doc-map check");
		expect(output).not.toContain("DELETES");
	});

	// The whole hook stack runs on `git merge` here, so a resolution must not be
	// read as a deletion: an unmerged path has no stage-0 blob either.
	it("skips and passes on an unmerged map mid-conflict", () => {
		const { root } = conflictedMap();

		const { code, output } = runGate(root, docMapGate());
		expect(code).toBe(0);
		expect(output).toContain("skipped the doc-map check");
		expect(output).not.toContain("DELETES");
	});

	it("runs the checker normally when nothing is deleted", () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
			staged: { [MAP]: "map edited\n" },
		});

		const { output } = runGate(root, docMapGate());
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("DELETES");
	});

	// The gate's own call, not the library's: a fix landing only in
	// precommit-gate.sh passes every case above this one and fails this.
	it("stops refusing when the gate's deletion question is dropped", () => {
		const original = docMapGate();
		const mutant = original.replace(
			/ {4}if ! gate_stage_out "\$dm_dir" docs\/doc-map\.md; then\n {6}gate_check_deleted doc-map\n {4}fi\n/,
			"",
		);
		expect(mutant, "the doc-map deletion question no longer parses").not.toBe(
			original,
		);
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
			deleted: [MAP],
		});

		expect(runGate(root, mutant).code).toBe(0);
	});

	// Isolates the OTHER cause (mantahostels#2911): a fix reached only through the file
	// test at `[ -f … ]` leaves `checkout-index` itself unguarded. This mutant
	// aborts the hook on the exit status the not-readable limb exists to warn
	// and pass on instead — it fails only this case, never the sibling "never
	// in the index" one, where `checkout-index` succeeds trivially.
	it("stops warning and passing when checkout-index's own failure is unguarded", () => {
		const original = docMapGate();
		const mutant = original.replace(
			'git checkout-index -a --prefix="$dm_dir/tree/" 2>/dev/null || dm_readable=0',
			'git checkout-index -a --prefix="$dm_dir/tree/" 2>/dev/null || exit 1',
		);
		expect(mutant, "the checkout-index call no longer parses").not.toBe(
			original,
		);

		expect(runGate(badBlobMap().root, mutant).code).toBe(1);
	});
});

/*
 * The rename hole, closed across every gate at once (mantahostels#2903).
 *
 * A rename is the same loss as a deletion for every reader resolving a document
 * by literal path — pick-next, manual-sync, CLAUDE.md §Ground truth,
 * docs/doc-map.md §A — and the gates exist to make that loud. The property is
 * then asserted structurally, so a gate added later arming off a read of its
 * own fails here rather than going quietly unarmed.
 */
describe("a rename of a gated document", () => {
	it("refuses when the superseded gate's map is renamed, naming the map and the check that reads it, before the checker runs", () => {
		const { root, git } = fixture({
			checkers: SUPERSEDED_CHECKERS,
			committed: { [MAP]: "map\n", [NEEDLES]: "{}\n" },
		});
		git("mv", MAP, "elsewhere.md");

		const { code, output } = runGate(root, supersededGate());
		expect(code).toBe(1);
		expect(output).toContain("the superseded-needle check reads");
		expect(output).toContain(MAP);
		expect(output).not.toContain(STUB_MARKER);
	});

	/*
	 * Every gate arms through precommit-gate.sh's `armed`, whose one read takes
	 * --no-renames (#1483, #1504).
	 */
	// Every spelling that lists the index: `diff --cached`, its `--staged`
	// alias, `diff-index --cached` and `ls-files`.
	const IndexRead =
		/\bgit (?:-\S+ )*(?:diff(?:-index)?\b[^\n]*--(?:cached|staged)|ls-files)\b/;
	const rawReads = (text: string) =>
		text
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#") && IndexRead.test(l));

	it("holds no raw read of the index in .husky/pre-commit (#1504)", () => {
		expect(rawReads(HOOK)).toEqual([]);
	});

	// The paired negative (mantahostels#2071's shape): the scan must actually bite.
	it.each([
		"git diff --cached --name-only",
		"git diff --staged --name-only",
		"git diff-index --cached --name-only HEAD",
		"git ls-files",
	])("reports a raw `%s` put back into the hook", (read) => {
		const gate = "if armed '^app/'; then";
		expect(HOOK).toContain(gate);
		const mutant = HOOK.replace(gate, `if ${read} | grep -q '^app/'; then`);
		expect(rawReads(mutant)).toHaveLength(1);
	});
});
