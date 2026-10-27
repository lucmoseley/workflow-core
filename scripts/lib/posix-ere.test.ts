// @vitest-environment node
/*
 * lib/posix-ere.js reads a pattern as bash's `=~` and pgrep compile it,
 * glibc's regcomp with REG_EXTENDED. Its contract is that compiler: every case
 * below is run through bash's own `=~` in one spawn, and the two must give the
 * same answer — matched, missed, or refused at compile — case-sensitive and
 * under nocasematch.
 *
 * The list is the edges where a JavaScript RegExp built from the pattern as
 * written disagrees with glibc: brackets, GNU escapes, intervals, a quantifier
 * with nothing to repeat, and an unbalanced bracket or paren. Loosen one and
 * lib/self-match.js reads a pattern that kills the session as one that misses
 * it, or refuses a safe one.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileEre } from "./posix-ere.js";

const CASES: [string, string][] = [
	["a{", "a{"],
	["a{1", "a{1"],
	["a{,2}", "a"],
	["{1}a", "a"],
	["*a", "*a"],
	["a**", "aa"],
	["a+?", "a"],
	["()", "x"],
	["a||b", "b"],
	["[]a]", "]"],
	["[^]a]", "b"],
	["[a\\]", "\\"],
	["[[:alpha:]]", "x"],
	["[[:foo:]]", "x"],
	["[[:upper:]]+", "ab"],
	["\\<ab", "x ab"],
	["ab\\>", "ab x"],
	["\\bab", "ab"],
	["\\d", "d"],
	["\\d", "1"],
	["\\w", "_"],
	["\\.", "a"],
	["a{2}", "aa"],
	["a{}", "a"],
	["a{2,1}", "aa"],
	["(", "("],
	[")", ")"],
	["a)", "a)"],
	["[", "["],
	["^*", "*"],
	["x|*", "*"],
	["$a", "a"],
	["a^", "a"],
	["[a-]", "-"],
	["[z-a]", "z"],
	["\\(", "("],
	["a\\", "a"],
	["[[.-.]]", "-"],
	["[[=a=]]", "a"],
	["?a", "a"],
	["a{1}{2}", "aa"],
	["\\n", "n"],
	["\\D", "d"],
	["\\q", "Q"],
	["(a)\\1", "aa"],
	["\\1", "1"],
	[".", "\n"],
	["[n]ode", "/bin/bash -c pkill -f '[n]ode'"],
	["node -c", "/bin/bash -c pkill -f 'node -c'"],
	["^bash$", "bash"],
	["BA", "bash"],
];

/** bash's answer for each case: 0 matched, 1 missed, 2 refused. */
function readBashAnswers(icase: boolean): string[] {
	const input = CASES.map(([p, s]) => `${JSON.stringify([p, s])}`).join("\n");
	const r = spawnSync(
		"bash",
		[
			"-c",
			`${icase ? "shopt -s nocasematch;" : ""}
while IFS= read -r line; do
  # jq ends each value with a newline; the x keeps $(…) from eating its own.
  p="$(jq -r '.[0]' <<<"$line"; echo x)"; p="\${p%$'\\nx'}"
  s="$(jq -r '.[1]' <<<"$line"; echo x)"; s="\${s%$'\\nx'}"
  [[ "$s" =~ $p ]]; echo $?
done`,
		],
		{ input: `${input}\n`, encoding: "utf8" },
	);
	return r.stdout.trim().split("\n");
}

const answer = (p: string, s: string, icase: boolean) => {
	const re = compileEre(p, { icase });
	if (re === null) return "2";
	return re.test(s) ? "0" : "1";
};

describe("compileEre agrees with bash's =~", () => {
	it.each([false, true])("on every case, nocasematch %s", (icase) => {
		const bash = readBashAnswers(icase);
		expect(bash).toHaveLength(CASES.length);
		const ours = CASES.map(([p, s]) => answer(p, s, icase));
		expect(
			CASES.map(([p, s], i) => `${p} on ${JSON.stringify(s)}: ${ours[i]}`),
		).toEqual(
			CASES.map(([p, s], i) => `${p} on ${JSON.stringify(s)}: ${bash[i]}`),
		);
	});
});
