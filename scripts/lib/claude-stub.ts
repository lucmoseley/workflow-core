/*
 * The bash `claude` stub every port fake's lines run in (#3030), and what
 * those fakes and their contracts share. Many port fakes share it, so it is
 * no `<port>-fake`: a test writing it imports no fake, and so reads no
 * port's fixture it does not use.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { buildAuthStatusBranch } from "./auth-status-fake";
import { shellQuote } from "./sh-quote.js";

/** `text` as one sh word, every `id` in it spliced as "$2": a recorded
 * answer to `claude <verb> <id>`. */
export const buildJobIdWord = (text: string, id: string) =>
	text.split(id).map(shellQuote).join('"$2"');

/** Write a bash `claude` stub at `bin` answering `auth status`
 * (lib/launch-auth.js), then running `lines` in turn, then exiting
 * `fallThroughExit`. */
export function writeClaudeStub(
	bin: string,
	lines: string[],
	fallThroughExit = 1,
) {
	fs.writeFileSync(
		bin,
		[
			"#!/bin/bash",
			buildAuthStatusBranch(),
			...lines,
			`exit ${fallThroughExit}`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return bin;
}

/** Why a contract's live `claude` case skips here, or undefined where it
 * runs (§G7.2). */
export function claudeLiveSkipReason(): string | undefined {
	if (process.env.CI)
		return "CI: the live claude case runs on the founder's machine only";
	const { status } = spawnSync("claude", ["--version"], {
		stdio: "ignore",
		// A guess: it answers in well under a second, and a hang should skip.
		timeout: 30_000,
	});
	return status === 0 ? undefined : "no claude on PATH";
}

/** The stub's `--bg` branch, a launch or a resume: runs the shell
 * `onLaunch`, prints file `out` and, where given, file `err` to stderr, then
 * exits 0 (#4413). */
export function buildBgBranch({
	out,
	err,
	onLaunch = "",
}: {
	out: string;
	err?: string;
	onLaunch?: string;
}) {
	return [
		'if [ "$1" = "--bg" ]; then',
		onLaunch,
		`cat ${shellQuote(out)}`,
		err ? `cat ${shellQuote(err)} >&2` : "",
		"exit 0",
		"fi",
	]
		.filter(Boolean)
		.join("\n");
}
