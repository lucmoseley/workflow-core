/*
 * The fixtures and runners the check-guard-registry test files share
 * (`scripts/check-guard-registry*.test.ts`, #4294).
 *
 * The script is copied into a `scripts/` inside each fixture, because the
 * checker reads its own siblings; but the TREE it scans is the host root, not
 * `..` from its own location, so every runner names the fixture with
 * `CLAUDE_PROJECT_DIR` as well — unless it runs from a linked worktree of
 * another tree, which the check then scans instead (#3386). Without that the
 * checker walks this repo and every case reads the live registry's findings.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";
import { readProgramLibs } from "../lib-closure-fixture";
import { runInProcess } from "./run-in-process";
import { shellQuote } from "./sh-quote.js";

export const REAL_SCRIPT = path.join(
	__dirname,
	"..",
	"check-guard-registry.js",
);
export const SELF_PLUGIN_HOOKS = "self-plugin/hooks/hooks.json";

/* chmod is a no-op for root, which can read the directory anyway. */
export const asRoot =
	typeof process.getuid === "function" && process.getuid() === 0;

/** Directories a case made; each file's afterEach hands them to removeTemps. */
export const temps: string[] = [];

export function removeTemps(): void {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
}

export interface Fixture {
	claude?: string;
	/** Extra files to create, path → contents. */
	files?: Record<string, string>;
}

/* The libs the checker and the landing gate run on, not all of scripts/lib:
 * the check reads, hashes and regex-scans every lib a fixture carries, on
 * every run (#3257). rule-text.sh is read by path, never required. Copied
 * from build()'s own listing of scripts/lib, which keeps every lib change
 * selecting each file that loads this kit: the read-edge selector credits a
 * test with its helper's reads one hop deep, never installLib's two hops off
 * (#4294). Residual: no fixture runs the checker over a real lib outside the
 * closure; the live-repository case does. */
const FIXTURE_LIBS = new Set([
	...readProgramLibs("check-guard-registry.js"),
	...readProgramLibs("landing-registry-gate.js"),
	"rule-text.sh",
]);

export const ANCHORS = ".claude/guard-registry-anchors.json";

export function readAnchors(root: string): Record<string, string> {
	return JSON.parse(fs.readFileSync(path.join(root, ANCHORS), "utf8"));
}

export function build(fx: Fixture): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-"));
	temps.push(root);
	const libs = path.join(root, "scripts", "lib");
	fs.mkdirSync(libs, { recursive: true });
	for (const lib of fs.readdirSync(__dirname))
		if (FIXTURE_LIBS.has(lib))
			fs.copyFileSync(path.join(__dirname, lib), path.join(libs, lib));
	fs.copyFileSync(
		REAL_SCRIPT,
		path.join(root, "scripts", "check-guard-registry.js"),
	);
	if (fx.claude !== undefined)
		fs.writeFileSync(path.join(root, "CLAUDE.md"), fx.claude);
	/* A core tree registers its hooks in the self-plugin's file (#2442), which
	 * the real core always carries. */
	const files = { [SELF_PLUGIN_HOOKS]: '{"hooks": {}}', ...fx.files };
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	return root;
}

export interface Result {
	code: number;
	kinds: string[];
	/**
	 * The human-readable report — the prose a session actually reads, which
	 * --json otherwise sends nowhere (mantahostels#1962).
	 *
	 * WFC_CHECK_SAY_FD is lib/check.js's own channel for exactly this: it
	 * makes say() write to the given fd even under --json, so one run yields
	 * the envelope on stdout and the report on stderr.
	 */
	report: string;
	json: {
		regionCount: number;
		ruleCount: number;
		byMarker: Record<string, number>;
		findings: {
			kind: string;
			file: string;
			detail: string;
			line: number;
			message: string;
		}[];
		warnings: {
			kind: string;
			guard: string;
			detail: string;
			rules: { file: string; line: number; gist: string }[];
			spans?: { span: string; coverage: number }[];
		}[];
	};
}

/**
 * The environment a `--review` run gets. A runner's `env` REPLACES the
 * environment, so the caller's is merged back in — minus WFC_RULES_DIR, which
 * run() strips for the reason its docstring gives.
 */
export function reviewEnv(root: string, env: Record<string, string> = {}) {
	const { WFC_RULES_DIR: _drop, ...outer } = process.env;
	return { ...outer, CLAUDE_PROJECT_DIR: root, ...env };
}

/**
 * `--review` prints prose, not JSON, so it needs its own runner. It exits on
 * its own path rather than through runCheck, so a non-zero status is raised
 * here.
 */
export function reviewIn(
	root: string,
	paths: string[] = [],
	env: Record<string, string> = {},
): string {
	const r = runInProcess(
		path.join(root, "scripts", "check-guard-registry.js"),
		["--review", ...paths],
		{ env: reviewEnv(root, env), cwd: root },
	);
	if (r.status !== 0)
		throw new Error(`--review exited ${r.status}\n${r.stdout}${r.stderr}`);
	return r.stdout;
}

export const NEIGHBOUR = "neighbour-session";

/*
 * A lock record as `listLocks` hands one over. Injected at the STORE, not at
 * the checker's own answer, so neighbourDirty's own filtering — is it mine,
 * is it dirty, has a dead claim aged out — runs against it.
 */
export function lock(rel: string, { alive = true } = {}) {
	return {
		path: rel,
		sessionId: NEIGHBOUR,
		pid: 4242,
		alive,
		claimedAt: new Date().toISOString(),
	};
}

/*
 * The claims a session's own Edit calls take: a live lock held by `session` on
 * each path dirty in `root`, bar those `except` names.
 */
export function ownLocks(root: string, session: string, except: string[] = []) {
	const args = ["status", "--porcelain=v1", "-uall", "--no-renames", "-z"];
	return execFileSync("git", args, { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter((e) => e.length > 3)
		.map((e) => e.slice(3))
		.filter((rel) => !except.includes(rel))
		.map((rel) => ({ ...lock(rel), sessionId: session }));
}

/** The --review env of a session whose own claims cover every dirty path. */
export function ownClaims(root: string, session = "self-session") {
	return {
		CLAUDE_CODE_SESSION_ID: session,
		WFC_ANCHOR_LOCKS: JSON.stringify(ownLocks(root, session)),
	};
}

export function run(
	root: string,
	extra: string[] = [],
	{ cwd, env = {} }: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Result {
	/*
	 * WFC_RULES_DIR is stripped so a stray value in this process's
	 * environment cannot redirect the fixture's store out from under it.
	 *
	 * WFC_CHECK_SAY_FD puts the human report on fd 2 while stdout stays a
	 * single parseable document, so a case can assert on either without a
	 * second run of the fixture (mantahostels#1962).
	 *
	 * cwd defaults to the fixture, as a hook's does: the git calls that take
	 * no -C read it (mantahostels#2077), and worktreeRoot() forks git twice
	 * more from a cwd outside the fixture (#4294). A case naming another cwd
	 * passes it.
	 */
	const {
		status: code,
		stdout,
		stderr,
	} = runInProcess(
		path.join(root, "scripts", "check-guard-registry.js"),
		["--json", ...extra],
		{
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: root,
				WFC_RULES_DIR: "",
				WFC_RULES_FALLBACK_DIR: "",
				WFC_CHECK_SAY_FD: "2",
				...env,
			},
			cwd: cwd ?? root,
		},
	);
	const json = JSON.parse(stdout);
	/* `kinds` means the gating claims. The advisory staleness warnings ride in
	 * the same `findings` array as WARNs, and are asserted separately via
	 * `json.warnings`. */
	return {
		code,
		kinds: json.findings
			.filter((f: { severity: string }) => f.severity === "FAIL")
			.map((f: { tag: string }) => f.tag),
		json,
		report: stderr,
	};
}

/** A region wrapper, so each case states only the rules it is about. */
export function region(...rules: string[]): string {
	return [
		"## Conventions",
		"",
		"<!-- guard-registry:begin -->",
		"",
		...rules,
		"",
		"<!-- guard-registry:end -->",
		"",
	].join("\n");
}

/* A hooks file that wires the named scripts as PreToolUse hooks. */
export function hooksWiring(...guards: string[]): string {
	return JSON.stringify({
		hooks: {
			PreToolUse: guards.map((g) => ({
				matcher: "Bash",
				hooks: [{ type: "command", command: `"$CLAUDE_PROJECT_DIR"/${g}` }],
			})),
		},
	});
}

export const TWO_GUARDS: Fixture = {
	claude: region(
		"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
		"- Never amend. **Enforced** (#111): `scripts/guard-amend.sh` denies it.",
	),
	files: {
		"scripts/guard-branch.sh":
			'#!/bin/sh\nsource "$(dirname "$0")/lib/deny.sh"\nexit 2\n',
		"scripts/guard-amend.sh": "#!/bin/sh\nexit 2\n",
		"scripts/lib/deny.sh": "deny() { exit 2; }\n",
		[SELF_PLUGIN_HOOKS]: hooksWiring(
			"scripts/guard-branch.sh",
			"scripts/guard-amend.sh",
		),
	},
};

export function committedRepo(
	fx: Fixture,
	prepare?: (root: string) => void,
): string {
	const root = build(fx);
	prepare?.(root);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("add", "-A");
	git("commit", "-qm", "x");
	return root;
}

/**
 * A fixture built once per describe by `make` in `beforeAll`, and a fresh
 * copy of it per call (base §X8 (1), #4294). Call it at a describe's top
 * level; the template is removed in `afterAll`.
 */
export function templateOf(make: () => string): () => string {
	let template = "";
	beforeAll(() => {
		template = make();
		/* Out of `temps`, which afterEach empties after the first case. */
		const at = temps.indexOf(template);
		if (at >= 0) temps.splice(at, 1);
	});
	afterAll(() => fs.rmSync(template, { recursive: true, force: true }));
	return () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-"));
		temps.push(root);
		fs.cpSync(template, root, { recursive: true });
		return root;
	};
}

/**
 * #2617's fixture: two guards, one sourcing a library, anchored and committed
 * with their anchors, so each case stages the change under judgement. Call
 * it at a describe's top level: it builds through templateOf().
 */
export function anchorExpiryKit() {
	const copy = templateOf(() =>
		committedRepo(TWO_GUARDS, (r) => reviewIn(r, [], claims())),
	);

	function stagingRepo() {
		const root = copy();
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		const stage = (files: Record<string, string>, also: string[] = []) => {
			for (const [rel, body] of Object.entries(files))
				fs.writeFileSync(path.join(root, rel), body);
			git("add", "--", ...Object.keys(files), ...also);
		};
		return { root, git, stage };
	}

	/* Claims are injected at the store, so the live arbiter's never reach a
	 * fixture whose paths share their names. */
	function claims(locks: unknown[] = []) {
		return {
			CLAUDE_CODE_SESSION_ID: "self-session",
			WFC_ANCHOR_LOCKS: JSON.stringify(locks),
		};
	}
	const gate = (root: string, locks: unknown[] = []) =>
		run(root, ["--against", "HEAD"], { env: claims(locks) });
	const review = (root: string, paths: string[]) =>
		reviewIn(root, paths, ownClaims(root));
	/* .husky/pre-commit's own guard-registry line, so the case runs what the
	 * hook runs. */
	const readHookLine = () => {
		const line = fs
			.readFileSync(
				path.join(__dirname, "..", "..", ".husky", "pre-commit"),
				"utf8",
			)
			.split("\n")
			.find((l) => l.includes("check-guard-registry.js --against HEAD"));
		if (!line) throw new Error("no guard-registry line in .husky/pre-commit");
		return line.trim();
	};
	const added = (r: Result) =>
		r.json.findings
			.filter((f) => (f as { tag?: string }).tag === "NEW-FAULT")
			.map((f) => f.message);
	return { stagingRepo, claims, gate, review, readHookLine, added };
}

/**
 * #3127's fixture, X: two guards anchored. C adds a library no guard sources
 * yet; D has guard-branch source it and re-anchors. Reverting C on D deletes
 * the library, so guard-branch's digest takes a value nobody read, with C
 * and D committed. Call it at a describe's top level: it builds through
 * templateOf().
 */
export function landerRevertKit() {
	let templateCulprit = "";
	let templateTip = "";
	const claims = {
		CLAUDE_CODE_SESSION_ID: "self-session",
		WFC_ANCHOR_LOCKS: "[]",
	};
	const copy = templateOf(() => {
		const built = committedRepo(TWO_GUARDS, (r) => {
			reviewIn(r, [], claims);
			fs.copyFileSync(
				path.join(__dirname, "..", "landing-registry-gate.js"),
				path.join(r, "scripts", "landing-registry-gate.js"),
			);
		});
		const { commit } = tools(built);
		templateCulprit = commit(
			{ "scripts/lib/extra.sh": "extra() { :; }\n" },
			"Add extra (#12)",
		);
		fs.writeFileSync(
			path.join(built, "scripts/guard-branch.sh"),
			'#!/bin/sh\nsource "$(dirname "$0")/lib/deny.sh"\nsource "$(dirname "$0")/lib/extra.sh"\nexit 2\n',
		);
		reviewIn(built, ["scripts/guard-branch.sh"], ownClaims(built));
		templateTip = commit({}, "Source extra, re-anchored");
		return built;
	});

	function tools(root: string) {
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		const commit = (files: Record<string, string>, msg: string) => {
			for (const [rel, body] of Object.entries(files))
				fs.writeFileSync(path.join(root, rel), body);
			git("add", "-A");
			git("commit", "-qm", msg);
			return git("rev-parse", "HEAD");
		};
		return { git, commit };
	}

	function repo() {
		const root = copy();
		return {
			root,
			...tools(root),
			culprit: templateCulprit,
			tip: templateTip,
		};
	}

	const env = (culprit?: string) => ({
		...claims,
		...(culprit ? { WFC_LANDER_REVERT: culprit } : {}),
	});
	const preCommit = (root: string, culprit?: string) =>
		run(root, ["--against", "HEAD"], { env: env(culprit) });
	const push = (root: string, sha: string, tip: string, culprit?: string) =>
		/* spawn-kept: a real fd, as the #3074 describe's — the gate streams the
		 * checker's report to the real fd 2. */
		spawnSync(
			"node",
			[path.join(root, "scripts", "landing-registry-gate.js")],
			{
				cwd: root,
				encoding: "utf8",
				input: `refs/heads/main ${sha} refs/heads/landing ${tip}\n`,
				env: {
					...process.env,
					...env(culprit),
					CLAUDE_PROJECT_DIR: root,
					WFC_RULES_DIR: "",
					WFC_RULES_FALLBACK_DIR: "",
					WFC_MODULES: "landing",
				},
			},
		);
	const review =
		"node scripts/check-guard-registry.js --review scripts/guard-branch.sh";

	/**
	 * `root` as the lander's checkout: `landing` and `main` on a bare remote
	 * at `tip`, and hooks running the two registry gates as .husky does.
	 */
	function landerCheckout(root: string, tip: string) {
		const remote = `${root}.git`;
		temps.push(remote);
		execFileSync("git", ["init", "-q", "--bare", remote]);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		git("remote", "add", "origin", remote);
		git(
			"push",
			"-q",
			"origin",
			`${tip}:refs/heads/landing`,
			`${tip}:refs/heads/main`,
		);
		const hooks = path.join(root, ".git", "gate-hooks");
		fs.mkdirSync(hooks);
		for (const [hook, script] of [
			["prepare-commit-msg", '"$GATES/check-guard-registry.js" --against HEAD'],
			["pre-push", '"$GATES/landing-registry-gate.js"'],
		] as const) {
			fs.writeFileSync(
				path.join(hooks, hook),
				`#!/bin/sh\nGATES=${shellQuote(`${root}/scripts`)}\nexec node ${script}\n`,
			);
			fs.chmodSync(path.join(hooks, hook), 0o755);
		}
		git("config", "core.hooksPath", hooks);
		for (const [name, value] of Object.entries({
			...claims,
			CLAUDE_PROJECT_DIR: root,
			WFC_RULES_DIR: "",
			WFC_RULES_FALLBACK_DIR: "",
			WFC_MODULES: "landing",
		}))
			vi.stubEnv(name, value);
		return (ref: string) =>
			execFileSync("git", ["rev-parse", ref], {
				cwd: remote,
				encoding: "utf8",
			}).trim();
	}
	return { repo, tools, preCommit, push, review, landerCheckout };
}
