// @vitest-environment node
/*
 * Holds lib/bash-quote.js to bash's own `printf %q`, word for word, over every
 * printable ASCII character alone and inside a word, the positional `#` and
 * `~` rules, control bytes and non-ASCII under a C and a UTF-8 locale.
 *
 * Loosen it and the dispatcher's `would launch:` line stops pasting back into
 * bash as the command it names.
 *
 * spawn-kept: the oracle is bash itself, one `printf %q` call per locale over
 * every word at once.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bashQuote } from "./bash-quote.js";

const printable = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
	String.fromCharCode(0x20 + i),
);
const WORDS = [
	"",
	...printable,
	...printable.map((c) => `a${c}b`),
	...printable.map((c) => `${c}a`),
	"a=~b",
	"x:~",
	"~/x",
	"a~b",
	"#x",
	"x#",
	"a\nb",
	"\t",
	"\x01\x1b\x7f",
	"it's",
	"é",
	"naïve café",
	"claude-haiku-5-5[1m]",
	"/implement 341",
	"--name=/implement 341",
];

/** What bash's `printf %q` prints for each of WORDS under `locale`. */
const bashSays = (locale: string): string[] => {
	const r = spawnSync(
		"bash",
		["-c", 'for w in "$@"; do printf "%q\\0" "$w"; done', "q", ...WORDS],
		{ encoding: "utf8", env: { ...process.env, LC_ALL: locale } },
	);
	expect(r.status, r.stderr).toBe(0);
	return r.stdout.split("\0").slice(0, -1);
};

describe("bashQuote", () => {
	it.each(["C", "C.UTF-8"])(
		"matches bash's printf %%q under LC_ALL=%s",
		(locale) => {
			const want = bashSays(locale);
			const got = WORDS.map((w) => bashQuote(w, { LC_ALL: locale }));
			expect(got).toEqual(want);
		},
	);
});
