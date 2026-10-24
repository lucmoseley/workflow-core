// @vitest-environment node
/*
 * wfc-config.sh — the shell half of workflow-core-config.js: each read's
 * default, the declared value, the unknown-contract refusal and the two skip
 * lines, run in a real bash against a throwaway host root (#2, #944), then
 * its parity with the JS reader (#1481).
 *
 * `lib/guard-parse.sh` sources it, so every bash `PreToolUse` guard in
 * `.claude/settings.json` reads its config through it; loosen a case and an
 * adopter's gated checks are silently skipped or run on a host that never
 * opted in, or the shell half drifts from the JS reader's defaults.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LIB = path.resolve(__dirname, "wfc-config.sh");
let dir: string;

const writeConfig = (text: string) => {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".claude", "workflow-core.json"), text);
};
const sh = (script: string, env: Record<string, string> = {}) =>
	spawnSync("/bin/bash", ["-c", `source ${JSON.stringify(LIB)}; ${script}`], {
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			WFC_MODULES: undefined,
			WFC_OUTPUT_STYLE: undefined,
			...env,
		},
	});

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wfc-sh-")));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("defaults with no config file", () => {
	it("reads no module on, no command declared, nothing disabled, the contract fine", () => {
		const r = sh(
			'wfc_module_on roadmap; echo "m=$?"; wfc_command test; echo "c=$?"; wfc_disabled guard-branch.sh; echo "d=$?"; wfc_contract_ok; echo "k=$?"',
		);
		expect(r.stdout).toBe("m=1\nc=1\nd=1\nk=0\n");
		expect(r.stderr).toBe("");
	});
});

describe("declared values", () => {
	beforeEach(() =>
		writeConfig(
			JSON.stringify({
				contract: 1,
				modules: ["suites"],
				commands: { test: "npm run test", lint: null },
				disabled: ["guard-branch.sh"],
			}),
		),
	);

	it("reads a listed module as on and an unlisted one as off", () => {
		expect(
			sh('wfc_module_on suites; echo "$?"; wfc_module_on site; echo "$?"')
				.stdout,
		).toBe("0\n1\n");
	});

	it("prints a declared command and fails a null or absent one", () => {
		expect(
			sh(
				'wfc_command test; echo " $?"; wfc_command lint; echo "$?"; wfc_command typecheck; echo "$?"',
			).stdout,
		).toBe("npm run test 0\n1\n1\n");
	});

	it("prints a known deploy, and fails an unknown or absent one (#742)", () => {
		const deploy = (d: unknown) => {
			writeConfig(JSON.stringify({ contract: 1, deploy: d }));
			return sh('wfc_deploy; echo " $?"').stdout;
		};
		expect(deploy("vercel")).toBe("vercel 0\n");
		expect(deploy("netlify")).toBe(" 1\n");
		expect(deploy(["vercel"])).toBe(" 1\n");
		fs.rmSync(path.join(dir, ".claude", "workflow-core.json"));
		expect(sh('wfc_deploy; echo " $?"').stdout).toBe(" 1\n");
	});

	it("reads a listed basename as disabled and another as not", () => {
		expect(
			sh(
				'wfc_disabled guard-branch.sh; echo "$?"; wfc_disabled guard-pull-form.sh; echo "$?"',
			).stdout,
		).toBe("0\n1\n");
	});
});

describe("wfc_output_style (#448)", () => {
	const core = ".claude/output-styles/core-voice.md";

	it("defaults to core-voice.md with no config", () => {
		expect(sh("wfc_output_style").stdout).toBe(core);
	});

	it("prints a declared repo-relative path", () => {
		writeConfig(
			JSON.stringify({ overrides: { output_style: "docs/manta-voice.md" } }),
		);
		expect(sh("wfc_output_style").stdout).toBe("docs/manta-voice.md");
	});

	it.each(["bare.md", "/abs/voice.md", "docs/../voice.md"])(
		"defaults %s, as the JS reader rejects it",
		(style) => {
			writeConfig(JSON.stringify({ overrides: { output_style: style } }));
			expect(sh("wfc_output_style").stdout).toBe(core);
		},
	);

	it("defaults under a contract this core does not read", () => {
		writeConfig(
			JSON.stringify({
				contract: 9,
				overrides: { output_style: "docs/manta-voice.md" },
			}),
		);
		expect(sh("wfc_output_style").stdout).toBe(core);
	});

	it("accepts a backslash-led path, as posix path.isAbsolute does", () => {
		writeConfig(JSON.stringify({ overrides: { output_style: "\\abs\\v.md" } }));
		expect(sh("wfc_output_style").stdout).toBe("\\abs\\v.md");
	});

	it("defaults WFC_OUTPUT_STYLE too under a contract this core does not read", () => {
		writeConfig(JSON.stringify({ contract: 9 }));
		expect(sh("wfc_output_style", { WFC_OUTPUT_STYLE: "x/y.md" }).stdout).toBe(
			core,
		);
	});

	it("takes WFC_OUTPUT_STYLE over the declared value, empty meaning undeclared", () => {
		writeConfig(
			JSON.stringify({ overrides: { output_style: "docs/manta-voice.md" } }),
		);
		expect(sh("wfc_output_style", { WFC_OUTPUT_STYLE: "x/y.md" }).stdout).toBe(
			"x/y.md",
		);
		expect(sh("wfc_output_style", { WFC_OUTPUT_STYLE: "" }).stdout).toBe(core);
	});
});

describe("WFC_MODULES", () => {
	it("replaces the declared list where set, even to nothing", () => {
		writeConfig(JSON.stringify({ modules: ["site"] }));
		expect(
			sh('wfc_module_on roadmap; echo "$?"; wfc_module_on site; echo "$?"', {
				WFC_MODULES: "roadmap,suites",
			}).stdout,
		).toBe("0\n1\n");
		expect(
			sh('wfc_module_on site; echo "$?"', { WFC_MODULES: "" }).stdout,
		).toBe("1\n");
	});
});

describe("the liveness mod's off switch (#944)", () => {
	it("raises no warning, and is never read as a module list", () => {
		writeConfig(
			JSON.stringify({ modules: ["suites"], mods: { "wfc-liveness": false } }),
		);
		const r = sh(
			'wfc_module_on suites; echo "$?"; wfc_module_on roadmap; echo "$?"; wfc_contract_ok; echo "$?"',
		);
		expect(r.stdout).toBe("0\n1\n0\n");
		expect(r.stderr).toBe("");
	});
});

describe("unknown module names (#43)", () => {
	it("warns on an unknown name asked about, and reads it as off", () => {
		const r = sh('wfc_module_on sutes; echo "$?"', { WFC_MODULES: "suites" });
		expect(r.stdout).toBe("1\n");
		expect(r.stderr).toContain('unknown module "sutes"');
	});

	it("warns on an unknown name in WFC_MODULES, once per process", () => {
		const r = sh(
			'wfc_module_on suites; echo "$?"; wfc_module_on roadmap; echo "$?"',
			{ WFC_MODULES: "suites,rodmap" },
		);
		expect(r.stdout).toBe("0\n1\n");
		expect(
			r.stderr.match(/unknown module "rodmap" in WFC_MODULES\n/g),
		).toHaveLength(1);
	});

	it("warns on an unknown name in the config's modules, once per process", () => {
		writeConfig(JSON.stringify({ modules: ["suites", "rodmap"] }));
		const r = sh(
			'wfc_module_on suites; echo "$?"; wfc_module_on roadmap; echo "$?"',
		);
		expect(r.stdout).toBe("0\n1\n");
		expect(
			r.stderr.match(
				/unknown module "rodmap" in \.claude\/workflow-core\.json/g,
			),
		).toHaveLength(1);
	});

	it("knows the same deploys as the JS reader", () => {
		const { DEPLOYS } = require("./workflow-core-config.js");
		expect(sh('printf %s "$WFC_KNOWN_DEPLOYS"').stdout.split(" ")).toEqual([
			...DEPLOYS,
		]);
	});

	it("knows the same modules as the JS reader", () => {
		const { MODULES } = require("./workflow-core-config.js");
		expect(sh('printf %s "$WFC_KNOWN_MODULES"').stdout.split(" ")).toEqual([
			...MODULES,
		]);
	});

	it("knows the same commands and contracts as the JS reader", () => {
		const { COMMANDS, readConfig } = require("./workflow-core-config.js");
		expect(sh('printf %s "$WFC_KNOWN_COMMANDS"').stdout.split(" ")).toEqual([
			...COMMANDS,
		]);
		/* The JS reader names the contracts it reads in its refusal. */
		writeConfig(JSON.stringify({ contract: -1 }));
		const refusal = (() => {
			try {
				readConfig({ root: dir, quiet: true });
			} catch (e) {
				return (e as Error).message;
			}
			return expect.fail("the JS reader read contract -1");
		})();
		expect(
			sh('printf %s "$WFC_KNOWN_CONTRACTS"').stdout.split(" ").join(", "),
		).toBe(/\(it reads ([^)]*)\)/.exec(refusal)?.[1]);
	});
});

/*
 * The parity table (#1481): each fixture through both readers, every key the
 * shell reads asked of each. A row's `answers` are what both give, over `baseAnswers`;
 * `shellDiffers` is an intended difference, with its reason. "refused" is the
 * JS reader's contract throw, and in shell the key's `baseAnswers` entry with the
 * refusal on stderr.
 */
describe("parity with the JS reader (#1481)", () => {
	const cfg = require("./workflow-core-config.js");
	const refusalPattern = /which this workflow-core does not read/;
	interface Asks {
		module: string;
		command: string;
	}
	const probes = {
		contract: {
			sh: () => "wfc_contract_ok",
			shAnswer: (_out: string, rc: number) => (rc === 0 ? "ok" : "refused"),
			js: (root: string) => {
				cfg.readConfig({ root, quiet: true });
				return "ok";
			},
		},
		module: {
			sh: (a: Asks) => `wfc_module_on ${a.module}`,
			shAnswer: (_out: string, rc: number) => (rc === 0 ? "on" : "off"),
			js: (root: string, a: Asks) =>
				cfg.moduleOn(a.module, { root }) ? "on" : "off",
		},
		command: {
			sh: (a: Asks) => `wfc_command ${a.command}`,
			shAnswer: (out: string, rc: number) => (rc === 0 ? out : "undeclared"),
			js: (root: string, a: Asks) =>
				cfg.commandFor(a.command, { root }) ?? "undeclared",
		},
		deploy: {
			sh: () => "wfc_deploy",
			shAnswer: (out: string, rc: number) => (rc === 0 ? out : "none"),
			js: (root: string) =>
				cfg.readConfig({ root, quiet: true }).deploy ?? "none",
		},
		suiteRunners: {
			sh: () => "wfc_suite_runners",
			shAnswer: (out: string) => out.trim().split("\n").join(",") || "none",
			js: (root: string) =>
				cfg.readConfig({ root, quiet: true }).suiteRunners?.join(",") || "none",
		},
		outputStyle: {
			sh: () => "wfc_output_style",
			shAnswer: (out: string) => out,
			js: (root: string) =>
				cfg.outputStylePath({
					root,
					say: () => {
						/* only the path is compared */
					},
				}),
		},
		disabled: {
			sh: () => "wfc_disabled guard-branch.sh",
			shAnswer: (_out: string, rc: number) => (rc === 0 ? "yes" : "no"),
			js: (root: string) =>
				cfg.guardDisabled("guard-branch.sh", { root }) ? "yes" : "no",
		},
		tracker: {
			sh: () => "wfc_tracker",
			shAnswer: (out: string, rc: number) => (rc === 0 ? out : "none"),
			js: (root: string) => cfg.resolveKey("tracker", { root }) ?? "none",
		},
	};
	type Probe = keyof typeof probes;
	type Answers = Record<Probe, string>;
	const coreVoicePath = ".claude/output-styles/core-voice.md";
	const baseAnswers: Answers = {
		contract: "ok",
		module: "off",
		command: "undeclared",
		deploy: "none",
		suiteRunners: "none",
		outputStyle: coreVoicePath,
		disabled: "no",
		tracker: "none",
	};
	const refusedAnswers: Partial<Answers> = {
		contract: "refused",
		module: "refused",
		command: "refused",
		deploy: "refused",
		suiteRunners: "refused",
		tracker: "refused",
	};
	const fullConfig = {
		modules: ["roadmap"],
		commands: { test: "npm test" },
		deploy: "vercel",
		suiteRunners: ["a.sh", "b.sh"],
		overrides: { output_style: "docs/voice.md" },
		disabled: ["guard-branch.sh"],
		tracker: "acme/declared",
	};
	interface Row {
		name: string;
		/** The config's text, or an object to serialise; absent, no file. */
		config?: string | object;
		remote?: string;
		modulesEnv?: string;
		asks?: Partial<Asks>;
		answers?: Partial<Answers>;
		shellDiffers?: { why: string; answers: Partial<Answers> };
	}
	const brokenAnswers = {
		contract: "broken",
		module: "broken",
		command: "broken",
		deploy: "broken",
		suiteRunners: "broken",
		tracker: "broken",
	};
	const notRead = {
		why: "JS throws on a config it cannot read; a hook must not crash its caller (#43), so shell reads every key as its default",
		answers: { ...baseAnswers },
	};
	const rows: Row[] = [
		{ name: "no config file" },
		{ name: "an empty config", config: {} },
		{
			name: "every key declared",
			config: { contract: 1, ...fullConfig },
			answers: {
				module: "on",
				command: "npm test",
				deploy: "vercel",
				suiteRunners: "a.sh,b.sh",
				outputStyle: "docs/voice.md",
				disabled: "yes",
				tracker: "acme/declared",
			},
		},
		{
			name: "every key declared, under an unread contract",
			config: { contract: 99, ...fullConfig },
			answers: refusedAnswers,
		},
		{
			name: "an unread contract with modules: [roadmap]",
			config: { contract: 99, modules: ["roadmap"] },
			answers: refusedAnswers,
		},
		{
			name: "a null contract",
			config: { contract: null },
			answers: refusedAnswers,
		},
		{
			name: "a string contract",
			config: { contract: "1" },
			answers: refusedAnswers,
		},
		{
			name: "WFC_MODULES over the declared list",
			config: { modules: [] },
			modulesEnv: "suites,roadmap",
			answers: { module: "on" },
		},
		{
			name: "WFC_MODULES under an unread contract",
			config: { contract: 99 },
			modulesEnv: "roadmap",
			answers: refusedAnswers,
		},
		{
			name: "a module entry holding a comma",
			config: { modules: ["roadmap,suites"] },
			asks: { module: "suites" },
		},
		{
			name: "modules not an array",
			config: { modules: "roadmap" },
		},
		{
			name: "a blank command",
			config: { commands: { test: "  " } },
		},
		{
			name: "a whitespace-only command",
			config: { commands: { test: "\t\n ﻿" } },
		},
		{
			name: "a command of NEL, which trim() keeps",
			config: { commands: { test: "\u0085" } },
			answers: { command: "\u0085" },
		},
		{
			name: "a command that is not a string",
			config: { commands: { test: 3 } },
		},
		{
			name: "commands not an object",
			config: { commands: ["npm test"] },
		},
		{
			name: "an unknown deploy",
			config: { deploy: "netlify" },
		},
		{
			name: "suiteRunners holding a non-string",
			config: { suiteRunners: ["a.sh", 3] },
		},
		{
			name: "suiteRunners not an array",
			config: { suiteRunners: "a.sh" },
		},
		{
			name: "disabled holding a non-string",
			config: { disabled: ["guard-branch.sh", 3] },
		},
		...["bare.md", "/abs/voice.md", "docs/../voice.md"].map((style) => ({
			name: `output_style ${style}`,
			config: { overrides: { output_style: style } },
		})),
		...(
			[
				["https://github.com/acme/derived.git", "acme/derived"],
				["https://user@github.com/acme/derived/", "acme/derived"],
				["git@github.com:acme/derived.git", "acme/derived"],
				["ssh://git@github.com/acme/derived", "acme/derived"],
				["git@github.com:acme/derived.git.git", "acme/derived.git"],
				["https://github.com/acme/.git", "acme/.git"],
				["https://gitlab.com/acme/derived.git", "none"],
				["https://github.com/acme/derived/extra", "none"],
			] as const
		).map(([remote, tracker]) => ({
			name: `tracker undeclared, origin ${remote}`,
			config: {},
			remote,
			answers: { tracker },
		})),
		{
			name: "tracker not a string",
			config: { tracker: 3 },
			remote: "git@github.com:acme/derived.git",
			answers: { tracker: "acme/derived" },
		},
		{
			name: "tracker declared empty",
			config: { tracker: "" },
			remote: "git@github.com:acme/derived.git",
			answers: { tracker: "" },
		},
		{
			name: "a config that does not parse",
			config: "{ nope",
			answers: brokenAnswers,
			shellDiffers: notRead,
		},
		{
			name: "a config that is not an object",
			config: "[1]",
			answers: brokenAnswers,
			shellDiffers: notRead,
		},
		{
			name: "WFC_MODULES over a config that does not parse",
			config: "{ nope",
			modulesEnv: "roadmap",
			answers: brokenAnswers,
			shellDiffers: notRead,
		},
		{
			name: "an unknown module asked",
			config: { modules: ["roadmap", "rodmap"] },
			asks: { module: "rodmap" },
			answers: { module: "throws" },
			shellDiffers: {
				why: "a throw would take down the hook asking (#43), so shell warns and reads it off",
				answers: { module: "off" },
			},
		},
		{
			name: "an unknown command asked",
			config: { commands: { test: "npm test", tset: "npm test" } },
			asks: { command: "tset" },
			answers: { command: "throws" },
			shellDiffers: {
				why: "as an unknown module: shell warns and reads it undeclared",
				answers: { command: "undeclared" },
			},
		},
	];

	const write = (row: Row) => {
		if (row.config !== undefined)
			writeConfig(
				typeof row.config === "string"
					? row.config
					: JSON.stringify(row.config),
			);
		if (row.remote) {
			spawnSync("git", ["-C", dir, "init", "-q"]);
			spawnSync("git", ["-C", dir, "remote", "add", "origin", row.remote]);
		}
	};

	/** What a JS probe that threw answers, read off its message. */
	const thrownAnswer = (e: unknown) => {
		const m = (e as Error).message;
		if (refusalPattern.test(m)) return "refused";
		if (/does not parse/.test(m)) return "broken";
		return "throws";
	};

	const jsAnswers = (row: Row, asks: Asks): Answers => {
		const saved = {
			WFC_MODULES: process.env.WFC_MODULES,
			WFC_OUTPUT_STYLE: process.env.WFC_OUTPUT_STYLE,
		};
		delete process.env.WFC_OUTPUT_STYLE;
		if (row.modulesEnv === undefined) delete process.env.WFC_MODULES;
		else process.env.WFC_MODULES = row.modulesEnv;
		// The rows' own malformed keys warn; the answers are what is compared.
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const out = {} as Answers;
			for (const [probe, p] of Object.entries(probes)) {
				try {
					out[probe as Probe] = p.js(dir, asks);
				} catch (e) {
					out[probe as Probe] = thrownAnswer(e);
				}
			}
			return out;
		} finally {
			stderr.mockRestore();
			for (const [k, v] of Object.entries(saved))
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
		}
	};

	/** One bash for the row, each probe in a subshell of its own so one
	 *  probe's once-per-process refusal never silences another's. */
	const shellAnswers = (row: Row, asks: Asks): Answers => {
		const out = path.join(dir, "probes");
		fs.mkdirSync(out);
		const script = Object.entries(probes)
			.map(
				([probe, p]) =>
					`( ${p.sh(asks)} >${out}/${probe}.out 2>${out}/${probe}.err; echo $? >${out}/${probe}.rc )`,
			)
			.join("\n");
		const env: Record<string, string> = {};
		if (row.modulesEnv !== undefined) env.WFC_MODULES = row.modulesEnv;
		sh(script, env);
		const answers = {} as Answers;
		for (const [probe, p] of Object.entries(probes)) {
			const read = (ext: string) =>
				fs.readFileSync(path.join(out, `${probe}.${ext}`), "utf8");
			const answer = p.shAnswer(read("out"), Number(read("rc")));
			const refused = refusalPattern.test(read("err"));
			if (refused && probe !== "contract")
				expect(answer, `${probe} reads its default when refused`).toBe(
					baseAnswers[probe as Probe],
				);
			answers[probe as Probe] = refused ? "refused" : answer;
		}
		return answers;
	};

	it.each(rows)(
		"answers every key as the JS reader does, given $name",
		(row) => {
			write(row);
			const asks: Asks = { module: "roadmap", command: "test", ...row.asks };
			const js = { ...baseAnswers, ...row.answers };
			expect(jsAnswers(row, asks), "JS").toEqual(js);
			expect(shellAnswers(row, asks), row.shellDiffers?.why ?? "shell").toEqual(
				{
					...js,
					...row.shellDiffers?.answers,
				},
			);
		},
	);

	it("probes every key the shell reads", () => {
		const helpers = [
			"wfc_config_file",
			"wfc_module_off_line",
			"wfc_command_undeclared_line",
			"wfc_repo_slug",
			// Reads the harness's settings, not this config (#2039).
			"wfc_core_voice_loaded",
		];
		const readers = [
			...fs.readFileSync(LIB, "utf8").matchAll(/^(wfc_\w+)\(\)/gm),
		]
			.map((m) => m[1])
			.filter((f) => !helpers.includes(f));
		const asks = { module: "roadmap", command: "test" };
		expect(
			Object.values(probes)
				.map((p) => p.sh(asks).split(" ")[0])
				.sort(),
		).toEqual(readers.sort());
	});
});

describe("contract", () => {
	it("takes a missing contract as the known one", () => {
		writeConfig("{}");
		expect(sh('wfc_contract_ok; echo "$?"').stdout).toBe("0\n");
	});

	it("refuses an unknown contract, naming the migration note", () => {
		writeConfig(JSON.stringify({ contract: 2 }));
		const r = sh('wfc_contract_ok; echo "$?"');
		expect(r.stdout).toBe("2\n");
		expect(r.stderr).toMatch(
			/declares contract 2, which this workflow-core does not read \(it reads 1\)\. Read the migration note in migrations\//,
		);
	});
});

describe("degraded reads", () => {
	it("reads defaults, once warned, where the file does not parse", () => {
		writeConfig("{ nope");
		const r = sh('wfc_module_on roadmap; echo "$?"');
		expect(r.stdout).toBe("1\n");
		expect(r.stderr).toMatch(/does not parse — every key read as its default/);
	});

	it("reads defaults where jq is not on PATH", () => {
		writeConfig(JSON.stringify({ modules: ["roadmap"] }));
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		for (const tool of ["git", "dirname", "basename"]) {
			const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
				encoding: "utf8",
			}).stdout.trim();
			if (found) fs.symlinkSync(found, path.join(bin, tool));
		}
		const r = sh('wfc_module_on roadmap; echo "$?"', { PATH: bin });
		expect(r.stdout).toBe("1\n");
		expect(r.stderr).toMatch(/jq not found/);
	});
});

describe("skip lines", () => {
	it("names the module and the config file", () => {
		expect(sh("wfc_module_off_line roadmap").stdout).toBe(
			'SKIP: module "roadmap" is off — .claude/workflow-core.json does not list it under "modules"\n',
		);
	});

	it("names the command and the config file", () => {
		expect(sh("wfc_command_undeclared_line check_staged").stdout).toBe(
			"SKIP: commands.check_staged is undeclared in .claude/workflow-core.json\n",
		);
	});
});
