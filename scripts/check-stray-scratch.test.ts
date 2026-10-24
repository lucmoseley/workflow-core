// @vitest-environment node
/*
 * Pins which untracked paths the stray-scratch report names, in which of its
 * two buckets and under which remedy, and that it names only what has settled
 * (mantahostels#2349, mantahostels#2455).
 *
 * Every test drives the real script end to end through lib/run-in-process.js,
 * against a throwaway git repo on `--root`. A real repo rather than a stubbed
 * git: what the check asserts is exactly how `git status --porcelain` classifies
 * a path — ignored, tracked, untracked, a collapsed directory — and a stub would
 * be asserting the stub.
 *
 * Fixtures are backdated with `utimesSync`, which sets mtime only, so every run
 * sets `WFC_SCRATCH_AGE_MTIME_ONLY=1` except the #1003 case.
 *
 * The report runs in `npm run status`: loosen a case and scratch the write
 * guard missed piles up unnamed, or an unposted research note is handed an
 * `rm` remedy and lost.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-stray-scratch.js");

/** Mirrors the script's own constant; a change to either should fail a test. */
const NAMED_MAX = 5;

let root: string;
/** Every `mkdtempSync` dir an oracle fixture made this test, swept in `afterEach`. */
let oracleDirs: string[];

/** A throwaway repo with one committed file and `.claude/tmp/` gitignored. */
function makeRepo(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "stray-scratch-")),
	);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	fs.writeFileSync(path.join(dir, ".gitignore"), ".claude/tmp/\n");
	fs.writeFileSync(path.join(dir, "tracked.md"), "one\n");
	git("add", ".gitignore", "tracked.md");
	git("commit", "-qm", "base");
	return dir;
}

/*
 * WRITES A SETTLED PATH — one whose mtime is two days old, so the script's
 * 24-hour cut names it (mantahostels#2436). The default, since every case here asserts on a
 * NAMED path.
 */
function write(rel: string, body = "x\n") {
	writeFresh(rel, body);
	/* THE DIRECTORIES TOO, not just the file. `untrackedEntries` collapses an
	 * untracked directory to one entry, and the script stats THAT entry — so a
	 * fixture that aged only the leaf leaves every collapsed case reading
	 * fresh. */
	const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
	for (let at = path.join(root, rel); at !== root; at = path.dirname(at))
		fs.utimesSync(at, old, old);
}

/** Written now, so the script reads it as a live session's working scratch. */
function writeFresh(rel: string, body = "x\n") {
	const at = path.join(root, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
}

/** Write and commit, so the path's directory is tracked rather than collapsed. */
function commit(rel: string, body = "x\n") {
	write(rel, body);
	execFileSync("git", ["add", rel], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["commit", "-qm", `add ${rel}`], {
		cwd: root,
		stdio: "ignore",
	});
}

/**
 * A fake `claude agents --json`, in the shape `agent-liveness.js` expects.
 * `null` fakes a daemon that will not run at all (limb 2 unreadable).
 *
 * Written OUTSIDE `root`: `root` is the tree this very check scans, so a
 * bin/listing pair dropped inside it would show up as untracked scratch of
 * its own and inflate the counts every test asserts on.
 */
function oracle(agents: { sessionId: string; startedAt?: number }[] | null) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stray-scratch-oracle-"));
	oracleDirs.push(dir);
	const bin = path.join(dir, "fake-claude");
	const listing = path.join(dir, "agents.json");
	if (agents !== null) fs.writeFileSync(listing, JSON.stringify(agents));
	fs.writeFileSync(
		bin,
		`#!/bin/sh\n${
			agents === null
				? 'echo "no daemon" >&2\nexit 1\n'
				: `cat ${JSON.stringify(listing)}\n`
		}`,
		{ mode: 0o755 },
	);
	return bin;
}

/**
 * The default oracle every ordinary test gets: one live session that started
 * NOW — after every path `write()` ages to two days old, and so predating
 * nothing.
 */
function defaultOracle() {
	return oracle([{ sessionId: "s-live", startedAt: Date.now() }]);
}

/**
 * An oracle that also counts its own invocations, in a file OUTSIDE `root`
 * for the same reason `oracle()` is — proves the gate at `check-stray-scratch.js`'s
 * `if (aged.length)` actually skips the spawn rather than merely hiding its
 * answer.
 */
function countingOracle(agents: { sessionId: string; startedAt?: number }[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stray-scratch-counting-"));
	oracleDirs.push(dir);
	const bin = path.join(dir, "fake-claude");
	const listing = path.join(dir, "agents.json");
	const calls = path.join(dir, "calls");
	fs.writeFileSync(listing, JSON.stringify(agents));
	fs.writeFileSync(calls, "");
	fs.writeFileSync(
		bin,
		`#!/bin/sh\nprintf x >> ${JSON.stringify(calls)}\ncat ${JSON.stringify(listing)}\n`,
		{ mode: 0o755 },
	);
	return { bin, callCount: () => fs.readFileSync(calls, "utf8").length };
}

function run(...args: string[]) {
	return runAs("", defaultOracle(), true, ...args);
}

/** `run`, but with the caller's own oracle rather than the always-condemns default. */
function runWithOracle(bin: string, ...args: string[]) {
	return runAs("", bin, true, ...args);
}

/**
 * Under a session id — `""` for none, the plain-terminal shape — and an
 * oracle. `mtimeOnly: false` ages by the real write time (#1003).
 */
function runAs(
	sessionId: string,
	bin: string,
	mtimeOnly: boolean,
	...args: string[]
) {
	// Off, not inherited: a real Actions run sets it globally, and this
	// suite runs inside one — runCheck's per-finding ::warning:: annotation
	// would otherwise leak into `out` uncapped, alongside the capped
	// human-readable list these tests assert on (mantahostels#2427).
	const res = runInProcess(SCRIPT, ["--root", root, ...args], {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			CLAUDE_CODE_SESSION_ID: sessionId,
			WFC_CLAUDE_BIN: bin,
			WFC_SCRATCH_AGE_MTIME_ONLY: mtimeOnly ? "1" : "",
		},
	});
	return { ...res, out: `${res.stdout}${res.stderr}` };
}

interface Envelope {
	outcome: string;
	count: number;
	noun: string;
	summary: string;
	stray: string[];
	strayCount: number;
	strayFresh: number;
	strayUnreadable: number;
	strayLiveSpared: number;
	strayUnverified: number;
	strayUnverifiedWhy?: string;
	strayHidden: number;
	research: string[];
	researchCount: number;
	researchHidden: number;
	findings: { severity: string; tag: string; path: string }[];
}

/** The --json envelope, which is stdout's whole content in that mode. */
function json(...args: string[]) {
	const res = run("--json", ...args);
	return JSON.parse(res.stdout) as Envelope;
}

function jsonWithOracle(bin: string, ...args: string[]) {
	const res = runWithOracle(bin, "--json", ...args);
	return JSON.parse(res.stdout) as Envelope;
}

beforeEach(() => {
	root = makeRepo();
	oracleDirs = [];
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	for (const dir of oracleDirs)
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("check-stray-scratch", () => {
	it("names an untracked path and counts it (mantahostels#2349)", () => {
		write(".c2349.out");

		const { out, status } = run("--notify");

		expect(out).toContain("STRAY-SCRATCH (1)");
		expect(out).toContain(".c2349.out");
		expect(out).toContain("docs/environment.md` §12");
		// The other bucket stays silent (mantahostels#2455) — a regression filling both
		// passes every positive assertion above.
		expect(out).not.toContain("STRANDED-UNTRACKED");
		expect(json().research).toEqual([]);
		// WARN, never FAIL — it reports and a human decides (mantahostels#2349).
		expect(status).toBe(0);
		expect(json().outcome).toBe("WARN");
	});

	it("says nothing at all when the tree carries no untracked path (mantahostels#2349)", () => {
		const { out, status } = run("--notify");

		expect(out).toBe("");
		expect(status).toBe(0);
		expect(json().outcome).toBe("OK");
	});

	it("never reports the sanctioned scratch directory, which git ignores (mantahostels#2103)", () => {
		write(".claude/tmp/scratch.md");

		expect(json().strayCount).toBe(0);
		expect(json().outcome).toBe("OK");
	});

	it("does not report a tracked file that is merely modified (mantahostels#2211)", () => {
		fs.writeFileSync(path.join(root, "tracked.md"), "two\n");

		expect(json().stray).toEqual([]);
	});

	it("collapses an untracked directory to one entry rather than walking it (mantahostels#2211)", () => {
		write("scratchdir/a.out");
		write("scratchdir/b.out");

		expect(json().stray).toEqual(["scratchdir/"]);
	});

	it("caps the named list and hands over the command listing the rest (mantahostels#2349)", () => {
		for (let i = 0; i < NAMED_MAX + 3; i++) write(`.s${i}.out`);

		const { out } = run("--notify");
		const envelope = json();

		expect(envelope.strayCount).toBe(NAMED_MAX + 3);
		expect(envelope.strayHidden).toBe(3);
		expect(out).toContain(`.s${NAMED_MAX - 1}.out`);
		expect(out).not.toContain(`.s${NAMED_MAX}.out`);
		expect(out).toContain("and 3 more");
		expect(out).toContain("git status --porcelain | grep '^??'");
	});

	it("raises one WARN finding per stray path, so none gates (mantahostels#2349)", () => {
		write(".one.out");
		write(".two.out");

		const findings = json().findings;

		expect(findings).toHaveLength(2);
		expect(findings.every((f) => f.severity === "WARN")).toBe(true);
		expect(findings.map((f) => f.path).sort()).toEqual([
			".one.out",
			".two.out",
		]);
	});

	it("names what it counted in the summary noun (mantahostels#2349)", () => {
		write(".one.out");

		const envelope = json();

		expect(envelope.count).toBe(1);
		expect(envelope.noun).toBe("stray scratch path(s)");
	});

	it("SKIPs where git will not answer, rather than reporting a tidy tree (mantahostels#2349)", () => {
		root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-")),
		);

		const envelope = json();

		expect(envelope.outcome).toBe("SKIP");
		expect(envelope.summary).toContain("unknown — not nothing");
		expect(envelope.count).toBe(0);
	});

	it("says nothing on the notify channel when it SKIPs (mantahostels#2349)", () => {
		root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-")),
		);

		// A SKIP line injected into every session start would be worse than silence.
		expect(run("--notify").out).toBe("");
	});

	it("quotes a stray whose name would not survive a shell word (mantahostels#2349)", () => {
		write("scratch file.out");

		expect(run("--notify").out).toContain("'scratch file.out'");
	});

	it("re-reports the same stray on a second run (mantahostels#2349)", () => {
		write(".c2349.out");

		expect(json().strayCount).toBe(1);
		expect(json().strayCount).toBe(1);
	});

	// --- the two buckets (mantahostels#2455) --------------------------------------------

	it("reports an untracked research artefact in its own bucket, not as scratch (mantahostels#2455)", () => {
		// Tracked, so git names the stray file itself rather than the directory.
		commit("docs/research/landed.md");
		write("docs/research/.stranded.findings.md");

		const { out, status } = run("--notify");
		const envelope = json();

		expect(envelope.stray).toEqual([]);
		expect(envelope.research).toEqual(["docs/research/.stranded.findings.md"]);
		expect(out).toContain("STRANDED-UNTRACKED (1)");
		expect(out).not.toContain("STRAY-SCRATCH");
		expect(envelope.outcome).toBe("WARN");
		expect(status).toBe(0);
	});

	it("gives the research bucket a post-to-its-issue remedy and never a bare rm (mantahostels#2455, #2162)", () => {
		commit("docs/research/landed.md");
		write("docs/research/.stranded.findings.md");

		const { out } = run("--notify");

		expect(out).toContain("post it as a comment on its");
		expect(out).toContain("A research artefact is never committed.");
		expect(out).toContain("`rm` IS NOT THE REMEDY");
		expect(out).not.toContain("`rm` is the remedy");
	});

	it("keeps the two remedies apart when both buckets have paths (mantahostels#2455)", () => {
		commit("docs/research/landed.md");
		write("docs/research/.stranded.findings.md");
		write(".c2455.out");

		const { out } = run("--notify");
		const envelope = json();

		expect(envelope.stray).toEqual([".c2455.out"]);
		expect(envelope.research).toEqual(["docs/research/.stranded.findings.md"]);
		expect(out).toContain("STRAY-SCRATCH (1)");
		expect(out).toContain("STRANDED-UNTRACKED (1)");
		expect(out).toContain("`rm` is the remedy");
		expect(out).toContain("`rm` IS NOT THE REMEDY");
		expect(out.indexOf("STRAY-SCRATCH (1)")).toBeLessThan(
			out.indexOf("`rm` is the remedy"),
		);
		expect(out.indexOf("`rm` is the remedy")).toBeLessThan(
			out.indexOf("STRANDED-UNTRACKED (1)"),
		);
	});

	it("says nothing about either bucket on a tree with neither (mantahostels#2455)", () => {
		commit("docs/research/landed.md");

		const { out } = run("--notify");

		expect(out).toBe("");
		expect(json().outcome).toBe("OK");
		expect(json().research).toEqual([]);
		expect(json().stray).toEqual([]);
	});

	it("raises the research bucket at WARN under its own finding code, STRANDED-UNTRACKED, not STRAY-SCRATCH (mantahostels#2455)", () => {
		commit("docs/research/landed.md");
		write("docs/research/.a.findings.md");
		write(".b.out");

		const findings = json().findings;

		expect(findings).toHaveLength(2);
		expect(findings.every((f) => f.severity === "WARN")).toBe(true);
		// Tag TIED TO PATH: a tag set alone passes with the two codes swapped.
		expect(findings.map((f) => `${f.tag} ${f.path}`).sort()).toEqual([
			"STRANDED-UNTRACKED docs/research/.a.findings.md",
			"STRAY-SCRATCH .b.out",
		]);
	});

	it("caps each bucket independently, on the one cap (mantahostels#2455)", () => {
		commit("docs/research/landed.md");
		for (let i = 0; i < NAMED_MAX + 3; i++) write(`.s${i}.out`);
		for (let i = 0; i < NAMED_MAX + 2; i++) write(`docs/research/r${i}.md`);

		const { out } = run("--notify");
		const envelope = json();

		expect(envelope.strayHidden).toBe(3);
		expect(envelope.researchHidden).toBe(2);
		expect(out).toContain("and 3 more");
		expect(out).toContain("and 2 more");
		expect(out).toContain(`docs/research/r${NAMED_MAX - 1}.md`);
		expect(out).not.toContain(`docs/research/r${NAMED_MAX}.md`);
		expect(out).toContain(
			"git ls-files --others --exclude-standard -- docs/research/",
		);
	});

	it("caps a research-only tree on its own (mantahostels#2455)", () => {
		commit("docs/research/landed.md");
		for (let i = 0; i < NAMED_MAX + 2; i++) write(`docs/research/r${i}.md`);

		const { out } = run("--notify");
		const envelope = json();

		expect(envelope.researchHidden).toBe(2);
		expect(envelope.strayHidden).toBe(0);
		expect(out).toContain("and 2 more");
		expect(out).not.toContain("STRAY-SCRATCH");
		expect(envelope.noun).toBe("untracked research artefact(s)");
	});

	it("names both populations in the noun when both buckets have paths (mantahostels#2455)", () => {
		commit("docs/research/landed.md");
		write("docs/research/.a.findings.md");
		write(".b.out");

		const envelope = json();

		expect(envelope.count).toBe(2);
		expect(envelope.noun).toBe("untracked path(s) outside `.claude/tmp/`");
	});

	it("counts a collapsed docs/research/ entry as one artefact, not as scratch (mantahostels#2455)", () => {
		// `docs/` tracked, so git collapses no higher than `docs/research/`.
		commit("docs/keep.md");
		write("docs/research/.a.findings.md");
		write("docs/research/.b.findings.md");

		const envelope = json();

		expect(envelope.research).toEqual(["docs/research/"]);
		expect(envelope.stray).toEqual([]);
		expect(envelope.count).toBe(1);
	});

	it("swallows research into the scratch bucket when docs/ itself collapses (mantahostels#2455)", () => {
		// The accepted limit of one tree read: git collapses no further than the
		// shallowest untracked directory, so `docs/` untracked hides the prefix
		// and the paths take the `rm` remedy. Unreachable in this repo, where
		// `docs/` carries hundreds of tracked files.
		write("docs/research/.a.findings.md");

		expect(json().stray).toEqual(["docs/"]);
		expect(json().research).toEqual([]);
	});

	it("still reports a path that merely looks like docs/research/ (mantahostels#2418)", () => {
		commit("docs/keep.md");
		write("docs/research-notes.out");

		expect(json().stray).toEqual(["docs/research-notes.out"]);
	});
});

/* THE AGE CUT (mantahostels#2436, whose census is on mantahostels#2418). */
describe("the 24-hour cut on the scratch bucket", () => {
	it("does not name a stray a live session may still be writing", () => {
		writeFresh(".fresh2436.out");
		const { out, status } = run("--notify");
		expect(out).not.toContain(".fresh2436.out");
		expect(json().stray).toEqual([]);
		expect(json().findings).toEqual([]);
		expect(status).toBe(0);
	});

	it("counts the fresh ones, so the block cannot be read as the whole tree", () => {
		writeFresh(".fresh2436.out");
		writeFresh(".fresh2436b.out");
		write(".settled2436.out");
		const { out } = run("--notify");
		expect(out).toContain(".settled2436.out");
		expect(out).toContain("2 further untracked path(s)");
		expect(out).toContain("2 under 24 hours old");
		expect(out).toContain("NOT");
		expect(json().strayFresh).toBe(2);
		expect(json().strayCount).toBe(1);
	});

	it("says NOTHING on the notify channel where every stray is fresh", () => {
		/* A `say` from the checker body escapes runCheck's OK suppression, so an
		 * unconditional count would inject an unactionable line into every
		 * session start — and one referring to a named block that was never
		 * printed. */
		writeFresh(".fresh2436.out");
		const { out } = run("--notify");
		expect(out).toBe("");
	});

	it("keeps the count off the summary and the block in step", () => {
		writeFresh(".fresh2436.out");
		expect(json().summary).toContain(
			"1 further untracked path(s) outside `.claude/tmp/` — 1 under 24 hours old",
		);
		write(".settled2436.out");
		expect(run("--notify").out).toContain(
			"1 further untracked path(s) outside `.claude/tmp/` — 1 under 24 hours old",
		);
	});

	it("says so on an all-fresh tree rather than reporting it tidy", () => {
		writeFresh(".fresh2436.out");
		const envelope = json();
		expect(envelope.outcome).toBe("OK");
		expect(envelope.summary).toContain("1 under 24 hours old");
		expect(envelope.strayFresh).toBe(1);
	});

	it("keeps the research bucket off the cut entirely", () => {
		/* A research artefact is finished work whatever its mtime, and its
		 * remedy — post it to its issue, then delete it — is safe on a new file.
		 * A committed neighbour first, or `docs/` itself collapses to one
		 * untracked entry and the path never reaches the research bucket. */
		commit("docs/research/landed.md");
		writeFresh("docs/research/.fresh2436.findings.md");
		const { out } = run("--notify");
		expect(out).toContain("STRANDED-UNTRACKED");
		expect(json().research).toEqual(["docs/research/.fresh2436.findings.md"]);
	});

	it("never names a path it cannot stat, and never calls it deletable", () => {
		/* FAIL-SAFE DIRECTION: an unreadable mtime must not become an `rm`
		 * instruction. A dangling symlink is untracked to git and unstattable
		 * through `statSync`, which follows the link. */
		fs.symlinkSync(
			path.join(root, "nothing-here"),
			path.join(root, ".dangling2436"),
		);
		const { out } = run("--notify");
		expect(out).not.toContain(".dangling2436");
		expect(json().strayUnreadable).toBe(1);
		expect(json().strayFresh).toBe(0);
	});

	it("says its mtime was unreadable rather than asserting an age it never read", () => {
		/* mantahostels#103 §6 asks a fail-open to be VISIBLE where a human reads the output. */
		fs.symlinkSync(
			path.join(root, "nothing-here"),
			path.join(root, ".dangling2436"),
		);
		write(".settled2436.out");
		const { out } = run("--notify");
		expect(out).toContain("1 whose mtime could not be read");
		expect(out).not.toContain("1 under 24 hours old");
	});

	it("names a collapsed scratch directory only once it has settled", () => {
		writeFresh("scratchdir2436/a.out");
		expect(json().stray).toEqual([]);
		const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
		fs.utimesSync(path.join(root, "scratchdir2436"), old, old);
		expect(json().stray).toEqual(["scratchdir2436/"]);
	});
});

describe("the write time userland cannot rewind (#1003)", () => {
	it("reads a path tar extracted from an old commit as fresh, not as stray", () => {
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: root,
				encoding: "buffer",
				env: {
					...process.env,
					GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
					GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
				},
			});
		writeFresh("r2/page.html");
		git("add", "r2/page.html");
		git("commit", "-qm", "r2");
		execFileSync("tar", ["-x", "-C", root], {
			input: git("archive", "--prefix=.extracted1003/", "HEAD", "r2/page.html"),
		});
		const commitMs = Date.parse("2020-01-01T00:00:00Z");
		const bin = oracle([{ sessionId: "s0", startedAt: commitMs + 1000 }]);
		const envelopeAgedBy = (mtimeOnly: boolean) =>
			JSON.parse(runAs("", bin, mtimeOnly, "--json").stdout) as Envelope;
		expect(fs.statSync(path.join(root, ".extracted1003")).mtimeMs).toBe(
			commitMs,
		);

		const envelope = envelopeAgedBy(false);
		expect(envelope.stray).toEqual([]);
		expect(envelope.strayFresh).toBe(1);
		// Not vacuous: by mtime alone the same tree names it under `rm`.
		expect(envelopeAgedBy(true).stray).toEqual([".extracted1003/"]);
	});
});

/* LIMB 2 (mantahostels#2505): the age cut alone is a guess, and the reaper's real gate
 * also asks the liveness oracle whether a live session predates the mtime. */
describe("limb 2 — the liveness oracle", () => {
	it("condemns an age-settled path where the oracle confirms no live session predates it", () => {
		write(".settled2505.out");
		const bin = oracle([{ sessionId: "s-live", startedAt: Date.now() }]);

		const envelope = jsonWithOracle(bin);

		expect(envelope.stray).toEqual([".settled2505.out"]);
		expect(envelope.strayLiveSpared).toBe(0);
	});

	it("spares an age-settled path where a live session started before its mtime", () => {
		write(".live2505.out");
		const before = Date.now() - 72 * 60 * 60 * 1000;
		const bin = oracle([{ sessionId: "s-live", startedAt: before }]);

		const envelope = jsonWithOracle(bin);
		const { out } = runWithOracle(bin, "--notify");

		expect(envelope.outcome).toBe("OK");
		expect(envelope.stray).toEqual([]);
		expect(envelope.strayLiveSpared).toBe(1);
		expect(out).toBe("");
		expect(envelope.summary).toContain(
			"1 settled by age, spared by a live session",
		);
	});

	it("spares every age-settled path on an unreadable oracle, warns rather than reading tidy, and says why", () => {
		write(".unread2505.out");
		const bin = oracle(null);

		const envelope = jsonWithOracle(bin);
		const { out } = runWithOracle(bin, "--notify");

		// An unread oracle means the tree was NOT fully assessed — WARN, not a
		// silent OK.
		expect(envelope.outcome).toBe("WARN");
		expect(envelope.stray).toEqual([]);
		expect(envelope.strayUnverified).toBe(1);
		expect(envelope.strayUnverifiedWhy).toContain("would not run");
		expect(envelope.findings.some((f) => f.tag === "STRAY-UNVERIFIED")).toBe(
			true,
		);
		expect(out).toContain("1 settled by age, unverifiable");
	});

	it("prints the spared count alongside a named stray", () => {
		// Older than the one live session — condemned.
		write(".condemned2505.out");
		// Just past the 24 h age cut, but younger than the live session's
		// start — spared, since that session may still be writing it.
		const barelyAged = Date.now() - 25 * 60 * 60 * 1000;
		writeFresh(".live2505b.out");
		fs.utimesSync(
			path.join(root, ".live2505b.out"),
			new Date(barelyAged),
			new Date(barelyAged),
		);
		const bin = oracle([
			{ sessionId: "s-mid", startedAt: Date.now() - 36 * 60 * 60 * 1000 },
		]);

		const { out } = runWithOracle(bin, "--notify");
		const envelope = jsonWithOracle(bin);

		expect(envelope.stray).toEqual([".condemned2505.out"]);
		expect(envelope.strayLiveSpared).toBe(1);
		expect(out).toContain("STRAY-SCRATCH (1)");
		expect(out).toContain("1 settled by age, spared by a live session");
	});

	it("never surfaces an unverifiable population when nothing has aged in", () => {
		writeFresh(".fresh2505.out");
		const bin = oracle(null);

		const envelope = jsonWithOracle(bin);

		expect(envelope.strayUnverified).toBe(0);
		expect(envelope.strayFresh).toBe(1);
	});

	it("never actually spawns the oracle when nothing has aged in", () => {
		writeFresh(".fresh2505b.out");
		const { bin, callCount } = countingOracle([
			{ sessionId: "s-live", startedAt: Date.now() },
		]);

		jsonWithOracle(bin);

		expect(callCount()).toBe(0);
	});

	it("does spawn the oracle exactly once where limb 1 named a candidate", () => {
		write(".aged2505.out");
		const { bin, callCount } = countingOracle([
			{ sessionId: "s-live", startedAt: Date.now() },
		]);

		jsonWithOracle(bin);

		expect(callCount()).toBe(1);
	});

	it("condemns an age-settled path where the oracle lists the session it runs in", () => {
		write(".self1446.out");
		const bin = oracle([{ sessionId: "s-self", startedAt: Date.now() }]);

		const envelope = JSON.parse(runAs("s-self", bin, true, "--json").stdout);

		expect(envelope.stray).toEqual([".self1446.out"]);
	});

	/* Mid-session the oracle lists its caller, so a listing that omits it is
	 * short, and the strict self-test refuses it (#1446). */
	it("names nothing where the oracle has not listed the session it runs in", () => {
		write(".short1446.out");
		const bin = oracle([{ sessionId: "s-other", startedAt: Date.now() }]);

		const envelope = JSON.parse(runAs("s-self", bin, true, "--json").stdout);

		expect(envelope.stray).toEqual([]);
		expect(envelope.strayUnverified).toBe(1);
		expect(envelope.strayUnverifiedWhy).toContain(
			"does not list this very session",
		);
	});

	it("spares an age-settled path where the oracle lists no readable start time", () => {
		write(".nostart2505.out");
		// A record with no startedAt at all — `earliestStart` reads it as
		// unreadable rather than as "no live session predates this".
		const bin = oracle([{ sessionId: "s-blind" }]);

		const envelope = jsonWithOracle(bin);

		expect(envelope.outcome).toBe("WARN");
		expect(envelope.stray).toEqual([]);
		expect(envelope.strayUnverified).toBe(1);
		expect(envelope.strayUnverifiedWhy).toContain(
			"no session with a readable start time",
		);
	});

	it("still reports STRAY-SCRATCH findings only for oracle-condemned paths", () => {
		write(".condemned2505.out");
		write(".spared2505.out");
		const before = Date.now() - 72 * 60 * 60 * 1000;
		const bin = oracle([
			{ sessionId: "s-old", startedAt: before },
			{ sessionId: "s-new", startedAt: Date.now() },
		]);

		const envelope = jsonWithOracle(bin);

		// The EARLIEST live session is what limb 2 checks, so the old one
		// sparing predates both mtimes: neither is condemned.
		expect(envelope.stray).toEqual([]);
		expect(envelope.strayLiveSpared).toBe(2);
	});
});
