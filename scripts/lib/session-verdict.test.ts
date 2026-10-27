// @vitest-environment node
/*
 * The session verdict (#1502): whether a session's own last commit, as its
 * commit ledger names it, is attested by certificates over its own work — the
 * question the `result:` gate asks (mantahostels#1253). A throwaway git repo
 * supplies the commits; a stub ledger says whose they are.
 *
 * Loosen a case and a job reports done on a commit no suite ever ran; widen it
 * and a job is blocked on a commit or a file that is not its own.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./run-in-process";

const req = createRequire(__filename);
const { sessionVerdict } = req("./session-verdict.js");
const { markersDir } = req("./marker-root.js");
const { projectSlug } = req("./project-slug.js");

const SID = "me";
const NEIGHBOUR = "them";
const NO_SUCH_SHA = "0".repeat(40);

let dir: string;
/** Each session's commit ledger, oldest first; null is one that will not read. */
let ledgers: Record<string, string[] | null>;
let ledger: ReturnType<typeof stubLedger>;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verdict-")));
	ledgers = {};
	ledger = stubLedger();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	git("commit", "-q", "--allow-empty", "-m", "root");
	/* The published tip the composed attestation diffs from (#814). */
	git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A commit of `file` by `session`'s ledger — none where `session` is null. */
function commitFile(file: string, session: string | null = SID): string {
	fs.writeFileSync(path.join(dir, file), `${file}\n${Math.random()}\n`);
	git("add", "--", file);
	git("commit", "-q", "-m", `add ${file}`);
	const sha = git("rev-parse", "HEAD");
	if (session) ledgers[session] = [...(ledgers[session] ?? []), sha];
	return sha;
}

/** `ledgers` behind the commit ledger's interface (`own-work.js`'s `CommitLedger`). */
const stubLedger = () => ({
	ledgerRoot: (): string | null => dir,
	readCommitsBy: (id: string) => (id in ledgers ? ledgers[id] : []),
	readOwnersOf: (commits: string[]): Map<string, string> | null => {
		const owners = new Map<string, string>();
		for (const [id, shas] of Object.entries(ledgers))
			for (const c of commits)
				if (shas?.includes(c) && !owners.has(c)) owners.set(c, id);
		return owners;
	},
});

function verdict({
	log = () => {
		/* the red-note cases pass their own */
	},
}: {
	log?: (what: string) => void;
} = {}) {
	return sessionVerdict(SID, { root: dir, ledger, log });
}

function writeMarkerStore(lines: string[]) {
	fs.writeFileSync(
		path.join(markersDir(dir), ".test-pass-markers.jsonl"),
		lines.map((l) => `${l}\n`).join(""),
	);
}

/** The whole suite: nothing filtered, every module run. */
const FULL_SCOPE = {
	modulesRun: 40,
	modulesTotal: 40,
	tests: 200,
	skipped: 0,
	nameFilter: null,
	fileFilters: [] as string[],
	changed: false as string | boolean,
};

/** `npm run test:changed` over a fresh read-edge manifest (mantahostels#2146). */
const ADMISSIBLE_SCOPE = {
	...FULL_SCOPE,
	modulesRun: 3,
	changed: "HEAD~1",
	admissible: true,
};

/** A hand-typed one-file run — the shape mantahostels#2154 found nearly every certificate in. */
const NARROW_SCOPE = {
	...FULL_SCOPE,
	modulesRun: 1,
	fileFilters: ["scripts/a.test.ts"],
};

/**
 * A vitest certificate on `sha`, taken over a tree nobody would call clean.
 * `scope` of `null` writes the pre-mantahostels#1230 certificate, which carries no scope at all.
 */
const certificate = (
	sha: string,
	scope: unknown = FULL_SCOPE,
	suite = "vitest",
) =>
	JSON.stringify({
		sha,
		at: new Date().toISOString(),
		suite,
		scope,
		dirtyAtStart: true,
		dirtyCount: 4,
		foreign: [{ path: "scripts/other.js", why: "held by a neighbour" }],
	});

/** An admissible narrowed certificate on `sha`, selected for `file` and reading it alone. */
const narrowed = (sha: string, file: string) =>
	JSON.stringify({
		...JSON.parse(certificate(sha, ADMISSIBLE_SCOPE)),
		dirtyAtStart: false,
		foreign: [],
		treeAtEnd: git("rev-parse", `${sha}^{tree}`),
		closure: [file],
		changedPaths: [file],
	});

/** The session's own commit of `file`, and a store attesting some OTHER commit. */
function committedUnattested(file = "a.txt"): string {
	const sha = commitFile(file);
	writeMarkerStore([certificate(NO_SUCH_SHA)]);
	return sha;
}

describe("the session's commit comes from its commit ledger (#1472 Q1 (A))", () => {
	it("is attested once a marker names that commit, dirty tree and all", () => {
		const sha = commitFile("a.txt");
		writeMarkerStore([certificate(sha)]);

		expect(verdict()).toEqual({ state: "attested", at: sha });
	});

	it("is owed, naming that commit, where no certificate attests it", () => {
		const sha = committedUnattested();

		const v = verdict();
		expect(v.state).toBe("owed");
		expect(v.own).toBe(sha);
		expect(v.text.unattested).toContain(".test-pass-markers.jsonl");
		expect(v.text.run.startsWith("npm run test\n\n")).toBe(true);
	});

	it("reads the session's own last commit, not HEAD", () => {
		const mine = commitFile("mine.txt");
		writeMarkerStore([certificate(mine)]);
		/* A neighbour commits, moving HEAD onto bytes this session never ran. */
		commitFile("theirs.txt", NEIGHBOUR);

		expect(verdict()).toEqual({ state: "attested", at: mine });
	});

	it("never reads a neighbour's commit of a file this session also wrote as its own", () => {
		const mine = commitFile("shared.txt");
		writeMarkerStore([certificate(mine)]);
		commitFile("shared.txt", NEIGHBOUR);

		expect(verdict()).toEqual({ state: "attested", at: mine });
	});

	it("owes nothing where the session committed nothing", () => {
		fs.writeFileSync(path.join(dir, "a.txt"), "uncommitted\n");
		writeMarkerStore([certificate(NO_SUCH_SHA)]);

		expect(verdict()).toEqual({ state: "attested", at: null });
	});

	it("owes nothing where its ledger names no commit HEAD contains", () => {
		git("switch", "-q", "-c", "spike/elsewhere");
		commitFile("a.txt");
		git("switch", "-q", "main");
		writeMarkerStore([certificate(NO_SUCH_SHA)]);

		expect(verdict()).toEqual({ state: "attested", at: null });
	});

	it("passes over a ledgered commit git cannot name", () => {
		ledgers[SID] = ["f".repeat(40)];
		writeMarkerStore([certificate(NO_SUCH_SHA)]);

		expect(verdict()).toEqual({ state: "attested", at: null });
	});

	it("takes the newest HEAD contains, passing over a newer one it does not", () => {
		const mine = commitFile("a.txt");
		writeMarkerStore([certificate(mine)]);
		git("switch", "-q", "-c", "spike/elsewhere");
		commitFile("b.txt");
		git("switch", "-q", "main");

		expect(verdict()).toEqual({ state: "attested", at: mine });
	});

	it("is unjudged where the commit ledger will not read", () => {
		committedUnattested();
		ledgers[SID] = null;

		expect(verdict()).toEqual({
			state: "unjudged",
			why: "commit ledger unreadable",
		});
	});

	it("is unjudged where no main worktree holds the ledger", () => {
		committedUnattested();
		ledger.ledgerRoot = () => null;

		expect(verdict()).toEqual({
			state: "unjudged",
			why: "commit ledger unreadable",
		});
	});
});

describe("it judges the session's own work only (#1472 Q2 (A))", () => {
	/** A neighbour's unattested commit, and the session's attested one above it. */
	function neighbourUnderMine() {
		commitFile("theirs.txt", NEIGHBOUR);
		const mine = commitFile("mine.txt");
		writeMarkerStore([narrowed(mine, "mine.txt")]);
		return mine;
	}

	it("owes nothing for a neighbour's unattested commit under its own attested one, which push:check still reports", () => {
		const mine = neighbourUnderMine();

		expect(verdict()).toEqual({ state: "attested", at: mine });

		const home = path.join(dir, ".claude-home");
		/* The neighbour's ledger where push:check reads it, its session ended. */
		const theirs = path.join(
			home,
			"projects",
			projectSlug(dir),
			"commits",
			`${NEIGHBOUR}.txt`,
		);
		fs.mkdirSync(path.dirname(theirs), { recursive: true });
		fs.writeFileSync(theirs, `${ledgers[NEIGHBOUR]?.join("\n")}\n`);
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude/workflow-core.json"),
			JSON.stringify({ commands: { test: "node scripts/run-vitest.js" } }),
		);
		const r = runInProcess(path.join(__dirname, "..", "push-check.js"), [], {
			cwd: dir,
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: dir,
				CLAUDE_CONFIG_DIR: home,
				CLAUDE_CODE_SESSION_ID: SID,
			},
		});
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("theirs.txt — commit");
		expect(r.stdout).toContain("made by session(s) that have ended");
		expect(r.stdout).toContain("-- --adopt theirs.txt");
	});

	it("judges the whole range where whose commits are whose cannot be told", () => {
		neighbourUnderMine();
		ledger.readOwnersOf = () => null;

		const v = verdict();
		expect(v.state).toBe("owed");
		expect(v.text.unattested).toContain("theirs.txt — commit");
		expect(v.text.unattested).toContain("its range from `origin/main` changes");
		expect(v.text.unattested).toMatch(/` prints the same\.$/);
	});

	it("counts a commit no ledger names as its own, which over-selects (#1154)", () => {
		commitFile("stray.txt", null);
		const mine = commitFile("mine.txt");
		writeMarkerStore([narrowed(mine, "mine.txt")]);

		const v = verdict();
		expect(v.state).toBe("owed");
		expect(v.text.unattested).toContain("stray.txt — commit");
	});
});

/*
 * mantahostels#2167. `suiteOf` answers `vitest` for every vitest marker however little of
 * the suite ran, so it cannot tell the narrow certificate below from a whole run.
 */
describe("only a run wide enough to attest the sha clears it", () => {
	function attested(scope: unknown) {
		const sha = commitFile("a.txt");
		writeMarkerStore([
			JSON.stringify({
				...JSON.parse(certificate(sha, scope)),
				changedPaths: ["a.txt"],
			}),
		]);
		return sha;
	}

	it("is owed on a certificate whose scope is a filtered one-file run", () => {
		attested(NARROW_SCOPE);
		expect(verdict().state).toBe("owed");
	});

	it("is owed on a certificate whose scope is a bare --changed run nothing admitted", () => {
		/* The same selection an admissible run makes, minus the certificate. */
		attested({ ...ADMISSIBLE_SCOPE, admissible: false });
		expect(verdict().state).toBe("owed");
	});

	it("is owed on a pre-mantahostels#1230 certificate carrying no scope at all", () => {
		attested(null);
		expect(verdict().state).toBe("owed");
	});

	it("is owed on a full certificate from another suite entirely", () => {
		const sha = commitFile("a.txt");
		writeMarkerStore([certificate(sha, FULL_SCOPE, "pytest")]);
		expect(verdict().state).toBe("owed");
	});

	it("is attested by an admissible filtered certificate", () => {
		attested(ADMISSIBLE_SCOPE);
		expect(verdict().state).toBe("attested");
	});

	it("is attested by a full certificate, ignoring a narrow one sharing its sha", () => {
		const sha = commitFile("a.txt");
		writeMarkerStore([
			certificate(sha, NARROW_SCOPE),
			certificate(sha, FULL_SCOPE),
		]);
		expect(verdict().state).toBe("attested");
	});

	it("reads the scope of the certificate on THIS sha, not of any other in the store", () => {
		const sha = commitFile("a.txt");
		writeMarkerStore([
			certificate(NO_SUCH_SHA, FULL_SCOPE),
			certificate(sha, NARROW_SCOPE),
		]);
		expect(verdict().state).toBe("owed");
	});

	/*
	 * #189: a certificate can also attest by tree. `certificate` stamps a dirty
	 * tree, which the tree route answers for itself — the diff-tree proved the
	 * dirt outside the closure.
	 */
	describe("by tree rather than by sha (#189)", () => {
		const readTree = (ref: string) => git("rev-parse", `${ref}^{tree}`);
		/** A marker on some other sha whose tree is `ref`'s. */
		const onTree = (ref: string, scope: unknown, extra = {}) =>
			JSON.stringify({
				...JSON.parse(certificate(NO_SUCH_SHA, scope)),
				treeAtEnd: readTree(ref),
				...extra,
			});

		it("is attested by a full certificate whose tree is this commit's, under another sha", () => {
			const sha = commitFile("a.txt");
			git("commit", "-q", "--allow-empty", "-m", "moved sha, same tree");
			ledgers[SID]?.push(git("rev-parse", "HEAD"));
			writeMarkerStore([onTree(sha, FULL_SCOPE, { closure: "*" })]);

			expect(verdict().state).toBe("attested");
		});

		it("is owed on a full certificate on an equal tree that carries no closure", () => {
			const sha = commitFile("a.txt");
			writeMarkerStore([onTree(sha, FULL_SCOPE)]);
			expect(verdict().state).toBe("owed");
		});

		it("is owed on a narrow certificate on an equal tree, however complete its closure", () => {
			const sha = commitFile("a.txt");
			writeMarkerStore([onTree(sha, NARROW_SCOPE, { closure: "*" })]);
			expect(verdict().state).toBe("owed");
		});

		it("is attested by an admissible certificate over a dirty tree on the commit made from it", () => {
			fs.writeFileSync(path.join(dir, "a.txt"), "own edit\n");
			git("add", "--", "a.txt");
			git("commit", "-q", "-m", "track a.txt");
			git("update-ref", "refs/remotes/origin/main", "HEAD");
			fs.writeFileSync(path.join(dir, "a.txt"), "own edit v1\n");
			fs.writeFileSync(path.join(dir, "neighbour.txt"), "dirt\n");
			git("add", "--", "neighbour.txt");
			const stashed = git("stash", "create");
			const marker = JSON.stringify({
				...JSON.parse(certificate(NO_SUCH_SHA, ADMISSIBLE_SCOPE)),
				treeAtEnd: git("rev-parse", `${stashed}^{tree}`),
				closure: ["a.test.ts", "a.txt"],
				changedPaths: ["a.txt", "neighbour.txt"],
				base: git("rev-parse", "HEAD"),
			});
			git("commit", "-q", "-m", "own edit", "--", "a.txt");
			ledgers[SID] = [git("rev-parse", "HEAD")];
			writeMarkerStore([marker]);

			expect(verdict().state).toBe("attested");
		});

		it("is attested by an EMPTY admissible selection on the docs-only commit made from it (#189 §6)", () => {
			fs.writeFileSync(path.join(dir, "notes.md"), "prose\n");
			git("add", "--", "notes.md");
			const stashed = git("stash", "create");
			const marker = JSON.stringify({
				...JSON.parse(
					certificate(NO_SUCH_SHA, {
						...ADMISSIBLE_SCOPE,
						modulesRun: 0,
					}),
				),
				treeAtEnd: git("rev-parse", `${stashed}^{tree}`),
				closure: ["docs/test-read-edges.json", "package.json"],
				changedPaths: ["notes.md"],
				base: git("rev-parse", "HEAD"),
			});
			git("commit", "-q", "-m", "docs only", "--", "notes.md");
			ledgers[SID] = [git("rev-parse", "HEAD")];
			writeMarkerStore([marker]);

			expect(verdict().state).toBe("attested");
		});
	});
});

/*
 * #814: the verdict reads the composed attestation (ADR-0009) at the session's own
 * commit, at HEAD, and at any full or admissible run's sha between them.
 */
describe("composed certificates clear the session's commit, or a later one containing it", () => {
	it("is attested through a later commit that contains it", () => {
		commitFile("mine.txt");
		const head = commitFile("theirs.txt", null);
		writeMarkerStore([certificate(head)]);

		expect(verdict()).toEqual({ state: "attested", at: head });
	});

	it("is attested where an earlier commit containing the session's is attested and a later one is not", () => {
		commitFile("mine.txt");
		const attested = commitFile("theirs.txt", null);
		commitFile("untested.txt", null);
		writeMarkerStore([certificate(attested)]);

		expect(verdict()).toEqual({ state: "attested", at: attested });
	});

	it("is attested by two narrowed certificates that attest it only between them", () => {
		const first = commitFile("mine.txt");
		const head = commitFile("theirs.txt");
		writeMarkerStore([
			narrowed(first, "mine.txt"),
			narrowed(head, "theirs.txt"),
		]);

		expect(verdict().state).toBe("attested");
	});

	it.each([0, 1])("is owed on narrowed certificate %i alone", (i) => {
		const first = commitFile("mine.txt");
		const head = commitFile("theirs.txt");
		writeMarkerStore([
			[narrowed(first, "mine.txt"), narrowed(head, "theirs.txt")][i],
		]);

		expect(verdict().state).toBe("owed");
	});

	it("names each unattested file and its commit at HEAD, and why a run now counts", () => {
		const mine = commitFile("mine.txt");
		const head = commitFile("theirs.txt", null);
		writeMarkerStore([certificate(NO_SUCH_SHA)]);

		const v = verdict();
		expect(v.at).toBe(head);
		expect(v.text.unattested).toMatch(
			new RegExp(
				`At ${head.slice(0, 12)}:\n⚠  2 FILE\\(S\\) IN \\S+ LACK A VITEST CERTIFICATE:`,
			),
		);
		expect(v.text.unattested).toContain(
			`mine.txt — commit ${mine.slice(0, 12)}`,
		);
		expect(v.text.unattested).toContain(
			`theirs.txt — commit ${head.slice(0, 12)}`,
		);
		expect(v.text.unattested).toContain(
			"this session's own commits change in its range",
		);
		expect(v.text.unattested).toMatch(
			/` judges every commit the next push sends, so it may also name a neighbour's, which is not this session's to attest\.$/,
		);
		expect(v.text.run).toContain(
			"`npm run test` is the run whose certificate attests a commit already made, and that certificate now counts for your commit because HEAD contains it.",
		);
		expect(v.text.run).toContain(
			"`npm run test:changed` is not its equal: it selects only your uncommitted files, so after a commit it selects nothing from it (#1217).",
		);
	});

	it("names the pytest gap on a Python commit only vitest left a certificate on", () => {
		const sha = commitFile("pipe.py");
		writeMarkerStore([certificate(sha)]);

		const { text } = verdict();
		expect(text.unattested).toMatch(
			/1 FILE\(S\) IN \S+ LACK A PYTEST CERTIFICATE/,
		);
		expect(text.unattested).toContain(`pipe.py — commit ${sha.slice(0, 12)}`);
		expect(text.unattested).not.toContain("VITEST");
	});

	it("is unjudged where the attestation cannot be judged", () => {
		git("update-ref", "-d", "refs/remotes/origin/main");
		committedUnattested();

		const v = verdict();
		expect(v.state).toBe("unjudged");
		expect(v.why).toContain("could not judge attestation");
	});
});

describe("an unreadable certificate store is no evidence the suite did not run", () => {
	it("is unjudged where the marker store is missing", () => {
		commitFile("a.txt");
		expect(verdict().why).toContain("certificate store missing");
	});

	it("is unjudged where every line in the store is unparseable", () => {
		commitFile("a.txt");
		writeMarkerStore(["{not json", "also not json"]);
		expect(verdict().why).toContain("certificate store missing");
	});
});

describe("the owed text's parts", () => {
	it("prescribes re-running only the tests a neighbour's commit voided, where every owed file names them (#1860)", () => {
		fs.mkdirSync(path.join(dir, "docs"));
		fs.writeFileSync(
			path.join(dir, "docs/test-read-edges.json"),
			JSON.stringify({ edges: { "docs/d.md": ["t.test.ts"] } }),
		);
		for (const f of ["a.js", "docs/d.md", "t.test.ts"]) commitFile(f, null);
		git("add", "-A");
		git("commit", "-q", "-m", "setup");
		const setup = git("rev-parse", "HEAD");
		git("update-ref", "refs/remotes/origin/main", setup);
		/* The session's certificate read a.js as edited, beside docs/d.md as it was. */
		const scratch = commitFile("a.js", null);
		const treeAtEnd = git("rev-parse", `${scratch}^{tree}`);
		git("reset", "-q", "--hard", setup);
		const theirs = commitFile("docs/d.md", NEIGHBOUR);
		git("update-ref", "refs/remotes/origin/main", theirs);
		git("checkout", "-q", scratch, "--", "a.js");
		git("commit", "-q", "-m", "mine");
		ledgers[SID] = [git("rev-parse", "HEAD")];
		writeMarkerStore([
			JSON.stringify({
				...JSON.parse(certificate(setup, ADMISSIBLE_SCOPE)),
				dirtyAtStart: false,
				foreign: [],
				treeAtEnd,
				closure: ["a.js", "docs/d.md", "t.test.ts"],
				selected: ["t.test.ts"],
				changedPaths: ["a.js"],
				imports: { "t.test.ts": ["a.js"] },
				roots: [],
			}),
		]);

		const v = verdict();
		expect(v.state).toBe("owed");
		expect(
			v.text.run.startsWith("npm run test -- --retest t.test.ts\n\n"),
		).toBe(true);
	});

	it("prescribes the narrowed default, and says what makes one admissible", () => {
		committedUnattested();

		const { text } = verdict();
		expect(text.run).toContain("scripts/run-vitest.js");
		expect(text.run).toContain("merge-base(HEAD, origin/main)");
		expect(text.run).toContain("docs/test-read-edges.json");
		expect(text.run).not.toContain("--full");
	});

	it("owes nothing where the landing module is on (#2933)", () => {
		vi.stubEnv("WFC_MODULES", "suites,landing");
		try {
			committedUnattested();
			expect(verdict()).toEqual({
				state: "skipped",
				why: expect.stringContaining('module "landing" is on'),
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("names the reap both npm suite scripts pay on their way in, and no hand reap", () => {
		committedUnattested();

		const { text } = verdict();
		/* mantahostels#1843: the session stopped on a `free -m` read taken before the
		 * suite, so the reap never fired for it. */
		expect(text.reap).toContain("scripts/pretest-reap.js");
		expect(text.reap).toContain("free -m");
		/* #633 gave `test:changed` a `pretest:changed` reap like `test`'s
		 * `pretest`, so the hand reap this text once named for it is gone (#635). */
		expect(text.reap).not.toContain("scripts/reap-finished-sessions.js");
		expect(text.reap).not.toMatch(/reap by hand/i);
		expect(text.reap).toContain("the rung the run needs");
	});
});

/**
 * A red vitest marker on `sha`, failing in `files`. `scope` overrides let a
 * case narrow the run without restating the rest of it.
 */
const redMarker = (
	sha: string,
	files: string[],
	{
		at = new Date().toISOString(),
		suite = "vitest",
		scope = {},
	}: { at?: string; suite?: string; scope?: Record<string, unknown> } = {},
) =>
	JSON.stringify({
		sha,
		at,
		suite,
		scope: {
			...FULL_SCOPE,
			failed: files.length,
			failures: files.map((file) => ({ file, tests: ["a case"] })),
			...scope,
		},
	});

function writeFailStore(lines: string[]) {
	fs.writeFileSync(
		path.join(markersDir(dir), ".test-fail-markers.jsonl"),
		lines.map((l) => `${l}\n`).join(""),
	);
}

describe("the red note names the last full red, so the exemption is checkable (mantahostels#2205)", () => {
	/** The red note of an owed verdict over `lines`, and what it logged. */
	function readRedNote(lines: string[] | null) {
		committedUnattested();
		if (lines) writeFailStore(lines);
		const logged: string[] = [];
		const v = verdict({ log: (what) => logged.push(what) });
		return { red: v.text.red as string, logged: logged.join("\n") };
	}

	it("names its sha, its age and its failing files", () => {
		const red = "b".repeat(40);
		const note = readRedNote([
			redMarker(red, [
				path.join(dir, "scripts/one.test.ts"),
				path.join(dir, "scripts/two.test.ts"),
			]),
		]).red;
		expect(note).toContain(".test-fail-markers.jsonl");
		expect(note).toContain(red.slice(0, 12));
		expect(note).toMatch(/\d+ min old/);
		expect(note).toContain("\n  scripts/one.test.ts\n");
		expect(note).toContain("\n  scripts/two.test.ts\n");
	});

	it("asserts nothing about whose work it is, and issues no licence", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/one.test.ts"]),
		]).red;
		/* Naming the exemption available was option (C) of mantahostels#2205, declined. */
		expect(note).toContain("EVIDENCE, NOT A LICENCE");
		expect(note).not.toMatch(/not your(s)? (work|red)/i);
		expect(note).not.toMatch(/exemption is available/i);
	});

	it("takes the most recent full red, not the most recent red", () => {
		const note = readRedNote([
			redMarker("a".repeat(40), ["scripts/old.test.ts"]),
			redMarker("b".repeat(40), ["scripts/wide.test.ts"]),
			redMarker("c".repeat(40), ["scripts/narrow.test.ts"], {
				scope: { modulesRun: 1 },
			}),
		]).red;
		expect(note).toContain("scripts/wide.test.ts");
		expect(note).not.toContain("scripts/narrow.test.ts");
		expect(note).not.toContain("scripts/old.test.ts");
	});

	it("offers a red that collected 90% of the corpus", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/most.test.ts"], {
				scope: { modulesRun: 36, modulesTotal: 40 },
			}),
		]).red;
		expect(note).toContain("scripts/most.test.ts");
	});

	it("offers no red narrower than that", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/some.test.ts"], {
				scope: { modulesRun: 35, modulesTotal: 40 },
			}),
		]).red;
		expect(note).toBe("");
	});

	it("ignores another suite's red", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/py.test.ts"], { suite: "pytest" }),
		]).red;
		expect(note).toBe("");
	});

	it("is empty, and logged, where the red store is absent", () => {
		const { red, logged } = readRedNote(null);
		expect(red).toBe("");
		expect(logged).toContain("red store missing, unreadable");
	});

	it("is empty where the red store cannot be read at all", () => {
		/* A directory where the store should be: `readFailures`'s own catch
		 * answers []. */
		fs.mkdirSync(path.join(markersDir(dir), ".test-fail-markers.jsonl"));
		const { red, logged } = readRedNote(null);
		expect(red).toBe("");
		expect(logged).toContain("red store missing, unreadable");
	});

	it("is empty, and logged, where every line is torn", () => {
		const { red, logged } = readRedNote(["{not json", "also not json"]);
		expect(red).toBe("");
		expect(logged).toContain("red store missing, unreadable");
	});

	it("logs nothing where the store is readable and holds no wide red", () => {
		const { red, logged } = readRedNote([
			redMarker("b".repeat(40), ["scripts/one.test.ts"], {
				scope: { modulesRun: 1 },
			}),
		]);
		expect(red).toBe("");
		expect(logged).toBe("");
	});

	it("ignores a red narrowed by a name filter, however many modules it ran", () => {
		/* Why the ratio alone cannot see this: `isFullScopeRed`'s docstring. */
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/named.test.ts"], {
				scope: { nameFilter: "some case" },
			}),
		]).red;
		expect(note).toBe("");
	});

	it("prints the age in hours for a red hours old", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/one.test.ts"], {
				at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
			}),
		]).red;
		expect(note).toContain("3.0 h old");
	});

	it("prints the age in days for a red days old", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/one.test.ts"], {
				at: new Date(Date.now() - 5 * 24 * 3_600_000).toISOString(),
			}),
		]).red;
		expect(note).toContain("5 days old");
	});

	it("says the age is unknown rather than inventing one", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/one.test.ts"], { at: "not a date" }),
		]).red;
		expect(note).toContain("of unknown age");
		expect(note).toContain("scripts/one.test.ts");
	});

	it("truncates a long failing list and says how many it dropped", () => {
		const many = Array.from({ length: 26 }, (_, i) => `scripts/f${i}.test.ts`);
		const note = readRedNote([redMarker("b".repeat(40), many)]).red;
		expect(note).toContain("scripts/f19.test.ts");
		expect(note).not.toContain("scripts/f20.test.ts");
		expect(note).toContain("...and 6 more");
	});

	it("says nothing about how many it dropped where it dropped none", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/one.test.ts"]),
		]).red;
		expect(note).not.toContain("more");
	});

	it("prints a path outside the repo root as it stands", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["/elsewhere/x.test.ts"]),
		]).red;
		expect(note).toContain("  /elsewhere/x.test.ts");
	});

	it("prints an already-relative path as it stands", () => {
		const note = readRedNote([
			redMarker("b".repeat(40), ["scripts/rel.test.ts"]),
		]).red;
		expect(note).toContain("  scripts/rel.test.ts");
	});

	it("offers no red that names no failing file", () => {
		expect(readRedNote([redMarker("b".repeat(40), [])]).red).toBe("");
	});
});
