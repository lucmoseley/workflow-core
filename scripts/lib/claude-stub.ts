import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { buildAuthStatusBranch } from "./auth-status-fake";
import { LIVE_CALL_TIMEOUT_MS } from "./headless-options.js";
import { shellQuote } from "./sh-quote.js";

export const buildJobIdWord = (text: string, id: string) =>
	text.split(id).map(shellQuote).join('"$2"');

export const buildVersionBranch = (version: string) =>
	`if [ "$1" = "--version" ]; then echo ${shellQuote(`${version} (Claude Code)`)}; exit 0; fi`;

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

export function claudeLiveSkipReason(): string | undefined {
	if (process.env.CI)
		return "CI: the live claude case runs on the founder's machine only";
	const { status } = spawnSync("claude", ["--version"], {
		stdio: "ignore",
		timeout: LIVE_CALL_TIMEOUT_MS,
	});
	return status === 0 ? undefined : "no claude on PATH";
}

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
