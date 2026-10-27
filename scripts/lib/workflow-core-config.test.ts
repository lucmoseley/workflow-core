// @vitest-environment node
/*
 * Pins the adopter-config reader: every key's default and derivation, the
 * unknown-key warning and unknown-contract throw, the path helpers, and the
 * output and exit code of each verb a hook or skill calls (mantahostels#3516's
 * contract; #2).
 *
 * It runs in-process against a temp host root minted per test. `vi` only spies
 * on stderr, where the config's warnings land; nothing is mocked.
 * exitUnlessModule and the `module` verb are the two spawns: their skip line
 * is a writeFd to a real fd, and #418 was that line lost to a pipe, which no
 * in-process run reproduces.
 *
 * Breaking it lets a stale config be half-read, a `.husky/pre-commit` gate
 * that takes its command from the `command` verb skip or run the wrong one,
 * or a skill's `module`/`retro-count` gate misfire, in every adopter at once.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./run-in-process";

const {
	hostRoot,
	readConfig,
	KNOWN_KEYS,
	resolveKey,
	requireKey,
	moduleOn,
	readCommandFor,
	guardDisabled,
	ladderPath,
	cycleLogPath,
	brandSheetPath,
	userSettingsSnapshotPath,
	USER_SETTINGS_SNAPSHOT_DEFAULT,
	pickNextRankingPath,
	readOutputStylePath,
	UPSTREAM_TRACKER,
	UPSTREAM_CODE_REPO,
	codeRepoArgs,
	codeRepoUrl,
	isCodeApartFromTracker,
	retroFault,
	archScanFault,
	faultsOn,
} = require("./workflow-core-config.js");

/* The default paths each reader falls back to, spelled here rather than
 * imported. */
const LADDER_DEFAULT = "docs/capacity-procurement-ladder.md";
const CYCLE_LOG_DEFAULT = "docs/cycle-log.md";
const BRAND_SHEET_DEFAULT = "docs/brand-sheet.md";
const PICK_NEXT_RANKING_DEFAULT = ".claude/pick-next-ranking.md";
const OUTPUT_STYLE_DEFAULT = ".claude/output-styles/core-voice.md";

let dir: string;
const saved = {
	project: process.env.CLAUDE_PROJECT_DIR,
	gh: process.env.WFC_GH,
	modules: process.env.WFC_MODULES,
	pool: process.env.WFC_ALWAYS_LOADED,
	style: process.env.WFC_OUTPUT_STYLE,
};
const writeConfig = (root: string, text: string) => {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(root, ".claude", "workflow-core.json"), text);
};
const git = (...args: string[]) =>
	execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
const stubGh = (body: string) => {
	const gh = path.join(dir, "gh");
	fs.writeFileSync(gh, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	process.env.WFC_GH = gh;
};

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-config-")));
	delete process.env.WFC_MODULES;
	delete process.env.WFC_ALWAYS_LOADED;
	delete process.env.WFC_OUTPUT_STYLE;
});
afterEach(() => {
	for (const [k, env] of [
		["project", "CLAUDE_PROJECT_DIR"],
		["gh", "WFC_GH"],
		["modules", "WFC_MODULES"],
		["pool", "WFC_ALWAYS_LOADED"],
		["style", "WFC_OUTPUT_STYLE"],
	] as const) {
		if (saved[k] === undefined) delete process.env[env];
		else process.env[env] = saved[k];
	}
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("hostRoot", () => {
	it("is CLAUDE_PROJECT_DIR, symlinks dereferenced", () => {
		const link = path.join(os.tmpdir(), `wfc-config-link-${process.pid}`);
		fs.symlinkSync(dir, link);
		try {
			process.env.CLAUDE_PROJECT_DIR = link;
			expect(hostRoot()).toBe(dir);
		} finally {
			fs.unlinkSync(link);
		}
	});

	it("falls back to the git top level of the working directory", () => {
		delete process.env.CLAUDE_PROJECT_DIR;
		const sub = path.join(dir, "a", "b");
		fs.mkdirSync(sub, { recursive: true });
		execFileSync("git", ["init", "-q", dir]);
		expect(hostRoot(sub)).toBe(dir);
	});
});

describe("readConfig — defaults", () => {
	it("gives every key its default when the file is absent", () => {
		const c = readConfig({ root: dir });
		expect(c).toEqual({
			file: path.join(dir, ".claude", "workflow-core.json"),
			contract: 1,
			founder: undefined,
			tracker: undefined,
			codeRepo: undefined,
			login: undefined,
			name: undefined,
			corpus: undefined,
			commands: {
				test: null,
				lint: null,
				typecheck: null,
				check: null,
				check_staged: null,
				push_check: null,
				helper_check: null,
				full_test: null,
			},
			modules: [],
			categories: {},
			disabled: [],
			overrides: { skills: {}, output_style: null },
			capacityLadder: undefined,
			refillLoop: true,
			alwaysLoaded: undefined,
			warnings: [],
			faults: [],
		});
	});

	it("reads every declared key", () => {
		const declared = {
			contract: 1,
			founder: "F",
			tracker: "owner/repo",
			login: "owner",
			name: "Repo",
			corpus: ["owner/repo"],
			commands: { test: "node --test", lint: null },
			modules: ["roadmap", "suites"],
			categories: { tech: "Tech & Stack" },
			disabled: ["guard-branch.sh"],
			overrides: {
				skills: { "pick-next": "v1.2.0" },
				output_style: ".claude/output-styles/mine.md",
			},
			capacityLadder: false,
			capacityLadderPath: "docs/machinery/capacity-procurement-ladder.md",
			cycleLogPath: "docs/machinery/cycle-log.md",
			pickNextRankingPath: "docs/machinery/pick-next-ranking.md",
			manualRender: {
				command: "npm run gen:doc-pages",
				outputs: ["docs/pages/operating-manual.html"],
			},
			sessionMeanMb: 600,
			sessionSigmaMb: 320,
			suiteRunners: ["scripts/build-site.js"],
			alwaysLoaded: ["CLAUDE.md", ".claude/output-styles/mine.md"],
			retro: { weeklyCount: 3 },
			archScan: { threshold: 9000, exclude: ["data/**"] },
			sensitivePaths: [
				{
					name: "RLS",
					description: "who may read or write what",
					globs: ["supabase/migrations/**"],
					focus: "who can read or write what",
					examples: ["an RLS policy"],
					live: true,
				},
			],
		};
		writeConfig(dir, JSON.stringify(declared));
		expect(readConfig({ root: dir })).toMatchObject({
			...declared,
			commands: {
				test: "node --test",
				lint: null,
				typecheck: null,
				check: null,
				check_staged: null,
				push_check: null,
			},
			warnings: [],
		});
	});

	it("reads a wrongly typed value as its default, and warns, naming the key and the type it wanted", () => {
		writeConfig(
			dir,
			JSON.stringify({ login: 7, modules: "roadmap", disabled: [1] }),
		);
		const c = readConfig({ root: dir, quiet: true });
		expect([c.login, c.modules, c.disabled]).toEqual([undefined, [], []]);
		expect(c.warnings).toEqual([
			'"modules" is not an array — read as its default',
			'"login" is not a string — read as its default',
			'"disabled" is not an array of strings — read as its default',
		]);
	});

	it("reads a sessionMeanMb that is not a positive integer as its default, and warns (#2139)", () => {
		for (const bad of [0, -545, 545.5, "545"]) {
			writeConfig(dir, JSON.stringify({ sessionMeanMb: bad }));
			const c = readConfig({ root: dir, quiet: true });
			expect(c.sessionMeanMb).toBeUndefined();
			expect(c.warnings).toEqual([
				'"sessionMeanMb" is not a positive integer — read as its default',
			]);
		}
	});

	it("reads a retro.weeklyCount that is not a positive integer as unset, and warns (#964)", () => {
		for (const bad of [0, -2, 2.5, "2", null]) {
			writeConfig(dir, JSON.stringify({ retro: { weeklyCount: bad } }));
			const c = readConfig({ root: dir, quiet: true });
			expect(c.retro).toEqual({});
			expect(c.warnings).toEqual([
				'"retro.weeklyCount" is not a positive integer — read as its default',
			]);
		}
	});

	it("reads a retro that is not an object as its default, and warns (#964)", () => {
		writeConfig(dir, JSON.stringify({ retro: 2 }));
		const c = readConfig({ root: dir, quiet: true });
		expect([c.retro, c.warnings]).toEqual([
			undefined,
			['"retro" is not an object — read as its default'],
		]);
	});

	it("warns on an unknown key inside retro, naming it and dropping it (#964)", () => {
		writeConfig(dir, JSON.stringify({ retro: { weeklyCnt: 2 } }));
		expect(readConfig({ root: dir, quiet: true })).toMatchObject({
			retro: {},
			warnings: ['unknown key "retro.weeklyCnt"'],
		});
	});

	it.each([
		["threshold", 0, "a positive integer"],
		["threshold", 8750.5, "a positive integer"],
		["threshold", "8750", "a positive integer"],
		["exclude", "data/**", "an array of non-empty strings"],
		["exclude", ["data/**", ""], "an array of non-empty strings"],
		["exclude", [7], "an array of non-empty strings"],
	])(
		"reads an archScan.%s of %j as unset, and warns that it is not %s (#1362)",
		(key, bad, want) => {
			writeConfig(dir, JSON.stringify({ archScan: { [key]: bad } }));
			const c = readConfig({ root: dir, quiet: true });
			expect([c.archScan, c.warnings]).toEqual([
				{},
				[`"archScan.${key}" is not ${want} — read as its default`],
			]);
		},
	);

	it("reads an archScan that is not an object as its default, and warns (#1362)", () => {
		writeConfig(dir, JSON.stringify({ archScan: ["data/**"] }));
		const c = readConfig({ root: dir, quiet: true });
		expect([c.archScan, c.warnings]).toEqual([
			undefined,
			['"archScan" is not an object — read as its default'],
		]);
	});

	it("warns on an unknown key inside archScan, naming it and keeping the keys it knows (#1362)", () => {
		writeConfig(
			dir,
			JSON.stringify({ archScan: { threshold: 9000, treshold: 1 } }),
		);
		expect(readConfig({ root: dir, quiet: true })).toMatchObject({
			archScan: { threshold: 9000 },
			warnings: ['unknown key "archScan.treshold"'],
		});
	});

	it.each([
		[
			[{ description: "d" }],
			'"sensitivePaths[0]" has no "name" string — entry dropped, so nothing matches it',
		],
		[
			["RLS"],
			'"sensitivePaths[0]" has no "name" string — entry dropped, so nothing matches it',
		],
		[
			[{ name: "a" }],
			'"sensitivePaths[0].description" is not a non-empty string — read as its default',
		],
		[
			[
				{ name: "a", description: "d" },
				{ name: "a", description: "e" },
			],
			'"sensitivePaths[1].name" repeats "a"',
		],
		[
			[{ name: "a", description: "d", globs: ["x/**", 7] }],
			'"sensitivePaths[0].globs[1]" is not a non-empty string — glob dropped',
		],
		[
			[{ name: "a", description: "d", globs: "x/**" }],
			'"sensitivePaths[0].globs" is not an array — read as its default',
		],
		[
			[{ name: "a", description: "d", live: "true" }],
			'"sensitivePaths[0].live" is not a boolean — read as its default',
		],
		[
			[{ name: "a", description: "d", focus: 3 }],
			'"sensitivePaths[0].focus" is not a non-empty string — read as its default',
		],
		[
			[{ name: "a", description: "d", examples: [1] }],
			'"sensitivePaths[0].examples" is not an array of strings — read as its default',
		],
		[
			[{ name: "a", description: "d", glob: [] }],
			'unknown key "sensitivePaths[0].glob"',
		],
		[{ name: "a" }, '"sensitivePaths" is not an array — read as its default'],
	])(
		"warns, never throws, on a sensitivePaths of %j (#1617)",
		(bad, warning) => {
			writeConfig(dir, JSON.stringify({ sensitivePaths: bad }));
			expect(readConfig({ root: dir, quiet: true }).warnings).toEqual([
				warning,
			]);
		},
	);

	it.each([
		[undefined],
		[[]],
		[[{ name: "a", description: "d" }]],
		[[{ name: "a", description: "d", globs: [] }]],
	])(
		"warns that the mutation hold never fires, with mutation on and a sensitivePaths of %j (#1911)",
		(declared) => {
			writeConfig(
				dir,
				JSON.stringify({ modules: ["mutation"], sensitivePaths: declared }),
			);
			expect(readConfig({ root: dir, quiet: true }).warnings).toEqual([
				'module "mutation" is on but no "sensitivePaths" entry has a glob, so the mutation hold never fires',
			]);
		},
	);

	it.each([
		[
			{
				modules: ["mutation"],
				sensitivePaths: [{ name: "a", description: "d", globs: ["x/**"] }],
			},
		],
		[{ modules: [], sensitivePaths: [] }],
	])(
		"does not warn of a mutation hold that can fire, or is off: %j (#1911)",
		(raw) => {
			writeConfig(dir, JSON.stringify(raw));
			expect(readConfig({ root: dir, quiet: true }).warnings).toEqual([]);
		},
	);

	it("keeps a malformed sensitivePaths entry it can name, each fault read as its default (#1617)", () => {
		writeConfig(
			dir,
			JSON.stringify({
				sensitivePaths: [
					{ name: "a", globs: ["x/**", ""], live: "yes", examples: "e" },
				],
			}),
		);
		expect(readConfig({ root: dir, quiet: true }).sensitivePaths).toEqual([
			{
				name: "a",
				description: "",
				globs: ["x/**"],
				focus: "access control and money logic",
				examples: [],
				live: false,
			},
		]);
	});

	it("reads workflow-core's own sensitivePaths clean (#1617)", () => {
		const c = readConfig({
			root: path.join(__dirname, "..", ".."),
			quiet: true,
		});
		expect(
			c.warnings.filter((w: string) => w.includes("sensitivePaths")),
		).toEqual([]);
		expect(c.sensitivePaths).toEqual([
			{
				name: "secret handling",
				description: expect.any(String),
				globs: ["scripts/write-secret.js", "scripts/lib/token-shapes.js"],
				focus:
					"what secret slips past the scan or gets written where git keeps it",
				examples: [],
				live: false,
			},
		]);
	});

	it("reads an alwaysLoaded path that leaves the repo as its default, and warns", () => {
		for (const bad of [
			["/etc/passwd"],
			["../x.md"],
			["docs/../../x.md"],
			[""],
		]) {
			writeConfig(dir, JSON.stringify({ alwaysLoaded: bad }));
			const c = readConfig({ root: dir, quiet: true });
			expect(c.alwaysLoaded).toBeUndefined();
			expect(c.warnings).toEqual([
				'"alwaysLoaded" is not an array of repo-relative paths — read as its default',
			]);
		}
	});

	it("reads a capacityLadderPath that is not repo-relative as its default, and warns (#401)", () => {
		for (const bad of ["/etc/ladder.md", "../ladder.md", "", 7]) {
			writeConfig(dir, JSON.stringify({ capacityLadderPath: bad }));
			const c = readConfig({ root: dir, quiet: true });
			expect(c.capacityLadderPath).toBeUndefined();
			expect(c.warnings).toEqual([
				'"capacityLadderPath" is not a repo-relative path — read as its default',
			]);
		}
	});

	it("reads a name-form output_style as its default, and warns (#69)", () => {
		writeConfig(dir, JSON.stringify({ overrides: { output_style: "mine" } }));
		const c = readConfig({ root: dir, quiet: true });
		expect(c.overrides.output_style).toBeNull();
		expect(c.warnings).toEqual([
			'"overrides.output_style" is not a repo-relative path — read as its default',
		]);
	});

	it("reads WFC_ALWAYS_LOADED in place of the declared pool", () => {
		writeConfig(dir, JSON.stringify({ alwaysLoaded: ["CLAUDE.md"] }));
		process.env.WFC_ALWAYS_LOADED = "AGENTS.md,STYLE.md";
		expect(readConfig({ root: dir }).alwaysLoaded).toEqual([
			"AGENTS.md",
			"STYLE.md",
		]);
	});

	it("reads WFC_OUTPUT_STYLE in place of the declared output_style", () => {
		writeConfig(
			dir,
			JSON.stringify({
				overrides: { output_style: ".claude/output-styles/mine.md" },
			}),
		);
		process.env.WFC_OUTPUT_STYLE = "STYLE.md";
		expect(readConfig({ root: dir }).overrides.output_style).toBe("STYLE.md");
	});

	it("reads WFC_OUTPUT_STYLE='' as a declared-null override, not unset", () => {
		writeConfig(
			dir,
			JSON.stringify({
				overrides: { output_style: ".claude/output-styles/mine.md" },
			}),
		);
		process.env.WFC_OUTPUT_STYLE = "";
		expect(readConfig({ root: dir }).overrides.output_style).toBeNull();
	});

	it("refuses a file that does not parse, naming it", () => {
		writeConfig(dir, "{ nope");
		expect(() => readConfig({ root: dir })).toThrow(
			/workflow-core\.json does not parse/,
		);
	});
});

describe("readConfig — unknown keys", () => {
	it("warns on an unknown key, a misspelt command and an unknown module, naming each", () => {
		writeConfig(
			dir,
			JSON.stringify({
				foundr: "F",
				commands: { tests: "x" },
				modules: ["roadmaps"],
			}),
		);
		const c = readConfig({ root: dir, quiet: true });
		expect(c.warnings).toEqual([
			'unknown key "foundr"',
			'unknown key "commands.tests"',
			'unknown module "roadmaps"',
		]);
		expect(c.modules).toEqual([]);
	});

	it("raises none on the liveness mod's off switch (#944)", () => {
		writeConfig(dir, JSON.stringify({ mods: { "wfc-liveness": false } }));
		expect(readConfig({ root: dir, quiet: true }).warnings).toEqual([]);
	});

	it.each([
		[
			{ "wfc-liveness": "false" },
			'"mods.wfc-liveness" is not a boolean — read as its default',
		],
		[{ "wfc-livenes": false }, 'unknown key "mods.wfc-livenes"'],
		[["wfc-liveness"], '"mods" is not an object — read as its default'],
		[false, '"mods" is not an object — read as its default'],
	])(
		"warns on mods %j, naming the key, failing open (#944)",
		(mods, warning) => {
			writeConfig(dir, JSON.stringify({ founder: "f", mods }));
			const c = readConfig({ root: dir, quiet: true });
			expect(c.warnings).toEqual([warning]);
			expect(c.founder).toBe("f");
		},
	);

	it("prints each warning on stderr once per process", () => {
		writeConfig(dir, JSON.stringify({ typo: 1 }));
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		readConfig({ root: dir });
		readConfig({ root: dir });
		expect(write).toHaveBeenCalledTimes(1);
		expect(String(write.mock.calls[0][0])).toContain('unknown key "typo"');
	});
});

describe("readConfig — type warnings reach stderr (#1530)", () => {
	it("prints a mistyped founder and disabled once each, and nothing on a quiet read", () => {
		writeConfig(dir, JSON.stringify({ founder: 42, disabled: "x" }));
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		readConfig({ root: dir, quiet: true });
		expect(write).not.toHaveBeenCalled();
		readConfig({ root: dir });
		readConfig({ root: dir });
		const file = path.join(dir, ".claude", "workflow-core.json");
		expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
			`WARN ${file}: "founder" is not a string — read as its default\n`,
			`WARN ${file}: "disabled" is not an array of strings — read as its default\n`,
		]);
	});
});

describe("readConfig — the known-key list (#1534)", () => {
	it("lists exactly the keys readConfig returns, plus those read elsewhere", () => {
		const returned = Object.keys(readConfig({ root: dir, quiet: true }));
		const readElsewhere = ["mods", "stepsOwed", "walkedTo"];
		/* KNOWN_KEYS itself, not the unknown-key warning: the warning shows a
		 * returned key is listed, never that a listed key is still read. */
		expect(new Set(KNOWN_KEYS).size).toBe(KNOWN_KEYS.length);
		expect([...KNOWN_KEYS].sort()).toEqual(
			[
				...returned.filter((k) => !["file", "warnings", "faults"].includes(k)),
				...readElsewhere,
			].sort(),
		);
	});
});

describe("readConfig — each simple key's valid, malformed and absent value (#1534)", () => {
	const arrayOfStrings = "an array of strings";
	const repoRelativePath = "a repo-relative path";
	type Row = [
		key: string,
		valid: unknown,
		malformed: unknown,
		want: string,
		fallback: unknown,
	];
	const pathRow = (key: string): Row => [
		key,
		"docs/x.md",
		"/etc/x.md",
		repoRelativePath,
		undefined,
	];
	const rows: Row[] = [
		["founder", "F", 42, "a string", undefined],
		["tracker", "owner/repo", 1, "a string", undefined],
		["codeRepo", "owner/code", 1, "a string", undefined],
		["login", "owner", 2, "a string", undefined],
		["name", "Repo", 3, "a string", undefined],
		["deploy", "vercel", "netlify", "one of vercel", undefined],
		["categories", { tech: "Tech" }, { tech: 1 }, "an object of strings", {}],
		["disabled", ["guard-branch.sh"], "guard-branch.sh", arrayOfStrings, []],
		["capacityLadder", true, "true", "a boolean", undefined],
		["admissionGate", true, "true", "a boolean", undefined],
		["refillLoop", false, "false", "a boolean", true],
		pathRow("capacityLadderPath"),
		pathRow("cycleLogPath"),
		pathRow("brandSheetPath"),
		pathRow("userSettingsSnapshotPath"),
		pathRow("pickNextRankingPath"),
		["roadmapMajorPin", 5, "5", "a number", undefined],
		["ruffExclude", ["data/**"], [7], arrayOfStrings, undefined],
		["sessionMeanMb", 600, 0, "a positive integer", undefined],
		["sessionSigmaMb", 320, 320.5, "a positive integer", undefined],
		["fullTestShards", 2, 0, "a positive integer", undefined],
		["suiteRunners", ["a.sh"], "a.sh", arrayOfStrings, undefined],
		[
			"worktreeLinks",
			[".env", "build/gen"],
			["../outside"],
			"an array of repo-relative paths",
			undefined,
		],
	];
	it.each(
		rows.map(([key, valid, malformed, want, fallback]) => ({
			key,
			valid,
			malformed,
			want,
			fallback,
		})),
	)(
		"$key: reads $valid back, reads $malformed as its default with a printed warning that it is not $want, and an absent one silently as $fallback",
		({ key, valid, malformed, want, fallback }) => {
			writeConfig(dir, JSON.stringify({ [key]: valid }));
			const good = readConfig({ root: dir, quiet: true });
			expect([good[key], good.warnings]).toEqual([valid, []]);

			writeConfig(dir, JSON.stringify({ [key]: malformed }));
			const write = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			const bad = readConfig({ root: dir });
			const printed = write.mock.calls.map((c) => String(c[0]));
			const warning = `"${key}" is not ${want} — read as its default`;
			expect([bad[key], bad.warnings]).toEqual([fallback, [warning]]);
			expect(printed).toEqual([`WARN ${bad.file}: ${warning}\n`]);

			writeConfig(dir, "{}");
			const absent = readConfig({ root: dir, quiet: true });
			expect([absent[key], absent.warnings]).toEqual([fallback, []]);
		},
	);
});

describe("readConfig — contract", () => {
	it("takes contract 1 when the key is missing", () => {
		writeConfig(dir, "{}");
		expect(readConfig({ root: dir }).contract).toBe(1);
	});

	it.each([
		[2, "2"],
		[0, "0"],
		["1", '"1"'],
	])("refuses contract %j, naming the migration note", (contract, shown) => {
		writeConfig(dir, JSON.stringify({ contract }));
		expect(() => readConfig({ root: dir })).toThrow(
			`declares contract ${shown}, which this workflow-core does not read (it reads 1). Read the migration note in migrations/`,
		);
	});
});

describe("readConfig at a revision (#3132)", () => {
	const commit = () => {
		git("init", "-q");
		git("add", ".");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c");
	};

	it("reads the committed config, not the working copy's", () => {
		writeConfig(dir, JSON.stringify({ modules: ["landing"] }));
		commit();
		writeConfig(dir, JSON.stringify({ modules: [] }));
		expect(moduleOn("landing", { root: dir, rev: "HEAD" })).toBe(true);
		expect(moduleOn("landing", { root: dir })).toBe(false);
	});

	it("gives every key its default where the revision holds no config", () => {
		fs.writeFileSync(path.join(dir, "f"), "");
		commit();
		writeConfig(dir, JSON.stringify({ modules: ["landing"] }));
		expect(readConfig({ root: dir, rev: "HEAD" }).modules).toEqual([]);
	});

	it("runs the committed config through the same validation, naming the revision", () => {
		writeConfig(dir, JSON.stringify({ contract: 2 }));
		commit();
		writeConfig(dir, "{}");
		expect(() => readConfig({ root: dir, rev: "HEAD" })).toThrow(
			`${path.join(dir, ".claude", "workflow-core.json")} at HEAD declares contract 2`,
		);
	});

	it("throws where the committed config does not parse", () => {
		writeConfig(dir, "[]");
		commit();
		expect(() => readConfig({ root: dir, rev: "HEAD" })).toThrow(
			"at HEAD does not parse: not a JSON object",
		);
	});

	it("throws where the revision holds a directory at the config's path", () => {
		fs.mkdirSync(path.join(dir, ".claude", "workflow-core.json"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(dir, ".claude", "workflow-core.json", "x"), "");
		commit();
		expect(() => readConfig({ root: dir, rev: "HEAD" })).toThrow(
			"at HEAD is not a file",
		);
	});

	it("throws where the revision names no commit, an unborn HEAD included", () => {
		git("init", "-q");
		expect(() => readConfig({ root: dir, rev: "HEAD" })).toThrow(
			"at HEAD cannot be read",
		);
	});
});

describe("resolveKey — derivation", () => {
	it("prefers a declared tracker to the remote", () => {
		git("init", "-q");
		git("remote", "add", "origin", "git@github.com:other/remote.git");
		writeConfig(dir, JSON.stringify({ tracker: "owner/repo" }));
		expect(resolveKey("tracker", { root: dir })).toBe("owner/repo");
	});

	it("derives tracker from the origin remote at the host root", () => {
		git("init", "-q");
		git("remote", "add", "origin", "git@github.com:owner/remote.git");
		expect(resolveKey("tracker", { root: dir })).toBe("owner/remote");
	});

	it("derives no tracker where the remote is not GitHub", () => {
		git("init", "-q");
		git("remote", "add", "origin", "https://gitlab.com/owner/remote.git");
		expect(resolveKey("tracker", { root: dir })).toBeUndefined();
	});

	it("prefers a declared codeRepo to the tracker (#1957)", () => {
		writeConfig(
			dir,
			JSON.stringify({ tracker: "owner/tracker", codeRepo: "owner/code" }),
		);
		expect(resolveKey("codeRepo", { root: dir })).toBe("owner/code");
		expect(resolveKey("tracker", { root: dir })).toBe("owner/tracker");
	});

	it("derives codeRepo from the origin remote before the tracker", () => {
		writeConfig(dir, JSON.stringify({ tracker: "owner/tracker" }));
		expect(resolveKey("codeRepo", { root: dir })).toBe("owner/tracker");
		git("init", "-q");
		git("remote", "add", "origin", "git@github.com:owner/remote.git");
		expect(resolveKey("codeRepo", { root: dir })).toBe("owner/remote");
	});

	it("builds the clone URL from codeRepo, never the tracker", () => {
		writeConfig(
			dir,
			JSON.stringify({ tracker: "owner/tracker", codeRepo: "owner/code" }),
		);
		expect(codeRepoUrl({ root: dir })).toBe(
			"https://github.com/owner/code.git",
		);
	});

	it("builds the core's clone URL where no repo resolves", () => {
		expect(codeRepoUrl({ root: dir })).toBe(
			`https://github.com/${UPSTREAM_CODE_REPO}.git`,
		);
	});

	it("points gh's run calls at codeRepo, never the tracker (#1963)", () => {
		writeConfig(
			dir,
			JSON.stringify({ tracker: "owner/tracker", codeRepo: "owner/code" }),
		);
		expect(codeRepoArgs({ root: dir })).toEqual(["--repo", "owner/code"]);
	});

	it("leaves gh its default repo where no codeRepo resolves", () => {
		expect(codeRepoArgs({ root: dir })).toEqual([]);
	});

	it("calls the code apart from its tracker only where the two repos differ", () => {
		writeConfig(dir, JSON.stringify({ tracker: "owner/tracker" }));
		expect(isCodeApartFromTracker({ root: dir })).toBe(false);
		writeConfig(
			dir,
			JSON.stringify({ tracker: "owner/tracker", codeRepo: "owner/code" }),
		);
		expect(isCodeApartFromTracker({ root: dir })).toBe(true);
	});

	it("derives login from the authenticated gh user", () => {
		stubGh('[ "$1 $2" = "api user" ] && echo octocat');
		expect(resolveKey("login", { root: dir })).toBe("octocat");
	});

	it("derives no login where gh fails", () => {
		stubGh("exit 1");
		expect(resolveKey("login", { root: dir })).toBeUndefined();
	});

	it("derives corpus as the own tracker plus the upstream tracker", () => {
		writeConfig(dir, JSON.stringify({ tracker: "owner/repo" }));
		expect(resolveKey("corpus", { root: dir })).toEqual([
			"owner/repo",
			UPSTREAM_TRACKER,
		]);
	});

	it("reads a corpus entry that is not owner/name as the default", () => {
		writeConfig(
			dir,
			JSON.stringify({ tracker: "owner/repo", corpus: ["a/b\nc/d"] }),
		);
		expect(readConfig({ root: dir, quiet: true }).warnings).toEqual([
			'"corpus" is not an array of owner/name trackers — read as its default',
		]);
		expect(resolveKey("corpus", { root: dir })).toEqual([
			"owner/repo",
			UPSTREAM_TRACKER,
		]);
	});

	it("leaves an own tracker that is not owner/name out of the derived corpus", () => {
		writeConfig(dir, JSON.stringify({ tracker: "a/b\nc/d" }));
		expect(resolveKey("corpus", { root: dir })).toEqual([UPSTREAM_TRACKER]);
	});

	it("derives name from the host root's directory name", () => {
		expect(resolveKey("name", { root: dir })).toBe(path.basename(dir));
	});

	it.each([
		["https://github.com/o/r.git", "o/r"],
		["https://github.com/o/r", "o/r"],
		["https://token@github.com/o/r.git", "o/r"],
		["git@github.com:o/r.git", "o/r"],
		["ssh://git@github.com/o/r.git", "o/r"],
		["git@gitlab.com:o/r.git", undefined],
	])("derives the tracker from an origin remote at %s", (url, want) => {
		git("init", "-q");
		git("remote", "add", "origin", url);
		expect(resolveKey("tracker", { root: dir })).toBe(want);
	});
});

describe("the `corpus` verb, the recurrence hook's tracker list (#512)", () => {
	const run = (config: string, args = ["corpus"]) => {
		writeConfig(dir, config);
		return runInProcess(require.resolve("./workflow-core-config.js"), args, {
			cwd: dir,
			env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
		});
	};

	it("prints a declared corpus one tracker per line, in declared order", () => {
		const r = run(JSON.stringify({ corpus: ["z/last", "a/first"] }));
		expect([r.status, r.stdout, r.stderr]).toEqual([
			0,
			"z/last\na/first\n",
			"",
		]);
	});

	it("prints the own tracker plus the upstream tracker where undeclared", () => {
		git("init", "-q");
		git("remote", "add", "origin", "git@github.com:owner/remote.git");
		const r = run("{}");
		expect([r.status, r.stdout, r.stderr]).toEqual([
			0,
			`owner/remote\n${UPSTREAM_TRACKER}\n`,
			"",
		]);
	});

	it("prints the upstream tracker once where it is the own tracker", () => {
		const r = run(JSON.stringify({ tracker: UPSTREAM_TRACKER }));
		expect([r.status, r.stdout]).toEqual([0, `${UPSTREAM_TRACKER}\n`]);
	});

	it("prints the upstream tracker alone where no own tracker derives, warning with the key", () => {
		const r = run("{}");
		expect([r.status, r.stdout, r.stderr]).toEqual([
			0,
			`${UPSTREAM_TRACKER}\n`,
			`WARN .claude/workflow-core.json: no own tracker resolves, so "corpus" is ${UPSTREAM_TRACKER} alone — declare "corpus" or "tracker"\n`,
		]);
	});

	it("warns the same where a declared tracker is not owner/name", () => {
		const r = run(JSON.stringify({ tracker: "not-a-tracker" }));
		expect([r.status, r.stdout]).toEqual([0, `${UPSTREAM_TRACKER}\n`]);
		expect(r.stderr).toContain('no own tracker resolves, so "corpus"');
	});

	it("prints no tracker, the skip line and exits 1 where none resolves", () => {
		const r = run(JSON.stringify({ corpus: [] }));
		expect([r.status, r.stdout, r.stderr]).toEqual([
			1,
			"",
			'SKIP: "corpus" in .claude/workflow-core.json resolves no tracker\n',
		]);
	});

	it("exits 2 naming the fault on a config that will not read", () => {
		const r = run("{ not json");
		expect([r.status, r.stdout]).toEqual([2, ""]);
		expect(r.stderr).toMatch(/^BROKEN: .*does not parse/);
	});

	it("warns on a malformed corpus and prints the default", () => {
		const r = run(JSON.stringify({ tracker: "owner/repo", corpus: "a/b" }));
		expect([r.status, r.stdout]).toEqual([
			0,
			`owner/repo\n${UPSTREAM_TRACKER}\n`,
		]);
		expect(r.stderr).toContain('"corpus" is not an array of strings');
	});

	it("is listed on the usage line", () => {
		const r = run("{}", ["nonsense"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^usage: .*\| corpus \| retro-count\n$/);
	});
});

describe("requireKey", () => {
	it("returns a declared key", () => {
		writeConfig(dir, JSON.stringify({ tracker: "owner/repo" }));
		expect(requireKey("tracker", { root: dir })).toBe("owner/repo");
	});

	it("names the file and the key when founder is undeclared", () => {
		writeConfig(dir, "{}");
		expect(() => requireKey("founder", { root: dir })).toThrow(
			`${path.join(dir, ".claude", "workflow-core.json")} declares no "founder"`,
		);
	});

	it("names the file and the key when login can be neither read nor derived", () => {
		stubGh("exit 1");
		writeConfig(dir, "{}");
		expect(() => requireKey("login", { root: dir })).toThrow(
			/declares no "login" and none could be derived/,
		);
	});
});

describe("moduleOn and readCommandFor", () => {
	it("reads a listed module as on and an unlisted one as off", () => {
		writeConfig(dir, JSON.stringify({ modules: ["site"] }));
		expect(moduleOn("site", { root: dir })).toBe(true);
		expect(moduleOn("roadmap", { root: dir })).toBe(false);
	});

	it("reads WFC_MODULES in place of the declared list", () => {
		writeConfig(dir, JSON.stringify({ modules: ["site"] }));
		process.env.WFC_MODULES = "roadmap,suites";
		expect(moduleOn("roadmap", { root: dir })).toBe(true);
		expect(moduleOn("site", { root: dir })).toBe(false);
		process.env.WFC_MODULES = "";
		expect(moduleOn("roadmap", { root: dir })).toBe(false);
	});

	it("never warns of a mutation hold WFC_MODULES alone turns on (#1911)", () => {
		writeConfig(dir, JSON.stringify({}));
		process.env.WFC_MODULES = "mutation";
		expect(readConfig({ root: dir, quiet: true }).warnings).toEqual([]);
	});

	it("reads a declared command and an undeclared one as null", () => {
		writeConfig(dir, JSON.stringify({ commands: { lint: "npm run lint" } }));
		expect(readCommandFor("lint", { root: dir })).toBe("npm run lint");
		expect(readCommandFor("test", { root: dir })).toBeNull();
	});
});

describe("guardDisabled", () => {
	it("reads a listed guard file as disabled and an unlisted one as not", () => {
		writeConfig(dir, JSON.stringify({ disabled: ["guard-branch.sh"] }));
		expect(guardDisabled("guard-branch.sh", { root: dir })).toBe(true);
		expect(guardDisabled("guard-branch", { root: dir })).toBe(false);
		expect(guardDisabled("guard-pull-form.sh", { root: dir })).toBe(false);
	});

	it("never disables a guard off a config it cannot read", () => {
		writeConfig(dir, '{"disabled": ["guard-branch.sh"],');
		expect(guardDisabled("guard-branch.sh", { root: dir })).toBe(false);
		writeConfig(
			dir,
			JSON.stringify({ contract: 9, disabled: ["guard-branch.sh"] }),
		);
		expect(guardDisabled("guard-branch.sh", { root: dir })).toBe(false);
	});
});

describe("cycleLogPath (#438)", () => {
	it("is the declared cycleLogPath", () => {
		writeConfig(
			dir,
			JSON.stringify({ cycleLogPath: "docs/machinery/cycle-log.md" }),
		);
		expect(cycleLogPath({ root: dir })).toBe("docs/machinery/cycle-log.md");
	});

	it("defaults where undeclared", () => {
		expect(cycleLogPath({ root: dir })).toBe(CYCLE_LOG_DEFAULT);
	});

	it("defaults a rejected cycleLogPath, warning that it is not a repo-relative path", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		writeConfig(dir, JSON.stringify({ cycleLogPath: "/abs/cycle-log.md" }));
		expect(cycleLogPath({ root: dir })).toBe(CYCLE_LOG_DEFAULT);
		expect(String(write.mock.calls[0][0])).toContain(
			'"cycleLogPath" is not a repo-relative path',
		);
	});
});

describe("readOutputStylePath (#448)", () => {
	it("is the declared overrides.output_style", () => {
		writeConfig(
			dir,
			JSON.stringify({
				overrides: { output_style: ".claude/output-styles/manta-voice.md" },
			}),
		);
		expect(readOutputStylePath({ root: dir })).toBe(
			".claude/output-styles/manta-voice.md",
		);
	});

	it("defaults where undeclared, rejected or unreadable", () => {
		expect(readOutputStylePath({ root: dir })).toBe(OUTPUT_STYLE_DEFAULT);
		writeConfig(dir, JSON.stringify({ overrides: { output_style: "bare" } }));
		expect(readOutputStylePath({ root: dir })).toBe(OUTPUT_STYLE_DEFAULT);
		writeConfig(dir, "{ not json");
		expect(readOutputStylePath({ root: dir })).toBe(OUTPUT_STYLE_DEFAULT);
	});
});

describe("brandSheetPath (#452)", () => {
	it("is the declared brandSheetPath", () => {
		writeConfig(
			dir,
			JSON.stringify({ brandSheetPath: "docs/brand/brand-sheet.md" }),
		);
		expect(brandSheetPath({ root: dir })).toBe("docs/brand/brand-sheet.md");
	});

	it("defaults where undeclared", () => {
		expect(brandSheetPath({ root: dir })).toBe(BRAND_SHEET_DEFAULT);
	});

	it("defaults a rejected brandSheetPath, warning that it is not a repo-relative path", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		writeConfig(dir, JSON.stringify({ brandSheetPath: "../brand-sheet.md" }));
		expect(brandSheetPath({ root: dir })).toBe(BRAND_SHEET_DEFAULT);
		expect(String(write.mock.calls[0][0])).toContain(
			'"brandSheetPath" is not a repo-relative path',
		);
	});
});

describe("userSettingsSnapshotPath (#447)", () => {
	it("is the declared userSettingsSnapshotPath", () => {
		writeConfig(
			dir,
			JSON.stringify({
				userSettingsSnapshotPath: "docs/machinery/claude-user-settings.md",
			}),
		);
		expect(userSettingsSnapshotPath({ root: dir })).toBe(
			"docs/machinery/claude-user-settings.md",
		);
	});

	it("defaults where undeclared", () => {
		expect(userSettingsSnapshotPath({ root: dir })).toBe(
			USER_SETTINGS_SNAPSHOT_DEFAULT,
		);
		expect(USER_SETTINGS_SNAPSHOT_DEFAULT).toBe("docs/claude-user-settings.md");
	});
});

describe("pickNextRankingPath (#455)", () => {
	it("is the declared pickNextRankingPath", () => {
		writeConfig(
			dir,
			JSON.stringify({
				pickNextRankingPath: "docs/machinery/pick-next-ranking.md",
			}),
		);
		expect(pickNextRankingPath({ root: dir })).toBe(
			"docs/machinery/pick-next-ranking.md",
		);
	});

	it("defaults where undeclared", () => {
		expect(pickNextRankingPath({ root: dir })).toBe(PICK_NEXT_RANKING_DEFAULT);
	});

	it("defaults a rejected pickNextRankingPath, warning that it is not a repo-relative path", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		writeConfig(dir, JSON.stringify({ pickNextRankingPath: 42 }));
		expect(pickNextRankingPath({ root: dir })).toBe(PICK_NEXT_RANKING_DEFAULT);
		expect(String(write.mock.calls[0][0])).toContain(
			'"pickNextRankingPath" is not a repo-relative path',
		);
	});
});

describe("ladderPath (#401)", () => {
	it("is the declared capacityLadderPath", () => {
		writeConfig(
			dir,
			JSON.stringify({ capacityLadderPath: "docs/machinery/ladder.md" }),
		);
		expect(ladderPath({ root: dir })).toBe("docs/machinery/ladder.md");
	});

	it("defaults silently where undeclared", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		expect(ladderPath({ root: dir })).toBe(LADDER_DEFAULT);
		expect(write).not.toHaveBeenCalled();
	});

	it("defaults where the config will not read, warning once and naming the default path it reads (#406)", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		writeConfig(dir, '{"capacityLadderPath": "x.md",');
		expect(ladderPath({ root: dir })).toBe(LADDER_DEFAULT);
		expect(ladderPath({ root: dir })).toBe(LADDER_DEFAULT);
		expect(write).toHaveBeenCalledTimes(1);
		expect(String(write.mock.calls[0][0])).toMatch(
			/does not parse.*read at docs\/capacity-procurement-ladder\.md/,
		);
	});

	it("defaults a rejected capacityLadderPath, warning once that it is not a repo-relative path (#406)", () => {
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		writeConfig(dir, JSON.stringify({ capacityLadderPath: "../ladder.md" }));
		expect(ladderPath({ root: dir })).toBe(LADDER_DEFAULT);
		expect(ladderPath({ root: dir })).toBe(LADDER_DEFAULT);
		readConfig({ root: dir });
		expect(write).toHaveBeenCalledTimes(1);
		expect(String(write.mock.calls[0][0])).toContain(
			'"capacityLadderPath" is not a repo-relative path',
		);
	});
});

/** A node run with the host's own module list, the suite default dropped. */
const hostRun = (args: string[]) =>
	spawnSync(process.execPath, args, {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WFC_MODULES: undefined },
	});

describe("exitUnlessModule", () => {
	const run = (config: string, gate = '"roadmap"') => {
		writeConfig(dir, config);
		return hostRun([
			"-e",
			`require(${JSON.stringify(require.resolve("./workflow-core-config.js"))}).exitUnlessModule(${gate}); console.log("ran")`,
		]);
	};

	it("exits 0 with the skip line when the module is off", () => {
		const r = run("{}");
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(r.stderr).toBe(
			'SKIP: module "roadmap" is off — .claude/workflow-core.json does not list it under "modules"\n',
		);
	});

	it("runs the script when the module is on", () => {
		const r = run(JSON.stringify({ modules: ["roadmap"] }));
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "ran\n", ""]);
	});

	it("names the first module that is off, where it needs several (#418)", () => {
		const r = run(
			JSON.stringify({ modules: ["governance"] }),
			'["governance", "roadmap"]',
		);
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(r.stderr).toContain('SKIP: module "roadmap" is off');
	});

	it("exits 2 naming the refusal when the contract is unknown", () => {
		const r = run(JSON.stringify({ contract: 9 }));
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^BROKEN: .*declares contract 9.*migration note/);
	});
});

describe("the `module` verb, a skill's gate (#418)", () => {
	const run = (config: string, ...modules: string[]) => {
		writeConfig(dir, config);
		return hostRun([
			require.resolve("./workflow-core-config.js"),
			"module",
			...modules,
		]);
	};

	it("is silent and exits 0 where every module named is on", () => {
		const r = run(
			JSON.stringify({ modules: ["governance", "roadmap"] }),
			"governance",
			"roadmap",
		);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
	});

	it("prints the skip line for the one that is off and exits 1", () => {
		const r = run(
			JSON.stringify({ modules: ["governance"] }),
			"governance",
			"roadmap",
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('SKIP: module "roadmap" is off');
	});

	it("exits 2 on a module that does not exist, naming it in a BROKEN line", () => {
		const r = run("{}", "governance", "roadmaps");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('BROKEN: no module "roadmaps"');
	});
});

describe("which retro and archScan warnings refuse, chosen by fault kind (#1744)", () => {
	const faultsOf = (config: object) => {
		writeConfig(dir, JSON.stringify(config));
		const c = readConfig({ root: dir, quiet: true });
		return [retroFault(c), archScanFault(c)];
	};

	it.each([
		[
			{ archScan: { threshold: "8750" } },
			'"archScan.threshold" is not a positive integer',
		],
		[{ archScan: ["data/**"] }, '"archScan" is not an object'],
	])("refuses a malformed archScan of %j", (config, why) => {
		expect(faultsOf(config)).toEqual([null, why]);
	});

	it("does not refuse an unknown archScan sub-key", () => {
		expect(faultsOf({ archScan: { treshold: 1 } })).toEqual([null, null]);
	});

	it.each([
		[
			{ retro: { weeklyCount: "4" } },
			'"retro.weeklyCount" is not a positive integer',
		],
		[{ retro: 4 }, '"retro" is not an object'],
		[{ retro: { weeklyCnt: 4 } }, 'unknown key "retro.weeklyCnt"'],
	])("refuses a malformed or misspelt retro of %j", (config, why) => {
		expect(faultsOf(config)).toEqual([why, null]);
	});

	it("does not refuse retro on a warning that only quotes the word, such as a module named retro", () => {
		expect(faultsOf({ modules: ["retro"] })).toEqual([null, null]);
	});

	it("picks a key's own faults, never an unknown top-level key that only starts with its name and a dot", () => {
		writeConfig(
			dir,
			JSON.stringify({ ruffExclude: ["a/**"], "ruffExclude.x": 1 }),
		);
		const c = readConfig({ root: dir, quiet: true });
		expect(faultsOn(c, "ruffExclude")).toEqual([]);
		expect(faultsOn(c, "ruffExclude", { under: true })).toHaveLength(1);
	});

	it("records each fault's key and kind", () => {
		writeConfig(
			dir,
			JSON.stringify({ archScan: { threshold: 0, treshold: 1 }, retr: {} }),
		);
		expect(readConfig({ root: dir, quiet: true }).faults).toEqual([
			{ key: "retr", kind: "unknown-key", text: 'unknown key "retr"' },
			{
				key: "archScan.threshold",
				kind: "malformed",
				text: '"archScan.threshold" is not a positive integer',
			},
			{
				key: "archScan.treshold",
				kind: "unknown-key",
				text: 'unknown key "archScan.treshold"',
			},
		]);
	});
});

describe("the `retro-count` verb, retro-sweep's weekly gate (#964)", () => {
	const run = (config: string) => {
		writeConfig(dir, config);
		return runInProcess(
			require.resolve("./workflow-core-config.js"),
			["retro-count"],
			{ cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } },
		);
	};
	const unset =
		"SKIP: retro.weeklyCount is unset in .claude/workflow-core.json; run retro-sweep in calibrate mode first, whose result sets it\n";

	it("prints the declared count and exits 0", () => {
		const r = run(JSON.stringify({ retro: { weeklyCount: 4 } }));
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "4\n", ""]);
	});

	it.each([
		["no retro key", "{}"],
		["a retro key with no count", JSON.stringify({ retro: {} })],
	])(
		"prints the skip line naming calibration and exits 1 on %s",
		(_, config) => {
			const r = run(config);
			expect([r.status, r.stdout, r.stderr]).toEqual([1, "", unset]);
		},
	);

	it.each([
		[
			"a count that is not a positive integer",
			{ retro: { weeklyCount: "4" } },
			'"retro.weeklyCount" is not a positive integer',
		],
		["a retro that is not an object", { retro: 4 }, '"retro" is not an object'],
		[
			"a misspelt count key",
			{ retro: { weeklyCnt: 4 } },
			'unknown key "retro.weeklyCnt"',
		],
	])(
		"exits 2 rather than skipping on %s, naming the fault",
		(_, config, why) => {
			const r = run(JSON.stringify(config));
			expect([r.status, r.stdout, r.stderr]).toEqual([
				2,
				"",
				`BROKEN: ${path.join(dir, ".claude", "workflow-core.json")}: ${why}\n`,
			]);
		},
	);
});

describe("the `manual-render` verb, manual-sync's post-write step (#451)", () => {
	const run = (config: string) => {
		writeConfig(dir, config);
		return runInProcess(
			require.resolve("./workflow-core-config.js"),
			["manual-render"],
			{
				cwd: dir,
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: dir,
					WFC_MODULES: undefined,
				},
			},
		);
	};
	const declared = {
		command: "npm run gen:doc-pages",
		outputs: ["docs/pages/operating-manual.html", "docs/pages/index.html"],
	};

	it("prints the command, then each output, and exits 0", () => {
		const r = run(JSON.stringify({ manualRender: declared }));
		expect([r.status, r.stdout, r.stderr]).toEqual([
			0,
			"npm run gen:doc-pages\ndocs/pages/operating-manual.html\ndocs/pages/index.html\n",
			"",
		]);
	});

	it("prints the skip line and exits 1 where undeclared", () => {
		const r = run("{}");
		expect([r.status, r.stdout]).toEqual([1, ""]);
		expect(r.stderr).toBe(
			"SKIP: manualRender is undeclared in .claude/workflow-core.json\n",
		);
	});

	it.each([
		["no outputs", { command: "x", outputs: [] }],
		["no command", { outputs: ["docs/a.html"] }],
		["an absolute output", { command: "x", outputs: ["/abs/a.html"] }],
		["an output outside the repo", { command: "x", outputs: ["../a.html"] }],
		[
			"a newline in the command",
			{ command: "x\ndocs/b.html", outputs: ["docs/a.html"] },
		],
		[
			"a newline in an output",
			{ command: "x", outputs: ["docs/a.html\ndocs/b.html"] },
		],
		["a string", "npm run gen:doc-pages"],
	])(
		"exits 2 rather than skipping on %s, naming the shape it wants",
		(_, manualRender) => {
			const r = run(JSON.stringify({ manualRender }));
			expect([r.status, r.stdout]).toEqual([2, ""]);
			expect(r.stderr).toBe(
				`BROKEN: ${path.join(dir, ".claude", "workflow-core.json")}: "manualRender" is not {command: a one-line command string, outputs: a non-empty array of one-line repo-relative paths}\n`,
			);
		},
	);
});

describe("the `pick-next-ranking` verb, pick-next §4's read (#455)", () => {
	const run = (config: string) => {
		writeConfig(dir, config);
		return runInProcess(
			require.resolve("./workflow-core-config.js"),
			["pick-next-ranking"],
			{ cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } },
		);
	};

	it("prints the declared path and exits 0", () => {
		const r = run(
			JSON.stringify({ pickNextRankingPath: "docs/pick-next-ranking.md" }),
		);
		expect([r.status, r.stdout, r.stderr]).toEqual([
			0,
			"docs/pick-next-ranking.md\n",
			"",
		]);
	});

	it("prints the default where undeclared", () => {
		const r = run("{}");
		expect([r.status, r.stdout, r.stderr]).toEqual([
			0,
			".claude/pick-next-ranking.md\n",
			"",
		]);
	});

	it.each([
		["a malformed value", JSON.stringify({ pickNextRankingPath: "/abs.md" })],
		["an unreadable config", "{ not json"],
	])("warns on %s and prints the default", (_, config) => {
		const r = run(config);
		expect([r.status, r.stdout]).toEqual([0, ".claude/pick-next-ranking.md\n"]);
		expect(r.stderr).toMatch(/^WARN /);
	});
});
