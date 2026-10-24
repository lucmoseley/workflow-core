// @vitest-environment node
/*
 * arbiter-bases.js records what HEAD held when a session first wrote a path,
 * and `stale-check` judges a staged path against that base — with
 * `accept-head` and post-commit's `advance-bases` its only moves (#110, #111,
 * #112, #114).
 *
 * Each case runs in arbiter-testkit's sandbox over a real `git init`, with
 * neighbour commits landing for real, because a base is a real blob at a real
 * HEAD; the CLI runs in process.
 *
 * `stale-write-back-gate.sh` in .husky/pre-commit refuses on `stale-check`:
 * loosen a case here and a commit writes back a version a neighbour has since
 * replaced, or real work is refused as stale.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AS_ROOT,
	bases,
	commitAll,
	core,
	finished,
	freshSandbox,
	live,
	noSessions,
	SCRIPT,
	store,
} from "./arbiter-testkit";
import { runInProcess } from "./run-in-process";

const sb = freshSandbox();

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" }).trim();
const write = (rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(sb.repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(sb.repo, rel), text);
};
const headBlob = (rel: string) => git("rev-parse", `HEAD:${rel}`);
/** A neighbour's commit landing on `rel` while this session works. */
const neighbourCommits = (rel: string, text: string) => {
	write(rel, text);
	commitAll(sb, `neighbour edits ${rel}`);
};
/** With no `stdin`, the script's read of fd 0 reaches the test process's own. */
const cli = (args: string[], options: { env?: object; stdin?: string } = {}) =>
	runInProcess(SCRIPT, args, {
		cwd: sb.repo,
		env: { ...process.env, ...options.env },
		stdin: options.stdin,
	});

const DOC = "docs/doc-map.md";
const SCRIPT_REL = "scripts/evidence-audit.py";

/** `sessionId`'s per-path base record for `rel`, as the gate reads it; null where none was minted. */
const pathBase = (rel: string, sessionId: string) => {
	const file = store.paths.base(rel, sessionId);
	if (!fs.existsSync(file)) return null;
	const { head, blob } = core.readRecord(file);
	return { head, blob };
};

/**
 * The base `stale-check` judges `rel` against, per-path or the session's, as
 * `accept-head` logs it. The accept moves the base to HEAD, so a case reads
 * this once, last.
 */
const judgedBase = (rel: string, sessionId = "alice") => {
	const r = cli(["accept-head", rel], {
		env: { CLAUDE_CODE_SESSION_ID: sessionId },
	});
	expect(r.status).toBe(0);
	return JSON.parse(
		fs
			.readFileSync(store.paths.acceptedHeads(sessionId), "utf8")
			.trim()
			.split("\n")
			.at(-1) ?? "",
	).oldBase;
};

beforeEach(() => {
	git("init", "-q");
	write(DOC, "seeded\n");
	write(SCRIPT_REL, "seeded\n");
	commitAll(sb);
});

describe("the per-path base, minted at a session's first write (#110)", () => {
	it("records HEAD's blob and sha when a Write/Edit claim is taken", () => {
		const want = { blob: headBlob(DOC), head: git("rev-parse", "HEAD") };
		store.acquire(DOC, live(sb, "alice"));
		expect(pathBase(DOC, "alice")).toEqual(want);
	});

	it("keeps the first write's base when a neighbour commits and the session writes again", () => {
		const me = live(sb, "alice");
		store.acquire(DOC, me);
		const first = headBlob(DOC);

		neighbourCommits(DOC, "neighbour's\n");
		store.acquire(DOC, me); // reentrant
		bases.mintBase(DOC, "alice"); // and any other route reaching it

		expect(pathBase(DOC, "alice")?.blob).toBe(first);
		expect(headBlob(DOC)).not.toBe(first);
	});

	it("keys a region claim's base on the file", () => {
		const rel = "docs/doc-map.md#B1";
		store.acquire(rel, live(sb, "alice"));
		expect(pathBase(DOC, "alice")).not.toBeNull();
	});

	it("records a null blob for a path HEAD does not have — an addition", () => {
		write("docs/new.md", "new\n");
		store.acquire("docs/new.md", live(sb, "alice"));
		expect(pathBase("docs/new.md", "alice")).toMatchObject({
			blob: null,
		});
	});

	it("records the same on the detect-only observation a second writer gets", () => {
		store.acquire(SCRIPT_REL, live(sb, "alice"));
		const bob = live(sb, "bob");
		store.acquire(SCRIPT_REL, bob); // held — bob gets no lock
		expect(pathBase(SCRIPT_REL, "bob")).toBeNull();

		write(SCRIPT_REL, "bob's\n");
		store.recordObservation(SCRIPT_REL, bob);
		expect(pathBase(SCRIPT_REL, "bob")).toMatchObject({
			blob: headBlob(SCRIPT_REL),
		});
	});

	it("records the same for a path the post-Bash tier scan finds", () => {
		live(sb, "alice");
		expect(cli(["refresh", "alice"]).status).toBe(0); // the tier is now known
		const was = headBlob(SCRIPT_REL);
		write(SCRIPT_REL, "alice's sed\n");
		expect(cli(["refresh", "alice"]).status).toBe(0);
		expect(pathBase(SCRIPT_REL, "alice")).toMatchObject({
			blob: was,
		});
	});

	it("mints no more on one scan tick than the scan's own cap", () => {
		live(sb, "alice");
		const cap = 20; // SCAN_MINT_MAX in lib/arbiter-snapshots.js
		const many = Array.from(
			{ length: cap + 5 },
			(_, i) => `scripts/gen-${String(i).padStart(2, "0")}.py`,
		);
		for (const rel of many) write(rel, "seeded\n");
		commitAll(sb, "seed many");
		expect(cli(["refresh", "alice"]).status).toBe(0);

		for (const rel of many) write(rel, "regenerated\n");
		expect(cli(["refresh", "alice"]).status).toBe(0);
		const minted = () => many.filter((rel) => pathBase(rel, "alice") !== null);
		expect(minted()).toHaveLength(cap);

		expect(cli(["refresh", "alice"]).status).toBe(0);
		expect(minted()).toHaveLength(many.length);
	});

	it("mints nothing without a session id", () => {
		expect(bases.mintBase(DOC, null)).toBeNull();
		expect(fs.existsSync(store.paths.basesDir())).toBe(false);
	});
});

describe("the session-start base, a fallback for every other path (#110)", () => {
	const start = (sessionId: string) =>
		cli(["prune-markers", "--detach"], {
			env: { CLAUDE_CODE_SESSION_ID: "" },
			stdin: JSON.stringify({ session_id: sessionId, source: "startup" }),
		});

	it("is recorded at SessionStart off the hook's own event JSON", () => {
		expect(start("alice").status).toBe(0);
		expect(judgedBase(DOC)).toEqual({
			source: "session",
			head: git("rev-parse", "HEAD"),
			blob: headBlob(DOC),
		});
	});

	it("is recorded once per session — a resume keeps the first", () => {
		start("alice");
		const first = headBlob(DOC);
		neighbourCommits(DOC, "neighbour's\n");
		start("alice");
		expect(judgedBase(DOC)?.blob).toBe(first);
	});

	it("answers for a claim whose base was never minted, from the session's", () => {
		start("alice");
		const was = headBlob(DOC);
		// A mint that failed open: a lock, and no base record beside it.
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		core.writeRecord(store.paths.lock(DOC), {
			path: DOC,
			sessionId: "alice",
			claimId: "unminted",
		});
		neighbourCommits(DOC, "neighbour's\n");
		expect(judgedBase(DOC)).toMatchObject({
			source: "session",
			blob: was,
		});
	});

	it("answers for a path whose own record will not read", () => {
		start("alice");
		store.acquire(DOC, live(sb, "alice"));
		fs.writeFileSync(store.paths.base(DOC, "alice"), "{torn");
		expect(judgedBase(DOC)?.source).toBe("session");
	});

	it("gives a null blob for a path the session-start HEAD did not have", () => {
		start("alice");
		expect(judgedBase("docs/later.md")).toMatchObject({
			source: "session",
			blob: null,
		});
	});

	it("leaves a session with neither record answering null", () => {
		expect(judgedBase(DOC)).toBeNull();
	});
});

const start = (sessionId: string) =>
	cli(["prune-markers", "--detach"], {
		env: { CLAUDE_CODE_SESSION_ID: "" },
		stdin: JSON.stringify({ session_id: sessionId, source: "startup" }),
	});
/** `text` into the object store, as `git add` would stage it. */
const blobOf = (text: string) =>
	execFileSync("git", ["hash-object", "-w", "--stdin"], {
		cwd: sb.repo,
		input: text,
		encoding: "utf8",
	}).trim();
const check = (rel: string, staged: string, sessionId = "alice") =>
	cli(["stale-check", rel, staged], {
		env: { CLAUDE_CODE_SESSION_ID: sessionId },
	});
const staleSetup = () => {
	start("alice");
	store.acquire(DOC, live(sb, "alice"));
	neighbourCommits(DOC, "seeded\nneighbour's line\n");
};

describe("stale-check, the stale-write-back rule for one staged path (#111)", () => {
	it("passes where HEAD has not moved since the base", () => {
		store.acquire(DOC, live(sb, "alice"));
		const r = check(DOC, blobOf("alice's rewrite\n"));
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes where the staged version is HEAD's", () => {
		staleSetup();
		expect(check(DOC, headBlob(DOC)).status).toBe(0);
	});

	it("refuses a stale regeneration, naming the path and the neighbour's commit", () => {
		staleSetup();
		const r = check(DOC, blobOf("seeded\n"));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`refusing ${DOC}`);
		expect(r.stderr).toContain(
			`${git("rev-parse", "--short", "HEAD")} neighbour edits ${DOC}`,
		);
		expect(r.stderr).toContain(`accept-head ${DOC}`);
	});

	it("passes staged content that carries the neighbour's change", () => {
		staleSetup();
		const r = check(DOC, blobOf("seeded\nneighbour's line\nalice's line\n"));
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("judges a path the session never wrote against its session-start base", () => {
		start("alice");
		neighbourCommits(DOC, "seeded\nneighbour's line\n");
		const r = check(DOC, blobOf("seeded\n"));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`neighbour edits ${DOC}`);
		expect(r.stderr).toContain(`accept-head ${DOC}`);
	});

	it("falls back to the session-start base where the path's own record is corrupt", () => {
		staleSetup();
		fs.writeFileSync(store.paths.base(DOC, "alice"), "{torn");
		const r = check(DOC, blobOf("seeded\n"));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`neighbour edits ${DOC}`);
		expect(r.stderr).toContain(`accept-head ${DOC}`);
	});

	it("passes a path absent at the base — an addition", () => {
		start("alice");
		write("docs/new.md", "neighbour's\n");
		commitAll(sb, "neighbour adds docs/new.md");
		const r = check("docs/new.md", blobOf("alice's\n"));
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes a path a neighbour has deleted since the base", () => {
		staleSetup();
		git("rm", "-q", DOC);
		commitAll(sb, `neighbour deletes ${DOC}`);
		const r = check(DOC, blobOf("seeded\n"));
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes a binary path unconditionally", () => {
		const bin = "docs/logo.bin";
		write(bin, "\0seeded");
		commitAll(sb, "seed binary");
		start("alice");
		store.acquire(bin, live(sb, "alice"));
		neighbourCommits(bin, "\0neighbour's");
		const r = check(bin, blobOf("\0seeded"));
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes silently with no session id", () => {
		staleSetup();
		const r = check(DOC, blobOf("seeded\n"), "");
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes silently for a session with no base at all", () => {
		neighbourCommits(DOC, "seeded\nneighbour's line\n");
		const r = check(DOC, blobOf("seeded\n"));
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("fails open with one stderr line naming the path as not checked, where neither record will parse", () => {
		staleSetup();
		fs.writeFileSync(store.paths.base(DOC, "alice"), "{torn");
		fs.writeFileSync(store.paths.sessionBase("alice"), "{torn");
		const r = check(DOC, blobOf("seeded\n"));
		expect(r.status).toBe(0);
		expect(r.stderr.trim().split("\n")).toHaveLength(1);
		expect(r.stderr).toContain(`${DOC} not checked`);
	});

	it.skipIf(AS_ROOT)(
		"fails open with one stderr line where the store will not read",
		() => {
			staleSetup();
			const dir = sb.stateDir();
			fs.chmodSync(dir, 0o000);
			try {
				const r = check(DOC, blobOf("seeded\n"));
				expect(r.status).toBe(0);
				expect(r.stderr.trim().split("\n")).toHaveLength(1);
				expect(r.stderr).toContain(`${DOC} not checked`);
			} finally {
				fs.chmodSync(dir, 0o755);
			}
		},
	);
});

describe("accept-head, stale-check's escape for an intended revert (#112)", () => {
	const accept = (rel: string, sessionId = "alice") =>
		cli(["accept-head", rel], { env: { CLAUDE_CODE_SESSION_ID: sessionId } });
	const logOf = (sessionId: string) =>
		fs
			.readFileSync(store.paths.acceptedHeads(sessionId), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));

	it("turns a refused stale write-back into a pass, and logs the accept", () => {
		staleSetup();
		const oldHead = pathBase(DOC, "alice")?.head;
		const revert = blobOf("seeded\n");
		expect(check(DOC, revert).status).toBe(1);

		const r = accept(DOC);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`base for ${DOC}`);

		const after = check(DOC, revert);
		expect(after.status).toBe(0);
		expect(after.stderr).toBe("");
		const head = git("rev-parse", "HEAD");
		expect(pathBase(DOC, "alice")).toEqual({
			head,
			blob: headBlob(DOC),
		});
		const [entry, ...more] = logOf("alice");
		expect(more).toEqual([]);
		expect(entry).toEqual({
			sessionId: "alice",
			path: DOC,
			oldBase: { source: "path", head: oldHead, blob: blobOf("seeded\n") },
			newBase: { head, blob: headBlob(DOC) },
			at: expect.any(String),
		});
		expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
	});

	it("never touches the working tree or the index", () => {
		staleSetup();
		write(DOC, "alice's unstaged edit\n");
		write("docs/other.md", "alice's staged addition\n");
		git("add", "docs/other.md");
		const tree = fs.readFileSync(path.join(sb.repo, DOC), "utf8");
		const index = git("ls-files", "-s");
		const status = git("status", "--porcelain");

		expect(accept(DOC).status).toBe(0);

		expect(fs.readFileSync(path.join(sb.repo, DOC), "utf8")).toBe(tree);
		expect(git("ls-files", "-s")).toBe(index);
		expect(git("status", "--porcelain")).toBe(status);
	});

	it("moves a path judged on the session-start base, logging that base as the old one", () => {
		start("alice");
		const startHead = git("rev-parse", "HEAD");
		neighbourCommits(DOC, "seeded\nneighbour's line\n");
		expect(accept(DOC).status).toBe(0);
		expect(check(DOC, blobOf("seeded\n")).status).toBe(0);
		expect(logOf("alice")[0].oldBase).toEqual({
			source: "session",
			head: startHead,
			blob: blobOf("seeded\n"),
		});
	});

	it("appends one entry per accept, and leaves another session's base alone", () => {
		staleSetup();
		store.acquire(DOC, live(sb, "bob"));
		const bobs = pathBase(DOC, "bob");
		accept(DOC);
		neighbourCommits(DOC, "seeded\nneighbour's line\nanother\n");
		accept(DOC);
		expect(logOf("alice").map((e) => e.newBase.head)).toEqual([
			git("rev-parse", "HEAD~1"),
			git("rev-parse", "HEAD"),
		]);
		expect(pathBase(DOC, "bob")).toEqual(bobs);
		expect(fs.existsSync(store.paths.acceptedHeads("bob"))).toBe(false);
	});

	it("logs a per-path base that would not read, beside the session base it fell back to", () => {
		staleSetup();
		fs.writeFileSync(store.paths.base(DOC, "alice"), "{torn");
		expect(accept(DOC).status).toBe(0);
		const [entry] = logOf("alice");
		expect(entry.oldBase.source).toBe("session");
		expect(entry.oldBaseFault).toContain(store.paths.base(DOC, "alice"));
		expect(check(DOC, blobOf("seeded\n")).status).toBe(0);
	});

	it("retracts the log entry where the base will not move", () => {
		staleSetup();
		const file = store.paths.base(DOC, "alice");
		fs.rmSync(file);
		fs.mkdirSync(path.join(file, "blocker"), { recursive: true });
		const r = accept(DOC);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("the log entry is retracted");
		const [entry, retraction] = logOf("alice");
		expect(retraction).toEqual({
			retracts: entry.at,
			path: DOC,
			why: expect.stringContaining("the base would not move"),
		});
	});

	it("keys a region's accept on the file", () => {
		staleSetup();
		expect(accept(`${DOC}#B1`).status).toBe(0);
		expect(check(DOC, blobOf("seeded\n")).status).toBe(0);
	});

	it("refuses with no session id, naming CLAUDE_CODE_SESSION_ID and moving nothing", () => {
		staleSetup();
		const before = pathBase(DOC, "alice");
		const r = accept(DOC, "");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("needs CLAUDE_CODE_SESSION_ID");
		expect(pathBase(DOC, "alice")).toEqual(before);
	});

	it.skipIf(AS_ROOT)(
		"refuses, moving nothing, where the log will not write",
		() => {
			staleSetup();
			const before = pathBase(DOC, "alice");
			const dir = store.paths.acceptedHeadsDir();
			fs.mkdirSync(dir, { recursive: true });
			fs.chmodSync(dir, 0o500);
			try {
				const r = accept(DOC);
				expect(r.status).toBe(1);
				expect(r.stderr).toContain(`${DOC} not accepted`);
				expect(pathBase(DOC, "alice")).toEqual(before);
				expect(fs.readdirSync(store.paths.basesDir())).not.toContainEqual(
					expect.stringMatching(/\.tmp$/),
				);
			} finally {
				fs.chmodSync(dir, 0o755);
			}
		},
	);

	it("ages a finished session's log out with its bases, sparing a live one's", () => {
		staleSetup();
		accept(DOC);
		const file = store.paths.acceptedHeads("alice");
		const old = new Date(Date.now() - bases.BASE_AGE_MS - 60_000);
		fs.utimesSync(file, old, old);
		store.pruneAll(noSessions);
		expect(fs.existsSync(file)).toBe(true);
		finished(sb, "alice");
		store.pruneAll(noSessions);
		expect(fs.existsSync(file)).toBe(false);
	});
});

describe("the sweep (#110)", () => {
	const aged = (file: string) => {
		const old = new Date(Date.now() - bases.BASE_AGE_MS - 60_000);
		fs.utimesSync(file, old, old);
	};

	it("spares a live session's base whatever its age", () => {
		store.acquire(DOC, live(sb, "alice"));
		const file = store.paths.base(DOC, "alice");
		aged(file);
		store.pruneAll(noSessions);
		expect(fs.existsSync(file)).toBe(true);
	});

	it("ages out a finished session's base a week after its first write", () => {
		store.acquire(DOC, live(sb, "alice"));
		const file = store.paths.base(DOC, "alice");
		aged(file);
		finished(sb, "alice");
		store.pruneAll(noSessions);
		expect(fs.existsSync(file)).toBe(false);
	});
});

describe("advance-bases, post-commit's move of a session's base (#114)", () => {
	const advance = (commit: string, sessionId = "alice") =>
		cli(["advance-bases", commit], {
			env: { CLAUDE_CODE_SESSION_ID: sessionId },
		});
	const ownCommit = (files: Record<string, string>, message = "alice") => {
		for (const [rel, text] of Object.entries(files)) write(rel, text);
		commitAll(sb, message);
		return git("rev-parse", "HEAD");
	};

	it("makes the commit the base of every path it touched", () => {
		start("alice");
		store.acquire(DOC, live(sb, "alice"));
		const sha = ownCommit({ [DOC]: "alice's\n", "docs/new.md": "n\n" });

		expect(advance(sha).status).toBe(0);
		for (const rel of [DOC, "docs/new.md"])
			expect(pathBase(rel, "alice")).toEqual({
				head: sha,
				blob: headBlob(rel),
			});
	});

	it("leaves a path the commit did not touch on its prior base", () => {
		start("alice");
		store.acquire(SCRIPT_REL, live(sb, "alice"));
		const prior = pathBase(SCRIPT_REL, "alice");
		const sha = ownCommit({ [DOC]: "alice's\n" });

		advance(sha);
		expect(pathBase(SCRIPT_REL, "alice")).toEqual(prior);
	});

	it("records a deleted path with a null blob", () => {
		store.acquire(DOC, live(sb, "alice"));
		fs.rmSync(path.join(sb.repo, DOC));
		commitAll(sb, "alice deletes");
		const sha = git("rev-parse", "HEAD");

		advance(sha);
		expect(pathBase(DOC, "alice")).toEqual({
			head: sha,
			blob: null,
		});
	});

	it("turns a trim of the session's own committed text from a refusal into a pass", () => {
		start("alice");
		store.acquire(DOC, live(sb, "alice"));
		const sha = ownCommit({ [DOC]: "seeded\none\ntwo\nthree\n" });
		const trim = blobOf("seeded\none\n");
		expect(check(DOC, trim).status).toBe(1);

		advance(sha);
		expect(check(DOC, trim).status).toBe(0);
	});

	it("moves only the calling session's base", () => {
		store.acquire(DOC, live(sb, "bob"));
		const bobs = pathBase(DOC, "bob");
		advance(ownCommit({ [DOC]: "alice's\n" }));
		expect(pathBase(DOC, "bob")).toEqual(bobs);
		expect(pathBase(DOC, "alice")?.head).toBe(git("rev-parse", "HEAD"));
	});

	it("refuses a call naming no commit, as a usage error", () => {
		const r = cli(["advance-bases"], {
			env: { CLAUDE_CODE_SESSION_ID: "alice" },
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: session-arbiter.js advance-bases");
	});

	it("does nothing with no session id", () => {
		const sha = ownCommit({ [DOC]: "alice's\n" });
		expect(advance(sha, "").status).toBe(0);
		expect(fs.existsSync(store.paths.basesDir())).toBe(false);
	});

	it("exits 0 with one stderr line where git cannot read the commit, offering accept-head as the way out", () => {
		const r = advance("0000000000000000000000000000000000000000");
		expect(r.status).toBe(0);
		expect(r.stderr.trim().split("\n")).toHaveLength(1);
		expect(r.stderr).toContain("did not become your base");
		expect(r.stderr).toContain("git could not list");
		expect(r.stderr).toContain("accept-head");
	});
});
