// @vitest-environment node
/*
 * lib/infer-commands.js's `runsLintStaged` (#2587): a command runs lint-staged
 * itself, or through the `package.json` scripts it runs, however the call is
 * spelled. Its `classifyCheckStaged` (#2731): each `biome check --staged`
 * shape maps to biome-staged.js or is refused, naming the way out (#2599).
 * Its `inferCommands` infers `node --test` from node's own default test
 * patterns (#3170).
 *
 * A module test over a temp `package.json`, since both read only the scripts
 * it declares. Loosen a case and an unsafe `check_staged` passes init and the
 * pre-commit hook, linting or writing a neighbour's worktree bytes (#2583);
 * loosen the node patterns and a repo whose tests node never runs is handed
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
	runsLintStaged,
} from "./infer-commands.js";
import { runInProcess } from "./run-in-process";

let dir: string;

const UNREAD = "so whether it runs biome check --staged cannot be read";

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
		// A missing script's handed words stop at the line's end (#3413).
		"pnpm run nosuch\nlint-staged",
		'concurrently "pnpm run nosuch" "lint-staged"',
		"npm run nosuch lint-staged",
		"pnpm run nosuch -- lint-staged",
		'yarn run nosuch "lint-staged"',
		// A script name quoted in part (#3445).
		'npm run p"re"',
	])("counts %j", (command) => {
		expect(runsLintStaged(dir, command)).toBe(true);
	});

	it.each([
		"eslint --rule lint-staged-x .",
		"npm run lint-staged",
		"npm run missing",
		"npm run loop",
		"pnpm run nosuch\ntsc",
		'concurrently "pnpm run nosuch" "tsc"',
	])("does not count %j", (command) => {
		expect(runsLintStaged(dir, command)).toBe(false);
	});

	it("does not count a command running no script, reading no unparsable package.json (#3546)", () => {
		fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
		expect(runsLintStaged(dir, "eslint .")).toBe(false);
		expect(() => runsLintStaged(dir, "npm run pre")).toThrow(
			"package.json does not parse",
		);
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
		// Fail-closed only where the text mentions Biome or a run (#3545).
		["an expansion with no biome and no run", "eslint $(git diff --cached)"],
		["a brace expansion with no biome and no run", "prettier -c {a,b}.js"],
	])("leaves %s alone", (_, command) => {
		expect(
			classify("biome check --staged", { command, inferred: false }),
		).toEqual({ kind: "none" });
	});
});

describe("the check-staged CLI on #3545's fail-open shapes", () => {
	const Cli = path.join(__dirname, "infer-commands.js");

	beforeEach(() => {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				scripts: { cs: "biome check --staged --no-errors-on-unmatched" },
				devDependencies: { "@biomejs/biome": "2.5.15" },
			}),
		);
	});

	const run = (command: string) =>
		runInProcess(Cli, ["check-staged", command], { cwd: dir });

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
	])("passes %j, which mentions no biome and no run", (command) => {
		expect(run(command)).toMatchObject({ status: 0, stderr: "" });
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
