/*
 * arbiter-testkit.ts — the sandbox the arbiter's suites share.
 *
 * NEVER let a suite touch the real registry: a literal ~/.claude would make a
 * test run write into the founder's live locks and wedge real sessions.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { caught } from "./caught.js";
import { runInProcess } from "./run-in-process";
import { sleepSync } from "./sleep-sync.js";

// The arbiter is CommonJS and stays that way — it is spawned as a plain node
// script by a bash hook.
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const family = (name: string): any =>
	createRequire(import.meta.url)(`./arbiter-${name}.js`);

export const store = family("store");
export const proc = family("proc");

/*
 * The families arbiter-store.js does not re-export (mantahostels#1967, mantahostels#1994).
 *
 * EACH IS A NAMESPACE AND IS NEVER DESTRUCTURED — the discipline
 * arbiter-store.js states in full. A file that already has a local of one of
 * these names imports it `as <name>Mod`.
 *
 * A family exports more than the facade did, accepted at mantahostels#1959: reaching past
 * the operation you came for is a review finding.
 */
export const bases = family("bases");
export const breaks = family("breaks");
export const content = family("content");
export const core = family("core");
export const debts = family("debts");
export const issueClaims = family("issue-claims");
export const ledger = family("ledger");
export const locks = family("locks");
export const markers = family("markers");
export const snapshots = family("snapshots");

/** The debt record on `rel` owned by `issue`, or with no issue the unowned stub; null where none. */
export const readDebtOf = (rel: string, issue: number | null = null) =>
	debts
		.readDebts(rel)
		.find(
			(e: { record: { issue?: number | null } }) =>
				(e.record.issue ?? null) === issue,
		)?.record ?? null;

export const SCRIPT = path.join(__dirname, "..", "session-arbiter.js");

/**
 * chmod is advisory to root, which reads a 000 file or directory and writes into
 * a 555 one regardless. Every test that seals a path off skips on this, or it
 * would pass for a reason that says nothing about the store.
 */
export const AS_ROOT =
	typeof process.getuid === "function" && process.getuid() === 0;

export interface Sandbox {
	/** The throwaway root; everything below lives inside it. */
	dir: string;
	/** The fake CLAUDE_CONFIG_DIR. */
	home: string;
	/** The fake repo, and CLAUDE_PROJECT_DIR. */
	repo: string;

	/*
	 * Methods, not fields (mantahostels#205). Both derive from the environment this sandbox
	 * re-points in its beforeEach, so a suite that captured them as fields would
	 * capture whatever the PREVIOUS test left behind — or, on the first test, the
	 * developer's real ~/.claude.
	 */

	/** Where the arbiter keeps locks/, debts/, writes/ and the fail-open log. */
	stateDir: () => string;
	/** The fail-open log itself. */
	errorLog: () => string;
}

function dropSiblingConfigs(env: NodeJS.ProcessEnv) {
	delete env.WFC_CLAUDE_CONFIG_A;
	delete env.WFC_CLAUDE_CONFIG_B;
	delete env.WFC_CLAUDE_CONFIG_C;
}

/**
 * Point every external oracle the arbiter shells out to at a stub inside the
 * sandbox.
 *
 * WITHOUT THIS THE SUITE READS THE MACHINE (mantahostels#1902). A real Claude Code session
 * exports `WFC_CLAUDE_BIN` — here `claude-agents-union`, which unions the
 * founder's three live session registries — so a case reaching the liveness
 * oracle without a shim of its own asks which sessions are running RIGHT NOW,
 * and answers differently minute to minute. `WFC_ARBITER_GH` is unset there,
 * falling the debt lifecycle back on the real `gh`. NEITHER BINARY IS REACHABLE
 * IN CI, so a green CI run says nothing about this.
 *
 * THE AGENTS STUB LISTS THE CALLER AND NOBODY ELSE, which is what the real
 * oracle said. An empty array is NOT that: `agent-liveness.js` reads `[]` as a
 * refusal ("listed no agents at all"), and its self-test refuses again unless
 * the list names `CLAUDE_CODE_SESSION_ID` — so a stub echoing `[]` would send
 * every unshimmed case down the refusal branch the real oracle never took.
 *
 * The `gh` stub refuses loudly: a case that needs one says so with `fakeGh`
 * rather than reaching the network.
 *
 * RESIDUAL: a real session also exports `CLAUDE_PID`, `CLAUDECODE` and
 * `CLAUDE_CODE_MESSAGING_SOCKET`, and the sandbox leaves `HOME` alone
 * deliberately. None is read by the arbiter today.
 */
function stubOracles(sb: Sandbox) {
	const dir = path.join(sb.dir, "stubs");
	fs.mkdirSync(dir, { recursive: true });

	const write = (name: string, body: string) => {
		const bin = path.join(dir, name);
		fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`);
		fs.chmodSync(bin, 0o755);
		return bin;
	};

	// A sandbox id of its own, so the oracle's self-test is not answered with
	// the founder's live session id (agent-liveness.js's `me`).
	process.env.CLAUDE_CODE_SESSION_ID = "sandbox";

	// sessionDirs() (arbiter-core.js) PREFERS these three over its
	// configDir-derived defaults, so one exported in a session's environment
	// would reopen the route this whole helper closes. Latent today: nothing
	// exports them. Cleared anyway, since the failure would be silent.
	dropSiblingConfigs(process.env);

	process.env.WFC_CLAUDE_BIN = write(
		"claude",
		// `${...}` spelt out longhand: Biome reads the shell form as a stray
		// template placeholder (lint/suspicious/noTemplateCurlyInString).
		'sid=$CLAUDE_CODE_SESSION_ID\n[ -n "$sid" ] || sid=sandbox\n' +
			'printf \'[{"sessionId":"%s"}]\\n\' "$sid"',
	);
	process.env.WFC_ARBITER_GH = write(
		"gh",
		'echo "arbiter sandbox: unstubbed gh call: $*" >&2\nexit 1',
	);
	// No trailing delimiter on an unset PATH: an empty field is the cwd.
	process.env.PATH = process.env.PATH
		? `${dir}${path.delimiter}${process.env.PATH}`
		: dir;
}

/**
 * Attempts `removeSandbox` makes before it gives up and rethrows.
 *
 * 100 x 50 ms is a 5-second ceiling, and it is a bound rather than a
 * measurement — nobody has timed how long a detached child keeps writing. It is
 * sized off the load a CI runner puts on the children in question (mantahostels#2255, mantahostels#2956).
 */
export const SANDBOX_RM_ATTEMPTS = 100;
export const SANDBOX_RM_DELAY_MS = 50;

/**
 * Remove a sandbox directory, tolerating a detached child still writing into it.
 *
 * A suite that spawns a child detached returns from its assertions before that
 * child is done, so the teardown can walk the tree while the child is still
 * creating files in it — `rmSync` then throws ENOTEMPTY and reds a suite whose
 * assertions all passed (mantahostels#2956).
 *
 * ONLY ENOTEMPTY is retried. Any other code is the caller's bug and is rethrown
 * at once, and a directory that never empties still throws rather than being
 * left behind silently.
 *
 * `rmSync`'s own `maxRetries` is the obvious reach and is deliberately not used:
 * it retries inside the native call, so the retry branch is unreachable from a
 * test and the guarantee could only be reported unverified (mantahostels#2956). It also
 * widens the retried set to EBUSY/EMFILE/ENFILE/EPERM, none of which this
 * failure produces.
 *
 * `remove` and `sleep` are injected so the retry branch is reachable in-process
 * without a real racing writer.
 */
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

/**
 * Register beforeEach/afterEach for a fresh sandbox, and hand back a handle
 * re-pointed before every test. Read it inside the test body, never at module
 * scope.
 *
 * `setUp` runs INSIDE this beforeEach, once the environment is re-pointed, and
 * is the only safe place for a suite to prepare something whose path derives
 * from the sandbox. A suite doing that from a beforeEach of its own is correct
 * only while its hook happens to be registered after this one, which is an
 * ordering nothing states and nothing checks; get it wrong and the work lands in
 * the wrong directory with nothing failing (mantahostels#205).
 */
/**
 * session-arbiter.js run in `sb.repo`: `cli` returns the whole result,
 * `readListing` only stdout, throwing on a non-zero exit.
 */
export const arbiterCli = (sb: Sandbox) => ({
	cli: (args: string[], env: Record<string, string> = {}) =>
		runInProcess(SCRIPT, args, {
			cwd: sb.repo,
			env: { ...process.env, ...env },
		}),
	readListing: (args: string[]) => {
		const r = runInProcess(SCRIPT, args, { cwd: sb.repo });
		if (r.status !== 0)
			throw new Error(
				`session-arbiter.js ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`,
			);
		return r.stdout;
	},
});

export function freshSandbox(setUp?: (sb: Sandbox) => void): Sandbox {
	const sb: Sandbox = {
		dir: "",
		home: "",
		repo: "",
		stateDir: () => store.stateDir(),
		errorLog: () => store.errorLog(),
	};
	const savedEnv = { ...process.env };

	beforeEach(() => {
		sb.dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-"));
		sb.home = path.join(sb.dir, "home", ".claude");
		sb.repo = path.join(sb.dir, "repo");
		fs.mkdirSync(path.join(sb.home, "sessions"), { recursive: true });
		fs.mkdirSync(path.join(sb.home, "jobs"), { recursive: true });
		fs.mkdirSync(path.join(sb.repo, "docs"), { recursive: true });
		process.env.CLAUDE_CONFIG_DIR = sb.home;
		process.env.CLAUDE_PROJECT_DIR = sb.repo;
		// A background job inherits both pointed at the real checkout, and either
		// outranks CLAUDE_PROJECT_DIR in dispatch-ledger.js ledgerRoot() and every
		// `WFC_REPO_ROOT || hostRoot()` reader (#3119).
		process.env.WFC_REPO_ROOT = sb.repo;
		process.env.WFC_DISPATCH_ROOT = sb.repo;
		stubOracles(sb);
		setUp?.(sb);
	});

	afterEach(() => {
		removeSandbox(sb.dir);
		process.env = { ...savedEnv };
	});

	return sb;
}

/**
 * A sessions/<pid>.json entry, the registry mantahostels#104 ruled the single source.
 *
 * `procStart: null` is a real entry shape, not a missing argument — a Claude
 * Code that stopped writing the field.
 *
 * `name` is the session's own title, which the real registry carries and which
 * sweepRisk reads to name a neighbour without a `claude agents --json` call. It
 * is optional because an entry genuinely arrives without one.
 */
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

/** A registered session running on this test's own live pid. */
export function live(sb: Sandbox, sessionId: string, name?: string) {
	registerSession(sb, sessionId, process.pid, { name });
	return store.identify(sessionId);
}

/** Registered, but on a pid whose start time does not match: finished. */
export function finished(sb: Sandbox, sessionId: string) {
	registerSession(sb, sessionId, process.pid, { procStart: "999999999" });
}

/**
 * A `gh` stand-in wired through WFC_ARBITER_GH, and a count of its
 * invocations — the debt lifecycle's only network call.
 */
export function fakeGh(sb: Sandbox, body: string) {
	const bin = path.join(sb.dir, "gh-fake");
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho "$*" >> "${path.join(sb.dir, "gh-calls")}"\n${body}\n`,
	);
	fs.chmodSync(bin, 0o755);
	process.env.WFC_ARBITER_GH = bin;
}

/**
 * A `gh` stand-in for the batched sweep: `gh issue list --state closed --json
 * number` answers with exactly `closed`, and nothing else is answered at all.
 */
export const ghClosedList = (sb: Sandbox, closed: number[]) =>
	fakeGh(sb, `echo '${JSON.stringify(closed.map((number) => ({ number })))}'`);

export const ghAnswers = (sb: Sandbox, state: string) =>
	fakeGh(sb, `echo '{"state":"${state}"}'`);

/**
 * The argv of every gh call, in order. Assert on the argv, never on the count:
 * a sweep's whole correctness is in its query (mantahostels#1203).
 */
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

/**
 * Make the sandbox repo a real git repository.
 *
 * Without one the arbiter answers nothing off `git status`, the
 * DIRTY-AND-UNCLAIMED notice included (mantahostels#2387).
 *
 * NOT git-fixture.ts's `initGitRepo`, and not part of `freshSandbox`. That
 * seam takes a `core.hooksPath` and commits a seed `a.md`, putting a file the
 * suite never asked for into every tree that then reads `git status`; and
 * `git init` costs every suite that asks git nothing, which is most of them.
 *
 * A repo-local identity is written straight into `.git/config`, costing no
 * spawn, so a caller's plain `git commit` works on a runner with no global one.
 */
export function gitRepo(sb: Sandbox) {
	execFileSync("git", ["init", "-q"], { cwd: sb.repo });
	fs.appendFileSync(
		path.join(sb.repo, ".git", "config"),
		"[user]\n\temail = t@t\n\tname = t\n",
	);
}

/**
 * Commit whatever the sandbox tree holds, so a release's cleanliness check has a
 * HEAD to compare against.
 *
 * Identity on the command line rather than in a config: a machine with no
 * `user.email` set would otherwise fail every suite that commits.
 */
export function commitAll(sb: Sandbox, message = "seed") {
	execFileSync("git", ["add", "-A"], { cwd: sb.repo });
	execFileSync(
		"git",
		["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message],
		{ cwd: sb.repo },
	);
}

/**
 * The agents oracle pruneIssueClaims spares on, listing nobody — what a test
 * about some other family passes so pruneAll's issue-claim sweep is exercised
 * rather than refused (mantahostels#1796).
 */
export const noSessions = () => ({ ids: new Set<string>() });

/** A lock recording a process that is certainly gone. */
export const DEAD = { pid: 999_999, procStart: "1" };

export const liveHolder = () => ({
	pid: process.pid,
	procStart: proc.readProcStartOf(process.pid),
});

/** A claim on `rel` written straight into the sandbox's lock store. */
export function putLock(rel: string, fields: object) {
	fs.mkdirSync(store.paths.locksDir(), { recursive: true });
	fs.writeFileSync(
		store.paths.lock(rel),
		JSON.stringify(locks.newLock({ path: rel, ...fields })),
	);
}

/** A caller identity for a session the registry can prove is running. */
export const durably = (sessionId: string) => ({
	sessionId,
	...liveHolder(),
	durable: true,
});

/**
 * Which of `names` the session-start sweep deletes, each written as a day-old
 * file in the markers directory, with `running` the one session registered as
 * live. `prune-markers` runs as a child in a throwaway sandbox of its own, so a
 * suite with no arbiter sandbox can ask whether a marker family it writes is
 * swept.
 */
export function sweptMarkers(names: string[], running = "running"): string[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swept-markers-"));
	try {
		const home = path.join(dir, "home");
		const repo = path.join(dir, "repo");
		fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
		registerSession({ home, repo }, running, process.pid);
		const markerDir = path.join(repo, ".claude", "tmp", "markers");
		fs.mkdirSync(markerDir, { recursive: true });
		// Past arbiter-markers.js's MARKER_AGE_MS, a day, by an hour.
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
		dropSiblingConfigs(env);
		execFileSync(process.execPath, [SCRIPT, "prune-markers"], {
			env,
			stdio: "ignore",
		});
		return names.filter((name) => !fs.existsSync(path.join(markerDir, name)));
	} finally {
		removeSandbox(dir);
	}
}
