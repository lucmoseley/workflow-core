// @vitest-environment node
/*
 * Pins that check-code-standards.js names every citation in the code standards
 * that no longer resolves, and every §N7 export nothing consumes, with the line
 * the reader must go to (mantahostels#1091, the ticket that built it;
 * mantahostels#1799).
 *
 * check-code-standards.js reads its scope from `git ls-files` and resolves
 * every path against the working directory, so it is exercised inside a
 * throwaway repository rather than against this one — a fixture pinned to this
 * repo's own docs/code-standards.md would go red the moment a citation in it
 * was repinned.
 *
 * The script is report-only and never gates, so almost every case here asserts
 * exit 0. What is actually under test is the MESSAGE: which fault
 * was named, and whether it carried the line the reader has to go to (§X3).
 *
 * It warns on every commit from .husky/pre-commit and backs `npm run
 * check:standards`: loosen a case and a stale pin goes unnamed, so a reviewer
 * cites a rule against the wrong lines and accuses clean code, or an export
 * nothing consumes goes unreported.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-code-standards.js");
const DOC = "docs/code-standards.md";
const ANCHORS = "scripts/code-standards-anchors.json";

let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/** Write a file and track it — `git ls-files` is the scope, so untracked is invisible. */
const track = (file: string, body: string) => {
	fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
	git("add", "--", file);
};

const doc = (body: string) => track(DOC, body);

const runAt = (dir: string, ...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: dir,
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const run = (...args: string[]) => runAt(repo, ...args);

const readAnchors = (): Record<string, string> =>
	JSON.parse(fs.readFileSync(path.join(repo, ANCHORS), "utf8"));

/** A source file whose quotable sentence sits on a known line. */
const SUBJECT = [
	"/*",
	" * a header line",
	" * the quoted sentence lives here",
	" */",
	"const x = 1;",
	"const y = 2;",
	"",
].join("\n");

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "code-standards-"));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("quotation-paired pins", () => {
	it("passes a quotation that still sits inside its cited range", () => {
		track("lib/a.ts", SUBJECT);
		doc('Rule — `lib/a.ts:2-4` *"the quoted sentence lives here"*\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
		expect(r.out).toContain("1 quotation(s) found verbatim");
	});

	it("reports a quotation that has moved, naming the line it is on now", () => {
		track("lib/a.ts", SUBJECT);
		doc('Rule — `lib/a.ts:5-6` *"the quoted sentence lives here"*\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("DRIFTED");
		expect(r.out).toContain("lib/a.ts:3");
		expect(r.out).toContain(`repin ${DOC}:1`);
	});

	it("reports a quotation absent from the whole file, distinctly from one that moved", () => {
		track("lib/a.ts", SUBJECT);
		doc('Rule — `lib/a.ts:2-4` *"a sentence nobody ever wrote anywhere"*\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("ABSENT");
		expect(r.out).not.toContain("DRIFTED");
		expect(r.out).toContain("fabricated");
	});

	it("reports a quotation that matches and then diverges as MISQUOTED, saying where", () => {
		track("lib/a.ts", SUBJECT);
		doc(
			'Rule — `lib/a.ts:2-4` *"the quoted sentence lives here on a line of its own"*\n',
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("MISQUOTED");
		expect(r.out).toContain("diverges");
		expect(r.out).toContain("lib/a.ts:3");
	});

	it("accepts a quotation running past the end of its cited range", () => {
		// A pin points at the line a quotation STARTS on, not at its last line.
		track("lib/a.ts", "/*\n * one two\n * three four\n */\n");
		doc('Rule — `lib/a.ts:2` *"one two three four"*\n');
		expect(run().out).toContain("OK:");
	});

	it("accepts an elided quotation, matching its fragments in order", () => {
		track("lib/a.ts", "/*\n * alpha beta gamma delta epsilon\n */\n");
		doc('Rule — `lib/a.ts:2` *"alpha beta … delta epsilon"*\n');
		expect(run().out).toContain("OK:");
	});

	it("still reports elided fragments that appear in the wrong order", () => {
		// The pair to the case above: an ellipsis must not become a wildcard that
		// accepts any two phrases from the file. Which of the two quotation faults
		// it lands as depends on how much of the opening fragment matches.
		track("lib/a.ts", "/*\n * alpha beta gamma delta epsilon\n */\n");
		doc('Rule — `lib/a.ts:2` *"delta epsilon … alpha beta"*\n');
		const r = run();
		expect(r.out).toMatch(/MISQUOTED|ABSENT/);
		expect(r.out).not.toContain("OK:");
	});

	it("accepts a quotation cut short with a full stop the source does not carry", () => {
		track("lib/a.ts", "/*\n * it runs on to say more\n */\n");
		doc('Rule — `lib/a.ts:2` *"it runs on."*\n');
		expect(run().out).toContain("OK:");
	});

	it('folds quote characters, which the *"…"* notation forces the document to swap', () => {
		track("lib/a.ts", '/*\n * passing for "no names found"\n */\n');
		doc("Rule — `lib/a.ts:2` *\"passing for 'no names found'\"*\n");
		expect(run().out).toContain("OK:");
	});

	it("accepts a quotation sitting in a sibling pin's range on the same line", () => {
		// #N6's shape: one sentence cited at two places at once ("repeated at
		// :228-230"), where insisting on the paired pin would report a quotation
		// that is demonstrably where the line says it is.
		track(
			"lib/a.ts",
			"/*\n * the shared sentence\n * filler\n * filler\n */\n",
		);
		doc('Rule — `lib/a.ts:2`, repeated at `:4`: *"the shared sentence"*\n');
		// The quotation pairs to `:4`; `lib/a.ts:2` is bare and wants an anchor.
		run("--review");
		expect(run().out).toContain("OK:");
	});

	it("reports a quotation in no pin's range on the line, against the nearest one", () => {
		track(
			"lib/a.ts",
			"/*\n * filler\n * the shared sentence\n * filler\n */\n",
		);
		doc('Rule — `lib/a.ts:2`, repeated at `:4`: *"the shared sentence"*\n');
		const r = run();
		expect(r.out).toContain("DRIFTED");
		expect(r.out).toContain("lib/a.ts:3");
	});
});

describe("pairing — what a quotation is answerable to", () => {
	it("leaves a quotation alone when the span before it is a path with no line number", () => {
		// The §N4 shape: a rule pins check.js, then quotes check-test-marker.js's
		// header, which carries no pin. Checking that quotation against the
		// check.js pin is a FALSE FINDING.
		track("lib/a.ts", SUBJECT);
		track("lib/b.ts", "/*\n * a different sentence entirely\n */\n");
		doc(
			'Rule — `lib/a.ts:2-4`, and `lib/b.ts` says *"a different sentence entirely"*\n',
		);
		// Unpaired, the pin is bare and wants an anchor like any other.
		run("--review");
		const r = run();
		expect(r.out).toContain("OK:");
		expect(r.out).toContain("0 quotation(s)");
	});

	it("does check a quotation whose nearest preceding span is a pin", () => {
		track("lib/a.ts", SUBJECT);
		doc(
			'Rule — `lib/a.ts` at `lib/a.ts:5-6` *"the quoted sentence lives here"*\n',
		);
		expect(run().out).toContain("DRIFTED");
	});

	it("pairs a quotation that opens the sentence with the pin that follows it", () => {
		track("lib/a.ts", SUBJECT);
		doc('Rule — *"the quoted sentence lives here"* (`lib/a.ts:5-6`)\n');
		expect(run().out).toContain("DRIFTED");
	});

	it("reads no pin out of a backticked path inside a quotation", () => {
		// Quotations quote source that itself contains backticked paths. Scanning
		// them for spans invents citations and corrupts the inheritance a bare pin
		// walks.
		track("lib/a.ts", "/*\n * see `lib/phantom.ts:9` for the rest\n */\n");
		doc('Rule — `lib/a.ts:2` *"see `lib/phantom.ts:9` for the rest"*\n');
		const r = run();
		expect(r.out).toContain("OK:");
		expect(r.out).toContain("1 citation(s)");
		expect(r.out).not.toContain("phantom");
	});

	it("resolves a bare pin against the unpinned path named earlier on its line", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts`, which owns the shape (`:5-6`)\n");
		const r = run();
		expect(r.out).toContain("UNANCHORED");
		expect(r.out).toContain("lib/a.ts:5-6");
		expect(r.out).not.toContain("UNRESOLVED");
	});

	it("reports a bare pin with no path anywhere on its line", () => {
		// The pair: inheritance is within the line and never across one, so a pin
		// that inherits from the paragraph above must be refused, not guessed.
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:2-4`\n\nAnother rule — (`:5-6`)\n");
		expect(run().out).toContain("UNRESOLVED");
	});

	it("resolves a citation given by basename alone", () => {
		track("lib/review/strip.ts", SUBJECT);
		doc('Rule — `strip.ts:2-4` *"the quoted sentence lives here"*\n');
		expect(run().out).toContain("OK:");
	});

	it("refuses to guess a basename two tracked files share", () => {
		track("lib/a/strip.ts", SUBJECT);
		track("lib/b/strip.ts", SUBJECT);
		doc('Rule — `strip.ts:2-4` *"the quoted sentence lives here"*\n');
		const r = run();
		expect(r.out).toContain("AMBIGUOUS-PATH");
		expect(r.out).toContain("cite the full path");
	});
});

describe("the file behind the pin", () => {
	it("reports a cited path that no longer exists", () => {
		doc('Rule — `lib/gone.ts:2-4` *"anything"*\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("MISSING-PATH");
		expect(r.out).toContain("lib/gone.ts");
	});

	it("reports a pin pointing past the end of its file", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:400-410`\n");
		const r = run();
		expect(r.out).toContain("OUT-OF-RANGE");
		expect(r.out).toContain("points past its end");
	});

	it("reports a reversed range, whose start is the only end past the file", () => {
		// `400-2` is the only shape where the start overruns and the end does not.
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:400-2`\n");
		expect(run().out).toContain("OUT-OF-RANGE");
	});

	it("reports a range whose END overruns the file, not just its start", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:2-400`\n");
		expect(run().out).toContain("OUT-OF-RANGE");
	});
});

describe("bare pins — the hunk digest", () => {
	it("reports a bare pin with no anchor, naming the command that clears it", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6`\n");
		const r = run();
		expect(r.out).toContain("UNANCHORED");
		expect(r.out).toContain("--review lib/a.ts:5-6");
	});

	it("passes once the pin is anchored", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6`\n");
		expect(run("--review").status).toBe(0);
		expect(readAnchors()["lib/a.ts:5-6"]).toMatch(/^[0-9a-f]{16}$/);
		const r = run();
		expect(r.out).toContain("OK:");
		expect(r.out).toContain("1 bare pin(s) unchanged");
	});

	it("reports a bare pin whose cited lines have changed since they were read", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6`\n");
		run("--review");
		track("lib/a.ts", SUBJECT.replace("const y = 2;", "const y = 99;"));
		const r = run();
		expect(r.out).toContain("MOVED");
		expect(r.out).toContain("re-read them against the rule");
	});

	it("stays silent when a change lands outside the cited lines", () => {
		// Pairs with the case above: a whole-file digest fires here, which is why mantahostels#1091 rejected one.
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6`\n");
		run("--review");
		track(
			"lib/a.ts",
			SUBJECT.replace("a header line", "a rewritten header line"),
		);
		expect(run().out).toContain("OK:");
	});

	it("reports an anchor no bare pin cites any more", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6`\n");
		run("--review");
		doc("Rule — the pin is gone\n");
		expect(run().out).toContain("ORPHAN-ANCHOR");
	});

	it("drops orphans on a bare --review and keeps them on a targeted one", () => {
		track("lib/a.ts", SUBJECT);
		track("lib/b.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6` and `lib/b.ts:5-6`\n");
		run("--review");
		doc("Rule — `lib/a.ts:5-6`\n");
		run("--review", "lib/a.ts:5-6");
		expect(Object.keys(readAnchors())).toContain("lib/b.ts:5-6");
		run("--review");
		expect(Object.keys(readAnchors())).toEqual(["lib/a.ts:5-6"]);
	});

	it("takes a bare path as every pin into that file", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6` and `lib/a.ts:2-4`\n");
		run("--review", "lib/a.ts");
		expect(Object.keys(readAnchors()).sort()).toEqual([
			"lib/a.ts:2-4",
			"lib/a.ts:5-6",
		]);
	});

	it("says so when a --review argument matches no bare pin, rather than anchoring nothing quietly", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6`\n");
		const r = run("--review", "lib/typo.ts:1-2");
		expect(r.out).toContain("no bare pin matches it");
	});

	it("never anchors a quotation-paired pin, which is verified verbatim instead", () => {
		track("lib/a.ts", SUBJECT);
		doc('Rule — `lib/a.ts:2-4` *"the quoted sentence lives here"*\n');
		run("--review");
		expect(Object.keys(readAnchors())).toEqual([]);
	});
});

describe("the alphabet — what gates and what does not", () => {
	it("never gates: every finding is WARN and the exit stays 0", () => {
		doc("Rule — `lib/gone.ts:1-2` and `lib/also-gone.ts:3`\n");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN:");
	});

	it("SKIPs a --review when the document itself is absent — the subject, not the apparatus", () => {
		track("lib/a.ts", SUBJECT);
		const r = run("--review");
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP:");
	});

	it("still judges the exports when no document exists, whose subject is the code (#1376)", () => {
		track(
			"scripts/thing.js",
			"function spare() {}\n\nmodule.exports = { spare };\n",
		);
		track("scripts/thing.test.ts", 'import { spare } from "./thing";\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(`${DOC} could not be read`);
		expect(r.out).toContain("DEAD-EXPORT  scripts/thing.js  spare");
		expect(r.out).toContain("only tests consume spare");
	});

	it("is BROKEN when git cannot enumerate the tracked set", () => {
		// git is what it READS THE REPO WITH, so its failure gates (check.js:16-26).
		const bare = fs.mkdtempSync(
			path.join(os.tmpdir(), "code-standards-nogit-"),
		);
		fs.mkdirSync(path.join(bare, "docs"), { recursive: true });
		fs.writeFileSync(path.join(bare, DOC), "Rule — `lib/a.ts:1-2`\n");
		try {
			const r = runAt(bare);
			expect(r.status).toBe(2);
			expect(r.out).toContain("BROKEN:");
		} finally {
			fs.rmSync(bare, { recursive: true, force: true });
		}
	});

	it("refuses --review with --json, which would describe a run that never happened", () => {
		doc("Rule — `lib/a.ts:1-2`\n");
		const r = run("--review", "--json");
		expect(r.status).toBe(2);
		expect(r.out).toContain("no --json form");
	});

	it("carries the counts in its --json envelope", () => {
		track("lib/a.ts", SUBJECT);
		doc(
			'Rule — `lib/a.ts:2-4` *"the quoted sentence lives here"* and `lib/a.ts:5-6`\n',
		);
		const r = run("--json");
		const envelope = JSON.parse(r.out);
		expect(envelope.checker).toBe("code-standards");
		expect(envelope.citations).toBe(2);
		expect(envelope.quotations).toBe(1);
		expect(envelope.barePins).toBe(1);
	});
});

describe("--touching — a diff-scoped report (mantahostels#2631)", () => {
	/* Not lib/check.js's --against fault-diff: this filters ONE run's findings,
	 * so an already-stale backlog entry can resurface on a doc-prose edit even
	 * with its cited file untouched — see check-code-standards.js:27-43. */
	const commit = (msg: string) => git("commit", "-m", msg);
	const readHead = () => git("rev-parse", "HEAD").trim();

	it("keeps a pre-existing stale pin whose cited file the diff never touches out of the report, even while the unscoped run still carries it", () => {
		track("lib/a.ts", SUBJECT);
		track("lib/b.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6` and `lib/b.ts:5-6`\n");
		run("--review");
		commit("anchor both");
		track("lib/b.ts", SUBJECT.replace("const y = 2;", "const y = 99;"));
		git("add", "--", "lib/b.ts");
		commit("lib/b.ts drifts, unrelated to the diff under test");
		const scopeRev = readHead();

		const full = run();
		expect(full.out).toContain("MOVED");
		expect(full.out).toContain("lib/b.ts:5-6");

		const scoped = run("--touching", scopeRev);
		expect(scoped.out).not.toContain("lib/b.ts:5-6");
		expect(scoped.out).toContain("OK:");
	});

	it("surfaces a citation once its cited file is what the diff touches", () => {
		track("lib/a.ts", SUBJECT);
		track("lib/b.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6` and `lib/b.ts:5-6`\n");
		run("--review");
		commit("anchor both");
		track("lib/b.ts", SUBJECT.replace("const y = 2;", "const y = 99;"));
		git("add", "--", "lib/b.ts");
		commit("lib/b.ts drifts, unrelated to the diff under test");
		const scopeRev = readHead();

		track("lib/a.ts", SUBJECT.replace("const y = 2;", "const y = 99;"));
		const r = run("--touching", scopeRev);
		expect(r.out).toContain("MOVED");
		expect(r.out).toContain("lib/a.ts:5-6");
		expect(r.out).not.toContain("lib/b.ts:5-6");
	});

	it("surfaces a pin sitting on a document line the diff touched, even with its cited file untouched", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:5-6`\n");
		run("--review");
		commit("anchor");
		track("lib/a.ts", SUBJECT.replace("const y = 2;", "const y = 99;"));
		git("add", "--", "lib/a.ts");
		commit("lib/a.ts drifts, unrelated to the diff under test");
		const scopeRev = readHead();

		doc("Rule with reworded prose — `lib/a.ts:5-6`\n");
		const r = run("--touching", scopeRev);
		expect(r.out).toContain("MOVED");
		expect(r.out).toContain("lib/a.ts:5-6");
	});

	it("scopes a DEAD-EXPORT finding the same way, by the file it names", () => {
		doc("Rule — see below\n");
		track(
			"scripts/thing.js",
			"function spare() {}\nspare();\n\nmodule.exports = {\n\tspare,\n};\n",
		);
		track(
			"scripts/other.js",
			"function stray() {}\nstray();\n\nmodule.exports = {\n\tstray,\n};\n",
		);
		commit("both files, both dead");
		const scopeRev = readHead();

		track(
			"scripts/thing.js",
			"function spare() {}\nfunction extra() {}\nspare();\nextra();\n\nmodule.exports = {\n\tspare,\n};\n",
		);
		const r = run("--touching", scopeRev);
		expect(r.out).toContain("scripts/thing.js");
		expect(r.out).not.toContain("scripts/other.js");
	});

	it("needs a rev", () => {
		doc("Rule — `lib/a.ts:1-2`\n");
		const r = run("--touching");
		expect(r.status).toBe(2);
		expect(r.out).toContain("needs a value");
	});

	it("refuses combining with --review, which re-anchors rather than reporting", () => {
		doc("Rule — `lib/a.ts:1-2`\n");
		const r = run("--review", "--touching", "HEAD");
		expect(r.status).toBe(2);
		expect(r.out).toContain("Not both at once");
	});
});

describe("§N7 export blocks", () => {
	const docline = "Rule — see below\n";

	it("reports an exported name no other tracked file spells, naming file and name", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"function used() {}\nfunction spare() {}\nused();\nspare();\n\nmodule.exports = {\n\tused,\n\tspare,\n};\n",
		);
		track("scripts/caller.js", 'require("./thing").used();\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("DEAD-EXPORT");
		expect(r.out).toContain("scripts/thing.js");
		expect(r.out).toContain("spare");
		expect(r.out).not.toContain("used\n");
	});

	it("reads the in-place exports.<name> run a file in a require cycle keeps", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"function used() {}\nfunction spare() {}\nfunction kept() {}\nused();\nspare();\nkept();\n\nexports.used = used;\nexports.spare = spare;\n// scripts/later.js wants it (#1)\nexports.kept = kept;\n",
		);
		track("scripts/caller.js", 'require("./thing").used();\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("DEAD-EXPORT  scripts/thing.js  spare");
		expect(r.out).not.toContain("thing.js  used");
		expect(r.out).not.toContain("thing.js  kept");
	});

	it("reads a re-export in the run, and a run code follows as no run at all", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			'const other = require("./other");\n\nexports.spare = other.spare;\n',
		);
		track(
			"scripts/later.js",
			"function stray() {}\nstray();\nexports.stray = stray;\nstray();\n",
		);
		const r = run();
		expect(r.out).toContain("DEAD-EXPORT  scripts/thing.js  spare");
		expect(r.out).not.toContain("scripts/later.js");
	});

	it("says nothing about a name another tracked file spells", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"function used() {}\n\nmodule.exports = {\n\tused,\n};\n",
		);
		track("scripts/caller.js", 'require("./thing").used();\n');
		expect(run().out).not.toContain("DEAD-EXPORT");
	});

	it("counts a name spelled only in a data file as a consumer, where the file also names the module", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"function byName() {}\n\nmodule.exports = {\n\tbyName,\n};\n",
		);
		track(
			"scripts/needles.json",
			'{ "script": "scripts/thing.js", "call": "byName" }\n',
		);
		expect(run().out).not.toContain("DEAD-EXPORT");
	});

	describe("a speller counts only where it reaches the exporting module (#1616)", () => {
		const review =
			"function review() {}\nreview();\n\nmodule.exports = {\n\treview,\n};\n";

		it("reports a common-word export that only an unrelated file spells", () => {
			doc(docline);
			track("scripts/thing.js", review);
			track("scripts/thing.test.ts", 'import { review } from "./thing";\n');
			// Spells the word, and names a `thing` only in prose, never as a path.
			track(
				"scripts/other.js",
				'require("./elsewhere").review();\n// the thing to review\n',
			);
			const r = run();
			expect(r.out).toContain("DEAD-EXPORT  scripts/thing.js  review");
			expect(r.out).toContain("only tests consume review");
		});

		it("counts a dynamic require through path.join", () => {
			doc(docline);
			track("scripts/thing.js", review);
			track(
				"scripts/caller.js",
				'require(path.join(__dirname, "thing.js")).review();\n',
			);
			expect(run().out).not.toContain("DEAD-EXPORT");
		});

		it("counts a file naming the module in a spawned command", () => {
			doc(docline);
			track("scripts/thing.js", review);
			track("scripts/caller.sh", 'node scripts/thing.js --mode "review"\n');
			expect(run().out).not.toContain("DEAD-EXPORT");
		});

		it("does not let a caller of one exporter vouch for another exporting the same name", () => {
			doc(docline);
			track("scripts/thing.js", review);
			track("scripts/lib/other.js", review);
			track("scripts/caller.js", 'require("./thing").review();\n');
			const r = run();
			expect(r.out).toContain("scripts/lib/other.js  review");
			expect(r.out).not.toContain("scripts/thing.js  review");
		});

		it("does not take a directory of the module's name as reaching it", () => {
			doc(docline);
			track("scripts/thing.js", review);
			track("scripts/caller.js", 'require("./thing/inner").review();\n');
			expect(run().out).toContain("DEAD-EXPORT  scripts/thing.js  review");
		});
	});

	it("exempts an entry carrying a comment directly above it", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"function spare() {}\nspare();\n\nmodule.exports = {\n\t// Kept for check-later.js, which lands with #999.\n\tspare,\n};\n",
		);
		expect(run().out).not.toContain("DEAD-EXPORT");
	});

	it("scans every name in the one-line export form, not just the first", () => {
		// Biome writes a short block on one line, so both spellings are live in
		// the corpus and a line-per-entry split sees only the whole line.
		doc(docline);
		track(
			"scripts/thing.js",
			"function used() {}\nfunction spare() {}\nused();\nspare();\n\nmodule.exports = { used, spare };\n",
		);
		track("scripts/caller.js", 'require("./thing").used();\n');
		const r = run();
		expect(r.out).toContain("DEAD-EXPORT");
		expect(r.out).toContain("spare");
	});

	it("leaves a .js outside §N7's scope alone", () => {
		doc(docline);
		track(
			"lib/thing.js",
			"function spare() {}\nspare();\n\nmodule.exports = {\n\tspare,\n};\n",
		);
		expect(run().out).not.toContain("DEAD-EXPORT");
	});

	it("counts the names it cleared in the OK line, and carries them in --json", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"function used() {}\nused();\n\nmodule.exports = {\n\tused,\n};\n",
		);
		track("scripts/caller.js", 'require("./thing").used();\n');
		expect(run().out).toContain(
			"every one of 1 name(s) across 1 §N7 export block(s)",
		);
		const envelope = JSON.parse(run("--json").out);
		expect(envelope.exportBlocks).toBe(1);
		expect(envelope.exportedNames).toBe(1);
		expect(envelope.exports_dead).toEqual([]);
	});
	it("reports two files exporting one name and neither consuming it, rather than letting them vouch for each other", () => {
		// A speller is a consumer only if it does not define the name itself.
		doc(docline);
		const body =
			"function shared() {}\nshared();\n\nmodule.exports = {\n\tshared,\n};\n";
		track("scripts/one.js", body);
		track("scripts/two.js", body);
		const r = run();
		expect(r.out).toContain("scripts/one.js");
		expect(r.out).toContain("scripts/two.js");
		expect(JSON.parse(run("--json").out).exports_dead).toHaveLength(2);
	});

	it("treats a caller that rebinds the import under the same name as a consumer", () => {
		// A definer by its `const`, and a real consumer by the property it reads.
		doc(docline);
		track(
			"scripts/thing.js",
			"const HINT = /x/;\nHINT.test('x');\n\nmodule.exports = {\n\tHINT,\n};\n",
		);
		track(
			"scripts/caller.js",
			'const HINT = require("./thing").HINT;\nHINT.test("y");\n',
		);
		expect(run().out).not.toContain("DEAD-EXPORT");
	});

	it("carries the file to go to in its --json finding, not only in the prose", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"function spare() {}\nspare();\n\nmodule.exports = {\n\tspare,\n};\n",
		);
		const [finding] = JSON.parse(run("--json").out).exports_dead;
		expect(finding.where).toBe("scripts/thing.js");
		expect(finding.pin).toBe("spare");
	});

	it("takes a comment above a one-line block as the reason for every name in it", () => {
		// The one-line form has no per-entry line to carry a comment.
		doc(docline);
		track(
			"scripts/thing.js",
			"function spare() {}\nspare();\n\n// Kept for check-later.js, which lands with #999.\nmodule.exports = { spare };\n",
		);
		expect(run().out).not.toContain("DEAD-EXPORT");
	});

	it("reads the last export block, so a header comment quoting the form cannot hijack the file", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"/*\n*/\nmodule.exports = {\n\tdecoy,\n};\nfunction spare() {}\nspare();\n\nmodule.exports = {\n\tspare,\n};\n",
		);
		const r = run();
		expect(r.out).toContain("spare");
		expect(r.out).not.toContain("decoy");
	});

	describe("a name only tests consume (#1348's §G6, #1361)", () => {
		const spare =
			"function spare() {}\nspare();\n\nmodule.exports = {\n\tspare,\n};\n";

		it("reports it like a name nothing consumes, naming the tests that do", () => {
			doc(docline);
			track("scripts/thing.js", spare);
			track("scripts/thing.test.ts", 'import { spare } from "./thing";\n');
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).toContain("DEAD-EXPORT  scripts/thing.js  spare");
			expect(r.out).toContain(
				"only tests consume spare — scripts/thing.test.ts",
			);
			expect(r.out).toContain(
				"Test through the program or the exports its real callers use and drop the export",
			);
			expect(r.out).toContain("a comment is no fix");
			const envelope = JSON.parse(run("--json").out);
			expect(envelope.exports_dead).toHaveLength(1);
			expect(envelope.exportsTestOnly).toBe(1);
		});

		it("counts test support as a test: a testkit, harness, fixture, stub or fake, and a fixtures directory", () => {
			doc(docline);
			track("scripts/thing.js", spare);
			for (const support of [
				"scripts/lib/thing-testkit.ts",
				"scripts/lib/gate-harness.js",
				"scripts/lib/probe-fixture.ts",
				"scripts/lib/port-stub.ts",
				"scripts/lib/fake-port.ts",
				"scripts/lib/fixtures/probe.js",
			])
				track(support, 'require("../thing").spare;\n');
			expect(JSON.parse(run("--json").out).exportsTestOnly).toBe(1);
		});

		it("leaves it unreported once one non-test file consumes it too", () => {
			doc(docline);
			track("scripts/thing.js", spare);
			track("scripts/thing.test.ts", 'import { spare } from "./thing";\n');
			track("scripts/caller.js", 'require("./thing").spare();\n');
			expect(run().out).not.toContain("DEAD-EXPORT");
		});

		it("exempts the main a guarded program exports for run-in-process", () => {
			doc(docline);
			track(
				"scripts/prog.js",
				"async function main() {}\n\nmodule.exports = { main };\nif (require.main === module) main();\n",
			);
			track("scripts/prog.test.ts", "runInProcessAsync(SCRIPT, [], {});\n");
			expect(run().out).not.toContain("DEAD-EXPORT");
		});

		it("still reports a main exported from a file with no require.main guard, which run-in-process cannot drive", () => {
			doc(docline);
			track(
				"scripts/prog.js",
				"function main() {}\n\nmodule.exports = { main };\n",
			);
			track("scripts/prog.test.ts", 'import { main } from "./prog";\n');
			// Neither the harness's generic read nor another program's guard is a
			// real caller of this main.
			track(
				"scripts/lib/run-in-process.js",
				"const main = entry.exports?.main;\nmain();\n",
			);
			track(
				"scripts/other.js",
				"if (require.main === module) process.exit(0);\n",
			);
			expect(run().out).toContain("only tests consume main");
		});

		it("exempts a module whose header names its unbuilt caller and that caller's ticket", () => {
			doc(docline);
			track(
				"scripts/lib/early.js",
				`/*\n * Built ahead of its caller.\n * Unbuilt caller: scripts/report.js (#575)\n */\n${spare}`,
			);
			track(
				"scripts/lib/brief.js",
				`/** Unbuilt caller: scripts/report.js (#575) */\n${spare}`,
			);
			track(
				"scripts/lib/early.test.ts",
				'import { spare } from "./early";\nimport { spare } from "./brief";\n',
			);
			expect(run().out).not.toContain("DEAD-EXPORT");
		});

		it("does not exempt an unbuilt caller named without its ticket, or outside the header", () => {
			doc(docline);
			track(
				"scripts/lib/early.js",
				`/*\n * Unbuilt caller: scripts/report.js\n */\n${spare}`,
			);
			track(
				"scripts/lib/late.js",
				`/* header */\nconst x = 1;\n// Unbuilt caller: scripts/report.js (#575)\n${spare}`,
			);
			track("scripts/lib/both.test.ts", 'import { spare } from "./early";\n');
			const r = run();
			expect(r.out).toContain("scripts/lib/early.js  spare");
			expect(r.out).toContain("scripts/lib/late.js  spare");
		});

		it("scans no test-kind file as an exporter", () => {
			doc(docline);
			track("scripts/lib/fixtures/probe.js", spare);
			track(
				"scripts/lib/probe.test.ts",
				'require("./fixtures/probe").spare;\n',
			);
			expect(JSON.parse(run("--json").out).exportBlocks).toBe(0);
		});
	});

	it("judges the re-export entry form by the name it exports, not the value behind it", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"const other = { inner: 1 };\nother.inner;\n\nmodule.exports = {\n\tspare: other.inner,\n};\n",
		);
		const r = run();
		expect(r.out).toContain("DEAD-EXPORT");
		expect(r.out).toContain("spare");
	});

	it("says how many entries it could not read, rather than counting them as cleared", () => {
		doc(docline);
		track(
			"scripts/thing.js",
			"const rest = {};\nrest.x;\n\nmodule.exports = {\n\t...rest,\n};\n",
		);
		expect(run().out).toContain("1 entr(ies) were of no shape §N7 describes");
		expect(JSON.parse(run("--json").out).exportEntriesUnread).toBe(1);
	});
});

describe("the standards base beside the local file (#963)", () => {
	const basePath = "docs/code-standards-base.md";
	const anchorsPath = "scripts/code-standards-base-anchors.json";
	const base = (body: string) => track(basePath, body);
	const readBytes = (file: string) => fs.readFileSync(path.join(repo, file));
	const dead =
		"function spare() {}\nspare();\n\nmodule.exports = {\n\tspare,\n};\n";

	it("reads both documents in one run, each finding once, under the document that carries it", () => {
		track("lib/a.ts", SUBJECT);
		track("scripts/b.js", SUBJECT);
		track("scripts/dead.js", dead);
		doc("Rule — `lib/a.ts:40`\n");
		base("Rule — `scripts/b.js:40`\n");
		const r = run("--json");
		expect(r.status).toBe(0);
		const envelope = JSON.parse(r.out);
		expect(envelope.documents).toEqual([DOC, basePath]);
		expect(
			envelope.citations_stale.map(
				(f: { doc: string; pin: string }) => `${f.doc} ${f.pin}`,
			),
		).toEqual([`${DOC} lib/a.ts:40`, `${basePath} scripts/b.js:40`]);
		// The export scan reads neither document, so two of them must not run it twice.
		expect(envelope.exports_dead).toHaveLength(1);
	});

	it("names both documents in the OK line when both are read", () => {
		track("scripts/b.js", SUBJECT);
		doc('Rule — `scripts/b.js:2-4` *"the quoted sentence lives here"*\n');
		base('Rule — `scripts/b.js:2-4` *"the quoted sentence lives here"*\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			`2 citation(s) across 1 file(s) in ${DOC} and ${basePath} resolve`,
		);
	});

	it("reads the local file alone where the repo has no base, as an adopter's run does", () => {
		track("lib/a.ts", SUBJECT);
		doc("Rule — `lib/a.ts:40`\n");
		const envelope = JSON.parse(run("--json").out);
		expect(envelope.documents).toEqual([DOC]);
		expect(run().out).not.toContain(basePath);
	});

	it("reads the base alone where the repo keeps no local file, rather than skipping", () => {
		track("scripts/b.js", SUBJECT);
		base("Rule — `scripts/b.js:40`\n");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("SKIP");
		expect(r.out).toContain(`OUT-OF-RANGE  ${basePath}:1  scripts/b.js:40`);
	});

	it("warns, exit 0, on a base line pin into a file the release leaves behind, naming the base line and the pin", () => {
		// release-contains.js is in plugin-tree.js's LEFT_BEHIND set.
		track("scripts/release-contains.js", SUBJECT);
		doc("Rule — see the base\n");
		base(
			'Rule — `scripts/release-contains.js:2-4` *"the quoted sentence lives here"*\n',
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			`UNSHIPPED  ${basePath}:1  scripts/release-contains.js:2-4`,
		);
		expect(r.out).toContain(
			"the release leaves scripts/release-contains.js behind",
		);
	});

	it("warns on a base line pin into a test file, which no release ships, naming the base line and the pin and asking for a shipped file", () => {
		track("scripts/a.test.ts", SUBJECT);
		doc("Rule — see the base\n");
		base('Rule — `scripts/a.test.ts:2-4` *"the quoted sentence lives here"*\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(`UNSHIPPED  ${basePath}:1  scripts/a.test.ts:2-4`);
		expect(r.out).toContain("pin a shipped file");
	});

	it("warns on a base line pin cited by bare file name, which opens nothing at the plugin root", () => {
		track("scripts/b.js", SUBJECT);
		doc("Rule — see the base\n");
		base('Rule — `b.js:2-4` *"the quoted sentence lives here"*\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("UNSHIPPED");
		expect(r.out).toContain("cite scripts/b.js in full");
	});

	it("never calls a shipped base line pin UNSHIPPED", () => {
		track("scripts/b.js", SUBJECT);
		doc("Rule — see the base\n");
		base('Rule — `scripts/b.js:2-4` *"the quoted sentence lives here"*\n');
		const r = run();
		expect(r.out).toContain("OK:");
		expect(r.out).not.toContain("UNSHIPPED");
	});

	it("never calls a shipped root-level file's line pin a bare name — it opens at the plugin root as cited", () => {
		// ruff.toml is in plugin-tree.js's COPIED list.
		track("ruff.toml", SUBJECT);
		doc("Rule — see the base\n");
		base('Rule — `ruff.toml:2-4` *"the quoted sentence lives here"*\n');
		const r = run();
		expect(r.out).toContain("OK:");
		expect(r.out).not.toContain("UNSHIPPED");
	});

	it("warns UNSHIPPED on a base line pin naming no file, or a missing one, which the release refuses too (#1259)", () => {
		track("scripts/b.js", SUBJECT);
		doc("Rule — see the base\n");
		base("Absent — `scripts/gone.js:1`.\nNo path — `:4`.\n");
		const r = run();
		expect(r.out).toContain(`UNSHIPPED  ${basePath}:1  scripts/gone.js:1`);
		expect(r.out).toContain("no file opens at scripts/gone.js");
		expect(r.out).toContain(`UNSHIPPED  ${basePath}:2  :4`);
		expect(r.out).toContain("it names no file");
		expect(r.out).toContain("pin a shipped file");
	});

	it("warns UNSHIPPED on exactly the base line pins the release refuses (#1259)", async () => {
		const { buildTree } = await import("./lib/plugin-tree.js");
		track("scripts/b.js", SUBJECT);
		track("scripts/release-contains.js", SUBJECT);
		track("scripts/a.test.ts", SUBJECT);
		track("ruff.toml", SUBJECT);
		doc("Rule — see the base\n");
		base(
			[
				"Shipped — `scripts/b.js:2-4`.",
				"Left behind — `scripts/release-contains.js:2`.",
				"A test — `scripts/a.test.ts:2`.",
				"Bare name — `b.js:2`.",
				"Absent — `scripts/gone.js:1`.",
				"No path — `:4`.",
				"A directory — `scripts:1`.",
				"Shipped at the root — `ruff.toml:2`.",
				"",
			].join("\n"),
		);
		const warned = JSON.parse(run("--json").out)
			.citations_stale.filter((f: { kind: string }) => f.kind === "UNSHIPPED")
			.map((f: { docLine: number }) => f.docLine);
		track("self-plugin/hooks/hooks.json", JSON.stringify({ hooks: {} }));
		let message = "";
		try {
			buildTree(repo, path.join(repo, "out"));
		} catch (err) {
			message = (err as Error).message;
		}
		const pinFault =
			message
				.split("\n")
				.find((l) => l.startsWith(`${basePath} carries line pins`)) ?? "";
		const refused = [...pinFault.matchAll(/\(line (\d+)\)/g)].map((m) =>
			Number(m[1]),
		);
		expect(refused).toEqual([2, 3, 4, 5, 6, 7]);
		expect(warned).toEqual(refused);
	});

	it("says which document went unread when the other one was read", () => {
		track("scripts/b.js", SUBJECT);
		base('Rule — `scripts/b.js:2-4` *"the quoted sentence lives here"*\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(`${DOC} could not be read`);
		expect(r.out).toContain("its citations go unchecked");
	});

	it("never judges the local file's line pins for shipping — they are read in the repo", () => {
		track("scripts/release-contains.js", SUBJECT);
		doc(
			'Rule — `scripts/release-contains.js:2-4` *"the quoted sentence lives here"*\n',
		);
		base("Rule — no pins\n");
		expect(run().out).not.toContain("UNSHIPPED");
	});

	it("names the base's own anchors file and --review command for an unanchored base line pin", () => {
		track("scripts/b.js", SUBJECT);
		doc("Rule — see the base\n");
		base("Rule — `scripts/b.js:5-6`\n");
		const r = run();
		expect(r.out).toContain(`no entry in ${anchorsPath}`);
		expect(r.out).toContain(`--review ${basePath} scripts/b.js:5-6`);
	});

	it("re-anchors the base alone on --review naming it, leaving the local anchors file byte-identical", () => {
		track("lib/a.ts", SUBJECT);
		track("scripts/b.js", SUBJECT);
		doc("Rule — `lib/a.ts:5-6`\n");
		base("Rule — `scripts/b.js:5-6`\n");
		expect(run("--review").status).toBe(0);
		const local = readBytes(ANCHORS);
		expect(run("--review", basePath).status).toBe(0);
		expect(readBytes(ANCHORS).equals(local)).toBe(true);
		expect(Object.keys(JSON.parse(readBytes(anchorsPath).toString()))).toEqual([
			"scripts/b.js:5-6",
		]);
		expect(run().out).toContain("OK:");
	});

	it("re-anchors the local file alone on a bare --review, leaving the base anchors file byte-identical", () => {
		track("lib/a.ts", SUBJECT);
		track("scripts/b.js", SUBJECT);
		doc("Rule — `lib/a.ts:5-6`\n");
		base("Rule — `scripts/b.js:5-6`\n");
		expect(run("--review", basePath).status).toBe(0);
		const kept = readBytes(anchorsPath);
		expect(run("--review").status).toBe(0);
		expect(readBytes(anchorsPath).equals(kept)).toBe(true);
		expect(Object.keys(readAnchors())).toEqual(["lib/a.ts:5-6"]);
	});

	it("scopes --touching by the base's own changed lines, not the local file's", () => {
		track("scripts/b.js", SUBJECT);
		doc("Rule — see the base\n");
		base("Rule — nothing yet\n");
		git("commit", "-q", "-m", "both documents");
		base("Rule — nothing yet\nRule — `scripts/b.js:40`\n");
		const r = run("--touching", "HEAD");
		expect(r.out).toContain(`OUT-OF-RANGE  ${basePath}:2  scripts/b.js:40`);
	});
});

describe("pythonRoutes against the local route table (#1863)", () => {
	const Config = ".claude/workflow-core.json";
	const Table = [
		"## Route rows",
		"",
		"| Path | Code kind |",
		"|---|---|",
		"| `scripts/**/test_*.py`, `scripts/evidence_test_support.py` | test |",
		"| `scripts/**/*.py` | program |",
		"",
	].join("\n");
	const routes = (pythonRoutes: Record<string, string>) =>
		track(Config, JSON.stringify({ pythonRoutes }));
	const commit = (msg: string) => git("commit", "-m", msg);

	it("names a local row pythonRoutes lacks, at its table line, and never gates", () => {
		doc(Table);
		routes({ "scripts/**/test_*.py": "test", "scripts/**/*.py": "program" });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			`ROUTE-DRIFT  ${DOC}:5  scripts/evidence_test_support.py`,
		);
		expect(r.out).toContain("The table wins");
		expect(r.out).not.toContain("Fix the\n  DOCUMENT");
	});

	it("names a pythonRoutes row no table row holds against the config", () => {
		doc(Table);
		routes({
			"scripts/**/test_*.py": "test",
			"scripts/evidence_test_support.py": "test",
			"scripts/gone.py": "test",
			"scripts/**/*.py": "program",
		});
		expect(run().out).toContain(`ROUTE-DRIFT  ${Config}  scripts/gone.py`);
	});

	it("says the copies agree, and carries no route finding in --json", () => {
		doc(Table);
		routes({
			"scripts/**/test_*.py": "test",
			"scripts/evidence_test_support.py": "test",
			"scripts/**/*.py": "program",
		});
		expect(run().out).toContain(
			"pythonRoutes agrees with the 3 route row(s) reaching Python",
		);
		const envelope = JSON.parse(run("--json").out);
		expect(envelope.routes_drift).toEqual([]);
	});

	it("scopes a dropped table row into --touching by the document, though no changed line holds it", () => {
		doc(Table);
		routes({
			"scripts/**/test_*.py": "test",
			"scripts/evidence_test_support.py": "test",
			"scripts/**/*.py": "program",
		});
		commit("copies agree");
		const scopeRev = git("rev-parse", "HEAD").trim();

		doc(Table.replace(", `scripts/evidence_test_support.py`", ""));
		const r = run("--touching", scopeRev);
		expect(r.out).toContain(
			`ROUTE-DRIFT  ${Config}  scripts/evidence_test_support.py`,
		);
	});

	it("leaves pre-existing drift out of a --touching diff that reaches neither copy", () => {
		doc(Table);
		routes({ "scripts/**/*.py": "program" });
		commit("drift already there");
		const scopeRev = git("rev-parse", "HEAD").trim();

		track("lib/a.ts", SUBJECT);
		const r = run("--touching", scopeRev);
		expect(r.out).not.toContain("ROUTE-DRIFT");
		expect(r.out).not.toContain("pythonRoutes agrees");
	});
});
