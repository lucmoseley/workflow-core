// @vitest-environment node
/*
 * guard-npm-install.sh vets a new dependency with a deny at the install
 * boundary (mantahostels#1803, ruled at mantahostels#1767).
 *
 * THREE CHECKS, tested in both directions each: the execution window
 * (`--ignore-scripts` on an install that adds a package), new-package
 * legitimacy (the name exists, clears 180 days, clears 1,000 downloads a
 * month), and the bare `npx` name.
 *
 * NOTHING HERE TOUCHES THE NETWORK. `npm` and `curl` are stubs injected at
 * WFC_NPM and WFC_CURL (§N7: they feed chosen output, #2266, #2422), driven by
 * two environment variables.
 *
 * The thresholds are constants in the guard, so each threshold case pins the
 * boundary from both sides — one day inside and one day outside — which is what
 * makes a silent change to either constant fail something.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`) and is the only vetting of a new dependency, so a
 * loosened case lets an unvetted install through.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog, failOpenLogPath } from "./guard-log-fixture";
import { describeSharedParserLibrary } from "./guard-parse-fixture";
import { buildBashPayload, spawnGuard } from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-npm-install.sh");

let dir: string;
let config: string;
let shared: string;
let elsewhere: string;

/** What the stub registry answers. `E404` and `FAIL` are the two failure modes. */
interface Registry {
	created?: string;
	downloads?: string;
}

const daysAgo = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString();

const initRepo = (at: string, pkg: Record<string, unknown>) => {
	fs.mkdirSync(at, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: at });
	fs.writeFileSync(path.join(at, "package.json"), JSON.stringify(pkg, null, 1));
};

/*
 * The stubs. `npm` answers `npm view <pkg> time.created --json` and `curl`
 * answers the downloads endpoint; both mimic the real tools' exit codes,
 * because the guard tells "no such package" from "registry unreachable" by
 * npm's E404 alone and there is no other signal to read. Both sit off PATH, so
 * a bare call that skips its var reaches the real tool and fails the test.
 */
const writeStubs = () => {
	fs.mkdirSync(path.dirname(npmStub()), { recursive: true });
	fs.writeFileSync(
		npmStub(),
		`#!/usr/bin/env bash
echo "npm $*" >> "$STUB_CALLS"
case "\${STUB_CREATED:-}" in
  E404) echo '{"error":{"code":"E404"}}'; exit 1 ;;
  FAIL) echo 'npm error network'; exit 1 ;;
  *) printf '"%s"\\n' "\${STUB_CREATED}" ;;
esac
`,
	);
	fs.writeFileSync(
		curlStub(),
		`#!/usr/bin/env bash
echo "curl $*" >> "$STUB_CALLS"
case "\${STUB_DOWNLOADS:-}" in
  FAIL) exit 22 ;;
  *) printf '{"downloads":%s}\\n' "\${STUB_DOWNLOADS}" ;;
esac
`,
	);
	fs.chmodSync(npmStub(), 0o755);
	fs.chmodSync(curlStub(), 0o755);
};

const npmStub = () => path.join(dir, "stubs", "npm");

const curlStub = () => path.join(dir, "stubs", "curl");

const calls = () => path.join(dir, "stub-calls.log");

const run = (
	command: string,
	reg: Registry = {},
	env: Record<string, string> = {},
	cwd = shared,
) =>
	spawnGuard(GUARD, buildBashPayload(command, "test"), {
		project: shared,
		config,
		cwd,
		env: {
			WFC_NPM: npmStub(),
			WFC_CURL: curlStub(),
			STUB_CALLS: calls(),
			STUB_CREATED: reg.created ?? daysAgo(4000),
			STUB_DOWNLOADS: reg.downloads ?? "9000000",
			WFC_ALLOW_NEW_PACKAGE: "",
			...env,
		},
		timeout: 20_000,
	});

/** The refusal's prose, or null where the guard allowed. */
const denial = (
	command: string,
	reg: Registry = {},
	env: Record<string, string> = {},
): string | null => {
	const r = run(command, reg, env);
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	expect(r.status).toBe(0);
	if (!(r.stdout ?? "").trim()) return null;
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	expect(out.hookEventName).toBe("PreToolUse");
	if (out.permissionDecision !== "deny") return null;
	return out.permissionDecisionReason as string;
};

const allows = (command: string, reg: Registry = {}, env = {}) =>
	denial(command, reg, env) === null;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-npm-"));
	config = path.join(dir, "config");
	shared = path.join(dir, "shared");
	elsewhere = path.join(dir, "elsewhere");
	initRepo(shared, {
		dependencies: { "js-yaml": "^4.1.0" },
		devDependencies: {
			vitest: "^3.0.0",
			typescript: "^5.0.0",
			"@biomejs/biome": "^2.0.0",
		},
	});
	initRepo(elsewhere, {});
	writeStubs();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
});

describe("check 1 — the execution window", () => {
	it("denies an install that adds a package without --ignore-scripts, naming the package", () => {
		const why = denial("npm install left-pad");
		expect(why).toMatch(/does not carry `--ignore-scripts`/);
		expect(why).toContain("left-pad");
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

	it("names every new package in the refusal, not just the first", () => {
		const why = denial("npm install left-pad ms js-yaml");
		expect(why).toContain("left-pad");
		expect(why).toContain("ms");
		// js-yaml is already a dependency, so it is not one of the additions.
		expect(why).toMatch(/adds 2 package\(s\)/);
	});

	it.each([
		"npm install --ignore-scripts=false left-pad",
		"npm install --ignore-scripts --no-ignore-scripts left-pad",
		"npm install --ignore-scripts false left-pad",
		"npm install --no-ignore-scripts true left-pad",
	])("does not accept `%s` as carrying the flag", (command) => {
		expect(denial(command)).toMatch(/--ignore-scripts/);
	});

	it("runs before any registry call, so a malformed install costs nothing", () => {
		// The ordering is the guard's own: check 1 is local and certain, so a
		// command that is both malformed and hallucinated is refused offline.
		denial("npm install wfc-nope", { created: "E404" });
		expect(fs.existsSync(calls())).toBe(false);
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
});

describe("check 2 — new-package legitimacy", () => {
	const install = "npm install --ignore-scripts left-pad";

	it("allows a package that clears both thresholds", () => {
		expect(allows(install, { created: daysAgo(400), downloads: "50000" })).toBe(
			true,
		);
	});

	it("denies a name the registry does not have", () => {
		expect(denial(install, { created: "E404" })).toMatch(
			/No package named `left-pad` exists/,
		);
	});

	it("denies a package under the 180-day floor", () => {
		expect(denial(install, { created: daysAgo(179) })).toMatch(/180-day floor/);
	});

	it("allows a package exactly on the far side of the 180-day floor", () => {
		expect(allows(install, { created: daysAgo(181) })).toBe(true);
	});

	it("denies a package under the 1,000-download floor, quoting its download count", () => {
		expect(denial(install, { downloads: "999" })).toMatch(
			/downloaded 999 time\(s\) last month/,
		);
	});

	it("allows a package exactly on the floor", () => {
		expect(allows(install, { downloads: "1000" })).toBe(true);
	});

	it.each([
		["npm", { created: "FAIL" }],
		["the downloads endpoint", { downloads: "FAIL" }],
	])(
		"denies when %s is unreachable, offering WFC_ALLOW_NEW_PACKAGE=1 as the way out",
		(_who, reg) => {
			const why = denial(install, reg as Registry);
			expect(why).toMatch(/could not be reached/);
			// mantahostels#1767: the escape is a named env var, never silence.
			expect(why).toContain("WFC_ALLOW_NEW_PACKAGE=1");
		},
	);

	it("checks a scoped package by its full name", () => {
		const why = denial("npm i --ignore-scripts @nope/thing", {
			created: "E404",
		});
		expect(why).toMatch(/No package named `@nope\/thing`/);
		expect(fs.readFileSync(calls(), "utf8")).toContain("@nope/thing");
	});

	it.each([
		"left-pad@^1.3.0",
		"left-pad@~4.17.0",
		"left-pad@1.2.3",
		"left-pad@latest",
	])("strips the range in `%s` before asking the registry", (spec) => {
		// `~` is npm's approximate-version range, not a home-relative path.
		denial(`npm i --ignore-scripts ${spec}`, { created: "E404" });
		expect(fs.readFileSync(calls(), "utf8")).toContain("npm view left-pad ");
	});

	it("names the package, not the argument of a value-taking config (#544)", () => {
		const why = denial("npm install --ignore-scripts --cafile ca.pem lodash", {
			created: "E404",
		});
		expect(why).toMatch(/No package named `lodash`/);
		expect(fs.readFileSync(calls(), "utf8")).not.toContain("ca.pem");
	});

	it.each([
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
	])("reads `%s` as an option and its value (#544)", (option) => {
		const why = denial(`npm install --ignore-scripts ${option} lodash`, {
			created: "E404",
		});
		expect(why).toMatch(/No package named `lodash`/);
		expect(fs.readFileSync(calls(), "utf8").trim()).toMatch(
			/^npm view lodash [^\n]*$/,
		);
	});

	it.each([
		"--save-dev=true",
		"--color=always",
		"--yes=null",
		"--no-optional=false",
	])("reads `%s` as an option and its value (#559)", (option) => {
		const why = denial(`npm install --ignore-scripts ${option} lodash`, {
			created: "E404",
		});
		expect(why).toMatch(/No package named `lodash`/);
		expect(fs.readFileSync(calls(), "utf8").trim()).toMatch(
			/^npm view lodash [^\n]*$/,
		);
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
			denial(`npm install --ignore-scripts ${shorthand} true`, {
				created: "E404",
			});
			expect(fs.readFileSync(calls(), "utf8")).toContain("npm view true ");
		},
	);

	it("still requires --ignore-scripts where `true` follows `--dd`", () => {
		expect(denial("npm install --dd true")).toMatch(/--ignore-scripts/);
	});

	it.each([
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
	])(
		"reads npm's spelling `%s` as an option and its value (#563)",
		(option) => {
			const why = denial(`npm install --ignore-scripts ${option} lodash`, {
				created: "E404",
			});
			expect(why).toMatch(/No package named `lodash`/);
			expect(fs.readFileSync(calls(), "utf8").trim()).toMatch(
				/^npm view lodash [^\n]*$/,
			);
		},
	);

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

	it.each([
		"npm install --ignore-scripts ./local-thing",
		"npm install --ignore-scripts file:../thing",
		"npm i --ignore-scripts github:someone/thing",
		"npm i --ignore-scripts https://example.com/thing.tgz",
		"npm i --ignore-scripts left-pad@npm:something-else",
	])("denies `%s` as unvettable", (command) => {
		expect(denial(command)).toMatch(/registry cannot be asked about/);
	});

	it("never reaches the network for a package already depended on", () => {
		allows("npm install --ignore-scripts js-yaml");
		expect(fs.existsSync(calls())).toBe(false);
	});
});

describe("the escape", () => {
	const fake = "npm install --ignore-scripts wfc-nope-xyz";

	it("stands down the legitimacy check when set in the hook's environment", () => {
		expect(
			allows(fake, { created: "E404" }, { WFC_ALLOW_NEW_PACKAGE: "1" }),
		).toBe(true);
	});

	it("is NOT spellable on the command line", () => {
		// mantahostels#109: an escape a session can spell for itself is not a deny. The leading
		// assignment reaches the guard as text and is never honoured.
		expect(
			denial(`WFC_ALLOW_NEW_PACKAGE=1 ${fake}`, { created: "E404" }),
		).toMatch(/No package named/);
	});

	it("stands down the unvettable-spec deny too", () => {
		// The deny's own text names this escape.
		expect(
			allows(
				"npm i --ignore-scripts github:someone/thing",
				{},
				{ WFC_ALLOW_NEW_PACKAGE: "1" },
			),
		).toBe(true);
	});

	it("does not stand down the execution-window check", () => {
		expect(
			denial("npm install left-pad", {}, { WFC_ALLOW_NEW_PACKAGE: "1" }),
		).toMatch(/--ignore-scripts/);
	});

	it("does not stand down the bare-npx check", () => {
		expect(
			denial("npx biome ci .", {}, { WFC_ALLOW_NEW_PACKAGE: "1" }),
		).toMatch(/by bare name/);
	});
});

describe("check 3 — the bare npx name", () => {
	it("denies the repo's own worked incident, naming biome by bare name and offering node_modules/.bin/biome instead", () => {
		const why = denial("npx biome ci .");
		expect(why).toMatch(/`biome` by bare name/);
		expect(why).toContain("node_modules/.bin/biome");
		expect(why).toContain("npx @biomejs/biome …");
	});

	it("says it could not tell the owner where node_modules is absent and no dependency is `@<scope>/<bin>`", () => {
		const why = denial("npx eslint .");
		expect(why).toContain("could not read every dependency's package.json");
		expect(why).toContain("npx -p <that dependency> eslint …");
		expect(why).not.toContain("@<scope>");
	});

	// #1806: the owner is read from each dependency's installed `bin`.
	describe("with node_modules installed", () => {
		const install = (name: string, bin: unknown) => {
			const at = path.join(shared, "node_modules", name);
			fs.mkdirSync(at, { recursive: true });
			fs.writeFileSync(
				path.join(at, "package.json"),
				JSON.stringify({ name, bin }),
			);
		};
		beforeEach(() => {
			install("typescript", { tsc: "bin/tsc", tsserver: "bin/tsserver" });
			install("@biomejs/biome", { biome: "bin/biome" });
			install("js-yaml", "bin/js-yaml.js");
			install("vitest", { vitest: "vitest.mjs" });
		});

		it.each([
			["npx tsc --noEmit", "npx -p typescript tsc …", "`typescript`"],
			["npx biome ci .", "npx @biomejs/biome …", "`@biomejs/biome`"],
		])(
			"names the dependency carrying the bin in `%s`",
			(command, line, owner) => {
				const why = denial(command);
				expect(why).toContain(line);
				expect(why).toContain(`${owner}, the dependency that carries it`);
			},
		);

		it("says no dependency carries an unknown bin, printing no placeholder", () => {
			const why = denial("npx cowsay hi");
			expect(why).toContain(
				"No dependency of this repo carries a `cowsay` bin",
			);
			expect(why).not.toContain("@<scope>");
			expect(why).not.toContain("npx -p");
		});

		it.each([
			[
				"one dependency missing",
				() =>
					fs.rmSync(path.join(shared, "node_modules", "vitest"), {
						recursive: true,
					}),
			],
			[
				"one package.json that will not parse",
				() =>
					fs.writeFileSync(
						path.join(shared, "node_modules", "vitest", "package.json"),
						"{",
					),
			],
		])(
			"says it could not tell, not that none carries it, with %s",
			(_name, damage) => {
				damage();
				const why = denial("npx cowsay hi");
				expect(why).toContain("could not read every dependency's package.json");
				expect(why).not.toContain("No dependency of this repo carries");
			},
		);
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
		// Controls, each value joined by `=` or after a spelling npx knows whole.
		["npx --reg=https://r.example biome ci .", "biome"],
		["npx -C ./app biome ci .", "biome"],
		["npx --node-arg ./x.js biome ci .", "biome"],
		// npx hands `--ignore-scr` the next word, and npm reads that word as the bin.
		["npx --ignore-scr biome ci .", "biome"],
		["npx -y biome ci .", "biome"],
		["npx --shell /bin/sh biome ci .", "biome"],
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
		["npx -p", "true"],
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
	])("allows `%s`", (command) => {
		expect(allows(command)).toBe(true);
	});

	it("reads a bare npx inside a compound command", () => {
		expect(denial("cd /tmp && npx biome ci .")).toMatch(/by bare name/);
	});
});

describe("fail-open, where a verdict is impossible upstream of the registry", () => {
	it("allows and records when package.json cannot be read", () => {
		// Unreadable package.json would make every package look new, so the guard
		// would deny an ordinary reinstall. It allows instead, on the record.
		fs.rmSync(path.join(shared, "package.json"));
		const r = run("npm install left-pad");
		expect(r.stdout ?? "").toBe("");
		expect(r.status).toBe(0);
		const log = fs.readFileSync(failOpenLogPath(config, shared), "utf8");
		expect(log).toMatch(/no readable package.json/);
	});

	it("allows and records when package.json is not JSON", () => {
		fs.writeFileSync(path.join(shared, "package.json"), "{ not json");
		const r = run("npm install left-pad");
		expect(r.stdout ?? "").toBe("");
		const log = fs.readFileSync(failOpenLogPath(config, shared), "utf8");
		expect(log).toMatch(/package.json did not parse/);
	});
});

describe("fail-closed, where the registry cannot be asked", () => {
	it.each([
		["npm", "WFC_NPM"],
		["curl", "WFC_CURL"],
	])("DENIES and records when %s has gone missing", (tool, envVar) => {
		// The one deliberate departure from mantahostels#103 §6, on mantahostels#1767's wording: an
		// unchecked install is what this guard exists to prevent, so a guard that
		// cannot check refuses. It records the fault as well, so the departure is
		// visible in check-guard-errors.js rather than silent.
		const r = run(
			"npm install --ignore-scripts left-pad",
			{},
			{ [envVar]: path.join(dir, `no-such-${tool}`) },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/could not be reached/);
		expect(r.stdout).toContain("WFC_ALLOW_NEW_PACKAGE=1");
		const log = fs.readFileSync(failOpenLogPath(config, shared), "utf8");
		expect(log).toMatch(new RegExp(`${tool} not found`));
	});
});

describeSharedParserLibrary({
	guard: GUARD,
	denyCommand: "npx biome ci .",
	ctx: () => ({ dir, shared, elsewhere }),
});

const payload = (command: string) => ({
	session_id: "test",
	tool_name: "Bash",
	tool_input: { command },
});

describeFailOpenLog({
	guard: GUARD,
	denied: payload("npx biome ci ."),
	fieldless: { session_id: "test", tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: payload("npm ci"),
	ctx: () => ({ dir, config, project: shared }),
});

/*
 * MUTATIONS RUN, each with failing cases (counts: #1823):
 *
 *   1. `((ignore)) ||` -> `((1)) ||`, check 1 always satisfied
 *   2. `MIN_AGE_DAYS=180` -> `0`
 *   3. `MIN_DOWNLOADS=1000` -> `0`
 *   4. the `*)` registry-verdict deny -> `return 0`, unreachable allowed
 *   5. the escape also read off `$segment`, mantahostels#109's command-line spelling
 *   6. `judge_npx` returns before its deny, check 3 turned off
 *   7. `_npx_preparse` puts no `--` before the bin (#491)
 *   8. `--cafile` dropped from NPM_VALUE_FLAGS (#544)
 *   9. `npm_arg` keeps a consumed `true`/`always`/`null` as a spec
 *  10. `--ignore-scripts false` leaves `ignore` set
 *  11. `npm_arg` reads `true` after any flag, not a Boolean config
 *  12. `_npx_preparse` expands no shorthand (#571)
 *  13. `_npx_preparse` keeps a removed option's value (#571)
 *  14. `judge_npx` skips `_npm_canon` (#571)
 *  15. `npx_arg` ignores `--no-package` (#571)
 *
 * NOT MUTATION-COVERED: the two network timeouts (`timeout 12`,
 * `--max-time 8`), which no test drives — the stubs answer instantly, so
 * shortening either changes nothing here.
 */
