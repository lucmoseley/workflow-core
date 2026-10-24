// @vitest-environment node
/*
 * tenure.test.ts — tenure.js gathers evidence and renders no verdict, so
 * the tests pin two things: that the evidence is the evidence the skill's
 * step 4 asks for, and that a lookup which could not run never comes back
 * looking like an absence, which the pass would take as licence to cut a
 * line nobody understands (mantahostels#1147, the ticket that scripted the
 * step; mantahostels#1114).
 *
 * Black-box in a throwaway git repo, per docs/code-standards-base.md §X3, with `gh`
 * injected at WFC_GH rather than found on PATH (§N7). Every fail-closed case
 * is paired with a positive case proving the ordinary path still reports.
 *
 * Real git repos, not synthetic fixtures: the one thing that can drift under
 * this script is what `git log -S` actually prints, and a fixture would stop
 * pinning it.
 *
 * Loosen a case and the concision pass's step 4 is shown the wrong commit as
 * a line's origin, or a lookup that never ran as "no history", and cuts a
 * line that was load-bearing.
 *
 * MUTATIONS RUN (mantahostels#1114 limb 4): the locate failure made to fall
 * through to the lookups; the unresolved-lookup exit made 0; the needle made
 * the multi-line span again; the pathspec-less rung dropped; `--reverse`
 * dropped; the re-wrap-tolerant body search made a literal `includes` (mantahostels#2510);
 * `findAcrossWraps`'s token separator widened from `\s+\*?\s*` to `[\s*]+`,
 * losing the boundary that keeps a bare `single*use` and a `**bold**` run
 * from reading as a wrap; `needleFor`'s leading `* ` strip removed, so a
 * marker-bearing fragment reaches `git log -S` and hides the introducing
 * commit behind whichever one wrote the wrap (mantahostels#3169). Each turned exactly one
 * case below red, and each was reversed by its inverse edit.
 *
 * MUTATIONS RUN ON THE mantahostels#3134 AXIS (1b): the message filter made a no-op; the
 * identifier-match regex's word boundaries dropped; the prose-line guard on
 * `DECL_PATTERNS` disabled; the display order's `newestFirst` flag flipped.
 * Each turned exactly one case in "the later-ruling scan" red, and each was
 * reversed by its inverse edit.
 *
 * MUTATIONS RUN ON THE mantahostels#3155 IDENTIFIER-FREQUENCY AXIS: the threshold raised
 * to Infinity turned only the "too common" case red; the threshold dropped to
 * 0 turned only the "rare" case red. Each was reversed by its inverse edit.
 * NOT mutation-tested: the repo-wide frequency lookup's own `git log` failure
 * falling through to a clear rather than `unresolved` — no test here drives
 * `git log` itself to fail, the same pre-existing gap as the file-scoped
 * lookup a few lines above it never having one either.
 *
 * MUTATIONS RUN ON THE #763 LINE-HISTORY RUNG: `lineHistory` made to return
 * no commits; its lines located in the working tree rather than HEAD; the
 * already-printed dedupe disabled; its `--reverse` dropped. Each turned only
 * #763 cases red (the working-tree one also the uncommitted-absence case),
 * and each was reversed by its inverse edit.
 *
 * MUTATIONS RUN ON THE #1238 CLOSED-PIPE CASES: the EPIPE catch removed
 * turned all three red; EPIPE made `process.exit(0)` turned only the exit-3
 * case red. Each was reversed by its inverse edit.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "../../../../scripts/lib/run-in-process.js";

const TENURE = path.resolve(__dirname, "tenure.js");

/** The sentence under test throughout: long enough to be a distinctive needle,
 * and shaped like the prose this skill actually judges. */
const SENTENCE =
	"A reward code is single use and expires ninety days after it is issued.";

/** The tail of axis 1b's too-common warning (mantahostels#3155). One shared fragment, so
 * a reword cannot leave the negative case passing vacuously. */
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

/** Replaces the injected `gh` with a script emitting `body` and exiting `code`. */
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
		env: { ...process.env, WFC_GH: ghStub },
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
	// The grep axis looks at scripts/ and docs/doc-map.md; both must exist or
	// the axis is unresolved by design.
	write("scripts/placeholder.js", "// nothing\n");
	write("docs/doc-map.md", "# doc map\n");
	git("add", "-A");
	git("commit", "-m", "seed");
});

afterEach(() => {
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
		// Four commits name booking_dorm_rate without ever touching the phrase
		// itself — the cap (3) must withhold the OLDEST of these, because the
		// true ruling is the newest and step 1's oldest-first rule would hide
		// exactly the commit this lookup exists to surface (mantahostels#3134). The
		// docstring stays untouched throughout: only unrelated lines are added.
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
		// 20 more commits naming "hostel", repo-wide: 21 matches in total,
		// over MAX_IDENTIFIER_COMMIT_MATCHES (20) — a single common word run
		// into the ground, the case raw character length cannot see (mantahostels#3155).
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
		// One other commit does name it in plain English — frequency 1, not 0
		// — so this case actually exercises the threshold rather than passing
		// vacuously on an identifier nothing ever mentions.
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
		// `_` holds no word characters, so the axis is unresolved before a
		// frequency lookup ever runs. Warning it matched too much would
		// contradict the line beneath it.
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
		// The same sentence, re-wrapped by a later, unrelated edit. A needle
		// carrying the new line break matches only this commit.
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
		// The pathspec rung names only the rename, whose message describes the
		// move — which clears tenure under step 4's bulk-rewrite rule.
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
		// Accepted residual, documented at findAcrossWraps: a `* ` list
		// bullet is indistinguishable from a comment-continuation marker, so
		// tolerating one tolerates the other too.
		write("doc.md", "the rule\n* applies to partners\nand nobody else.\n");
		commit("doc.md", "add the rule");

		const { code, out } = run("the rule applies", "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("phrase at doc.md:1");
	});

	it("finds the commit that settled a rule, not the commit that wrapped it into a comment (mantahostels#3169)", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Stop a reward code being redeemed twice");
		// Rewrapped into a doc comment by a later, unrelated edit, with the
		// longest line-internal fragment (needleFor's pick) now carrying the
		// comment's leading `* ` marker.
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
		// Uncommitted lines above the phrase: `-L` numbers HEAD's lines, so
		// the working tree's line number would point it at the wrong line.
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
		// Present in the working tree, never committed: git genuinely holds no
		// commit that added this string.
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
		// None of the lookups must appear: a printed "none" here would read
		// as proof that no commit introduced the sentence.
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
		// The point of the cap's direction: what survives it is the commit that
		// introduced the sentence, not the newest edit to touch it (mantahostels#1147).
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
		// The needle-echo line always prints SENTENCE, so the assertion that
		// actually pins full-body printing is the marker sitting after it —
		// unreachable unless the body printed past the 600-char cap.
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
	/** Runs tenure.js into `reader` through bash, printing tenure.js's own exit
	 * code after the reader's output. The inner `timeout` is the hang pin: a
	 * hang reads `tenure-exit=124`, and the hung node is killed, not orphaned.
	 * Spawned, not run in process (§X3): EPIPE needs a real fd 1 whose reader
	 * has gone, which run-in-process.js's captured stdout never is, and the
	 * hang pin needs a timeout. */
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

	// `true` exits before tenure.js writes anything, so every write meets a
	// closed pipe — the case `head -1` reaches only when it wins a race.
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

describe("the log parser (#1341)", () => {
	it("reads a commit with no body as one, never printing an undefined body", () => {
		write("doc.md", `${SENTENCE}\n`);
		commit("doc.md", "Stop a reward code being redeemed twice");

		const { code, out } = run(SENTENCE, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("Stop a reward code being redeemed twice");
		expect(out).not.toContain("undefined");
	});

	/* A message carrying the record separator is the one way git hands the
	 * parser a record short of its fields. */
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
