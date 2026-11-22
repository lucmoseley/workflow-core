import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandPath } from "./command-path-testkit";
import { shellQuote } from "./sh-quote.js";

export type GitFaultMatch =
	| { all: true }
	| { words: string[] }
	| { every: string[] }
	| { first: string }
	| { argPrefix: string };

export type GitFaultAction =
	| { exit: number }
	| { sleep: number }
	| { script: string };

export interface FaultyGit {
	git: string;
	dir: string;
	hits: () => number;
}

let realGit: string | undefined;

export const resolveRealGit = (): string => {
	realGit ??= commandPath("git");
	return realGit;
};

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
