// @vitest-environment node
/*
 * Pins check-doc-map.js's numbered assertions on a real git repo: every tracked
 * in-scope file registered, no dead or stray entry, the pairing grace window,
 * and the reference checks over §B and §C. Each assertion's ticket is cited in
 * check-doc-map.js's own numbered list; the file was built for
 * mantahostels#148.
 *
 * check-doc-map.js reads its scope from `git ls-files`, so it is exercised
 * inside a throwaway repository rather than against this one — a fixture
 * pinned to this repo's own docs/ tree would go red on every doc added.
 *
 * It is a hard gate in .husky/pre-commit, which refuses a commit adding a
 * fault, and in .github/workflows/roadmap-digest.yml, so loosening a test
 * here loosens both: an unregistered document lands, one the update routine
 * will never consider.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFaultyGit } from "./lib/git-fault-fake";
import { defineTemplate, mkScratchDir, scratchBase } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-doc-map.js");
const MAP = "docs/doc-map.md";

let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const write = (file: string, body: string) => {
	fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
};

/** Write a file and track it — untracked files are out of scope by design. */
const track = (file: string, body = "x\n") => {
	write(file, body);
	git("add", "--", file);
};

/**
 * Commits whatever is currently staged, dated `hoursAgo` hours back — the
 * only way to express an "old" half of a doc-map pairing fault without
 * sleeping in the test (mantahostels#1785).
 */
const commit = (message: string, hoursAgo = 0) => {
	const date = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
	execFileSync("git", ["commit", "-qm", message], {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
	});
};

/**
 * The map as the script parses it: a version stamp, then a Section A table
 * whose first cell holds the registered path(s). `sectionB` is appended after
 * the `## Section B` heading the parser cuts at.
 */
const mapDoc = (rows: string[], sectionB = "") =>
	[
		"# Doc map",
		"",
		"v1.0 · 5 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"| --- | --- | --- |",
		...rows,
		"",
		"## Section B — figure registry",
		"",
		sectionB,
		"",
	].join("\n");

/** `n` whitespace-delimited words. */
const words = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

/** A Section A row registering one or more paths. */
const row = (...paths: string[]) =>
	`| ${paths.map((p) => `\`${p}\``).join(", ")} | a doc | \`stable\` |`;

/**
 * The restatement data file, written **untracked** beside the map: tracking it
 * would put it in scope and make every coverage fixture owe it a register row.
 */
const RESTATEMENTS = "docs/doc-map-restatements.json";

interface Restatement {
	path: string;
	locator?: string;
	gloss?: string;
}
interface RestatementEntry {
	paths: Restatement[];
	note?: string;
	knownIncomplete?: string;
}

/**
 * Write the restatement file, and re-stamp the map's pointer counts to agree
 * with it. Assertion 11 (mantahostels#1474) FAILs a pointer whose count disagrees with its
 * key. A test that IS about the disagreement writes the map after calling this.
 */
const writeRestatements = (data: Record<string, RestatementEntry>) => {
	write(RESTATEMENTS, JSON.stringify(data));
	const file = path.join(repo, MAP);
	if (!fs.existsSync(file)) return;
	let owner = "";
	const restamped = fs
		.readFileSync(file, "utf8")
		.split("\n")
		.map((line) => {
			const heading = line.match(/^### (B\d+)\b/);
			if (heading) owner = heading[1];
			if (!/^- \*\*Restated in:\*\*/.test(line)) return line;
			const n = data[owner]?.paths.length;
			return n === undefined ? NO_POINTER : pointer(n);
		})
		.join("\n");
	write(MAP, restamped);
	git("add", "--", MAP);
};

/**
 * The superseded data file, beside the map and untracked for the same reason.
 * Assertion 11 reads it to reconcile `Supersedes` pointer bullets against their
 * keys (mantahostels#1474), so every fixture owes one.
 */
const SUPERSEDED = "docs/doc-map-superseded.json";

interface SupersededEntry {
	text: string;
	needles: { needle: string; scanned: boolean }[];
}

const writeSuperseded = (data: Record<string, SupersededEntry>) =>
	write(SUPERSEDED, JSON.stringify(data));

const HIGH_WATER = "docs/doc-map-high-water.json";

/** The high-water mark assertions 12 and 13 read; a missing one is BROKEN. */
const writeHighWater = (mark = 0) =>
	write(HIGH_WATER, JSON.stringify({ highWaterMark: mark }));

/**
 * The retired-vocabulary sidecar, beside the map for the restatement file's
 * reason (mantahostels#2293). A missing or empty one is silent, not BROKEN (mantahostels#2324) —
 * every writeMap() fixture gets one written empty by default (mantahostels#2351), so a
 * test that is not about this sidecar never has to think about it. A fixture
 * that builds its own map without writeMap() writes one only where the test
 * needs it present.
 */
const RETIRED_VOCABULARY = "docs/doc-map-retired-vocabulary.json";

interface FixtureVocabularyEntry {
	phrases: { literal?: string; stem?: string }[];
}

const writeRetiredVocabulary = (data: Record<string, FixtureVocabularyEntry>) =>
	write(RETIRED_VOCABULARY, JSON.stringify(data));

/** The pointer bullet assertion 11 requires beside a sidecar key. */
const pointer = (n: number) =>
	`- **Restated in:** ${n} path${n === 1 ? "" : "s"}, in \`docs/doc-map-restatements.json\`.`;

/** Its counterpart for an entry the sidecar does not key. */
const NO_POINTER = "- **Restated in:** none — nothing restates it.";

/**
 * Since mantahostels#591 the data file is the only source of restatement paths, and a
 * missing one is BROKEN — so every fixture needs one, and it may only key an
 * entry the map actually holds. A fixture that states no §B entry of its own
 * gets this one, paired with the default data below.
 */
const BASELINE_ENTRY = `### B1 · A figure\n\n${pointer(1)}\n- **Settled at #1**`;

/**
 * Assertion 10 FAILs a `### B<n>` entry carrying no `Settled at` bullet, so
 * every fixture that states an entry owes one — none of them is about that
 * bullet. Give each entry the bullet where it lacks one; a test that is about
 * the assertion passes `rawEntries` and gets its fixture through untouched.
 */
const SETTLED_BULLET = "- **Settled at #1**";
/**
 * Assertion 11 (mantahostels#1474) FAILs an entry the restatement sidecar keys that carries
 * no `Restated in` pointer, and writeMap keys the first entry — so the same pass
 * supplies the pointer wherever the fixture states none.
 */
const withSettled = (body: string) => {
	const lines = body.split("\n");
	const out: string[] = [];
	let seenEntry = false;
	for (let i = 0; i < lines.length; i++) {
		out.push(lines[i]);
		if (!/^### B\d+/.test(lines[i])) continue;
		let end = i + 1;
		while (end < lines.length && !/^#+ /.test(lines[end])) end++;
		const block = lines.slice(i + 1, end).join("\n");
		if (!/^\s*-\s*\*\*Settled at/m.test(block)) out.push(SETTLED_BULLET);
		if (!/^\s*-\s*\*\*Restated in/m.test(block))
			out.push(seenEntry ? NO_POINTER : pointer(1));
		seenEntry = true;
	}
	return out.join("\n");
};

const ADMISSIONS = "docs/doc-map-admissions.json";

const writeAdmissions = (data: Record<string, unknown>) =>
	write(ADMISSIONS, JSON.stringify(data, null, 2));

/**
 * Assertion 29 (mantahostels#3225) FAILs a `### B<n>` id absent from HEAD with no
 * conforming admission row, and most fixtures here add an entry — so derive a
 * conforming row for every id the fixture states and no test that is not about
 * this sidecar has to think about it.
 */
const admissionsFor = (body: string) => {
	const out: Record<string, unknown> = {};
	for (const [, id] of body.matchAll(/^### (B\d+)/gm))
		out[id] = {
			settledAt: 1,
			confirmed: "A",
			commentUrl: "https://github.com/owner/repo/issues/1#issuecomment-1",
		};
	return out;
};

const CLASSES = "docs/doc-map-classes.json";

/**
 * The class sidecar, written **untracked** beside the map for the restatement
 * file's reason. Assertion 1 reads coverage from it and a missing one is BROKEN
 * (mantahostels#1849) — so, like the admission rows above, derive it from the fixture's own
 * rows and no test that is not about this sidecar has to think about it.
 *
 * Every key takes `source-of-truth`: the class the row's markdown cell spells is
 * read by nothing here since mantahostels#1849, and assertion 17 is silent over these
 * fixtures anyway — `mapDoc`'s three-column table is not the register table the
 * renderer places rows into.
 */
const classesFor = (rows: string[]) => {
	const out: Record<string, unknown> = {};
	// A `/**` §A entry is a fixture-only spelling; the sidecar's key vocabulary
	// takes one trailing `*`, which covers the same directory.
	for (const line of rows)
		for (const [, token] of (line.split("|")[1] || "").matchAll(/`([^`]+)`/g))
			out[token.trim().replace(/\*\*$/, "*")] = {
				section: "Docs",
				class: "source-of-truth",
				classQualifier: null,
				role: null,
				route: null,
				consumes: null,
				// Assertion 31 (mantahostels#3412) requires it on a prose key and refuses it elsewhere.
				...(/\.(md|html)$/.test(token.trim()) ? { reader: "agent" } : {}),
			};
	return out;
};

/** register-doc.js's canonical bytes (mantahostels#3353): sorted keys, tab indent, one
 * trailing newline, non-ASCII unescaped — what SIDECAR-NOT-CANONICAL gates. */
const writeClasses = (data: Record<string, unknown>) => {
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(data).sort()) sorted[key] = data[key];
	write(CLASSES, `${JSON.stringify(sorted, null, "\t")}\n`);
};

/** Track the map and the sidecars every assertion needs to reconcile. */
const writeMap = (
	rows: string[],
	sectionB = "",
	opts: { rawEntries?: boolean } = {},
) => {
	const stated = /^### B\d+/m.test(sectionB)
		? sectionB
		: [sectionB, BASELINE_ENTRY].filter(Boolean).join("\n\n");
	const body = opts.rawEntries ? stated : withSettled(stated);
	track(MAP, mapDoc(rows, body));
	// Keyed to the map's first entry so it is never an orphan; overwrite it with
	// writeRestatements() where the test is about the data itself.
	const first = body.match(/^### (B\d+)/m);
	if (first)
		writeRestatements({ [first[1]]: { paths: [{ path: "docs/notes.md" }] } });
	// Assertion 11 reconciles `Supersedes` bullets against this file, so it must
	// exist.
	writeSuperseded({});
	writeHighWater();
	// Overwrite it with writeAdmissions() where the test is about the admission
	// record (mantahostels#3225) itself.
	writeAdmissions(admissionsFor(body));
	// Present for the --root/--data-dir fixtures that track or copy it
	// structurally; overwrite it with writeRetiredVocabulary() where the test is
	// about the phrase-count assertion (mantahostels#2293) itself.
	writeRetiredVocabulary({});
	// Overwrite it with writeClasses() where the test is about the sidecar
	// itself — a bad class token, a repeated key, an unregistered file.
	writeClasses(classesFor(rows));
};

/*
 * scripts/lib/run-in-process.js states what the seam does not reproduce, which
 * is why the cases here stay sequential.
 */
const check = (env: Record<string, string> = {}, ...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: repo,
		env: { ...process.env, ...env },
	});
	return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
};

/** The baseline repo: three in-scope files, all registered. */
const baselineRows = [row(MAP), row("docs/notes.md"), row("CLAUDE.md")];

/**
 * Runs `fn` with `repo` pointed at `dir` — every helper above (`git`, `write`,
 * `track`, `commit`, `writeMap`) writes through the module-level `repo`, so a
 * template build function borrows it rather than re-deriving its own copy of
 * that plumbing.
 */
const withRepo = <T>(dir: string, fn: () => T): T => {
	const prev = repo;
	repo = dir;
	try {
		return fn();
	} finally {
		repo = prev;
	}
};

/** `git init` plus the two tracked-but-uncommitted files every fixture below
 * starts from — the baseline every case shared before mantahostels#2072, now the common
 * first step of each template's own independent build. */
const initBase = () => {
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	track("docs/notes.md");
	track("CLAUDE.md");
};

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#1907), migrated onto the shared
 * scripts/lib/git-fixture.ts helper (mantahostels#2068, mantahostels#2072) for its relink and
 * leak-check — this file's own hand-rolled `cpSync` never repointed the
 * template's absolute path out of anything, which mantahostels#2048 named as exactly the
 * failure mode mantahostels#2016's own fixture had (this one had no `core.hooksPath` or
 * worktree for a naive copy to mis-point, so it never surfaced here, but
 * nothing enforced that it stayed that way).
 */
const template = defineTemplate((dir) => withRepo(dir, initBase));

/*
 * The pairing-grace-window states (mantahostels#1785) baked into named variants rather
 * than a per-test `commit()` — see mantahostels#2072's fixture-state inventory. Each
 * variant builds ON TOP OF a copy of the base template above (`template`'s
 * own cache, cheap: a `cpSync`, not a re-run of `git init`) rather than
 * redoing `initBase()` from scratch — the earlier version of this file
 * duplicated the base build once per variant, which cost more in git spawns
 * than it saved. The ages used are 0h and 8h, both far from
 * `PAIRING_GRACE_MS`'s 6h boundary (scripts/lib/doc-map.js:1139), so baking
 * the commit date in at build time rather than at each test's run time is
 * safe against wall-clock drift within a run.
 */
const onBase = (dir: string, steps: () => void): void => {
	template.instantiate(dir);
	withRepo(dir, steps);
};

const graceTemplate = defineTemplate({
	"fresh-uncovered-file": (dir) =>
		onBase(dir, () => {
			writeMap(baselineRows);
			track("docs/fresh.md");
			commit("add fresh file", 0);
		}),
	"stale-uncovered-file": (dir) =>
		onBase(dir, () => {
			writeMap(baselineRows);
			track("docs/fresh.md");
			commit("add fresh file", 8);
		}),
	"fresh-dead-row": (dir) =>
		onBase(dir, () => {
			writeMap([...baselineRows, row("docs/ghost.md")]);
			commit("add ghost row", 0);
		}),
	"stale-dead-row": (dir) =>
		onBase(dir, () => {
			writeMap([...baselineRows, row("docs/ghost.md")]);
			commit("add ghost row", 8);
		}),
	"stale-present-untracked": (dir) =>
		onBase(dir, () => {
			writeMap([...baselineRows, row("docs/pending.md")]);
			commit("add pending row", 8);
			write("docs/pending.md", "pending\n");
		}),
	"stale-genuine-delete": (dir) =>
		onBase(dir, () => {
			writeMap([...baselineRows, row("docs/removed.md")]);
			track("docs/removed.md");
			commit("add removed file and its row", 8);
			git("rm", "-q", "--", "docs/removed.md");
		}),
});

/**
 * Switches the current test off the base template's copy and onto a
 * pairing-grace-window variant's, in place of the per-test
 * `writeMap`/`track`/`commit` sequence those tests used to run. Discards the
 * base copy `beforeEach` just instantiated rather than reusing it — kept this
 * way because a `beforeEach` that skips the base instantiation for the seven
 * grace tests alone would need to know a test's variant before it runs; the
 * cost is one `cpSync` plus one leak scan thrown away per grace test (mantahostels#2072).
 */
const useGrace = (variant: string) => {
	fs.rmSync(repo, { recursive: true, force: true });
	const dir = mkScratchDir("doc-map-grace-");
	graceTemplate.instantiate(dir, variant);
	repo = dir;
};

beforeEach(() => {
	repo = mkScratchDir("doc-map-test-");
	template.instantiate(repo);
});
afterEach(() => {
	// Guarded because an empty `repo` means beforeEach threw before minting one.
	if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe("check-doc-map", () => {
	it("passes when every tracked in-scope file is registered", () => {
		writeMap(baselineRows);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: doc map covers all 3 tracked files");
		expect(r.out).toContain("3 register entries");
		expect(r.out).toContain("v1.0");
		expect(r.out).not.toContain("5 August 2026");
	});

	it("fails on a tracked file with no register entry, naming it", () => {
		track("docs/unregistered.md");
		writeMap(baselineRows);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 tracked file(s) in scope have no doc-map");
		expect(r.out).toContain("docs/unregistered.md");
		// the failure has to carry the way out — the command, since mantahostels#1849
		expect(r.out).toContain("node scripts/register-doc.js");
	});

	/* mantahostels#1849 moved coverage's subject: the sidecar is the register, and §A is a
	 * projection of it. These two pin the direction — a row without a key does
	 * not cover, and a key without a row does. */
	it("fails a file §A carries a row for and the sidecar does not key", () => {
		track("docs/unregistered.md");
		writeMap([...baselineRows, row("docs/unregistered.md")]);
		writeClasses(classesFor(baselineRows));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/unregistered.md");
		expect(r.out).toContain("node scripts/register-doc.js");
	});

	it("covers a file the sidecar keys, §A row or no §A row", () => {
		track("docs/registered.md");
		writeMap(baselineRows);
		writeClasses(classesFor([...baselineRows, row("docs/registered.md")]));
		expect(check().status).toBe(0);
	});

	it("fails on a register entry matching no tracked file, naming it", () => {
		writeMap([...baselineRows, row("docs/deleted.md")]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("register entr(ies) match no tracked file");
		expect(r.out).toContain("docs/deleted.md");
		expect(r.out).toContain("renamed or removed");
	});

	/*
	 * mantahostels#1785: a split doc-map commit pair — the file half or the row half landed
	 * on `main` but not the other — WARNs inside a 6h grace window and FAILs
	 * once it expires. Every case here needs a real commit, dated with
	 * GIT_AUTHOR_DATE/GIT_COMMITTER_DATE, since with no commit at all (every
	 * fixture above) history is unavailable and the checker already FAILs —
	 * that is acceptance criterion 7, pinned by the un-committed fixtures above
	 * rather than repeated here.
	 */
	describe("the pairing grace window", () => {
		it("warns, not fails, on an uncovered file introduced minutes ago, naming the file, its age and the grace left", () => {
			useGrace("fresh-uncovered-file");
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("WARN");
			expect(r.out).toContain(
				"tracked file(s) in scope have no doc-map register entry yet, within the",
			);
			expect(r.out).toContain("docs/fresh.md");
			expect(r.out).toMatch(/introduced \dm ago/);
			expect(r.out).toContain("grace left");
			expect(r.out).toContain("doc-map-classes.json#A:docs/fresh.md");
		});

		it("fails on the same shape of file once its introducing commit is 8h old, naming the file with no mention of a grace window", () => {
			useGrace("stale-uncovered-file");
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				"1 tracked file(s) in scope have no doc-map register entry:",
			);
			expect(r.out).toContain("docs/fresh.md");
			expect(r.out).not.toContain("grace window");
		});

		it("warns, not fails, on a dead entry whose row was written minutes ago, naming the file, the row age and the grace left", () => {
			useGrace("fresh-dead-row");
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("WARN");
			expect(r.out).toContain(
				"doc-map register entr(ies) match no tracked file yet, within the",
			);
			expect(r.out).toContain("docs/ghost.md");
			expect(r.out).toMatch(/row written \dm ago/);
			expect(r.out).toContain("grace left");
		});

		it("fails on the same shape of row once it is 8h old, naming the file with no mention of a grace window", () => {
			useGrace("stale-dead-row");
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				"1 doc-map register entr(ies) match no tracked file:",
			);
			expect(r.out).toContain("docs/ghost.md");
			expect(r.out).not.toContain("grace window");
		});

		// mantahostels#1193, unaffected: present-but-untracked stays a WARN at any age, never
		// routed through the grace split at all.
		it("still warns on a present-but-untracked entry regardless of age", () => {
			useGrace("stale-present-untracked");
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain(
				"register entr(ies) name a file present on disk but not yet tracked",
			);
			expect(r.out).not.toContain("match no tracked file");
		});

		// Story 12: a genuine rename/delete, neither half young, FAILs exactly as
		// today — the file was once real, is committed, and is later removed.
		it("fails immediately on a genuine delete: an old file, removed, whose old row still names it", () => {
			useGrace("stale-genuine-delete");
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("register entr(ies) match no tracked file:");
			expect(r.out).toContain("docs/removed.md");
			expect(r.out).toContain("renamed or removed");
		});

		// The --json envelope: an in-grace item keeps its existing key at warn
		// severity, so the direction gate — lib/fault-profiles.js's `doc-map`
		// profile, which reads staged vs baseline envelopes to tell an inherited
		// fault from a new one — still matches it unmodified. The item itself
		// must be the SAME staged vs baseline (identity is the whole JSON value,
		// that profile's comment), so no age figure lives in the item — only in
		// the human report.
		it("carries an in-grace UNCOVERED item at warn severity under its existing key", () => {
			useGrace("fresh-uncovered-file");
			const r = check({}, "--json");
			expect(r.status).toBe(0);
			const envelope = JSON.parse(r.stdout);
			const byTag = Object.fromEntries(
				envelope.findings.map((f: { tag: string }) => [f.tag, f]),
			);
			expect(byTag["UNCOVERED-GRACE"].severity).toBe("WARN");
			expect(byTag["UNCOVERED-GRACE"].files).toEqual(["docs/fresh.md"]);
			expect(byTag.UNCOVERED).toBeUndefined();
		});

		/*
		 * The `doc-map` profile's own comment: it diffs the TOP-LEVEL envelope keys
		 * (`uncovered`, `dead`, …) — `findings` is in its DOC_MAP_NOT_A_FAULT set
		 * and never compared, and the profile has no `gating` predicate of its
		 * own, so every item surviving into those top-level lists is gate
		 * material. `data.uncovered`/`data.dead` therefore carry the OUT-OF-GRACE
		 * half alone (`check-doc-map.js`'s own comment beside them) — an in-grace
		 * item left in would read as "not in baseline" and refuse the commit the
		 * moment the doc map ALSO carries any unrelated, already-FAILing entry,
		 * exactly the split-commit-pair case grace exists to let through (caught
		 * in review of mantahostels#1785 — the first version of this test asserted the buggy
		 * behaviour as correct). Two real envelopes, not one fed to itself, since
		 * an identical pair passes for any item shape whatsoever and proves
		 * nothing.
		 */
		it("does not let an in-grace item leak into the direction gate's diffed set", () => {
			// Baseline (HEAD): the grace-window file already landed, days ago, so
			// it long ago passed out of grace — this run FAILs on it, same as an
			// inherited fault the founder has not yet cleared.
			writeMap(baselineRows);
			track("docs/old-uncovered.md");
			commit("add old-uncovered.md", 24 * 10);
			const baseline = check({}, "--json").stdout;
			expect(JSON.parse(baseline).outcome).toBe("FAIL");

			// Staged (this commit): the same inherited FAIL, plus a second file
			// this commit alone adds — genuinely new, but young enough to WARN.
			track("docs/fresh.md");
			commit("add fresh.md too", 0);
			const staged = check({}, "--json").stdout;
			expect(JSON.parse(staged).outcome).toBe("FAIL");

			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "new-faults-"));
			try {
				const stagedFile = path.join(dir, "staged.json");
				const baselineFile = path.join(dir, "baseline.json");
				fs.writeFileSync(stagedFile, staged);
				fs.writeFileSync(baselineFile, baseline);
				const nf = runInProcess(
					path.resolve(__dirname, "checker-new-faults.js"),
					["doc-map", stagedFile, baselineFile],
				);
				// Exit 0: the old file is inherited, and the fresh, in-grace file
				// is WARN-only — grace has to mean this pair reads as nothing new,
				// not merely that check-doc-map.js itself said WARN.
				expect(nf.status).toBe(0);
				expect(nf.stdout ?? "").not.toContain("docs/old-uncovered.md");
				expect(nf.stdout ?? "").not.toContain("docs/fresh.md");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("still refuses a genuinely new out-of-grace file alongside an unrelated in-grace one, naming only the out-of-grace file", () => {
			writeMap(baselineRows);
			commit("seed", 24 * 10);
			const baseline = check({}, "--json").stdout;
			expect(JSON.parse(baseline).outcome).toBe("OK");

			// Both added by this commit: one backdated past grace (a rebase or
			// cherry-pick landing an old change), one genuinely fresh.
			track("docs/old-and-new.md");
			commit("add old-and-new.md", 24 * 10);
			track("docs/fresh.md");
			commit("add fresh.md too", 0);
			const staged = check({}, "--json").stdout;
			expect(JSON.parse(staged).outcome).toBe("FAIL");

			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "new-faults-"));
			try {
				const stagedFile = path.join(dir, "staged.json");
				const baselineFile = path.join(dir, "baseline.json");
				fs.writeFileSync(stagedFile, staged);
				fs.writeFileSync(baselineFile, baseline);
				const nf = runInProcess(
					path.resolve(__dirname, "checker-new-faults.js"),
					["doc-map", stagedFile, baselineFile],
				);
				// Exit 1: the out-of-grace file is genuinely new and gate material.
				expect(nf.status).toBe(1);
				expect(nf.stdout ?? "").toContain("docs/old-and-new.md");
				// The in-grace file must not appear — it is not gate material yet.
				// Its tag as well as its path (mantahostels#2594): the leak this catches carries
				// the finding's message and no filename, so the path assertion
				// alone never bit.
				expect(nf.stdout ?? "").not.toContain("docs/fresh.md");
				expect(nf.stdout ?? "").not.toContain("UNCOVERED-GRACE");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		/*
		 * Acceptance criterion 8 (mantahostels#1785): a clean run raises neither UNCOVERED nor
		 * DEAD-ENTRY, so `splitByGrace` never runs its loop body and `dateItem` —
		 * `pairingHalfAgeMs`, the only caller of `git` in this path — is never
		 * invoked. Not directly observable from outside a spawned process (no seam
		 * to intercept the child's own `execFileSync` calls), so this is the
		 * closest available proxy: a repo whose git history is entirely absent
		 * (every fixture above `track()`s but never commits) still passes clean.
		 * If a clean run called `pairingHalfAgeMs` on some item, that item would
		 * have to exist — and none does, so there is nothing for it to be called
		 * with. Stated here rather than claimed covered on faith.
		 */
		it("passes clean with no commits in the repo at all — no fault means no dating call", () => {
			writeMap(baselineRows);
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("OK: doc map covers all 3 tracked files");
		});
	});

	// Neither check may short-circuit the other.
	it("reports an uncovered file and a dead entry in the same run", () => {
		track("docs/unregistered.md");
		writeMap([...baselineRows, row("docs/deleted.md")]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/unregistered.md");
		expect(r.out).toContain("docs/deleted.md");
	});

	// mantahostels#1193: a register entry whose file exists on disk but was never `git add`-ed
	// is normal mid-ticket state — the map edit and the file's own commit are
	// separate steps — so it must not block an unrelated commit.
	it("warns, not fails, on a register entry naming a present but untracked file", () => {
		write("docs/pending.md", "pending\n");
		writeMap([...baselineRows, row("docs/pending.md")]);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		expect(r.out).toContain(
			"register entr(ies) name a file present on disk but not yet tracked",
		);
		expect(r.out).toContain("docs/pending.md");
		expect(r.out).not.toContain("renamed or removed");
	});

	// The same entry, once its file is genuinely gone rather than merely
	// uncommitted, still FAILs — the rename-or-delete case assertion 2 exists for.
	it("still fails when the untracked file is later deleted, not just uncommitted, naming the file as renamed or removed", () => {
		write("docs/pending.md", "pending\n");
		writeMap([...baselineRows, row("docs/pending.md")]);
		fs.rmSync(path.join(repo, "docs/pending.md"));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("register entr(ies) match no tracked file");
		expect(r.out).toContain("docs/pending.md");
		expect(r.out).toContain("renamed or removed");
	});

	// #2584: self-plugin/ sat outside SCOPE, so a row naming its tracked hooks
	// file matched nothing tracked and read as uncommitted.
	it("warns on an uncommitted self-plugin row, naming it and not the tracked one (#2584)", () => {
		track("self-plugin/hooks/hooks.json");
		write("self-plugin/pending.json", "{}\n");
		writeMap([
			...baselineRows,
			row("self-plugin/hooks/hooks.json"),
			row("self-plugin/pending.json"),
		]);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		const untrackedBlock = r.out
			.slice(r.out.indexOf("name a file present on disk but not yet tracked"))
			.split("\n\n")[0];
		expect(untrackedBlock).toContain("self-plugin/pending.json");
		expect(untrackedBlock).not.toContain("self-plugin/hooks/hooks.json");
	});

	it("reports a tracked self-plugin file with no register row as uncovered", () => {
		track("self-plugin/.claude-plugin/marketplace.json");
		writeMap(baselineRows);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("have no doc-map register entry");
		expect(r.out).toContain("self-plugin/.claude-plugin/marketplace.json");
		expect(r.out).toContain("node scripts/register-doc.js");
	});

	// mantahostels#1193: neither finding may short-circuit the other, on the same reasoning
	// as the uncovered/dead pairing above.
	it("reports an untracked entry and a dead entry as separate findings", () => {
		write("docs/pending.md", "pending\n");
		writeMap([...baselineRows, row("docs/pending.md"), row("docs/deleted.md")]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/pending.md");
		expect(r.out).toContain(
			"register entr(ies) name a file present on disk but not yet tracked",
		);
		expect(r.out).toContain("docs/deleted.md");
		expect(r.out).toContain("register entr(ies) match no tracked file");
	});

	it("covers a whole directory from a trailing /* entry", () => {
		track("docs/research/a.md");
		track("docs/research/nested/b.md");
		writeMap([...baselineRows, row("docs/research/*")]);
		expect(check().status).toBe(0);
	});

	it("covers a whole directory from a trailing /** entry", () => {
		track("docs/research/a.md");
		writeMap([...baselineRows, row("docs/research/**")]);
		expect(check().status).toBe(0);
	});

	it("covers a filename prefix from a bare * entry", () => {
		track("docs/adr-0001.md");
		track("docs/adr-0002.md");
		writeMap([...baselineRows, row("docs/adr-*")]);
		expect(check().status).toBe(0);
	});

	// A literal entry is an exact path, not a prefix.
	it("does not let a literal entry cover a longer path sharing its prefix", () => {
		track("docs/notes.md.bak");
		writeMap(baselineRows);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/notes.md.bak");
	});

	// Scope is docs/, .claude/, AGENTS.md, CLAUDE.md. app/ is deliberately out —
	// it is placeholder product code, and registering it would map fiction.
	it("ignores tracked files outside the mapped scope", () => {
		track("app/page.tsx");
		track("scripts/thing.js");
		track("package.json");
		writeMap(baselineRows);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("all 3 tracked files");
	});

	it("covers .claude/ and AGENTS.md, which are in scope", () => {
		track(".claude/settings.json");
		track("AGENTS.md");
		writeMap([...baselineRows, row(".claude/*"), row("AGENTS.md")]);
		expect(check().status).toBe(0);
	});

	it("fails on an unregistered file under .claude/, naming it", () => {
		track(".claude/skills/thing/SKILL.md");
		writeMap(baselineRows);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(".claude/skills/thing/SKILL.md");
	});

	it("ignores an untracked file in scope", () => {
		write("docs/scratch.md", "scratch\n");
		writeMap(baselineRows);
		expect(check().status).toBe(0);
	});

	// Section B quotes paths in prose while explaining where a figure lives.
	// Parsing it would invent entries that vouch for files nobody registered.
	it("does not treat a path quoted in Section B as a register entry", () => {
		track("docs/pricing.md");
		writeMap(baselineRows, "§B1 — the take rate lives in `docs/pricing.md`.");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/pricing.md");
		expect(r.out).toContain("no doc-map register entry");
	});

	it("does not report a Section B path as a dead entry", () => {
		writeMap(baselineRows, "§B2 — restated in `docs/long-gone.md`.");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("docs/long-gone.md");
	});

	it("does not read a Section B table row as a register entry", () => {
		track("docs/pricing.md");
		writeMap(
			baselineRows,
			[
				"| Figure | Owner | Restated in |",
				"| --- | --- | --- |",
				"| `docs/pricing.md` | the take rate | `docs/long-gone.md` |",
			].join("\n"),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/pricing.md");
		expect(r.out).toContain("no doc-map register entry");
		// and no phantom dead entry from a path Section B merely names
		expect(r.out).not.toContain("docs/long-gone.md");
	});

	it("reads only the first cell of a row", () => {
		track("docs/pricing.md");
		track("docs/other.md");
		writeMap([
			...baselineRows,
			"| `docs/other.md` | derived from `docs/pricing.md` | `derived` |",
		]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/pricing.md");
		expect(r.out).toContain("no doc-map register entry");
		// and it must not have been read as an entry vouching for anything
		expect(r.out).not.toContain("match no tracked file");
	});

	// Authority classes are written as inline code in the register too. A word
	// with no slash and no .md is prose, not a path.
	it("does not read a non-path inline code span as an entry", () => {
		writeMap([...baselineRows, "| `generated-only` | a class | `derived` |"]);
		expect(check().status).toBe(0);
	});

	// Padding inside the backticks is invisible in rendered Markdown, so a map
	// that reads correct must not fail — and must not register a padded path as
	// a dead entry alongside the file it was meant to cover.
	it("tolerates whitespace inside a backticked entry", () => {
		track("docs/padded.md");
		writeMap([...baselineRows, "| ` docs/padded.md ` | a doc | `stable` |"]);
		expect(check().status).toBe(0);
	});

	it("registers every path in a multi-path first cell", () => {
		track("docs/a.md");
		track("docs/b.md");
		writeMap([...baselineRows, row("docs/a.md", "docs/b.md")]);
		expect(check().status).toBe(0);
	});

	it("ignores lines that are not table rows", () => {
		writeMap([...baselineRows, "Prose mentioning `docs/nowhere.md` inline."]);
		expect(check().status).toBe(0);
	});

	// `git ls-files` C-quotes any path holding a space or a non-ASCII byte
	// ("docs/caf\303\251.md") unless -z is passed, and a quoted path matches no
	// register entry — so the guard would demand an entry for a file that is
	// already registered.
	it("reads paths git would otherwise quote", () => {
		track("docs/café notes.md");
		writeMap([...baselineRows, row("docs/café notes.md")]);
		expect(check().status).toBe(0);
	});

	it("reports a wildcard entry whose directory no longer exists", () => {
		writeMap([...baselineRows, row("docs/removed/*")]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("match no tracked file");
		expect(r.out).toContain("docs/removed/*");
	});

	/* Scope comes from git, so a git that cannot answer must never read as "no
	 * files, therefore clean". `git ls-files` is this check's reading APPARATUS —
	 * how it enumerates the tracked set — so a failure is BROKEN at exit 2, not
	 * SKIP (mantahostels#155 — the checker family's exit-code and severity model —
	 * decision 6). */
	it("reports BROKEN, not a clean scan, when git cannot list the tree", () => {
		writeMap(baselineRows);
		fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
		// The fixture now lives under scratchBase(), which is INSIDE Manta's own
		// repository (mantahostels#3149) — so a `repo` stripped of its `.git` would resolve
		// upwards and list Manta's tree instead of failing. The ceiling stops
		// that walk at the base, restoring the out-of-repo shape this case is
		// about.
		const r = check({ GIT_CEILING_DIRECTORIES: scratchBase() });
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
		expect(r.out).toContain("git ls-files failed");
		expect(r.out).not.toContain("OK:");
	});

	/* The map is tracked in the repo, so a map that will not read or will not
	 * parse is BROKEN (exit 2), not a finding about coverage (exit 1). */
	it("is BROKEN when the map file is missing", () => {
		const r = check({}, "docs/absent.md");
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot read doc map");
	});

	// The stamp doubles as a parse canary: without it, the file being read is
	// not the map, and an empty parse would otherwise look like a clean repo.
	it("is BROKEN when the map carries no version stamp", () => {
		track(MAP, "# Doc map\n\n## Section A\n\n| `CLAUDE.md` | a doc | `x` |\n");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("no version stamp");
		// and it must name the shape the canary accepts, or the author restores
		// a line the next run rejects again
		expect(r.out).toContain('("vN.N · <date>")');
	});

	it("is BROKEN when Section A yields no register entries", () => {
		track(MAP, "# Doc map\n\nv1.0 · 5 August 2026 · 0 registered paths\n");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("no register entries parsed");
	});

	// The workflow reads annotations, not the log, so a failure that skipped
	// them would be invisible on the PR's Files-changed view.
	it("emits a GitHub Actions annotation for each fault under GITHUB_ACTIONS", () => {
		track("docs/unregistered.md");
		writeMap([...baselineRows, row("docs/deleted.md")]);
		const r = check({ GITHUB_ACTIONS: "true" });
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("::error::");
		expect(r.stdout).toContain("no doc-map register entry");
		expect(r.stdout).toContain("match no tracked file");
	});

	it("emits no annotation when not running under GitHub Actions", () => {
		track("docs/unregistered.md");
		writeMap(baselineRows);
		const r = check({ GITHUB_ACTIONS: "" });
		expect(r.status).toBe(1);
		expect(r.stdout).not.toContain("::error::");
	});

	/* Report text alone since mantahostels#1665, so what is left to prove is the
	 * derivation: the route tally the OK line prints, and §B's rounded word
	 * figure. */
	describe("derived counts", () => {
		// Counting routes must not depend on splitting the file at Section C.
		it("counts every ### C<n> route heading", () => {
			writeMap(
				baselineRows,
				["### C1 · One?", "", "### C2 · Two?", "", "### C3 · Three?"].join(
					"\n",
				),
			);
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("3 question routes");
		});

		it("does not count a ### heading that merely starts with C", () => {
			writeMap(baselineRows, "### Caching policy\n\n### Cutting prose");
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("0 question routes");
		});

		it("rounds §B's word count to the nearest 1,000, up", () => {
			writeMap(baselineRows, ["### B1 · A figure", words(1500)].join("\n\n"));
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("§B ~2,000 words");
		});

		it("rounds down below the halfway mark", () => {
			writeMap(baselineRows, ["### B1 · A figure", words(1400)].join("\n\n"));
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("§B ~1,000 words");
		});

		// The figure is §B's alone: prose past the next `## ` heading is not §B.
		it("counts §B alone, not the rest of the map", () => {
			const fat = [BASELINE_ENTRY, words(1400)].join("\n\n");
			track(
				MAP,
				`${mapDoc(baselineRows, fat)}\n## Section C\n\n${words(1000)}`,
			);
			writeRestatements({ B1: { paths: [{ path: "docs/notes.md" }] } });
			writeHighWater();
			writeClasses(classesFor(baselineRows));
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("§B ~1,000 words");
		});
	});

	/* Section C routes a question to the documents that answer it. Nothing
	 * checked those paths existed, so a rename left the reader following a route
	 * to no file (mantahostels#212). The unreached list is report-only by contrast: gating on
	 * it would force a route onto every binary asset (mantahostels#22). */
	describe("Section C routes", () => {
		const route = (id: string, read: string, not = "") =>
			[
				`### ${id} · A question?`,
				`- **Read:** ${read}`,
				`- **Not:** ${not}`,
			].join("\n");

		it("fails on a route path matching no tracked file, naming route and path", () => {
			writeMap(baselineRows, route("C1", "`docs/renamed-away.md` for this"));
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("Section C route path(s)");
			expect(r.out).toContain("C1 → docs/renamed-away.md");
			expect(r.out).toContain("renamed or removed");
		});

		it("passes a route path citing a document by its bare filename", () => {
			writeMap(baselineRows, route("C1", "`notes.md` for the notes"));
			expect(check().status).toBe(0);
		});

		/* mantahostels#1403: the map is read off disk but the file set comes out of git, so a
		 * route written before its target was committed failed the gate. Same
		 * softening assertion 2 took for register rows at mantahostels#1193. */
		it("warns, not fails, on a route path naming a present but untracked file", () => {
			write("docs/pending.md", "pending\n");
			writeMap(baselineRows, route("C1", "`docs/pending.md` for this"));
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("WARN");
			expect(r.out).toContain(
				"name a file present on disk but not yet tracked by git",
			);
			expect(r.out).toContain("C1 → docs/pending.md");
			expect(r.out).not.toContain("renamed or removed");
		});

		// The softening runs through the same citation matcher the FAIL does, so a
		// route citing the pending file by bare filename is softened too.
		it("warns on an untracked route target cited by its bare filename", () => {
			write("docs/pending.md", "pending\n");
			writeMap(baselineRows, route("C1", "`pending.md` for this"));
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("C1 → pending.md");
		});

		// The rename-or-delete case assertion 4 exists for is untouched.
		it("still fails when the untracked route target is deleted, not just uncommitted, naming the route and its target as renamed or removed", () => {
			write("docs/pending.md", "pending\n");
			writeMap(baselineRows, route("C1", "`docs/pending.md` for this"));
			fs.rmSync(path.join(repo, "docs/pending.md"));
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("point at no tracked file");
			expect(r.out).toContain("C1 → docs/pending.md");
			expect(r.out).toContain("renamed or removed");
		});

		// A gitignored file is not somewhere a route may point: it will never be
		// committed, so the sweeps would read the route as dead.
		it("still fails on a route path naming a gitignored file", () => {
			track(".gitignore", "docs/ignored.md\n");
			write("docs/ignored.md", "ignored\n");
			writeMap(baselineRows, route("C1", "`docs/ignored.md` for this"));
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("C1 → docs/ignored.md");
			expect(r.out).toContain("renamed or removed");
		});

		// Neither finding may short-circuit the other, as with the entry pair.
		it("reports an untracked route and a dead route as separate findings", () => {
			write("docs/pending.md", "pending\n");
			writeMap(
				baselineRows,
				[
					route("C1", "`docs/pending.md` for this"),
					route("C2", "`docs/renamed-away.md` for that"),
				].join("\n"),
			);
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("C1 → docs/pending.md");
			expect(r.out).toContain(
				"name a file present on disk but not yet tracked by git",
			);
			expect(r.out).toContain("C2 → docs/renamed-away.md");
			expect(r.out).toContain("point at no tracked file");
		});

		it("carries the untracked route in the --json envelope under its own tag", () => {
			write("docs/pending.md", "pending\n");
			writeMap(baselineRows, route("C1", "`docs/pending.md` for this"));
			const r = check({}, "--json");
			expect(r.status).toBe(0);
			const envelope = JSON.parse(r.stdout);
			const finding = envelope.findings.find(
				(f: { tag: string }) => f.tag === "UNTRACKED-ROUTE",
			);
			expect(finding.severity).toBe("WARN");
			expect(finding.routes).toContainEqual({
				route: "C1",
				path: "docs/pending.md",
			});
		});

		// A route says "read notes/momtest.md", never "docs/notes/momtest.md" —
		// but the suffix must start at a segment boundary, or `otes.md` passes.
		it("does not match a suffix that breaks mid-segment", () => {
			writeMap(baselineRows, route("C1", "`otes.md`"));
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("C1 → otes.md");
		});

		it("resolves a trailing-slash route path against the directory's files", () => {
			track("docs/adr/0001-thing.md");
			writeMap(
				[...baselineRows, row("docs/adr/*")],
				route("C1", "`docs/adr/`"),
			);
			expect(check().status).toBe(0);
		});

		/* A wildcard route path resolves the same way a trailing slash does. No
		 * route in the map is written that way today. */
		it("resolves a wildcard route path against the directory's files", () => {
			track("docs/adr/0001-thing.md");
			writeMap(
				[...baselineRows, row("docs/adr/*")],
				route("C1", "`docs/adr/*`"),
			);
			expect(check().status).toBe(0);
		});

		it("fails on a trailing-slash route path whose directory is empty, naming the route and its path", () => {
			writeMap(baselineRows, route("C1", "`docs/gone/`"));
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("C1 → docs/gone/");
		});

		// A route may legitimately send the reader outside the register's scope —
		// README.md sits at the repo root, outside SCOPE, and takes no Section A row.
		it("resolves a route path to a tracked file outside the mapped scope", () => {
			track("README.md");
			writeMap(baselineRows, route("C1", "`README.md` for the overview"));
			const r = check();
			expect(r.status).toBe(0);
			// and it stays out of scope: the coverage count must not have grown
			expect(r.out).toContain("all 3 tracked files");
		});

		it("checks a Not-line path for existence too", () => {
			writeMap(
				baselineRows,
				route("C1", "`notes.md`", "`docs/gone.md` — stale"),
			);
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("C1 → docs/gone.md");
		});

		it("reports a dead route in the same run as an uncovered file", () => {
			track("docs/unregistered.md");
			writeMap(baselineRows, route("C1", "`docs/gone.md`"));
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("docs/unregistered.md");
			expect(r.out).toContain("C1 → docs/gone.md");
			expect(r.out).toContain("FAIL: 2 doc-map problem(s)");
		});

		it("annotates a dead route under GITHUB_ACTIONS", () => {
			writeMap(baselineRows, route("C1", "`docs/gone.md`"));
			const r = check({ GITHUB_ACTIONS: "true" });
			expect(r.stdout).toContain("::error::");
			expect(r.stdout).toContain("Section C route path(s)");
		});

		// Versions and clause numbers are dotted but are not paths.
		it("does not read a version or a clause number as a path", () => {
			writeMap(
				baselineRows,
				route("C1", "`notes.md` at `v1.89`, under clause `6.1`"),
			);
			expect(check().status).toBe(0);
		});

		it("treats an unlabelled route's paths as destinations", () => {
			writeMap(
				baselineRows,
				["### C1 · A question?", "Read `notes.md` for this."].join("\n"),
			);
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("(2 of 3 in-scope files");
		});

		it("resolves a trailing-slash route path written without its parent", () => {
			track("docs/adr/0001-thing.md");
			writeMap([...baselineRows, row("docs/adr/*")], route("C1", "`adr/`"));
			expect(check().status).toBe(0);
		});

		// A route runs to the next heading of any depth: a #### sub-heading ends
		// it.
		it("ends a route at a deeper sub-heading", () => {
			writeMap(
				baselineRows,
				[
					"### C1 · A question?",
					"- **Read:** `notes.md`",
					"#### An aside",
					"- **Read:** `docs/gone.md`",
				].join("\n"),
			);
			expect(check().status).toBe(0);
		});

		// Inline code in a route is as often a command or a skill name as a path.
		it("ignores inline code that is not a path", () => {
			writeMap(
				baselineRows,
				route(
					"C1",
					"`/pick-next` via `concision-pass`, never `git status` or `derived`",
				),
			);
			expect(check().status).toBe(0);
		});

		describe("the unreached list", () => {
			it("lists an in-scope file no route reaches, without failing", () => {
				writeMap(baselineRows, route("C1", "`notes.md`"));
				const r = check();
				expect(r.status).toBe(0);
				expect(r.out).toContain("Reached by no Section C route");
				expect(r.out).toContain("CLAUDE.md");
				expect(r.out).not.toContain("  docs/notes.md\n");
			});

			it("grows when a route is deleted, and CI stays green", () => {
				writeMap(baselineRows, route("C1", "`notes.md`"));
				const before = check();
				expect(before.out).toContain("(2 of 3 in-scope files");

				writeMap(baselineRows);
				const after = check();
				expect(after.status).toBe(0);
				expect(after.out).toContain("(3 of 3 in-scope files");
			});

			// Counting a Not-line path as reached would mark C7's "`docs/` alone"
			// as routing every doc.
			it("does not count a Not-line path as reached", () => {
				writeMap(
					baselineRows,
					route("C1", "`CLAUDE.md`", "`notes.md` — lossy"),
				);
				const r = check();
				expect(r.status).toBe(0);
				expect(r.out).toContain("docs/notes.md");
				expect(r.out).toContain("(2 of 3 in-scope files");
			});

			it("says nothing when every in-scope file is reached", () => {
				writeMap(
					baselineRows,
					route("C1", "`notes.md`, `CLAUDE.md` and `doc-map.md`"),
				);
				const r = check();
				expect(r.status).toBe(0);
				expect(r.out).not.toContain("Reached by no Section C route");
			});
		});
	});

	/* Section B's `Restated in:` line is what a session walks when a figure
	 * changes, instead of grepping. A path on it that no longer exists drops a
	 * restatement out of the walk and the stale copy survives, so a dead one
	 * FAILs on the same rationale as a dead §C route (mantahostels#213). */
	describe("Section B restated-in paths", () => {
		/* The paths come from the data file (mantahostels#591), so a fixture states the entry
		 * in the map and its paths in the JSON. Nothing in the entry's own prose
		 * is read. */
		const entry = (id: string) => `### ${id} · A figure`;

		it("fails on a restated-in path matching no tracked file, naming entry and path", () => {
			writeMap(baselineRows, entry("B1"));
			writeRestatements({
				B1: { paths: [{ path: "notes/renamed-away.md", locator: "§1" }] },
			});
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("Section B restated-in path(s)");
			expect(r.out).toContain("B1 → notes/renamed-away.md");
			expect(r.out).toContain("renamed or removed");
		});

		it("passes a restated-in path citing a document by its bare filename", () => {
			writeMap(baselineRows, entry("B1"));
			writeRestatements({
				B1: { paths: [{ path: "notes.md" }, { path: "CLAUDE.md" }] },
			});
			expect(check().status).toBe(0);
		});

		// Paths are written relative to docs/, so the match is a suffix one.
		it("does not match a suffix that breaks mid-segment", () => {
			writeMap(baselineRows, entry("B1"));
			writeRestatements({ B1: { paths: [{ path: "otes.md" }] } });
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("B1 → otes.md");
		});

		/* A locator pins where in the file the copy sits, in a field of its own;
		 * one left inside the path is refused outright by the loader. */
		it("checks the path and ignores the locator beside it", () => {
			writeMap(baselineRows, entry("B1"));
			writeRestatements({
				B1: {
					paths: [
						{ path: "notes.md", locator: "§2/§4" },
						{ path: "CLAUDE.md", locator: "§Ground truth" },
					],
				},
			});
			expect(check().status).toBe(0);
		});

		it("still fails on a dead path carrying a locator", () => {
			writeMap(baselineRows, entry("B1"));
			writeRestatements({
				B1: { paths: [{ path: "docs/gone.md", locator: "§3" }] },
			});
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("B1 → docs/gone.md");
		});

		it("is BROKEN where a path still holds its locator, saying the locator belongs in its own field", () => {
			writeMap(baselineRows, entry("B1"));
			writeRestatements({ B1: { paths: [{ path: "notes.md L74" }] } });
			const r = check();
			expect(r.status).toBe(2);
			expect(r.out).toContain("locator belongs in its own field");
		});

		it("resolves a restated-in path to a tracked file outside the mapped scope", () => {
			track("scripts/thing.js");
			writeMap(baselineRows, entry("B1"));
			writeRestatements({ B1: { paths: [{ path: "scripts/thing.js" }] } });
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("all 3 tracked files");
		});

		// A restatement is not a route: it must not silence the unreached list, or
		// a figure's blast radius would read as question-route coverage.
		it("does not count a restated-in path as reached by a route", () => {
			writeMap(baselineRows, entry("B1"));
			writeRestatements({ B1: { paths: [{ path: "notes.md" }] } });
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("(3 of 3 in-scope files");
		});

		it("reports a dead restatement in the same run as an uncovered file", () => {
			track("docs/unregistered.md");
			writeMap(baselineRows, entry("B1"));
			writeRestatements({ B1: { paths: [{ path: "docs/gone.md" }] } });
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("docs/unregistered.md");
			expect(r.out).toContain("B1 → docs/gone.md");
			expect(r.out).toContain("FAIL: 2 doc-map problem(s)");
		});

		it("annotates a dead restatement under GITHUB_ACTIONS", () => {
			writeMap(baselineRows, entry("B1"));
			writeRestatements({ B1: { paths: [{ path: "docs/gone.md" }] } });
			const r = check({ GITHUB_ACTIONS: "true" });
			expect(r.stdout).toContain("::error::");
			expect(r.stdout).toContain("Section B restated-in path(s)");
		});

		/* A line number is the one locator nothing keeps true — every edit above
		 * it moves it and no generator re-derives it — so the token is refused in
		 * every field a locator can be written in, and in the entry's own prose
		 * (mantahostels#3151). */
		describe("line-number locators", () => {
			const cases: [string, RestatementEntry, string][] = [
				[
					"a locator",
					{ paths: [{ path: "notes.md", locator: "L241" }] },
					"B1 — L241 in locator on `notes.md`",
				],
				[
					"a gloss",
					{
						paths: [{ path: "notes.md", gloss: "`notes.md` L12 (the figure)" }],
					},
					"B1 — L12 in gloss on `notes.md`",
				],
				[
					"a note",
					{ paths: [{ path: "notes.md" }], note: "walk L7 too" },
					"B1 — L7 in note",
				],
				[
					"a locator, in the path:line form",
					{ paths: [{ path: "notes.md", locator: "notes.md:241" }] },
					"B1 — notes.md:241 in locator on `notes.md`",
				],
				[
					"a note, in the path:range form",
					{
						paths: [{ path: "notes.md" }],
						note: "see `scripts/collect.py:77-85` first",
					},
					"B1 — scripts/collect.py:77-85 in note",
				],
				[
					"a gloss, on an extensionless path",
					{
						paths: [
							{ path: "notes.md", gloss: "as `.husky/pre-commit:12` does" },
						],
					},
					"B1 — .husky/pre-commit:12 in gloss on `notes.md`",
				],
			];
			for (const [where, data, line] of cases)
				it(`fails the token in ${where}, naming the entry and token and offering a quoted phrase the file holds instead`, () => {
					writeMap(baselineRows, entry("B1"));
					writeRestatements({ B1: data });
					const r = check();
					expect(r.status).toBe(1);
					expect(r.out).toContain(line);
					expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
					expect(r.out).toContain('"quoted phrase" the file holds');
				});
			it("fails the token in the entry's own prose, naming the entry and the token", () => {
				writeMap(
					baselineRows,
					`${entry("B1")}\n\n- **Owner:** \`notes.md\` §Fermi (L148)`,
				);
				writeRestatements({ B1: { paths: [{ path: "notes.md" }] } });
				const r = check();
				expect(r.status).toBe(1);
				expect(r.out).toContain("B1 — L148 in entry prose");
				const envelope = JSON.parse(check({}, "--json").stdout);
				expect(envelope.lineLocators).toEqual([
					{ entry: "B1", where: "entry prose", token: "L148" },
				]);
			});
			it("fails a path:line citation in the entry's own prose, naming the entry and the citation", () => {
				writeMap(
					baselineRows,
					`${entry("B1")}\n\n- **Owner:** \`docs/notes.md:19\` states it`,
				);
				writeRestatements({ B1: { paths: [{ path: "notes.md" }] } });
				const r = check();
				expect(r.status).toBe(1);
				expect(r.out).toContain("B1 — docs/notes.md:19 in entry prose");
			});
			it("passes a §-section locator, a word that merely starts with L, and a colon that is no citation", () => {
				writeMap(
					baselineRows,
					`${entry("B1")}\n\n- **Owner:** \`notes.md\` §4, the L2-cache line and CL4 both, read at 12:30 as a 3:1 ratio from example.com:443`,
				);
				writeRestatements({
					B1: { paths: [{ path: "notes.md", locator: "§4 (CL4)" }] },
				});
				expect(check().status).toBe(0);
			});
		});

		/* The quoted phrase that replaces a line number is held to the file's
		 * bytes, so the replacement cannot rot the way the number did (mantahostels#3151). */
		describe("quoted anchors", () => {
			it("fails a locator phrase the file no longer holds, naming only that phrase and offering to re-quote it", () => {
				track("docs/notes.md", "The blended figure is thirty.\n");
				writeMap(baselineRows, entry("B1"));
				writeRestatements({
					B1: {
						paths: [
							{
								path: "docs/notes.md",
								locator:
									'§1 "blended figure is thirty" and "figure was twenty"',
							},
						],
					},
				});
				const r = check();
				expect(r.status).toBe(1);
				expect(r.out).toContain('B1 → docs/notes.md: "figure was twenty"');
				expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
				expect(r.out).not.toContain('"blended figure is thirty"');
				expect(r.out).toContain("Re-quote the phrase");
				const envelope = JSON.parse(check({}, "--json").stdout);
				expect(envelope.deadAnchors).toEqual([
					{ entry: "B1", path: "docs/notes.md", phrase: "figure was twenty" },
				]);
			});
			it("passes every phrase the file holds, and reads a gloss's quotes as prose", () => {
				track("docs/notes.md", "The blended figure is thirty.\n");
				writeMap(baselineRows, entry("B1"));
				writeRestatements({
					B1: {
						paths: [
							{
								path: "docs/notes.md",
								locator: '"blended figure is thirty"',
								gloss: 'once "twenty"',
							},
						],
					},
				});
				expect(check().status).toBe(0);
			});
			it("leaves a dead path to the dead-restatement fault", () => {
				writeMap(baselineRows, entry("B1"));
				writeRestatements({
					B1: { paths: [{ path: "docs/gone.md", locator: '"anything"' }] },
				});
				const r = check();
				expect(r.out).toContain("B1 → docs/gone.md");
				expect(r.out).not.toContain("DEAD-ANCHOR");
			});
		});

		it("says every restatement path is live when they are", () => {
			writeMap(baselineRows, entry("B1"));
			writeRestatements({ B1: { paths: [{ path: "notes.md" }] } });
			const r = check();
			expect(r.out).toContain("every §B restatement path live");
		});

		/* Printed from the same parse so the scripts/check-doc-map.js's header prose quoting it is never
		 * hand-counted (mantahostels#280, the stale coverage figure). */
		describe("the restatement census", () => {
			it("reports paths and covered entries, without failing", () => {
				writeMap(baselineRows, [entry("B1"), entry("B2")].join("\n\n"));
				writeRestatements({
					B1: {
						paths: [{ path: "notes.md", locator: "§1" }, { path: "CLAUDE.md" }],
					},
					B2: { paths: [{ path: "notes.md" }] },
				});
				const r = check();
				expect(r.status).toBe(0);
				expect(r.out).toContain("3 restatement path(s) across 2 of 2 §B");
			});

			// The denominator is every §B entry; the numerator is the entries the
			// data file keys, so an entry restating nothing is simply left out of
			// the file rather than carried there as an empty list.
			it("counts an entry the data file does not key in the denominator only", () => {
				writeMap(baselineRows, [entry("B1"), entry("B2")].join("\n\n"));
				writeRestatements({ B1: { paths: [{ path: "notes.md" }] } });
				const r = check();
				expect(r.status).toBe(0);
				expect(r.out).toContain("1 restatement path(s) across 1 of 2 §B");
			});
		});
	});

	/*
	 * Every fault is raised through one helper taking the payload key as a
	 * parameter. The key is what a --json consumer reads the items out of, and it
	 * is no longer visible beside the tag.
	 */
	it("gives every fault kind its own tag and payload key in --json", () => {
		track("docs/unregistered.md");
		writeMap(
			[...baselineRows, row("docs/deleted.md")],
			[
				"### B1 · A figure",
				"- **Restated in:** `docs/vanished.md` §1",
				"",
				"## Section C — question routes",
				"",
				"### C1 · Where does X live?",
				"- **Read:** `docs/no-such-route.md`",
			].join("\n"),
		);
		writeRestatements({
			B1: { paths: [{ path: "docs/vanished.md", locator: "§1" }] },
		});
		const r = check({}, "--json");
		expect(r.status).toBe(1);

		const envelope = JSON.parse(r.stdout);
		const byTag = Object.fromEntries(
			envelope.findings.map((f: { tag: string }) => [f.tag, f]),
		);
		expect(Object.keys(byTag).sort()).toEqual([
			"DEAD-ENTRY",
			"DEAD-RESTATEMENT",
			"DEAD-ROUTE",
			"UNCOVERED",
		]);
		expect(byTag.UNCOVERED.files).toContain("docs/unregistered.md");
		expect(byTag["DEAD-ENTRY"].entries).toContain("docs/deleted.md");
		expect(byTag["DEAD-ROUTE"].routes).toContainEqual({
			route: "C1",
			path: "docs/no-such-route.md",
		});
		expect(byTag["DEAD-RESTATEMENT"].restatements).toContainEqual({
			entry: "B1",
			path: "docs/vanished.md",
		});
	});

	/* In an adopter the core's scripts, skills and agent docs live at the plugin
	 * root, not in the host's tree (#604). */
	describe("a path only the plugin ships", () => {
		const pluginOnly = [
			"docs/agents/guide.md",
			".claude/skills/pick/SKILL.md",
			"scripts/check-thing.js",
		];
		let plugin: string;
		beforeEach(() => {
			plugin = fs.mkdtempSync(path.join(scratchBase(), "plugin-"));
			for (const f of pluginOnly) {
				fs.mkdirSync(path.join(plugin, path.dirname(f)), { recursive: true });
				fs.writeFileSync(path.join(plugin, f), "x\n");
			}
			writeMap(
				baselineRows,
				[
					"### B1 · A figure",
					"- **Restated in:** `.claude/skills/pick/SKILL.md` §1",
					"",
					"## Section C — question routes",
					"",
					"### C1 · Where does X live?",
					"- **Read:** `docs/agents/guide.md`",
				].join("\n"),
			);
			writeRestatements({
				B1: {
					paths: [{ path: ".claude/skills/pick/SKILL.md", locator: "§1" }],
				},
			});
			const data = classesFor(baselineRows) as Record<
				string,
				Record<string, unknown>
			>;
			data["docs/notes.md"].consumes = [
				{ kind: "path", ref: "scripts/check-thing.js" },
			];
			writeClasses(data);
		});
		afterEach(() => fs.rmSync(plugin, { recursive: true, force: true }));

		it("resolves a route, a restatement and a consumes there in a plugin install", () => {
			const r = check({ WFC_SCRIPT_ROOT: plugin });
			expect(r.out).not.toContain("point at no tracked file");
			expect(r.out).not.toContain("resolve to nothing");
			expect(r.status).toBe(0);
		});

		it("still fails all three in a source checkout of the core, tagging each DEAD-ROUTE, DEAD-RESTATEMENT or DEAD-CONSUMES", () => {
			fs.writeFileSync(path.join(plugin, "package.json"), "{}\n");
			const r = check({ WFC_SCRIPT_ROOT: plugin }, "--json");
			expect(r.status).toBe(1);
			const byTag = Object.fromEntries(
				JSON.parse(r.stdout).findings.map((f: { tag: string }) => [f.tag, f]),
			);
			expect(byTag["DEAD-ROUTE"].routes).toContainEqual({
				route: "C1",
				path: "docs/agents/guide.md",
			});
			expect(Object.keys(byTag).sort()).toEqual([
				"DEAD-CONSUMES",
				"DEAD-RESTATEMENT",
				"DEAD-ROUTE",
			]);
		});
	});

	it("reads the map from an explicit path argument", () => {
		const rows = [
			row("docs/notes.md"),
			row("CLAUDE.md"),
			row("docs/alt-map.md"),
		];
		// three in-scope files once alt-map.md is tracked: it, notes.md, CLAUDE.md
		track("docs/alt-map.md", mapDoc(rows, BASELINE_ENTRY));
		writeRestatements({ B1: { paths: [{ path: "docs/notes.md" }] } });
		writeHighWater();
		writeClasses(classesFor(rows));
		// docs/doc-map.md does not exist here; the argument is what makes it pass
		expect(check({}, "docs/alt-map.md").status).toBe(0);
	});
});

/* What this guards is not a wrong verdict but a wrong instruction — the line the
 * check tells a reader to paste. The incident: docs/doc-map.md §A. */
describe("check-doc-map mid-merge", () => {
	/** Leave the fixture with contested.md conflicted in the index. */
	const conflict = () => {
		git("commit", "-qm", "base");
		git("checkout", "-qb", "other");
		write("docs/contested.md", "theirs\n");
		git("commit", "-qm", "theirs", "--", "docs/contested.md");
		git("checkout", "-q", "-");
		write("docs/contested.md", "ours\n");
		git("commit", "-qm", "ours", "--", "docs/contested.md");
		try {
			git("merge", "other");
		} catch {
			/* the conflict this fixture exists to create */
		}
		expect(git("ls-files", "--unmerged")).not.toBe("");
	};

	/** Track the contested file and the map that registers it. */
	const setup = () => {
		track("docs/contested.md", "base\n");
		writeMap([...baselineRows, row("docs/contested.md")], "");
		conflict();
	};

	it("skips rather than counting, naming the conflicted path", () => {
		setup();
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).toContain("conflicted path(s)");
		expect(r.out).toContain("docs/contested.md");
	});

	/*
	 * A file is left unregistered here, so a check that ran would FAIL on
	 * coverage. Without that the test passes for the wrong reason: a fixture
	 * with nothing to find is silent whether the SKIP fires or not.
	 */
	it("raises no coverage failure while the conflict stands", () => {
		track("docs/unregistered.md");
		setup();
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).not.toContain("docs/unregistered.md");
	});

	it("counts the committed tree once the conflict is resolved", () => {
		setup();
		write("docs/contested.md", "resolved\n");
		// mid-merge git refuses a partial commit, so the resolution is staged
		git("add", "--", "docs/contested.md");
		git("commit", "-qm", "resolved");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: doc map covers all 4 tracked files");
	});
});

/*
 * Assertion 5's paths come from doc-map-restatements.json and nowhere else
 * (mantahostels#591).
 */
describe("the restatement data file", () => {
	const data = "docs/doc-map-restatements.json";
	const sectionB = (restated: string) =>
		[
			"### B7 · a figure",
			"",
			"- **Owner:** `docs/notes.md`",
			`- **Restated in:** \`${restated}\``,
			"",
		].join("\n");

	it("reads the paths from the data file, keeping the entry association", () => {
		writeMap(baselineRows, sectionB("docs/notes.md"));
		write(data, JSON.stringify({ B7: { paths: [{ path: "docs/gone.md" }] } }));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("B7 → docs/gone.md");
	});

	/* The array-per-entry shape this file held until mantahostels#1469. It is not read
	 * alongside the object shape: a loader accepting both would take a mistyped
	 * `paths` for an entry that legitimately restates nothing, and assertion 5
	 * would scan zero paths while reporting a clean run. */
	it("is BROKEN on the superseded array-per-entry shape, calling it a non-object item", () => {
		writeMap(baselineRows, sectionB("docs/notes.md"));
		write(data, JSON.stringify({ B7: [{ path: "docs/notes.md" }] }));
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("non-object item");
		expect(r.out).not.toContain("every §B restatement path live");
	});

	it("checks a path carrying a gloss, beside an entry note and a marker date", () => {
		writeMap(baselineRows, sectionB("docs/notes.md"));
		write(
			data,
			JSON.stringify({
				B7: {
					paths: [
						{
							path: "docs/gone.md",
							locator: "§2",
							gloss: "the launch-gate paragraph",
						},
					],
					note: "Not a restatement: `CLAUDE.md` — it carries no figure.",
					knownIncomplete: "2026-08-19",
				},
			}),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("B7 → docs/gone.md");
	});

	it("is BROKEN where a marker date is not an ISO date", () => {
		writeMap(baselineRows, sectionB("docs/notes.md"));
		write(
			data,
			JSON.stringify({
				B7: {
					paths: [{ path: "docs/notes.md" }],
					knownIncomplete: "19 August 2026",
				},
			}),
		);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("not an ISO YYYY-MM-DD date");
	});

	it("ignores the entry's own prose, which is no longer read at all", () => {
		writeMap(baselineRows, sectionB("docs/gone.md"));
		write(
			data,
			JSON.stringify({
				B7: { paths: [{ path: "docs/notes.md", locator: "§3" }] },
			}),
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("1 restatement path(s) across 1 of 1 §B entries");
	});

	/* The mutation the spec called the one that matters most: a checker reading
	 * nothing reports nothing, which is indistinguishable from a registry whose
	 * every path is live. So the absent file is BROKEN, not a silent OK (mantahostels#591). */
	it("is BROKEN where the data file is missing — never a silent clean scan", () => {
		writeMap(baselineRows, sectionB("docs/gone.md"));
		fs.rmSync(path.join(repo, data));
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("is missing");
		expect(r.out).not.toContain("every §B restatement path live");
	});

	it("is BROKEN on a data file holding no entries at all", () => {
		writeMap(baselineRows, sectionB("docs/notes.md"));
		write(data, "{}");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("holds no entries");
	});

	// A day-one map has no §B entries, so an empty file is its real state (#3).
	it("accepts a data file holding no entries where §B holds none either", () => {
		writeMap(baselineRows);
		track(MAP, mapDoc(baselineRows, ""));
		write(data, "{}");
		const r = check();
		expect(r.status).not.toBe(2);
		expect(r.out).not.toContain("holds no entries");
		expect(r.out).toContain("0 restatement path(s) across 0 of 0 §B entries");
	});

	it("is BROKEN on a data file that exists but will not load, naming it — never a fallback", () => {
		writeMap(baselineRows, sectionB("docs/notes.md"));
		write(data, "{ not json");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("doc-map-restatements.json");
	});

	/* .husky/pre-commit stages the sidecar out with the map and its five data
	 * files, so that caller never reaches this fallback. It answers a caller
	 * pointing `--data-dir` somewhere holding no sidecar at all (mantahostels#1849). What it
	 * costs is said out loud, and asserted here. */
	it("falls back to the tracked sidecar, saying which bytes it read", () => {
		writeMap(baselineRows);
		write(
			"elsewhere/doc-map-restatements.json",
			JSON.stringify({ B1: { paths: [{ path: "docs/notes.md" }] } }),
		);
		write("elsewhere/doc-map-high-water.json", '{"highWaterMark":0}');
		write("elsewhere/doc-map-superseded.json", "{}");
		const r = check({}, "--data-dir", "elsewhere");
		expect(r.status).toBe(0);
		expect(r.out).toContain("no class sidecar in elsewhere");
		expect(r.out).toContain("the working tree's bytes, not this commit's");
	});

	/* Precedence, not merely presence: .husky/pre-commit's whole reason for
	 * staging the sidecar out is that the --data-dir copy must WIN over the
	 * tracked one. The tracked sidecar here keys every file, so a checker
	 * reading it reports no fault at all. */
	it("reads the --data-dir sidecar over the tracked one when both exist", () => {
		writeMap(baselineRows);
		writeClasses(classesFor(baselineRows));
		write(
			"elsewhere/doc-map-restatements.json",
			JSON.stringify({ B1: { paths: [{ path: "docs/notes.md" }] } }),
		);
		write("elsewhere/doc-map-high-water.json", '{"highWaterMark":0}');
		write("elsewhere/doc-map-superseded.json", "{}");
		const short = classesFor(baselineRows) as Record<string, unknown>;
		delete short["docs/notes.md"];
		write("elsewhere/doc-map-classes.json", JSON.stringify(short));
		const r = check({}, "--data-dir", "elsewhere");
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/notes.md");
		expect(r.out).not.toContain("no class sidecar in elsewhere");
	});

	it("takes the data directory from --data-dir", () => {
		writeMap(baselineRows, sectionB("docs/notes.md"));
		write(
			"elsewhere/doc-map-restatements.json",
			JSON.stringify({ B7: { paths: [{ path: "docs/gone.md" }] } }),
		);
		write("elsewhere/doc-map-high-water.json", '{"highWaterMark":0}');
		write(
			"elsewhere/doc-map-classes.json",
			JSON.stringify(classesFor(baselineRows)),
		);
		const r = check({}, "--data-dir", "elsewhere");
		expect(r.status).toBe(1);
		expect(r.out).toContain("B7 → docs/gone.md");
	});

	/* Together with the mandatory non-empty file, this is why the census below
	 * needs no zero-entry guard: a map with no §B entries can hold no valid data
	 * file, so the run is BROKEN before the census is reached. */
	it("is BROKEN where the map holds no §B entries at all, naming the entry the data file keys", () => {
		const rows = baselineRows;
		track(MAP, mapDoc(rows, ""));
		writeHighWater();
		writeRestatements({ B1: { paths: [{ path: "docs/notes.md" }] } });
		writeClasses(classesFor(rows));
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("B1");
	});

	it("is BROKEN where the data file keys an entry the map lacks, naming it", () => {
		writeMap(baselineRows, sectionB("docs/notes.md"));
		write(
			data,
			JSON.stringify({ B99: { paths: [{ path: "docs/notes.md" }] } }),
		);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("B99");
	});
});

/*
 * Assertion 6 (mantahostels#970). Ids are permanent — mantahostels#892 forbade reusing and
 * renumbering them — and doc-map-restatements.json, -retired-vocabulary.json
 * and -superseded.json all key off them, so a duplicate silently hands one
 * entry's rows to another and cannot be fixed after the fact.
 */
describe("distinct Section B entry ids", () => {
	it("passes on a map whose entry ids are all distinct, and says how many", () => {
		writeMap(baselineRows, "### B1 · One\n\nx\n\n### B2 · Two\n\ny");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("2 distinct §B entry ids");
	});

	it("fails on a repeated id, naming it and the heading it first appeared under", () => {
		writeMap(
			baselineRows,
			"### B7 · The original\n\nx\n\n### B7 · The accidental twin\n\ny",
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 Section B entry id(s) appear more than once");
		expect(r.out).toContain("B7");
		expect(r.out).toContain("The original");
	});

	it("routes the fix to the allocator rather than to renumbering", () => {
		writeMap(baselineRows, "### B7 · One\n\nx\n\n### B7 · Two\n\ny");
		expect(check().out).toContain("alloc-entry");
	});

	it("counts a triplicate as two duplicates, not one", () => {
		writeMap(
			baselineRows,
			"### B7 · One\n\nx\n\n### B7 · Two\n\ny\n\n### B7 · Three\n\nz",
		);
		expect(check().out).toContain("2 Section B entry id(s)");
	});

	it("reads a heading inside a fenced block as an example, not an entry", () => {
		// The allocator skips fences too, so failing here would fail a document the
		// allocator is meanwhile handing that id out for.
		writeMap(
			baselineRows,
			"### B7 · One\n\n```\n### B7 · a quoted example\n```\n\ny",
		);
		expect(check().status).toBe(0);
	});

	it("does not confuse B10 with B1", () => {
		writeMap(baselineRows, "### B1 · One\n\nx\n\n### B10 · Ten\n\ny");
		expect(check().status).toBe(0);
	});
});

/*
 * Assertion 8 (mantahostels#1402; moved onto the sidecar's own keys at mantahostels#1849). A key is its
 * arbiter region id (`A:<path>`, lib/doc-map-regions.js), so two entries under
 * one key share one lock and their two writers contend — the failure the
 * per-row split ended. Assertion 6 above is the same guarantee for §B.
 *
 * The duplicate is written into the sidecar's BYTES, because that is the only
 * place it can exist: `JSON.parse` keeps the last of a repeated key and drops
 * the rest without a word.
 */
describe("distinct register keys", () => {
	/** The baseline sidecar's bytes, with `repeated`'s entry written a second time. */
	const withRepeat = (repeated: string) => {
		const data = classesFor(baselineRows) as Record<string, unknown>;
		const lines = Object.entries(data).map(
			([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
		);
		lines.push(
			`  ${JSON.stringify(repeated)}: ${JSON.stringify(data[repeated])}`,
		);
		return `{\n${lines.join(",\n")}\n}`;
	};

	it("passes on a sidecar whose keys are all distinct", () => {
		writeMap(baselineRows);
		expect(check().status).toBe(0);
	});

	it("fails on a key written twice, naming it", () => {
		writeMap(baselineRows);
		write(CLASSES, withRepeat("docs/notes.md"));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 key(s) appear twice in");
		expect(r.out).toContain("docs/notes.md");
	});

	it("says the region id is what a repeat breaks, not merely tidiness", () => {
		writeMap(baselineRows);
		write(CLASSES, withRepeat("docs/notes.md"));
		expect(check().out).toContain("arbiter region id");
	});

	// The summary tally is a separate expression from the findings, so a repeat
	// used to be reported beside "FAIL: 0 doc-map problem(s)" (mantahostels#1352). Two now,
	// not one: `withRepeat`'s hand-built bytes are also 2-space-indented and
	// unsorted, so SIDECAR-NOT-CANONICAL (mantahostels#3353) fires alongside the duplicate.
	it("counts the repeat in the summary tally", () => {
		writeMap(baselineRows);
		write(CLASSES, withRepeat("docs/notes.md"));
		expect(check().out).toContain("FAIL: 2 doc-map problem(s)");
	});

	// A `role` override is free prose and routinely holds a brace or a quote; a
	// naive scan for `"<key>":` would read one as a second top-level key.
	it("does not read a key out of an override's own prose", () => {
		writeMap(baselineRows);
		const data = classesFor(baselineRows) as Record<
			string,
			Record<string, unknown>
		>;
		data["docs/notes.md"].role = '{ "docs/notes.md": "not a key" }';
		writeClasses(data);
		expect(check().status).toBe(0);
	});

	// Two §A rows leading with one path is now assertion 17's fault to report:
	// §A is a projection, and the sidecar it projects cannot hold the duplicate.
	it("leaves a repeated §A row to the render-agreement assertion", () => {
		writeMap([...baselineRows, row("docs/notes.md")], "");
		const r = check();
		expect(r.out).not.toContain("appear twice in");
	});
});

/* Assertion 30 (mantahostels#3353). register-doc.js's header pins the sidecar's canonical
 * bytes — sorted keys, tab-indented JSON.stringify, one trailing newline,
 * non-ASCII left unescaped. */
describe("sidecar canonical serialisation", () => {
	const sortKeys = (data: Record<string, unknown>) => {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(data).sort()) sorted[key] = data[key];
		return sorted;
	};

	const canonicalBytes = (data: Record<string, unknown>) =>
		`${JSON.stringify(sortKeys(data), null, "\t")}\n`;

	it("passes on register-doc.js's own byte shape", () => {
		writeMap(baselineRows);
		expect(check().status).toBe(0);
	});

	it("fails when non-ASCII is escaped, naming the writer signature and the fix", () => {
		writeMap(baselineRows);
		const data = classesFor(baselineRows) as Record<
			string,
			Record<string, unknown>
		>;
		data["docs/notes.md"].section = "§Docs";
		// json.dump's ensure_ascii=True default escapes the § this writes literally.
		write(CLASSES, canonicalBytes(data).replace("§Docs", "\\u00a7Docs"));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("is not register-doc.js's canonical serialisation");
		expect(r.out).toContain("ensure_ascii");
		expect(r.out).toContain("node scripts/register-doc.js");
	});

	it("fails on a two-space indent, counting the differing lines and naming the fix", () => {
		writeMap(baselineRows);
		write(CLASSES, JSON.stringify(sortKeys(classesFor(baselineRows)), null, 2));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toMatch(
			/\d+ of \d+ line\(s\) differ from the canonical form/,
		);
		expect(r.out).toContain("node scripts/register-doc.js");
	});

	it("counts it in the summary tally", () => {
		writeMap(baselineRows);
		write(CLASSES, JSON.stringify(sortKeys(classesFor(baselineRows)), null, 2));
		expect(check().out).toContain("FAIL: 1 doc-map problem(s)");
	});
});

/* Assertion 31 (mantahostels#3412): `reader` on every prose key, from a closed vocabulary,
 * and on no other key. */
describe("the reader field", () => {
	const sidecar = () =>
		classesFor(baselineRows) as Record<string, Record<string, unknown>>;

	it("passes on each of the three tokens", () => {
		writeMap(baselineRows);
		const data = sidecar();
		data["docs/notes.md"].reader = "human";
		data["CLAUDE.md"].reader = "both";
		writeClasses(data);
		expect(check().status).toBe(0);
	});

	it("fails a misspelt token, naming the path, and stands §A's render down", () => {
		writeMap(baselineRows);
		const data = sidecar();
		data["docs/notes.md"].reader = "humans";
		writeClasses(data);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("carry a reader outside the vocabulary");
		expect(r.out).toContain('docs/notes.md — "humans"');
		expect(r.out).toContain("1 unknown reader token(s)");
	});

	it("fails a prose key with no reader, naming the registration command", () => {
		writeMap(baselineRows);
		const data = sidecar();
		delete data["docs/notes.md"].reader;
		writeClasses(data);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(".md or .html sidecar key(s) carry no reader");
		expect(r.out).toContain("  docs/notes.md");
		expect(r.out).toContain("--reader <token>");
	});

	it("fails a reader on a key that is not a prose document, naming the key", () => {
		const rows = [...baselineRows, row("docs/data.json")];
		writeMap(rows);
		track("docs/data.json", "{}\n");
		const data = classesFor(rows) as Record<string, Record<string, unknown>>;
		data["docs/data.json"].reader = "agent";
		writeClasses(data);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"carry a reader but are not a .md or .html document",
		);
		expect(r.out).toContain("  docs/data.json");
	});
});

/* Assertion 32 (mantahostels#3412): a documentation page's source must be one that may
 * have a page. */
describe("the page–source assertion", () => {
	const rows = [...baselineRows, row("docs/notes.html")];
	const withPage = (
		edit: (d: Record<string, Record<string, unknown>>) => void,
	) => {
		writeMap(rows);
		track("docs/notes.html", "<p>page</p>\n");
		const data = classesFor(rows) as Record<string, Record<string, unknown>>;
		data["docs/notes.html"].class = "derived";
		data["docs/notes.html"].reader = "both";
		data["docs/notes.html"].consumes = [{ kind: "path", ref: "docs/notes.md" }];
		data["docs/notes.md"].reader = "both";
		edit(data);
		writeClasses(data);
		return check();
	};

	it("passes a page whose source is registered and human-read", () => {
		expect(
			withPage(() => {
				/* no edit: the row as written passes */
			}).status,
		).toBe(0);
	});

	it("fails a page whose source has no key, naming the page and the source", () => {
		const r = withPage((d) => {
			(d["docs/notes.html"].consumes as { ref: string }[])[0].ref =
				"docs/gone.md";
		});
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/notes.html — source docs/gone.md has no key");
	});

	it("fails a page whose source is agent-read, naming the page and the source", () => {
		const r = withPage((d) => {
			d["docs/notes.md"].reader = "agent";
		});
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"docs/notes.html — source docs/notes.md is read by `agent` alone",
		);
	});

	it("resolves a suffix-spelt source ref to its one key, as assertion 25 does", () => {
		const r = withPage((d) => {
			(d["docs/notes.html"].consumes as { ref: string }[])[0].ref = "notes.md";
			d["docs/notes.md"].reader = "agent";
		});
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"docs/notes.html — source docs/notes.md is read by `agent` alone",
		);
	});
});

/*
 * Assertion 19 (mantahostels#1849). The class is the one judgement the sidecar carries, so
 * a token outside the five documented ones is a FAIL naming the path — never a
 * sixth value, and never an abort.
 */
describe("the class vocabulary", () => {
	const withClass = (cls: unknown) => {
		const data = classesFor(baselineRows) as Record<
			string,
			Record<string, unknown>
		>;
		data["docs/notes.md"].class = cls;
		return data;
	};

	it("passes on the five documented tokens", () => {
		writeMap(baselineRows);
		const data = classesFor(baselineRows) as Record<
			string,
			Record<string, unknown>
		>;
		data["docs/notes.md"].class = "free-edit";
		data["CLAUDE.md"].class = "binary-asset";
		writeClasses(data);
		expect(check().status).toBe(0);
	});

	it("fails a token outside them, naming the path and the token", () => {
		writeMap(baselineRows);
		writeClasses(withClass("stable"));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("outside the documented vocabulary");
		expect(r.out).toContain("docs/notes.md — `stable`");
	});

	it("FAILs rather than aborting, so the rest of the run still reports", () => {
		writeMap(baselineRows);
		writeClasses(withClass("stable"));
		const r = check();
		// 2 would be BROKEN — the loader's own throw, which this replaces — and
		// an abort would cut the report off before the census below.
		expect(r.status).toBe(1);
		expect(r.out).toContain("restatement path(s) across");
	});

	it("says §A's render and the role cap went unchecked while it stands", () => {
		writeMap(baselineRows);
		writeClasses(withClass("stable"));
		expect(check().out).toContain("unknown class token(s)");
	});

	// mantahostels#3545: the third finding to refuse a commit above "FAIL: 0 doc-map
	// problem(s)" — the register-key repeat at :2053 and the stray at :2474 were
	// the first two. The tally reads off the FAIL findings, so this counts itself.
	it("counts the unknown token in the summary tally", () => {
		writeMap(baselineRows);
		writeClasses(withClass("stable"));
		expect(check().out).toContain("FAIL: 1 doc-map problem(s)");
	});

	it("takes a qualifier beside a real token, and does not vet it", () => {
		writeMap(baselineRows);
		const data = classesFor(baselineRows) as Record<
			string,
			Record<string, unknown>
		>;
		data["docs/notes.md"].classQualifier = "(for code rules) \u00b7 consumer";
		writeClasses(data);
		expect(check().status).toBe(0);
	});
});

/* Assertion 7 (mantahostels#1229). */
describe("dense Section C route ids", () => {
	const route = (id: string, read = "`notes.md`") =>
		[`### ${id} \u00b7 A question?`, `- **Read:** ${read}`].join("\n");

	const routes = (...ids: string[]) => ids.map((id) => route(id)).join("\n\n");

	it("passes on the dense run C1..Cn", () => {
		writeMap(baselineRows, routes("C1", "C2", "C3"));
		expect(check().status).toBe(0);
	});

	it("passes when the headings sit in reading order, not numeric order", () => {
		writeMap(baselineRows, routes("C1", "C3", "C2"));
		expect(check().status).toBe(0);
	});

	it("passes on a map with no routes at all", () => {
		writeMap(baselineRows);
		expect(check().status).toBe(0);
	});

	it("fails naming the absent id when a middle route is deleted", () => {
		writeMap(baselineRows, routes("C1", "C2", "C4"));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("dense run C1-C4");
		// the absent id on its own item line, not merely inside the header range
		expect(r.out).toContain("\n  C3 — no route carries this id");
		// and nothing else fired
		expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
	});

	// The run is measured against the highest id, so C4 — a legitimate permanent
	// route sitting above the gap — is never itself accused.
	it("does not accuse the route above the gap", () => {
		writeMap(baselineRows, routes("C1", "C2", "C4"));
		expect(check().out).not.toContain("C4 —");
	});

	it("fails on two routes sharing an id, saying so", () => {
		writeMap(baselineRows, routes("C1", "C2", "C2"));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("C2 — heads more than one route");
	});

	// Number("C01") is 1, so a leading zero survives the run check — but the id
	// is then citable only as §C01, which no sidecar spells.
	it("fails on a leading-zero id, naming the id and the rule it breaks", () => {
		writeMap(baselineRows, routes("C01", "C2", "C3"));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("C01 — ids run from C1 and carry no leading zero");
	});

	it("fails on a C0 heading", () => {
		writeMap(baselineRows, routes("C0", "C1", "C2"));
		expect(check().status).toBe(1);
	});

	// The map quotes its own formats; a fenced example must not manufacture a gap.
	it("ignores a route heading inside a fenced block", () => {
		writeMap(
			baselineRows,
			[
				routes("C1", "C2"),
				"```",
				"### C40 \u00b7 a quoted example",
				"```",
			].join("\n\n"),
		);
		expect(check().status).toBe(0);
	});

	it("routes the fix to repointing rather than renumbering", () => {
		writeMap(baselineRows, routes("C1", "C3"));
		const r = check();
		expect(r.out).toContain("repointed, never deleted");
		expect(r.out).toContain("renumbering breaks those citers");
	});

	it("annotates the gap under GITHUB_ACTIONS", () => {
		writeMap(baselineRows, routes("C1", "C3"));
		const r = check({ GITHUB_ACTIONS: "true" });
		expect(r.stdout).toContain("::error::");
		expect(r.stdout).toContain("dense run");
	});

	it("carries the ROUTE-ID-GAP tag and its ids in --json", () => {
		writeMap(baselineRows, routes("C1", "C3"));
		const r = check({}, "--json");
		const findings = JSON.parse(r.stdout).findings as {
			tag: string;
			ids?: { id: string; why: string }[];
		}[];
		const gap = findings.find((f) => f.tag === "ROUTE-ID-GAP");
		expect(gap?.ids).toEqual([{ id: "C2", why: "no route carries this id" }]);
	});

	/* Everything above the highest surviving id is invisible, so deleting the
	 * top route leaves the run dense and passes. Catching it needs a
	 * retired-route sidecar, priced and declined at mantahostels#1229. */
	it("does not catch the highest-numbered routes being deleted", () => {
		writeMap(baselineRows, routes("C1", "C2"));
		expect(check().status).toBe(0);
	});
});

/* Assertion 9 (mantahostels#1352). */
describe("Section B entries inside Section B", () => {
	const entry = (id: string) => `### ${id} · A figure`;

	/** §B entries, then a Section C heading, then whatever was appended below it. */
	const withSectionC = (inB: string[], belowC: string[]) =>
		[
			...inB.map(entry),
			"## Section C — question routes",
			"### C1 · A question?",
			"- **Read:** `notes.md`",
			...belowC.map(entry),
		].join("\n\n");

	it("passes when every entry sits above Section C", () => {
		writeMap(baselineRows, withSectionC(["B1", "B2", "B3"], []));
		expect(check().status).toBe(0);
	});

	it("names the stray id and its line when one sits below Section C", () => {
		writeMap(baselineRows, withSectionC(["B1", "B2"], ["B3"]));
		const r = check();
		expect(r.out).toContain(
			"1 Section B entry heading(s) sit outside Section B",
		);
		expect(r.out).toMatch(/\n {2}B3 — line \d+, outside Section B/);
		// the entries that are in range are not accused
		expect(r.out).not.toContain("B1 —");
	});

	// mantahostels#3525: the second finding to refuse a commit above "FAIL: 0 doc-map
	// problem(s)" — the register-key repeat at :2053 was the first.
	it("refuses the commit and counts the stray in the summary tally", () => {
		writeMap(baselineRows, withSectionC(["B1", "B2"], ["B3"]));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
	});

	it("names every stray, not just the first", () => {
		writeMap(baselineRows, withSectionC(["B1"], ["B2", "B3"]));
		expect(check().out).toContain("2 Section B entry heading(s)");
	});

	// A stray below a later `## ` heading is as invisible as one below §C —
	// two host entries once landed under `## Capture and placement`.
	it("catches an entry below a section further down than Section C", () => {
		writeMap(
			baselineRows,
			[withSectionC(["B1"], []), "## Capture and placement", entry("B2")].join(
				"\n\n",
			),
		);
		expect(check().out).toContain("B2 — line");
	});

	it("routes the fix to relocation, never a rewrite", () => {
		writeMap(baselineRows, withSectionC(["B1"], ["B2"]));
		const r = check();
		expect(r.out).toContain("in id order, block intact");
		expect(r.out).toContain("relocation, never a rewrite");
	});

	// The map quotes its own formats; a fenced example below §C is not a stray.
	it("ignores an entry heading inside a fenced block below Section C", () => {
		writeMap(
			baselineRows,
			[withSectionC(["B1"], []), "```", entry("B99"), "```"].join("\n\n"),
		);
		expect(check().out).not.toContain("outside Section B");
	});

	it("carries the STRAY-ENTRY tag and its ids in --json", () => {
		writeMap(baselineRows, withSectionC(["B1"], ["B2"]));
		const findings = JSON.parse(check({}, "--json").stdout).findings as {
			tag: string;
			ids?: string[];
			key?: string;
		}[];
		const stray = findings.find((f) => f.tag === "STRAY-ENTRY");
		expect(stray?.ids?.length).toBe(1);
		expect(stray?.ids?.[0]).toContain("B2 — line");
		// The line number is masked: it moves with every edit above it (#1591).
		expect(stray?.key).toBe("STRAY-ENTRY\tB2 — line #, outside Section B");
	});
});

/*
 * Assertion 10 (mantahostels#1458). Presence only, exactly as guard-issue-close.js gates
 * `**Outstanding:**` — the two accepted forms are `**Settled at #<n>**` and
 * `**Settled at:** none — <why>`, and no checker can judge which is true.
 */
describe("the `Settled at` bullet", () => {
	const entry = (id: string, bullet = "") =>
		[`### ${id} · A figure`, bullet].filter(Boolean).join("\n\n");

	it("fails on an entry carrying no `Settled at` bullet, naming the id", () => {
		writeMap(baselineRows, entry("B1"), { rawEntries: true });
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 Section B entr(ies) carry no `Settled at`");
		expect(r.out).toContain("B1");
	});

	it("passes on `**Settled at #<n>**`", () => {
		writeMap(
			baselineRows,
			entry("B1", `${pointer(1)}\n- **Settled at #942**, 23 August 2026.`),
			{
				rawEntries: true,
			},
		);
		expect(check().status).toBe(0);
	});

	it("passes on the `none` form, where nothing decided the figure", () => {
		writeMap(
			baselineRows,
			entry(
				"B1",
				`${pointer(1)}\n- **Settled at:** none — inherited from the brand sheet.`,
			),
			{ rawEntries: true },
		);
		expect(check().status).toBe(0);
	});

	it("names every entry lacking it, not just the first", () => {
		writeMap(baselineRows, [entry("B1"), entry("B2")].join("\n\n"), {
			rawEntries: true,
		});
		expect(check().out).toContain("2 Section B entr(ies)");
	});

	it("routes the fix to the two accepted spellings", () => {
		writeMap(baselineRows, entry("B1"), { rawEntries: true });
		const r = check();
		expect(r.out).toContain("**Settled at #<n>**");
		expect(r.out).toContain("**Settled at:** none");
	});

	it("carries the SETTLED-AT-MISSING tag and its ids in --json", () => {
		writeMap(baselineRows, [entry("B1"), entry("B2")].join("\n\n"), {
			rawEntries: true,
		});
		const findings = JSON.parse(check({}, "--json").stdout).findings as {
			tag: string;
			ids?: string[];
		}[];
		const missing = findings.find((f) => f.tag === "SETTLED-AT-MISSING");
		expect(missing?.ids).toEqual(["B1", "B2"]);
	});
});

/*
 * Assertion 11 (mantahostels#1474). `rawEntries: true` throughout: the fixture helpers
 * supply a conforming pointer, which is exactly what these tests must not get
 * for free.
 */
describe("Section B pointer shape", () => {
	const marker = " ⚠ **Restated-in is known incomplete**.";
	const supersedes = "- **Supersedes:** see `docs/doc-map-superseded.json`.";
	const entry = (id: string, ...bullets: string[]) =>
		[`### ${id} · A figure`, "", "- **Settled at #1**", ...bullets].join("\n");

	const fixture = (
		body: string,
		restatements: Record<string, RestatementEntry>,
		superseded: Record<string, SupersededEntry> = {},
	) => {
		writeMap(baselineRows, body, { rawEntries: true });
		writeRestatements(restatements);
		writeSuperseded(superseded);
		// writeRestatements re-stamps pointers, which would erase what is under
		// test — put the fixture's own body back.
		track(MAP, mapDoc(baselineRows, body));
		writeHighWater();
	};

	const oneNeedle = { text: "the old value", needles: [] as never[] };

	it("passes the counted pointer, the `none` form and the Supersedes pointer", () => {
		fixture(
			[
				entry("B1", pointer(2)),
				entry("B2", NO_POINTER),
				entry("B3", pointer(1), supersedes),
			].join("\n\n"),
			{
				B1: { paths: [{ path: "docs/notes.md" }, { path: "CLAUDE.md" }] },
				B3: { paths: [{ path: "docs/notes.md" }] },
			},
			{ B3: oneNeedle },
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("sidecar-agreeing pointer");
	});

	it("passes the bare known-incomplete marker as a suffix on either form", () => {
		fixture(
			[
				entry("B1", `${pointer(1)}${marker}`),
				entry("B2", `${NO_POINTER.slice(0, -1)}${marker}`),
			].join("\n\n"),
			{ B1: { paths: [{ path: "docs/notes.md" }] } },
		);
		expect(check().status).toBe(0);
	});

	it("fails a pointer whose count disagrees with its key, naming both figures", () => {
		fixture(entry("B1", pointer(3)), {
			B1: { paths: [{ path: "docs/notes.md" }] },
		});
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("B1 — pointer says 3 path(s), the sidecar holds 1");
	});

	it("fails a pointer naming a key the sidecar does not hold", () => {
		fixture([entry("B1", pointer(1)), entry("B2", pointer(1))].join("\n\n"), {
			B1: { paths: [{ path: "docs/notes.md" }] },
		});
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("B2 — points at doc-map-restatements.json");
		expect(r.out).toContain("holds no key for it");
	});

	it("fails a sidecar key whose entry carries no `Restated in` bullet", () => {
		fixture(entry("B1"), { B1: { paths: [{ path: "docs/notes.md" }] } });
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("carries no `Restated in` bullet");
	});

	it("fails a `none` bullet on an entry the sidecar does key, naming the entry", () => {
		fixture(entry("B1", NO_POINTER), {
			B1: { paths: [{ path: "docs/notes.md" }] },
		});
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("B1 — says `none` while");
	});

	it("fails the pre-migration em-dash bullet, prose and all, saying the Restated in bullet matches no template", () => {
		fixture(
			entry(
				"B1",
				"- **Restated in — 1 path, in `docs/doc-map-restatements.json`:** `docs/notes.md` §1.",
			),
			{ B1: { paths: [{ path: "docs/notes.md" }] } },
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("`Restated in` matches no template");
	});

	it("fails a `Supersedes` bullet still carrying its prose", () => {
		fixture(
			entry("B1", pointer(1), "- **Supersedes:** the old **$18** figure."),
			{ B1: { paths: [{ path: "docs/notes.md" }] } },
			{ B1: oneNeedle },
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("`Supersedes` matches no template");
	});

	it("passes the parenthetical `Supersedes` spelling §B8 needs", () => {
		fixture(
			entry(
				"B1",
				pointer(1),
				"- **Supersedes (basis, not figure):** see `docs/doc-map-superseded.json`.",
			),
			{ B1: { paths: [{ path: "docs/notes.md" }] } },
			{ B1: oneNeedle },
		);
		expect(check().status).toBe(0);
	});

	it("fails a `Supersedes` pointer with no key in the superseded file, naming doc-map-superseded.json", () => {
		fixture(entry("B1", pointer(1), supersedes), {
			B1: { paths: [{ path: "docs/notes.md" }] },
		});
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("doc-map-superseded.json, which holds no key");
	});

	it("fails a superseded key whose entry carries no `Supersedes` bullet", () => {
		fixture(
			entry("B1", pointer(1)),
			{ B1: { paths: [{ path: "docs/notes.md" }] } },
			{ B1: oneNeedle },
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("carries no `Supersedes` bullet");
	});

	it("fails a superseded key naming no §B entry", () => {
		fixture(
			entry("B1", pointer(1), supersedes),
			{ B1: { paths: [{ path: "docs/notes.md" }] } },
			{ B1: oneNeedle, B9: oneNeedle },
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("B9 — doc-map-superseded.json keys it");
		expect(r.out).toContain("holds no such entry");
	});

	it("skips the key half, and says so, when the superseded file is absent", () => {
		fixture(
			entry("B1", pointer(1), supersedes),
			{ B1: { paths: [{ path: "docs/notes.md" }] } },
			{ B1: oneNeedle },
		);
		fs.rmSync(path.join(repo, "docs", "doc-map-superseded.json"));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("was not reconciled");
		expect(r.out).not.toContain("holds no key for it");
	});

	it("WARNs rather than FAILs while the map is dirty, naming the entry and reading it as a live session mid-edit", () => {
		fixture(entry("B1", pointer(3)), {
			B1: { paths: [{ path: "docs/notes.md" }] },
		});
		const r = check({}, MAP, "--map-dirty");
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		expect(r.out).toContain("B1 — pointer says 3 path(s)");
		expect(r.out).toContain("half-rewritten entry is a live session mid-edit");
	});

	/* The `isDirty(mapPath)` limb of `mapDirty`, which no caller passing
	 * --map-dirty ever reaches. mantahostels#1193 gave a dirty map the WARN; that softening
	 * has to hold for a caller that hands over the real tracked path and no
	 * flag, which is every caller but .husky/pre-commit. */
	it("WARNs off its own git read, with no --map-dirty flag, naming the entry and its pointer count", () => {
		fixture(entry("B1", pointer(1)), {
			B1: { paths: [{ path: "docs/notes.md" }] },
		});
		git("commit", "-qm", "base");
		// dirty against HEAD, and nothing tells the checker so
		track(MAP, mapDoc(baselineRows, entry("B1", pointer(3))));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		expect(r.out).toContain("B1 — pointer says 3 path(s)");
	});

	/* mantahostels#1191: .husky/pre-commit hands over a `$(mktemp -d)` copy, a path with no
	 * git identity, so the limb above reads it clean however dirty the real map
	 * is. That is the whole reason --map-dirty exists — without the flag the
	 * copy must still FAIL. */
	it("FAILs on an out-of-repo copy of a dirty map, absent the flag, naming the entry and its pointer count", () => {
		fixture(entry("B1", pointer(1)), {
			B1: { paths: [{ path: "docs/notes.md" }] },
		});
		git("commit", "-qm", "base");
		track(MAP, mapDoc(baselineRows, entry("B1", pointer(3))));
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-copy-"));
		for (const f of [
			MAP,
			RESTATEMENTS,
			SUPERSEDED,
			HIGH_WATER,
			CLASSES,
			RETIRED_VOCABULARY,
		])
			fs.writeFileSync(
				path.join(dir, path.basename(f)),
				fs.readFileSync(path.join(repo, f)),
			);
		const r = check({}, path.join(dir, "doc-map.md"), "--data-dir", dir);
		expect(r.status).toBe(1);
		expect(r.out).toContain("B1 — pointer says 3 path(s)");
	});

	it("prints the three templates when it FAILs", () => {
		fixture(entry("B1", pointer(3)), {
			B1: { paths: [{ path: "docs/notes.md" }] },
		});
		const r = check();
		expect(r.out).toContain(
			"- **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.",
		);
		expect(r.out).toContain(
			"- **Restated in:** none — <one clause saying why>.",
		);
		expect(r.out).toContain(
			"- **Supersedes:** see `docs/doc-map-superseded.json`.",
		);
	});

	it("carries the POINTER-SHAPE tag and its items in --json", () => {
		fixture(entry("B1", pointer(3)), {
			B1: { paths: [{ path: "docs/notes.md" }] },
		});
		const findings = JSON.parse(check({}, "--json").stdout).findings as {
			tag: string;
			pointers?: string[];
		}[];
		const fault = findings.find((f) => f.tag === "POINTER-SHAPE");
		expect(fault?.pointers?.[0]).toContain("B1 — pointer says 3 path(s)");
	});

	/* mantahostels#2293: the Retired vocabulary bullet's free-text phrase count, checked
	 * against docs/doc-map-retired-vocabulary.json the same way Restated in's
	 * count is checked against its own sidecar. */
	describe("the Retired vocabulary bullet's phrase count", () => {
		const retired2 =
			"- **Retired vocabulary:** 2 phrases, in `docs/doc-map-retired-vocabulary.json`.";
		const vocabOf = (n: number) => ({
			literal: `phrase ${n}`,
		});

		it("passes when the prose count agrees with the sidecar", () => {
			fixture(entry("B1", pointer(1), retired2), {
				B1: { paths: [{ path: "docs/notes.md" }] },
			});
			writeRetiredVocabulary({ B1: { phrases: [vocabOf(1), vocabOf(2)] } });
			expect(check().status).toBe(0);
		});

		it("fails when the prose count disagrees with the sidecar", () => {
			fixture(entry("B1", pointer(1), retired2), {
				B1: { paths: [{ path: "docs/notes.md" }] },
			});
			writeRetiredVocabulary({
				B1: { phrases: [vocabOf(1), vocabOf(2), vocabOf(3)] },
			});
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				"B1 — `Retired vocabulary` bullet says 2 phrase(s), " +
					"doc-map-retired-vocabulary.json holds 3",
			);
			expect(r.out).toContain(
				"editing docs/doc-map-retired-vocabulary.json or the prose",
			);
		});

		it("fails a bullet stating no phrase count", () => {
			fixture(
				entry(
					"B1",
					pointer(1),
					"- **Retired vocabulary:** grep these, in `docs/doc-map-retired-vocabulary.json`.",
				),
				{ B1: { paths: [{ path: "docs/notes.md" }] } },
			);
			writeRetiredVocabulary({ B1: { phrases: [vocabOf(1)] } });
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				"B1 — `Retired vocabulary` bullet states no phrase count",
			);
		});

		it("is silent on an entry the sidecar does not key", () => {
			fixture(entry("B1", pointer(1), retired2), {
				B1: { paths: [{ path: "docs/notes.md" }] },
			});
			// Overwrite writeMap's empty default with an unrelated key — the
			// mismatch this assertion checks needs a B1 key to compare against;
			// an uncovered entry is check-retired-vocabulary.js's fault to
			// raise, not this one's.
			writeRetiredVocabulary({ B9: { phrases: [vocabOf(1)] } });
			const r = check();
			expect(r.status).toBe(0);
		});

		/* mantahostels#2324: an empty sidecar is a legitimate "nothing retired yet" state,
		 * not corruption. */
		it("is silent on an empty sidecar, never BROKEN", () => {
			fixture(entry("B1", pointer(1), retired2), {
				B1: { paths: [{ path: "docs/notes.md" }] },
			});
			writeRetiredVocabulary({});
			const r = check();
			expect(r.status).toBe(0);
		});

		it("is silent, and says so, when the sidecar is absent", () => {
			fixture(entry("B1", pointer(1), retired2), {
				B1: { paths: [{ path: "docs/notes.md" }] },
			});
			fs.rmSync(path.join(repo, RETIRED_VOCABULARY));
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain("was not reconciled");
		});

		it("is BROKEN where the sidecar will not parse, saying it is unreadable", () => {
			fixture(entry("B1", pointer(1), retired2), {
				B1: { paths: [{ path: "docs/notes.md" }] },
			});
			write(RETIRED_VOCABULARY, "{ not json");
			const r = check();
			expect(r.status).toBe(2);
			expect(r.out).toContain("retired-vocabulary data file unreadable");
		});
	});
});

/*
 * Assertions 12 and 13 (#2339). Ids are permanent (mantahostels#892): a reused
 * one makes a reference to the removed entry resolve to the new one. The mark
 * is the highest id ever removed, so a new id above it was never held.
 */
describe("the high-water mark", () => {
	const entry = (id: string) => `### ${id} · Figure ${id}\n\nx`;
	// Tracked, so HEAD holds a mark to compare against, and so registered.
	const rows = [...baselineRows, row(HIGH_WATER)];
	const stageMap = (ids: string[], mark: number) => {
		writeMap(rows, ids.map(entry).join("\n\n"));
		track(HIGH_WATER, JSON.stringify({ highWaterMark: mark }));
	};
	const commitMap = (ids: string[], mark: number) => {
		stageMap(ids, mark);
		git("commit", "-qm", "base");
	};

	it("passes a new id above the mark", () => {
		commitMap(["B1"], 3);
		stageMap(["B1", "B4"], 3);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"no id at or below the high-water mark reused, and none removed above it",
		);
	});

	it("refuses a new id at or below the mark, naming it and offering alloc-entry", () => {
		commitMap(["B1"], 3);
		stageMap(["B1", "B3"], 3);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"1 §B id(s) new since HEAD sit at or below the high-water mark, B3:",
		);
		expect(r.out).toContain("alloc-entry");
	});

	/* The commit adding an entry always has a dirty map, so a softened check
	 * would refuse nothing. */
	it("still refuses a reused id under --map-dirty", () => {
		commitMap(["B1"], 3);
		stageMap(["B1", "B2"], 3);
		const r = check({}, MAP, "--map-dirty");
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 §B id(s) new since HEAD sit at or below");
	});

	it("compares ids as numbers, so B10 sits above a mark of 9", () => {
		commitMap(["B1"], 9);
		stageMap(["B1", "B10"], 9);
		expect(check().status).toBe(0);
	});

	it("refuses a removal the mark is not raised to, naming the mark to set", () => {
		commitMap(["B1", "B2"], 0);
		stageMap(["B1"], 0);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("B2 leaves the map, above the mark B0");
		expect(r.out).toContain(`Set \`highWaterMark\` in ${HIGH_WATER} to 2`);
	});

	it("passes a removal that raises the mark to its id", () => {
		commitMap(["B1", "B2"], 0);
		stageMap(["B1"], 2);
		expect(check().status).toBe(0);
	});

	it("refuses a lowered mark", () => {
		commitMap(["B1"], 3);
		stageMap(["B1"], 2);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("the mark falls from HEAD's B3 to B2");
	});

	it("says the mark went unchecked where HEAD holds no copy of the map", () => {
		stageMap(["B1"], 0);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("the high-water mark was not checked against it");
	});

	it("is BROKEN where the mark file is absent, saying how to write it", () => {
		writeMap(baselineRows, entry("B1"));
		fs.rmSync(path.join(repo, HIGH_WATER));
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain(`${HIGH_WATER} is missing`);
		expect(r.out).toContain('{ "highWaterMark": <n> }');
	});

	it("is BROKEN where the mark is not a non-negative integer", () => {
		writeMap(baselineRows, entry("B1"));
		write(HIGH_WATER, JSON.stringify({ highWaterMark: "B3" }));
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("holds no `highWaterMark`");
	});

	it("carries the REUSED-ENTRY-ID tag and its ids in --json", () => {
		commitMap(["B1"], 3);
		stageMap(["B1", "B2", "B3"], 3);
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "REUSED-ENTRY-ID",
		);
		expect(finding.ids).toEqual(["B2", "B3"]);
	});
});

/*
 * Assertion 25 (mantahostels#2419). `consumes` typed as a reference list: the checker
 * knows what a token is before it tries to resolve it, so a code identifier in
 * backticks is never mistaken for a dead file.
 */
describe("typed Consumes references", () => {
	/** The baseline sidecar with one document's `consumes` typed. */
	const withConsumes = (refs: unknown, key = "docs/notes.md") => {
		const data = classesFor(baselineRows) as Record<
			string,
			Record<string, unknown>
		>;
		data[key].consumes = refs;
		writeClasses(data);
	};

	it("passes a reference list every element of which resolves", () => {
		writeMap(baselineRows);
		withConsumes([
			{ kind: "path", ref: "CLAUDE.md", gloss: "the contract it applies" },
			{ kind: "figure", ref: "B1" },
			{ kind: "issue", ref: "2419" },
			{ kind: "external", ref: "~/.claude/settings.json" },
			{ kind: "note", ref: "process.execPath" },
		]);
		expect(check().status).toBe(0);
	});

	it("fails an entry holding a string, naming the doc, and stands the sidecar loader down rather than aborting", () => {
		writeMap(baselineRows);
		withConsumes("`docs/gone.md` (a note deleted three weeks ago)");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("are not typed references at all");
		expect(r.out).toContain("docs/notes.md →");
		expect(r.out).toContain("is not a list of typed references");
		expect(r.out).toContain("The sidecar will not load until");
		// The string stands loadDocClasses down rather than aborting the run.
		expect(r.out).toContain("malformed `consumes` reference(s) in");
	});

	it("fails a dead `path`, naming the document and the reference", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "path", ref: "docs/gone.md" }]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("resolve to nothing");
		expect(r.out).toContain("docs/notes.md → docs/gone.md");
		expect(r.out).toContain("names no tracked file and nothing on disk");
		expect(r.out).toContain("npm run gen:doc-map-section-a");
	});

	it("WARNs at exit 0 on a `path` present on disk but untracked, naming the reference and saying to commit the file", () => {
		writeMap(baselineRows);
		write("docs/pending.md", "pending\n");
		withConsumes([{ kind: "path", ref: "docs/pending.md" }]);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		expect(r.out).toContain("docs/notes.md → docs/pending.md");
		expect(r.out).toContain("present on disk but not yet tracked");
		expect(r.out).toContain("Commit the file");
	});

	it("fails a `glob` matching no tracked file, naming the glob", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "glob", ref: "docs/nothing/*" }]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/nothing/* — matches no tracked file");
	});

	it("passes a `glob` matching at least one tracked file", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "glob", ref: "docs/*" }]);
		expect(check().status).toBe(0);
	});

	it("fails a `figure` naming no live entry", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "figure", ref: "B99" }]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("§B99 heads no Section B entry");
	});

	/* A pre-commit hook must never wait on `gh`, and a closed issue is corpus
	 * here rather than history — so shape is checked and existence is not. */
	it("fails a malformed `issue`, whose shape is all that is checked, saying it is not a bare issue number", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "issue", ref: "#457" }]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("is not a bare issue number");
	});

	it("passes an issue number no repository need hold", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "issue", ref: "999999" }]);
		expect(check().status).toBe(0);
	});

	it("never fails `external` or `note`, however unresolvable", () => {
		writeMap(baselineRows);
		withConsumes([
			{ kind: "external", ref: "~/.claude/nothing-here.sh" },
			{ kind: "note", ref: "process.execPath" },
		]);
		expect(check().status).toBe(0);
	});

	it("fails an unknown `kind`, keeping the vocabulary closed, naming the reference and its kind, and stands the sidecar loader down rather than aborting", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "card", ref: "search-results" }]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/notes.md → search-results");
		expect(r.out).toContain('carries kind "card"');
		expect(r.out).toContain("are not typed references at all");
		// The malformed reference stands loadDocClasses down rather than
		// aborting the run over a fault already named here.
		expect(r.out).toContain("malformed `consumes` reference(s) in");
	});

	it("fails an element that is not a reference object at all", () => {
		writeMap(baselineRows);
		withConsumes(["docs/notes.md"]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("is not a { kind, ref } reference object");
	});

	/* A dirty map is a session mid-edit whose sidecar is written last. */
	it("softens the whole block to WARN while the map is dirty, saying to land the edit", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "path", ref: "docs/gone.md" }]);
		git("commit", "-qm", "base");
		write(MAP, `${fs.readFileSync(path.join(repo, MAP), "utf8")}\nedited\n`);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		expect(r.out).toContain("resolve to nothing");
		expect(r.out).toContain("Land the edit");
	});

	/* .husky/pre-commit hands the flag rather than a tracked path (mantahostels#1191). */
	it("softens on the --map-dirty flag over a clean map, warning that the reference resolves to nothing", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "path", ref: "docs/gone.md" }]);
		git("commit", "-qm", "base");
		const r = check({}, "--map-dirty");
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		expect(r.out).toContain("resolve to nothing");
	});

	/* A dirty map excuses a pointer whose target moved in a commit the sidecar
	 * has not caught up with. It excuses nothing about a reference that is not
	 * a reference — which is the fault that makes the sidecar unloadable. */
	it("does not soften a MALFORMED reference while the map is dirty", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "card", ref: "search-results" }]);
		git("commit", "-qm", "base");
		write(MAP, `${fs.readFileSync(path.join(repo, MAP), "utf8")}\nedited\n`);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("are not typed references at all");
	});

	/* "No override" stays exactly one state (`null`), never two. */
	it("is BROKEN on a `consumes` present but empty, asking for a non-empty array, and passes a null one", () => {
		writeMap(baselineRows);
		withConsumes([]);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("non-empty array");

		writeMap(baselineRows);
		withConsumes(null);
		expect(check().status).toBe(0);
	});

	/* Assertion 26 (mantahostels#2647). The `with <other-ref>:` prefix is a pointer, and a
	 * reordered cell strands it. */
	it("fails a pair-scope prefix naming the wrong neighbour", () => {
		writeMap(baselineRows);
		withConsumes([
			{ kind: "figure", ref: "B1" },
			{ kind: "issue", ref: "2419" },
			{ kind: "path", ref: "CLAUDE.md", gloss: "with §B1: the pair" },
		]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("naming the wrong neighbour");
		expect(r.out).toContain("the reference before it is #2419");
	});

	it("passes a pair-scope prefix naming the reference beside it", () => {
		writeMap(baselineRows);
		withConsumes([
			{ kind: "figure", ref: "B1" },
			{ kind: "path", ref: "CLAUDE.md", gloss: "with §B1: the pair" },
		]);
		expect(check().status).toBe(0);
	});

	it("names the way out, not just the fault", () => {
		writeMap(baselineRows);
		withConsumes([
			{ kind: "figure", ref: "B1" },
			{ kind: "issue", ref: "2419" },
			{ kind: "path", ref: "CLAUDE.md", gloss: "with §B1: the pair" },
		]);
		const r = check();
		expect(r.out).toContain("Repoint the prefix");
		expect(r.out).toContain("npm run gen:doc-map-section-a");
	});

	/* Both ends of the pointer sit in one sidecar cell, and the cell reorder
	 * that strands a prefix is exactly what dirties the map — so softening
	 * would waive the fault at the only gate that sees it (mantahostels#2647 review). */
	it("does not soften a pair-scope fault while the map is dirty", () => {
		writeMap(baselineRows);
		withConsumes([
			{ kind: "figure", ref: "B1" },
			{ kind: "issue", ref: "2419" },
			{ kind: "path", ref: "CLAUDE.md", gloss: "with §B1: the pair" },
		]);
		git("commit", "-qm", "base");
		write(MAP, `${fs.readFileSync(path.join(repo, MAP), "utf8")}\nedited\n`);
		expect(check().status).toBe(1);
	});

	/* .husky/pre-commit hands the flag rather than a tracked path (mantahostels#1191). */
	it("does not soften a pair-scope fault on the --map-dirty flag", () => {
		writeMap(baselineRows);
		withConsumes([
			{ kind: "figure", ref: "B1" },
			{ kind: "issue", ref: "2419" },
			{ kind: "path", ref: "CLAUDE.md", gloss: "with §B1: the pair" },
		]);
		git("commit", "-qm", "base");
		expect(check({}, "--map-dirty").status).toBe(1);
	});

	it("carries the PAIR-SCOPE tag and its items in --json", () => {
		writeMap(baselineRows);
		withConsumes([
			{ kind: "figure", ref: "B1" },
			{ kind: "issue", ref: "2419" },
			{ kind: "path", ref: "CLAUDE.md", gloss: "with §B1: the pair" },
		]);
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "PAIR-SCOPE",
		);
		expect(finding.references).toEqual([
			{
				doc: "docs/notes.md",
				ref: "`CLAUDE.md`",
				why: "scopes back to §B1, but the reference before it is #2419",
			},
		]);
	});

	it("carries the DEAD-CONSUMES tag and its items in --json", () => {
		writeMap(baselineRows);
		withConsumes([{ kind: "path", ref: "docs/gone.md" }]);
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "DEAD-CONSUMES",
		);
		expect(finding.references).toEqual([
			{
				doc: "docs/notes.md",
				ref: "docs/gone.md",
				why: "names no tracked file and nothing on disk",
			},
		]);
	});
});

/*
 * Assertion 14 (mantahostels#1384, on mantahostels#1350's ruling). The commit that ADDS a §B entry is
 * refused over 300 prose words, and a commit that merely edits one is not —
 * the on-touch scope mantahostels#1311 refused. Every fixture below therefore commits a
 * base first, since "new" means "absent from HEAD's copy of the map".
 */
describe("the new-entry prose cap", () => {
	const entry = (id: string, n: number) =>
		`### ${id} · Figure ${id}\n\n${words(n)}`;

	const base = (sectionB: string) => {
		writeMap(baselineRows, sectionB);
		git("commit", "-qm", "base");
	};

	it("passes when a new entry is at the cap", () => {
		base(entry("B1", 10));
		writeMap(baselineRows, `${entry("B1", 10)}\n\n${entry("B2", 300)}`);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"no entry new since HEAD over the 300-word prose cap",
		);
	});

	it("fails on a new entry over the cap, naming the id and the excess", () => {
		base(entry("B1", 10));
		writeMap(baselineRows, `${entry("B1", 10)}\n\n${entry("B2", 400)}`);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"1 §B entr(ies) new since HEAD exceed the 300-word prose cap",
		);
		expect(r.out).toContain("B2 — 400 prose words, 100 over the 300-word cap");
		// The over-cap entry is counted in the tally the summary line reports, not
		// merely printed above it.
		expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
	});

	it("does not fail on an EDIT to an existing over-cap entry", () => {
		base(entry("B1", 400));
		writeMap(baselineRows, `${entry("B1", 400)}\n\ncorrected`);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("NEW-ENTRY-OVER-CAP");
	});

	it("does not fail on an edit that GROWS an existing over-cap entry", () => {
		base(entry("B1", 400));
		writeMap(baselineRows, entry("B1", 900));
		expect(check().status).toBe(0);
	});

	/*
	 * The load-bearing difference from assertions 3 and 11: those soften
	 * to a WARN while the map is dirty, and this one must not. Every commit that
	 * adds an entry has a dirty map by definition, so a softened assertion 14
	 * would refuse nothing that was ever committed.
	 */
	it("still FAILs under --map-dirty, which softens every other assertion, and names the entry and its word count", () => {
		base(entry("B1", 10));
		writeMap(baselineRows, `${entry("B1", 10)}\n\n${entry("B2", 400)}`);
		const r = check({}, MAP, "--map-dirty");
		expect(r.status).toBe(1);
		expect(r.out).toContain("B2 — 400 prose words");
	});

	/* Skeleton bullets are uncapped (mantahostels#891), so the advice must never send a
	 * reader to cut the pointers that make the entry navigable. */
	it("routes the fix to cutting prose, never the skeleton bullets", () => {
		base(entry("B1", 10));
		writeMap(baselineRows, `${entry("B1", 10)}\n\n${entry("B2", 400)}`);
		const r = check();
		expect(r.out).toContain("Cut PROSE from the entry");
		expect(r.out).toContain("the skeleton bullets are uncapped");
		expect(r.out).toContain("duty to record a settled load-bearing fact");
	});

	/*
	 * No HEAD is "cannot tell which entries are new", not "none are" — so it says
	 * so rather than passing silently.
	 */
	it("says the cap went unchecked where HEAD holds no copy of the map", () => {
		writeMap(baselineRows, entry("B1", 400));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("the 300-word new-entry prose cap was not checked");
	});

	it("still fails a new over-cap entry that carries an over-cap marker", () => {
		base(entry("B1", 10));
		const marked = `${entry("B2", 400)}\n- **Over cap by ruling (#1911):** every claim here is load-bearing — never cut one to reach 300; read the count from \`overCapEntries()\`.`;
		writeMap(baselineRows, `${entry("B1", 10)}\n\n${marked}`);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("B2 —");
		expect(r.out).toContain("no ruling can predate the entry it exempts");
	});

	it("carries the NEW-ENTRY-OVER-CAP tag and its items in --json", () => {
		base(entry("B1", 10));
		writeMap(baselineRows, `${entry("B1", 10)}\n\n${entry("B2", 400)}`);
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "NEW-ENTRY-OVER-CAP",
		);
		expect(finding.entries).toEqual([{ id: "B2", words: 400, excess: 100 }]);
	});
});

/*
 * Assertion 29 (mantahostels#3225, building mantahostels#2888's design on mantahostels#2884's deferral). The
 * `commentUrl` field is what carries the ordering — a permalink does not exist
 * before its comment does — so these cases pin the field checks as hard as the
 * presence check.
 */
describe("the admission record", () => {
	// The `Settled at` bullet is written here rather than left to withSettled's
	// default mantahostels#1: the cross-check reads it, so every `admission` below would otherwise
	// fault for naming an issue the entry does not.
	const entry = (id: string) =>
		`### ${id} · Figure ${id}\n\nprose\n- **Settled at #42**, 6 September 2026.`;
	const admission = {
		settledAt: 42,
		confirmed: "Accept recommendation",
		commentUrl: "https://github.com/owner/repo/issues/42#issuecomment-7",
	};

	const base = (sectionB: string) => {
		writeMap(baselineRows, sectionB);
		git("commit", "-qm", "base");
	};

	/** Add B2 to a committed B1, then say what the sidecar holds for B2. */
	const admit = (admittedRow: unknown) => {
		base(entry("B1"));
		writeMap(baselineRows, `${entry("B1")}\n\n${entry("B2")}`);
		const data: Record<string, unknown> = { ...admissionsFor(entry("B1")) };
		if (admittedRow !== undefined) data.B2 = admittedRow;
		writeAdmissions(data);
		return check();
	};

	it("passes when the new entry carries a conforming row", () => {
		const r = admit(admission);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("UNRECORDED-ADMISSION");
	});

	it("fails when the new entry has no row at all, naming the entry and the admissions sidecar", () => {
		const r = admit(undefined);
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"1 §B entr(ies) new since HEAD carry no conforming row in doc-map-admissions.json",
		);
		expect(r.out).toContain("B2 — no row in the admissions sidecar");
		expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
	});

	it("fails a row whose settledAt is not a positive integer, naming the entry", () => {
		const r = admit({ ...admission, settledAt: "42" });
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"B2 — `settledAt` is not a positive integer issue number",
		);
	});

	it("fails a row whose confirmed is empty, naming the entry", () => {
		const r = admit({ ...admission, confirmed: "   " });
		expect(r.status).toBe(1);
		expect(r.out).toContain("B2 — `confirmed` is empty or not a string");
	});

	/*
	 * The load-bearing field. A bare issue URL, a `#issue-` anchor or a
	 * hand-typed placeholder all read as "no comment was posted".
	 */
	it("fails a commentUrl that is not an issue-comment permalink, naming the entry", () => {
		const r = admit({
			...admission,
			commentUrl: "https://github.com/owner/repo/issues/42",
		});
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"B2 — `commentUrl` is not a GitHub issue-comment permalink",
		);
	});

	/* A permalink copied from the wrong issue records a confirmation that was
	 * never given on the round the entry cites. */
	it("fails a commentUrl whose issue disagrees with settledAt, naming the entry and both issue numbers", () => {
		const r = admit({
			...admission,
			commentUrl: "https://github.com/owner/repo/issues/43#issuecomment-7",
		});
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"B2 — `commentUrl` points at issue #43, but `settledAt` names #42",
		);
	});

	it("fails a row that is not an object, naming the entry", () => {
		const r = admit("confirmed");
		expect(r.status).toBe(1);
		expect(r.out).toContain("B2 — its row is not an object");
	});

	it("fails a settledAt that is an integer but not positive, naming the entry", () => {
		const r = admit({ ...admission, settledAt: 0 });
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"B2 — `settledAt` is not a positive integer issue number",
		);
	});

	/* The row records the round the ENTRY cites, so a settling issue the entry
	 * itself does not name is a row filed against the wrong decision. */
	it("fails a settledAt the entry's own `Settled at` bullet does not name", () => {
		base(entry("B1"));
		writeMap(
			baselineRows,
			`${entry("B1")}\n\n### B2 · Figure B2\n\nprose\n- **Settled at #99**, 6 September 2026.`,
			{ rawEntries: true },
		);
		writeAdmissions({ ...admissionsFor(entry("B1")), B2: admission });
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"B2 — `settledAt` names #42, but the entry's own `Settled at` bullet names #99",
		);
	});

	/*
	 * mantahostels#1350's 300-word cap can force an entry's substance into a fresh id, and
	 * mantahostels#2920 ruled a split is not an admission — so the row records the split
	 * and nobody is quoted as confirming it.
	 */
	it("passes a cap-split row, which carries no confirmation at all", () => {
		const r = admit({ capSplit: true, from: "B1", settledAt: 42 });
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("UNRECORDED-ADMISSION");
	});

	it("fails a cap-split row that names no id it came from", () => {
		const r = admit({ capSplit: true, settledAt: 42 });
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"B2 — `capSplit` is set but `from` names no `B<n>` the split came from",
		);
	});

	it("names the absent sidecar rather than sending you to write a row twice", () => {
		base(entry("B1"));
		writeMap(baselineRows, `${entry("B1")}\n\n${entry("B2")}`);
		fs.rmSync(path.join(repo, ADMISSIONS));
		expect(check().out).toContain("the sidecar went unstaged");
	});

	it("does not fail on an EDIT to an existing entry with no row", () => {
		base(entry("B1"));
		writeMap(baselineRows, `${entry("B1")}\n\ncorrected`);
		writeAdmissions({});
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("UNRECORDED-ADMISSION");
	});

	/* Assertion 14's reason, and the second assertion it applies to: the commit
	 * adding an entry always has a dirty map, so a softened one refuses
	 * nothing that was ever committed. */
	it("still FAILs under --map-dirty, which softens every other assertion, and names the entry with no admissions row", () => {
		base(entry("B1"));
		writeMap(baselineRows, `${entry("B1")}\n\n${entry("B2")}`);
		writeAdmissions(admissionsFor(entry("B1")));
		const r = check({}, MAP, "--map-dirty");
		expect(r.status).toBe(1);
		expect(r.out).toContain("B2 — no row in the admissions sidecar");
	});

	/* An absent sidecar is read as empty rather than BROKEN: a commit adding an
	 * entry with no sidecar at all is the case this assertion exists to refuse,
	 * so it must fall out as a fault and not as corruption. */
	it("fails, rather than BROKENs, where the sidecar is absent, naming the entry with no row", () => {
		base(entry("B1"));
		writeMap(baselineRows, `${entry("B1")}\n\n${entry("B2")}`);
		fs.rmSync(path.join(repo, ADMISSIONS));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("B2 — no row in the admissions sidecar");
		expect(r.out).not.toContain("admissions data file unreadable");
	});

	it("BROKENs on a sidecar that will not parse", () => {
		base(entry("B1"));
		writeMap(baselineRows, `${entry("B1")}\n\n${entry("B2")}`);
		write(ADMISSIONS, "{ not json");
		expect(check().out).toContain("admissions data file unreadable");
	});

	it("says the record went unchecked where HEAD holds no copy of the map", () => {
		writeMap(baselineRows, entry("B1"));
		writeAdmissions({});
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("the admission record was not checked");
	});

	/* The advice is where the ordering is taught, and it is the only place a
	 * session meets it at the moment it matters. */
	it("routes the fix to posting the comment FIRST", () => {
		const r = admit(undefined);
		expect(r.out).toContain("POST THAT COMMENT FIRST");
		expect(r.out).toContain("never your paraphrase of what he meant");
		expect(r.out).toContain("it cannot prove the founder spoke");
	});

	it("carries the UNRECORDED-ADMISSION tag and its items in --json", () => {
		base(entry("B1"));
		writeMap(baselineRows, `${entry("B1")}\n\n${entry("B2")}`);
		writeAdmissions(admissionsFor(entry("B1")));
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "UNRECORDED-ADMISSION",
		);
		expect(finding.entries).toEqual([
			{ id: "B2", why: "no row in the admissions sidecar" },
		]);
	});
});

/*
 * Assertion 21 (mantahostels#2058). A §B entry's own `Over cap by ruling (#n)` marker is
 * stale once the entry falls at or under the 300-word cap — invisible to
 * assertion 14's NEW-ENTRY-OVER-CAP list, which only ever sees entries still
 * over cap.
 */
describe("the stale over-cap marker", () => {
	const buildMarkerText = (n: number) =>
		`- **Over cap by ruling (#${n}):** every claim here is load-bearing — never cut one to reach 300; read the count from \`overCapEntries()\`.`;
	const markerWords = (n: number) =>
		(buildMarkerText(n).match(/\S+/g) || []).length;

	/** A §B entry with `n` total prose words, `n` counting the marker's own. */
	const entry = (id: string, n: number, markerTicket: number | null) => {
		const marker = markerTicket === null ? null : buildMarkerText(markerTicket);
		const bodyWords =
			n - (markerTicket === null ? 0 : markerWords(markerTicket));
		return [
			`### ${id} · Figure ${id}`,
			"",
			words(bodyWords),
			...(marker === null ? [] : [marker]),
		].join("\n");
	};

	it("passes on a marked entry that is still over cap", () => {
		writeMap(baselineRows, entry("B1", 400, 1911));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("no stale over-cap marker");
	});

	it("passes on an entry with no marker, over cap or not", () => {
		writeMap(baselineRows, entry("B1", 400, null));
		const r = check();
		expect(r.status).toBe(0);
	});

	it("fails on a marked entry that has fallen at the cap, naming the id and the ticket", () => {
		writeMap(baselineRows, entry("B1", 300, 1911));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"1 §B entr(ies) carry an over-cap marker but are no longer over cap",
		);
		expect(r.out).toContain("B1 — 300 prose words, marked exempt by #1911");
		expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
	});

	it("fails on a marked entry well under the cap", () => {
		writeMap(baselineRows, entry("B1", 10, 1911));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"1 §B entr(ies) carry an over-cap marker but are no longer over cap",
		);
	});

	/*
	 * The load-bearing reason: the commit that drains B1 to exactly 300 words
	 * is itself the one that makes docs/doc-map.md differ from HEAD, so a
	 * softened assertion here would never refuse the commit responsible —
	 * only some later, unrelated one.
	 */
	it("still FAILs under --map-dirty, which softens every other assertion, and names the entry, its word count and its exemption marker", () => {
		writeMap(baselineRows, entry("B1", 300, 1911));
		const r = check({}, MAP, "--map-dirty");
		expect(r.status).toBe(1);
		expect(r.out).toContain("B1 — 300 prose words, marked exempt by #1911");
	});

	it("routes the fix to dropping the marker bullet", () => {
		writeMap(baselineRows, entry("B1", 300, 1911));
		const r = check();
		expect(r.out).toContain("Drop the `Over cap by ruling (#n)` bullet");
	});

	it("carries the STALE-OVER-CAP-MARKER tag and its items in --json", () => {
		writeMap(baselineRows, entry("B1", 300, 1911));
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "STALE-OVER-CAP-MARKER",
		);
		expect(finding.entries).toEqual([
			{ id: "B1", words: 300, exemptedAt: 1911 },
		]);
	});
});

/*
 * Assertion 23 (mantahostels#2124). A line reaching for the marker and missing its
 * spelling leaves the entry unexempted with nothing saying so — the fail-open
 * the exemption regex had before this. WARN, never FAIL: the probe is lexical.
 */
describe("the malformed over-cap marker", () => {
	const entry = (id: string, line: string | null, n = 10) =>
		[
			`### ${id} · Figure ${id}`,
			"",
			words(n),
			...(line === null ? [] : [line]),
		].join("\n");

	const nearMiss =
		"- **Over cap by ruling (#1911)**: every claim here is load-bearing.";
	const valid =
		"- **Over cap by ruling (#1911):** every claim here is load-bearing.";

	it("warns on a near miss, naming the entry and quoting the line", () => {
		writeMap(baselineRows, entry("B1", nearMiss));
		const r = check();
		expect(r.out).toContain(
			"1 §B line(s) look like an over-cap marker but do not parse as one:",
		);
		expect(r.out).toContain(`B1 — ${nearMiss}`);
	});

	/* WARN, so it never enters `count` and never refuses the commit. */
	it("exits 0 on a near miss and leaves the doc-map count alone", () => {
		writeMap(baselineRows, entry("B1", nearMiss));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN: 0 doc-map problem(s)");
	});

	it("stays silent on the marker's own correct spelling", () => {
		// Over cap, so assertion 21 has nothing stale to say either.
		writeMap(baselineRows, entry("B1", valid, 400));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("look like an over-cap marker");
	});

	it("stays silent on an entry mentioning nothing of the sort", () => {
		writeMap(baselineRows, entry("B1", null));
		const r = check();
		expect(r.out).not.toContain("look like an over-cap marker");
	});

	it("routes the fix to the marker's exact spelling", () => {
		writeMap(baselineRows, entry("B1", nearMiss));
		const r = check();
		expect(r.out).toContain(
			"Respell the bullet exactly `- **Over cap by ruling (#n):**`",
		);
	});

	it("carries the MALFORMED-OVER-CAP-MARKER tag and its items in --json", () => {
		writeMap(baselineRows, entry("B1", nearMiss));
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "MALFORMED-OVER-CAP-MARKER",
		);
		expect(finding.lines).toEqual([{ id: "B1", line: nearMiss }]);
		expect(finding.severity).toBe("WARN");
	});
});

/*
 * Assertion 22 (mantahostels#2050). A marked entry may not GROW — direction, never level.
 * WARN, never FAIL: a FAIL collides with mantahostels#1911's own bar on cutting a claim,
 * which would leave a session holding a load-bearing addition no legal move.
 */
describe("growth in an over-cap-by-ruling entry", () => {
	const buildMarkerText = (n: number) =>
		`- **Over cap by ruling (#${n}):** every claim here is load-bearing — never cut one to reach 300; read the count from \`overCapEntries()\`.`;
	const markerWords = (n: number) =>
		(buildMarkerText(n).match(/\S+/g) || []).length;

	/** A §B entry with `n` total prose words, `n` counting the marker's own. */
	const entry = (id: string, n: number, markerTicket: number | null) => {
		const marker = markerTicket === null ? null : buildMarkerText(markerTicket);
		const bodyWords =
			n - (markerTicket === null ? 0 : markerWords(markerTicket));
		return [
			`### ${id} · Figure ${id}`,
			"",
			words(bodyWords),
			...(marker === null ? [] : [marker]),
		].join("\n");
	};

	const base = (sectionB: string) => {
		writeMap(baselineRows, sectionB);
		git("commit", "-qm", "base");
	};

	it("WARNs on a marked entry that grew, naming what it was and by how much", () => {
		base(entry("B1", 400, 1911));
		writeMap(baselineRows, entry("B1", 420, 1911));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"1 §B entr(ies) marked over cap by ruling grew in this commit",
		);
		expect(r.out).toContain(
			"B1 — 400 → 420 prose words, +20, marked exempt by #1911",
		);
	});

	it("passes silently where the marked entry held steady", () => {
		base(entry("B1", 400, 1911));
		writeMap(baselineRows, entry("B1", 400, 1911));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("marked over cap by ruling grew");
	});

	/* Marked-only is mantahostels#2050's scope: an unmarked entry has the on-touch rule. */
	it("says nothing about growth in an over-cap entry carrying no marker", () => {
		base(entry("B1", 400, null));
		writeMap(baselineRows, entry("B1", 420, null));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("marked over cap by ruling grew");
	});

	/* Growth lands in a dirty-map commit by construction, so softening on that
	 * axis would warn on nothing — assertion 21's reason. */
	it("still WARNs under --map-dirty, naming the entry, its word growth and its exemption", () => {
		base(entry("B1", 400, 1911));
		writeMap(baselineRows, entry("B1", 420, 1911));
		const r = check({}, MAP, "--map-dirty");
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"B1 — 400 → 420 prose words, +20, marked exempt by #1911",
		);
	});

	it("routes the fix to paying for the addition inside the same entry", () => {
		base(entry("B1", 400, 1911));
		writeMap(baselineRows, entry("B1", 420, 1911));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("Pay for the addition inside the same entry");
		expect(r.out).toContain(
			"Never cut a claim to get there (mantahostels#1911, mantahostels#1935)",
		);
	});

	/*
	 * The load-bearing exclusion: lib/fault-profiles.js's `doc-map` profile has
	 * no `gating` predicate and diffs everything in `data`, so a grown entry
	 * landing there would turn this WARN into a gate by the back door.
	 */
	it("keeps the grown entries out of the --json data envelope", () => {
		base(entry("B1", 400, 1911));
		writeMap(baselineRows, entry("B1", 420, 1911));
		const parsed = JSON.parse(check({}, "--json").stdout);
		// The tag IS in `findings`, which the profile does not gate on.
		expect(
			parsed.findings.some(
				(f: { tag: string }) => f.tag === "OVER-CAP-ENTRY-GREW",
			),
		).toBe(true);
		expect(JSON.stringify(parsed.data ?? {})).not.toContain("growth");
		expect(parsed.count ?? 0).toBe(0);
	});

	it("carries the OVER-CAP-ENTRY-GREW tag and its items in --json", () => {
		base(entry("B1", 400, 1911));
		writeMap(baselineRows, entry("B1", 420, 1911));
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "OVER-CAP-ENTRY-GREW",
		);
		expect(finding.entries).toEqual([
			{ id: "B1", words: 420, was: 400, growth: 20, exemptedAt: 1911 },
		]);
	});

	/*
	 * Assertion 24 (mantahostels#2227), sharing this block's fixtures because it is the same
	 * marker over the same baseline. Dropping the bullet takes the entry out of
	 * assertion 22 above, and 21 sees a missing marker only below the cap.
	 */
	describe("a dropped over-cap-by-ruling marker", () => {
		it("WARNs on an over-cap entry whose marker went, naming the ruling", () => {
			base(entry("B1", 400, 1911));
			writeMap(baselineRows, entry("B1", 400, null));
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toContain(
				"1 over-cap §B entr(ies) lost the marker the baseline carried",
			);
			expect(r.out).toContain(
				"B1 — 400 prose words, marked exempt by #1911 until this commit",
			);
		});

		/* The sanctioned drain: the §B preamble asks for exactly this. */
		it("says nothing where the entry was drained under the cap too", () => {
			base(entry("B1", 400, 1911));
			writeMap(baselineRows, entry("B1", 250, null));
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).not.toContain("lost the marker the baseline carried");
		});

		it("says nothing where the marker is still there", () => {
			base(entry("B1", 400, 1911));
			writeMap(baselineRows, entry("B1", 420, 1911));
			const r = check();
			expect(r.out).not.toContain("lost the marker the baseline carried");
		});

		/* The drop lands in a dirty-map commit by construction, as 22's does. */
		it("still WARNs under --map-dirty, naming the entry and the exemption this commit drops", () => {
			base(entry("B1", 400, 1911));
			writeMap(baselineRows, entry("B1", 400, null));
			const r = check({}, MAP, "--map-dirty");
			expect(r.status).toBe(0);
			expect(r.out).toContain(
				"B1 — 400 prose words, marked exempt by #1911 until this commit",
			);
		});

		it("routes an accident to putting the bullet back, and names the deliberate case", () => {
			base(entry("B1", 400, 1911));
			writeMap(baselineRows, entry("B1", 400, null));
			const r = check();
			expect(r.out).toContain("Deleted by accident?");
			expect(r.out).toContain("Un-marked on purpose, the ruling revisited?");
		});

		/* The same back-door exclusion assertion 22's block pins above. */
		it("keeps the dropped entries out of the --json data envelope", () => {
			base(entry("B1", 400, 1911));
			writeMap(baselineRows, entry("B1", 400, null));
			const parsed = JSON.parse(check({}, "--json").stdout);
			expect(
				parsed.findings.some(
					(f: { tag: string }) => f.tag === "OVER-CAP-MARKER-DROPPED",
				),
			).toBe(true);
			expect(JSON.stringify(parsed.data ?? {})).not.toContain(
				"OVER-CAP-MARKER-DROPPED",
			);
			expect(parsed.count ?? 0).toBe(0);
		});

		it("carries the OVER-CAP-MARKER-DROPPED tag and its items in --json", () => {
			base(entry("B1", 400, 1911));
			writeMap(baselineRows, entry("B1", 400, null));
			const r = check({}, "--json");
			const finding = JSON.parse(r.stdout).findings.find(
				(f: { tag: string }) => f.tag === "OVER-CAP-MARKER-DROPPED",
			);
			expect(finding.entries).toEqual([
				{ id: "B1", words: 400, exemptedAt: 1911 },
			]);
			expect(finding.severity).toBe("WARN");
		});
	});
});

/*
 * Assertion 15 (mantahostels#1640). The ledger lives in §Capture and placement, a section
 * the fixture map has no equivalent of — so the list is written into the
 * `sectionB` slot, which is fine because the assertion locates it by its stem
 * line rather than by which section it sits in.
 */
describe("the shed-ledger entry cap", () => {
	/** A ledger bullet of exactly `bytes` bytes, ASCII throughout. */
	const bullet = (issue: number, bytes: number) => {
		const head = `  - **#${issue}**, 20 August 2026 — `;
		// Padded on the head's BYTE length, not its character length: the em dash
		// is one character and three bytes, and the cap counts bytes.
		return head + "x".repeat(Math.max(0, bytes - Buffer.byteLength(head)));
	};

	/**
	 * The stem line and the bullets nested under it. The stem's own indent is
	 * what the parser measures nesting against, so the fixture writes it flush
	 * left exactly as the map does.
	 */
	const ledger = (...bullets: string[]) =>
		["- **Sheds paid, most recent first:**", ...bullets].join("\n");

	it("passes when every entry but the newest is at the cap", () => {
		writeMap(baselineRows, ledger(bullet(9, 4000), bullet(8, 440)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"every shed-ledger entry but the newest at or under 440 B",
		);
	});

	it("fails a compacted entry over the cap, naming its issue and excess", () => {
		writeMap(baselineRows, ledger(bullet(9, 4000), bullet(8, 441)));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 shed-ledger entr(ies) exceed the 440 B cap");
		expect(r.out).toContain("#8 — 441 B, 1 over the 440 B cap");
		expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
	});

	/* The newest entry is written in full, so its size must never fault. */
	it("exempts the newest entry however long it is", () => {
		writeMap(baselineRows, ledger(bullet(9, 9000)));
		expect(check().status).toBe(0);
	});

	/* The sibling `Rejected` list is a peer of the stem, not nested under it,
	 * and mantahostels#1640 left it out of scope: it is already in the compact shape. */
	it("ignores bullets that are not nested under the stem", () => {
		writeMap(
			baselineRows,
			[
				ledger(bullet(9, 4000), bullet(8, 300)),
				"- **Rejected, with the residual reason:**",
				`  - ${"y".repeat(900)}`,
			].join("\n"),
		);
		expect(check().status).toBe(0);
	});

	/*
	 * Every commit that lands a tranche has a dirty map, so softening this
	 * assertion would refuse nothing that was ever committed.
	 */
	it("still FAILs under --map-dirty, which softens every other assertion, and names the ledger entry and its size", () => {
		writeMap(baselineRows, ledger(bullet(9, 4000), bullet(8, 800)));
		const r = check({}, MAP, "--map-dirty");
		expect(r.status).toBe(1);
		expect(r.out).toContain("#8 — 800 B");
	});

	/* No stem is "this is not the doc map", not "the ledger is empty" — so it
	 * says the cap went unchecked rather than passing silently. */
	it("says the cap went unchecked where the map carries no stem line", () => {
		writeMap(baselineRows);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("the 440 B shed-ledger entry cap was not checked");
		// And the OK line must not assert the cap held: a run that says both is a
		// contradiction the reader has to resolve.
		expect(r.out).not.toContain("every shed-ledger entry but the newest");
	});

	/*
	 * The cap is per ENTRY, not per physical line, so an over-long tranche split
	 * across sub-bullets is still over the cap — otherwise the gate is evaded by
	 * pressing return.
	 */
	it("charges an entry's sub-bullets and continuation lines to that entry", () => {
		writeMap(
			baselineRows,
			ledger(
				bullet(9, 4000),
				bullet(8, 300),
				`    - ${"y".repeat(150)}`,
				`    a continuation line, ${"z".repeat(100)}`,
			),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("#8 — 581 B, 141 over the 440 B cap");
	});

	/* The newest entry is exempt as a WHOLE: its sub-bullets must not be read as
	 * the start of the entry below it, which `.slice(1)` on lines would do. */
	it("exempts the newest entry's sub-bullets along with it", () => {
		writeMap(
			baselineRows,
			ledger(bullet(9, 4000), `    - ${"y".repeat(900)}`, bullet(8, 300)),
		);
		expect(check().status).toBe(0);
	});

	it("routes the fix to the five things a compacted entry keeps", () => {
		writeMap(baselineRows, ledger(bullet(9, 4000), bullet(8, 900)));
		const r = check();
		expect(r.out).toContain("Only the NEWEST entry is written in full");
		/* The subject clause is the fifth thing, added at mantahostels#1831 against a drafted
		 * four every ledger entry had already ignored. Pinned because nothing
		 * else fails if the advice reverts to naming only the other four. */
		expect(r.out).toContain("what it did in one clause");
		expect(r.out).toContain("its named residual");
		/* The verdict is the conditional sixth thing (mantahostels#1864), and its placement
		 * is the operative half — a verdict folded into the residual leaves no
		 * marker to find it by. Pinned for the same reason as the fifth: nothing
		 * else fails if the advice reverts to naming five, or names the sixth
		 * without saying where it goes. */
		expect(r.out).toContain(
			"its verdict is a sixth element beside the residual",
		);
		expect(r.out).toContain("never inside it");
		expect(r.out).toContain("recoverable from the tranche's own issue");
	});

	it("carries the LEDGER-ENTRY-OVER-CAP tag and its items in --json", () => {
		writeMap(baselineRows, ledger(bullet(9, 4000), bullet(8, 500)));
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "LEDGER-ENTRY-OVER-CAP",
		);
		expect(finding.entries).toEqual([{ label: "#8", bytes: 500, excess: 60 }]);
	});
});

/*
 * Assertion 16 (mantahostels#1788). Two things have to move together for this one: the
 * fixture repo's staged CLAUDE.md (the pool delta) and the ledger written into
 * the map's `sectionB` slot, which the parser locates by its stem line rather
 * than by section.
 */
describe("the pool-tranche trigger verdict", () => {
	const bullet = (issue: number, tail = "") =>
		`  - **#${issue}**, 20 August 2026 — **−10 B**: a shed.${tail}`;

	const ledger = (...bullets: string[]) =>
		["- **Sheds paid, most recent first:**", ...bullets].join("\n");

	const base = (sectionB: string) => {
		track("CLAUDE.md", "pool\n");
		writeMap(baselineRows, sectionB);
		commit("base");
	};

	const growPool = (extra: number) =>
		track("CLAUDE.md", `pool\n${"x".repeat(extra)}`);

	const verdict = " **Trigger:** none nameable — no matcher reaches it.";

	it("passes a pool-byte tranche whose new entry carries a verdict", () => {
		base(ledger(bullet(8)));
		growPool(50);
		writeMap(baselineRows, ledger(bullet(9, verdict), bullet(8)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"§5's newest ledger entry answers step 2 for this commit's 50 B",
		);
	});

	it("fails a pool-byte tranche whose new entry carries no verdict", () => {
		base(ledger(bullet(8)));
		growPool(50);
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("this commit adds 50 B to the always-loaded pool");
		expect(r.out).toContain(
			"#9 — the newest ledger entry carries no `**Trigger:**` verdict",
		);
		expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
	});

	/* The limb that stops one entry's marker paying for every later tranche. */
	it("fails a pool-byte commit that writes no entry of its own, naming the entry HEAD already held", () => {
		base(ledger(bullet(8, verdict)));
		growPool(50);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"#8 — the ledger's newest entry is the one HEAD already held",
		);
	});

	it("passes a second tranche under one issue that labels its entry apart", () => {
		base(ledger(bullet(8, verdict)));
		growPool(50);
		writeMap(
			baselineRows,
			ledger(
				`  - **#8 review**, 20 August 2026 — **+50 B**.${verdict}`,
				bullet(8, verdict),
			),
		);
		expect(check().status).toBe(0);
	});

	it("fails a pool-byte commit that only edits a figure in HEAD's newest entry", () => {
		base(ledger(bullet(8, verdict)));
		growPool(50);
		writeMap(
			baselineRows,
			ledger(bullet(8, verdict).replace("−10 B", "−12 B")),
		);
		expect(check().out).toContain(
			"#8 — the ledger's newest entry is the one HEAD already held",
		);
	});

	it("fails a verdict under the word floor, naming the count", () => {
		base(ledger(bullet(8)));
		growPool(50);
		writeMap(baselineRows, ledger(bullet(9, " **Trigger:** none"), bullet(8)));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"its `**Trigger:**` verdict is 1 word(s); 3 is the floor",
		);
	});

	it("says nothing when the commit does not grow the pool", () => {
		base(ledger(bullet(8)));
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("LEDGER-TRIGGER-VERDICT");
		expect(r.out).not.toContain("answers step 2");
	});

	it("says nothing when the commit shrinks the pool", () => {
		base(ledger(bullet(8)));
		track("CLAUDE.md", "p\n");
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		expect(check().status).toBe(0);
	});

	it("still FAILs under --map-dirty, which softens every other assertion, and says the entry carries no Trigger verdict", () => {
		base(ledger(bullet(8)));
		growPool(50);
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		const r = check({}, MAP, "--map-dirty");
		expect(r.status).toBe(1);
		expect(r.out).toContain("carries no `**Trigger:**` verdict");
	});

	/* The verdict rides in the newest entry, which assertion 15 exempts. */
	it("does not push the newest entry over assertion 15's cap", () => {
		base(ledger(bullet(8)));
		growPool(50);
		writeMap(
			baselineRows,
			ledger(bullet(9, `${verdict} ${"y".repeat(900)}`), bullet(8)),
		);
		expect(check().status).toBe(0);
	});

	/*
	 * `git cat-file` exits 128 for a missing path, an unresolvable rev and a
	 * broken repository alike. Reading a git that cannot answer as "no rev
	 * resolves" would skip assertion 16 quietly, so it is BROKEN (#3152).
	 */
	it("is BROKEN where git will not size a pool file, never a skipped verdict", () => {
		base(ledger(bullet(8)));
		writeMap(baselineRows, ledger(bullet(8)));
		const faulty = writeFaultyGit(
			{ words: ["cat-file", "-s"] },
			{ exit: 128 },
			{ under: repo },
		);
		const r = check({ WFC_GIT: faulty.git });
		expect(faulty.hits()).toBeGreaterThan(0);
		expect(r.status).toBe(2);
		expect(r.out).toContain("git would not read");
		expect(r.out).not.toContain("trigger verdict was not checked");
	});

	it("is BROKEN where git will not resolve a committed rev, never a skipped verdict", () => {
		base(ledger(bullet(8)));
		writeMap(baselineRows, ledger(bullet(8)));
		const faulty = writeFaultyGit(
			{ argPrefix: "HEAD^{commit}" },
			{ exit: 128 },
			{ under: repo },
		);
		const r = check({ WFC_GIT: faulty.git });
		expect(faulty.hits()).toBeGreaterThan(0);
		expect(r.status).toBe(2);
		expect(r.out).toContain("git would not resolve HEAD");
		expect(r.out).not.toContain("trigger verdict was not checked");
	});

	/*
	 * Asserted on the library rather than through the CLI: the whole checker
	 * BROKENs on a corrupt index long before it reaches this assertion, so the
	 * CLI cannot distinguish the fix from the bug.
	 */
	it("throws BROKEN on a corrupt index, never reading it as an empty pool", () => {
		base(ledger(bullet(8)));
		const bad = path.join(repo, "bad.idx");
		fs.writeFileSync(bad, "garbage-not-an-index");
		const probe = spawnSync(
			"node",
			[
				"-e",
				"const {stagedPoolDelta}=require(process.argv[1]);" +
					'try{stagedPoolDelta(["HEAD"]);console.log("returned")}' +
					"catch(e){console.log(require(process.argv[2]).outcomeOf(e))}",
				path.resolve(__dirname, "lib/always-loaded-pool.js"),
				path.resolve(__dirname, "lib/outcome-error.js"),
			],
			{
				cwd: repo,
				encoding: "utf8",
				env: { ...process.env, GIT_INDEX_FILE: bad },
			},
		);
		expect(probe.stdout.trim()).toBe("BROKEN");
	});

	/*
	 * The index limb of the same widening: a pool file on disk but unstaged
	 * draws `exists on disk, but not in the index` from `cat-file -s :<p>`,
	 * which is 0 staged bytes rather than a git that could not answer. No CLI
	 * case reaches it — every rev the checker asks about is `HEAD`, and the
	 * index always holds the file a test staged.
	 */
	it("reads an unstaged pool file on disk as 0 index bytes", () => {
		base(ledger(bullet(8)));
		write("docs/working-contract.md", `${"c".repeat(60)}\n`);
		const probe = spawnSync(
			"node",
			[
				"-e",
				"const {stagedPoolDelta}=require(process.argv[1]);" +
					'console.log(JSON.stringify(stagedPoolDelta(["HEAD"])));',
				path.resolve(__dirname, "lib/always-loaded-pool.js"),
			],
			{ cwd: repo, encoding: "utf8" },
		);
		expect(probe.stdout.trim()).toBe("0");
	});

	/*
	 * The commit that CREATES a pool file. Git refuses `cat-file -s HEAD:<p>`
	 * there with a spelling of its own — `exists on disk, but not in 'HEAD'` —
	 * and reading that as a broken apparatus nulled the delta, skipping
	 * assertion 16 on precisely the commit it exists to gate (mantahostels#3526).
	 *
	 * docs/working-contract.md is the pool member the fixture's HEAD does not
	 * hold. CLAUDE.md cannot stand in: initBase() tracks it, so `base()` commits
	 * it.
	 */
	const createPoolFile = () => {
		track("docs/working-contract.md", `${"c".repeat(60)}\n`);
		return [...baselineRows, row("docs/working-contract.md")];
	};

	it("charges the whole file to the commit that creates a pool file", () => {
		base(ledger(bullet(8)));
		const rows = createPoolFile();
		writeMap(rows, ledger(bullet(9), bullet(8)));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("this commit adds 61 B to the always-loaded pool");
		expect(r.out).toContain(
			"#9 — the newest ledger entry carries no `**Trigger:**` verdict",
		);
		expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
	});

	it("passes a creating commit whose new entry carries a verdict", () => {
		base(ledger(bullet(8)));
		const rows = createPoolFile();
		writeMap(rows, ledger(bullet(9, verdict), bullet(8)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"§5's newest ledger entry answers step 2 for this commit's 61 B",
		);
	});

	it("says the verdict went unchecked where no committed rev resolves", () => {
		writeMap(baselineRows, ledger(bullet(9)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("the §5 trigger verdict was not checked");
	});

	it("says the verdict went unchecked where the map carries no ledger stem", () => {
		base("");
		growPool(50);
		writeMap(baselineRows);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("the §5 trigger verdict was not checked");
	});

	it("routes the fix to both shapes step 2 admits", () => {
		base(ledger(bullet(8)));
		growPool(50);
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		const r = check();
		expect(r.out).toContain("**Trigger:** none nameable —");
		expect(r.out).toContain("the gate is that step 2 was answered");
	});

	it("carries the LEDGER-TRIGGER-VERDICT tag and its items in --json", () => {
		base(ledger(bullet(8)));
		growPool(50);
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "LEDGER-TRIGGER-VERDICT",
		);
		expect(finding.entries).toEqual([
			{
				label: "#9",
				fault: "the newest ledger entry carries no `**Trigger:**` verdict",
			},
		]);
	});
});

/*
 * Assertion 20 (mantahostels#1968, on mantahostels#1890's ruling). Unlike assertion 16 above, this one
 * is indifferent to the pool delta: it fires on a COMPACTION, so the fixture
 * moves the ledger alone and leaves CLAUDE.md where it found it.
 */
describe("the compaction verdict", () => {
	const prediction = " **Prediction:** the guard fires within the tranche.";

	const bullet = (issue: number, tail = "") =>
		`  - **#${issue}**, 20 August 2026 — **−10 B**: a shed.${tail}`;

	const ledger = (...bullets: string[]) =>
		["- **Sheds paid, most recent first:**", ...bullets].join("\n");

	const base = (sectionB: string) => {
		writeMap(baselineRows, sectionB);
		commit("base");
	};

	it("passes a compaction that carries the verdict it owes", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(
			baselineRows,
			ledger(
				bullet(9),
				bullet(
					8,
					" **Verdict: held** — the guard fired 12 times since 20 Aug.",
				),
			),
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("§5's verdict is not there to find");
	});

	it("fails a compaction whose verdict is absent, naming the ledger entry", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"#8 — it carried a prediction and its compacted form carries no " +
				"`**Verdict` verdict of its own",
		);
		expect(r.out).toContain("FAIL: 1 doc-map problem(s)");
	});

	/*
	 * The folding limb mantahostels#1864 ruled against (a verdict written INTO the named
	 * residual) is the same fault as an absent one: it leaves no marker to find
	 * a verdict by.
	 */
	it("fails a verdict folded into the named residual, reading it as no Verdict of its own", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(
			baselineRows,
			ledger(
				bullet(9),
				bullet(
					8,
					" **Residual:** held — the guard fired 12 times since 20 Aug.",
				),
			),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("carries no `**Verdict` verdict of its own");
	});

	/* A second tranche under one issue, labelled apart (#1739). */
	const labelled = (label: string, tail = "") =>
		`  - **${label}**, 20 August 2026 — **+10 B**: an addition.${tail}`;

	it("passes a labelled tranche's compaction whose verdict names its issue", () => {
		base(ledger(labelled("#8 review", prediction), bullet(8)));
		writeMap(
			baselineRows,
			ledger(
				bullet(9),
				labelled("#8 review", " **Verdict on #8:** held, it fired twice."),
				bullet(8),
			),
		);
		expect(check().status).toBe(0);
	});

	it("fails a compaction relabelled as it was compacted, carrying no verdict", () => {
		base(ledger(labelled("#8 review", prediction), bullet(7)));
		writeMap(
			baselineRows,
			ledger(bullet(9), labelled("#8 follow-up"), bullet(7)),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("carries no `**Verdict` verdict of its own");
	});

	it("fails a verdict under the word floor, naming the count", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(baselineRows, ledger(bullet(9), bullet(8, " **Verdict:** held")));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"its `**Verdict` verdict is 1 word(s); 3 is the floor",
		);
	});

	/*
	 * The discriminator is exact rather than proxied: a duplicate-cut tranche
	 * owing no prediction — mantahostels#1928 is one — is the false positive a date proxy
	 * would have failed next (mantahostels#1890).
	 */
	it("passes a compaction of an entry that carried no prediction", () => {
		base(ledger(bullet(8)));
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("§5's verdict is not there to find");
	});

	it("says nothing where the newest entry is the one HEAD already held", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(baselineRows, ledger(bullet(8, prediction), bullet(7)));
		expect(check().status).toBe(0);
	});

	it("says nothing where the displaced entry has left the ledger", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(baselineRows, ledger(bullet(9)));
		expect(check().status).toBe(0);
	});

	it("still FAILs under --map-dirty, which softens every other assertion, and says the compaction carries no Verdict of its own", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		const r = check({}, MAP, "--map-dirty");
		expect(r.status).toBe(1);
		expect(r.out).toContain("carries no `**Verdict` verdict of its own");
	});

	/*
	 * The mantahostels#1647/mantahostels#1648 breach: a verdict written onto the entry BELOW the one that
	 * earned it. Unanchored, its marker would clear the wrong entry's gate.
	 */
	it("fails a verdict naming another entry's issue", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(
			baselineRows,
			ledger(
				bullet(9),
				bullet(8, " **Verdict on #7:** held — #7's guard fired 12 times."),
			),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("carries no `**Verdict` verdict of its own");
	});

	it("passes a verdict naming this entry's own issue", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(
			baselineRows,
			ledger(
				bullet(9),
				bullet(8, " **Verdict on #8:** held — the guard fired 12 times."),
			),
		);
		expect(check().status).toBe(0);
	});

	/* An entry is one bullet, so an empty verdict must not borrow the words of
	 * the element written after it. */
	it("does not count a following element's words toward the floor", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(
			baselineRows,
			ledger(
				bullet(9),
				bullet(
					8,
					" **Verdict:** **Residual:** the shed is refused, do not re-propose.",
				),
			),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("verdict is 0 word(s); 3 is the floor");
	});

	/*
	 * MERGE_HEAD and friends WIDEN assertions 14 and 16 — a merge's other side
	 * has already paid for what it added. Here they would NARROW, refusing a
	 * merge for a compaction the other branch committed.
	 */
	it("judges HEAD alone, so a merge parent's compaction is not refused", () => {
		base(ledger(bullet(8, prediction)));
		const otherParent = git("rev-parse", "HEAD").trim();
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		git("add", "--", MAP);
		commit("the other branch's own compaction, already committed");
		fs.writeFileSync(path.join(repo, ".git/MERGE_HEAD"), `${otherParent}\n`);
		expect(check().status).toBe(0);
	});

	it("carries the LEDGER-COMPACTION-VERDICT tag and its items in --json", () => {
		base(ledger(bullet(8, prediction)));
		writeMap(baselineRows, ledger(bullet(9), bullet(8)));
		const r = check({}, "--json");
		const finding = JSON.parse(r.stdout).findings.find(
			(f: { tag: string }) => f.tag === "LEDGER-COMPACTION-VERDICT",
		);
		expect(finding.entries).toEqual([
			{
				label: "#8",
				fault:
					"it carried a prediction and its compacted form carries no " +
					"`**Verdict` verdict of its own",
			},
		]);
	});
});

/*
 * Assertions 17 and 18 (mantahostels#1863). §A is rendered from docs/doc-map-classes.json,
 * so its bytes are gated against the generator's output and a surviving `role`
 * override is word-capped.
 */
describe("Section A render agreement", () => {
	const header = "| Path | Role | Class | Update route | Consumes |";
	const sep = "|---|---|---|---|---|";

	const sidecarEntry = (over: Record<string, unknown> = {}) => ({
		section: "Docs",
		class: "source-of-truth",
		classQualifier: null,
		role: null,
		route: null,
		consumes: null,
		reader: "agent",
		...over,
	});

	/** A rendered §A: one heading, one table, one row per sidecar key. */
	const renderedMap = (rows: string[]) =>
		[
			"# Doc map",
			"",
			"v1.0 · 5 August 2026",
			"",
			"## Section A — document register",
			"",
			"### Docs",
			"",
			header,
			sep,
			...rows,
			"",
			"## Section B — figure registry",
			"",
			BASELINE_ENTRY,
			SETTLED_BULLET,
			"",
		].join("\n");

	/** The three registered paths every fixture below covers, rendered. */
	const rendered = [
		"| `CLAUDE.md` | CLAUDE.md | `source-of-truth` | Direct | — |",
		"| `docs/doc-map.md` | Doc map | `source-of-truth` | Direct | — |",
		"| `docs/notes.md` | Notes | `source-of-truth` | Direct | — |",
	];

	const sidecar = (over: Record<string, unknown> = {}) => ({
		"CLAUDE.md": sidecarEntry(),
		"docs/doc-map.md": sidecarEntry(),
		"docs/notes.md": sidecarEntry(),
		...over,
	});

	const setUp = (rows: string[], data: Record<string, unknown> = sidecar()) => {
		track(MAP, renderedMap(rows));
		writeClasses(data);
		writeRestatements({ B1: { paths: [{ path: "docs/notes.md" }] } });
		writeSuperseded({});
		writeHighWater();
	};

	it("passes when §A's bytes are what the generator renders", () => {
		setUp(rendered);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("§A matches the generator against 3 sidecar rows");
	});

	it("fails on a hand-edited row, naming the path and the regeneration command", () => {
		setUp([
			rendered[0],
			"| `docs/doc-map.md` | hand-written prose | `source-of-truth` | Direct | — |",
			rendered[2],
		]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("§A does not match what the generator renders");
		expect(r.out).toContain("docs/doc-map.md — row differs");
		expect(r.out).toContain("npm run gen:doc-map-section-a");
	});

	/* An adopter's package.json has no gen: script (#664). */
	it("names the plugin's own generator and register-doc.js in an install, and the generator runs from the adopter (#2066)", () => {
		const plugin = fs.mkdtempSync(path.join(scratchBase(), "plugin-"));
		try {
			fs.symlinkSync(path.dirname(SCRIPT), path.join(plugin, "scripts"));
			setUp([
				rendered[0],
				"| `docs/doc-map.md` | hand-written prose | `source-of-truth` | Direct | — |",
				rendered[2],
			]);
			const r = check({ WFC_SCRIPT_ROOT: plugin });
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				`  node ${plugin}/scripts/generate-doc-map-section-a.js\n`,
			);
			expect(r.out).toContain(`\`node ${plugin}/scripts/register-doc.js `);
			expect(r.out).not.toContain("npm run");
			const generate = runInProcess(
				path.join(plugin, "scripts", "generate-doc-map-section-a.js"),
				[],
				{ cwd: repo, env: process.env },
			);
			expect(generate.status, generate.stderr).toBe(0);
			expect(check({ WFC_SCRIPT_ROOT: plugin }).status).toBe(0);
		} finally {
			fs.rmSync(plugin, { recursive: true, force: true });
		}
	});

	it("names a row §A carries and the sidecar does not", () => {
		track("docs/extra.md");
		setUp([
			...rendered,
			"| `docs/extra.md` | x | `source-of-truth` | Direct | — |",
		]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/extra.md — row has no sidecar key");
	});

	it("names a sidecar key §A has no row for", () => {
		track("docs/extra.md");
		setUp(rendered, sidecar({ "docs/extra.md": sidecarEntry() }));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/extra.md — row missing");
	});

	/* mantahostels#2743 renders `Research runs` as a register list, so `parseRowLines` reads a
	 * list line as well as a table row. Without that, a path missing from a
	 * listed subsection collapses into the coarse ordering fault below and the
	 * report never names it. */
	it("names a listed path §A has no line for", () => {
		track("docs/research/a.md");
		track("docs/research/b.md");
		const listed = (over: Record<string, unknown> = {}) =>
			sidecarEntry({
				section: "Research runs",
				class: "free-edit",
				...over,
			});
		track(
			MAP,
			[
				"# Doc map",
				"",
				"v1.0 · 5 August 2026",
				"",
				"## Section A — document register",
				"",
				"### Docs",
				"",
				header,
				sep,
				...rendered,
				"",
				"### Research runs",
				"",
				"<!-- register-list: free-edit -->",
				"- `docs/research/a.md`",
				"<!-- /register-list -->",
				"",
				"## Section B — figure registry",
				"",
				BASELINE_ENTRY,
				SETTLED_BULLET,
				"",
			].join("\n"),
		);
		writeClasses(
			sidecar({
				"docs/research/a.md": listed(),
				"docs/research/b.md": listed(),
			}),
		);
		writeRestatements({ B1: { paths: [{ path: "docs/notes.md" }] } });
		writeSuperseded({});
		writeHighWater();
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/research/b.md — row missing");
	});

	it("reports a reordering, which changes no row's own text", () => {
		setUp([rendered[2], rendered[1], rendered[0]]);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("row order or subsection placement differs");
	});

	// Since mantahostels#1849 the sidecar is the coverage register, so its absence is
	// BROKEN above assertion 1 and this assertion is never reached at all.
	it("is BROKEN where no sidecar sits beside the map, saying no coverage conclusion was drawn", () => {
		track(MAP, renderedMap(rendered));
		writeRestatements({ B1: { paths: [{ path: "docs/notes.md" }] } });
		writeSuperseded({});
		writeHighWater();
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot read the class sidecar");
		expect(r.out).toContain("no coverage conclusion was drawn");
	});

	it("is BROKEN by a sidecar that exists and does not load, naming the field at fault", () => {
		setUp(rendered);
		write(
			CLASSES,
			JSON.stringify({ "CLAUDE.md": sidecarEntry({ section: 7 }) }),
		);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("section is not a non-empty string");
	});

	describe("the `role` word cap", () => {
		it("fails an override over the cap, naming the path and the excess", () => {
			const over = words(305);
			setUp(
				[
					`| \`CLAUDE.md\` | ${over} | \`source-of-truth\` | Direct | — |`,
					rendered[1],
					rendered[2],
				],
				sidecar({ "CLAUDE.md": sidecarEntry({ role: over }) }),
			);
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain("`role` override(s) exceed the 300-word cap");
			expect(r.out).toContain("CLAUDE.md — 305 words, 5 over the 300-word cap");
		});

		it("passes an override at the cap", () => {
			const at = words(300);
			setUp(
				[
					`| \`CLAUDE.md\` | ${at} | \`source-of-truth\` | Direct | — |`,
					rendered[1],
					rendered[2],
				],
				sidecar({ "CLAUDE.md": sidecarEntry({ role: at }) }),
			);
			expect(check().status).toBe(0);
		});
	});
});

/*
 * --root (mantahostels#1922): the whole reading comes from a materialised tree rather than
 * from the shared working directory, which is what .husky/pre-commit now hands
 * it — a `git checkout-index` extraction of this commit's index, which
 * `extract()` below builds the same way.
 */
describe("--root", () => {
	let roots: string[] = [];

	/** The index, extracted the way the pre-commit gate extracts it. */
	const extract = () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-root-"));
		execFileSync("git", ["checkout-index", "-a", `--prefix=${dir}/`], {
			cwd: repo,
		});
		roots.push(dir);
		return dir;
	};

	beforeEach(() => {
		roots = [];
	});
	afterEach(() => {
		for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
	});

	/*
	 * The four sidecars are written UNTRACKED everywhere else in this file, and
	 * have to be tracked here: an extraction of the index holds only what the
	 * index holds. Tracking them puts them in scope, so they take register rows
	 * too.
	 */
	const rootRows = [
		...baselineRows,
		row(RESTATEMENTS),
		row(SUPERSEDED),
		row(HIGH_WATER),
		row(CLASSES),
		row(RETIRED_VOCABULARY),
		row(ADMISSIONS),
	];
	const stageSidecars = () =>
		git(
			"add",
			"--",
			RESTATEMENTS,
			SUPERSEDED,
			HIGH_WATER,
			CLASSES,
			RETIRED_VOCABULARY,
			ADMISSIONS,
		);

	/** The map as the index holds it — what writeMap staged a moment ago. */
	const readStagedMap = () => fs.readFileSync(path.join(repo, MAP), "utf8");

	/** A Section C route, which `writeMap` places by its `### C<n>` heading. */
	const route = (id: string, read: string) =>
		[`### ${id} · A question?`, `- **Read:** ${read}`, "- **Not:** "].join(
			"\n",
		);

	/* ASSERTION 2, the worktree-only half: a register row the WORKING COPY of the
	 * map carries and the commit does not, naming a file that exists nowhere.
	 * Under --root the map is the commit's, so there is no row and no fault. */
	it("reads the map from the root, not from the working directory", () => {
		writeMap(rootRows);
		stageSidecars();
		const root = extract();
		// Edited in place rather than rebuilt: writeMap's sidecars are keyed to
		// the map it wrote, and a from-scratch mapDoc would be BROKEN against them.
		write(
			MAP,
			readStagedMap()
				.replace("v1.0", "v9.9")
				.replace(row(CLASSES), `${row(CLASSES)}\n${row("docs/phantom.md")}`),
		);

		const r = check({}, "--root", root);
		expect(r.status).toBe(0);
		expect(r.out).toContain("v1.0");
		expect(r.out).not.toContain("v9.9");
		expect(r.out).not.toContain("docs/phantom.md");
		// The same tree without --root is the FAIL, which is what makes the
		// assertion above about the root rather than about the fixture.
		const bare = check();
		expect(bare.status).toBe(1);
		expect(bare.out).toContain("docs/phantom.md");
	});

	/* ASSERTION 4's two halves, the pair the ticket asked for: a route the
	 * working copy adds is ignored, and one the commit itself carries refuses. */
	it("ignores a Section C route only the working copy of the map carries", () => {
		writeMap(rootRows);
		stageSidecars();
		const root = extract();
		write(
			MAP,
			`${readStagedMap()}\n${route("C9", "`docs/renamed-away.md` for this")}`,
		);

		expect(check({}, "--root", root).status).toBe(0);
		const bare = check();
		expect(bare.status).toBe(1);
		expect(bare.out).toContain("C9 \u2192 docs/renamed-away.md");
	});

	it("refuses a Section C route the commit itself carries", () => {
		writeMap(rootRows, route("C9", "`docs/renamed-away.md` for this"));
		stageSidecars();
		const root = extract();

		const r = check({}, "--root", root);
		expect(r.status).toBe(1);
		expect(r.out).toContain("C9 \u2192 docs/renamed-away.md");
	});

	/* The leg mantahostels#1922 was filed for: the tracked ENUMERATION, which `git ls-files`
	 * answered against the shared index and the process's own cwd. */
	it("enumerates the tracked set by walking the root", () => {
		writeMap(rootRows);
		stageSidecars();
		const root = extract();
		// Tracked in the live repo, absent from the extraction: coverage is asked
		// of the commit's files, so this one is not owed a register row.
		track("docs/added-after.md");

		expect(check({}, "--root", root).status).toBe(0);
		// The same repo state without --root is a coverage FAIL, which is what
		// makes the assertion above about the root rather than about luck.
		const bare = check();
		expect(bare.status).toBe(1);
		expect(bare.out).toContain("docs/added-after.md");
	});

	it("still refuses a dead entry the commit itself carries", () => {
		track("docs/registered.md");
		writeMap([...rootRows, row("docs/registered.md")]);
		stageSidecars();
		git("rm", "-q", "-f", "--", "docs/registered.md");
		const root = extract();

		const r = check({}, "--root", root);
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/registered.md");
	});

	/* THE DELIBERATE EXCEPTION, recorded in the checker's header: the two
	 * untracked softeners keep asking the live repo under --root. An extraction
	 * has no untracked files, so resolving them against it would answer "absent"
	 * for every one and turn each WARN back into the FAIL mantahostels#1193 removed. */
	it("softens a row for an untracked file, reading the live tree for it", () => {
		writeMap([...rootRows, row("docs/pending.md")]);
		stageSidecars();
		const root = extract();
		// Written but never staged: absent from the extraction, present on disk.
		write("docs/pending.md", "x\n");

		const r = check({}, "--root", root);
		expect(r.status).toBe(0);
		expect(r.out).toContain("present on disk but not yet tracked by git");
		expect(r.out).toContain("docs/pending.md");
	});

	it("is BROKEN when the root holds no map, naming the rooted path", () => {
		writeMap(rootRows);
		const absent = path.join(os.tmpdir(), "no-such-root-1922");
		const r = check({}, "--root", absent);
		expect(r.status).toBe(2);
		// Rooted, so it is the copy that is missing and not docs/doc-map.md.
		expect(r.out).toContain(path.join(absent, MAP));
	});

	/* The other apparatus failure --root introduces: the map reads and the WALK
	 * does not. BROKEN, never a clean tree — an unreadable tree must not report
	 * the repo covered. */
	it("is BROKEN when the tree will not walk, and says which read failed", () => {
		// Not docs/: the map lives there and would fail its own read first, which
		// is a different BROKEN.
		track("side/thing.md");
		writeMap([...rootRows, row("side/thing.md")]);
		stageSidecars();
		const root = extract();
		const shut = path.join(root, "side");
		fs.chmodSync(shut, 0o000);
		try {
			const r = check({}, "--root", root);
			expect(r.status).toBe(2);
			// The --root arm of the ternary, not `git ls-files failed`.
			expect(r.out).toContain("could not walk the materialised tree");
			expect(r.out).toContain("No coverage conclusion drawn");
		} finally {
			fs.chmodSync(shut, 0o755);
		}
	});
});

/*
 * mantahostels#2068's acceptance criteria require this of every file migrated onto
 * scripts/lib/git-fixture.ts: a write made in an instantiated copy must not
 * reach the template, or a second, independent copy of it. The helper's own
 * leak check already throws on instantiation if relinking left the copy
 * pointing at the template (proven in git-fixture.test.ts) — what is left to
 * assert here is the BEHAVIOURAL isolation a leak would cause.
 *
 * Only the grace-window template carries this case: the base template
 * (Class 1) never commits, so a fresh instantiation of it has no history for
 * a leaked commit to show up in — `git log` there exits 128 whether or not
 * isolation held, which cannot discriminate a leak from a clean copy. The
 * grace variant commits, so its fresh copy has real history to check against.
 */
describe("the copied fixture is isolated from its template (mantahostels#1907, mantahostels#2068, mantahostels#2072)", () => {
	it("a commit made in one grace variant's copy leaves a fresh copy of it untouched", () => {
		useGrace("fresh-uncovered-file");
		track("docs/only-in-this-copy.md");
		commit("only in this grace copy");
		expect(git("log", "--oneline")).toContain("only in this grace copy");

		const fresh = mkScratchDir("doc-map-grace-fresh-");
		try {
			graceTemplate.instantiate(fresh, "fresh-uncovered-file");
			expect(
				execFileSync("git", ["log", "--oneline"], {
					cwd: fresh,
					encoding: "utf8",
				}),
			).not.toContain("only in this grace copy");
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
});

describe("live section references (#805)", () => {
	it("fails a reference to a section the map does not carry, naming the file", () => {
		writeMap(baselineRows);
		track("CLAUDE.md", "Read `docs/doc-map.md` §The propagation pass first.\n");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"1 reference(s) to a docs/doc-map.md section that does not exist:",
		);
		expect(r.out).toContain("CLAUDE.md: §The propagation pass first.");
		expect(r.out).toContain("Point the reference at a heading the map carries");
		const envelope = JSON.parse(check({}, "--json").stdout);
		expect(envelope.sectionRefs).toEqual([
			{ file: "CLAUDE.md", ref: "§The propagation pass first." },
		]);
	});

	it("passes a reference that names a section, and skips a test file and a binary asset", () => {
		writeMap(baselineRows);
		track("CLAUDE.md", "Read `docs/doc-map.md` §B before writing one.\n");
		track("scripts/x.test.ts", "// docs/doc-map.md §Nope\n");
		track("docs/old.svg", "docs/doc-map.md §Nope\n");
		writeMap([...baselineRows, row("docs/old.svg")]);
		const classes = classesFor([...baselineRows, row("docs/old.svg")]);
		(classes["docs/old.svg"] as { class: string }).class = "binary-asset";
		writeClasses(classes);
		const r = check();
		expect(r.out).not.toContain("DEAD-SECTION-REF");
		expect(r.out).toContain("every doc-map section reference live");
	});
});

/* An adopter has no scripts/ of its own, so each advice line naming
 * register-doc.js spells it at the plugin root (#2066). */
describe("register-doc.js advice in an install", () => {
	let plugin: string;
	beforeEach(() => {
		/* The core's real scripts/ under a root with no package.json, so the
		 * command the advice prints can be run. */
		plugin = fs.mkdtempSync(path.join(scratchBase(), "plugin-"));
		fs.symlinkSync(path.dirname(SCRIPT), path.join(plugin, "scripts"));
	});
	afterEach(() => fs.rmSync(plugin, { recursive: true, force: true }));

	const expectPluginCommand = (out: string) => {
		expect(out).toContain(`  node ${plugin}/scripts/register-doc.js <path>`);
		expect(out).not.toContain("node scripts/register-doc.js");
	};

	it("spells register-doc.js at the plugin root on an uncovered file, in a command that runs from the adopter", () => {
		track("docs/unregistered.md");
		writeMap(baselineRows);
		const r = check({ WFC_SCRIPT_ROOT: plugin });
		expect(r.out).toContain("have no doc-map register entry:");
		expectPluginCommand(r.out);
		const help = runInProcess(
			path.join(plugin, "scripts", "register-doc.js"),
			["--help"],
			{ cwd: repo, env: process.env },
		);
		expect(help.stdout + help.stderr).toMatch(/^usage: /);
	});

	it("spells register-doc.js at the plugin root on an uncovered file inside the grace window", () => {
		useGrace("fresh-uncovered-file");
		const r = check({ WFC_SCRIPT_ROOT: plugin });
		expect(r.out).toContain("have no doc-map register entry yet");
		expectPluginCommand(r.out);
	});

	it("spells register-doc.js at the plugin root on a prose key with no reader", () => {
		writeMap(baselineRows);
		const data = classesFor(baselineRows) as Record<
			string,
			Record<string, unknown>
		>;
		delete data["docs/notes.md"].reader;
		writeClasses(data);
		const r = check({ WFC_SCRIPT_ROOT: plugin });
		expect(r.out).toContain("carry no reader");
		expectPluginCommand(r.out);
	});

	it("spells register-doc.js at the plugin root on a sidecar that is not canonical", () => {
		writeMap(baselineRows);
		write(CLASSES, JSON.stringify(classesFor(baselineRows), null, 2));
		const r = check({ WFC_SCRIPT_ROOT: plugin });
		expect(r.out).toContain("is not register-doc.js's canonical serialisation");
		expectPluginCommand(r.out);
	});
});
