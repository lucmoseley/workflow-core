// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ignoreFailure, orFallback } from "../../../../scripts/lib/caught.js";
import { keptSpawn } from "../../../../scripts/lib/kept-spawn.js";
import { runInProcess } from "../../../../scripts/lib/run-in-process.js";

const TENURE = path.resolve(__dirname, "tenure.js");

const SENTENCE =
	"A reward code is single use and expires ninety days after it is issued.";

const TOO_COMMON_WARNING =
	"commit messages repo-wide — too common to trust as a ruling on this specific " +
	"line, so read what follows as candidates rather than rulings";

let repo: string;
let ghStub: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), body);
};

const commit = (rel: string, message: string) => {
	git("add", "--", rel);
	git("commit", "-m", message);
};

const stubGhHanging = () => {
	fs.writeFileSync(
		ghStub,
		`#!/bin/sh\necho $$ > "${ghStub}.pid"\nexec sleep 60\n`,
		{ mode: 0o755 },
	);
};

const stubGh = (body: string, code = 0) => {
	fs.writeFileSync(
		ghStub,
		`#!/bin/sh\ncat <<'JSON'\n${body}\nJSON\nexit ${code}\n`,
		{ mode: 0o755 },
	);
};

const runIn = (cwd: string, ...args: string[]) => {
	const r = runInProcess(TENURE, args, {
		cwd,
		env: { ...process.env, WFC_GH: ghStub, TENURE_WORKER: "1" },
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const run = (...args: string[]) => runIn(repo, ...args);

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "tenure-"));
	ghStub = path.join(repo, "gh-stub");
	stubGh("[]");
	git("init", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	write("scripts/placeholder.js", "// nothing\n");
	write("docs/doc-map.md", "# doc map\n");
	git("add", "-A");
	git("commit", "-m", "seed");
});

afterEach(() => {
	ignoreFailure(() =>
		process.kill(Number(fs.readFileSync(`${ghStub}.pid`, "utf8")), "SIGKILL"),
	);
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("the lookups step 4 prescribes", () => {
	it("names the introducing commit and prints the body tenure turns on", () => {
		write("doc.md", `${SENTENCE}\n`);
		git("add", "--", "doc.md");
		git(
			"commit",
			"-m",
			"Stop a reward code being redeemed twice\n\nRuled at #999: single use, ninety days.",
		);

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("Stop a reward code being redeemed twice");
		expect(out).toContain("Ruled at #999: single use, ninety days.");
	});

	it("lists an earlier ruling the tracker already carries", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");
		stubGh(
			'[{"number":603,"state":"CLOSED","title":"Do whole-file audits suspend tenure?"}]',
		);

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("#603 CLOSED Do whole-file audits suspend tenure?");
	});

	it("names a test asserting the string, which makes the sentence load-bearing", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");
		write("scripts/rule.test.ts", `expect(out).toContain("${SENTENCE}");\n`);
		commit("scripts/rule.test.ts", "assert the rule");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("scripts/rule.test.ts:1:");
	});

	it("renders no verdict on whether tenure holds — that stays in the skill", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).not.toMatch(/tenure/i);
		expect(out).not.toMatch(/\b(cut|keep|refuse|holds)\b/i);
	});
});

describe("the later-ruling scan (mantahostels#3134)", () => {
	it("names the enclosing function and the commit ruling its line kept, a change -S cannot see", () => {
		write(
			"page.py",
			"def booking_dorm_rate(page_text):\n" +
				'    """The lowest rate quoted for a room on this page.\n\n' +
				"    ANCHORED TO THE PRICE ROWS, NOT TO THE PAGE.\n" +
				'    """\n' +
				"    return None\n",
		);
		commit("page.py", "Read each hostel's page and fill its dossier");
		write(
			"page.py",
			"def booking_dorm_rate(page_text):\n" +
				'    """The lowest rate quoted for a room on this page.\n\n' +
				"    ANCHORED TO THE PRICE ROWS, NOT TO THE PAGE.\n" +
				'    """\n' +
				"    return None\n\n\ndef unrelated():\n    pass\n",
		);
		commit(
			"page.py",
			"Drain six page-check lines\n\n" +
				"booking_dorm_rate: the page inventory, the residual reason already standing",
		);

		const { code, out } = run(
			"ANCHORED TO THE PRICE ROWS, NOT TO THE PAGE.",
			"page.py",
		);

		expect(code).toBe(0);
		expect(out).toContain("enclosing identifier: booking_dorm_rate");
		expect(out).toContain("Drain six page-check lines");
	});

	it("matches a plain-English name for a CONSTANT_CASE identifier", () => {
		write(
			"page.py",
			"# The phrases a platform prints above an owner's reply.\nREPLY_MARKERS = (\n" +
				'    r"Owner response"\n)\n',
		);
		commit("page.py", "add the reply marker check");
		write(
			"page.py",
			"# The phrases a platform prints above an owner's reply.\nREPLY_MARKERS = (\n" +
				'    r"Owner response"\n)\n\n\ndef unrelated():\n    pass\n',
		);
		commit(
			"page.py",
			"Cut the page-check comments restating their own rules\n\n" +
				"The reply markers keep the residual they bound.",
		);

		const { code, out } = run(
			"The phrases a platform prints above an owner's reply.",
			"page.py",
		);

		expect(code).toBe(0);
		expect(out).toContain("enclosing identifier: REPLY_MARKERS");
		expect(out).toContain(
			"Cut the page-check comments restating their own rules",
		);
	});

	it("says none, not unresolved, where no enclosing identifier sits nearby", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain(
			"no enclosing function, class or constant name found",
		);
	});

	it("shows the newest matching commits under the display cap, not the oldest", () => {
		write(
			"page.py",
			"def booking_dorm_rate(page_text):\n" +
				'    """The lowest rate quoted for a room on this page.\n\n' +
				"    ANCHORED TO THE PRICE ROWS, NOT TO THE PAGE.\n" +
				'    """\n',
		);
		commit("page.py", "Read each hostel's page and fill its dossier");
		let body =
			"def booking_dorm_rate(page_text):\n" +
			'    """The lowest rate quoted for a room on this page.\n\n' +
			"    ANCHORED TO THE PRICE ROWS, NOT TO THE PAGE.\n" +
			'    """\n';
		for (const n of ["one", "two", "three", "four"]) {
			body += `\n\ndef unrelated_${n}():\n    pass\n`;
			write("page.py", body);
			commit(
				"page.py",
				n === "four"
					? "booking_dorm_rate: the actual ruling, newest of all"
					: `booking_dorm_rate: unrelated note ${n}`,
			);
		}

		const { code, out } = run(
			"ANCHORED TO THE PRICE ROWS, NOT TO THE PAGE.",
			"page.py",
		);

		expect(code).toBe(0);
		expect(out).toContain("the actual ruling, newest of all");
		expect(out).toContain("(+1 older, not shown)");
		expect(out).not.toContain("unrelated note one");
	});

	it("excludes a commit touching the file whose message never names the identifier", () => {
		write(
			"page.py",
			"def booking_dorm_rate(page_text):\n" +
				'    """The lowest rate quoted for a room on this page.\n\n' +
				"    ANCHORED TO THE PRICE ROWS, NOT TO THE PAGE.\n" +
				'    """\n',
		);
		commit("page.py", "Read each hostel's page and fill its dossier");
		write(
			"page.py",
			"def booking_dorm_rate(page_text):\n" +
				'    """The lowest rate quoted for a room on this page.\n\n' +
				"    ANCHORED TO THE PRICE ROWS, NOT TO THE PAGE.\n" +
				'    """\n\n\ndef unrelated():\n    pass\n',
		);
		commit("page.py", "Fix an unrelated formatting glitch in the collector");

		const { code, out } = run(
			"ANCHORED TO THE PRICE ROWS, NOT TO THE PAGE.",
			"page.py",
		);

		expect(code).toBe(0);
		expect(out).toContain("none mentioning");
		expect(out).not.toContain("Fix an unrelated formatting glitch");
	});

	it("does not match a short identifier inside an unrelated longer word", () => {
		write(
			"page.py",
			'def res(page_text):\n    """A comment on this function."""\n',
		);
		commit("page.py", "Read each hostel's page and fill its dossier");
		write(
			"page.py",
			"def res(page_text):\n" +
				'    """A comment on this function."""\n\n\ndef unrelated():\n    pass\n',
		);
		commit(
			"page.py",
			"Cut duplicated test setup and check the reserved-rooms results still pass",
		);

		const { code, out } = run("A comment on this function.", "page.py");

		expect(code).toBe(0);
		expect(out).toContain("none mentioning");
		expect(out).not.toContain("Cut duplicated test setup");
	});

	it("does not read a Markdown 'Word:' line as a declaration", () => {
		write(
			"notes.md",
			"Scope: the census behind this rule.\n\n" +
				"A reward code is single use and expires ninety days after issue.\n",
		);
		commit("notes.md", "add the rule");

		const { code, out } = run(
			"A reward code is single use and expires ninety days after issue.",
			"notes.md",
		);

		expect(code).toBe(0);
		expect(out).not.toContain("enclosing identifier: Scope");
		expect(out).toContain(
			"no enclosing function, class or constant name found",
		);
	});

	it("warns that an identifier's words are too common in commit messages to trust (mantahostels#3155)", () => {
		write(
			"page.py",
			'def hostel(page_text):\n    """A comment on this function."""\n',
		);
		commit("page.py", "Read each hostel's page and fill its dossier");
		for (let i = 0; i < 20; i++) {
			write("filler.md", `filler ${i}\n`);
			commit("filler.md", `Mention hostel again, filler commit ${i}`);
		}

		const { code, out } = run("A comment on this function.", "page.py");

		expect(code).toBe(0);
		expect(out).toContain(
			`identifier "hostel" matches 21 ${TOO_COMMON_WARNING}`,
		);
	});

	it("does not warn for an identifier whose words are rare in commit messages (mantahostels#3155)", () => {
		write(
			"page.py",
			"def booking_dorm_rate(page_text):\n" +
				'    """A comment on this function."""\n',
		);
		commit("page.py", "Read each hostel's page and fill its dossier");
		write("notes.md", "note\n");
		commit(
			"notes.md",
			"Add the booking dorm rate helper referenced from page.py",
		);

		const { code, out } = run("A comment on this function.", "page.py");

		expect(code).toBe(0);
		expect(out).toContain('none mentioning "booking_dorm_rate"');
		expect(out).not.toContain(TOO_COMMON_WARNING);
	});

	it("stays silent about frequency where the identifier was never searchable (mantahostels#3155)", () => {
		write("page.py", '_ = 1\n"""A comment on this function."""\n');
		commit("page.py", "Read each hostel's page and fill its dossier");

		const { code, out } = run("A comment on this function.", "page.py");

		expect(code).toBe(3);
		expect(out).toContain("holds no word characters");
		expect(out).not.toContain(TOO_COMMON_WARNING);
	});
});

describe("the retry ladder", () => {
	it("finds the commit that settled a rule, not the commit that reflowed it (mantahostels#1147)", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Stop a reward code being redeemed twice");
		write(
			"doc.md",
			"A reward code is single use\nand expires ninety days after it is issued.\n",
		);
		commit("doc.md", "Reflow the whole document");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("longest fragment that cannot span a line break");
		expect(out).toContain("Stop a reward code being redeemed twice");
	});

	it("shows the commit that settled a rule when a later rename hides it from the pathspec (mantahostels#1147)", () => {
		write("old.md", `${SENTENCE}\n`);
		commit("old.md", "Stop a reward code being redeemed twice");
		git("mv", "old.md", "new.md");
		git("commit", "-m", "Rename old.md to new.md");

		const { code, out } = run(SENTENCE, "new.md");

		expect(code).toBe(0);
		expect(out).toContain("Rename old.md to new.md");
		expect(out).toContain("which new.md's own history cannot see");
		expect(out).toContain("Stop a reward code being redeemed twice");
	});

	it("says nothing about a second rung where the pathspec already saw every commit", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Stop a reward code being redeemed twice");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).not.toContain("cannot see");
	});

	it("resolves a quotation whose line breaks are not the file's", () => {
		write(
			"doc.md",
			"A reward code is single use\nand expires ninety days after it is issued.\n",
		);
		commit("doc.md", "add the rule");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("phrase at doc.md:1");
	});

	it("resolves a quotation spanning a block comment's ` * ` line wrap (mantahostels#3169)", () => {
		write(
			"doc.md",
			"/**\n * A reward code is single use and expires ninety\n * days after it is issued.\n */\n",
		);
		commit("doc.md", "add the rule");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("phrase at doc.md:2");
	});

	it("does not treat a run of `*` with no whitespace on either side as a gap (mantahostels#3169)", () => {
		write(
			"doc.md",
			"A reward code is single*use and expires ninety days after it is issued.\n",
		);
		commit("doc.md", "add the rule");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(3);
		expect(out).toContain("UNRESOLVED: that phrase is not in doc.md");
	});

	it("also crosses a Markdown list boundary, the same shape as a comment marker (mantahostels#3169)", () => {
		write("doc.md", "the rule\n* applies to partners\nand nobody else.\n");
		commit("doc.md", "add the rule");

		const { code, out } = run("the rule applies", "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("phrase at doc.md:1");
	});

	it("finds the commit that settled a rule, not the commit that wrapped it into a comment (mantahostels#3169)", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Stop a reward code being redeemed twice");
		write(
			"doc.md",
			"/**\n * A reward\n * code is single use and expires ninety days after it is issued.\n */\n",
		);
		commit("doc.md", "Reflow into a doc comment");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("Stop a reward code being redeemed twice");
		expect(out).not.toContain("none in doc.md itself");
	});

	it("names the commit that wrote a line a later commit reworded, which -S on the current wording cannot see (#763)", () => {
		write("doc.md", "A reward code may be redeemed once.\n");
		commit("doc.md", "Stop a reward code being redeemed twice");
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Tighten the wording across the document");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("git log -L");
		expect(out).toContain("Stop a reward code being redeemed twice");
	});

	it("follows the line to its writer when the working tree has shifted it (#763)", () => {
		write("doc.md", "A reward code may be redeemed once.\n");
		commit("doc.md", "Stop a reward code being redeemed twice");
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Tighten the wording across the document");
		write("doc.md", `new heading\n\nintro\n\n${SENTENCE}\n`);

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("phrase at doc.md:5");
		expect(out).toContain("Stop a reward code being redeemed twice");
	});

	it("prints a commit both rungs found once, not its body twice (#763)", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Stop a reward code being redeemed twice\n\nBODY-MARKER");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out.split("BODY-MARKER")).toHaveLength(2);
		expect(out).toContain("(body above)");
	});

	it("reports a string no commit ever carried as a real absence, both rungs run", () => {
		write("doc.md", "placeholder\n");
		commit("doc.md", "add the file");
		write("doc.md", `${SENTENCE}\n`);

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("none, with and without the pathspec");
		expect(out).toContain("no commit in this");
		expect(out).toContain(
			"git log -L SKIPPED: the phrase is not in HEAD's copy of doc.md",
		);
	});
});

describe("fails closed — a lookup that could not run is never an absence (mantahostels#1147)", () => {
	it("exits 3 on a phrase it cannot locate, and prints no lookup results at all", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");

		const { code, out } = run("a sentence this file has never held", "doc.md");

		expect(code).toBe(3);
		expect(out).toContain("UNRESOLVED: that phrase is not in doc.md");
		expect(out).toContain("Nothing about");
		expect(out).not.toContain("introducing commit");
		expect(out).not.toContain("later ruling on this identifier");
		expect(out).not.toContain("earlier ruling");
		expect(out).not.toContain("asserted elsewhere");
	});

	it("exits 3 when the tracker cannot be reached, rather than reporting no earlier ruling", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");
		stubGh("gh: could not connect", 1);

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(3);
		expect(out).toContain("UNRESOLVED: gh issue list failed");
		expect(out).toContain("1 of 5 lookups unresolved");
		expect(out).toContain("not evidence of absence");
	});

	it("reports an untracked file as having no history yet, not as having no commit", () => {
		write("fresh.md", `${SENTENCE}\n`);

		const { code, out } = run(SENTENCE, "fresh.md");

		expect(code).toBe(3);
		expect(out).toContain("fresh.md is untracked");
		expect(out).toContain("no tenure to clear yet");
	});

	it("exits 0 with all four sections reported when every lookup ran", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("1. introducing commit");
		expect(out).toContain("1b. later ruling on this identifier");
		expect(out).toContain("2. earlier ruling");
		expect(out).toContain("3. asserted elsewhere");
		expect(out).not.toContain("UNRESOLVED");
	});

	it("exits 3 outside a git repository rather than reporting no introducing commit", () => {
		const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tenure-nogit-"));
		fs.writeFileSync(path.join(bare, "doc.md"), `${SENTENCE}\n`);
		try {
			const { code, out } = runIn(bare, SENTENCE, "doc.md");
			expect(code).toBe(3);
			expect(out).toContain("UNRESOLVED: not inside a git repository");
		} finally {
			fs.rmSync(bare, { recursive: true, force: true });
		}
	});

	it("exits 3 when neither grep target exists, naming the way out", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");
		git("rm", "-r", "-q", "scripts", "docs");
		git("commit", "-m", "drop the grep targets");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(3);
		expect(out).toContain("none of scripts, docs/doc-map.md exists here");
		expect(out).toContain("run this from the repository root");
	});

	it("refuses an invocation missing the path, printing its usage line", () => {
		const { code, out } = run(SENTENCE);

		expect(code).toBe(1);
		expect(out).toContain("usage: tenure.js '<phrase>' <path>");
	});

	it("refuses a path it cannot read, naming it", () => {
		const { code, out } = run(SENTENCE, "gone.md");

		expect(code).toBe(1);
		expect(out).toContain("cannot read gone.md");
	});
});

describe("output stays bounded, whatever the history holds (mantahostels#1114)", () => {
	it("shows the oldest three commits and says how many newer ones it withheld", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "commit one");
		for (const n of ["two", "three", "four", "five"]) {
			write("doc.md", "placeholder\n");
			commit("doc.md", `remove ${n}`);
			write("doc.md", `${SENTENCE}\n`);
			commit("doc.md", `restore ${n}`);
		}

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("9 in doc.md:");
		expect(out).toContain("(+6 newer, not shown)");
		expect(out).toContain("commit one");
		expect(out).not.toContain("restore five");
	});

	it("caps the line history at the oldest three rewordings too (#763)", () => {
		write("doc.md", "A reward code may be redeemed once.\n");
		commit("doc.md", "commit one");
		for (const n of ["two", "three", "four", "five"]) {
			write("doc.md", `A reward code may be redeemed once, rev ${n}.\n`);
			commit("doc.md", `reword ${n}`);
		}
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "reword six");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("commit one");
		expect(out).toContain("(+3 newer, not shown)");
		expect(out).not.toContain("reword five");
	});

	it("leaves the withheld-count line off a history that fits under the cap", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "commit one");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).not.toContain("not shown");
	});

	it("prints a body in full past the cap when the needle sits beyond it, rather than cutting it off (mantahostels#2510)", () => {
		write("doc.md", `${SENTENCE}\n`);
		const padding = "x".repeat(650);
		const tailMarker = "ZZZ-BEYOND-THE-OLD-CUTOFF";
		commit(
			"doc.md",
			`Stop a reward code being redeemed twice\n\n${padding}\n\n${SENTENCE}\n\n${tailMarker}`,
		);

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain(tailMarker);
		expect(out).toContain("holds the needle — printed in full");
	});

	it("clips a body past the cap and says so when the needle never occurs in it", () => {
		write("doc.md", `${SENTENCE}\n`);
		const padding = "x".repeat(650);
		commit("doc.md", `Stop a reward code being redeemed twice\n\n${padding}`);

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("does not occur past the cut");
	});

	it("prints a body in full past the cap when the needle is only present re-wrapped", () => {
		write("doc.md", `${SENTENCE}\n`);
		const padding = "x".repeat(650);
		const rewrapped =
			"A reward code is single use\nand expires ninety days after it is issued.";
		const tailMarker = "ZZZ-BEYOND-THE-OLD-CUTOFF";
		commit(
			"doc.md",
			`Stop a reward code being redeemed twice\n\n${padding}\n\n${rewrapped}\n\n${tailMarker}`,
		);

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain(tailMarker);
		expect(out).toContain("holds the needle — printed in full");
	});
});

describe("a reader that closes the pipe early (#1238)", () => {
	const piped = (reader: string, ...args: string[]) => {
		const r = spawnSync(
			"bash",
			[
				"-c",
				`timeout 10 node "$0" "$@" | ${reader}; echo "tenure-exit=\${PIPESTATUS[0]}"`,
				TENURE,
				...args,
			],
			{
				cwd: repo,
				encoding: "utf8",
				env: { ...process.env, WFC_GH: ghStub },
				timeout: 30_000,
			},
		);
		return { signal: r.signal, stdout: r.stdout, stderr: r.stderr };
	};

	it("exits promptly into `head -1`, with no EPIPE crash", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");

		const r = piped("head -1", SENTENCE, "doc.md");

		expect(r.signal).toBeNull();
		expect(r.stdout).toBe("phrase at doc.md:1\ntenure-exit=0\n");
		expect(r.stderr).not.toContain("EPIPE");
	});

	it("keeps exit 0 when the reader is gone before the first write", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");

		const r = piped("true", SENTENCE, "doc.md");

		expect(r.stdout).toBe("tenure-exit=0\n");
		expect(r.stderr).not.toContain("EPIPE");
	});

	it("keeps exit 3 for an unresolved lookup when the reader is gone, with no EPIPE on stderr", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");
		stubGh("gh: could not connect", 1);

		const r = piped("true", SENTENCE, "doc.md");

		expect(r.stdout).toBe("tenure-exit=3\n");
		expect(r.stderr).not.toContain("EPIPE");
	});
});

describe("a lookup that never ends (#5311)", () => {
	const spawned = (env: Record<string, string>, ...args: string[]) => {
		const r = keptSpawn("concurrent").spawnSync("node", [TENURE, ...args], {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, WFC_GH: ghStub, ...env },
			timeout: 30_000,
		});
		return { code: r.status, out: r.stdout + r.stderr };
	};

	it("passes a run that ends in time straight through the supervisor, report and exit 0", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");

		const r = spawned({}, SENTENCE, "doc.md");

		expect(r.code).toBe(0);
		expect(r.out).toContain("3. asserted elsewhere");
		expect(r.out).not.toContain("UNRESOLVED");
	});

	it("prints the hung lookup UNRESOLVED at its timeout and still reports the rest", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");
		stubGhHanging();

		const r = spawned(
			{ WFC_TENURE_LOOKUP_TIMEOUT_MS: "500" },
			SENTENCE,
			"doc.md",
		);

		expect(r.code).toBe(3);
		expect(r.out).toMatch(
			/2\. earlier ruling[^\n]*\n {3}UNRESOLVED: gh issue list failed: timed out after 0.5 s/,
		);
		expect(r.out).toContain("COMMIT");
	});

	it("kills a run past the ceiling and exits 3, whatever its lookups' caps", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "add the rule");
		stubGhHanging();

		const r = spawned(
			{ WFC_TENURE_LOOKUP_TIMEOUT_MS: "90000", WFC_TENURE_CEILING_MS: "1000" },
			SENTENCE,
			"doc.md",
		);

		expect(r.code).toBe(3);
		expect(r.out).toContain(
			"UNRESOLVED: tenure.js ran past its 1 s ceiling and was killed",
		);
		const pid = Number(fs.readFileSync(`${ghStub}.pid`, "utf8"));
		const state = orFallback(
			() => fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0],
			"gone",
		);
		expect(["gone", "Z"]).toContain(state);
	});
});

describe("the log parser (#1341)", () => {
	it("reads a commit with no body as one, never printing an undefined body", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Stop a reward code being redeemed twice");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("Stop a reward code being redeemed twice");
		expect(out).not.toContain("undefined");
	});

	it("fails loud on a record short of a subject, naming it, rather than building a commit of undefined fields", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Add the rule\n\nfirst half\x1esecond half");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(1);
		expect(out).toMatch(
			/record short of a sha, date or subject: "second half"/,
		);
	});
});
