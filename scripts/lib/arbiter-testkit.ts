import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, beforeEach, vi } from "vitest";
import { buildAgentsBranch, buildListedRow } from "./agents-stop-fake";
import { caught } from "./caught.js";
import { writeClaudeStub } from "./claude-stub";
import { type RouteAnswer, stubGhRoutes, stubGhScript } from "./gh-stub";
import { runInProcess } from "./run-in-process";
import { sleepSync } from "./sleep-sync.js";

const requireLocal = createRequire(import.meta.url);

export const store: typeof import("./arbiter-store.js") =
	requireLocal("./arbiter-store.js");
export const proc: typeof import("./arbiter-proc.js") =
	requireLocal("./arbiter-proc.js");

export const breaks: typeof import("./arbiter-breaks.js") = requireLocal(
	"./arbiter-breaks.js",
);
export const content: typeof import("./arbiter-content.js") = requireLocal(
	"./arbiter-content.js",
);
export const core: typeof import("./arbiter-core.js") =
	requireLocal("./arbiter-core.js");
export const issueClaims: typeof import("./arbiter-issue-claims.js") =
	requireLocal("./arbiter-issue-claims.js");
export const ledger: typeof import("./arbiter-ledger.js") = requireLocal(
	"./arbiter-ledger.js",
);
export const lockFiles: typeof import("./arbiter-lock-files.js") = requireLocal(
	"./arbiter-lock-files.js",
);
export const locks: typeof import("./arbiter-locks.js") =
	requireLocal("./arbiter-locks.js");
export const markers: typeof import("./arbiter-markers.js") = requireLocal(
	"./arbiter-markers.js",
);
export const snapshots: typeof import("./arbiter-snapshots.js") = requireLocal(
	"./arbiter-snapshots.js",
);

export const SCRIPT = path.join(__dirname, "..", "session-arbiter.js");

export const AS_ROOT =
	typeof process.getuid === "function" && process.getuid() === 0;

export interface Sandbox {
	dir: string;
	home: string;
	repo: string;

	stateDir: () => string;
	errorLog: () => string;
}

const SIBLING_CONFIGS = [
	"WFC_CLAUDE_CONFIG_A",
	"WFC_CLAUDE_CONFIG_B",
	"WFC_CLAUDE_CONFIG_C",
];

const BELT = path.join(__dirname, "arbiter-belt");

function stubOracles(sb: Sandbox) {
	const dir = path.join(sb.dir, "stubs");
	fs.mkdirSync(dir, { recursive: true });

	vi.stubEnv("CLAUDE_CODE_SESSION_ID", "sandbox");

	for (const name of SIBLING_CONFIGS) vi.stubEnv(name, undefined);

	vi.stubEnv(
		"WFC_CLAUDE_BIN",
		writeClaudeStub(path.join(dir, "claude"), [
			buildAgentsBranch([
				buildListedRow({ sessionId: "sandbox" }, ["pid", "status"]),
			]),
		]),
	);
	vi.stubEnv(
		"WFC_GH",
		stubGhScript(
			dir,
			'#!/bin/sh\necho "arbiter sandbox: unstubbed gh call: $*" >&2\nexit 1\n',
		).gh,
	);

	vi.stubEnv("PATH", `${BELT}${path.delimiter}${process.env.PATH}`);
}

// guess, lucmoseley/mantahostels#2255
export const SANDBOX_RM_ATTEMPTS = 100;
export const SANDBOX_RM_DELAY_MS = 50;

export function removeSandbox(
	dir: string,
	{
		remove = (target) => fs.rmSync(target, { recursive: true, force: true }),
		sleep = sleepSync,
		attempts = SANDBOX_RM_ATTEMPTS,
		delayMs = SANDBOX_RM_DELAY_MS,
	}: {
		remove?: (target: string) => void;
		sleep?: (ms: number) => void;
		attempts?: number;
		delayMs?: number;
	} = {},
): void {
	for (let attempt = 1; ; attempt++) {
		try {
			remove(dir);
			return;
		} catch (err) {
			const code = caught(err).code;
			if (code !== "ENOTEMPTY" || attempt >= attempts) throw err;
			sleep(delayMs);
		}
	}
}

export const arbiterCli = (sb: Sandbox) => ({
	cli: (args: string[], env: Record<string, string> = {}) =>
		runInProcess(SCRIPT, args, {
			cwd: sb.repo,
			env: { ...process.env, ...env },
		}),
	readListing: (args: string[]) => arbiterOk(args, { cwd: sb.repo }),
});

const arbiterOk = (
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => {
	const r = runInProcess(SCRIPT, args, options);
	if (r.status !== 0)
		throw new Error(
			`session-arbiter.js ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`,
		);
	return r.stdout;
};

export const ledgerHead = (tree: string, env: NodeJS.ProcessEnv) => {
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: tree,
		env,
		encoding: "utf8",
	}).trim();
	arbiterOk(["record-commit", head], { env });
};

export const endedPid = () =>
	execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim();

export function freshSandbox(setUp?: (sb: Sandbox) => void): Sandbox {
	const sb: Sandbox = {
		dir: "",
		home: "",
		repo: "",
		stateDir: () => store.stateDir(),
		errorLog: () => store.errorLog(),
	};
	beforeEach(() => {
		sb.dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-"));
		sb.home = path.join(sb.dir, "home", ".claude");
		sb.repo = path.join(sb.dir, "repo");
		fs.mkdirSync(path.join(sb.home, "sessions"), { recursive: true });
		fs.mkdirSync(path.join(sb.home, "jobs"), { recursive: true });
		fs.mkdirSync(path.join(sb.repo, "docs"), { recursive: true });
		vi.stubEnv("CLAUDE_CONFIG_DIR", sb.home);
		vi.stubEnv("CLAUDE_PROJECT_DIR", sb.repo);
		vi.stubEnv("WFC_REPO_ROOT", sb.repo);
		vi.stubEnv("WFC_DISPATCH_ROOT", sb.repo);
		stubOracles(sb);
		setUp?.(sb);
	});

	afterEach(() => removeSandbox(sb.dir));

	return sb;
}

export function registerSession(
	sb: Pick<Sandbox, "home" | "repo">,
	sessionId: string,
	pid: number,
	{ procStart, name }: { procStart?: string | null; name?: string } = {},
) {
	fs.writeFileSync(
		path.join(sb.home, "sessions", `${pid}.json`),
		JSON.stringify({
			pid,
			sessionId,
			procStart:
				procStart === undefined ? proc.readProcStartOf(pid) : procStart,
			status: "idle",
			cwd: sb.repo,
			...(name === undefined ? {} : { name }),
		}),
	);
}

export function storeAt(root: string) {
	vi.stubEnv("CLAUDE_PROJECT_DIR", root);
	vi.stubEnv("WFC_REPO_ROOT", root);
}

export function live(sb: Sandbox, sessionId: string, name?: string) {
	registerSession(sb, sessionId, process.pid, { name });
	return store.identify(sessionId);
}

export function finished(sb: Sandbox, sessionId: string) {
	registerSession(sb, sessionId, process.pid, { procStart: "999999999" });
}

export function fakeGh(sb: Sandbox, routes: Record<string, RouteAnswer>) {
	const { gh } = stubGhRoutes(sb.dir, routes, {
		log: path.join(sb.dir, "gh-calls"),
	});
	vi.stubEnv("WFC_GH", gh);
	return gh;
}

export function ghCalls(sb: Sandbox): string[] {
	try {
		return fs
			.readFileSync(path.join(sb.dir, "gh-calls"), "utf8")
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}

export const ghCallCount = (sb: Sandbox) => ghCalls(sb).length;

export function gitRepo(sb: Sandbox) {
	execFileSync("git", ["init", "-q"], { cwd: sb.repo });
	fs.appendFileSync(
		path.join(sb.repo, ".git", "config"),
		"[user]\n\temail = t@t\n\tname = t\n",
	);
}

export function commitAll(sb: Sandbox, message = "seed") {
	execFileSync("git", ["add", "-A"], { cwd: sb.repo });
	execFileSync(
		"git",
		["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message],
		{ cwd: sb.repo },
	);
}

export const noSessions = () => ({ ids: new Set<string>() });

export const DEAD = { pid: 999_999, procStart: "1" };

export const liveHolder = () => ({
	pid: process.pid,
	procStart: proc.readProcStartOf(process.pid),
});

export function listedLocks() {
	const listed = store.listLocks();
	assert(listed);
	return listed.map((l) => {
		assert(!l.unreadable);
		return l;
	});
}

export function listedClaims() {
	const listed = issueClaims.listIssueClaims();
	assert(listed);
	return listed.claims;
}

export function putLock(rel: string, fields: object) {
	fs.mkdirSync(store.paths.locksDir(), { recursive: true });
	fs.writeFileSync(
		store.paths.lock(rel),
		JSON.stringify(locks.newLock({ path: rel, ...fields })),
	);
}

export const durably = (sessionId: string) => ({
	sessionId,
	...liveHolder(),
	durable: true,
});

export function sweptMarkers(names: string[], running = "running"): string[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swept-markers-"));
	try {
		const home = path.join(dir, "home");
		const repo = path.join(dir, "repo");
		fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
		registerSession({ home, repo }, running, process.pid);
		const markerDir = path.join(repo, ".claude", "tmp", "markers");
		fs.mkdirSync(markerDir, { recursive: true });
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
		for (const name of names) {
			const file = path.join(markerDir, name);
			fs.writeFileSync(file, "");
			fs.utimesSync(file, old, old);
		}
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_CONFIG_DIR: home,
			CLAUDE_PROJECT_DIR: repo,
			CLAUDE_CODE_SESSION_ID: "sandbox",
			WFC_CLAUDE_BIN: "/bin/false",
		};
		for (const name of SIBLING_CONFIGS) delete env[name];
		execFileSync(process.execPath, [SCRIPT, "prune-markers"], {
			env,
			stdio: "ignore",
		});
		return names.filter((name) => !fs.existsSync(path.join(markerDir, name)));
	} finally {
		removeSandbox(dir);
	}
}
