// @vitest-environment node
/*
 * lib/pgrep-args.js reads a pgrep or pkill's arguments as procps-ng does —
 * which word is the pattern, and which flags change how it selects — and
 * whether that pattern selects a given text. lib/self-match.js and
 * lib/paste-self-match.js judge every pgrep and pkill through it, so a misread
 * here is a missed self-kill in both.
 *
 * The signal words are the ones bash's `kill -l` accepts: walked letter by
 * letter, `-TSTP` would read as `-T -S -T -P`, the `-P` swallowing the
 * next word.
 */

import { describe, expect, it } from "vitest";

/* CommonJS, hence the require. */
const { isSignalWord, pgrepSelects, readPgrepArgs } =
	require("./pgrep-args.js") as {
		isSignalWord: (w: string) => boolean;
		pgrepSelects: (
			subject: string,
			pattern: string,
			a: { exact: boolean; icase: boolean; invert: boolean },
		) => "selects" | "spares" | "invalid";
		readPgrepArgs: (words: string[]) => Record<string, unknown>;
	};

describe("a signal spelled as an option is dropped before the flags are read", () => {
	it.each([
		"-9",
		"-0",
		"-64",
		"-129",
		"-192",
		"-STOP",
		"-SIGTERM",
		"-HUP",
		"-RTMIN",
		"-RTMIN+30",
		"-SIGRTMAX-14",
		"-EXIT",
		"-DEBUG",
	])("%s is a signal", (w) => {
		expect(isSignalWord(w)).toBe(true);
	});

	it.each([
		["-65", "past the last real-time signal"],
		["-128", "between the two numbered ranges"],
		["-193", "past the shifted range"],
		["-F", "a capital flag that names no signal"],
		["-P", "another"],
		["-RTMIN+31", "past RTMAX"],
		["-RTMAX-15", "below RTMIN"],
		["-SIGEXIT", "a trap name never takes SIG"],
		["-IOT", "a name kill -l does not list"],
		["-stop", "lower case is a flag run"],
	])("%s — %s — is not", (w) => {
		expect(isSignalWord(w)).toBe(false);
	});

	it("reads -f past a signal whose letters would swallow it", () => {
		expect(readPgrepArgs(["-TSTP", "-f", "land.sh"])).toMatchObject({
			full: true,
			pattern: "land.sh",
		});
	});

	it("reads no -A out of a signal's letters", () => {
		expect(readPgrepArgs(["-ALRM", "-f", "x"]).ancestors).toBe(false);
	});
});

describe("the flags and the pattern", () => {
	it("skips a value-taking flag's value", () => {
		expect(readPgrepArgs(["-u", "lucmo", "-f", "x"])).toMatchObject({
			full: true,
			pattern: "x",
		});
	});

	it("reads -f inside a bundle, and every long spelling", () => {
		expect(readPgrepArgs(["-if", "x"])).toMatchObject({
			full: true,
			icase: true,
		});
		expect(
			readPgrepArgs([
				"--full",
				"--ignore-case",
				"--exact",
				"--inverse",
				"--ignore-ancestors",
				"x",
			]),
		).toEqual({
			full: true,
			icase: true,
			exact: true,
			invert: true,
			ancestors: true,
			pattern: "x",
		});
	});

	it("takes the first bare word as the pattern", () => {
		expect(readPgrepArgs(["a", "b"]).pattern).toBe("a");
	});
});

describe("whether a pattern selects", () => {
	const plain = { exact: false, icase: false, invert: false };
	it.each([
		["bash", "ba", plain, "selects"],
		["bash", "ba", { ...plain, exact: true }, "spares"],
		["bash", "BASH", { ...plain, icase: true }, "selects"],
		["bash", "node", { ...plain, invert: true }, "selects"],
		["bash", "bash", { ...plain, invert: true }, "spares"],
		["bash", "(", plain, "invalid"],
	] as const)("%s by %s under %o: %s", (subject, pattern, a, expected) => {
		expect(pgrepSelects(subject, pattern, a)).toBe(expected);
	});
});
