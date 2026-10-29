/*
 * git-fault-fake.ts — the fault-injecting `git` a test sets at WFC_GIT
 * (#3067). The wrapper fails, hangs or runs a script body on the argv its
 * `match` names, and `exec`s the real git on every other, so a case breaks one
 * git read and leaves the rest of the program's git real; an `all` match
 * catches every call.
 *
 * Its contract, held by git-fault.contract.test.ts (§G7): an argv the match
 * does not name behaves exactly as the real git does — exit code, stdout and
 * stderr.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Which calls fault: `words`, those arguments in a row anywhere in the argv
 * (read off `$*`, so an argument holding a space splits); `every`, each of
 * them anywhere, in any order (read the same way); `first`, the first
 * argument; `argPrefix`, any argument starting with it; `all`, every call.
 */
export type GitFaultMatch =
	| { all: true }
	| { words: string[] }
	| { every: string[] }
	| { first: string }
	| { argPrefix: string };

/**
 * What a matched call does: `exit` with that code;
 * `sleep` that many seconds, as the process a timeout kills; or run `script`,
 * an sh body seeing the call's argv and the real git at `$REAL_GIT`, which
 * falls through to the real git where it does not exit. A value the body
 * names goes in through `shellQuote`.
 */
export type GitFaultAction =
	| { exit: number }
	| { sleep: number }
	| { script: string };

export interface FaultyGit {
	/** The wrapper, for WFC_GIT. */
	git: string;
	/** The temp dir holding it, the caller's to remove. */
	dir: string;
	/** How many calls the match has caught so far. */
	hits: () => number;
}

let realGit: string | undefined;

/** The git on PATH, resolved once, which every unmatched call reaches. */
export const resolveRealGit = (): string => {
	realGit ??= execFileSync("sh", ["-c", "command -v git"], {
		encoding: "utf8",
	}).trim();
	return realGit;
};

/** `s` as one sh word. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const matchLines = (match: GitFaultMatch): string[] => {
	if ("all" in match) return ['fault "$@"'];
	if ("words" in match)
		return [
			`case " $* " in *${shellQuote(` ${match.words.join(" ")} `)}*) fault "$@" ;; esac`,
		];
	if ("every" in match)
		return [
			"hit=1",
			`for w in ${match.every.map(shellQuote).join(" ")}; do`,
			'  case " $* " in *" $w "*) ;; *) hit= ;; esac',
			"done",
			'[ -n "$hit" ] && fault "$@"',
		];
	if ("first" in match)
		return [`[ "$1" = ${shellQuote(match.first)} ] && fault "$@"`];
	return [
		'for a in "$@"; do',
		`  case $a in ${shellQuote(match.argPrefix)}*) fault "$@"; break ;; esac`,
		"done",
	];
};

const actionLines = (action: GitFaultAction): string[] => {
	if ("exit" in action) return [`  exit ${action.exit}`];
	if ("sleep" in action) return [`  exec sleep ${action.sleep}`];
	return action.script.split("\n").map((l) => `  ${l}`);
};

/**
 * Write a fault-injecting git into a fresh temp dir under `under` (the system
 * temp dir by default) and return it with its hit count.
 */
export function writeFaultyGit(
	match: GitFaultMatch,
	action: GitFaultAction,
	{ under = os.tmpdir() }: { under?: string } = {},
): FaultyGit {
	const dir = fs.mkdtempSync(path.join(under, "faulty-git-"));
	const hitLog = path.join(dir, "hits");
	const git = path.join(dir, "git");
	fs.writeFileSync(
		git,
		[
			"#!/bin/sh",
			`REAL_GIT=${shellQuote(resolveRealGit())}`,
			"fault() {",
			`  echo >> ${shellQuote(hitLog)}`,
			...actionLines(action),
			"}",
			...matchLines(match),
			'exec "$REAL_GIT" "$@"',
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const hits = () =>
		fs.existsSync(hitLog) ? fs.readFileSync(hitLog, "utf8").length : 0;
	return { git, dir, hits };
}
