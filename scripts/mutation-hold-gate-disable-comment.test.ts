// @vitest-environment node
/*
 * Pins the mutation hold's disable-comment check (#1909): which `Stryker
 * disable` comments a commit is charged for, read where Stryker 10's
 * instrumenter reads them.
 *
 * Driven through real `git commit`s in mutation-hold-testkit.ts's fixture
 * repo, so each case runs scripts/mutation-hold-gate.js and its Babel comment
 * read, scripts/lib/stryker-comments.js, for real. A file apart from
 * mutation-hold-gate.test.ts so that neither caps a CI job (#4943).
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from mutation-hold-gate.test.ts, whose cost was pre-existing; the
 * Babel child each case starts is most of it (#4943's profile).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFaultyGit } from "./lib/git-fault-fake";
import {
	changeLine2,
	commit,
	commitCount,
	expectHeld,
	expectLanded,
	expectRuleAppended,
	git,
	INSTALL,
	landHostConfig,
	MONEY,
	mutationHoldFixture,
	readLog,
	readRuns,
	repo,
	report,
	SEED,
	STUB_GIT_REFUSAL,
	scratch,
	write,
} from "./lib/mutation-hold-testkit";
import { shellQuote } from "./lib/sh-quote.js";

mutationHoldFixture();

/** A `git cat-file --batch` asked for `object` fails; every other call runs. */
const batchRefuses = (object: string) => ({
	WFC_GIT: writeFaultyGit(
		{ words: ["cat-file", "--batch"] },
		{
			script: `in="$(cat)"; case "$in" in *${shellQuote(object)}*) ${STUB_GIT_REFUSAL} ;; esac; printf '%s\\n' "$in" | "$REAL_GIT" "$@"; exit $?`,
		},
		{ under: scratch },
	).git,
});

describe("mutation-hold-gate.js — the disable comment (#1909)", () => {
	/** SEED with `comment` added above line 2, the fee guard. */
	const HangingBabel =
		"await new Promise(() => setInterval(() => {}, 1000));\nexport default {};\n";
	const HangTimeout = { WFC_MUTATION_COMMENTS_TIMEOUT_MS: "300" };
	const disableAbove = (comment: string) =>
		write(
			MONEY,
			SEED.replace("  if (amount > 100)", `  ${comment}\n  if (amount > 100)`),
		);

	it.each([
		"// Stryker disable next-line all",
		"// Stryker disable next-line ConditionalExpression:",
		"// Stryker disable next-line all:   ",
		"/* Stryker disable next-line all: */",
		"// Stryker disable StringLiteral,ObjectLiteral",
		"/* Stryker disable next-line all */ const x = a ? b : c;",
		"/* Stryker disable all */ const t = { a: 1 };",
	])("refuses an added %j, naming its line, and runs nothing", (comment) => {
		disableAbove(comment);
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain("stating no reason");
		expect(r.stderr).toContain("Say after a colon why");
		const printed = /^(\/\/.*|\/\*.*?\*\/)/.exec(comment)?.[1].trim();
		expect(r.stderr).toContain(`  lib/money.js:2  ${printed}`);
		expectRuleAppended(r);
		expect(readRuns()).toEqual([]);
	});

	it.each([
		[
			"a directive on its own line inside a block comment",
			"/*\nStryker disable next-line all\n*/",
			"/* Stryker disable next-line all */",
			3,
		],
		[
			"a line comment after a string holding //",
			'const u = "https://x"; // Stryker disable all',
			"// Stryker disable all",
			2,
		],
		[
			"a line comment after a string holding /*",
			'const s = "/*"; // Stryker disable next-line all',
			"// Stryker disable next-line all",
			2,
		],
	])(
		"refuses %s, as Babel's parser reads it (#2366)",
		(_, comment, printed, line) => {
			disableAbove(comment);
			const r = commit([MONEY]);
			expectHeld(r);
			expect(r.stderr).toContain(`  lib/money.js:${line}  ${printed}\n`);
			expect(readRuns()).toEqual([]);
		},
	);

	it.each([
		"/* Stryker disable next-line all: an unreachable guard */ // Stryker disable all",
		"/* Stryker disable all */ // Stryker disable next-line all: an unreachable guard",
	])(
		"refuses a line where any directive is unreasoned, naming it once: %j",
		(comment) => {
			disableAbove(comment);
			const r = commit([MONEY]);
			expectHeld(r);
			expect(r.stderr).toContain("stating no reason");
			expect(r.stderr.match(/ {2}lib\/money\.js:2 {2}/g)).toHaveLength(1);
		},
	);

	it.each([
		["lib/Widget.vue", 'setup lang="ts"', "const n: number = 1;"],
		["lib/Widget.vue", 'lang="tsx"', "const n = <b>{1 as number}</b>;"],
		["lib/page.html", 'type="text/typescript"', "const n: number = 1;"],
		["lib/Widget.svelte", 'lang="ts"', "const n: number = 1;"],
	])(
		"refuses an unreasoned directive in %s's <script %s> block, on its own line",
		(widget, attrs, code) => {
			write(
				widget,
				`<template>\n  <p>{{ "// Stryker disable all" }}</p>\n</template>\n<script ${attrs}>\n${code}\n// Stryker disable next-line all\nexport const m = n > 0;\n</script>\n`,
			);
			git("add", widget);
			const r = commit([widget]);
			expectHeld(r);
			expect(r.stderr).toContain(
				`  ${widget}:6  // Stryker disable next-line all\n`,
			);
			expect(r.stderr).not.toContain(`${widget}:2`);
			expect(r.stderr).not.toContain("could not read");
		},
	);

	it.each(['src="./a.js"', 'type="text/x-template"'])(
		"reads no <script %s> block, which Stryker does not parse",
		(attrs) => {
			const widget = "lib/Widget.vue";
			write(
				widget,
				`<script ${attrs}>\n// Stryker disable next-line all\nconst n: number = 1;\n</script>\n`,
			);
			git("add", widget);
			report([]);
			const r = commit([widget]);
			expect(r.status).toBe(0);
			expect(r.stderr).not.toContain("stating no reason");
			expect(r.stderr).not.toContain("could not read");
		},
	);

	it("charges no directive already in a block comment the commit adds a line to below its directive", () => {
		write(
			MONEY,
			SEED.replace(
				"  if (amount > 100)",
				"  /*\nStryker disable next-line all\n  */\n  if (amount > 100)",
			),
		);
		git("add", MONEY);
		git("commit", "-qm", "an old unreasoned comment, landed unheld");
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace("  */", "  a note\n  */"),
		);
		report([]);
		const before = commitCount();
		const r = commit([MONEY]);
		expect(r.stderr).not.toContain("stating no reason");
		expect(r.status).toBe(0);
		expect(commitCount()).toBe(before + 1);
	});

	it("refuses an old note the commit arms as a directive by editing the comment's opening line, naming its line (#2573)", () => {
		write(
			MONEY,
			SEED.replace(
				"  if (amount > 100)",
				"  /* note\nStryker disable all\n  */\n  if (amount > 100)",
			),
		);
		git("add", MONEY);
		git("commit", "-qm", "a note, no directive, landed unheld");
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace("  /* note", "  /*"),
		);
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain("  lib/money.js:3  /* Stryker disable all */\n");
		expect(readRuns()).toEqual([]);
	});

	it("refuses an old directive the commit arms by editing its enclosing block comment's delimiters, naming its line (#2624)", () => {
		write(
			MONEY,
			SEED.replace(
				"  if (amount > 100)",
				"  /* outer\n  // Stryker disable all\n  */\n  if (amount > 100)",
			),
		);
		git("add", MONEY);
		git(
			"commit",
			"-qm",
			"commented-out code holding a directive, landed unheld",
		);
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace("  /* outer", "  // outer")
				.replace("  */", "  // end"),
		);
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain("  lib/money.js:3  // Stryker disable all\n");
		expect(readRuns()).toEqual([]);
	});

	it("refuses an old note the commit arms by deleting a line inside its comment, where it adds a line to the file, naming its line (#2624)", () => {
		write(
			MONEY,
			SEED.replace(
				"  if (amount > 100)",
				"  /*\n  a note\nStryker disable all\n  */\n  if (amount > 100)",
			),
		);
		git("add", MONEY);
		git("commit", "-qm", "a note, no directive, landed unheld");
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace("  a note\n", "")
				.replace("amount * 0.2", "amount * 0.25"),
		);
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain("  lib/money.js:3  /* Stryker disable all */\n");
		expect(readRuns()).toEqual([]);
	});

	it.each([
		["babel.config.json", "#2573", '{ "plugins": ["./flow-syntax.js"] }\n'],
		[
			"babel.config.mjs",
			"top-level await, #2624",
			'await Promise.resolve();\nexport default { plugins: ["./flow-syntax.js"] };\n',
		],
	])(
		"refuses an unreasoned disable in a Flow file the host's %s parses, naming its line, not reporting it unread (%s)",
		(config, _, text) => {
			write(
				"flow-syntax.js",
				'module.exports = () => ({ manipulateOptions: (_, p) => p.plugins.push("flow") });\n',
			);
			write(config, text);
			git("add", "flow-syntax.js", config);
			git("commit", "-qm", "a host Babel config for Flow, landed unheld");
			write(
				MONEY,
				SEED.replace(
					"  if (amount > 100)",
					"  const n: number = 1;\n  // Stryker disable next-line all\n  if (amount > 100)",
				),
			);
			const r = commit([MONEY]);
			expect(r.status).toBe(1);
			expect(commitCount()).toBe(2);
			expect(r.stderr).not.toContain("could not read");
			expect(r.stderr).toContain(
				"  lib/money.js:3  // Stryker disable next-line all\n",
			);
			expect(readRuns()).toEqual([]);
		},
	);

	it("refuses an unreasoned disable in a file the host's Babel config parses only under its mutator.plugins, naming its line, not reporting it unread (#2624)", () => {
		write(
			"legacy-decorators.js",
			'module.exports = () => ({ manipulateOptions: (_, p) => p.plugins.push("decorators-legacy") });\n',
		);
		write("babel.config.json", '{ "plugins": ["./legacy-decorators.js"] }\n');
		write(
			"stryker.config.json",
			JSON.stringify({ testRunner: "vitest", mutator: { plugins: [] } }),
		);
		landHostConfig();
		disableAbove("// Stryker disable next-line all");
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).not.toContain("could not read");
		expect(r.stderr).toContain(
			"  lib/money.js:2  // Stryker disable next-line all\n",
		);
		expect(readRuns()).toEqual([]);
	});

	it("reads the disable comments only once the tools are installed, so a missing Stryker refuses first", () => {
		fs.rmSync(path.join(repo, "node_modules", "@stryker-mutator"), {
			recursive: true,
		});
		disableAbove("// Stryker disable next-line all");
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain(INSTALL);
		expect(r.stderr).not.toContain("stating no reason");
	});

	it.each([
		[
			"no instrumenter to load the parser beside",
			() =>
				fs.rmSync(
					path.join(repo, "node_modules/@stryker-mutator/instrumenter"),
					{
						recursive: true,
					},
				),
		],
		[
			"a file the parser will not read",
			() =>
				write(MONEY, `${fs.readFileSync(path.join(repo, MONEY), "utf8")}}}}\n`),
		],
	])(
		"leaves the file to Stryker, named and logged, where it has %s",
		(_, breakIt) => {
			disableAbove("// Stryker disable next-line all");
			breakIt();
			report([]);
			const r = commit([MONEY]);
			expect(r.status).toBe(0);
			expect(r.stderr).toContain(
				"could not read the added disable comments in lib/money.js: ",
			);
			expect(r.stderr).toContain("so Stryker alone judges them");
			expect(readRuns()).toHaveLength(1);
			expect(readLog()).toContain("a commit's disable comments went unchecked");
		},
	);

	it.each([
		"// Stryker disable next-line ConditionalExpression: the 100 tier is unreachable from checkout",
		"/* Stryker disable next-line all: an unreachable guard */",
	])("passes the same comment with a reason: %j", (comment) => {
		disableAbove(comment);
		report([{ line: 3, status: "Ignored" }]);
		expectLanded(commit([MONEY]));
		expect(readRuns()[0].config).toMatchObject({
			mutate: ["lib/money.js:2-2"],
		});
	});

	it.each([
		"//   Stryker disable next-line all",
		"/**\n   * Stryker disable next-line all\n   */",
		'const u = "// Stryker disable all";',
	])("refuses no comment Stryker reads as no directive: %j", (comment) => {
		disableAbove(comment);
		report([]);
		expectLanded(commit([MONEY]));
	});

	it("honours a reasoned region disable over a message table, judging the mutants Stryker ignores inside it", () => {
		write(
			MONEY,
			`${SEED}// Stryker disable StringLiteral,ObjectLiteral: display text only\nexport const MESSAGES = {\n  over: "Over the limit",\n  under: "Under the limit",\n};\n// Stryker restore StringLiteral,ObjectLiteral\n`,
		);
		report([
			{ line: 9, status: "Ignored", mutatorName: "ObjectLiteral" },
			{ line: 10, status: "Ignored", mutatorName: "StringLiteral" },
			{ line: 11, status: "Ignored", mutatorName: "StringLiteral" },
		]);
		const r = commit([MONEY]);
		expectLanded(r);
		expect(r.stderr).not.toContain("stating no reason");
		expect(readRuns()[0].config).toMatchObject({
			mutate: ["lib/money.js:8-13"],
		});
	});

	const landOldDirective = (seed = SEED) => {
		write(
			MONEY,
			`// fees\n// in pence\n${seed.replace(
				"  if (amount > 100)",
				"  // Stryker disable next-line all\n  // spare\n  if (amount > 100)",
			)}`,
		);
		git("add", MONEY);
		git("commit", "-qm", "an old unreasoned comment, landed unheld");
	};
	const changeTax = (t: string) => t.replace("amount * 0.2", "amount * 0.25");

	it.each([
		["adding a line below it", changeTax],
		["adding a line above it, moving it down", (t: string) => `// rates\n${t}`],
		[
			"deleting a line above it, moving it up",
			(t: string) => changeTax(t.replace("// in pence\n", "")),
		],
		[
			"replacing a line above it with two",
			(t: string) => t.replace("// in pence\n", "// in\n// pence\n"),
		],
		[
			"deleting the line just below it",
			(t: string) => changeTax(t.replace("  // spare\n", "")),
		],
	])(
		"charges no disable comment the commit did not add, %s (#2624)",
		(_, edit) => {
			landOldDirective();
			write(MONEY, edit(fs.readFileSync(path.join(repo, MONEY), "utf8")));
			report([]);
			const r = commit([MONEY]);
			expect(r.stderr).not.toContain("stating no reason");
			expect(r.status).toBe(0);
			expect(commitCount()).toBe(3);
		},
	);

	it("charges no old directive in a file HEAD's copy of will not parse, saying so (#2624)", () => {
		landOldDirective(`${SEED}}}}\n`);
		write(
			MONEY,
			changeTax(fs.readFileSync(path.join(repo, MONEY), "utf8")).replace(
				"}}}\n",
				"",
			),
		);
		report([]);
		const r = commit([MONEY]);
		expect(r.stderr).toContain("could not read lib/money.js at HEAD");
		expect(r.stderr).not.toContain("stating no reason");
		expect(r.status).toBe(0);
		expect(commitCount()).toBe(3);
		expect(readLog()).toContain(
			"could not read a file at HEAD — an old disable comment the commit arms went unchecked lib/money.js: ",
		);
	});

	it("refuses an old note armed by editing its comment's opening line where HEAD's copy will not parse (#2727)", () => {
		write(
			MONEY,
			`${SEED.replace(
				"  if (amount > 100)",
				"  /* note\nStryker disable all\n  */\n  if (amount > 100)",
			)}}}}\n`,
		);
		git("add", MONEY);
		git("commit", "-qm", "a note in a file that will not parse, landed unheld");
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace("  /* note", "  /*")
				.replace("}}}\n", ""),
		);
		const r = commit([MONEY]);
		expect(r.stderr).toContain("could not read lib/money.js at HEAD");
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain("  lib/money.js:3  /* Stryker disable all */\n");
		expect(readRuns()).toEqual([]);
	});

	it("refuses an old next-line directive the commit adds a line directly under (#2727)", () => {
		disableAbove("// Stryker disable next-line all");
		git("add", MONEY);
		git("commit", "-qm", "an old unreasoned comment, landed unheld");
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace(
					"all\n  if (amount > 100)",
					"all\n  const big = amount > 100;\n  if (amount > 100)",
				),
		);
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain(
			"  lib/money.js:2  // Stryker disable next-line all\n",
		);
		expect(readRuns()).toEqual([]);
	});

	/** HEAD holding `open` above fee and `close` between fee and tax, landed unheld. */
	const landRegion = (open: string, close: string) => {
		write(
			MONEY,
			SEED.replace(
				"export function fee",
				`${open}\nexport function fee`,
			).replace("export function tax", `${close}\nexport function tax`),
		);
		git("add", MONEY);
		git("commit", "-qm", "an old unreasoned region, landed unheld");
	};

	it.each([
		[
			"a restore of one mutator lifting no `all`",
			"// Stryker disable all",
			"// Stryker restore StringLiteral",
		],
		[
			"a restore lifting one of two mutators",
			"// Stryker disable StringLiteral,ObjectLiteral",
			"// Stryker restore ObjectLiteral",
		],
		[
			"a next-line restore",
			"// Stryker disable all",
			"// Stryker restore next-line all",
		],
	])(
		"refuses an old unreasoned region reaching a line the commit adds past %s (#2727)",
		(_, open, close) => {
			landRegion(open, close);
			write(MONEY, changeTax(fs.readFileSync(path.join(repo, MONEY), "utf8")));
			const r = commit([MONEY]);
			expect(r.status).toBe(1);
			expect(commitCount()).toBe(2);
			expect(r.stderr).toContain(`  lib/money.js:1  ${open}\n`);
			expect(readRuns()).toEqual([]);
		},
	);

	it("refuses an old unreasoned region the commit widens over a line it adds by deleting its restore (#2727)", () => {
		landRegion("// Stryker disable all", "// Stryker restore all");
		write(
			MONEY,
			changeTax(fs.readFileSync(path.join(repo, MONEY), "utf8")).replace(
				"// Stryker restore all\n",
				"",
			),
		);
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("  lib/money.js:1  // Stryker disable all\n");
	});

	it("refuses an old unreasoned region whose restore sits in code the commit leaves untouched (#2727)", () => {
		write(
			MONEY,
			`// Stryker disable all\n${SEED.replace("  return 0;", "  // Stryker restore all\n  return 0;")}`,
		);
		git("add", MONEY);
		git("commit", "-qm", "an old unreasoned region, landed unheld");
		write(MONEY, changeTax(fs.readFileSync(path.join(repo, MONEY), "utf8")));
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("  lib/money.js:1  // Stryker disable all\n");
	});

	it("charges no old unreasoned region inside code the commit leaves untouched (#2727)", () => {
		write(
			MONEY,
			SEED.replace("  return 0;", "  // Stryker disable all\n  return 0;"),
		);
		git("add", MONEY);
		git("commit", "-qm", "an old unreasoned region, landed unheld");
		write(MONEY, changeTax(fs.readFileSync(path.join(repo, MONEY), "utf8")));
		report([]);
		const r = commit([MONEY]);
		expect(r.stderr).not.toContain("stating no reason");
		expect(r.status).toBe(0);
	});

	it("charges no old unreasoned region in one <script> block, read for a line added above it, for a line the commit adds in another (#2727)", () => {
		const widget = "lib/Widget.vue";
		write(
			widget,
			"<script>\n// Stryker disable all\nexport const a = 1 > 0;\n</script>\n<script setup>\nconst b = 2 > 1;\n</script>\n",
		);
		git("add", widget);
		git("commit", "-qm", "an old unreasoned region, landed unheld");
		write(
			widget,
			fs
				.readFileSync(path.join(repo, widget), "utf8")
				.replace("<script>\n", "<script>\nconst z = 0;\n")
				.replace("2 > 1", "2 >= 1"),
		);
		report([]);
		const r = commit([widget]);
		expect(r.stderr).not.toContain("stating no reason");
		expect(r.status).toBe(0);
	});

	it.each([
		["// Stryker disable all", "// Stryker restore all"],
		[
			"// Stryker disable StringLiteral,ObjectLiteral",
			"// Stryker restore ObjectLiteral, StringLiteral",
		],
	])(
		"charges no old unreasoned region %j its restore closes above the lines the commit adds",
		(open, close) => {
			landRegion(open, close);
			write(MONEY, changeTax(fs.readFileSync(path.join(repo, MONEY), "utf8")));
			report([]);
			const r = commit([MONEY]);
			expect(r.stderr).not.toContain("stating no reason");
			expect(r.status).toBe(0);
			expect(commitCount()).toBe(3);
		},
	);

	it("reads the disable comments past a host Babel config printing on stdout (#2727)", () => {
		write(
			"babel.config.js",
			'console.log("hello from babel config");\nmodule.exports = {};\n',
		);
		landHostConfig();
		disableAbove("// Stryker disable next-line all");
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).not.toContain("could not read");
		expect(r.stderr).toContain(
			"  lib/money.js:2  // Stryker disable next-line all\n",
		);
	});

	it("reads the disable comments past a host Babel config whose timer outlives the read (#2727)", () => {
		write(
			"babel.config.js",
			"setInterval(() => {}, 1000);\nmodule.exports = {};\n",
		);
		landHostConfig();
		disableAbove("// Stryker disable next-line all");
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(r.stderr).not.toContain("could not read");
		expect(r.stderr).toContain(
			"  lib/money.js:2  // Stryker disable next-line all\n",
		);
	});

	it("leaves the file to Stryker, named and logged, where a host Babel config hangs the read past its timeout (#2727)", () => {
		write("babel.config.mjs", HangingBabel);
		landHostConfig();
		disableAbove("// Stryker disable next-line all");
		report([]);
		// A real hang on the real clock: the child's timeout is a spawnSync
		// option, reached by no fake timer. The read never ends, so any timeout
		// times out; 300 ms keeps the wait short.
		const r = commit([MONEY], { extra: HangTimeout });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"could not read the added disable comments in lib/money.js: timed out after 300 ms",
		);
		expect(readRuns()).toHaveLength(1);
		expect(readLog()).toContain("a commit's disable comments went unchecked");
	});

	it("starts no read of a staged file holding no directive, so a host Babel config that hangs it costs nothing (#4307)", () => {
		write("babel.config.mjs", HangingBabel);
		landHostConfig();
		changeLine2();
		report([]);
		const r = commit([MONEY], { extra: HangTimeout });
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("could not read");
		expect(readRuns()).toHaveLength(1);
		expect(readLog()).not.toContain("disable comments went unchecked");
	});

	it("leaves only the file whose staged copy git will not show to Stryker, named and logged (#2727)", () => {
		disableAbove("// Stryker disable next-line all");
		report([]);
		const r = commit([MONEY], { extra: batchRefuses(`:${MONEY}`) });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			`could not read the added disable comments in ${MONEY}: could not read a staged file: git cat-file failed while fetching ${MONEY} at the index: fatal: stub git will not answer`,
		);
		expect(r.stderr).not.toContain("NOT checked");
		expect(readRuns()).toHaveLength(1);
		expect(readLog()).toContain("a commit's disable comments went unchecked");
	});

	it("reads a file HEAD holds a directory at as unparseable, still refusing an added unreasoned directive, logged (#3174)", () => {
		git("rm", "-q", MONEY);
		write(`${MONEY}/x`, "x\n");
		git("add", "-A");
		git("commit", "-qm", "a directory at the file's path, landed unheld");
		fs.rmSync(path.join(repo, MONEY), { recursive: true });
		disableAbove("// Stryker disable next-line all");
		// Staged by hand: `commit -- lib/money.js` alone commits only the
		// directory's deletion, leaving the new file untracked and unheld.
		git("add", "-A");
		const r = commit([]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain(
			`could not read ${MONEY} at HEAD (could not read a file at HEAD: ${MONEY} at HEAD is not a file)`,
		);
		expect(r.stderr).toContain(
			"  lib/money.js:2  // Stryker disable next-line all\n",
		);
		expect(r.stderr).toContain("Say after a colon why");
		expect(readLog()).toContain(
			`could not read a file at HEAD — an old disable comment the commit arms went unchecked ${MONEY}: could not read a file at HEAD: ${MONEY} at HEAD is not a file`,
		);
	});

	it("reads a file whose HEAD copy git will not show as unparseable, still refusing an added unreasoned directive, logged (#2727)", () => {
		disableAbove("// Stryker disable next-line all");
		const r = commit([MONEY], { extra: batchRefuses(`HEAD:${MONEY}`) });
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(1);
		expect(r.stderr).toContain(
			`could not read ${MONEY} at HEAD (could not read a file at HEAD: git cat-file failed while fetching ${MONEY} at HEAD: fatal: stub git will not answer)`,
		);
		expect(r.stderr).toContain(
			"  lib/money.js:2  // Stryker disable next-line all\n",
		);
		expect(r.stderr).toContain("Say after a colon why");
		expect(readLog()).toContain(
			`could not read a file at HEAD — an old disable comment the commit arms went unchecked ${MONEY}: `,
		);
	});

	it("ships no mutator exclusion with the core, and passes the host's own as written", () => {
		changeLine2();
		report([]);
		expectLanded(commit([MONEY]));
		expect(readRuns()[0].config).not.toHaveProperty("mutator");
		write(
			"stryker.config.json",
			JSON.stringify({
				testRunner: "vitest",
				mutator: { excludedMutations: ["Regex"] },
			}),
		);
		landHostConfig();
		write(MONEY, SEED.replace("amount * 0.2", "amount * 0.25"));
		const r = commit([MONEY]);
		expect(r.status).toBe(0);
		expect(readRuns()[1].config).toMatchObject({
			mutator: { excludedMutations: ["Regex"] },
		});
	});
});
