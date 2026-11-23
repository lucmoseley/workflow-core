import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { readProgramLibs } from "../lib-closure-fixture";
import { defineTemplate } from "./git-fixture";
import { coreCall } from "./precommit-gate-testkit";
import { GATES } from "./precommit-gates.js";
import { runInProcess } from "./run-in-process";

export const REAL_SCRIPT = path.join(
	__dirname,
	"..",
	"check-guard-registry.js",
);
export const SELF_PLUGIN_HOOKS = "self-plugin/hooks/hooks.json";

export const asRoot =
	typeof process.getuid === "function" && process.getuid() === 0;

export const temps: string[] = [];

export function removeTemps(): void {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
}

export interface Fixture {
	claude?: string;
	files?: Record<string, string>;
}

const FIXTURE_LIBS = new Set([
	...readProgramLibs("check-guard-registry.js"),
	...readProgramLibs("landing-registry-gate.js"),
	"rule-text.sh",
]);

export const ANCHORS = ".claude/guard-registry-anchors.json";

export const IMPLICIT_MANIFEST = ".claude/implicit-behaviours.json";

export const ACTING_ROW = {
	IMPLICIT: "rewrites the file the session just wrote.",
	JUSTIFIED: "fail-safe — an unformatted file is read as a clobber later.",
	DEFEAT: "none — every failure path exits 0.",
	TREE: "host — reads the host root's stores.",
};

export function implicitRows(
	rows: Record<string, Record<string, string | string[]>>,
): Record<string, string> {
	return { [IMPLICIT_MANIFEST]: JSON.stringify(rows) };
}

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
	const files = {
		"package.json": "{}",
		[SELF_PLUGIN_HOOKS]: '{"hooks": {}}',
		...fx.files,
	};
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

export function reviewEnv(root: string, env: Record<string, string> = {}) {
	const { WFC_RULES_DIR: _drop, ...outer } = process.env;
	return { ...outer, CLAUDE_PROJECT_DIR: root, ...env };
}

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

export function lock(rel: string, { alive = true } = {}) {
	return {
		path: rel,
		sessionId: NEIGHBOUR,
		pid: 4242,
		alive,
		claimedAt: new Date().toISOString(),
	};
}

export function ownLocks(root: string, session: string, except: string[] = []) {
	const args = ["status", "--porcelain=v1", "-uall", "--no-renames", "-z"];
	return execFileSync("git", args, { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter((e) => e.length > 3)
		.map((e) => e.slice(3))
		.filter((rel) => !except.includes(rel))
		.map((rel) => ({ ...lock(rel), sessionId: session }));
}

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
	return {
		code,
		kinds: json.findings
			.filter((f: { severity: string }) => f.severity === "FAIL")
			.map((f: { tag: string }) => f.tag),
		json,
		report: stderr,
	};
}

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

const identifiedRepo = defineTemplate((dir) => {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
});

export function committedRepo(
	fx: Fixture,
	prepare?: (root: string) => void,
): string {
	const root = build(fx);
	prepare?.(root);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" });
	identifiedRepo.instantiate(root);
	git("add", "-A");
	git("commit", "-qm", "x");
	return root;
}

export function templateOf(make: () => string): () => string {
	let template = "";
	beforeAll(() => {
		template = make();
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
	const readHookLine = () => {
		const row = GATES.find((g) => g.id === "guard-registry");
		if (!row)
			throw new Error("no guard-registry row in lib/precommit-gates.js");
		return `${coreCall("node", row.script)} ${row.args.join(" ")} || exit "$?"`;
	};
	const added = (r: Result) =>
		r.json.findings
			.filter((f) => (f as { tag?: string }).tag === "NEW-FAULT")
			.map((f) => f.message);
	return { stagingRepo, claims, gate, review, readHookLine, added };
}
