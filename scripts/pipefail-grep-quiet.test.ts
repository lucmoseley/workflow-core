// @vitest-environment node
/*
 * pipefail-grep-quiet.test.ts — no tracked bash file pipes into `grep -q`
 * (#4983).
 *
 * `grep -q` exits on its first match; a producer still writing is then killed
 * by SIGPIPE (141), and `pipefail` makes the whole test read false — or true,
 * negated — at random (BashFAQ/105). Read the text with a here-string instead: `grep -q PAT <<<"$var"`.
 *
 * Every bash file is scanned, not only those that set `pipefail`: a sourced lib
 * runs under its caller's options. POSIX sh files are skipped: sh has no
 * here-string to rewrite to. Static so it covers every file, not only the
 * site a behavioural case would drive. Loosen it and the race comes back
 * unseen.
 *
 * The literal `git ls-files` pathspecs let the test selector run this on an
 * edit to any shell file; readTrackedShellFiles adds the extensionless ones.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTrackedShellFiles } from "./lib/formatters.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function isQuietGrep(segment: string): boolean {
	const words = segment.trim().split(/\s+/);
	while (/^[A-Za-z_]\w*=/.test(words[0] ?? "") || words[0] === "command")
		words.shift();
	if (!/^[ef]?grep$/.test(words[0] ?? "")) return false;
	return words
		.slice(1)
		.some((w) => /^-[A-Za-pr-z]*q[A-Za-z]*$|^--(quiet|silent)$/.test(w));
}

/** The 1-based lines where a pipe feeds `grep -q`. */
function findPipedQuietGrep(src: string): number[] {
	const hits: number[] = [];
	let pipeOpen = false;
	src.split("\n").forEach((line, i) => {
		if (/^\s*#/.test(line)) return;
		const segments = line.split(/(?<!\|)\|&?(?!\|)/).slice(pipeOpen ? 0 : 1);
		if (segments.some(isQuietGrep)) hits.push(i + 1);
		pipeOpen = /(?<!\|)\|&?\s*\\?\s*$/.test(line);
	});
	return hits;
}

function isBash(src: string): boolean {
	const head = src.split("\n", 3).join("\n");
	if (/^#!.*\bbash\b/.test(head)) return true;
	if (/^#!.*\b(sh|dash)\b/.test(head)) return false;
	return !/^# shellcheck shell=(sh|dash)\b/m.test(head);
}

describe("findPipedQuietGrep", () => {
	it("flags a one-line pipe into grep -q", () => {
		expect(findPipedQuietGrep(`printf '%s\\n' "$x" | grep -q '^a'`)).toEqual([
			1,
		]);
	});

	it("flags a combined flag, --quiet and a pipe continued onto the next line", () => {
		const src = [
			"a | grep -qxF b",
			"c | grep --quiet d",
			`"$gh" api x |`,
			`  grep -qx "$child"`,
		].join("\n");
		expect(findPipedQuietGrep(src)).toEqual([1, 2, 4]);
	});

	it("flags a late -q, a prefixed grep, egrep, |& and a pipe continued across a \\ or a comment", () => {
		const src = [
			"a | grep -e b -q",
			"a | LC_ALL=C grep -q b",
			"a | command grep -q b",
			"a | egrep -q b",
			"a |& grep -q b",
			"a |",
			"  # why",
			"  grep -q b",
			"a | \\",
			"  grep -q b",
		].join("\n");
		expect(findPipedQuietGrep(src)).toEqual([1, 2, 3, 4, 5, 8, 10]);
	});

	it("passes a here-string, a file argument, a non-quiet grep, an || and a comment", () => {
		const src = [
			`grep -q '^a' <<<"$x"`,
			`grep -qF b "$file"`,
			"a | grep -c b",
			"# a | grep -q b",
			"a || grep -q b c",
			"a ||",
			"  grep -q b c",
		].join("\n");
		expect(findPipedQuietGrep(src)).toEqual([]);
	});
});

describe("isBash", () => {
	it("reads the shebang, then the shellcheck directive, else bash", () => {
		expect(isBash("#!/usr/bin/env bash\n")).toBe(true);
		expect(isBash("#!/bin/sh\n")).toBe(false);
		expect(isBash("# shellcheck shell=sh\n")).toBe(false);
		expect(isBash("# shellcheck shell=bash\n")).toBe(true);
		expect(isBash("# a lib\n")).toBe(true);
	});
});

describe("tracked bash files (#4983)", () => {
	it("none pipes into grep -q", () => {
		const listed = execFileSync(
			"git",
			["ls-files", "*.sh", "*.bash", ".husky/*"],
			{ cwd: ROOT, encoding: "utf8" },
		)
			.split("\n")
			.filter(Boolean);
		const files = [...new Set([...listed, ...readTrackedShellFiles()])];
		expect(files).toContain("scripts/dispatch-sessions.sh");
		const hits: string[] = [];
		for (const rel of files) {
			const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
			if (!isBash(src)) continue;
			for (const line of findPipedQuietGrep(src)) hits.push(`${rel}:${line}`);
		}
		expect(hits).toEqual([]);
	});
});
