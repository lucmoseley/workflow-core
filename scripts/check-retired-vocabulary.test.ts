// @vitest-environment node
/*
 * Pins that check-retired-vocabulary.js reports a §B claim's retired wording
 * still live in a tracked file, less the entry's legitimate hits, with phrases
 * read from the data file alone (mantahostels#591) and never gating
 * (mantahostels#26).
 *
 * check-retired-vocabulary.js enumerates the repo with `git ls-files`, so it is
 * exercised inside a throwaway repository rather than against this one — a
 * fixture pinned to this repo's own docs/ tree would go red on every doc added.
 *
 * It reports in the daily repo-checks run: loosen a case and a stale copy
 * of a settled claim, findable only by its old wording, stays live unflagged.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "check-retired-vocabulary.js");
const MAP = "docs/doc-map.md";

let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const track = (file: string, body: string) => {
	fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
	git("add", "--", file);
};

/** A Section A register row: path, role, class, update route, consumes. */
const row = (p: string, cls: string) =>
	`| \`${p}\` | a doc | \`${cls}\` | Direct | — |`;

/**
 * The map as the script parses it: a Section A register giving each file its
 * authority class, then Section B entries carrying retired-vocabulary lists.
 *
 * One `binary-asset` row is always present — the script treats a Section A
 * that parses no row as unreadable, since without the register the scan cannot
 * tell a binary asset from prose.
 */
const mapDoc = (rows: string[], entries: string[]) =>
	[
		"# Doc map",
		"",
		"## Section A — document register",
		"",
		"| Path | Role | Class | Update route | Consumes |",
		"|---|---|---|---|---|",
		row("docs/history.bin", "binary-asset"),
		...rows,
		"",
		"## Section B — load-bearing figure registry",
		"",
		...entries,
		"",
		"## Section C — question routes",
		"",
	].join("\n");

/**
 * A Section B claim entry. Since mantahostels#591 an entry's phrases live in the data file
 * and nothing reads its prose, so the entry carries only the pointer bullet a
 * human reads — `vocab` is that bullet's text, not a list the checker parses.
 */
const entry = (id: string, vocab = "1 phrase, in the vocabulary data file.") =>
	[
		`### ${id} · a settled claim`,
		"",
		"- **Owner:** `docs/owner.md`",
		`- **Retired vocabulary — grep these:** ${vocab}`,
		"",
	].join("\n");

const VOCAB = "docs/doc-map-retired-vocabulary.json";

interface Phrase {
	literal?: string;
	stem?: string;
}
interface Allow {
	path: string;
	lines?: number[];
	anchors?: string[];
}
type Vocab = Record<string, { phrases: Phrase[]; allowlist?: Allow[] }>;

/**
 * The data file, written untracked: the checker reads it off disk either way,
 * and tracking it is the state the self-exemption test needs, not this one.
 */
const writeVocab = (data: Vocab) => {
	fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
	fs.writeFileSync(path.join(repo, VOCAB), JSON.stringify(data));
};

/** The common shape: one entry in the map, its phrases in the data file. */
const plant = (phrases: Phrase[], allowlist?: Allow[]) => {
	writeMap([], [entry("B1")]);
	writeVocab({ B1: allowlist ? { phrases, allowlist } : { phrases } });
};

const writeMap = (rows: string[], entries: string[]) =>
	track(MAP, mapDoc(rows, entries));

/** `timeout` absent: the run is never killed. */
const checkWithin = (timeout: number | undefined, ...args: string[]) => {
	const r = spawnSync("node", [SCRIPT, ...args], {
		cwd: repo,
		encoding: "utf8",
		timeout,
	});
	return {
		status: r.status ?? -1,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		/* Under GITHUB_ACTIONS the harness puts its ::warning:: annotations on
		 * stdout beside the envelope, which CI runs with and a bare `npm test`
		 * does not. */
		json: () =>
			JSON.parse(
				(r.stdout ?? "{}")
					.split("\n")
					.filter((l) => !l.startsWith("::"))
					.join("\n"),
			),
	};
};

const check = (...args: string[]) => checkWithin(undefined, ...args);

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "vocab-"));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("phrase selection", () => {
	it("reports an off-allowlist hit with its file and line", () => {
		plant([{ literal: "trusted reviews" }]);
		track("docs/copy.md", "one\ntwo\nwe sell trusted reviews\n");

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("docs/copy.md:3");
		expect(r.out).toContain("trusted reviews");
	});

	it("greps the stem, not the literal it glosses", () => {
		plant([
			{ literal: "trust is the product", stem: "trust.{0,40}the product" },
		]);
		// The paraphrase mantahostels#171 measured slipping past the literal.
		track("docs/copy.md", "the trust that is the *product*\n");

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("docs/copy.md:1");
	});

	it("takes the literal where no stem is given", () => {
		plant([{ literal: "hand-edit" }]);
		track("docs/copy.md", "you may hand-edit it\n");

		expect(check().out).toContain("docs/copy.md:1");
	});

	// A literal's whitespace is elastic and backticks are invisible to it, so a
	// phrase survives the inline code a writer put through the middle of it.
	it("matches a literal across backticks in the line", () => {
		plant([{ literal: "no takes: label means /triage" }]);
		track("docs/a.md", "no `takes:` label means /triage\n");

		expect(check("--json").json().hits).toHaveLength(1);
	});

	it("reports every phrase matching one line, not just the first", () => {
		plant([{ literal: "alpha" }, { literal: "beta" }]);
		track("docs/copy.md", "alpha and beta on one line\n");

		const r = check("--json");
		expect(
			r
				.json()
				.hits.map((h: { phrase: string }) => h.phrase)
				.sort(),
		).toEqual(["alpha", "beta"]);
	});

	/* Both of these were "not scanned" footer lines while phrases lived in
	 * prose, so an entry's stem and mantahostels#344 sat unscanned for as long as they existed and said
	 * so only in a footer nobody read. Validation at load is what ended that: a
	 * stem the scan cannot run is now BROKEN, naming its entry (mantahostels#580, mantahostels#591). */
	it("is BROKEN on a stem that would backtrack exponentially, naming its entry, and does not hang", () => {
		// `(a+)+$` against a line of a's never returns.
		plant([{ literal: "slow", stem: "(a+)+$" }]);
		track("docs/copy.md", `${"a".repeat(60)}b\n`);

		// §X9: a process timeout, so a scan that hangs is killed and fails the
		// status below rather than parking the worker.
		const r = checkWithin(15_000);
		expect(r.status).toBe(2);
		expect(r.out).toContain("backtrack exponentially");
		expect(r.out).toContain("B1");
	});

	it("is BROKEN on a stem that will not compile, naming its entry", () => {
		plant([{ literal: "broken", stem: "([unclosed" }]);
		track("docs/copy.md", "we permit price comparison\n");

		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("will not compile");
		expect(r.out).toContain("B1");
	});
});

describe("allowlists", () => {
	it("suppresses a named file entirely, and reports elsewhere", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/old-pitch.md", lines: [] }],
		);
		track("docs/old-pitch.md", "trusted reviews\ntrusted reviews\n");
		track("docs/copy.md", "trusted reviews\n");

		const r = check("--json");
		expect(r.json().allowed).toBe(2);
		expect(r.json().hits).toHaveLength(1);
		expect(r.json().hits[0].file).toBe("docs/copy.md");
	});

	it("suppresses only the lines an allowlist names", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/copy.md", lines: [1, 2] }],
		);
		track(
			"docs/copy.md",
			"trusted reviews\ntrusted reviews\ntrusted reviews\n",
		);

		const r = check("--json");
		expect(r.json().hits).toHaveLength(1);
		expect(r.json().hits[0].line).toBe(3);
	});

	it("matches an allowlist path written as a bare filename", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "brand-sheet.md", lines: [2] }],
		);
		track("docs/notes/brand-sheet.md", "clean\ntrusted reviews\n");
		// A control the allowlist does not name: without it, a phrase list that
		// returned nothing at all would pass this test.
		track("docs/copy.md", "trusted reviews\n");

		const hits = check("--json").json().hits;
		expect(hits).toHaveLength(1);
		expect(hits[0].file).toBe("docs/copy.md");
	});

	it("matches a directory allowlist entry", () => {
		plant(
			[{ literal: "ready-for-agent" }],
			[{ path: ".agents/skills/", lines: [] }],
		);
		track(".agents/skills/triage/SKILL.md", "ready-for-agent\n");
		track("docs/copy.md", "ready-for-agent\n");

		const hits = check("--json").json().hits;
		expect(hits).toHaveLength(1);
		expect(hits[0].file).toBe("docs/copy.md");
	});

	/* mantahostels#744: a line pin rots on every insertion above it, so the suppression it
	 * records is not durable. An anchor is a substring of the line itself. */
	it("suppresses the line a content anchor names, wherever it has moved to", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/copy.md", anchors: ["v1.2 history row"] }],
		);
		track(
			"docs/copy.md",
			"inserted\ninserted\nv1.2 history row: trusted reviews\ntrusted reviews\n",
		);

		const r = check("--json");
		expect(r.json().allowed).toBe(1);
		expect(r.json().hits).toHaveLength(1);
		expect(r.json().hits[0].line).toBe(4);
		expect(r.json().anchorNotes).toEqual([]);
	});

	it("keeps suppressing after a line is inserted above the anchor", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/copy.md", anchors: ["v1.2 history row"] }],
		);
		track("docs/copy.md", "v1.2 history row: trusted reviews\n");
		expect(check("--json").json().hits).toHaveLength(0);

		track(
			"docs/copy.md",
			"a new row above it\nv1.2 history row: trusted reviews\n",
		);
		expect(check("--json").json().hits).toHaveLength(0);
	});

	/* A line pin gets the anchor's diagnostic too (mantahostels#847). It rots the same way
	 * and, until now, silently: nothing distinguished a pin still covering its
	 * hit from one whose line has moved out from under it. */
	it("names a line pin whose line carries none of the entry's phrases", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/copy.md", lines: [1] }],
		);
		// The pinned line 1 once carried the phrase; an insertion pushed it down.
		track("docs/copy.md", "a row inserted above\ntrusted reviews\n");

		const r = check("--json");
		expect(r.status).toBe(0);
		expect(r.json().pinNotes).toHaveLength(1);
		expect(r.json().pinNotes[0]).toMatchObject({
			entry: "B1",
			file: "docs/copy.md",
			line: 1,
			text: "a row inserted above",
		});
		// The hit the pin no longer covers is back in the report on its own name.
		expect(r.json().hits).toMatchObject([{ file: "docs/copy.md", line: 2 }]);
		expect(r.out).toContain("matches nothing the entry greps for");
	});

	it("says nothing about a pin still sitting on its phrase", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/copy.md", lines: [1] }],
		);
		track("docs/copy.md", "trusted reviews\n");

		const r = check("--json");
		expect(r.json().pinNotes).toEqual([]);
		expect(r.json().hits).toHaveLength(0);
		expect(r.out).not.toContain("line pin(s)");
	});

	/* Judged as the scan judges a line — emphasis stripped — so a pin is never
	 * called dead over asterisks the scan itself sees through. */
	it("keeps quiet about a pin whose phrase is broken by emphasis", () => {
		plant(
			[{ literal: "trust is the product", stem: "trust.{0,40}the product" }],
			[{ path: "docs/copy.md", lines: [1] }],
		);
		track("docs/copy.md", "the trust that is the *product*\n");

		expect(check("--json").json().pinNotes).toEqual([]);
	});

	it("names a pin pointing past the end of its file", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/copy.md", lines: [40] }],
		);
		track("docs/copy.md", "trusted reviews\n");

		const r = check("--json");
		expect(r.json().pinNotes[0]).toMatchObject({ line: 40, fileLines: 1 });
		expect(r.out).toContain("past the end of the file");
	});

	/* An anchor matching nothing has already stopped suppressing — the hit it
	 * covered is back in the report — so it is named rather than gated. */
	it("reports an anchor that matches no line, and suppresses nothing", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/copy.md", anchors: ["a row nobody wrote"] }],
		);
		track("docs/copy.md", "trusted reviews\n");

		const r = check("--json");
		expect(r.status).toBe(0);
		expect(r.json().hits).toHaveLength(1);
		expect(r.json().anchorNotes).toHaveLength(1);
		expect(r.json().anchorNotes[0]).toMatchObject({
			entry: "B1",
			anchor: "a row nobody wrote",
			file: "docs/copy.md",
			lines: [],
		});
		expect(r.out).toContain("matches no line");
	});

	/* An anchor matching two lines is a claim about one of them, and an
	 * allowlist that suppresses both could hide a stale copy nobody allowed —
	 * the invariant a line pin has always had. So it suppresses neither. */
	it("suppresses nothing where an anchor spreads, and names it", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/copy.md", anchors: ["history row"] }],
		);
		track(
			"docs/copy.md",
			"history row: trusted reviews\nhistory row: trusted reviews\n",
		);

		const r = check("--json");
		expect(r.json().hits).toHaveLength(2);
		expect(r.json().allowed).toBe(0);
		expect(r.json().anchorNotes[0]).toMatchObject({
			anchor: "history row",
			lines: [1, 2],
		});
		expect(r.out).toContain("matches 2 lines");
	});

	it("takes the union of line pins and anchors on one path", () => {
		plant(
			[{ literal: "trusted reviews" }],
			[{ path: "docs/copy.md", lines: [1], anchors: ["anchored"] }],
		);
		track(
			"docs/copy.md",
			"trusted reviews\ntrusted reviews\nanchored trusted reviews\n",
		);

		const hits = check("--json").json().hits;
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(2);
	});

	// The entry's own pointer bullet still quotes the phrase it retired, so §B
	// stays skipped even though the list itself has moved to the data file.
	it("does not report Section B's own prose", () => {
		writeMap(
			[],
			[entry("B1", "retired `trusted reviews`; see the data file.")],
		);
		writeVocab({ B1: { phrases: [{ literal: "trusted reviews" }] } });

		const r = check("--json");
		expect(r.json().lists[0].phrases).toEqual(["trusted reviews"]);
		expect(r.json().hits).toHaveLength(0);
		expect(r.out).toContain("OK:");
	});

	/* mantahostels#2399: §A's cells are copied verbatim out of docs/doc-map-classes.json by
	 * the generator, so scanning both copies makes one sentence need two
	 * allowlist rows. */
	it("does not report a generated Section A table row, but does report its source", () => {
		writeMap(
			["| `docs/x.md` | trusted reviews | `free-edit` | Direct | — |"],
			[entry("B1")],
		);
		writeVocab({ B1: { phrases: [{ literal: "trusted reviews" }] } });
		track(
			"docs/doc-map-classes.json",
			'{"docs/x.md":{"role":"trusted reviews"}}\n',
		);

		const hits = check("--json").json().hits;
		expect(hits).toHaveLength(1);
		expect(hits[0].file).toBe("docs/doc-map-classes.json");
	});

	// §A's preamble is hand-written and has no source to suppress against.
	it("reports Section A's hand-written prose", () => {
		writeMap(["trusted reviews sit in the preamble"], [entry("B1")]);
		writeVocab({ B1: { phrases: [{ literal: "trusted reviews" }] } });

		const hits = check("--json").json().hits;
		expect(hits).toHaveLength(1);
		expect(hits[0].file).toBe(MAP);
	});

	it("skips Section B when the map is named by a non-canonical path", () => {
		writeMap([], [entry("B1", "retired `trusted reviews`.")]);
		writeVocab({ B1: { phrases: [{ literal: "trusted reviews" }] } });

		const r = check("--json", `./${MAP}`);
		expect(r.status).toBe(0);
		expect(r.json().hits).toHaveLength(0);
	});
});

describe("the report never gates", () => {
	it("exits 0 with many hits", () => {
		plant([{ literal: "trusted reviews" }]);
		track("docs/copy.md", "trusted reviews\n".repeat(40));

		const r = check("--json");
		expect(r.status).toBe(0);
		expect(r.json().outcome).toBe("WARN");
		expect(r.json().hits).toHaveLength(40);
	});

	it("plant, report, allowlist, quiet — with exit 0 throughout", () => {
		plant([{ literal: "trusted reviews" }]);
		track("docs/copy.md", "we sell trusted reviews\n");

		const planted = check("--json");
		expect(planted.status).toBe(0);
		expect(planted.json().hits).toHaveLength(1);

		writeVocab({
			B1: {
				phrases: [{ literal: "trusted reviews" }],
				allowlist: [{ path: "docs/copy.md", lines: [1] }],
			},
		});
		const quiet = check("--json");
		expect(quiet.status).toBe(0);
		expect(quiet.json().hits).toHaveLength(0);
		expect(quiet.json().outcome).toBe("OK");
	});
});

describe("scope", () => {
	it("exempts a binary-asset file by its Section A class", () => {
		writeMap([row("docs/logo.svg", "binary-asset")], [entry("B1")]);
		writeVocab({ B1: { phrases: [{ literal: "trusted reviews" }] } });
		track("docs/logo.svg", "trusted reviews\n");

		expect(check("--json").json().hits).toHaveLength(0);
	});

	it("exempts only the Section A path itself, not a file merely ending in it", () => {
		writeMap([row("CLAUDE.md", "binary-asset")], [entry("B1")]);
		writeVocab({ B1: { phrases: [{ literal: "trusted reviews" }] } });
		track("vendor/pkg/CLAUDE.md", "trusted reviews\n");

		const hits = check("--json").json().hits;
		expect(hits).toHaveLength(1);
		expect(hits[0].file).toBe("vendor/pkg/CLAUDE.md");
	});

	it("ignores an untracked file", () => {
		plant([{ literal: "trusted reviews" }]);
		fs.writeFileSync(path.join(repo, "scratch.md"), "trusted reviews\n");

		expect(check("--json").json().hits).toHaveLength(0);
	});

	it("is BROKEN when Section A parses no row", () => {
		track(
			MAP,
			[
				"# Doc map",
				"",
				"## Section A — document register",
				"",
				"| Path | Role | Class | Update route | Consumes |",
				"|---|---|---|---|---|",
				"",
				"## Section B — load-bearing figure registry",
				"",
				entry("B1"),
			].join("\n"),
		);
		writeVocab({ B1: { phrases: [{ literal: "trusted reviews" }] } });

		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("no Section A row parsed");
	});

	it("is BROKEN when the map cannot be read", () => {
		const r = check("docs/nope.md");
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot read doc map");
	});
});

/*
 * Phrases come from doc-map-retired-vocabulary.json and from nowhere else since
 * mantahostels#591 — the prose fallback is gone, so an absent file is BROKEN. The file is
 * written untracked in most of these; the exemption test tracks it, because
 * that is the state in which a phrase could self-report.
 */
describe("the vocabulary data file", () => {
	const data = "docs/doc-map-retired-vocabulary.json";
	const write = (file: string, body: string) => {
		fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
		fs.writeFileSync(path.join(repo, file), body);
	};
	/* A §B entry with no vocabulary list of its own — a data-file key must name
	 * an entry the map holds, so most fixtures here need one. */
	const bare = (id: string) =>
		`### ${id} · a claim\n\n- **Owner:** \`docs/owner.md\`\n`;

	it("is BROKEN where a bulleted entry has no key in the data file, naming only that entry as scanned by nothing", () => {
		writeMap([], [entry("B1"), bare("B2")]);
		writeVocab({ B2: { phrases: [{ literal: "data phrase" }] } });
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("B1");
		expect(r.out).toContain("scanned by nothing");
		// B2 carries no bullet, so it is owed nothing and is not named.
		expect(r.out).not.toContain("B2");
	});

	it("reads the mid-line bullet spelling, not just the line-initial one", () => {
		writeMap(
			[],
			[
				[
					"### B1 · a settled claim",
					"",
					"- **Owner:** `docs/owner.md`",
					"- **Rejected at #415:** a hard gate (**7%**). **Retired vocabulary:** 1 phrase, in the data file.",
					"",
				].join("\n"),
				bare("B2"),
			],
		);
		// An empty data file is BROKEN in its own right, so B2 keeps the file
		// populated and leaves B1 as the only entry owed a key.
		writeVocab({ B2: { phrases: [{ literal: "data phrase" }] } });
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("B1");
	});

	it("is BROKEN where the bullet is written bare, with no text after it, naming the entry", () => {
		writeMap(
			[],
			[
				["### B1 · a settled claim", "", "- **Retired vocabulary:**", ""].join(
					"\n",
				),
				bare("B2"),
			],
		);
		writeVocab({ B2: { phrases: [{ literal: "data phrase" }] } });
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("B1");
	});

	it("is green where every bulleted entry has its key", () => {
		plant([{ literal: "trusted reviews" }]);
		expect(check().status).toBe(0);
	});

	it("reads phrases from the data file and never the entry's prose", () => {
		writeMap([], [entry("B1", "`old wording`"), bare("B2")]);
		// B1 needs a key of its own or the checker BROKENs on it — a bulleted
		// entry the data file does not name is mantahostels#1247's silent-unscanned case. Its
		// phrase is deliberately absent from docs/copy.md below, so the prose
		// `old wording` is still scanned by nothing and this test still proves it.
		write(
			data,
			JSON.stringify({
				B1: { phrases: [{ literal: "a phrase nothing uses" }] },
				B2: { phrases: [{ literal: "data phrase" }] },
			}),
		);
		track("docs/copy.md", "old wording here\nthe data phrase survives\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("§B2 · data phrase");
		expect(r.out).toContain("docs/copy.md:2");
		expect(r.out).not.toContain("old wording");
	});

	it("greps the stem where one is stated, as in prose", () => {
		writeMap([], [bare("B1")]);
		write(
			data,
			JSON.stringify({
				B1: {
					phrases: [
						{
							literal: "trust is the product",
							stem: "trust.{0,40}the product",
						},
					],
				},
			}),
		);
		track("docs/copy.md", "the trust that is the product\n");
		expect(check().out).toContain("docs/copy.md:1");
	});

	it("applies the data file's allowlist", () => {
		writeMap([], [bare("B1")]);
		write(
			data,
			JSON.stringify({
				B1: {
					phrases: [{ literal: "trusted reviews" }],
					allowlist: [{ path: "docs/copy.md", lines: [1] }],
				},
			}),
		);
		track("docs/copy.md", "we sell trusted reviews\nagain trusted reviews\n");
		const r = check("--json");
		expect(r.json().hits).toMatchObject([{ file: "docs/copy.md", line: 2 }]);
	});

	it("exempts all three data files from the scan itself", () => {
		writeMap([], [bare("B1")]);
		track(
			data,
			JSON.stringify({ B1: { phrases: [{ literal: "trusted reviews" }] } }),
		);
		track(
			"docs/doc-map-superseded.json",
			JSON.stringify({ B1: [{ needle: "trusted reviews", scanned: false }] }),
		);
		track(
			"docs/doc-map-restatements.json",
			JSON.stringify({
				B1: { paths: [{ path: "docs/a.md", locator: "trusted reviews" }] },
			}),
		);
		track("docs/copy.md", "we sell trusted reviews\n");
		const r = check("--json");
		expect(r.json().hits).toMatchObject([{ file: "docs/copy.md" }]);
	});

	it("lists a literal that reduces to nothing as not scanned", () => {
		writeMap([], [bare("B1")]);
		write(data, JSON.stringify({ B1: { phrases: [{ literal: "``" }] } }));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("Not scanned");
		expect(r.out).toContain("§B1");
	});

	it("is BROKEN where the data file keys an entry the map lacks, naming the key", () => {
		writeMap([], [bare("B1")]);
		write(
			data,
			JSON.stringify({ B9: { phrases: [{ literal: "trusted reviews" }] } }),
		);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("B9");
	});

	it("is BROKEN on a data file that exists but will not load, naming it — never a fallback", () => {
		writeMap([], [entry("B1", "`trusted reviews`")]);
		write(data, "{ not json");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("doc-map-retired-vocabulary.json");
	});

	/* The mutation the spec called the one that matters most: with no file and
	 * no fallback the scan has nothing to grep for, and a clean OK over a repo
	 * full of retired wording is indistinguishable from a repo carrying none. */
	it("is BROKEN where the data file is missing — never a silent clean scan", () => {
		writeMap([], [entry("B1", "`trusted reviews`")]);
		track("docs/copy.md", "we sell trusted reviews\n");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("is missing");
		expect(r.out).not.toContain("OK:");
	});

	it("is BROKEN on a data file holding no entries at all", () => {
		writeMap([], [bare("B1")]);
		write(data, "{}");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("holds no entries");
	});

	// A day-one map has no §B entries, so an empty file is its real state (#3).
	it("accepts a data file holding no entries where §B holds none either", () => {
		writeMap([], []);
		write(data, "{}");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("holds no entries");
	});

	it("takes the data directory from --data-dir", () => {
		writeMap([], [bare("B1")]);
		write(
			"dd/doc-map-retired-vocabulary.json",
			JSON.stringify({ B1: { phrases: [{ literal: "trusted reviews" }] } }),
		);
		track("docs/copy.md", "we sell trusted reviews\n");
		expect(check("--data-dir", "dd").out).toContain("docs/copy.md:1");
	});
});
