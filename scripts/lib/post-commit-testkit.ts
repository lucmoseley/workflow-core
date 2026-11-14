/*
 * post-commit-testkit.ts — .husky/post-commit's rows driven in this process
 * (#5208, spec #5207): the registry run as scripts/post-commit-dispatch.js
 * runs it, on the real route port, and the programs the rows reach stood in
 * for where a case is about the row's half rather than the program's answer.
 *
 * A stand-in replaces a program's PROGRAM export, or lib/check.js's
 * checkInProcess, in `programs`, the steps' Programs port this kit hands
 * every row it runs; a program no case stood in for runs for real. The
 * stand-ins are dropped after every case.
 *
 * FOR TESTS ONLY.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, type Mock, vi } from "vitest";
import { runPostCommit as runDispatcher } from "../post-commit-dispatch.js";
import { scrubbedGitEnv } from "./hook-entry.js";
import { ROWS } from "./post-commit-rows.js";
import type { Programs } from "./post-commit-steps.js";

const load = createRequire(__filename);

export const SCRIPTS = path.join(__dirname, "..");

/** lib/post-commit-steps.js as the registry's rows hold it: the instance in
 * Node's own require cache, which an ESM import of the file is not, so a
 * case can compare a row's `run` with its step. */
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

/** The programs the rows run through a PROGRAM export. */
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

/**
 * The Programs port every row this kit runs is handed: each program's own
 * module and lib/check.js's checkInProcess, but for what the case stood in.
 */
export const programs: Programs = {
	load: (script) => {
		const real = load(path.join(SCRIPTS, script));
		const fake = programFakes.get(script);
		return fake ? { ...real, PROGRAM: fake } : real;
	},
	check: (spec, argv, opts) =>
		(checkFake.now ?? load("./check.js").checkInProcess)(spec, argv, opts),
};

/** Stand `impl` in for `script`'s PROGRAM until the case ends. */
export function stubProgram(script: Program, impl: (io: ProgramIo) => Result) {
	const fake = vi.fn(impl);
	programFakes.set(script, fake);
	return fake;
}

/**
 * Stand `impl` in for lib/check.js's checkInProcess, which the two
 * `--touched-by` rows run their checker through, until the case ends.
 */
export function stubCheck(
	impl: (...a: Parameters<CheckInProcess>) => Result | Promise<Result>,
) {
	const fake = vi.fn<CheckInProcess>(async (...a) => impl(...a));
	checkFake.now = fake;
	return fake;
}

/** Every program the rows reach, silent: the rows of git alone stay real. */
export function quietPrograms() {
	const quiet = Object.fromEntries(
		PROGRAMS.map((p) => [p, stubProgram(p, () => SILENT)]),
	) as Record<Program, ReturnType<typeof stubProgram>>;
	return { ...quiet, check: stubCheck(() => SILENT) };
}

/** A stand-in program writing its argv, one per line, to stdout. */
export const echoArgv = ({ args }: ProgramIo): Result => ({
	exit: 0,
	stdout: args.map((a) => `${a}\n`).join(""),
	stderr: "",
});

/** The env a hook's process has: no session unless given one, and the
 * relative GIT_INDEX_FILE git exports into every hook. */
export function hookEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const { CLAUDE_CODE_SESSION_ID: _, ...env } = process.env;
	return { ...env, GIT_INDEX_FILE: ".git/index", ...extra };
}

/**
 * The registry's run as scripts/post-commit-dispatch.js runs it, under
 * `io`. What it writes comes back per stream.
 */
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

/** The registry's row `id`. */
export function rowOf(id: string) {
	const row = ROWS.find((r) => r.id === id);
	if (!row) throw new Error(`post-commit-rows.js has no ${id} row`);
	return row;
}

/** What a replay leaves in the git dir, one per route-gated sentinel: a
 * rebase's and an apply's are directories, the rest files. */
export const REPLAY_SENTINELS = [
	["rebase-merge", "dir"],
	["rebase-apply", "dir"],
	["CHERRY_PICK_HEAD", "file"],
	["REVERT_HEAD", "file"],
	["BISECT_LOG", "file"],
] as const;

/** Leave `sentinel` in `root`'s git dir. */
export function plantSentinel(root: string, sentinel: string, kind: string) {
	const at = path.join(root, ".git", sentinel);
	if (kind === "dir") fs.mkdirSync(at);
	else fs.writeFileSync(at, "\n");
}

/**
 * A linked worktree of `repo` (made under `dir`) whose commit of `docs/wt.md`
 * fires a post-commit hook recording the GIT_* variables git hands it;
 * returns the worktree and the caller's env with those variables in it, as a
 * hook's own process has them.
 */
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
