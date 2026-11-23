import fs from "node:fs";
import path from "node:path";
import LATEST from "./fixtures/gh/wsl-latest-release.json" with {
	type: "json",
};
import RELEASES from "./fixtures/gh/wsl-releases.json" with { type: "json" };
import type { GhAnswer } from "./gh-fake";
import { shellQuote } from "./sh-quote.js";

export type WslBehaviour =
	| { version: string }
	| { noVersionLine: true }
	| { exits: number; says: string }
	| { hangs: true }
	| { stallsOnce: true; version: string };

// guess: far over any budget a test passes, #4082
const HANG_S = 30;

const utf16 = (lines: string[]) =>
	Buffer.from(lines.map((l) => `${l}\r\n`).join(""), "utf16le");

const versionBytes = (version: string) =>
	utf16([
		`WSL version: ${version}`,
		"Kernel version: 6.18.33.2-2",
		"WSLg version: 1.0.71",
	]);

export function writeWsl(dir: string, behaviour: WslBehaviour): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "wsl.exe");
	const out = path.join(dir, "wsl-out");
	const err = path.join(dir, "wsl-err");
	fs.writeFileSync(
		out,
		"version" in behaviour
			? versionBytes(behaviour.version)
			: utf16(["something else"]),
	);
	fs.writeFileSync(err, "says" in behaviour ? utf16([behaviour.says]) : "");
	fs.writeFileSync(
		bin,
		[
			"#!/bin/bash",
			`echo "$*" >> ${shellQuote(wslCallLogPath(dir))}`,
			...("stallsOnce" in behaviour
				? [
						`[ "$(wc -l < ${shellQuote(wslCallLogPath(dir))})" -gt 1 ] || exit 1`,
					]
				: []),
			"hangs" in behaviour ? `exec sleep ${HANG_S}` : `cat ${shellQuote(out)}`,
			`cat ${shellQuote(err)} >&2`,
			`exit ${"exits" in behaviour ? behaviour.exits : 0}`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return bin;
}

export const wslCallLogPath = (dir: string): string =>
	path.join(dir, "wsl-calls");

export function writeOsrelease(dir: string, release: string): string {
	const root = path.join(dir, "proc");
	fs.mkdirSync(path.join(root, "sys/kernel"), { recursive: true });
	fs.writeFileSync(path.join(root, "sys/kernel/osrelease"), `${release}\n`);
	return root;
}

export const WSL_KERNEL = "6.18.33.2-microsoft-standard-WSL2";

export const buildLatestAnswer = (tag: string): GhAnswer => ({
	...LATEST,
	stdout: JSON.stringify({ ...JSON.parse(LATEST.stdout), tag_name: tag }),
});

export const buildReleasesAnswer = (
	tags: string[],
	preReleases: string[] = [],
): GhAnswer => {
	const [recorded] = JSON.parse(RELEASES.stdout);
	return {
		...RELEASES,
		stdout: JSON.stringify([
			...tags.map((tag) => ({ ...recorded, tag_name: tag })),
			...preReleases.map((tag) => ({
				...recorded,
				tag_name: tag,
				prerelease: true,
			})),
		]),
	};
};
