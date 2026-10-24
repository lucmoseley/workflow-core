// @vitest-environment node
/*
 * The pre-commit doc-map gate (mantahostels#390), exercised as the shell it actually is.
 *
 * `.husky/pre-commit` calls `check-doc-map.js` only when the commit touches the
 * map's own scope, holds its output, and replays it on failure — plus, on a
 * green run, five blocks alone: the untracked-entry one, which since mantahostels#1300
 * refuses the commit where the row it names is one that commit ADDS, its
 * Section C twin, and the three WARN blocks `dm_replay_warn` prints.
 *
 * `check-doc-map.js` is stubbed in each fixture so both exit codes can be
 * driven. Every case naming `the real checker` runs it, as do `a pointer count
 * disagreeing with its sidecar` and `a hand-edited Section A row`, which run
 * the real `checker-new-faults.js` too: a stub can show neither that the hook
 * and the checker agree on the wording and the block shape the slice cuts on,
 * nor that the direction comparison refuses what it is meant to.
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a commit leaving
 * `docs/doc-map.md` unregistered, dangling or hand-edited lands unrefused, and
 * the authority map every session checks before an edit stops telling the truth.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	syntheticDocMap as buildDocMap,
	emptyDataFile,
	registerRow,
	sidecarEntry,
	syntheticSidecar,
	writeSidecar,
} from "./lib/doc-map-testkit";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import {
	armingPattern,
	cutGateScript,
	expectFixtureSupplies,
	gateHead,
	registerTempCleanup,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import {
	coreCall,
	HOOK,
	ROOT,
	writeCheckerDelegates,
} from "./lib/precommit-gate-testkit";

const CHECKER = "scripts/check-doc-map.js";

const { trackedFiles } =
	require("./lib/doc-map") as typeof import("./lib/doc-map");

/*
 * The bare repo is built once and copied (scripts/lib/git-fixture.ts), not
 * `git init` afresh per call. Fixtures with the default seed commit use
 * seededRepoTemplate below; the customised minority build on this one.
 *
 * Deliberately NOT `./lib/precommit-gate-harness`'s own `newRepo` (mantahostels#953): that
 * function is imported by eleven other gate suites this ticket (mantahostels#2079) does
 * not cover, and this file no longer imports it.
 */
const bareRepoTemplate = defineTemplate((root) => {
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	// A repo-local identity: a machine with no global `user.email` cannot
	// commit at all (matching precommit-gate-harness.js's own newRepo).
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
});

/** As precommit-gate-harness.js's own `newRepo`, but the bare repo comes from
 * the template above instead of a fresh `git init`. */
function newRepo(prefix: string, tempDirs: string[]): TempRepo {
	const root = mkScratchDir(prefix);
	tempDirs.push(root);
	try {
		bareRepoTemplate.instantiate(root);
	} catch (err) {
		fs.rmSync(root, { recursive: true, force: true });
		throw err;
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	return { root, git };
}

/*
 * mantahostels#2200's own template, one layer past bareRepoTemplate: a repo already
 * carrying `fixture()`'s DEFAULT seed commit — seed.txt plus all seven
 * DOC_MAP_FILES at their generic committed content. 25 of this file's 37
 * fixture() calls pass none of `docMapFiles`/`docMapInHead`/`headMap`, so for
 * those the seed commit's tree is IDENTICAL call to call and is worth
 * pre-building once. The checker itself (scripts/check-doc-map.js) is
 * deliberately absent from this commit: .husky/pre-commit's `dm_` block
 * invokes it as `node scripts/check-doc-map.js` off the WORKTREE (lines
 * ~270-311), never through git — only docs/ goes through `checkout-index` —
 * so its tracked status never enters the gate's behaviour. It stays a
 * per-call worktree write.
 */
const seededRepoTemplate = defineTemplate((root) => {
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
	fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	for (const name of DOC_MAP_FILES)
		fs.writeFileSync(path.join(root, "docs", name), `committed ${name}\n`);
	execFileSync("git", ["add", "--", "seed.txt", "docs"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
});

/** As `newRepo`, but from `seededRepoTemplate` — for a `fixture()` call whose
 * seed commit is the default shape. */
function newSeededRepo(tempDirs: string[]): TempRepo {
	const root = mkScratchDir("doc-map-gate-");
	tempDirs.push(root);
	try {
		seededRepoTemplate.instantiate(root);
	} catch (err) {
		fs.rmSync(root, { recursive: true, force: true });
		throw err;
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	return { root, git };
}

/** The map, its five data files and the class sidecar — what a fixture repo
 * carries under docs/ (mantahostels#1849 added the sidecar, the coverage register). Since
 * mantahostels#1922 the gate names none of them: it extracts the whole index and points the
 * checker at it with --root, so this list is the FIXTURES' and not the hook's. */
const DOC_MAP_FILES = [
	"doc-map.md",
	"doc-map-restatements.json",
	"doc-map-superseded.json",
	"doc-map-retired-vocabulary.json",
	"doc-map-restatement-allowlist.json",
	"doc-map-high-water.json",
	"doc-map-classes.json",
];

const gateFragment = () => cutGateScript(CHECKER);

/**
 * The two awk markers the hook hands `dm_gate_untracked`, in call order: the
 * Section A block first, the Section C route block second. A slice run outside
 * the hook has to supply the same one, or `$0 ~ ""` matches every line.
 */
const gateMarkers = () =>
	[...gateFragment().matchAll(/dm_gate_untracked \\\n {6}'([^']*)'/g)].map(
		(m) => m[1],
	);

/**
 * The awk markers the hook hands `dm_replay_warn`, in call order: assertion
 * 22's growth block first, assertion 23's malformed-marker block second,
 * assertion 24's dropped-marker block third. `replayAwkArgs` indexes them
 * positionally, so a new block goes on the END of the hook's call list.
 */
const replayMarkers = () =>
	[...gateFragment().matchAll(/dm_replay_warn '([^']*)'/g)].map((m) => m[1]);

/** `awkArgs`'s half for `dm_replay_warn`, whose awk takes its marker as `$1`. */
const replayAwkArgs = (which: number) => {
	const awk = /\| awk -v m="\$1" '\n([\s\S]*?)\n\t\t' \|\| true/.exec(
		gateFragment(),
	);
	expect(awk, "the replay awk no longer parses out of the hook").toBeTruthy();
	const markers = replayMarkers();
	expect(markers.length, "the gate's replay markers no longer parse").toBe(3);
	return ["-v", `m=${markers[which]}`, (awk as RegExpExecArray)[1]];
};

const awkArgs = (awk: RegExpExecArray, which: number) => {
	const markers = gateMarkers();
	expect(markers.length, "the gate's awk markers no longer parse").toBe(2);
	return ["-v", `m=${markers[which]}`, awk[1]];
};

/**
 * How the hook's grep alternation differs from `SCOPE` in lib/doc-map.js, or
 * `null` where they agree. The two are separate spellings of one list — a
 * new SCOPE member would otherwise leave the gate silently not covering it.
 */
function parityGap(
	fragment: string,
	checker: string = fs.readFileSync(
		path.join(ROOT, "scripts", "lib", "doc-map.js"),
		"utf8",
	),
	tracked: string[] = trackedFiles(),
): string | null {
	const decl = /const SCOPE = \[([^\]]*)\]/.exec(checker);
	if (!decl) return "SCOPE no longer parses out of lib/doc-map.js";
	const scope = [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	if (scope.length === 0) return "SCOPE parsed empty";

	// The arming pattern's own alternation: `^(a|b|c)`.
	const pattern = /^\^\(([^)]*)\)$/.exec(armingPattern(CHECKER, fragment));
	if (!pattern)
		return "the gate's arming pattern is no longer one `^(…)` group";

	// A directory member is spelled `docs/`, a root file `AGENTS\.md$`. SCOPE
	// matches both shapes for every member (inScope), so directory-ness comes
	// from the tracked tree: a member with tracked files under it is a directory.
	// A member absent from the tree is spelled as a file.
	const isDir = (m: string) => tracked.some((f) => f.startsWith(`${m}/`));
	const spelled = scope
		.map((m) =>
			isDir(m)
				? `${m.replaceAll(".", "\\.")}/`
				: `${m.replaceAll(".", "\\.")}$`,
		)
		.sort();
	const alternatives = pattern[1].split("|").sort();

	return JSON.stringify(alternatives) === JSON.stringify(spelled)
		? null
		: `hook matches ${JSON.stringify(alternatives)}, SCOPE is ${JSON.stringify(spelled)}`;
}

const temps = registerTempCleanup();

/** The one docs/research register entry the untracked-block case models its
 * injected row on. Never read from disk. */
const RESEARCH_PATH = "docs/research/synthetic-model.md";

/**
 * A self-contained doc-map.md carrying everything the two "cuts the real
 * checker's ... block" cases need: a `docs/research/...` register-list entry
 * the untracked-block case models its injected row on, and a §B entry with no
 * valid marker for the malformed-marker case to inject a near miss beside.
 */
const syntheticDocMap = () =>
	buildDocMap({
		head: ["# Doc map", "", "v1.0 · 17 September 2026", ""],
		sectionA: "## Section A — authority register",
		subsections: [
			{ heading: "Research runs", list: [RESEARCH_PATH] },
			{
				heading: "Docs",
				rows: [
					registerRow("docs/doc-map.md", "the map", "source-of-truth"),
					...DOC_MAP_FILES.filter((n) => n !== "doc-map.md").map((n) =>
						registerRow(`docs/${n}`, "a sidecar", "generated-only"),
					),
				],
			},
		],
		after: [
			"## Section B — figure registry",
			"",
			"### B1 · A figure with no marker yet",
			"",
			"Prose only — no `**Over cap by ruling (#N):**` bullet below it, so this",
			"is the entry the malformed-marker case injects its near miss beside.",
			"",
		],
	});

const syntheticDocMapSidecar = () =>
	syntheticSidecar(
		["docs/doc-map.md", RESEARCH_PATH, "docs/doc-map-classes.json"].concat(
			DOC_MAP_FILES.filter(
				(n) => n !== "doc-map.md" && n !== "doc-map-classes.json",
			).map((n) => `docs/${n}`),
		),
		(p) =>
			p === RESEARCH_PATH
				? sidecarEntry({ section: "Research runs" })
				: sidecarEntry({ class: "source-of-truth" }),
	);

/**
 * A temp directory holding a synthetic doc-map's sidecars, plus its map as text
 * for the caller to edit and write in beside them. Built entirely in-test
 * rather than read off HEAD or the worktree — the real docs/doc-map.md no
 * longer exists (#16), and the checker cares only that the map and its
 * sidecars are well-formed, not that they are THIS host's real ones.
 */
const syntheticDocMapDir = (prefix: string): { dir: string; map: string } => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	for (const name of DOC_MAP_FILES.filter(
		(n) =>
			n !== "doc-map.md" &&
			n !== "doc-map-classes.json" &&
			n !== "doc-map-restatements.json",
	))
		fs.writeFileSync(path.join(dir, name), emptyDataFile(name));
	// loadRestatements refuses an empty register (`holds no entries`), so §B1
	// needs at least one pointer — matching its own "A figure" heading in name
	// only; the two cases here read neither the count nor the restated paths.
	fs.writeFileSync(
		path.join(dir, "doc-map-restatements.json"),
		JSON.stringify({ B1: { paths: [{ path: "docs/doc-map.md" }] } }),
	);
	writeSidecar(
		path.join(dir, "doc-map-classes.json"),
		syntheticDocMapSidecar(),
	);
	return { dir, map: syntheticDocMap() };
};

const STUB_MARKER = "STUB-CHECK-RAN";

/** Where the stub records what each invocation was handed, one line per call. */
const CALL_LOG = "stub-calls.log";

/*
 * Shaped as check-doc-map.js's reportFault prints it: message, indented items, a
 * blank line, one advice line — then the long report-only section the hold
 * suppresses.
 */
const UNTRACKED_ENTRIES = [
	"docs/research/machine-binding-constraints.md",
	"docs/research/artefact-family-costs.md",
];

const UNTRACKED_REPORT = [
	"2 doc-map register entr(ies) name a file present on disk but not yet tracked by git:",
	...UNTRACKED_ENTRIES.map((e) => `  ${e}`),
	"",
	"Likely mid-ticket: the register edit and the file's own commit are separate steps.",
	"",
	"Files no Section C route reaches:",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

/** Assertion 22's WARN block, in reportFault's shape (mantahostels#2050). */
const GREW_REPORT = [
	"1 §B entr(ies) marked over cap by ruling grew in this commit:",
	"  B223 — 379 → 402 prose words, +23, marked exempt by #1911",
	"",
	"Pay for the addition inside the same entry: cut surplus wording until the entry is no larger than it was.",
	"",
	"Files no Section C route reaches:",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

/**
 * Assertion 23's WARN block (mantahostels#2124), quoting check-doc-map.js's own wording.
 *
 * The real checker prints the route section BEFORE this block; here it follows,
 * as it does in the two fixtures above, because what the `block alone` case
 * needs is a line past the advice for the slice to stop short of.
 */
const MALFORMED_REPORT = [
	"1 §B line(s) look like an over-cap marker but do not parse as one:",
	"  B1 — - **Over cap by ruling (#2124)** the colon sits outside the bold",
	"",
	"Respell the bullet exactly `- **Over cap by ruling (#n):**` — a top-level bullet, the whole leader bold, the colon INSIDE the bold, and a bare issue number after the `#`. Where the line is prose rather than an attempted marker, reword its opening so it does not read as one.",
	"",
	"Reached by no Section C route (261 of 340 in-scope files, not a failure):",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

/** A green run whose held report carries assertion 23's block. */
const malformedFixture = () =>
	fixture({
		staged: { "docs/doc-map.md": "x\n" },
		checkerExit: 0,
		checkerStdout: MALFORMED_REPORT,
	});

/**
 * Assertion 24's WARN block (mantahostels#2227), quoting check-doc-map.js's own wording.
 * The section after it is what the `block alone` case slices up to.
 */
const DROPPED_REPORT = [
	"1 over-cap §B entr(ies) lost the marker the baseline carried:",
	"  B223 — 402 prose words, marked exempt by #1911 until this commit",
	"",
	"Deleted by accident? Put the `- **Over cap by ruling (#n):**` bullet back.",
	"",
	"Reached by no Section C route (261 of 340 in-scope files, not a failure):",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

const droppedFixture = () =>
	fixture({
		staged: { "docs/doc-map.md": "x\n" },
		checkerExit: 0,
		checkerStdout: DROPPED_REPORT,
	});

const sectionARow = (entry: string) =>
	`| \`${entry}\` | a note | \`reference\` |`;

/**
 * The report above, over a HEAD map carrying `inherited` as Section A rows.
 * Whatever is left out is a row this commit adds, which the gate refuses.
 */
const untrackedFixture = (inherited: string[] = UNTRACKED_ENTRIES) =>
	fixture({
		staged: { "docs/research/note.md": "x\n" },
		checkerExit: 0,
		checkerStdout: UNTRACKED_REPORT,
		// A header line always, so an empty `inherited` is still a readable map:
		// an EMPTY one is the fail-open case.
		headMap: ["# Section A", ...inherited.map(sectionARow)].join("\n"),
	});

/**
 * The Section C half, added at mantahostels#1403 (the ticket that softened a route pointing
 * at an uncommitted file): a route whose target is on disk but not yet
 * committed.
 */
const UNTRACKED_ROUTES = [
	{ id: "C36", path: "docs/production-runbook.md" },
	{ id: "C37", path: "docs/release-strategy.md" },
];

const UNTRACKED_ROUTE_REPORT = [
	"2 Section C route path(s) in /tmp/staged/doc-map.md name a file present on disk but not yet tracked by git:",
	...UNTRACKED_ROUTES.map((r) => `  ${r.id} \u2192 ${r.path}`),
	"",
	"Likely mid-ticket: the route and the file it sends the reader to are separate steps.",
	"",
	"Files no Section C route reaches:",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

/**
 * As untrackedFixture, over a HEAD map carrying `inherited` as Section C route
 * lines, ids deliberately absent.
 */
const routeFixture = (
	inherited: string[] = UNTRACKED_ROUTES.map((r) => r.path),
) =>
	fixture({
		staged: { "docs/research/note.md": "x\n" },
		checkerExit: 0,
		checkerStdout: UNTRACKED_ROUTE_REPORT,
		headMap: [
			"# Section C",
			...inherited.map((p) => `- **Read:** \`${p}\``),
		].join("\n"),
	});

interface FixtureOpts {
	staged: Record<string, string>;
	checkerExit: number;
	/** Which of DOC_MAP_FILES the fixture repo carries; all seven by default. */
	docMapFiles?: string[];
	/**
	 * Whether those files are COMMITTED or only staged. Staged alone, the gate
	 * reads them from the index but finds no HEAD baseline to compare against —
	 * the fail-closed limb (mantahostels#1793). Committed by default.
	 */
	docMapInHead?: boolean;
	/** Replaces the stub's whole report, for cases that read its text. */
	checkerStdout?: string;
	/** Replaces the COMMITTED docs/doc-map.md, which the new-row gate reads from HEAD. */
	headMap?: string;
	/**
	 * The direction gate's verdict (mantahostels#1688): 1 = this commit ADDS the faults and
	 * the commit is refused, 0 = every fault is inherited and it passes, 2 = the
	 * comparison could not answer and the gate fails closed.
	 *
	 * Defaults to 1, which is what every case predating the direction gate
	 * expects: a failing checker refused the commit outright.
	 */
	newFaultsExit?: number;
	/** Replaces the direction gate's stdout, for cases that read what it names. */
	newFaultsStdout?: string;
}

/**
 * A git repo with one commit, plus a stubbed checker whose exit code is ours to
 * choose. `staged` is written and staged; nothing else is.
 */
function fixture(opts: FixtureOpts): string {
	/*
	 * mantahostels#2200: whether this call's seed commit is the template's fixed shape
	 * (seed.txt + all seven DOC_MAP_FILES, generic content) or has to be built
	 * by hand because docMapFiles/docMapInHead/headMap customise it.
	 */
	const usesDefaultSeed =
		opts.docMapFiles === undefined &&
		opts.docMapInHead !== false &&
		opts.headMap === undefined;
	const { root, git } = usesDefaultSeed
		? newSeededRepo(temps)
		: newRepo("doc-map-gate-", temps);

	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "scripts", "check-doc-map.js"),
		checkerStub(opts),
	);
	/*
	 * Stubbed for the same reason the checker is: the gate's direction test
	 * (mantahostels#1688) is a second process, and its three verdicts have to be drivable
	 * without building a real pair of --json envelopes per case.
	 *
	 * It refuses any profile but `doc-map` (mantahostels#1797, which merged the doc map's
	 * own front end into the shared profile table): the real script exits 2 on
	 * an unknown profile, so without this every case here would pass a gate
	 * whose profile argument the hook had misspelled.
	 */
	fs.writeFileSync(
		path.join(root, "scripts", "checker-new-faults.js"),
		`if (process.argv[2] !== "doc-map") {\n` +
			`  console.error("stub: profile " + process.argv[2]);\n` +
			"  process.exit(2);\n" +
			"}\n" +
			`console.log(${JSON.stringify(opts.newFaultsStdout ?? "dead: stub-new-fault.md")});\n` +
			`process.exit(${opts.newFaultsExit ?? 1});\n`,
	);
	if (!usesDefaultSeed) seedByHand(root, git, opts);
	// usesDefaultSeed: seededRepoTemplate already carries this exact commit —
	// seed.txt plus all seven DOC_MAP_FILES at their generic content — so
	// there is nothing left to write or commit here.

	for (const [rel, body] of Object.entries(opts.staged)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
		git("add", "--", rel);
	}
	return root;
}

/** The stub checker's source: a call recorder, or a fixed report. */
function checkerStub(opts: FixtureOpts): string {
	return opts.checkerStdout === undefined
		? `const fs = require("node:fs");\n` +
				`const root = process.argv[process.argv.indexOf("--root") + 1];\n` +
				// The baseline call's stdout goes to a file, so what it was handed
				// is recorded here instead — see CALL_LOG.
				`fs.appendFileSync(${JSON.stringify(CALL_LOG)}, (process.env.GIT_INDEX_FILE ?? "-") + " " + process.argv.slice(2).join(" ") + "\\n");\n` +
				`console.log("${STUB_MARKER}");\n` +
				`console.log(process.argv.slice(2).join(" "));\n` +
				`console.log(fs.readFileSync(root + "/docs/doc-map.md", "utf8"));\n` +
				`console.log("DIR:" + fs.readdirSync(root + "/docs").sort().join(","));\n` +
				`console.log(fs.readFileSync(root + "/docs/doc-map-high-water.json", "utf8"));\n` +
				`process.exit(${opts.checkerExit});\n`
		: `console.log(${JSON.stringify(opts.checkerStdout)});\n` +
				`process.exit(${opts.checkerExit});\n`;
}

/** The seed commit, built by hand where the options customise its docs. */
function seedByHand(root: string, git: TempRepo["git"], opts: FixtureOpts) {
	fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
	// The gate extracts the whole index and requires the MAP in it, so a
	// fixture without docs/doc-map.md only ever exercises the not-readable
	// warning.
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	const docMapPaths = (opts.docMapFiles ?? DOC_MAP_FILES).map(
		(n) => `docs/${n}`,
	);
	for (const name of opts.docMapFiles ?? DOC_MAP_FILES)
		fs.writeFileSync(
			path.join(root, "docs", name),
			name === "doc-map.md" && opts.headMap !== undefined
				? opts.headMap
				: `committed ${name}\n`,
		);
	git("add", "--", "seed.txt", "scripts/check-doc-map.js");
	if (opts.docMapInHead !== false && docMapPaths.length > 0)
		git("add", "--", ...docMapPaths);
	git("commit", "-qm", "seed");
	if (opts.docMapInHead === false && docMapPaths.length > 0)
		git("add", "--", ...docMapPaths);
}

/*
 * GITHUB_ACTIONS off for every child here. check.js writes its ::error:: and
 * ::warning:: annotations to stdout when it is set, so on a CI runner the
 * checker's report gains two lines the assertions below do not model — which is
 * what turned the untracked-block slice from 4 lines into 6.
 */
const NO_ANNOTATIONS = { ...process.env, GITHUB_ACTIONS: "" };

/*
 * spawnSync, not execFileSync: the gate's own warnings go to stderr, and
 * execFileSync returns stdout ALONE on a zero exit (mantahostels#1300).
 *
 * `-e` because husky runs the hook under `sh -e`, where an unconsumed non-zero
 * status aborts the file rather than falling through.
 */
function runGate(
	cwd: string,
	fragment: string = gateFragment(),
): { code: number; output: string } {
	const run = spawnSync("sh", ["-ec", fragment], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: NO_ANNOTATIONS,
	});
	return {
		code: run.status ?? 1,
		output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
	};
}

describe("the pre-commit doc-map gate", () => {
	it("is wired into .husky/pre-commit", () => {
		expect(HOOK).toContain(coreCall("node", "scripts/check-doc-map.js"));
	});

	it("supplies exactly the scripts the gate invokes", () => {
		expectFixtureSupplies(CHECKER, [CHECKER, "scripts/checker-new-faults.js"]);
	});

	it("covers exactly the SCOPE check-doc-map.js enforces", () => {
		expect(parityGap(gateFragment())).toBeNull();
	});

	it("reports a gap when the regex loses a SCOPE member", () => {
		expect(
			parityGap(gateFragment().replace("|CLAUDE\\.md$", "")),
		).not.toBeNull();
	});

	it("spells a new directory member of SCOPE as a directory (#17)", () => {
		const checker = 'const SCOPE = ["docs", ".claude", "scripts", "CLAUDE.md"]';
		const tracked = ["docs/a.md", ".claude/x", "scripts/b.js", "CLAUDE.md"];
		const gateArmedOn = (alts: string) =>
			`if armed '^(${alts})'; then\n\tnode ${CHECKER}\nfi`;
		expect(
			parityGap(
				gateArmedOn("docs/|\\.claude/|scripts/|CLAUDE\\.md$"),
				checker,
				tracked,
			),
		).toBeNull();
		expect(
			parityGap(
				gateArmedOn("docs/|\\.claude/|scripts$|CLAUDE\\.md$"),
				checker,
				tracked,
			),
		).not.toBeNull();
	});

	/* Asserted on the fragment, because every behavioural case below would also
	 * pass against a gate that had gone back to copying files by name. */
	it("extracts the whole index rather than naming files to stage out", () => {
		const fragment = gateFragment();
		expect(fragment).toContain("git checkout-index -a --prefix=");
		expect(fragment).not.toContain("dm_files=");
		expect(fragment).toContain('--root "$dm_dir/tree"');
	});

	// Each SCOPE member in scripts/lib/doc-map.js gets a case.
	for (const rel of [
		"docs/research/note.md",
		".claude/skills/x/SKILL.md",
		"AGENTS.md",
		"CLAUDE.md",
	]) {
		it(`runs the checker for a commit touching ${rel}`, () => {
			const repo = fixture({ staged: { [rel]: "x\n" }, checkerExit: 0 });

			expect(runGate(repo).code).toBe(0);
		});

		it(`fails the commit when the checker fails, for ${rel}`, () => {
			const repo = fixture({ staged: { [rel]: "x\n" }, checkerExit: 1 });

			const { code, output } = runGate(repo);
			expect(code).not.toBe(0);
			expect(output).toContain(STUB_MARKER);
		});
	}

	it("does not run the checker for a commit outside the map's scope", () => {
		const repo = fixture({
			staged: { "app/page.tsx": "x\n", "scripts/thing.js": "x\n" },
			// Exit 1, so a gate that wrongly ran it fails loudly.
			checkerExit: 1,
		});

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	// A path merely CONTAINING a scope name is not in scope: the regex is
	// anchored, so `my-docs/` and `x/CLAUDE.md` must not fire it.
	it("does not fire on a path that only resembles the scope", () => {
		const repo = fixture({
			staged: { "my-docs/a.md": "x\n", "vendor/CLAUDE.md": "x\n" },
			checkerExit: 1,
		});

		expect(runGate(repo).code).toBe(0);
	});

	/*
	 * Assertion 22's growth WARN (mantahostels#2050) exits 0, so without a replay the hold
	 * above swallows it — and the sweeps cannot substitute, running a clean
	 * checkout where no entry can read as grown.
	 */
	it("replays the growth block when the checker passes", () => {
		const repo = fixture({
			staged: { "docs/doc-map.md": "x\n" },
			checkerExit: 0,
			checkerStdout: GREW_REPORT,
		});

		const { code, output } = runGate(repo);
		// WARN-only by ruling: surfacing it must never start gating it.
		expect(code).toBe(0);
		expect(output).toContain("marked over cap by ruling grew in this commit:");
		expect(output).toContain("B223 — 379 → 402 prose words, +23");
		expect(output).toContain("Pay for the addition inside the same entry");
	});

	it("replays the growth block alone, not the report around it", () => {
		const repo = fixture({
			staged: { "docs/doc-map.md": "x\n" },
			checkerExit: 0,
			checkerStdout: GREW_REPORT,
		});

		expect(runGate(repo).output).not.toContain("unreached-noise.md");
	});

	it("says nothing about growth on a green run that reports none", () => {
		const repo = fixture({
			staged: { "docs/doc-map.md": "x\n" },
			checkerExit: 0,
			checkerStdout: "OK: doc map covers everything\n",
		});

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).not.toContain("marked over cap by ruling grew");
	});

	it("replays the malformed-marker block when the checker passes", () => {
		const repo = malformedFixture();

		const { code, output } = runGate(repo);
		// WARN-only by ruling, as assertion 22's is.
		expect(code).toBe(0);
		expect(output).toContain(
			"look like an over-cap marker but do not parse as one:",
		);
		expect(output).toContain("B1 — - **Over cap by ruling (#2124)**");
		expect(output).toContain("Respell the bullet exactly");
	});

	it("replays the malformed-marker block alone, not the report around it", () => {
		const repo = malformedFixture();

		expect(runGate(repo).output).not.toContain("unreached-noise.md");
	});

	/*
	 * Assertion 24's WARN (mantahostels#2227) is the ONLY notice a dropped marker ever gets:
	 * it compares against the parent, so the sweeps' clean checkout — where the
	 * map IS HEAD's — can never see one.
	 */
	it("replays the dropped-marker block when the checker passes", () => {
		const repo = droppedFixture();

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toContain("lost the marker the baseline carried:");
		expect(output).toContain("B223 — 402 prose words, marked exempt by #1911");
		expect(output).toContain("Deleted by accident?");
	});

	it("replays the dropped-marker block alone, not the report around it", () => {
		const repo = droppedFixture();

		expect(runGate(repo).output).not.toContain("unreached-noise.md");
	});

	it("says nothing about a dropped marker on a green run that reports none", () => {
		const repo = fixture({
			staged: { "docs/doc-map.md": "x\n" },
			checkerExit: 0,
			checkerStdout: "OK: doc map covers everything\n",
		});

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output.trim()).toBe("");
	});

	it("says nothing about a malformed marker on a green run that reports none", () => {
		const repo = fixture({
			staged: { "docs/doc-map.md": "x\n" },
			checkerExit: 0,
			checkerStdout: "OK: doc map covers everything\n",
		});

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		// The whole output, not the phrase alone: a marker blanked to `''`
		// matches every line, and would replay the OK line itself.
		expect(output.trim()).toBe("");
	});

	it("replays the untracked-entry block when the checker passes", () => {
		const repo = untrackedFixture();

		const { code, output } = runGate(repo);
		// Still WARN, per mantahostels#1193 — surfacing it must not start gating it.
		expect(code).toBe(0);
		expect(output).toContain("not yet tracked by git:");
		expect(output).toContain("docs/research/machine-binding-constraints.md");
		expect(output).toContain("docs/research/artefact-family-costs.md");
		expect(output).toContain("Likely mid-ticket:");
		expect(output).toContain(
			"DEAD, which FAILs there (mantahostels#1300, mantahostels#1403)",
		);
	});

	it("replays that block alone, not the report-only section around it", () => {
		const repo = untrackedFixture();

		const { output } = runGate(repo);
		expect(output).not.toContain("unreached-noise.md");
		expect(output).not.toContain("Files no Section C route reaches");
		expect(output).not.toContain("WARN: 0 doc-map problem(s)");
	});

	/*
	 * The half of mantahostels#1300 the replay above does not close: the session that ADDS
	 * the row is the one that can still fix it in the same commit.
	 */
	it("refuses a commit that adds a row for a file it does not contain, naming each row and offering to name the file in the pathspec as the way out", () => {
		const repo = untrackedFixture([]);

		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		for (const entry of UNTRACKED_ENTRIES) expect(output).toContain(entry);
		expect(output).toContain("and not the file(s) they name");
		expect(output).toContain("name the file in this commit's pathspec too");
	});

	it("only warns on a row HEAD's map already carried", () => {
		const repo = untrackedFixture();

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toContain("left as they are");
		expect(output).not.toContain("and not the file(s) they name");
	});

	it("names the added row alone when the other was inherited", () => {
		const repo = untrackedFixture([UNTRACKED_ENTRIES[0]]);

		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		// The refusal's own list, not the replayed report above it, which names both.
		const listed = output.slice(
			output.indexOf("and not the file(s) they name"),
		);
		expect(listed).toContain(UNTRACKED_ENTRIES[1]);
		expect(listed).not.toContain(UNTRACKED_ENTRIES[0]);
	});

	it("replays the untracked-route block when the checker passes", () => {
		const repo = routeFixture();

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toContain("C36 \u2192 docs/production-runbook.md");
		expect(output).toContain("C37 \u2192 docs/release-strategy.md");
		expect(output).toContain("Section C route(s) above reach");
		expect(output).not.toContain("unreached-noise.md");
	});

	it("refuses a commit that adds a route for a file it does not contain, offering to drop the route until it lands as the way out", () => {
		const repo = routeFixture([]);

		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		expect(output).toContain("and not the file(s) they name");
		expect(output).toContain("drop the route until it lands");
	});

	/* The discriminator: HEAD's map carries the paths and none of the route ids,
	 * so judging the whole "C36 \u2192 path" item would read every route as new and
	 * refuse the commit mantahostels#1403 exists to let through. */
	it("judges a route against HEAD by its path, never its id", () => {
		const repo = routeFixture();

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toContain("left as they are");
		expect(output).not.toContain("and not the file(s) they name");
	});

	it("names the added route alone when the other was inherited", () => {
		const repo = routeFixture([UNTRACKED_ROUTES[0].path]);

		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		const listed = output.slice(
			output.indexOf("and not the file(s) they name"),
		);
		expect(listed).toContain(UNTRACKED_ROUTES[1].path);
		expect(listed).not.toContain(UNTRACKED_ROUTES[0].path);
	});

	/* One report can hold both blocks. A single awk marker matching both would
	 * slice the first and judge the route items against Section A's wording. */
	it("replays both blocks when the report holds an entry and a route", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 0,
			checkerStdout: [UNTRACKED_REPORT, UNTRACKED_ROUTE_REPORT].join("\n"),
			headMap: [
				"# Section A",
				...UNTRACKED_ENTRIES.map(sectionARow),
				"# Section C",
				...UNTRACKED_ROUTES.map((r) => `- **Read:** \`${r.path}\``),
			].join("\n"),
		});

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toContain(UNTRACKED_ENTRIES[0]);
		expect(output).toContain("C36 \u2192 docs/production-runbook.md");
		expect(output).toContain("Section A row(s) above reach");
		expect(output).toContain("Section C route(s) above reach");
	});

	/* Fail-open: HEAD has no map to compare against, so nothing can be called
	 * new and the row keeps the WARN rather than blocking the commit that first
	 * adds the map. */
	it("warns without refusing when HEAD has no doc-map.md at all", () => {
		const repo = fixture({
			staged: {
				"docs/research/note.md": "x\n",
				"docs/doc-map.md": "first map\n",
			},
			checkerExit: 0,
			checkerStdout: UNTRACKED_REPORT,
			docMapFiles: DOC_MAP_FILES.filter((n) => n !== "doc-map.md"),
		});

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toContain("left as they are");
		expect(output).not.toContain("and not the file(s) they name");
	});

	/* Standards review of mantahostels#1300: a bare `||` would read grep's 127 as "absent
	 * from HEAD" for every entry and refuse every docs commit. Only a clean 1 is
	 * a new row, so a grep that cannot run leaves the WARN standing. */
	it("warns rather than refusing when grep itself cannot run", () => {
		const repo = untrackedFixture([]);

		const mutant = gateFragment().replace(
			'grep -qF -- "$dm_needle" || dm_rc=$?',
			"sh -c 'exit 127' || dm_rc=$?",
		);
		expect(mutant, "the grep call no longer parses out of the hook").not.toBe(
			gateFragment(),
		);
		const { code, output } = runGate(repo, mutant);
		expect(code).toBe(0);
		expect(output).toContain("left as they are");
		expect(output).not.toContain("and not the file(s) they name");
	});

	it("stays silent on a green run whose report holds no untracked entry", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 0,
			checkerStdout: [
				"Files no Section C route reaches:",
				"  docs/research/unreached-noise.md",
				"OK: doc map covers all 208 tracked files in scope",
			].join("\n"),
		});

		expect(runGate(repo).output.trim()).toBe("");
	});

	/*
	 * mantahostels#1300's slice is a contract between two files: the hook cuts on wording
	 * check-doc-map.js prints, and on the shape reportFault prints after it —
	 * the shape UNTRACKED_REPORT above models. Reword either, or wrap the advice
	 * onto a second line, and the replay silently stops reporting.
	 *
	 * So this case runs the REAL checker as a subprocess and feeds the REAL awk,
	 * cut out of the hook rather than retyped. The row is injected pointing at a
	 * scratch file made untracked-but-present for the length of the case.
	 */
	it("cuts the real checker's untracked block, wording and shape both", () => {
		const { dir, map } = syntheticDocMapDir("doc-map-slice-");

		// A dot-prefixed name under docs/research matches the scratch notes
		// already sitting there.
		const scratch = `docs/research/.slice-fixture-${process.pid}.md`;
		/*
		 * The model line is found through the SHIPPED parsers, not a private
		 * pattern: mantahostels#2743 moved the research runs from a §A table to a
		 * `register-list`, and this fixture's own idea of a row's shape did not
		 * follow, so it failed on `main` (mantahostels#2783). `parseRegister` supplies the
		 * paths §A actually registers — it alone knows the section bounds and
		 * skips the fenced examples — and the two line readers say which line
		 * carries one.
		 */
		const { parseRegister, registerListPath, registerRowPaths } =
			require("./lib/doc-map") as typeof import("./lib/doc-map");
		const registered = new Set(
			parseRegister(map).flatMap((r: { paths: string[] }) => r.paths),
		);
		const model = map.split("\n").find((l) => {
			const p = registerListPath(l) ?? registerRowPaths(l)[0];
			return !!p && p.startsWith("docs/research/") && registered.has(p);
		});
		expect(
			model,
			"no docs/research register entry to model the injected one on",
		).toBeTruthy();
		const injected = (model as string).replace(
			/`docs\/research\/[^`]+`/,
			`\`${scratch}\``,
		);
		fs.writeFileSync(
			path.join(dir, "doc-map.md"),
			map.replace(model as string, `${model}\n${injected}`),
		);

		fs.writeFileSync(path.join(ROOT, scratch), "scratch\n");
		let report: string;
		try {
			const run = spawnSync(
				"node",
				[
					"scripts/check-doc-map.js",
					path.join(dir, "doc-map.md"),
					"--data-dir",
					dir,
				],
				{
					cwd: ROOT,
					encoding: "utf8",
					maxBuffer: 32 * 1024 * 1024,
					env: NO_ANNOTATIONS,
				},
			);
			report = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		} finally {
			fs.rmSync(path.join(ROOT, scratch), { force: true });
		}
		expect(
			report,
			"the real checker did not raise the untracked entry",
		).toContain(scratch);

		const awk = /\| awk -v m="\$dm_marker" '\n([\s\S]*?)\n\t\t' \|\| true/.exec(
			gateFragment(),
		);
		expect(awk, "the slice awk no longer parses out of the hook").toBeTruthy();
		const sliced = spawnSync("awk", awkArgs(awk as RegExpExecArray, 0), {
			input: report,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		}).stdout;

		// Both halves, per §X3: the offending thing, and the way out.
		expect(sliced).toContain("not yet tracked by git:");
		expect(sliced).toContain(scratch);
		expect(sliced).toContain("Commit the file, or drop the entry");
		// And the entry comes back OUT of that slice: the refusal below compares
		// these paths against HEAD's map, so a change to reportFault's indent
		// would leave the gate with nothing to judge (mantahostels#1300).
		const sed = /\| sed -n '([^']*)' \|/.exec(gateFragment());
		expect(
			sed,
			"the entry strip no longer parses out of the hook",
		).toBeTruthy();
		expect(
			spawnSync("sed", ["-n", (sed as RegExpExecArray)[1]], {
				input: sliced,
				encoding: "utf8",
			}).stdout.trim(),
		).toBe(scratch);
		// And nothing past the advice line — the report-only section stays held.
		expect(sliced).not.toContain("Section C route");
		expect(sliced.trimEnd().split("\n").length).toBe(4);

		// The mutation, run on the real bytes rather than by editing the checker:
		// reword its heading and the slice goes silent.
		const reworded = spawnSync("awk", awkArgs(awk as RegExpExecArray, 0), {
			input: report.replace(
				"not yet tracked by git:",
				"not yet tracked by git —",
			),
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		}).stdout;
		expect(reworded.trim()).toBe("");
	});

	/*
	 * The untracked slice's contract, for assertion 23's marker (mantahostels#2124, mantahostels#2268).
	 * The fault is a line in the map itself, so this one needs no scratch file.
	 *
	 * The message the marker anchors on is built by concatenation in
	 * check-doc-map.js, so only the joined form can be sliced.
	 */
	it("cuts the real checker's malformed-marker block, wording and shape both", () => {
		const { dir, map } = syntheticDocMapDir("doc-map-marker-");

		// The first §B entry carrying no valid marker: one that already carries
		// one is outside assertion 23 by construction.
		const entries = map.split(/^### (?=B\d+ )/m).slice(1);
		const target = entries.find(
			(e) => !/^[-*]\s+\*\*Over cap by ruling \(#\d+\):\*\*/m.test(e),
		);
		expect(
			target,
			"no unmarked §B entry to inject the near miss into",
		).toBeTruthy();
		const heading = `### ${(target as string).split("\n")[0]}`;
		const id = /B\d+/.exec(heading)?.[0] as string;
		const nearMiss =
			"- **Over cap by ruling (#2124)** the colon sits outside the bold";
		fs.writeFileSync(
			path.join(dir, "doc-map.md"),
			map.replace(heading, `${heading}\n\n${nearMiss}`),
		);

		const run = spawnSync(
			"node",
			[
				"scripts/check-doc-map.js",
				path.join(dir, "doc-map.md"),
				"--data-dir",
				dir,
			],
			{
				cwd: ROOT,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
				env: NO_ANNOTATIONS,
			},
		);
		const report = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		expect(
			report,
			"the real checker did not raise the malformed marker",
		).toContain("do not parse as one:");

		const cut = (input: string) =>
			spawnSync("awk", replayAwkArgs(1), {
				input,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
			}).stdout;
		const sliced = cut(report);

		// Both halves, per §X3: the offending line, and the way out.
		expect(sliced).toContain("do not parse as one:");
		expect(sliced).toContain(`${id} — ${nearMiss}`);
		expect(sliced).toContain("Respell the bullet exactly");
		// And nothing past the advice line: message, item, blank, advice.
		expect(sliced.trimEnd().split("\n").length).toBe(4);

		// The mutation, run on the real bytes rather than by editing the checker:
		// reword the heading's tail and the anchored slice goes silent.
		expect(
			cut(
				report.replace("do not parse as one:", "do not parse as one —"),
			).trim(),
		).toBe("");
	});

	/*
	 * The replay markers are literal strings in TWO files, and the tests above
	 * feed the awk a fixture rather than the checker, so a reworded `msg` leaves
	 * them green and the block goes mute. Assertions 22 and 24 cannot be driven the way
	 * assertion 23 is above, both needing a git baseline the tmp-dir fixture has
	 * no HEAD for, so this pins the coupling statically instead.
	 *
	 * The checker builds each message by concatenation, so the source is joined
	 * before matching. `$` is the awk anchor, not part of the message.
	 */
	it("anchors every replay marker on wording the checker still emits", () => {
		const checker = fs
			.readFileSync(path.join(ROOT, "scripts", "check-doc-map.js"), "utf8")
			.replace(/["`]\s*\+\s*\n?\s*["`]/g, "");
		const markers = replayMarkers();
		expect(markers.length).toBe(3);
		for (const marker of markers)
			expect(checker, `no check-doc-map.js message emits ${marker}`).toContain(
				marker.replace(/\$$/, ""),
			);
	});

	it("prints nothing when the checker passes", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 0,
		});

		const { output } = runGate(repo);
		expect(output).not.toContain(STUB_MARKER);
		expect(output.trim()).toBe("");
	});

	// mantahostels#1191 (the ticket that fed this gate from the index, not the worktree).
	it("hands the checker the INDEX's map, not the worktree's", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});
		fs.writeFileSync(
			path.join(repo, "docs", "doc-map.md"),
			"dirty worktree map\n",
		);

		const { output } = runGate(repo);
		expect(output).toContain("committed doc-map.md");
		expect(output).not.toContain("dirty worktree map");
	});

	// The deadlock mantahostels#1191 records: the map and a sidecar dirty together, in the
	// state where the pair on disk disagrees. The checker must see the committed
	// pair, so both files' contents are asserted, not just the exit.
	it("judges a dirty map and sidecar by their committed pair", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});
		for (const name of ["doc-map.md", "doc-map-high-water.json"])
			fs.writeFileSync(path.join(repo, "docs", name), "half-written\n");

		const { output } = runGate(repo);
		expect(output).toContain("committed doc-map.md");
		expect(output).toContain("committed doc-map-high-water.json");
		expect(output).not.toContain("half-written");
	});

	/* Not a named list any more (mantahostels#1922): the sidecars arrive because the WHOLE
	 * index does, which `research` — a directory no version of the copy loop
	 * would have carried — is what proves. */
	it("hands the checker the commit's whole docs/, not seven named files", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		// The stub lists the tree's docs/, since the gate deletes it before the
		// case can look.
		const listed = /DIR:(\S*)/.exec(runGate(repo).output)?.[1];
		expect(listed?.split(",").sort()).toEqual(
			[...DOC_MAP_FILES, "research"].sort(),
		);
	});

	/* The old gate copied seven named blobs and warned-and-passed when one would
	 * not read (mantahostels#1922); with the whole index extracted
	 * there is no per-file apparatus failure left, so a data file genuinely
	 * absent from the index is a repo fault and reaches the checker as one. */
	it("reaches the checker when a data file is missing from the index", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			docMapFiles: DOC_MAP_FILES.filter((n) => n !== "doc-map-high-water.json"),
		});

		const { code, output } = runGate(repo, gateFragment());
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("skipped the doc-map check");
		expect(code).not.toBe(0);
	});

	/* Provoked on the fragment: nothing a fixture can arrange makes
	 * `git checkout-index` fail. */
	it("skips with a warning when the index will not extract", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		const mutant = gateFragment().replace(
			'git checkout-index -a --prefix="$dm_dir/tree/" 2>/dev/null',
			"false",
		);
		const { code, output } = runGate(repo, mutant);
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
		expect(output).toContain("skipped the doc-map check");
	});

	// BROKEN (2) and FAIL (1) stay distinguishable, as in the digest-version gate.
	it("propagates the checker's own exit code", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 2,
		});

		const { code, output } = runGate(repo);
		// A structural pin: exact code 2 proves BROKEN survives distinct from a
		// fault (1), not merely non-zero.
		expect(code).toBe(2);
		expect(output).toContain(STUB_MARKER);
	});

	/* Half-staging the map does not skip the gate — the reason is in
	 * .husky/pre-commit, above its skip branch (mantahostels#1202). */
	it("still runs the checker when only the map of the seven is staged", () => {
		const repo = fixture({
			staged: { "docs/doc-map.md": "edited doc-map\n" },
			checkerExit: 1,
		});

		const { output } = runGate(repo);
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("skipped the doc-map check");
		expect(output).toContain(`DIR:${DOC_MAP_FILES.slice().sort().join(",")}`);
		// The staged blob, not HEAD's, for the one file this commit does stage.
		expect(output).toContain("edited doc-map");
	});

	it("fires on a deletion", () => {
		const repo = fixture({ staged: {}, checkerExit: 1 });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, "docs", "gone.md"), "x\n");
		git("add", "--", "docs/gone.md");
		git("commit", "-qm", "add doc");
		git("rm", "-q", "--", "docs/gone.md");

		const { code, output } = runGate(repo);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});
});

/*
 * The direction gate (mantahostels#1688). A checker failure alone no longer refuses: the
 * hook asks whether HEAD already had those faults, and only refuses the ones
 * this commit adds.
 */
describe("the gate refuses only faults this commit adds", () => {
	const failing = (over: Partial<Parameters<typeof fixture>[0]> = {}) =>
		fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			...over,
		});

	it("passes a failing check whose every fault is already in HEAD", () => {
		const { code, output } = runGate(failing({ newFaultsExit: 0 }));

		expect(code).toBe(0);
		expect(output).toContain(
			"every FAIL finding the doc-map check reported above is already in HEAD",
		);
	});

	it("still replays the checker's report when it passes on inheritance", () => {
		// Silence would hide a red main from the one person able to repair it.
		expect(runGate(failing({ newFaultsExit: 0 })).output).toContain(
			STUB_MARKER,
		);
	});

	it("refuses a fault absent from HEAD, and names it", () => {
		const { code, output } = runGate(
			failing({ newFaultsStdout: "dead: docs/research/brand-new.md" }),
		);

		expect(code).toBe(1);
		expect(output).toContain("docs/research/brand-new.md");
		expect(output).toContain("NOT in HEAD");
	});

	it("fails closed when the comparison cannot answer", () => {
		const { code, output } = runGate(
			failing({ newFaultsExit: 2, newFaultsStdout: "envelope unreadable" }),
		);

		expect(code).toBe(1);
		expect(output).toContain("could not tell inherited doc-map faults");
	});

	/* End to end, over the real crash rather than a driven exit code: node exits
	 * 1 on a missing module, which the gate once read as a clean "this commit
	 * added these" and printed the MODULE_NOT_FOUND trace as the fault list
	 * (mantahostels#2026). */
	it("says the comparison could not run when its script is gone, blaming the commit for nothing", () => {
		const root = failing();
		fs.rmSync(path.join(root, "scripts", "checker-new-faults.js"));

		const { code, output } = runGate(root);

		expect(code).toBe(1);
		expect(output).toContain("could not tell inherited doc-map faults");
		expect(output).not.toContain("NOT in HEAD");
		expect(output).toContain("diagnostics, not findings");
		expect(output).toContain("MODULE_NOT_FOUND");
	});

	it("fails closed when the doc-map is in neither HEAD nor the index", () => {
		const { code, output } = runGate(
			failing({ docMapFiles: [], newFaultsExit: 0 }),
		);

		// docMapFiles: [] leaves the extraction with no docs/doc-map.md, which the
		// gate tests for before running anything — what this pins is that the
		// un-runnable path never reaches the pass branch below the direction gate.
		expect(code).toBe(0);
		expect(output).not.toContain("already in HEAD");
	});

	/* The limb reached when the map IS in the index but HEAD has no copy of it:
	 * HEAD's extraction carries no docs/doc-map.md, and the gate must refuse
	 * rather than read the missing baseline as "nothing inherited". newFaultsExit
	 * 0 so a gate that skipped the limb would pass. */
	it("fails closed when HEAD holds no baseline to compare against", () => {
		const { code, output } = runGate(
			failing({ docMapInHead: false, newFaultsExit: 0 }),
		);

		expect(code).not.toBe(0);
		expect(output).toContain("no readable HEAD baseline for the doc-map check");
	});

	it("leaves a green check untouched — no baseline is built at all", () => {
		const { code, output } = runGate(
			failing({ checkerExit: 0, newFaultsExit: 0 }),
		);

		expect(code).toBe(0);
		expect(output).not.toContain("already in HEAD");
	});
});

/*
 * `.husky/pre-commit` is read by every session in this repo-global tree and by
 * every worktree (mantahostels#344), so breaking the live file to prove a test bites would
 * break parallel sessions' commits for as long as the mutation stood. Each
 * mutation is therefore applied to the fragment IN MEMORY — the same bytes the
 * gate cases above run, textually altered — and the case asserts the mutant
 * behaves wrongly. Every case asserts the mutation actually changed the text
 * before running it, since a `.replace()` that matched nothing would silently
 * re-test the real gate.
 */
describe("mutations of the gate are caught by the cases above", () => {
	const mutate = (find: string, replace: string): string => {
		const mutant = gateFragment().replace(find, replace);
		expect(mutant, `mutation '${find}' did not apply`).not.toBe(gateFragment());
		return mutant;
	};

	it("stops failing the commit when the checker's exit code is not propagated", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		expect(runGate(repo, mutate('exit "$dm_status"', "exit 0")).code).toBe(0);
	});

	it("stops passing an inherited fault when the direction verdict is ignored", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			newFaultsExit: 0,
		});

		const { code, output } = runGate(
			repo,
			mutate(
				'return 0\n  fi\n\n  if [ "$gd_cmp" -eq 1 ]',
				'return 1\n  fi\n\n  if [ "$gd_cmp" -eq 1 ]',
			),
		);
		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
	});

	it("passes an unanswerable comparison when the verdict is read off the text", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			newFaultsExit: 2,
			newFaultsStdout: "",
		});

		expect(
			runGate(
				repo,
				mutate('if [ "$gd_cmp" -eq 0 ]; then', 'if [ -z "$gd_new" ]; then'),
			).code,
		).toBe(0);
	});

	it("stops refusing a new fault when the refuse default is flipped", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			newFaultsExit: 1,
		});

		expect(runGate(repo, mutate("  return 1\n}", "  return 0\n}")).code).toBe(
			0,
		);
	});

	it("runs the checker out of scope when the path filter is dropped", () => {
		const repo = fixture({ staged: { "app/page.tsx": "x\n" }, checkerExit: 1 });

		const mutant = mutate(gateHead(CHECKER), "if true; then\n");
		const { code, output } = runGate(repo, mutant);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("fires on a look-alike path when the regex loses its anchor", () => {
		const repo = fixture({ staged: { "my-docs/a.md": "x\n" }, checkerExit: 1 });

		const { code, output } = runGate(repo, mutate("'^(docs/", "'(docs/"));
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("stops covering CLAUDE.md when its alternative is dropped", () => {
		const repo = fixture({ staged: { "CLAUDE.md": "x\n" }, checkerExit: 1 });

		expect(runGate(repo, mutate("|CLAUDE\\.md$", "")).code).toBe(0);
	});

	it("reads the worktree map again when the staged copy is not passed", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});
		fs.writeFileSync(
			path.join(repo, "docs", "doc-map.md"),
			"dirty worktree map\n",
		);

		// The root pointed back at the live checkout: one flag, and the whole
		// reading is the worktree's again.
		const mutant = mutate('--root "$dm_dir/tree"', "--root .");
		expect(runGate(repo, mutant).output).toContain("dirty worktree map");
	});

	// mantahostels#1193: the checker reads the map from $dm_dir, a path outside the repo, so
	// it cannot itself tell whether docs/doc-map.md has a live edit — the gate
	// answers that question and hands the verdict down as a flag.
	it("passes --map-dirty when docs/doc-map.md itself has uncommitted changes", () => {
		const repo = fixture({
			staged: { "docs/doc-map.md": "edited doc-map\n" },
			checkerExit: 1,
		});

		expect(runGate(repo).output).toContain("--map-dirty");
	});

	it("omits --map-dirty when docs/doc-map.md matches HEAD", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		expect(runGate(repo).output).not.toContain("--map-dirty");
	});

	it("runs the checker with a data file missing from the index, when the readable flag is dropped", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			docMapFiles: DOC_MAP_FILES.filter((n) => n !== "doc-map-high-water.json"),
		});

		const { code, output } = runGate(
			repo,
			mutate("dm_readable=0", "dm_readable=1"),
		);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("loses the untracked replay when the awk pattern stops matching", () => {
		const repo = untrackedFixture();

		const mutant = mutate(
			"'register entr.* not yet tracked by git:$'",
			"'zzz-never-matches'",
		);
		expect(runGate(repo, mutant).output.trim()).toBe("");
	});

	it("loses the route replay when the route marker stops matching", () => {
		const repo = routeFixture();

		const mutant = mutate(
			"'Section C route path.* not yet tracked by git:$'",
			"'zzz-never-matches'",
		);
		expect(runGate(repo, mutant).output.trim()).toBe("");
	});

	it("loses the malformed-marker replay when its awk pattern stops matching", () => {
		const repo = malformedFixture();

		const mutant = mutate(
			"'look like an over-cap marker but do not parse as one:$'",
			"'zzz-never-matches'",
		);
		expect(runGate(repo, mutant).output.trim()).toBe("");
	});

	it("leaks the report-only section when the slice loses its end bound", () => {
		const repo = untrackedFixture();

		const mutant = mutate("if (blank) exit; ", "");
		expect(runGate(repo, mutant).output).toContain("unreached-noise.md");
	});

	it("stops refusing the added row when the exit is dropped", () => {
		const repo = untrackedFixture([]);

		expect(runGate(repo, mutate("\n      exit 1\n", "\n      :\n")).code).toBe(
			0,
		);
	});

	it("refuses an inherited row when the HEAD comparison is dropped", () => {
		const repo = untrackedFixture();

		const mutant = mutate(
			'grep -qF -- "$dm_needle" || dm_rc=$?',
			"sh -c 'exit 1' || dm_rc=$?",
		);
		const { code, output } = runGate(repo, mutant);
		expect(code).toBe(1);
		expect(output).toContain("and not the file(s) they name");
	});

	/* With the whole index extracted there is no per-file blob read left to fail,
	 * so an absent map is what the gate has to test for (mantahostels#1922). */
	it("runs the checker over an index with no map when its test is dropped", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			docMapFiles: [],
			newFaultsExit: 0,
		});

		const mutant = mutate(
			'[ -f "$dm_dir/tree/docs/doc-map.md" ] || dm_readable=0',
			":",
		);
		expect(runGate(repo, mutant).output).toContain(STUB_MARKER);
	});

	it("reads a HEAD with no map as nothing inherited when its test is dropped", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			docMapInHead: false,
			newFaultsExit: 0,
		});

		const mutant = mutate(
			'[ -f "$dm_base_dir/tree/docs/doc-map.md" ] || dm_base_ok=0',
			":",
		);
		const { code, output } = runGate(repo, mutant);
		expect(code).toBe(0);
		expect(output).toContain("already in HEAD");
	});

	/* mantahostels#1922's blocker: --root moves the FILESYSTEM reads, and assertion 16's pool
	 * delta is an INDEX read (`git cat-file -s ":<path>"`), which only
	 * GIT_INDEX_FILE can point at HEAD. Dropped, both sides measure this commit's
	 * own pool growth, agree, and a commit adding pool bytes with no §B entry
	 * passes as INHERITED. */
	it("runs the baseline under HEAD's index and the staged side under this one", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		runGate(repo);
		const calls = fs
			.readFileSync(path.join(repo, CALL_LOG), "utf8")
			.trim()
			.split("\n");
		// held run, --json staged run, --json baseline run.
		expect(calls).toHaveLength(3);
		expect(calls[0].startsWith("- ")).toBe(true);
		expect(calls[1].startsWith("- ")).toBe(true);
		expect(calls[2]).toMatch(/^\S+\/index /);
	});

	it("prints on a green run when the output hold is removed", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 0,
		});

		const mutant = mutate(
			`doc_map_out="$(${coreCall("node", "scripts/check-doc-map.js")} \\\n      --root "$dm_dir/tree" $dm_dirty_flag 2>&1)" || dm_status=$?`,
			'node scripts/check-doc-map.js --root "$dm_dir/tree" $dm_dirty_flag || dm_status=$?',
		);
		expect(runGate(repo, mutant).output).toContain(STUB_MARKER);
	});
});

/*
 * The safety claim the hook's own comment makes: under a PATHSPEC commit, git hands
 * the hook a temporary index, so the checker's `git ls-files` sees this commit's
 * paths and not a parallel session's `git add -N` file.
 */
describe("a pathspec commit's index isolation", () => {
	it("hides a neighbour's intent-to-add file from the hook", () => {
		const { root, git } = newRepo("index-isolation-", temps);
		git("config", "core.hooksPath", ".githooks");
		fs.writeFileSync(path.join(root, "base.txt"), "x\n");
		git("add", "--", "base.txt");
		git("commit", "-qm", "base");

		fs.mkdirSync(path.join(root, ".githooks"));
		const hook = path.join(root, ".githooks", "pre-commit");
		fs.writeFileSync(hook, "#!/bin/sh\ngit ls-files > ls-files.out\n");
		fs.chmodSync(hook, 0o755);

		// A parallel session's in-flight file, and this commit's own.
		fs.writeFileSync(path.join(root, "neighbour.md"), "n\n");
		git("add", "-N", "--", "neighbour.md");
		fs.writeFileSync(path.join(root, "mine.md"), "m\n");
		git("add", "-N", "--", "mine.md");

		git("commit", "-qm", "mine", "--", "mine.md");

		const seen = fs
			.readFileSync(path.join(root, "ls-files.out"), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(seen).toContain("mine.md");
		expect(seen).not.toContain("neighbour.md");
	});
});

/*
 * Why the checker's conflicted-index SKIP is unreachable from any hook (scripts/check-doc-map.js's header):
 * git refuses a commit holding unmerged entries before pre-commit fires, so the
 * only caller that can reach a conflicted index is a person running the checker
 * by hand mid-resolution.
 */
describe("a conflicted index and the pre-commit hook", () => {
	function conflictedRepo(): { root: string; ran: () => boolean } {
		const { root, git } = newRepo("conflicted-index-", temps);
		git("config", "core.hooksPath", ".githooks");
		fs.writeFileSync(path.join(root, "f.txt"), "a\n");
		git("add", "--", "f.txt");
		git("commit", "-qm", "base");

		git("checkout", "-q", "-b", "other");
		fs.writeFileSync(path.join(root, "f.txt"), "b\n");
		git("commit", "-qm", "other", "--", "f.txt");
		git("checkout", "-q", "-");
		fs.writeFileSync(path.join(root, "f.txt"), "c\n");
		git("commit", "-qm", "mine", "--", "f.txt");

		/* Installed after the setup commits, so hook.out can only come from the commit under test. */
		fs.mkdirSync(path.join(root, ".githooks"));
		const hook = path.join(root, ".githooks", "pre-commit");
		fs.writeFileSync(hook, `#!/bin/sh\necho ${STUB_MARKER} > hook.out\n`);
		fs.chmodSync(hook, 0o755);

		try {
			git("merge", "other");
		} catch {
			/* expected: the merge conflicts */
		}

		expect(
			execFileSync("git", ["ls-files", "-u"], { cwd: root }).length,
		).toBeGreaterThan(0);
		return { root, ran: () => fs.existsSync(path.join(root, "hook.out")) };
	}

	it("refuses the commit before the hook runs", () => {
		const { root, ran } = conflictedRepo();
		let status: number | undefined;
		let stderr = "";
		try {
			// Piped, so git's expected refusal is not printed into a green run.
			execFileSync("git", ["commit", "-qm", "resolve"], {
				cwd: root,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			const err = e as { status?: number; stderr?: Buffer };
			status = err.status;
			stderr = String(err.stderr ?? "");
		}
		expect(status).toBe(128);
		expect(stderr).toContain("unmerged");
		expect(ran()).toBe(false);
	});

	it("runs the hook once the resolution is staged", () => {
		const { root, ran } = conflictedRepo();
		fs.writeFileSync(path.join(root, "f.txt"), "resolved\n");
		execFileSync("git", ["add", "--", "f.txt"], { cwd: root });

		expect(execFileSync("git", ["ls-files", "-u"], { cwd: root }).length).toBe(
			0,
		);
		execFileSync("git", ["commit", "-qm", "resolve"], { cwd: root });
		expect(ran()).toBe(true);
	});
});

/*
 * Assertion 11 (mantahostels#1474) through the hook rather than through a stub: the gate is
 * where a pointer disagreeing with its sidecar is caught before the push.
 */
describe("a pointer count disagreeing with its sidecar", () => {
	const mapText = [
		"# Doc map",
		"",
		"v1.0 · 26 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"| --- | --- | --- |",
		"| `docs/doc-map.md` | the map | `stable` |",
		"| `docs/notes.md` | a doc | `stable` |",
		"| `docs/doc-map-restatements.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-superseded.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-retired-vocabulary.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-restatement-allowlist.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-high-water.json` | a sidecar | `source-of-truth` |",
		"| `docs/doc-map-classes.json` | the class sidecar | `source-of-truth` |",
		"",
		"## Section B — figure registry",
		"",
		"### B1 · A figure",
		"",
		"- **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.",
		"- **Settled at #1**",
		"",
	].join("\n");

	/* `stated` is §B1's pointer count, `seedPaths` the restatement paths HEAD
	 * carries and `stagedPaths` the ones this commit stages. The gate is
	 * direction-gated, so a fault present in both readings is INHERITED and
	 * passes — a case meant to be refused must differ across them. The
	 * divergence is put in the SIDECAR rather than the map because editing the
	 * map makes it dirty, and a pointer fault against a dirty map is a WARN by
	 * design (mantahostels#1193), which never reaches the direction gate at all. */
	function realCheckerRepo(
		stated = 2,
		seedPaths = 1,
		stagedPaths = seedPaths,
	): string {
		const { root, git } = newRepo("doc-map-pointer-", temps);
		// The direction comparer as well as the checker: without it the gate dies
		// MODULE_NOT_FOUND and its refusal proves nothing about the comparison.
		const checkerNames = ["check-doc-map.js", "checker-new-faults.js"];
		// Checked against the gate's own invocation list, not a separately
		// hand-declared one, so a name silently dropped here is caught rather
		// than surviving as an unreached MODULE_NOT_FOUND refusal (mantahostels#2237).
		expectFixtureSupplies(
			CHECKER,
			checkerNames.map((n) => `scripts/${n}`),
		);
		writeCheckerDelegates(root, checkerNames);
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "docs", "doc-map.md"),
			mapText.replace("<n> paths", `${stated} path${stated === 1 ? "" : "s"}`),
		);
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "x\n");
		const restatements = (n: number) =>
			JSON.stringify({
				B1: {
					paths: ["docs/notes.md", "docs/doc-map.md"]
						.slice(0, n)
						.map((rel) => ({ path: rel })),
				},
			});
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-restatements.json"),
			restatements(seedPaths),
		);
		for (const name of DOC_MAP_FILES)
			if (!fs.existsSync(path.join(root, "docs", name)))
				fs.writeFileSync(path.join(root, "docs", name), emptyDataFile(name));
		/* The class sidecar is the coverage register since mantahostels#1849, and the loop
		 * above has already written it as `{}`. Overwrite that with the real
		 * register: a repo whose sidecar keys no file is BROKEN. */
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-classes.json"),
			JSON.stringify(
				Object.fromEntries(
					[
						"docs/doc-map.md",
						"docs/notes.md",
						...DOC_MAP_FILES.filter((n) => n.endsWith(".json")).map(
							(n) => `docs/${n}`,
						),
						"docs/doc-map-classes.json",
					].map((p) => [
						p,
						{
							section: "Docs",
							class: "source-of-truth",
							classQualifier: null,
							role: null,
							route: null,
							consumes: null,
						},
					]),
				),
			),
		);
		fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
		git("add", "--", "seed.txt", "scripts", "docs");
		git("commit", "-qm", "seed");
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "y\n");
		git("add", "--", "docs/notes.md");
		if (stagedPaths !== seedPaths) {
			fs.writeFileSync(
				path.join(root, "docs", "doc-map-restatements.json"),
				restatements(stagedPaths),
			);
			git("add", "--", "docs/doc-map-restatements.json");
		}
		return root;
	}

	it("lets the commit through when the pointer and its key agree", () => {
		const repo = realCheckerRepo(1);
		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).not.toContain("pointer says");
	});

	/* Left to the checker's tracked-path fallback both readings resolve one
	 * working-tree file, the fault sets are identical and the deletion passes;
	 * read from each side's own extraction they differ (mantahostels#1849, mantahostels#1922).
	 *
	 * The seed commit is backdated because an uncovered file inside
	 * PAIRING_GRACE_MS is a WARN kept out of the --json envelope (mantahostels#1785), so a
	 * key deleted in the same session that registered the file is NOT refused. */
	it("refuses a commit that deletes a registration key, naming the file left with no register entry", () => {
		const repo = realCheckerRepo(1);
		const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		execFileSync(
			"git",
			["commit", "-q", "--amend", "--no-edit", "--date", old],
			{
				cwd: repo,
				env: { ...process.env, GIT_COMMITTER_DATE: old },
			},
		);

		const sidecar = path.join(repo, "docs", "doc-map-classes.json");
		const register = JSON.parse(fs.readFileSync(sidecar, "utf8"));
		delete register["docs/notes.md"];
		fs.writeFileSync(sidecar, JSON.stringify(register));
		// The §A row goes with it, or assertion 17 refuses the commit on the
		// orphaned row instead and the coverage limb is never reached.
		fs.writeFileSync(
			path.join(repo, "docs", "doc-map.md"),
			fs
				.readFileSync(path.join(repo, "docs", "doc-map.md"), "utf8")
				.replace("| `docs/notes.md` | a doc | `stable` |\n", ""),
		);
		execFileSync(
			"git",
			["add", "--", "docs/doc-map-classes.json", "docs/doc-map.md"],
			{
				cwd: repo,
			},
		);

		const { code, output } = runGate(repo);
		expect(code).not.toBe(0);
		expect(output).toContain("docs/notes.md");
		expect(output).toContain("no doc-map register entry");
	});

	it("refuses the commit and prints the fix", () => {
		const { code, output } = runGate(realCheckerRepo(2, 2, 1));
		expect(code).not.toBe(0);
		expect(output).toContain(
			"B1 — pointer says 2 path(s), the sidecar holds 1",
		);
		expect(output).toContain(
			"- **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.",
		);
		expect(output).toContain(
			"- **Restated in:** none — <one clause saying why>.",
		);
		expect(output).toContain(
			"- **Supersedes:** see `docs/doc-map-superseded.json`.",
		);
	});
});

/*
 * Assertion 17 (mantahostels#1852) through the hook rather than through the checker alone:
 * §A is rendered from the sidecar, so a hand edit to a row has to be refused at
 * the COMMIT.
 */
describe("a hand-edited Section A row", () => {
	/* Each case runs over vitest's 5 s default, which would read as a failure
	 * rather than as load (mantahostels#1852). */
	const slowGateMs = 20_000;

	const { renderSectionA, REGISTER_HEADER } =
		require("./lib/doc-map") as typeof import("./lib/doc-map");

	/** The map before §A is rendered into it: heading, subsection, bare table. */
	const skeleton = [
		"# Doc map",
		"",
		"v1.0 · 26 August 2026",
		"",
		"## Section A — document register",
		"",
		"### Docs",
		"",
		REGISTER_HEADER,
		"|---|---|---|---|---|",
		"",
		"## Section B — figure registry",
		"",
		"### B1 · A figure",
		"",
		"- **Restated in:** 1 path, in `docs/doc-map-restatements.json`.",
		"- **Settled at #1**",
		"",
	].join("\n");

	const registeredPaths = [
		"docs/doc-map.md",
		"docs/notes.md",
		...DOC_MAP_FILES.filter((n) => n !== "doc-map.md").map((n) => `docs/${n}`),
	];

	const sidecar = Object.fromEntries(
		registeredPaths.map((p) => [
			p,
			{
				section: "Docs",
				class: "source-of-truth",
				classQualifier: null,
				role: null,
				route: null,
				consumes: null,
			},
		]),
	);

	/** A repo whose §A agrees with its sidecar, seeded and committed. */
	function renderAgreeingRepo(): string {
		const { root, git } = newRepo("doc-map-render-", temps);
		const checkerNames = ["check-doc-map.js", "checker-new-faults.js"];
		// Checked against the gate's own invocation list, not a separately
		// hand-declared one, so a name silently dropped here is caught rather
		// than surviving as an unreached MODULE_NOT_FOUND refusal (mantahostels#2237, mantahostels#2242).
		expectFixtureSupplies(
			CHECKER,
			checkerNames.map((n) => `scripts/${n}`),
		);
		writeCheckerDelegates(root, checkerNames);
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "x\n");
		for (const name of DOC_MAP_FILES)
			if (name.endsWith(".json"))
				fs.writeFileSync(path.join(root, "docs", name), emptyDataFile(name));
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-restatements.json"),
			JSON.stringify({ B1: { paths: [{ path: "docs/notes.md" }] } }),
		);
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-classes.json"),
			JSON.stringify(sidecar),
		);
		fs.writeFileSync(
			path.join(root, "docs", "doc-map.md"),
			renderSectionA(skeleton, sidecar),
		);
		fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
		git("add", "--", "seed.txt", "scripts", "docs");
		git("commit", "-qm", "seed");
		return root;
	}

	/** Stage `edit` applied to the map, plus an unrelated touch to notes.md. */
	const stage = (root: string, edit: (text: string) => string) => {
		const map = path.join(root, "docs", "doc-map.md");
		fs.writeFileSync(map, edit(fs.readFileSync(map, "utf8")));
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "y\n");
		execFileSync("git", ["add", "--", "docs/doc-map.md", "docs/notes.md"], {
			cwd: root,
		});
	};

	it(
		"lets a commit through while §A matches the sidecar",
		() => {
			const root = renderAgreeingRepo();
			/* The assertion skips a §A with no register table, exiting 0 having
			 * compared nothing (check-doc-map.js:1204) — and the gate holds the
			 * checker's report on a green run, so the skip is invisible in `output`. */
			const seeded = fs.readFileSync(
				path.join(root, "docs", "doc-map.md"),
				"utf8",
			);
			expect(seeded).toContain(REGISTER_HEADER);
			expect(seeded).toContain("| `docs/notes.md` |");

			stage(root, (t) => t);
			const { code, output } = runGate(root);
			expect(code).toBe(0);
			expect(output).not.toContain("does not match what the generator renders");
		},
		slowGateMs,
	);

	it(
		"refuses the commit, naming the row and the regeneration command",
		() => {
			const root = renderAgreeingRepo();
			stage(root, (t) =>
				t.replace(
					/^\| `docs\/notes\.md` .*$/m,
					"| `docs/notes.md` | hand-written prose | `source-of-truth` | Direct | — |",
				),
			);
			const { code, output } = runGate(root);
			expect(code).not.toBe(0);
			expect(output).toContain("§A does not match what the generator renders");
			expect(output).toContain("docs/notes.md — row differs");
			expect(output).toContain("npm run gen:doc-map-section-a");
			/* The hook replays the checker's report BEFORE the direction limb runs
			 * (.husky/pre-commit:260), so the three strings above are printed
			 * whichever way that limb resolves — including its could-not-answer
			 * refusal (lib/precommit-gate.sh:232). */
			expect(output).toContain("are NOT in HEAD — this commit adds them");
		},
		slowGateMs,
	);
});

/*
 * git-fixture.ts (mantahostels#2068) leak-checks every instantiate() call itself (proven
 * in git-fixture.test.ts), so newRepo() above already throws before any test
 * body runs were a copy still pointing at the template. bareRepoTemplate
 * writes no absolute-path-bearing content — no hooksPath, no worktree, no
 * alternates — so relink() has nothing to find there, and the first case below
 * cannot exercise a relink regression on that front. What it DOES check, and
 * what mantahostels#2079's acceptance criteria ask for, is a narrower thing: a commit made
 * in one instantiated copy must not reach a second, independent instantiation
 * of the same template, i.e. that `fs.cpSync` isn't sharing a git object store
 * or a ref namespace between copies.
 *
 * seededRepoTemplate (mantahostels#2200) is the first template in this file that ISN'T
 * empty at the point of copy: it already carries one commit, a populated
 * object store and a ref — exactly the sharing vector the isolation claim
 * above is about, so it needs its own case rather than inheriting coverage
 * from the bare one (mantahostels#2200's review, spec axis finding 3).
 */
describe("the copied fixture is isolated from its template (mantahostels#2079)", () => {
	it("a commit made in one copy leaves a fresh copy untouched", () => {
		const { root, git } = newRepo("doc-map-gate-isolation-", temps);
		fs.writeFileSync(path.join(root, "only-here.txt"), "x\n");
		git("add", "--", "only-here.txt");
		git("commit", "-qm", "only in this copy");
		expect(git("log", "--oneline").toString()).toContain("only in this copy");

		// The fresh copy needs its own commit before `git log` is even callable
		// (a brand-new repo has no HEAD) — an unrelated one, so a shared object
		// store or ref namespace between copies would surface here rather than
		// being masked by the fresh copy having nothing to compare against.
		const { root: fresh, git: freshGit } = newRepo(
			"doc-map-gate-isolation-",
			temps,
		);
		fs.writeFileSync(path.join(fresh, "unrelated.txt"), "y\n");
		freshGit("add", "--", "unrelated.txt");
		freshGit("commit", "-qm", "unrelated");
		expect(freshGit("log", "--oneline").toString()).not.toContain(
			"only in this copy",
		);
		expect(fs.existsSync(path.join(fresh, "only-here.txt"))).toBe(false);
	});

	/* As above, but starting from seededRepoTemplate's own one-commit history
	 * — the discriminating case a template with no prior content cannot pose. */
	it("a commit made in one seeded copy leaves a fresh seeded copy untouched", () => {
		const { root, git } = newSeededRepo(temps);
		fs.writeFileSync(path.join(root, "only-here.txt"), "x\n");
		git("add", "--", "only-here.txt");
		git("commit", "-qm", "only in this copy");
		const log = git("log", "--oneline").toString();
		expect(log).toContain("only in this copy");
		expect(log).toContain("seed");

		const { root: fresh, git: freshGit } = newSeededRepo(temps);
		const freshLog = freshGit("log", "--oneline").toString();
		expect(freshLog).toContain("seed");
		expect(freshLog).not.toContain("only in this copy");
		expect(fs.existsSync(path.join(fresh, "only-here.txt"))).toBe(false);
	});
});
