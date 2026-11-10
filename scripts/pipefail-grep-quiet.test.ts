// @vitest-environment node
/*
 * No tracked bash script under `pipefail` pipes into `grep -q` (#4983).
 *
 * `grep -q` exits on its first match; a producer still writing is then killed
 * by SIGPIPE (141), and `pipefail` makes the whole test read false — or true,
 * negated — at random (BashFAQ/105). Read the text with a here-string instead:
 * `grep -q PAT <<<"$var"`.
 *
 * Static on purpose: the race fires about 1 run in 25, so a behavioural case
 * would pin nothing.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findPipedQuietGrep } from "./lib/pipefail-grep-quiet.js";

const ROOT = path.resolve(import.meta.dirname, "..");

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

describe("tracked pipefail scripts", () => {
	it("none pipes into grep -q", () => {
		const files = execFileSync("git", ["ls-files", "*.sh"], {
			cwd: ROOT,
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean);
		const hits: string[] = [];
		for (const rel of files) {
			const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
			if (!/\bpipefail\b/.test(src)) continue;
			for (const line of findPipedQuietGrep(src)) hits.push(`${rel}:${line}`);
		}
		expect(hits).toEqual([]);
	});
});
