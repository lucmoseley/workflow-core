// @vitest-environment node
/*
 * lib/infer-commands.js's three judgements of a repo's commands: whether one
 * runs lint-staged, however spelled (#2587); how each `biome check --staged`
 * shape maps to biome-staged.js or is refused, naming the way out (#2731,
 * #2599); and when `inferCommands` finds `node --test` from node's own default
 * patterns (#3170).
 *
 * Module cases over a temp directory, whose `package.json` files' scripts and
 * dependency sections, at the top and in the directories a command names, are
 * what the judgements read; program cases run through run-in-process the
 * `check-staged` program the hook runs, for its exit code and message.
 * Loosen a case and an unsafe `check_staged` passes init and the pre-commit
 * hook, linting or writing a neighbour's worktree bytes (#2583); loosen the
 * node patterns and a repo whose tests node never runs is handed
 * `node --test`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BIOME_STAGED_COMMAND,
	classifyCheckStaged,
	inferCommands,
	isLintStagedCommand,
} from "./infer-commands.js";
import { runInProcess } from "./run-in-process";

let dir: string;

const UNREAD = "so whether it runs biome check --staged cannot be read";
const OWN_FLAGS_WAY_OUT = `Declare check_staged instead as an explicit '${BIOME_STAGED_COMMAND} <flags>' whose flags you own.`;
const IN_WEB = `runs it in web, where biome-staged.js, which runs from the work tree's top, cannot follow. ${OWN_FLAGS_WAY_OUT}`;
const CLI = path.join(__dirname, "infer-commands.js");

const run = (command: string) =>
	runInProcess(CLI, ["check-staged", command], { cwd: dir });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "infer-commands-"));
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			scripts: {
				pre: "lint-staged",
				"lint-staged": "tsc",
				loop: "npm run loop",
			},
		}),
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("whether a command runs lint-staged (#2587)", () => {
	it.each([
		"lint-staged",
		"npx lint-staged && tsc",
		"npx lint-staged@17",
		"./node_modules/.bin/lint-staged",
		'sh -c "lint-staged"',
		"npm run pre",
		'npm run "pre"',
		'concurrently "npm run pre"',
		"npm run -s pre",
		// A runner flag after the name (#3153).
		"npm run pre --silent",
		"npm --prefix . run pre",
		"pnpm run --silent pre",
		"biome check . && yarn run pre",
		// A missing script's handed words stop at the line's end (#3413).
		"pnpm run nosuch\nlint-staged",
		'concurrently "pnpm run nosuch" "lint-staged"',
		"npm run nosuch lint-staged",
		"pnpm run nosuch -- lint-staged",
		'yarn run nosuch "lint-staged"',
		// A script name quoted in part (#3445).
		'npm run p"re"',
	])("counts %j", (command) => {
		expect(isLintStagedCommand(dir, command)).toBe(true);
	});

	it.each([
		"eslint --rule lint-staged-x .",
		"npm run lint-staged",
		"npm run missing",
		"npm run loop",
		"pnpm run nosuch\ntsc",
		'concurrently "pnpm run nosuch" "tsc"',
	])("does not count %j", (command) => {
		expect(isLintStagedCommand(dir, command)).toBe(false);
	});

	it("does not count a command running no script, reading no unparsable package.json (#3546)", () => {
		fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
		expect(isLintStagedCommand(dir, "eslint .")).toBe(false);
		expect(() => isLintStagedCommand(dir, "npm run pre")).toThrow(
			"package.json does not parse",
		);
	});
});

describe("a yarn or bun run a binary answers (#3944)", () => {
	const writeScripts = (scripts: object) =>
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts }),
		);

	it.each(["yarn run lint-staged", "bun run lint-staged"])(
		"counts %j where no script has that name, as the binary runs",
		(command) => {
			writeScripts({});
			expect(isLintStagedCommand(dir, command)).toBe(true);
		},
	);

	it.each(["npm run lint-staged", "pnpm run lint-staged"])(
		"does not count %j, whose runner fails on a missing script",
		(command) => {
			writeScripts({});
			expect(isLintStagedCommand(dir, command)).toBe(false);
		},
	);

	it("does not count a run naming a real script that runs no lint-staged", () => {
		writeScripts({ "lint-staged": "tsc" });
		expect(isLintStagedCommand(dir, "yarn run lint-staged")).toBe(false);
	});
});

describe("a command naming a script or directory by a bare `$'\\c'` (#3853)", () => {
	it("follows the script named as bash reads it, the literal \\c", () => {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts: { "\\c": "lint-staged" } }),
		);
		expect(isLintStagedCommand(dir, "npm run $'\\c'")).toBe(true);
	});

	it("reads a directory so named, in a repo with no Biome evidence", () => {
		expect(
			classifyCheckStaged(dir, "cd $'\\c' && npm run loop", { inferred: true }),
		).toEqual({ kind: "none" });
	});
});

describe("a command holding a `$'…'` escape with no character to read (#3896)", () => {
	it("reads eslint $'\\x' as no Biome command in a repo with no Biome evidence", () => {
		expect(
			classifyCheckStaged(dir, "eslint $'\\x'", { inferred: true }),
		).toEqual({ kind: "none" });
	});

	it("follows the script named as bash reads it, the literal \\x", () => {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts: { "\\x": "lint-staged" } }),
		);
		expect(isLintStagedCommand(dir, "npm run $'\\x'")).toBe(true);
	});
});

describe("classifyCheckStaged", () => {
	const classify = (
		script: string,
		{ biome = true, inferred = true, command = "npm run check:staged" } = {},
	) => {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				scripts: { "check:staged": script, tsc: "tsc" },
				...(biome ? { devDependencies: { "@biomejs/biome": "2.5.15" } } : {}),
			}),
		);
		return classifyCheckStaged(dir, command, { inferred });
	};

	it.each([
		["biome check --staged", BIOME_STAGED_COMMAND],
		["npx biome check --staged", BIOME_STAGED_COMMAND],
		["@biomejs/biome check --staged", BIOME_STAGED_COMMAND],
		// The shell deletes a backslash-newline (#3422).
		["biome check \\\n--staged", BIOME_STAGED_COMMAND],
		[
			"npx @biomejs/biome check --staged --no-errors-on-unmatched --error-on-warnings",
			`${BIOME_STAGED_COMMAND} --no-errors-on-unmatched --error-on-warnings`,
		],
		[
			"biome check --staged --only=lint/style",
			`${BIOME_STAGED_COMMAND} --only=lint/style`,
		],
		[
			"biome check --staged --reporter=json-pretty",
			`${BIOME_STAGED_COMMAND} --reporter=json-pretty`,
		],
		[
			"biome check --staged --javascript-formatter-quote-style=single --line-width=100",
			`${BIOME_STAGED_COMMAND} --javascript-formatter-quote-style=single --line-width=100`,
		],
	])("maps %j to %s with no note", (script, command) => {
		expect(classify(script)).toStrictEqual({ kind: "mapped", command });
	});

	it.each(["--write", "--fix", "--unsafe", "--apply", "--apply-unsafe"])(
		"maps a script with %s, dropping it and carrying the note",
		(flag) => {
			expect(
				classify(`biome check --staged ${flag} --no-errors-on-unmatched`),
			).toEqual({
				kind: "mapped",
				command: `${BIOME_STAGED_COMMAND} --no-errors-on-unmatched`,
				note: expect.stringContaining("auto-fix on commit dropped"),
			});
		},
	);

	it.each([
		[
			"composite",
			"biome check --staged && tsc",
			"holds more than",
			`'${BIOME_STAGED_COMMAND}' for the Biome part`,
		],
		[
			"piped",
			"biome check --staged | tee out",
			"holds more than",
			"a gate of its own",
		],
		[
			"semicolon",
			"biome check --staged; tsc",
			"holds more than",
			"a gate of its own",
		],
		[
			"redirect, the Biome part still mapped (#3153)",
			"biome check --staged --verbose > out.txt",
			"holds more than",
			`'${BIOME_STAGED_COMMAND} --verbose' for the Biome part`,
		],
		[
			"fd duplication ahead of a flag (#3153)",
			"biome check --staged 2>&1 --verbose | tee out",
			"holds more than",
			`'${BIOME_STAGED_COMMAND} --verbose' for the Biome part`,
		],
		[
			"write flag and composite",
			"biome check --staged --write && tsc",
			"holds more than",
			`'${BIOME_STAGED_COMMAND}' for the Biome part`,
		],
		[
			"value after a space",
			"biome check --staged --reporter json",
			"--reporter's value after a space",
			"Declare check_staged with the = form, --reporter=json.",
		],
		[
			"--config-path",
			"biome check --staged --config-path=biome.json",
			"passes --config-path",
			"whose flags you own",
		],
		[
			"--vcs-root",
			"biome check --staged --vcs-root=.",
			"passes --vcs-root",
			"whose flags you own",
		],
		[
			"--reporter-file",
			"biome check --staged --reporter-file=/tmp/r.json",
			"passes --reporter-file",
			"whose flags you own",
		],
		[
			"--log-file",
			"biome check --staged --log-file=log.txt",
			"passes --log-file",
			"whose flags you own",
		],
		[
			"--stdin-file-path",
			"biome check --staged --stdin-file-path=a.js",
			"passes --stdin-file-path",
			"whose flags you own",
		],
		[
			"-h, judged as --help (#2871)",
			"biome check --staged -h",
			"passes -h, which on biome-staged.js's extract of the index prints help and checks nothing",
			"Declare check_staged without '-h'.",
		],
		[
			"short flag other than -h (#3153)",
			"biome check --staged -v",
			"passes -v, a flag not on biome-staged.js's allowlist",
			"whose flags you own",
		],
		[
			"positional .",
			"biome check --staged .",
			'the path "."',
			"checks every staged path",
		],
		[
			"positional path",
			"biome check --staged --verbose src",
			'the path "src"',
			`'${BIOME_STAGED_COMMAND} --verbose', with no path`,
		],
		[
			"subshell, the Biome part still mapped (#3153)",
			"(biome check --staged)",
			"holds more than",
			`'${BIOME_STAGED_COMMAND}' for the Biome part`,
		],
		[
			"redirect with no space (#3191)",
			"biome check --staged>o",
			"holds more than",
			`'${BIOME_STAGED_COMMAND}' for the Biome part`,
		],
		[
			"input redirect with no space (#3191)",
			"biome check --staged<in",
			"holds more than",
			`'${BIOME_STAGED_COMMAND}' for the Biome part`,
		],
		...[
			"biome check --staged&>o",
			"biome check --staged&>>o",
			"biome check>o --staged",
			"biome check<in --staged",
			"biome>o check --staged",
		].map((script) => [
			`redirect touching a word: ${script} (#3191)`,
			script,
			"holds more than",
			"for the Biome part",
		]),
		...[
			"npx biome check --staged`x`",
			"biome check`x` --staged",
			"$(biome check --staged --verbose)",
			"`biome check --staged --verbose`",
		].map((script) => [
			`substitution: ${script} (#3191, #3545)`,
			script,
			UNREAD,
			`as an explicit '${BIOME_STAGED_COMMAND} <flags>'`,
		]),
		[
			"brace group, the Biome part still mapped (#3191)",
			"{ biome check --staged --verbose; }",
			"holds more than",
			`'${BIOME_STAGED_COMMAND} --verbose' for the Biome part`,
		],
		...[
			'"biome" check --staged',
			'biome check "--staged"',
			"biome check '--staged'",
			"biome check \\--staged",
			"biome 'check' --staged",
			// A quoted flag that would otherwise map is refused, not unquoted.
			'biome check --staged "--verbose"',
		].map((script) => [
			`quoted or backslashed word: ${JSON.stringify(script)} (#3414)`,
			script,
			"quotes or backslash-escapes a word",
			"Declare check_staged with every word unquoted and unescaped.",
		]),
		[
			"quoted word in a composite, the Biome part mapped unquoted (#3414)",
			'biome check "--staged" "--verbose" && tsc',
			"holds more than",
			`'${BIOME_STAGED_COMMAND} --verbose' for the Biome part`,
		],
		[
			"empty value",
			"biome check --staged --reporter=",
			"gives --reporter an empty value",
			"Declare check_staged with --reporter=<value>.",
		],
		[
			"npm exec",
			"npm exec -- biome check --staged",
			'through "npm exec -- biome"',
			'bare "biome check --staged …" script',
		],
		[
			"pnpm exec",
			"pnpm exec biome check --staged",
			'through "pnpm exec biome"',
			'bare "biome check --staged …" script',
		],
		[
			"pnpm",
			"pnpm biome check --staged",
			'through "pnpm biome"',
			'bare "biome check --staged …" script',
		],
		[
			"yarn",
			"yarn biome check --staged",
			'through "yarn biome"',
			'bare "biome check --staged …" script',
		],
		[
			"bunx",
			"bunx biome check --staged",
			'through "bunx biome"',
			'bare "biome check --staged …" script',
		],
		[
			"bun x",
			"bun x biome check --staged",
			'through "bun x biome"',
			'bare "biome check --staged …" script',
		],
		[
			"pinned version",
			"npx @biomejs/biome@1.9.4 check --staged",
			"pins Biome's version",
			`'${BIOME_STAGED_COMMAND} <flags>'`,
		],
		[
			"--changed",
			"biome check --staged --changed",
			"passes --changed",
			"Declare check_staged without '--changed'.",
		],
		[
			"--since",
			"biome check --staged --since=main",
			"passes --since",
			"Declare check_staged without '--since'.",
		],
		[
			"--watch",
			"biome check --staged --watch",
			"passes --watch",
			"Declare check_staged without '--watch'.",
		],
		[
			"--help",
			"biome check --staged --help",
			"passes --help",
			"Declare check_staged without '--help'.",
		],
		[
			"--",
			"biome check --staged --",
			"passes --,",
			"Declare check_staged without '--'.",
		],
		[
			"unknown flag",
			"biome check --staged --frobnicate",
			"passes --frobnicate, a flag not on",
			"whose flags you own",
		],
		[
			"switch given a value",
			"biome check --staged --verbose=true",
			"the switch --verbose a value",
			"Declare check_staged with the bare --verbose.",
		],
		[
			"--staged given a value",
			"biome check --staged=false",
			"the switch --staged a value",
			"Declare check_staged with the bare --staged.",
		],
	])("refuses the %s shape, naming the way out", (_, script, shape, wayOut) => {
		const c = classify(script);
		expect(c.kind).toBe("refused");
		const refusal = c.kind === "refused" ? c.refusal : "";
		expect(refusal).toContain(shape);
		expect(refusal).toContain(wayOut);
		expect(refusal).toMatch(/\(#2583\), and .+\. Declare check_staged /);
		expect(refusal).toContain(
			`through package.json script "check:staged" ("${script}")`,
		);
	});

	it("refuses where package.json declares no @biomejs/biome, naming devDependencies", () => {
		const c = classify("npx @biomejs/biome check --staged", { biome: false });
		expect(c.kind === "refused" && c.refusal).toContain(
			"declare @biomejs/biome, whose node_modules/.bin/biome biome-staged.js runs. Add @biomejs/biome to devDependencies.",
		);
	});

	it("refuses an explicit command that would map, naming the mapped one", () => {
		for (const command of [
			"npm run check:staged",
			// A runner flag after the name (#3153).
			"npm run check:staged --silent",
			"biome check --staged --write --no-errors-on-unmatched",
		]) {
			const c = classify(
				"biome check --staged --write --no-errors-on-unmatched",
				{
					inferred: false,
					command,
				},
			);
			const refusal = c.kind === "refused" ? c.refusal : "";
			expect(refusal).toContain("would map");
			expect(refusal).toContain(
				`as '${BIOME_STAGED_COMMAND} --no-errors-on-unmatched'`,
			);
		}
	});

	it.each(
		["pnpm", "yarn", "bun"].flatMap((runner) => [
			[runner, "--write", "would map (auto-fix on commit dropped", ""],
			[runner, "--verbose", "would map, and", " --verbose"],
		]),
	)(
		"refuses %s run with %s after the name as the script with it on the end (#3153, #3193)",
		(runner, flag, shape, carried) => {
			const c = classify("biome check --staged --no-errors-on-unmatched", {
				command: `${runner} run "check:staged" ${flag}`,
				inferred: false,
			});
			const refusal = c.kind === "refused" ? c.refusal : "";
			expect(refusal).toContain(
				`("biome check --staged --no-errors-on-unmatched"), handed ${flag},`,
			);
			expect(refusal).toContain(shape);
			expect(refusal).toContain(
				`Declare check_staged instead as '${BIOME_STAGED_COMMAND} --no-errors-on-unmatched${carried}'.`,
			);
			expect(refusal).not.toContain("a gate of its own");
		},
	);

	it.each([
		[
			"a value after a space",
			"--reporter json",
			"with the = form, --reporter=json",
		],
		["a path", "src", `as '${BIOME_STAGED_COMMAND}', with no path`],
	])(
		"refuses a pnpm run handing on %s, judged as the script's own (#3193)",
		(_, words, wayOut) => {
			const c = classify("biome check --staged", {
				command: `pnpm run check:staged ${words}`,
			});
			const refusal = c.kind === "refused" ? c.refusal : "";
			expect(refusal).toContain(`, handed ${words},`);
			expect(refusal).toContain(wayOut);
		},
	);

	it("maps an inferred pnpm run with the flag it hands on (#3193)", () => {
		expect(
			classify("biome check --staged", {
				command: "pnpm run check:staged --verbose",
			}),
		).toEqual({
			kind: "mapped",
			command: `${BIOME_STAGED_COMMAND} --verbose`,
		});
	});

	it.each([
		["pnpm run nosuch\nbiome check --staged", "holds more than"],
		["npm run check:staged -- --staged", "handed --staged,"],
		["pnpm run check:staged -- --staged", "handed -- --staged,"],
		["bun run check:staged -- --staged", "handed -- --staged,"],
		['yarn run check:staged "--staged"', "handed --staged,"],
		['concurrently "npm run nosuch" "biome check --staged"', "#2583"],
		['concurrently "npm run tsc" "biome check --staged"', "#2583"],
		["npm run nosuch biome check --staged", "#2583"],
		["pnpm run nosuch -- biome check --staged", "#2583"],
	])(
		"refuses %j, reading the words a run hands on (#3413)",
		(command, shape) => {
			const c = classify("biome check", { command, inferred: false });
			expect(c.kind === "refused" && c.refusal).toContain(shape);
		},
	);

	it.each([
		["npm run check:staged \\\n-- --staged", "handed --staged,"],
		["pnpm run check:staged \\\n--staged", "handed --staged,"],
		["pnpm run check:staged >o --staged", "holds more than"],
		["npm run check:staged -- 2>&1 --staged", "holds more than"],
		["pnpm run check:staged $(echo --staged)", UNREAD],
		["pnpm run check:staged `echo --staged`", UNREAD],
		["pnpm run check:staged $FLAGS", UNREAD],
		["yarn run check:staged $'--staged'", UNREAD],
		['pnpm run check:staged -- $"--staged"', UNREAD],
		["pnpm run check:staged --sta\\\nged", "handed --staged,"],
		["pnpm run check:staged --{staged,x}", UNREAD],
		["pnpm run check:staged $'\\x2d\\x2dstaged'", UNREAD],
		['pnpm run check:staged >"o x" --staged', "holds more than"],
	])(
		"refuses %j, reading a continuation, redirect, $-quote or expansion in the words a run hands on (#3422)",
		(command, shape) => {
			const c = classify("biome check", { command, inferred: false });
			expect(c.kind === "refused" && c.refusal).toContain(shape);
		},
	);

	it("maps an inferred continuation near a refused shape (#3422)", () => {
		expect(
			classify("biome check --staged", {
				command: "pnpm run check:staged \\\n--verbose",
			}),
		).toEqual({
			kind: "mapped",
			command: `${BIOME_STAGED_COMMAND} --verbose`,
		});
	});

	it.each([
		"eslint $'\\x'",
		"npm run $'\\x'",
		"biome check --staged $'\\x'",
		"biome check --staged $'\\u'",
		"biome check --staged $'\\U'",
		"biome check --staged $'\\U110000'",
	])("refuses %s as unreadable, never throwing (#3896)", (command) => {
		const c = classify("biome check --staged", { command });
		expect(c.kind === "refused" && c.refusal).toContain(UNREAD);
	});

	it.each([
		"yarn run check:staged $'--verbose'",
		'pnpm run check:staged $"--verbose"',
		"pnpm run $'check:staged' --verbose",
		"pnpm run check:staged --{verbose,json}",
	])(
		"refuses an inferred %j, which dash reads otherwise than bash (#3545)",
		(command) => {
			const c = classify("biome check --staged", { command });
			expect(c.kind === "refused" && c.refusal).toContain(UNREAD);
		},
	);

	it.each([
		"pnpm run nosuch\nbiome check",
		"pnpm run check:staged >o --verbose",
		"npm run check:staged --silent>o --staged",
		"npm run check:staged -- --verbose",
		"npm run check:staged --staged",
		'yarn run check:staged "--verbose"',
		'concurrently "npm run nosuch" "biome check"',
	])("leaves %j, which hands on no --staged, unclassified", (command) => {
		expect(classify("biome check", { command, inferred: false })).toEqual({
			kind: "none",
		});
	});

	it.each([
		["bi$@ome check --staged", UNREAD],
		["biome check --sta$@ged", UNREAD],
		["biome ch$1eck --staged", UNREAD],
		["$B check --staged", UNREAD],
		["biome check $'--stag\\x65d'", UNREAD],
		["biome check $'--staged'", UNREAD],
		['biome $"check" --staged', UNREAD],
		["$'bi\\x6fme' check --staged", UNREAD],
		["biome check {--staged,}", UNREAD],
		["{biome,check} --staged", UNREAD],
		["biome {check,--staged}", UNREAD],
		// A $(( whose first ( closes first is a subshell in a substitution.
		["echo $((cd /; biome check --staged) )", UNREAD],
		[
			"biome check --staged <<< x",
			`'${BIOME_STAGED_COMMAND}' for the Biome part`,
		],
		[
			'biome check --staged <<< "a b"',
			`'${BIOME_STAGED_COMMAND}' for the Biome part`,
		],
	])("refuses %j, its refusal naming %j (#3445)", (script, shape) => {
		const c = classify(script);
		expect(c.kind === "refused" && c.refusal).toContain(shape);
	});

	it.each([
		"npm run-script",
		"npm rum",
		"npm urn",
		"npm ur",
		"npm run-s",
		"npm runScript",
		"pnpm run-script",
	])("follows %s, the runner's own alias of run (#3627)", (verb) => {
		expect(
			classify("biome check --staged", { command: `${verb} check:staged` }),
		).toEqual({ kind: "mapped", command: BIOME_STAGED_COMMAND });
	});

	it.each(["yarn run-script", "bun rum", "pnpm urn", "npm ru"])(
		"does not follow %s, which runs no named script there (#3627)",
		(verb) => {
			expect(
				classify("biome check --staged", { command: `${verb} check:staged` }),
			).toEqual({ kind: "none" });
		},
	);

	it("follows a script name quoted in part (#3445)", () => {
		expect(
			classify("biome check --staged", { command: 'npm run check:"staged"' }),
		).toEqual({
			kind: "mapped",
			command: BIOME_STAGED_COMMAND,
		});
	});

	it("reads a single-quoted '$x' handed on as a literal (#3445)", () => {
		const c = classify("biome check --staged", {
			command: "pnpm run check:staged '$x'",
		});
		const refusal = c.kind === "refused" ? c.refusal : "";
		expect(refusal).toContain('passes the path "$x"');
		expect(refusal).not.toContain("expansion");
	});

	it("leaves a --staged in a comment unclassified (#3445)", () => {
		expect(classify("biome check # --staged")).toEqual({ kind: "none" });
	});

	it.each([
		"biome check $(git diff --name-only)",
		"pnpm run tsc $(echo --staged)",
		"cat <<E\n'\nE\nbiome check --staged",
		"eval 'biome check' --staged",
	])(
		"refuses %j, which it cannot read as dash would, unread (#3545)",
		(script) => {
			const c = classify(script);
			const refusal = c.kind === "refused" ? c.refusal : "";
			expect(refusal).toMatch(/^may run biome check --staged /);
			expect(refusal).toContain(UNREAD);
			expect(refusal).toContain(
				`as an explicit '${BIOME_STAGED_COMMAND} <flags>'`,
			);
		},
	);

	it.each([";", '"', "'", "$", "`", " "])(
		"maps a handed value holding %j quoted, so sh -c passes it exactly (#3545)",
		(ch) => {
			const value = `--only=a${ch}b`;
			const written = ch === "'" ? `"${value}"` : `'${value}'`;
			const c = classify("biome check --staged", {
				command: `pnpm run check:staged ${written}`,
			});
			const command = c.kind === "mapped" ? c.command : "";
			expect(command.startsWith(`${BIOME_STAGED_COMMAND} `)).toBe(true);
			const words = command.slice(BIOME_STAGED_COMMAND.length);
			expect(
				execFileSync("sh", ["-c", `printf '%s\\0'${words}`], {
					encoding: "utf8",
				}),
			).toBe(`${value}\0`);
		},
	);

	it("refuses an npm run whose flag a redirect follows with no space (#3193)", () => {
		const c = classify("biome check --staged", {
			command: "npm run check:staged --silent>o",
		});
		const refusal = c.kind === "refused" ? c.refusal : "";
		expect(refusal).toContain("holds more than");
	});

	it("refuses a script reached through a composite command", () => {
		const c = classify("biome check --staged", {
			command: "npm run check:staged && npm run tsc",
		});
		expect(c.kind === "refused" && c.refusal).toContain(
			`'${BIOME_STAGED_COMMAND}' for the Biome part`,
		);
	});

	it.each([
		[
			"a biome-staged.js command, unparsed",
			`${BIOME_STAGED_COMMAND} --reporter json`,
		],
		["a check with no --staged", "biome check --changed"],
		["an unrelated command", "eslint ."],
		["an npm run of an unrelated script", "npm run tsc"],
		// Fail-closed only where the text mentions Biome or a package manager
		// (#3545, #3851).
		[
			"an expansion with no biome and no package manager",
			"eslint $(git diff --cached)",
		],
		[
			"a brace expansion with no biome and no package manager",
			"prettier -c {a,b}.js",
		],
	])("leaves %s alone", (_, command) => {
		expect(
			classify("biome check --staged", { command, inferred: false }),
		).toEqual({ kind: "none" });
	});
});

describe("the check-staged CLI on #3545's fail-open shapes", () => {
	beforeEach(() => {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				scripts: { cs: "biome check --staged --no-errors-on-unmatched" },
				devDependencies: { "@biomejs/biome": "2.5.15" },
			}),
		);
	});

	it.each([
		// A substitution nested in ${…} or $((…)).
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		": ${X:-$(biome check --staged)}",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		': "${X:-`biome check --staged`}"',
		": $(( $(biome check --staged) ))",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		": ${X:-$(npm run cs)}",
		// Bash-only syntax, read otherwise by dash.
		": $'#\\' ; biome check --staged #'",
		"pnpm run cs --{verbose,json}",
		// An expansion in the check slot, or xargs.
		"biome $(echo check) --staged",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		"biome ${C:-check} --staged",
		"echo --staged | xargs biome check",
		// An expansion in a script name.
		"npm run cs$X",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		"npm run c${X}s",
		"node_modules/.bin/$B check --staged",
		// A quote or backslash splitting the mention, a shell reading stdin, a
		// hidden command name.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		': ${X:-$(bi""ome check --staged)}',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		": ${X:-$(b\\iome check --staged)}",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		": ${X:-$(npm r\\un cs)}",
		": $'#\\' ; bi\"\"ome check --staged #'",
		': $(( $(eval bi""ome check --staged) ))',
		'printf "biome check --st%sd" age | sh',
		"printf '\\142iome check --staged' | sh -s",
		'eval "$(printf x)"',
		'sh -c "$(printf x)"',
		"$(printf x)",
		"FOO=1 $(printf x)",
		"xargs $(printf x) < f",
		"parallel < f",
		"eval 'bi''ome check' --staged",
	])("refuses %j, naming an explicit biome-staged.js", (command) => {
		const r = run(command);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("may run biome check --staged");
		expect(r.stderr).toContain(
			`as an explicit '${BIOME_STAGED_COMMAND} <flags>'`,
		);
	});

	it.each([
		"eslint $(git diff --cached)",
		"prettier -c {a,b}.js",
		"git diff --cached --name-only | xargs eslint",
		"sh ./scripts/check.sh",
	])("passes %j, which mentions no biome and no package manager", (command) => {
		expect(run(command)).toMatchObject({ status: 0, stderr: "" });
	});
});

describe("the check-staged CLI on Biome evidence and what a runner runs (#3851)", () => {
	const Staged = "$(git diff --cached --name-only)";
	const NoPackageManager = [
		`uv run ruff check ${Staged}`,
		`pre-commit run --files ${Staged}`,
		"git diff --cached --name-only | xargs --no-run-if-empty eslint",
		`./scripts/run-lint.sh ${Staged}`,
	];

	const writePackage = (rel: string, pkg: object) => {
		fs.mkdirSync(path.join(dir, rel), { recursive: true });
		fs.writeFileSync(path.join(dir, rel, "package.json"), JSON.stringify(pkg));
	};

	describe("in a repo declaring Biome", () => {
		beforeEach(() => {
			writePackage(".", {
				scripts: {
					cs: "biome check --staged --no-errors-on-unmatched",
					cs2: "echo two",
					precs2: "biome check --staged",
					lint2: "echo lint",
					postlint2: "biome check --staged --write",
					test: "biome check --staged",
					start: "biome check --staged",
					stop: "biome check --staged",
					bc: "biome check",
					bl: "biome lint --staged",
					lint: "eslint",
					rs: "run-s cs",
				},
				devDependencies: { "@biomejs/biome": "2.5.15" },
			});
			writePackage("web", { scripts: { "web-cs": "biome check --staged" } });
			fs.mkdirSync(path.join(dir, "web/src"));
		});

		const NeverRewritten = "an explicit value is never rewritten";
		const HoldsMore = "holds more than that one command";
		const Through = "runs Biome through";
		const NotMapped = `in a shape biome-staged.js does not map. ${OWN_FLAGS_WAY_OUT}`;

		it.each([
			["yarn cs", NeverRewritten],
			["pnpm cs", NeverRewritten],
			["bun cs", NeverRewritten],
			["npm test", NeverRewritten],
			["npm t", NeverRewritten],
			["npm tst", NeverRewritten],
			["npm start", NeverRewritten],
			["npm stop", NeverRewritten],
			["bun test", NeverRewritten],
			["yarn cs run", 'passes the path "run"'],
			["pnpm cs run", 'passes the path "run"'],
			["bun cs run", 'passes the path "run"'],
			["pnpm --reporter silent run cs", NeverRewritten],
			["cd -- web && npm run web-cs", IN_WEB],
			["npx bi?me format --staged", NotMapped],
			["env bi?me format --staged", UNREAD],
			["do $X", UNREAD],
			["if true; then $X; fi", UNREAD],
			["! $X", UNREAD],
			["git ls-files | xargs -n 1 $X", UNREAD],
			["xargs -I {} $X {}", UNREAD],
			['sh -c "eslint $X"', UNREAD],

			["npm run cs2", HoldsMore],
			["npm run lint2", HoldsMore],
			["yarn cs2", HoldsMore],
			["npm restart", HoldsMore],
			["pnpm restart", HoldsMore],
			["npm run bc; npm run bc -- --staged", HoldsMore],
			["cd web || cd .; npm run cs", HoldsMore],
			["npm --prefix web run web-cs", IN_WEB],
			["npm --prefix=web run web-cs", IN_WEB],
			["npm -C web run web-cs", IN_WEB],
			["npm run --prefix web web-cs", IN_WEB],
			["npm run web-cs --prefix web", IN_WEB],
			["pnpm -C web web-cs", IN_WEB],
			["pnpm --dir=web run web-cs", IN_WEB],
			["yarn --cwd web web-cs", IN_WEB],
			["bun --cwd=web run web-cs", IN_WEB],
			["cd web && npm run web-cs", IN_WEB],
			["cd web/src && npm run web-cs", IN_WEB],
			["(cd web; npm run web-cs)", IN_WEB],
			["npm rum $S", UNREAD],
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			["npm urn c${X}s", UNREAD],
			["npm ur cs$X", UNREAD],
			["npm rum $(echo cs)", UNREAD],
			["npm $V cs", UNREAD],
			["npm --prefix $D run web-cs", UNREAD],
			["cd $D && npm run web-cs", UNREAD],
			["node_modules/.bin/bi?me check --staged", UNREAD],
			["node_modules/.bin/bi* check --staged", UNREAD],
			["node_modules/.bin/bi[o]me check --staged", UNREAD],
			["A=1 $X", UNREAD],
			["A=1 B=2 $X", UNREAD],
			["A=1 B=2 sh", UNREAD],
			["sh -c '$X'", UNREAD],
			["sh -c 'npm run $S'", UNREAD],
			["sh -c 'sh -c \"\\$X\"'", UNREAD],
			["node node_modules/.bin/bi?me check --staged", Through],
			["biome format --write --staged", NotMapped],
			["biome lint --staged", NotMapped],
			["npx biome format --staged", NotMapped],
			["yarn biome lint --staged", NotMapped],
			["biome --colors=off check --staged", NotMapped],
			["npm run bl", NotMapped],
		])("refuses %j, its refusal naming %j", (command, shape) => {
			const r = run(command);
			expect(r.stderr).toContain(shape);
			expect(r.status).toBe(1);
		});

		it.each(NoPackageManager)(
			"passes %j, which names no package manager",
			(command) => {
				expect(run(command)).toMatchObject({ status: 0, stderr: "" });
			},
		);

		it.each([
			"eslint $(git diff --cached)",
			"sh ./scripts/check.sh",
			"[ -f a ] && eslint",
			"biome check src/*.ts",
			"eslint src/*.js",
			"bundle exec rubocop $(git diff --cached --name-only)",
			"npm run lint",
			"yarn add cs2x",
			`./scripts/bun-lint.sh ${Staged}`,
			`./scripts/npm-check.sh ${Staged}`,
			`~/.bun/bin/ruff check ${Staged}`,
			"sh -c 'eslint $X'",
			"xargs eslint $X",
			"eslint src/*.js bi?me.js --staged",
		])(
			"passes %j, which reaches no Biome and no unread word beside a package manager",
			(command) => {
				expect(run(command)).toMatchObject({ status: 0, stderr: "" });
			},
		);

		it.each([
			`npm run lint -- ${Staged}`,
			`npx eslint ${Staged}`,
			`yarn eslint ${Staged}`,
			"git diff --cached --name-only | xargs npx eslint",
			`./run-biome.sh ${Staged}`,
			"$GATE",
		])("refuses %j unread, its way out a form the check passes", (command) => {
			const r = run(command);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("cannot be read");
			expect(r.stderr).toContain("as a shell file (sh ./your-gate.sh)");
			expect(r.stderr).toContain(`'${BIOME_STAGED_COMMAND} <flags>'`);
			expect(run("sh ./your-gate.sh").status).toBe(0);
			expect(run(`${BIOME_STAGED_COMMAND} --verbose`).status).toBe(0);
		});

		it.each([
			"node --run cs",
			"pnpm --filter web web-cs",
			"yarn workspace web web-cs",
			"pushd web; npm run web-cs",
			"env -C web npm run web-cs",
			"cd ~/web && npm run web-cs",
			"npm install-test",
			"pnpm --reporter silent cs",
			`./lint.sh ${Staged}`,
			"find . -exec $X ;",
			"su -c $X",
			"cat f | env --split-string=sh",
			"npm run c?",
			"biome check --st?ged",
			"npm run rs",
			"npm-run-all cs",
			"concurrently npm:cs",
			"turbo run cs",
			"nx run cs",
			"lerna run cs",
		])("leaves the stated residual %j unread", (command) => {
			expect(run(command).status).toBe(0);
		});

		describe("the seventh review's rows (#3944)", () => {
			it.each([
				["yarn run biome check --staged --write", Through],
				["bun run biome check --staged --write", Through],
				["yarn run biome check --staged && tsc", HoldsMore],
				["cd web && yarn run biome check --staged", IN_WEB],
				["cd web && biome check --staged", IN_WEB],
				["yarn --cwd web run biome check --staged", IN_WEB],
				["pnpm --dir web biome check --staged", IN_WEB],
				["cd web; biome check --staged", HoldsMore],
				["biome check --staged && cd web", HoldsMore],
				["npm ts", NeverRewritten],
				["pnpm t", NeverRewritten],
				["pnpm tst", NeverRewritten],
				["npm --prefix a --prefix web run web-cs", IN_WEB],
				["npm --prefix=a --prefix=web run web-cs", IN_WEB],
				["cat f | sh -s -- a", UNREAD],
				["cat f | sh -eo pipefail", UNREAD],
				["cat f | sh -o errexit -s a", UNREAD],
				["cat f | env sh", UNREAD],
				["cat f | env -i A=1 sh", UNREAD],
				["cat f | env -u A sh", UNREAD],
				["cat f | command sh", UNREAD],
				["cat f | exec sh", UNREAD],
				["env $X", UNREAD],
				["exec $X", UNREAD],
				["command $X", UNREAD],
				["time $X", UNREAD],
				["cat f | env -S sh", UNREAD],
				["cat f | nice -n 5 sh", UNREAD],
				["cat f | nohup sh", UNREAD],
			])("refuses %j, its refusal naming %j", (command, named) => {
				const r = run(command);
				expect(r.status).toBe(1);
				expect(r.stderr).toContain(named);
				expect(r.stderr).toContain("Declare check_staged");
			});

			it.each([
				"npm run biome check --staged",
				"pnpm run biome check --staged",
				"yarn t",
				"pnpm run t",
				"npm --prefix web --prefix a run web-cs",
				"sh ./gate.sh",
				"sh -e ./gate.sh",
				"sh -o errexit ./gate.sh",
				"env sh ./gate.sh",
				"env -u A sh ./gate.sh",
				"command sh ./gate.sh",
				"command -v sh",
			])("passes %j, which runs neither Biome nor stdin", (command) => {
				expect(run(command)).toMatchObject({ status: 0, stderr: "" });
			});

			it("keeps the outcome of a yarn or bun run naming a real script", () => {
				writePackage(".", {
					scripts: { biome: "eslint" },
					devDependencies: { "@biomejs/biome": "2.5.15" },
				});
				expect(run("yarn run biome check --staged").status).toBe(0);
				writePackage(".", {
					scripts: { biome: "biome" },
					devDependencies: { "@biomejs/biome": "2.5.15" },
				});
				const r = run("bun run biome check --staged --no-errors-on-unmatched");
				expect(r.status).toBe(1);
				expect(r.stderr).toContain(
					`Declare check_staged instead as '${BIOME_STAGED_COMMAND} --no-errors-on-unmatched'.`,
				);
			});

			it("refuses the script mantahostels declares, naming the mapped command", () => {
				writePackage(".", {
					scripts: {
						"check:staged":
							"biome check --staged --no-errors-on-unmatched --error-on-warnings",
					},
					devDependencies: { "@biomejs/biome": "2.5.15" },
				});
				const r = run("npm run check:staged");
				expect(r.status).toBe(1);
				expect(r.stderr).toContain(
					`Declare check_staged instead as '${BIOME_STAGED_COMMAND} --no-errors-on-unmatched --error-on-warnings'.`,
				);
			});

			it.skipIf(process.getuid?.() === 0)(
				"refuses a directory it cannot read, naming the path, and reads it once readable",
				() => {
					const web = path.join(dir, "web");
					fs.chmodSync(web, 0o000);
					try {
						const r = run("npm --prefix web run web-cs");
						expect(r.status).toBe(1);
						expect(r.stderr).toContain(
							`cannot be checked: ${path.join(web, "package.json")} cannot be read (EACCES`,
						);
						expect(r.stderr).toContain(BIOME_STAGED_COMMAND);
					} finally {
						fs.chmodSync(web, 0o755);
					}
					const r = run("npm --prefix web run web-cs");
					expect(r.status).toBe(1);
					expect(r.stderr).toContain(IN_WEB);
				},
			);
		});

		it.each([
			"biome format --write --staged",
			"biome lint --staged",
			"npm run bl",
		])("never maps %j, naming an explicit biome-staged.js", (command) => {
			const c = classifyCheckStaged(dir, command, { inferred: true });
			expect(c.kind).toBe("refused");
			expect(c.kind === "refused" && c.refusal).toContain(
				`'${BIOME_STAGED_COMMAND} <flags>'`,
			);
		});

		it("refuses a run in another directory, which biome-staged.js cannot follow", () => {
			const c = classifyCheckStaged(dir, "npm --prefix web run web-cs", {
				inferred: true,
			});
			expect(c.kind === "refused" && c.refusal).toContain(IN_WEB);
		});

		it("refuses a script a lifecycle script runs beside, which the mapped command would lose", () => {
			writePackage(".", {
				scripts: { cs: "biome check --staged", precs: "tsc" },
				devDependencies: { "@biomejs/biome": "2.5.15" },
			});
			const c = classifyCheckStaged(dir, "npm run cs", { inferred: true });
			expect(c.kind === "refused" && c.refusal).toContain(
				"holds more than that one command",
			);
		});

		it.each(["npm run cs", "pnpm cs", "yarn cs", "bun cs", "pnpm run cs"])(
			"maps %j, as the one adopter's shape must keep mapping",
			(command) => {
				writePackage(".", {
					scripts: {
						cs: "biome check --staged --no-errors-on-unmatched --error-on-warnings",
					},
					devDependencies: { "@biomejs/biome": "2.5.15" },
				});
				expect(classifyCheckStaged(dir, command, { inferred: true })).toEqual({
					kind: "mapped",
					command: `${BIOME_STAGED_COMMAND} --no-errors-on-unmatched --error-on-warnings`,
				});
			},
		);

		it("reads a run after cd && only in the directory it moved to, so a script there running no Biome passes (#2731's story 22)", () => {
			writePackage("web", { scripts: { test: "vitest" } });
			expect(run("cd web && npm test")).toMatchObject({
				status: 0,
				stderr: "",
			});
		});

		it("ends on a script handing itself ever more words", () => {
			writePackage(".", { scripts: { a: "npm run a x" } });
			expect(run("npm run a").status).toBe(0);
		});
	});

	describe("in a repo with no Biome evidence", () => {
		beforeEach(() => {
			writePackage(".", { scripts: { lint: "eslint ." } });
		});

		it.each([
			...NoPackageManager,
			`npm run lint -- ${Staged}`,
			"npm run $X",
			"$X",
			"$B check --staged",
			"sh -c '$X'",
			"cat f | sh",
			"parallel < f",
			"xargs $(printf x) < f",
			"tools/bi?me check --staged",
			"npm run lint -- bad $(x)",
		])("passes %j, as nothing here runs Biome", (command) => {
			expect(run(command)).toMatchObject({ status: 0, stderr: "" });
		});
	});

	describe("Biome evidence", () => {
		it("refuses a package.json it cannot read, naming the path and a true way out (#3944)", () => {
			fs.rmSync(path.join(dir, "package.json"));
			fs.mkdirSync(path.join(dir, "package.json"));
			const r = run("npm run $X");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				`cannot be checked: ${path.join(dir, "package.json")} cannot be read (EISDIR`,
			);
			expect(r.stderr).toContain(
				`Fix it, or declare check_staged in .claude/workflow-core.json as '${BIOME_STAGED_COMMAND} <flags>'`,
			);
			for (const wayOut of [BIOME_STAGED_COMMAND, "eslint ."])
				expect(run(wayOut)).toMatchObject({ status: 0, stderr: "" });
		});

		it("reads Biome declared only in a nested package as no evidence, until the command names it (#3944)", () => {
			writePackage(".", {});
			writePackage("web", {
				scripts: { cs: "biome check --staged" },
				devDependencies: { "@biomejs/biome": "2.5.15" },
			});
			expect(run("$GATE").status).toBe(0);
			const r = run("npm --prefix web run cs");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(IN_WEB);
		});

		it.each(["peerDependencies", "optionalDependencies"])(
			"counts @biomejs/biome in %s, though it maps only from the two others",
			(section) => {
				writePackage(".", { [section]: { "@biomejs/biome": "2.5.15" } });
				const r = run("npm run $X");
				expect(r.status).toBe(1);
				expect(r.stderr).toContain(UNREAD);
			},
		);

		it("reads no package.json in a directory a word only happens to name", () => {
			writePackage(".", {});
			fs.mkdirSync(path.join(dir, "bad"));
			fs.writeFileSync(path.join(dir, "bad/package.json"), "{ not json");
			expect(run("npm run lint -- bad $(x)")).toMatchObject({
				status: 0,
				stderr: "",
			});
		});

		it("counts a script mentioning biome, undeclared", () => {
			writePackage(".", { scripts: { fmt: "biome format ." } });
			const r = run("npm run $X");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(UNREAD);
		});

		it("counts biome written in the command itself", () => {
			writePackage(".", {});
			const r = run("biome check $(git diff --name-only)");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(UNREAD);
		});

		it("counts a package.json in a directory the command names", () => {
			writePackage(".", {});
			writePackage("web", { devDependencies: { "@biomejs/biome": "2.5.15" } });
			for (const command of [
				"cd web && npm run $X",
				"npm --prefix=web run $X",
			]) {
				const r = run(command);
				expect(r.status).toBe(1);
				expect(r.stderr).toContain(UNREAD);
			}
		});
	});
});

describe("inferCommands' node --test patterns (#3170)", () => {
	const write = (rel: string) => {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), "");
	};

	it.each([
		"lib/a.test.js",
		"lib/a-test.mjs",
		"lib/a_test.cjs",
		"lib/test-a.js",
		"lib/test.js",
		"test/a.js",
		"test/deep/helper.mjs",
	])("infers node --test from %s", (rel) => {
		write(rel);
		expect(inferCommands(dir).test?.command).toBe("node --test");
	});

	it.each([
		"lib/a.spec.js",
		"lib/a.test.ts",
		"lib/latest.js",
		"lib/contest-a.js",
		"tests/a.js",
		".test/a.js",
		"node_modules/dep/a.test.js",
	])("infers nothing from %s", (rel) => {
		write(rel);
		expect(inferCommands(dir).test).toBeUndefined();
	});
});
