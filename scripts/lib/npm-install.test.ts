// @vitest-environment node
/*
 * lib/npm-install.js, guard-npm-install.js's core (#2800), in process: the
 * npm install boundary (mantahostels#1803, ruled at mantahostels#1767).
 *
 * THREE CHECKS, tested in both directions each: the execution window
 * (`--ignore-scripts` on an install that adds a package), new-package
 * legitimacy (the name exists, clears 180 days, clears 1,000 downloads a
 * month, inside a 30 s budget), and the bare `npx` name.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR THE DISK. package.json, the installed
 * manifests, both registry calls and the clock are fakes passed as values,
 * the registry calls lib/npm-registry-fake.ts's, which
 * lib/npm-registry.contract.test.ts holds to the real npm and curl; the
 * production adapters are crossed in guard-npm-install.test.ts.
 *
 * The thresholds are constants in the core, so each threshold case pins the
 * boundary from both sides — one day inside and one day outside — which is
 * what makes a silent change to either constant fail something. It is the
 * only vetting of a new dependency, so a loosened case lets an unvetted
 * install through.
 */

import { describe, expect, it } from "vitest";
import { fakeTreeClassifier } from "./git-tree-fake.js";
import { kitContextFake } from "./kit-context-fake";
import {
	buildPassingRegistry,
	type Call,
	downloadsAnswer,
	npmViewAnswer,
	type Registry,
} from "./npm-registry-fake";

const { decide } = require("./npm-install.js") as {
	decide: (command: string, ctx: object) => { deny: string } | null;
};

const NOW = Date.parse("2026-10-25T12:00:00.000Z");

const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const PKG = {
	dependencies: { "js-yaml": "^4.1.0" },
	devDependencies: {
		vitest: "^3.0.0",
		typescript: "^5.0.0",
		"@biomejs/biome": "^2.0.0",
	},
};

/** The installed manifests, as `node_modules` holds them (#1806). */
const INSTALLED: Record<string, string> = {
	typescript: JSON.stringify({
		name: "typescript",
		bin: { tsc: "bin/tsc", tsserver: "bin/tsserver" },
	}),
	"@biomejs/biome": JSON.stringify({
		name: "@biomejs/biome",
		bin: { biome: "bin/biome" },
	}),
	"js-yaml": JSON.stringify({ name: "js-yaml", bin: "bin/js-yaml.js" }),
	vitest: JSON.stringify({ name: "vitest", bin: { vitest: "vitest.mjs" } }),
};

interface Over {
	pkg?: string | null;
	manifests?: Record<string, string>;
	allow?: boolean;
	now?: () => number;
	vars?: Record<string, string>;
}

function harness(reg: Partial<Registry> = {}, over: Over = {}) {
	const logs: string[] = [];
	const calls: string[] = [];
	const full = { ...buildPassingRegistry(NOW), ...reg };
	const ctx = kitContextFake({
		vars: over.vars ?? {},
		isDir: () => true,
		treeClass: fakeTreeClassifier({ "/repo": "shared" }),
		log: (what: string, detail?: string) =>
			logs.push(detail ? `${what}\t${detail}` : what),
		readPackageJson: () => ({
			path: "/repo/package.json",
			text: over.pkg === undefined ? JSON.stringify(PKG) : over.pkg,
		}),
		readManifest: (dep: string) => over.manifests?.[dep] ?? null,
		npmView: (pkg: string): Call => {
			calls.push(`npm view ${pkg} time.created --json`);
			return npmViewAnswer(full);
		},
		downloads: (pkg: string): Call => {
			calls.push(`downloads ${pkg}`);
			return downloadsAnswer(full);
		},
		now: over.now ?? (() => NOW),
		allowNewPackage: over.allow ?? false,
	});
	return { ctx, logs, calls };
}

/** The refusal's prose, or null where the core allowed. */
const denial = (
	command: string,
	reg: Partial<Registry> = {},
	over: Over = {},
): string | null => {
	const d = decide(command, harness(reg, over).ctx);
	return d === null ? null : d.deny;
};

const allows = (
	command: string,
	reg: Partial<Registry> = {},
	over: Over = {},
) => denial(command, reg, over) === null;

/** The registry calls `command` makes. */
const callsOf = (
	command: string,
	reg: Partial<Registry> = {},
	over: Over = {},
) => {
	const h = harness(reg, over);
	decide(command, h.ctx);
	return h.calls;
};

const ESCAPE = `The escape is \`WFC_ALLOW_NEW_PACKAGE=1\` in the environment Claude Code itself
was started in — NOT on this command line, which is read but never honoured: an
escape a session can spell for itself is not a deny (mantahostels#109). Otherwise ask the
founder to run the install from their own terminal, which sees no hook.`;

describe("what it does not judge", () => {
	it.each([
		// The lockfile install: no package named, so nothing is added that
		// `package.json` has not already been reviewed for.
		"npm install",
		"npm i",
		"npm ci",
		"npm run test",
		"npm test",
		"npm view left-pad version",
		"npm ls --depth 0",
		// An install alias that is not the subcommand.
		"npm run install left-pad",
		"npm view left-pad add",
		// A bare `npm` names nothing.
		"npm",
		// A package already in package.json is a reinstall, not an addition.
		"npm install js-yaml",
		"npm i js-yaml@4.1.0",
		"npm install vitest typescript",
		// A help request installs nothing, however npm lets it be spelled.
		"npm install --help left-pad",
		"npm install -h left-pad",
		"npm i --hel left-pad",
		// Another package manager entirely — out of scope, stated in LIMITS.
		"pnpm add left-pad",
		"yarn add left-pad",
		"bun add left-pad",
		// A binary reached by path resolves to exactly one thing.
		"node_modules/.bin/biome ci .",
		"npx @biomejs/biome ci .",
		"npx ./scripts/thing.js",
	])("allows `%s`", (command) => {
		expect(allows(command)).toBe(true);
	});

	it("allows a command that merely MENTIONS an install", () => {
		// The false-positive mode a Bash deny has and a structured-field deny does
		// not (mantahostels#103): a session documenting the hazard must not trip it.
		expect(
			allows('echo "run npm install left-pad to reproduce" >> notes.md'),
		).toBe(true);
	});

	it("reads npm by its basename, reached by path", () => {
		expect(denial("/usr/bin/npm install left-pad")).toMatch(/--ignore-scripts/);
	});
});

describe("check 1 — the execution window", () => {
	it("denies an install that adds a package without --ignore-scripts, in full", () => {
		expect(denial("npm install left-pad")).toBe(
			`This install adds 1 package(s) this repo does not yet depend on — left-pad  — and does not carry \`--ignore-scripts\`: npm install left-pad

A package's \`preinstall\` and \`postinstall\` run as you, before anything reads a byte of it. Re-run with \`--ignore-scripts\`; it is per-invocation, so husky's \`prepare\` bootstrap on a fresh clone is untouched (mantahostels#1767 rejected the repo-wide \`.npmrc\` form for exactly that reason).

Then commit the lockfile.`,
		);
	});

	it.each([
		"npm install --ignore-scripts left-pad",
		"npm install --ignore-scripts true left-pad",
		"npm install --no-ignore-scripts false left-pad",
	])("allows `%s`, which carries --ignore-scripts", (command) => {
		expect(allows(command)).toBe(true);
	});

	it.each(["add", "i", "in", "install", "isntall"])(
		"reads `npm %s` as an install",
		(sub) => {
			expect(denial(`npm ${sub} left-pad`)).toMatch(/--ignore-scripts/);
		},
	);

	it("reads a subcommand split off a Boolean's `=` word, as nopt does", () => {
		expect(denial("npm --save-dev=install left-pad")).toMatch(
			/--ignore-scripts/,
		);
	});

	it("shows a quoted span in the refusal as typed, never its mask", () => {
		const why = denial('npm i left-pad --tag "x y"') ?? "";
		expect(why).toContain(": npm i left-pad --tag ");
		expect(why).not.toContain("\x01");
	});

	it("reads the subcommand after npm's own `--`", () => {
		expect(denial("npm -- install left-pad")).toMatch(/--ignore-scripts/);
	});

	it("names every new package in the refusal, not just the first", () => {
		const why = denial("npm install left-pad ms js-yaml");
		expect(why).toContain("— left-pad ms  — and");
		// js-yaml is already a dependency, so it is not one of the additions.
		expect(why).toMatch(/adds 2 package\(s\)/);
	});

	it("counts and names an unvettable spec beside a new name", () => {
		expect(denial("npm install left-pad ./x")).toContain(
			"adds 2 package(s) this repo does not yet depend on — left-pad ./x — and",
		);
	});

	it.each([
		"npm install --ignore-scripts=false left-pad",
		"npm install --ignore-scripts --no-ignore-scripts left-pad",
		"npm install --ignore-scripts false left-pad",
		"npm install --no-ignore-scripts true left-pad",
		"npm install --no-ignore-scripts left-pad",
		"npm install --ignore-scripts --ignore-scripts false left-pad",
		"npm install --ignore-scripts --no-ignore-scripts true left-pad",
	])("does not accept `%s` as carrying the flag", (command) => {
		expect(denial(command)).toMatch(/--ignore-scripts/);
	});

	it("leaves an `--ignore-scripts` with a value npm does not read as Boolean as it was", () => {
		expect(allows("npm install --ignore-scripts --ignore-scripts=x")).toBe(
			true,
		);
		expect(
			denial("npm install --no-ignore-scripts=x left-pad", {
				created: "E404",
			}),
		).toMatch(/does not carry/);
	});

	it("runs before any registry call, so a malformed install costs nothing", () => {
		// The ordering is the guard's own: check 1 is local and certain, so a
		// command that is both malformed and hallucinated is refused offline.
		expect(callsOf("npm install wfc-nope", { created: "E404" })).toEqual([]);
	});

	it.each([
		"npm install --save-dev=left-pad",
		"npm install --no-save-dev=left-pad",
	])("reads the word in `%s` as a package, as npm does (#559)", (command) => {
		const why = denial(command);
		expect(why).toMatch(/does not carry `--ignore-scripts`/);
		expect(why).toContain("left-pad");
	});

	it("reads `--ignore-scripts=true` as the flag's value, not a package (#559)", () => {
		expect(allows("npm install --ignore-scripts=true left-pad")).toBe(true);
	});

	it("still denies where the flag sits behind a value-taking option, naming --ignore-scripts", () => {
		// `--omit dev` must not eat the package name; if it did, `left-pad` would
		// read as the value and the install would look like it added nothing.
		expect(denial("npm install --omit dev left-pad")).toMatch(
			/--ignore-scripts/,
		);
	});

	it("judges the first install of a compound command, and only it", () => {
		expect(denial("npm i left-pad && npx biome")).toMatch(/--ignore-scripts/);
		expect(denial("npx biome; npm install left-pad")).toMatch(/by bare name/);
	});

	it("names the segment, not the whole command, at the placeholder", () => {
		expect(denial("cd /tmp && npm i left-pad")).toContain(
			"`--ignore-scripts`: npm i left-pad\n",
		);
	});
});

describe("check 2 — new-package legitimacy", () => {
	const install = "npm install --ignore-scripts left-pad";

	it("allows a package that clears both thresholds", () => {
		expect(allows(install, { created: daysAgo(400), downloads: 50_000 })).toBe(
			true,
		);
	});

	it("denies a name the registry does not have, in full", () => {
		expect(denial(install, { created: "E404" })).toBe(
			`No package named \`left-pad\` exists on the npm registry: ${install}

That is the shape of a hallucinated name. Roughly one in five package references generated by a code model does not exist (Spracklen et al., USENIX Security 2025), and 43% of those names recur across re-runs — which is what makes pre-registering them worth an attacker's time. Check the name against the tool's own documentation before trying again.`,
		);
	});

	it("denies a package under the 180-day floor, in full", () => {
		expect(denial(install, { created: daysAgo(179) })).toBe(
			`\`left-pad\` was first published 179 days ago, under this guard's 180-day floor: ${install}

A squat registered against a hallucinated name is days old. A genuinely new package that this project needs is a founder decision, not a session's.

${ESCAPE}`,
		);
	});

	it("allows a package exactly on the floor and just past it", () => {
		expect(allows(install, { created: daysAgo(180) })).toBe(true);
		expect(allows(install, { created: daysAgo(181) })).toBe(true);
	});

	it("counts whole days, a part-day short of the floor still under it", () => {
		expect(
			denial(install, {
				created: new Date(NOW - 180 * 86_400_000 + 1000).toISOString(),
			}),
		).toMatch(/first published 179 days ago/);
	});

	it("counts days from the injected clock, not the wall clock", () => {
		expect(
			denial(
				install,
				{ created: daysAgo(0) },
				{ now: () => NOW + 10 * 86_400_000 },
			),
		).toMatch(/first published 10 days ago/);
	});

	it("denies a package under the 1,000-download floor, in full", () => {
		expect(denial(install, { downloads: 999 })).toBe(
			`\`left-pad\` was downloaded 999 time(s) last month, under this guard's floor of 1000: ${install}

A package worth installing has real download history. This has none, which is what a squatted name looks like from the outside.

${ESCAPE}`,
		);
	});

	it("allows a package exactly on the download floor", () => {
		expect(allows(install, { downloads: 1000 })).toBe(true);
	});

	it("reads a download count sent as a string", () => {
		expect(denial(install, { dlOut: '{"downloads":"12"}' })).toMatch(
			/downloaded 12 time\(s\)/,
		);
	});

	it.each([
		["npm", { created: "FAIL" }],
		["the downloads endpoint", { downloads: "FAIL" }],
		["npm's answer is not a date", { viewOut: '"not a date"' }],
		["npm's answer is not a string", { viewOut: "{}" }],
		["npm's answer is a number", { viewOut: "2020" }],
		["npm's answer is an empty string", { viewOut: '""' }],
		["npm's answer is not JSON", { viewOut: "nope" }],
		["the downloads body is not JSON", { dlOut: "nope" }],
		["the downloads body is null", { dlOut: "null" }],
		["the downloads body has no count", { dlOut: "{}" }],
		[
			"the downloads count is not a whole number",
			{ dlOut: '{"downloads":1.5}' },
		],
	])(
		"denies when %s, offering WFC_ALLOW_NEW_PACKAGE=1 as the way out",
		(_who, reg) => {
			// mantahostels#1767: the escape is a named env var, never silence.
			expect(denial(install, reg as Registry)).toBe(
				`The npm registry could not be reached to check \`left-pad\`, so this install proceeds on nothing: ${install}

An install whose name, age and download history went unchecked is what this guard exists to prevent, so an unreachable registry refuses rather than waving it through (mantahostels#1767).

${ESCAPE}`,
			);
		},
	);

	it("reads a failed call as unreachable whatever it printed", () => {
		expect(denial(install, { viewStatus: 2 })).toMatch(/could not be reached/);
		expect(denial(install, { dlStatus: 22 })).toMatch(/could not be reached/);
	});

	it("counts a date in the future as published 0 days ago, as bash's division truncates", () => {
		expect(
			denial(install, {
				created: new Date(NOW + 43_200_000).toISOString(),
			}),
		).toMatch(/first published 0 days ago/);
	});

	it("drops a fraction of a second from the date, as `date +%s` does", () => {
		expect(
			allows(install, {
				created: new Date(NOW - 180 * 86_400_000 + 500).toISOString(),
			}),
		).toBe(true);
	});

	it("reads a failed npm call carrying E404 as missing, not unreachable", () => {
		expect(denial(install, { created: "E404" })).toMatch(/^No package named/);
		expect(denial(install, { created: "FAIL" })).toMatch(
			/could not be reached/,
		);
	});

	it("never asks the downloads endpoint about a package too young to pass", () => {
		expect(callsOf(install, { created: daysAgo(3) })).toEqual([
			"npm view left-pad time.created --json",
		]);
	});

	it("asks npm, then the downloads endpoint, about each new package", () => {
		expect(callsOf("npm i --ignore-scripts left-pad ms")).toEqual([
			"npm view left-pad time.created --json",
			"downloads left-pad",
			"npm view ms time.created --json",
			"downloads ms",
		]);
	});

	it("refuses on the first package that fails, naming it", () => {
		expect(
			denial("npm i --ignore-scripts left-pad ms", { downloads: 5 }),
		).toMatch(/^`left-pad` was downloaded 5/);
	});

	it("checks a scoped package by its full name", () => {
		const why = denial("npm i --ignore-scripts @nope/thing", {
			created: "E404",
		});
		expect(why).toMatch(/No package named `@nope\/thing`/);
		expect(callsOf("npm i --ignore-scripts @nope/thing")).toContain(
			"npm view @nope/thing time.created --json",
		);
	});

	it.each([
		["left-pad@^1.3.0", "left-pad"],
		["left-pad@~4.17.0", "left-pad"],
		["left-pad@1.2.3", "left-pad"],
		["left-pad@latest", "left-pad"],
		["@nope/thing@next", "@nope/thing"],
	])("strips the range in `%s` before asking the registry", (spec, name) => {
		// `~` is npm's approximate-version range, not a home-relative path.
		expect(callsOf(`npm i --ignore-scripts ${spec}`)[0]).toBe(
			`npm view ${name} time.created --json`,
		);
	});

	it("names the package, not the argument of a value-taking config (#544)", () => {
		const reg = { created: "E404" };
		const cmd = "npm install --ignore-scripts --cafile ca.pem lodash";
		expect(denial(cmd, reg)).toMatch(/No package named `lodash`/);
		expect(callsOf(cmd, reg)).toEqual(["npm view lodash time.created --json"]);
	});

	it.each([
		// #544
		"--ca pem-text",
		"--proxy http://proxy:8080",
		"--https-proxy http://proxy:8080",
		"--globalconfig global.rc",
		"--fetch-retries 3",
		"--fetch-timeout 60000",
		"--lockfile-version 3",
		"--min-release-age 7",
		"--save-dev true",
		"--color always",
		"--yes null",
		"--no-browser firefox",
		// #559
		"--save-dev=true",
		"--color=always",
		"--yes=null",
		"--no-optional=false",
		// #563
		"--cafi ca.pem",
		"-cafile ca.pem",
		"-enjoy-by 2026-01-01",
		"-reg https://r.example",
		"-registry https://r.example",
		"-y null",
		"--ws null",
		"-n null",
		"--no null",
		"-C=dir",
		"--no-cidr 10.0.0.0/8",
		"--no-depth 7",
		"--no-depth 1e3",
		"--expect-results=null",
		"--tag -y null",
	])("reads `%s` as an option and its value (#544, #559, #563)", (option) => {
		const reg = { created: "E404" };
		const cmd = `npm install --ignore-scripts ${option} lodash`;
		expect(denial(cmd, reg)).toMatch(/No package named `lodash`/);
		expect(callsOf(cmd, reg)).toEqual(["npm view lodash time.created --json"]);
	});

	it("reads `--ignore-scripts=lodash` as the flag and a package (#559)", () => {
		expect(
			denial("npm install --ignore-scripts=lodash", { created: "E404" }),
		).toMatch(/No package named `lodash`/);
	});

	it.each(["-d", "--dd", "-sil"])(
		"reads `true` after the shorthand `%s` as a package",
		(shorthand) => {
			// Each is `--loglevel <level>` to npm, which then installs `true`.
			expect(
				callsOf(`npm install --ignore-scripts ${shorthand} true`, {
					created: "E404",
				}),
			).toEqual(["npm view true time.created --json"]);
		},
	);

	it("still requires --ignore-scripts where `true` follows `--dd`", () => {
		expect(denial("npm install --dd true")).toMatch(/--ignore-scripts/);
	});

	it.each([
		// A `no-` makes any config a Boolean, so the `=` word is a package.
		"npm install --no-cafile=evil",
		// `--help` is `--usage`, which a later `false` switches off again.
		"npm install --help false evil",
		"npm install -h false evil",
		// Each `no-` flips the flag, so three leave usage off.
		"npm install --usage --no-no-no-usage evil",
		// nopt takes `--` as `--browser`'s value and reads on.
		"npm install --browser -- --save-dev=evil",
	])("reads the package npm installs in `%s` (#563)", (command) => {
		expect(denial(command)).toMatch(/— evil +— and does not carry/);
	});

	it.each([
		"npm install --usage=false evil",
		"npm install --no-usage evil",
		"npm install --no-usage=true evil",
	])("reads usage switched off in `%s`, judging the install", (command) => {
		expect(denial(command)).toMatch(/— evil +— and does not carry/);
	});

	it.each([
		"npm install --usage=true evil",
		"npm install --no-usage=false evil",
		"npm install --usage --usage=x evil",
	])("reads usage left on in `%s`, judging nothing", (command) => {
		expect(allows(command)).toBe(true);
	});

	it.each([
		"--cafile ca.pem true",
		// `-5` is `--no-depth`'s value, not an option of its own.
		"--no-depth -5 true",
	])("reads `true` in `%s` as a package (#563)", (options) => {
		expect(
			denial(`npm install --ignore-scripts ${options}`, { created: "E404" }),
		).toMatch(/No package named `true`/);
	});

	it.each([
		"--ignore-scripts --no-no-no-ignore-scripts",
		// A String option refuses a word that looks like an option.
		"--ignore-scripts --tag --no-ignore-scripts",
	])("reads `%s` as npm does, leaving scripts on (#563)", (options) => {
		expect(denial(`npm install ${options} lodash`)).toMatch(
			/does not carry `--ignore-scripts`/,
		);
	});

	it.each(["--ign", "-ignore-scripts", "--ignore-scripts=true"])(
		"reads `%s` as --ignore-scripts (#563)",
		(spelling) => {
			expect(
				denial(`npm install ${spelling} lodash`, { created: "E404" }),
			).toMatch(/No package named `lodash`/);
		},
	);

	it("reads a glued run of one-letter shorthands, as `-DE` (#563)", () => {
		expect(
			denial("npm install --ignore-scripts -DE lodash", { created: "E404" }),
		).toMatch(/No package named `lodash`/);
	});

	it("asks the registry about a legacy uppercase name", () => {
		// npm has refused uppercase for NEW names since 2017; the legacy ones are
		// still installable, and calling one a path would be a false deny (H3).
		expect(
			denial("npm i --ignore-scripts JSONStream", { created: "E404" }),
		).toMatch(/No package named `JSONStream`/);
	});

	it("requires --ignore-scripts on an unvettable spec before judging it", () => {
		// Check 1 runs first on every addition, a tarball included — its preinstall
		// is exactly what the flag shuts (H2's ordering limb).
		expect(denial("npm install github:someone/thing")).toMatch(
			/--ignore-scripts/,
		);
	});

	it("denies an unvettable spec in full, naming the first", () => {
		const cmd = "npm i --ignore-scripts ./a ./b";
		expect(denial(cmd)).toBe(
			`This install names a spec the registry cannot be asked about, so its legitimacy is unverifiable: \`./a\`

${cmd}

A path, a tarball URL, a \`git:\`/\`github:\` spec and an \`npm:\` alias all bypass the checks this guard runs on a new package — that the name exists, its age, its download history. None of them can be answered for a spec that never touches the registry.

${ESCAPE}`,
		);
	});

	it("refuses an unvettable spec before asking about a new name beside it", () => {
		const cmd = "npm i --ignore-scripts left-pad ./a";
		expect(denial(cmd)).toMatch(/registry cannot be asked about/);
		expect(callsOf(cmd)).toEqual([]);
	});

	it.each([
		"npm install --ignore-scripts ./local-thing",
		"npm install --ignore-scripts file:../thing",
		"npm i --ignore-scripts github:someone/thing",
		"npm i --ignore-scripts https://example.com/thing.tgz",
		"npm i --ignore-scripts left-pad@npm:something-else",
		"npm i --ignore-scripts ~/thing",
		"npm i --ignore-scripts .hidden",
		"npm i --ignore-scripts some/path",
		"npm i --ignore-scripts @scope/bad!name",
		"npm i --ignore-scripts _under",
		// A scope with no name.
		"npm i --ignore-scripts @scope",
		'npm i --ignore-scripts "left-pad"',
	])("denies `%s` as unvettable", (command) => {
		expect(denial(command)).toMatch(/registry cannot be asked about/);
	});

	it("never reaches the network for a package already depended on", () => {
		expect(callsOf("npm install --ignore-scripts js-yaml")).toEqual([]);
	});
});

describe("the time budget", () => {
	const install = "npm i --ignore-scripts left-pad ms";

	/** A clock that steps `step` seconds on every read. */
	const stepping = (step: number) => {
		let t = NOW;
		return () => {
			const at = t;
			t += step * 1000;
			return at;
		};
	};

	it("refuses, in full, a package the budget ran out before", () => {
		// Reads: the deadline, left-pad's start, its age, then ms's start at
		// 30 s past the deadline's base.
		expect(denial(install, {}, { now: stepping(10) })).toBe(
			`This guard ran out of its own time budget before it could check \`ms\`, so nothing is known about it: ${install}

The budget is 30 s, under the hook's 60 s ceiling — a hook killed at that ceiling emits nothing at all, which reads as no objection. Install one package at a time and each gets checked.

${ESCAPE}`,
		);
	});

	it("asks about every package started inside the budget", () => {
		// ms starts at 27 s, inside the 30 s budget.
		expect(allows(install, {}, { now: stepping(9) })).toBe(true);
	});

	it("never asks the registry about a package past the budget", () => {
		expect(callsOf(install, {}, { now: stepping(10) })).toEqual([
			"npm view left-pad time.created --json",
			"downloads left-pad",
		]);
	});
});

describe("the escape", () => {
	const fake = "npm install --ignore-scripts wfc-nope-xyz";

	it("stands down the legitimacy check when set in the hook's environment", () => {
		expect(allows(fake, { created: "E404" }, { allow: true })).toBe(true);
		expect(callsOf(fake, { created: "E404" }, { allow: true })).toEqual([]);
	});

	it("is NOT spellable on the command line", () => {
		// mantahostels#109: an escape a session can spell for itself is not a
		// deny. The leading assignment reaches the core as text, and the shell's
		// own variable as `vars`, and neither is honoured.
		expect(
			denial(
				`WFC_ALLOW_NEW_PACKAGE=1 ${fake}`,
				{ created: "E404" },
				{ vars: { WFC_ALLOW_NEW_PACKAGE: "1" } },
			),
		).toMatch(/No package named/);
	});

	it("stands down the unvettable-spec deny too", () => {
		// The deny's own text names this escape.
		expect(
			allows(
				"npm i --ignore-scripts github:someone/thing",
				{},
				{ allow: true },
			),
		).toBe(true);
	});

	it("does not stand down the execution-window check", () => {
		expect(denial("npm install left-pad", {}, { allow: true })).toMatch(
			/--ignore-scripts/,
		);
	});

	it("does not stand down the bare-npx check", () => {
		expect(denial("npx biome ci .", {}, { allow: true })).toMatch(
			/by bare name/,
		);
	});
});

describe("check 3 — the bare npx name", () => {
	const bareBody = `npx tries \`node_modules/.bin\` first and the public registry second, and a throwaway worktree has no \`node_modules\` at all. What the registry holds under a bare name can be anyone's: in mantahostels#1538 the bare name \`biome\` fetched an unrelated package that accepts \`ci .\`, prints nothing and exits 0 — a check that went green having checked nothing. \`--no-install\` is not a defence: running the bare form once writes the impostor into \`~/.npm/_npx/\`, after which it resolves silently and offline.`;

	it("denies the repo's own worked incident, in full, offering the scoped package", () => {
		expect(denial("npx biome ci .")).toBe(
			`This runs \`biome\` by bare name, which resolves to two different things depending on whether \`node_modules\` happens to exist: npx biome ci .

${bareBody}

Spell it so it resolves to one thing:
  node_modules/.bin/biome …    in the canonical checkout
  npx @biomejs/biome …    \`@biomejs/biome\`, the dependency that carries it, in a worktree`,
		);
	});

	it("says it could not tell the owner where node_modules is absent and no dependency is `@<scope>/<bin>`, in full", () => {
		expect(denial("npx eslint .")).toBe(
			`This runs \`eslint\` by bare name, which resolves to two different things depending on whether \`node_modules\` happens to exist: npx eslint .

${bareBody}

This guard could not read every dependency's package.json in \`node_modules\` to find which carries \`eslint\`. Spell it so it resolves to one thing:
  node_modules/.bin/eslint …    in the canonical checkout
  npx -p <that dependency> eslint …    in a worktree`,
		);
	});

	// #1806: the owner is read from each dependency's installed `bin`.
	describe("with node_modules installed", () => {
		const nm = { manifests: INSTALLED };

		it.each([
			["npx tsc --noEmit", "npx -p typescript tsc …", "`typescript`"],
			["npx biome ci .", "npx @biomejs/biome …", "`@biomejs/biome`"],
			["npx js-yaml x", "", ""],
		])(
			"names the dependency carrying the bin in `%s`",
			(command, line, owner) => {
				const why = denial(command, {}, nm);
				if (!line) {
					expect(why).toBeNull();
					return;
				}
				expect(why).toContain(
					`  ${line}    ${owner}, the dependency that carries it, in a worktree`,
				);
			},
		);

		it("names a string `bin` by the package's unscoped name", () => {
			const manifests = {
				...INSTALLED,
				"js-yaml": JSON.stringify({ name: "@x/yamlish", bin: "b.js" }),
			};
			expect(denial("npx yamlish", {}, { manifests })).toContain(
				"  npx @x/yamlish …    `@x/yamlish`, the dependency that carries it",
			);
		});

		it("says no dependency carries an unknown bin, in full, printing no placeholder", () => {
			const why = denial("npx cowsay hi", {}, nm);
			expect(why).toMatch(
				/\n\nNo dependency of this repo carries a `cowsay` bin\. Install the package that provides it, then run `node_modules\/\.bin\/cowsay …`\.$/,
			);
			expect(why).not.toContain("@<scope>");
			expect(why).not.toContain("npx -p");
		});

		it("says none carries it where the carrying manifest names no package", () => {
			const manifests = {
				...INSTALLED,
				vitest: JSON.stringify({ bin: { cowsay: "c" } }),
			};
			expect(denial("npx cowsay hi", {}, { manifests })).toContain(
				"No dependency of this repo carries a `cowsay` bin",
			);
		});

		it.each([
			[
				"one dependency missing",
				(({ vitest: _v, ...rest }) => rest)(INSTALLED),
				false,
			],
			[
				"one package.json that will not parse",
				{ ...INSTALLED, js: "", "js-yaml": "{" },
				true,
			],
			[
				"one package.json that is no object",
				{ ...INSTALLED, "js-yaml": "[]" },
				true,
			],
			[
				"a string `bin` with no name",
				{ ...INSTALLED, "js-yaml": JSON.stringify({ bin: "x" }) },
				true,
			],
		])(
			"says it could not tell, not that none carries it, with %s",
			(_name, manifests, logged) => {
				const h = harness({}, { manifests });
				const d = decide("npx cowsay hi", h.ctx);
				expect(d?.deny).toContain(
					"could not read every dependency's package.json",
				);
				expect(d?.deny).not.toContain("No dependency of this repo carries");
				expect(h.logs).toEqual(
					logged
						? [
								"a dependency's package.json in node_modules did not parse — the owner of the cowsay bin is unread",
							]
						: [],
				);
			},
		);

		it("still names an owner found before a manifest that will not parse", () => {
			const manifests = { ...INSTALLED, vitest: "{" };
			expect(denial("npx tsc", {}, { manifests })).toContain(
				"npx -p typescript tsc …",
			);
		});

		it("falls back to a `@<scope>/<bin>` dependency where a manifest is unread", () => {
			const manifests = (({ "@biomejs/biome": _b, ...rest }) => rest)(
				INSTALLED,
			);
			expect(denial("npx biome", {}, { manifests })).toContain(
				"npx @biomejs/biome …    `@biomejs/biome`, the dependency",
			);
		});

		it("reads a manifest with no `bin` as carrying nothing, whatever its name", () => {
			const manifests = {
				...INSTALLED,
				vitest: JSON.stringify({ name: "cowsay" }),
			};
			expect(denial("npx cowsay", {}, { manifests })).toContain(
				"No dependency of this repo carries",
			);
		});

		it("reads a null manifest as carrying nothing", () => {
			const manifests = { ...INSTALLED, vitest: "null" };
			expect(denial("npx cowsay", {}, { manifests })).toContain(
				"No dependency of this repo carries",
			);
		});
	});

	it("names biome as the incident behind the rule, not as the bin refused", () => {
		expect(denial("npx tsc --noEmit")).toContain(
			"in mantahostels#1538 the bare name `biome` fetched an unrelated package",
		);
	});

	it.each(["npx eslint .", "npx tsc --noEmit", "npx next build"])(
		"denies `%s` as a tool called by bare name",
		(command) => {
			expect(denial(command)).toMatch(/by bare name/);
		},
	);

	it("allows a name that IS a dependency", () => {
		// The ticket's own scoping: unscoped AND not among package.json's
		// dependencies. `vitest` is both a dependency and its own bin name.
		expect(allows("npx vitest run")).toBe(true);
	});

	it("denies `tsc` as a bare name even though typescript is a dependency", () => {
		// Intended, per the guard's LIMITS: the PACKAGE name is what resolves,
		// and `tsc` is not one.
		expect(denial("npx tsc --noEmit")).toMatch(/by bare name/);
	});

	it("judges --package rather than the bin when one is given", () => {
		expect(allows("npx -p @biomejs/biome biome ci .")).toBe(true);
		expect(denial("npx --package biome biome ci .")).toMatch(/by bare name/);
	});

	it.each([
		["npx tsc -p tsconfig.json", "tsc"],
		["npx biome --package x ci .", "biome"],
		// Controls: these fail only if a value-taking option after the bin is
		// read as npx's.
		["npx tsc --project tsconfig.json", "tsc"],
		["npx eslint -c .eslintrc.json .", "eslint"],
	])("names the bin, not a value after it, in `%s`", (command, bin) => {
		// #491: npx's options end at the bin, so a `-p` after it is the bin's own
		// flag.
		const why = denial(command);
		expect(why).toContain(`\`${bin}\` by bare name`);
		expect(why).toContain(`node_modules/.bin/${bin}`);
	});

	it.each([
		["npx --loglevel silent biome ci .", "biome"],
		["npx -w app tsc", "tsc"],
		["npx --registry https://r.example biome ci .", "biome"],
	])(
		"names the bin, not an npx option's value before it, in `%s`",
		(command, bin) => {
			expect(denial(command)).toContain(`\`${bin}\` by bare name`);
		},
	);

	it.each([
		// #571: the option's value was read as the bin, and a URL or path passed.
		["npx --reg https://r.example biome ci .", "biome"],
		["npx -registry https://r.example biome ci .", "biome"],
		["npx --regis https://r.example biome ci .", "biome"],
		["npx --prefi ./app biome ci .", "biome"],
		["npx -L project biome ci .", "biome"],
		['npx --r"eg" https://r.example biome ci .', "biome"],
		['npx -"-reg" https://r.example biome ci .', "biome"],
		// npx drops a removed option together with its value.
		["npx -n ./x.js biome ci .", "biome"],
		["npx --npm ./x biome ci .", "biome"],
		// Controls, each value joined by `=` or after a spelling npx knows whole.
		["npx --reg=https://r.example biome ci .", "biome"],
		["npx -C ./app biome ci .", "biome"],
		["npx --node-arg ./x.js biome ci .", "biome"],
		["npx --node-arg=./x.js biome ci .", "biome"],
		// npx hands `--ignore-scr` the next word, and npm reads that word as the bin.
		["npx --ignore-scr biome ci .", "biome"],
		["npx -y biome ci .", "biome"],
		["npx --shell /bin/sh biome ci .", "biome"],
		["npx --shell=/bin/sh biome ci .", "biome"],
		["npx --ignore-existing biome ci .", "biome"],
		["npx -q biome ci .", "biome"],
		["npx --cache ./c biome", "biome"],
		["npx -c 'echo hi' biome", "biome"],
	])(
		"reads an abbreviated or shorthand npx option as npx does, in `%s`",
		(command, bin) => {
			expect(denial(command)).toContain(`\`${bin}\` by bare name`);
		},
	);

	it.each([
		// npm fetches the packages `true` and `false` for these.
		["npx -p true vitest run", "true"],
		["npx --package=false vitest", "false"],
		["npx --no-package true vitest", "false"],
		["npx --no-package=false vitest", "true"],
		["npx --no-package=evil vitest", "evil"],
		["npx -p", "true"],
		["npx --package", "true"],
	])("judges the package npm stores, in `%s`", (command, pkg) => {
		expect(denial(command)).toContain(`\`${pkg}\` by bare name`);
	});

	it.each([
		// #571: only the last `-p` was judged.
		"npx -p biome -p @biomejs/biome biome ci .",
		"npx -p @biomejs/biome -p biome biome ci .",
		"npx -p=biome biome ci .",
		// nopt hands `--no-package` its next word as a package.
		"npx --no-package biome @biomejs/biome ci .",
	])("judges every --package spelling, in `%s`", (command) => {
		expect(denial(command)).toContain("`biome` by bare name");
	});

	it.each([
		// npx matches a key whole, so `--no-audit` and the glued `-DE` are
		// not switches to it and take the next word, leaving `--package` npx's.
		// npm's own parser reads both as Booleans; using it here would allow these.
		"npx --no-audit @biomejs/biome --package biome ci .",
		"npx -DE @biomejs/biome --package biome ci .",
		// An unknown option takes a next word that is no option.
		"npx --zzz @biomejs/biome --package biome ci .",
		// npx hands `--browser` nothing, then nopt takes npx's `--` as its value
		// and reads on, so the `--package` is npx's.
		"npx --browser @biomejs/biome --package biome ci .",
	])(
		"reads an option's key as npx does, not as npm does, in `%s` (#1972)",
		(command) => {
			expect(denial(command)).toContain("`biome` by bare name");
		},
	);

	it.each([
		// A joined value takes no next word, and separate whole shorthands expand
		// to switches, so the bin comes first and the `--package` after it is the
		// bin's own.
		"npx --audit=false @biomejs/biome --package biome ci .",
		"npx -D -E @biomejs/biome --package biome ci .",
		"npx --audit @biomejs/biome --package biome ci .",
		// An unknown option takes a next word only where it is no option.
		"npx --zzz --audit=false @biomejs/biome --package biome ci .",
	])(
		"allows a scoped bin after an option that takes no next word, in `%s` (#1972)",
		(command) => {
			expect(allows(command)).toBe(true);
		},
	);

	it.each([
		"npx -p=@biomejs/biome biome ci .",
		"npx --reg https://r.example @biomejs/biome ci .",
		"npx -p '@biomejs/biome' biome ci .",
		'npx "@biomejs/biome" ci .',
	])(
		"allows a scoped package behind a shorthand or abbreviated option, in `%s`",
		(command) => {
			expect(allows(command)).toBe(true);
		},
	);

	it("reads --help after the bin as the bin's, not npx's (#491)", () => {
		expect(denial("npx biome --help")).toMatch(/`biome` by bare name/);
	});

	it("is not defeated by --no-install", () => {
		// docs/agents/guard-registry.md §Conventions: one `npx biome` writes the impostor into the npx
		// cache, after which `--no-install` resolves it silently and offline.
		expect(denial("npx --no-install biome ci .")).toMatch(/by bare name/);
	});

	it.each([
		"npx",
		"npx --help",
		"npx -h",
		// #571: npm reads both as `--usage`, and runs nothing.
		"npx --usa biome",
		"npx -? biome",
		// A lone `-` is no registry name.
		"npx -",
		"npx - biome",
		// After `--`, the first word is the bin.
		"npx -- @biomejs/biome",
		// A scoped name, a path, a dotted name and a URL-shaped spec are no
		// bare registry name.
		"npx @someone/else",
		"npx scripts/x.js",
		"npx .tool",
		"npx file:tool",
		// A joined value, and npx's own `--no-install`, take no next word, so
		// the scoped package is the bin and the `--package` after it its own.
		"npx --registry=https://r.example @biomejs/biome --package biome ci .",
		// A removed option npx hands its value drops it, the bin after it
		// npm's.
		"npx -p -n x biome",
		"npx --no-install @biomejs/biome --package biome ci .",
	])("allows `%s`", (command) => {
		expect(allows(command)).toBe(true);
	});

	it.each([
		"npx --usage=false biome",
		"npx --no-usage biome",
		"npx --usage --no-usage biome",
	])("judges the bin where usage is switched off, in `%s`", (command) => {
		expect(denial(command)).toMatch(/`biome` by bare name/);
	});

	it("drops the value joined to npx's `--no-install`", () => {
		expect(denial("npx --no-install=x biome")).toMatch(/^This runs `biome`/);
	});

	it("names the first package that is no dependency", () => {
		expect(denial("npx -p left-pad -p ms x")).toMatch(/^This runs `left-pad`/);
	});

	it("reads a bare npx inside a compound command", () => {
		expect(denial("cd /tmp && npx biome ci .")).toMatch(/by bare name/);
	});

	it("reads npx's first word after `--` as the bin", () => {
		expect(denial("npx -- biome")).toMatch(/`biome` by bare name/);
	});
});

describe("fail-open, where a verdict is impossible upstream of the registry", () => {
	it("allows and records when package.json cannot be read", () => {
		// Unreadable package.json would make every package look new, so the guard
		// would deny an ordinary reinstall. It allows instead, on the record.
		const h = harness({}, { pkg: null });
		expect(decide("npm install left-pad", h.ctx)).toBeNull();
		expect(h.logs).toEqual([
			"no readable package.json at /repo/package.json — install allowed unchecked",
		]);
	});

	it.each([
		["not JSON", "{ not json"],
		["an array", "[]"],
		["a string", '"x"'],
		["a dependency field that is no object", '{"dependencies":"x"}'],
		["a dependency field that is an array", '{"devDependencies":[]}'],
	])("allows and records when package.json is %s", (_l, text) => {
		const h = harness({}, { pkg: text });
		expect(decide("npm install left-pad", h.ctx)).toBeNull();
		expect(h.logs).toEqual([
			"package.json did not parse — install allowed unchecked",
		]);
	});

	it("judges nothing after the fault, a later bare npx included", () => {
		const h = harness({}, { pkg: null });
		expect(decide("npm i left-pad; npx biome", h.ctx)).toBeNull();
		expect(decide("npx biome", harness({}, { pkg: null }).ctx)).toBeNull();
	});

	it("reads package.json only once a verdict needs it", () => {
		const h = harness({}, { pkg: null });
		expect(
			decide("npm install; npx; npx @biomejs/biome; npm ci", h.ctx),
		).toBeNull();
		expect(h.logs).toEqual([]);
	});

	it.each([
		["null", "null"],
		["no dependency fields", "{}"],
		[
			"fields set to null or false",
			'{"dependencies":null,"devDependencies":false}',
		],
	])("reads a package.json with %s as depending on nothing", (_l, text) => {
		const h = harness({}, { pkg: text });
		expect(decide("npm i js-yaml", h.ctx)?.deny).toMatch(/— js-yaml {2}— and/);
		expect(h.logs).toEqual([]);
	});

	it("reads every dependency field", () => {
		const pkg = JSON.stringify({
			optionalDependencies: { a: "1" },
			peerDependencies: { b: "1" },
		});
		expect(allows("npm i a b", {}, { pkg })).toBe(true);
	});
});

describe("fail-closed, where the registry cannot be asked", () => {
	it.each([
		[
			"npm",
			{ created: "MISSING" },
			"npm not found — legitimacy of left-pad could not be checked, denying",
		],
		[
			"curl",
			{ downloads: "MISSING" as const },
			"curl not found — download history of left-pad could not be checked, denying",
		],
	])("DENIES and records when %s has gone missing", (_tool, reg, line) => {
		// The one deliberate departure from mantahostels#103 §6, on
		// mantahostels#1767's wording: an unchecked install is what this guard
		// exists to prevent, so a guard that cannot check refuses. It records the
		// fault as well, so the departure is visible rather than silent.
		const h = harness(reg);
		const d = decide("npm install --ignore-scripts left-pad", h.ctx);
		expect(d?.deny).toMatch(/could not be reached/);
		expect(d?.deny).toContain("WFC_ALLOW_NEW_PACKAGE=1");
		expect(h.logs).toEqual([line]);
	});

	it("reads a killed npm call, with no status, as unreachable", () => {
		expect(
			denial("npm i --ignore-scripts left-pad", {
				viewStatus: null,
				viewOut: "",
			}),
		).toMatch(/could not be reached/);
	});
});
