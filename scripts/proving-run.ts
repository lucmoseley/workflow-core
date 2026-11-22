import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type RouteAnswer, stubGhHandler, stubGhRoutes } from "./lib/gh-stub";
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
		// lucmoseley/mantahostels#100
		this.git("config", "core.hooksPath", path.join(this.dir, "no-hooks"));
		this.git("config", "branch.main.merge", "refs/heads/landing");
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

	readonly extraEnv: Record<string, string> = {};

	ghStub(routes: Record<string, RouteAnswer>, { log }: { log?: string } = {}) {
		this.extraEnv.WFC_GH = stubGhRoutes(this.dir, routes, { log }).gh;
		return this;
	}

	private issueStore?: string;

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
		this.extraEnv.WFC_GH = stubGhHandler(
			path.join(this.dir, "gh-issue-stub"),
			`const fs = require("node:fs");
// The two reaches outside the sandbox: the repo's shared synchronous pause
// and its atomic writer.
const { sleepSync } = require(${JSON.stringify(path.join(REPO_ROOT, "scripts", "lib", "sleep-sync.js"))});
const { writeFileAtomic } = require(${JSON.stringify(path.join(REPO_ROOT, "scripts", "lib", "atomic-write.js"))});
const store = env.WFC_ISSUE_STUB_STORE;

const put = (text) => writeFileAtomic(store, text);

/*
 * Counted only when an intrusion is configured. The 8-writer race runs this
 * stub from many processes at once, where a read-modify-write counter would
 * race.
 */
const cfg = env.WFC_ISSUE_STUB_INTRUDE;
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

if (argv[0] === "issue" && argv[1] === "view") {
	const seen = fs.readFileSync(store, "utf8");
	const delay = Number(env.WFC_ISSUE_STUB_VIEW_DELAY_MS) || 0;
	if (delay) sleepSync(delay);
	intrude();
	out(JSON.stringify({ body: seen }));
	exit(0);
}
if (argv[0] === "issue" && argv[1] === "edit") {
	put(fs.readFileSync(argv[argv.indexOf("--body-file") + 1], "utf8"));
	intrude();
	exit(0);
}
err("gh stub: unsupported call: " + argv.join(" ") + "\\n");
exit(1);
`,
		).gh;
		this.extraEnv.WFC_ISSUE_STUB_STORE = this.issueStore;
		return this;
	}

	readIssueBodyText() {
		if (!this.issueStore) throw new Error("no issueStub in this arena");
		return fs.readFileSync(this.issueStore, "utf8");
	}

	writeIssueBody(body: string) {
		if (!this.issueStore) throw new Error("no issueStub in this arena");
		fs.writeFileSync(this.issueStore, body);
	}

	readonly sessions: Session[] = [];

	session(id: string) {
		const s = new Session(this, id);
		this.sessions.push(s);
		return s;
	}

	freeByConvention(file: string) {
		return this.git("status", "--porcelain", "--", file).trim() === "";
	}

	destroy() {
		for (const s of this.sessions) s.killed();
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}
