// @vitest-environment node
/*
 * lib/npm-options.js's `npmCanon`, npm 11.16.0's option parser in Node, and
 * the exact-match lookups npx makes instead, `shorthandExact` and `boolExact`
 * (#563, #571, #1972), pinned over one fixture set. lib/suite-concurrency.js
 * reads with it whether `npm … run <name>` launches a build or a dev server,
 * and lib/npm-install.js the install and the npx argv it judges.
 *
 * A drift lets a second `next build` spelt with npm's own flags through, or
 * takes a flag's value for the script name and refuses an unrelated command
 * as a build.
 */

import { describe, expect, it } from "vitest";

const { boolExact, npmCanon, shorthandExact } = require("./npm-options.js") as {
	boolExact: (flag: string) => boolean;
	npmCanon: (argv: string[]) => string[];
	shorthandExact: (key: string) => string[] | null;
};

const CANON_CASES: [string[], string[]][] = [
	[
		["run", "build"],
		["run", "build"],
	],
	[
		["-s", "run", "build"],
		["--loglevel=silent", "run", "build"],
	],
	[
		["--silent", "run", "dev"],
		["--loglevel=silent", "run", "dev"],
	],
	[
		["-ddd", "run", "build"],
		["--loglevel=silly", "run", "build"],
	],
	[
		["-DE", "run", "build"],
		["--save-dev", "--save-exact", "run", "build"],
	],
	[
		["--prefix", "x", "run", "build"],
		["--prefix=x", "run", "build"],
	],
	[
		["-C", "x", "run", "build"],
		["--prefix=x", "run", "build"],
	],
	[
		["--cafi", "ca.pem", "run", "build"],
		["--cafile=ca.pem", "run", "build"],
	],
	[
		["-cafile", "ca.pem", "run", "build"],
		["--cafile=ca.pem", "run", "build"],
	],
	[
		["-y", "null", "run", "build"],
		["--yes=null", "run", "build"],
	],
	[
		["--tag", "--no-ignore-scripts", "run", "build"],
		["--tag=", "--no-ignore-scripts", "run", "build"],
	],
	[
		["--tag=--x", "run", "build"],
		["--tag=", "--x", "run", "build"],
	],
	[
		["--no-no-global", "run"],
		["--global", "run"],
	],
	[
		["--loglevel", "silent", "run", "build"],
		["--loglevel=silent", "run", "build"],
	],
	[
		["--depth", "3", "run", "build"],
		["--depth=3", "run", "build"],
	],
	[
		["--depth", "x", "run"],
		["--depth=x", "run"],
	],
	[
		["--audit-level", "high", "run"],
		["--audit-level=high", "run"],
	],
	[
		["--no-workspace", "--", "run"],
		["--no-workspace=--", "run"],
	],
	[
		["--browser", "--", "run"],
		["--browser=--", "run"],
	],
	[
		["-w", "web", "run", "build"],
		["--workspace=web", "run", "build"],
	],
	[
		["--ws", "run", "build"],
		["--workspaces", "run", "build"],
	],
	[
		["--wor", "web", "run", "dev"],
		["--wor", "web", "run", "dev"],
	],
	[
		["--foo", "run", "build"],
		["--foo", "run", "build"],
	],
	[
		["--foo=bar", "run", "build"],
		["--foo=bar", "run", "build"],
	],
	[
		["-=", "run"],
		["", "run"],
	],
	[["--save-dev=pkg"], ["--save-dev", "pkg"]],
	[
		["-q=1", "run"],
		["--loglevel=warn", "1", "run"],
	],
	[
		["--NO-global", "run"],
		["--no-global", "run"],
	],
	[
		["--json", "true", "run", "build"],
		["--json=true", "run", "build"],
	],
	[
		["--expires", "0x1f", "run"],
		["--expires=0x1f", "run"],
	],
	[
		["--expires", " 1e3 ", "run"],
		["--expires= 1e3 ", "run"],
	],
	[
		["--yes", "Infinity"],
		["--yes", "Infinity"],
	],
	[
		["--", "run", "build"],
		["--", "run", "build"],
	],
	[
		["---", "run"],
		["--", "run"],
	],
	[
		["-x", "run", "build"],
		["--x", "run", "build"],
	],
	[
		["--include", "dev", "run", "build"],
		["--include=dev", "run", "build"],
	],
	[
		["--no-include", "x"],
		["--no-include", "x"],
	],
	[
		["--color", "always", "run"],
		["--color=always", "run"],
	],
	[
		["--ena", "2020", "run"],
		["--ena", "2020", "run"],
	],
	[
		["-l", "run"],
		["--long", "run"],
	],
];

/* The keys npx looks up whole (#1972): the shorthand keys and Boolean flags
 * among them, and the near misses — an abbreviation, a glued run, a `--no-`
 * form, a key outside the character set. */
const SHORTHAND_CASES: [string, string[] | null][] = [
	["p", ["--parseable"]],
	["q", ["--loglevel", "warn"]],
	["quiet", ["--loglevel", "warn"]],
	["n", ["--no-yes"]],
	["no", ["--no-yes"]],
	["h", ["--usage"]],
	["help", ["--usage"]],
	["?", ["--usage"]],
	["H", ["--usage"]],
	["v", ["--version"]],
	["DE", null],
	["D", ["--save-dev"]],
	["enjoy-by", ["--before"]],
	["reg", ["--registry"]],
	["regi", null],
	["y", ["--yes"]],
	["ws", ["--workspaces"]],
	["d", ["--loglevel", "info"]],
	["ddd", ["--loglevel", "silly"]],
	["x", null],
	["", null],
	["p=", null],
	["q q", null],
];

const BOOL_CASES: [string, boolean][] = [
	["--audit", true],
	["--no-audit", false],
	["--ignore-scripts", true],
	["--ign", false],
	["--yes", true],
	["--tag", false],
	["--usage", true],
	["--", false],
	["", false],
	["audit", false],
];

describe("the exact-match lookups npx makes (#1972)", () => {
	it.each(SHORTHAND_CASES)("shorthandExact(%j) is %j", (key, exp) => {
		expect(shorthandExact(key)).toEqual(exp);
	});

	it.each(BOOL_CASES)("boolExact(%j) is %j", (flag, yes) => {
		expect(boolExact(flag)).toBe(yes);
	});
});

describe("npmCanon", () => {
	it.each(CANON_CASES)("canonicalises %j to %j", (argv, canon) => {
		expect(npmCanon(argv)).toEqual(canon);
	});
});
