/*
 * proving-run.ts — the harness behind mantahostels#107 (the proving run for mantahostels#96's
 * arbitration side).
 *
 * mantahostels#96's destination requires arbitration to be "proven to work — demonstrated,
 * not merely designed". mantahostels#107 asked how to demonstrate that without the founder
 * hand-orchestrating two live sessions on every run. The answer this harness
 * implements:
 *
 *   Tier 1 — deterministic interleaving. None of the four documented failure
 *   modes is a timing race. mantahostels#63 (index sweep), the stale version bump, mantahostels#87
 *   (wrong-branch commit) and mantahostels#60/mantahostels#73 (held-file deadlock) are all determined
 *   consequences of shared mutable state — the index, a file's content, HEAD,
 *   the working tree.
 *
 *   Tier 2 — real concurrency, but only on the claim primitive. mantahostels#103 §3 designs
 *   against one genuine race: two sessions reading an empty registry in the same
 *   instant. Simultaneity is the whole point of it, so interleaving cannot show
 *   it.
 *
 * Everything runs inside a throwaway arena: a scratch git repo, and a sandbox
 * HOME standing in for the liveness and claim registries. The harness must
 * never write to the real ~/.claude — a test that did could wedge the founder's
 * live sessions — nor to this working tree.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "./proving-session";

const REPO_ROOT = path.resolve(__dirname, "..");

export class Arena {
	readonly dir: string;
	readonly repo: string;
	readonly home: string;

	constructor() {
		this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "proving-run-"));
		this.repo = path.join(this.dir, "repo");
		this.home = path.join(this.dir, "home");
		fs.mkdirSync(this.repo);
		fs.mkdirSync(path.join(this.home, ".claude", "jobs"), { recursive: true });
		fs.mkdirSync(path.join(this.home, ".claude", "sessions"), {
			recursive: true,
		});

		this.git("init", "-q", "-b", "main", ".");
		this.git("config", "user.email", "test@example.com");
		this.git("config", "user.name", "test");
		// The real tree's core.hooksPath is absolute, so a scratch repo would
		// otherwise run this repo's Husky gates (see mantahostels#100's PATH finding).
		this.git("config", "core.hooksPath", path.join(this.dir, "no-hooks"));
	}

	git(...args: string[]) {
		return execFileSync("git", args, { cwd: this.repo, encoding: "utf8" });
	}

	write(file: string, body: string) {
		const full = path.join(this.repo, file);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, body);
	}

	read(file: string) {
		return fs.readFileSync(path.join(this.repo, file), "utf8");
	}

	commitAll(message: string) {
		this.git("add", "-A");
		this.git("commit", "-qm", message);
	}

	/** Env every session in this arena inherits, on top of the registry paths. */
	readonly extraEnv: Record<string, string> = {};

	/**
	 * A fake `gh` on the arbiter's lookup path, so the debt store's issue
	 * lifecycle can be exercised without a network call or a real issue number.
	 * `body` is the script's shell body — it decides the exit code and stdout.
	 */
	ghStub(body: string) {
		const stub = path.join(this.dir, "gh-stub");
		fs.writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
		this.extraEnv.WFC_ARBITER_GH = stub;
		return this;
	}

	/** Where issueStub keeps the one issue body it serves. */
	private issueStore?: string;

	/**
	 * A fake `gh` backing ONE issue body with a file, so the safe-edit path
	 * (mantahostels#131) can be raced without live GitHub. It serves exactly the two calls
	 * that script makes — `issue view --json body` and `issue edit --body-file`
	 * — and writes via temp-then-rename, because the race under test lives
	 * between one process's fetch and its write, not inside a single gh call: a
	 * torn read would fake a lost update the code never caused.
	 *
	 * `viewDelayMs` widens that fetch-to-write window on purpose. Measured on
	 * this machine, eight real processes against an instant stub never collide
	 * at all — node's own startup dominates, so every writer reported a single
	 * write and the test would have passed with the repair loop deleted.
	 *
	 * `intrude` is the Tier 1 alternative to widening it: instead of racing two
	 * writers and hoping they collide, the stub itself performs the rival's
	 * write, at a chosen point in the one real writer's call sequence. That
	 * sequence is fixed — view, edit, view — so `afterCall` selects the
	 * ordering under test exactly (mantahostels#142). The rival
	 * write is raw and whole-body, which is what a writer that fetched before
	 * ours started would upload.
	 */
	issueStub(
		initialBody: string,
		viewDelayMs = 0,
		intrude?: { afterCall: number; body: string },
	) {
		this.extraEnv.WFC_ISSUE_STUB_VIEW_DELAY_MS = String(viewDelayMs);
		if (intrude) {
			this.extraEnv.WFC_ISSUE_STUB_INTRUDE = JSON.stringify(intrude);
		}
		this.issueStore = path.join(this.dir, "issue-body.md");
		fs.writeFileSync(this.issueStore, initialBody);
		const stub = path.join(this.dir, "gh-issue-stub");
		fs.writeFileSync(
			stub,
			`#!/usr/bin/env node
const fs = require("node:fs");
// The two reaches outside the sandbox: the repo's shared synchronous pause
// and its atomic writer.
const { sleepSync } = require(${JSON.stringify(path.join(REPO_ROOT, "scripts", "lib", "sleep-sync.js"))});
const { writeFileAtomic } = require(${JSON.stringify(path.join(REPO_ROOT, "scripts", "lib", "atomic-write.js"))});
const store = process.env.WFC_ISSUE_STUB_STORE;
const a = process.argv.slice(2);

const put = (text) => writeFileAtomic(store, text);

/*
 * Counted only when an intrusion is configured. The 8-writer race runs this
 * stub from many processes at once, where a read-modify-write counter would
 * race.
 */
const cfg = process.env.WFC_ISSUE_STUB_INTRUDE;
let call = 0;
if (cfg) {
	const counter = store + ".calls";
	try { call = Number(fs.readFileSync(counter, "utf8")) || 0; } catch {}
	call += 1;
	fs.writeFileSync(counter, String(call));
}
/* After this call's own effect, so the writer sees the pre-intrusion state. */
const intrude = () => {
	if (cfg && call === JSON.parse(cfg).afterCall) put(JSON.parse(cfg).body);
};

if (a[0] === "issue" && a[1] === "view") {
	const seen = fs.readFileSync(store, "utf8");
	const delay = Number(process.env.WFC_ISSUE_STUB_VIEW_DELAY_MS) || 0;
	if (delay) sleepSync(delay);
	intrude();
	process.stdout.write(JSON.stringify({ body: seen }));
	process.exit(0);
}
if (a[0] === "issue" && a[1] === "edit") {
	const i = a.indexOf("--body-file");
	put(fs.readFileSync(a[i + 1], "utf8"));
	intrude();
	process.exit(0);
}
process.stderr.write("gh stub: unsupported call: " + a.join(" ") + "\\n");
process.exit(1);
`,
			{ mode: 0o755 },
		);
		this.extraEnv.WFC_GH = stub;
		this.extraEnv.WFC_ISSUE_STUB_STORE = this.issueStore;
		return this;
	}

	/** The issue body as the stub currently holds it. */
	issueBodyText() {
		if (!this.issueStore) throw new Error("no issueStub in this arena");
		return fs.readFileSync(this.issueStore, "utf8");
	}

	/**
	 * A raw upload, with nothing in the loop — what `gh issue edit --body-file`
	 * does. The before-halves need it: they model the unguarded write, so they
	 * must not go through the script whose absence they are demonstrating.
	 */
	writeIssueBody(body: string) {
		if (!this.issueStore) throw new Error("no issueStub in this arena");
		fs.writeFileSync(this.issueStore, body);
	}

	/**
	 * The debt store as it sits on disk. The slug is recomputed here rather than
	 * imported, for the same reason proving-session.ts's procStartOf is: a
	 * harness that borrowed the path logic it checks would agree with it even
	 * where both are wrong.
	 *
	 * This is why scripts/lib/project-slug-scan.test.ts's regression fence exempts
	 * this file by name (mantahostels#2052), the same deliberate restatement it exempts
	 * project-slug.js for.
	 */
	debts() {
		const root = this.git("rev-parse", "--show-toplevel").trim();
		const dir = path.join(
			this.home,
			".claude",
			"projects",
			root.replace(/[^a-zA-Z0-9]/g, "-"),
			"debts",
		);
		let files: string[] = [];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			return [];
		}
		return files.map(
			(f) =>
				JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
					path: string;
					issue: number | null;
					gist: string | null;
					createdAt: string;
				},
		);
	}

	readonly sessions: Session[] = [];

	session(id: string) {
		const s = new Session(this, id);
		this.sessions.push(s);
		return s;
	}

	/**
	 * The rule every session follows today, in the absence of any guard: treat a
	 * file that is already dirty as belonging to someone else. This is mantahostels#99's
	 * signal 2, and it fails in both directions — dirty-but-finished reads as
	 * taken, which deadlocks two sessions; clean-but-held reads as free, which
	 * is mantahostels#66.
	 */
	freeByConvention(file: string) {
		return this.git("status", "--porcelain", "--", file).trim() === "";
	}

	destroy() {
		for (const s of this.sessions) s.killed();
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}
