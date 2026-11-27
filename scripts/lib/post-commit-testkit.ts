import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, type Mock, vi } from "vitest";
import { scrubbedGitEnv } from "./git.js";
import { ROWS, runPostCommit as runDispatcher } from "./post-commit-rows.js";
import type { Programs } from "./post-commit-steps.js";

const load = createRequire(__filename);

export const SCRIPTS = path.join(__dirname, "..");

export const STEPS: typeof import("./post-commit-steps.js") = load(
	"./post-commit-steps.js",
);

export interface Io {
	cwd: string;
	env: NodeJS.ProcessEnv;
}
export interface Result {
	exit: number;
	stdout: string;
	stderr: string;
}
export type ProgramIo = Io & { args: string[] };

export const SILENT: Result = { exit: 0, stdout: "", stderr: "" };

export const PROGRAMS = [
	"report-new-shared-faults.js",
	"session-arbiter.js",
	"keep-hook-shims.js",
] as const;
export type Program = (typeof PROGRAMS)[number];

type CheckInProcess = Programs["check"];

const programFakes = new Map<string, Mock<(io: ProgramIo) => Result>>();
const checkFake: { now: Mock<CheckInProcess> | null } = { now: null };

afterEach(() => {
	programFakes.clear();
	checkFake.now = null;
});

export const programs: Programs = {
	load: (script) => {
		const real = load(path.join(SCRIPTS, script));
		const fake = programFakes.get(script);
		return fake ? { ...real, PROGRAM: fake } : real;
	},
	check: (spec, argv, opts) =>
		(checkFake.now ?? load("./check.js").checkInProcess)(spec, argv, opts),
};

export function stubProgram(script: Program, impl: (io: ProgramIo) => Result) {
	const fake = vi.fn(impl);
	programFakes.set(script, fake);
	return fake;
}

export function stubCheck(
	impl: (...a: Parameters<CheckInProcess>) => Result | Promise<Result>,
) {
	const fake = vi.fn<CheckInProcess>(async (...a) => impl(...a));
	checkFake.now = fake;
	return fake;
}

export function quietPrograms() {
	const quiet = Object.fromEntries(
		PROGRAMS.map((p) => [p, stubProgram(p, () => SILENT)]),
	) as Record<Program, ReturnType<typeof stubProgram>>;
	return { ...quiet, check: stubCheck(() => SILENT) };
}

export const echoArgv = ({ args }: ProgramIo): Result => ({
	exit: 0,
	stdout: args.map((a) => `${a}\n`).join(""),
	stderr: "",
});

export function hookEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const { CLAUDE_CODE_SESSION_ID: _, ...env } = process.env;
	return { ...env, GIT_INDEX_FILE: ".git/index", ...extra };
}

export async function runPostCommit(
	io: Io,
	rows: typeof ROWS = ROWS,
): Promise<Result> {
	const out = { 1: "", 2: "" };
	const exit = await runDispatcher(io, {
		rows,
		programs,
		write: (fd: number, text: string) => {
			out[fd === 1 ? 1 : 2] += text;
		},
	});
	return { exit, stdout: out[1], stderr: out[2] };
}

export function rowOf(id: string) {
	const row = ROWS.find((r) => r.id === id);
	if (!row) throw new Error(`post-commit-rows.js has no ${id} row`);
	return row;
}

export const REPLAY_SENTINELS = [
	["rebase-merge", "dir"],
	["rebase-apply", "dir"],
	["CHERRY_PICK_HEAD", "file"],
	["REVERT_HEAD", "file"],
	["BISECT_LOG", "file"],
] as const;

export function plantSentinel(root: string, sentinel: string, kind: string) {
	const at = path.join(root, ".git", sentinel);
	if (kind === "dir") fs.mkdirSync(at);
	else fs.writeFileSync(at, "\n");
}

export function linkedCommit(repo: string, dir: string) {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: scrubbedGitEnv(process.env),
		}).trim();
	const wt = path.join(dir, "wt");
	git(repo, "worktree", "add", "-q", "-b", "wt", wt);
	const hooks = path.join(dir, "hooks");
	const seen = path.join(dir, "hook-env");
	fs.mkdirSync(hooks);
	fs.writeFileSync(
		path.join(hooks, "post-commit"),
		`#!/bin/sh\nenv | grep -E '^GIT_(INDEX_FILE|DIR|WORK_TREE)=' > '${seen}'\n`,
		{ mode: 0o755 },
	);
	git(wt, "config", "core.hooksPath", hooks);
	fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
	fs.writeFileSync(path.join(wt, "docs", "wt.md"), "from the worktree\n");
	git(wt, "add", "-A");
	git(wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "wt");
	git(wt, "config", "--unset", "core.hooksPath");
	const redirects: Record<string, string> = Object.fromEntries(
		fs
			.readFileSync(seen, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
	);
	return {
		wt,
		env: { ...process.env, ...redirects } as NodeJS.ProcessEnv,
		redirects,
	};
}
