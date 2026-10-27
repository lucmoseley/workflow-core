// @vitest-environment node
/*
 * lib/infer-commands.js's `runsLintStaged` (#2587): a command runs lint-staged
 * itself, or through the `package.json` scripts it runs, however the call is
 * spelled. Its `classifyCheckStaged` (#2731): each `biome check --staged`
 * shape maps to biome-staged.js or is refused, naming the way out (#2599).
 *
 * A module test over a temp `package.json`, since both read only the scripts
 * it declares. Loosen a case and an unsafe `check_staged` passes init and the
 * pre-commit hook, linting or writing a neighbour's worktree bytes (#2583).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BIOME_STAGED_COMMAND,
	classifyCheckStaged,
	runsLintStaged,
} from "./infer-commands.js";

let dir: string;

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

describe("runsLintStaged", () => {
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
	])("counts %j", (command) => {
		expect(runsLintStaged(dir, command)).toBe(true);
	});

	it.each([
		"eslint --rule lint-staged-x .",
		"npm run lint-staged",
		"npm run missing",
		"npm run loop",
	])("does not count %j", (command) => {
		expect(runsLintStaged(dir, command)).toBe(false);
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
			"quoted program name",
			'"biome" check --staged',
			'runs Biome through ""biome""',
			'bare "biome check --staged …" script',
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

	it.each(["pnpm", "yarn", "bun"])(
		"refuses %s run with a flag after the name, which reaches the script (#3153)",
		(runner) => {
			const c = classify("biome check --staged", {
				command: `${runner} run check:staged --write`,
				inferred: false,
			});
			expect(c.kind === "refused" && c.refusal).toContain("holds more than");
		},
	);

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
	])("leaves %s alone", (_, command) => {
		expect(
			classify("biome check --staged", { command, inferred: false }),
		).toEqual({ kind: "none" });
	});
});
