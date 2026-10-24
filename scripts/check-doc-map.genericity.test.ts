// @vitest-environment node
/*
 * The genericity gate (docs/repo-boundary.md §6.1, mantahostels#3510): check-doc-map.js
 * runs green against a repository whose doc map holds NO host string — no
 * `manta`, `hostel`, `lucmo` anywhere in its tracked bytes — and every
 * assertion it makes trips on one fault applied to that green base.
 *
 * Self-contained by design: it copies the handful of helpers it needs from
 * check-doc-map.test.ts rather than importing them, because that file's own
 * fixture embeds two host strings (`CLAUDE.md` in `initBase`, the
 * `owner/repo` admission permalink in `admissionsFor`) that this
 * gate exists to keep out.
 *
 * THE BASE IS THE PASSING FORM OF EVERY ASSERTION. Each case below applies one
 * fault to a fresh copy of it and asserts the severity, the tag and the exit
 * code that fault owes. The message half of §X3 — that the output names the
 * offender and the way out — is check-doc-map.test.ts's, against the real map.
 *
 * Assertion 16 (pool-byte trigger verdict) is reached through
 * docs/working-contract.md, a member of this repo's declared pool
 * (vitest.setup.ts's WFC_ALWAYS_LOADED) carrying no host string; the other
 * three members are host root files or spell `manta`.
 *
 * Breaking it costs the core's portability: check-doc-map.js is the doc-map
 * gate in every adopter's .husky/pre-commit and roadmap-digest.yml, and a
 * loosened case lets a host assumption back into the engine unseen, to fail
 * first in an adopter's repo.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-doc-map.js");
const HOST_STRING = /manta|hostel|lucmo|mantahostels/i;

const MAP = "docs/doc-map.md";
const CLASSES = "docs/doc-map-classes.json";
const RESTATEMENTS = "docs/doc-map-restatements.json";
const SUPERSEDED = "docs/doc-map-superseded.json";
const VOCAB = "docs/doc-map-retired-vocabulary.json";
const HIGH_WATER = "docs/doc-map-high-water.json";
const ADMISSIONS = "docs/doc-map-admissions.json";

/* The engine requires a github.com permalink (lib/doc-map.js
 * ADMISSION_COMMENT_URL). */
const commentUrl = (n: number) =>
	`https://github.com/example-org/example-repo/issues/${n}#issuecomment-${n}00`;

type Sidecar = Record<string, Record<string, unknown>>;
interface Ref {
	kind: string;
	ref: string;
	gloss?: string;
}

/* ── repo plumbing, per fixture directory ─────────────────────────────── */

const ctxFor = (repo: string) => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	const write = (file: string, body: string) => {
		fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
		fs.writeFileSync(path.join(repo, file), body);
	};
	const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8");
	const track = (file: string, body: string) => {
		write(file, body);
		git("add", "--", file);
	};
	const commit = (message: string, hoursAgo = 0) => {
		const date = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
		execFileSync("git", ["commit", "-qm", message], {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
		});
	};
	/* register-doc.js's canonical bytes (mantahostels#3353): sorted keys, tabs, newline. */
	const writeClasses = (data: Sidecar) => {
		const sorted: Sidecar = {};
		for (const k of Object.keys(data).sort()) sorted[k] = data[k];
		write(CLASSES, `${JSON.stringify(sorted, null, "\t")}\n`);
	};
	const writeJson = (file: string, data: unknown) =>
		write(file, `${JSON.stringify(data)}\n`);
	return { repo, git, write, read, track, commit, writeClasses, writeJson };
};
type Ctx = ReturnType<typeof ctxFor>;

/* ── §A rows, hand-rendered in the shape the engine's renderer emits ───── */

const ROUTE: Record<string, string> = {
	"source-of-truth": "Direct",
	derived: "Regenerate only",
};
const KIND: Record<string, string> = {
	".json": "data file",
	".html": "HTML document",
};

const title = (p: string) => {
	const base = p.split("/").pop() || p;
	const opened = base.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
	return opened.charAt(0).toUpperCase() + opened.slice(1);
};

const refText = (r: Ref) => {
	let ref: string;
	if (r.kind === "figure") ref = `§${r.ref}`;
	else if (r.kind === "issue") ref = `#${r.ref}`;
	else ref = `\`${r.ref}\``;
	return r.gloss ? `${ref} (${r.gloss})` : ref;
};

const rowFor = (p: string, e: Record<string, unknown>) => {
	const kind = KIND[p.match(/\.[^./]+$/)?.[0] || ""];
	const role =
		(e.role as string) || (kind ? `${title(p)} — ${kind}` : title(p));
	const consumes = Array.isArray(e.consumes)
		? (e.consumes as Ref[]).map(refText).join(" · ")
		: "—";
	return `| \`${p}\` | ${role} | \`${e.class}\` | ${(e.route as string) || ROUTE[e.class as string]} | ${consumes} |`;
};

const sectionA = (sidecar: Sidecar) =>
	[
		"### Docs",
		"",
		"| Path | Role | Class | Update route | Consumes |",
		"|---|---|---|---|---|",
		...Object.keys(sidecar)
			.sort()
			.map((p) => rowFor(p, sidecar[p])),
	].join("\n");

/* ── the base map ─────────────────────────────────────────────────────── */

const entry = (id: string, name: string, prose: string, bullets: string[]) =>
	[`### ${id} · ${name}`, "", prose, "", ...bullets].join("\n");

const B1 = entry("B1", "Widget count", "The count of widgets is 12.", [
	"- **Owner:** `docs/notes.md`",
	"- **Restated in:** 1 path, in `docs/doc-map-restatements.json`.",
	"- **Settled at #1**, 1 January 2026.",
]);
const B3 = entry("B3", "Gadget rate", "The gadget rate is 3 per hour.", [
	"- **Restated in:** none — nothing restates it.",
	"- **Settled at #3**, 3 January 2026.",
]);

const ledgerOf = (entries: string[]) =>
	["## Ledger", "", "Sheds paid, most recent first:", ...entries].join("\n");

const LEDGER = ledgerOf([
	"  - #2, 2 January 2026, -10 B, trimmed a sentence. **Residual:** none. **Prediction:** the sentence stays out. **Trigger:** none nameable — no rule moved.",
	"  - #1, 1 January 2026, -5 B, trimmed a word. **Residual:** none.",
]);

const ROUTES = [
	"### C1 · Where is the widget count?",
	"",
	"- **Read:** `docs/notes.md`",
	"- **Not:** `docs/guide.md`",
	"",
	"### C2 · How do I use the guide?",
	"",
	"- **Read:** `docs/guide.md`",
].join("\n");

interface MapOpts {
	sidecar: Sidecar;
	entries?: string[];
	ledger?: string;
}

const mapDoc = ({ sidecar, entries = [B1, B3], ledger = LEDGER }: MapOpts) =>
	[
		"# Doc map",
		"",
		"v1.0 · 1 January 2026",
		"",
		"The register of every document in this repository.",
		"",
		"## Authority classes",
		"",
		"Five tokens: `source-of-truth`, `derived`, `generated-only`, `free-edit`, `binary-asset`.",
		"",
		"## Section A — document register",
		"",
		sectionA(sidecar),
		"",
		"## Section B — figure registry",
		"",
		"Entries carry `Owner`, `Inputs`, `Restated in`, `Supersedes`, `Settled at`.",
		"",
		...entries.flatMap((e) => [e, ""]),
		"## Section C — question routes",
		"",
		ROUTES,
		"",
		ledger,
		"",
	].join("\n");

const doc = (cls: string, extra: Record<string, unknown> = {}) => ({
	section: "Docs",
	class: cls,
	classQualifier: null,
	role: null,
	route: null,
	consumes: null,
	...extra,
});

const baseSidecar = (): Sidecar => ({
	[ADMISSIONS]: doc("derived"),
	[CLASSES]: doc("source-of-truth"),
	[RESTATEMENTS]: doc("source-of-truth"),
	[VOCAB]: doc("source-of-truth"),
	[SUPERSEDED]: doc("source-of-truth"),
	[HIGH_WATER]: doc("source-of-truth"),
	[MAP]: doc("source-of-truth", { reader: "agent" }),
	"docs/guide.html": doc("derived", {
		reader: "both",
		consumes: [{ kind: "path", ref: "docs/guide.md" }],
	}),
	"docs/guide.md": doc("source-of-truth", {
		reader: "both",
		consumes: [
			{ kind: "figure", ref: "B1" },
			{ kind: "path", ref: "docs/notes.md", gloss: "with §B1: its source" },
		],
	}),
	"docs/notes.md": doc("source-of-truth", { reader: "agent" }),
});

const baseRestatements = () => ({
	B1: {
		paths: [
			{ path: "docs/notes.md", locator: 'the line "widget count is 12"' },
		],
	},
});
/* B2 was removed, so the mark stands at 2. */
const baseHighWater = () => ({ highWaterMark: 2 });
const baseAdmissions = () => ({
	B1: { settledAt: 1, confirmed: "A", commentUrl: commentUrl(1) },
	B3: { settledAt: 3, confirmed: "yes", commentUrl: commentUrl(3) },
});
const admission = (n: number) => ({
	settledAt: n,
	confirmed: "A",
	commentUrl: commentUrl(n),
});

/** Writes the sidecar and re-renders §A from it. */
const writeAll = (c: Ctx, opts: MapOpts) => {
	c.writeClasses(opts.sidecar);
	c.write(MAP, mapDoc(opts));
};

/* PAIRING_GRACE_MS (lib/doc-map.js) is 6 h: a commit 8 h old is past the
 * grace window, one 0 h old is inside it. */
const PAST_GRACE_HOURS = 8;
const IN_GRACE_HOURS = 0;
/* The prose cap assertions 14, 18, 21 and 22 measure against (mantahostels#1384). */
const CAP_WORDS = 300;

const build = (dir: string) => {
	const c = ctxFor(dir);
	c.git("init", "-q", ".");
	c.git("config", "user.email", "fixture@example.com");
	c.git("config", "user.name", "fixture");
	c.write("docs/notes.md", "The widget count is 12.\n");
	c.write("docs/guide.md", "A guide to the widgets.\n");
	c.write("docs/guide.html", "<p>A guide to the widgets.</p>\n");
	writeAll(c, { sidecar: baseSidecar() });
	c.writeJson(RESTATEMENTS, baseRestatements());
	c.writeJson(SUPERSEDED, {});
	c.writeJson(VOCAB, {});
	c.writeJson(HIGH_WATER, baseHighWater());
	c.writeJson(ADMISSIONS, baseAdmissions());
	c.git("add", "-A");
	c.commit("base", PAST_GRACE_HOURS);
	return c;
};

const words = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

const MARKED_B3 = entry("B3", "Gadget rate", words(CAP_WORDS + 20), [
	"- **Over cap by ruling (#9):** cannot be cut.",
	"- **Restated in:** none — nothing restates it.",
	"- **Settled at #3**, 3 January 2026.",
]);

/** The base plus a HEAD where B3 is over cap and marked (assertions 22, 24). */
const buildMarked = (dir: string) => {
	const c = build(dir);
	writeAll(c, { sidecar: baseSidecar(), entries: [B1, MARKED_B3] });
	c.git("add", "-A");
	c.commit("mark B3", PAST_GRACE_HOURS);
	return c;
};

const template = defineTemplate((dir) => {
	build(dir);
});
const markedTemplate = defineTemplate((dir) => {
	buildMarked(dir);
});

/* ── running the checker ──────────────────────────────────────────────── */

interface Finding {
	severity: string;
	tag: string;
}

const check = (repo: string) => {
	const r = runInProcess(SCRIPT, ["--json"], {
		cwd: repo,
		env: { ...process.env },
	});
	let json: { outcome?: string; findings?: Finding[] } = {};
	try {
		json = JSON.parse(r.stdout);
	} catch {
		// A crash leaves no envelope; the assertions below then fail on `outcome`.
	}
	return {
		status: r.status,
		outcome: json.outcome,
		tags: (json.findings || []).map((f) => `${f.severity} ${f.tag}`),
		out: `${r.stdout}${r.stderr}`,
	};
};

/** Every tracked file's bytes, for the host-string grep. */
const trackedText = (c: Ctx) =>
	c
		.git("ls-files")
		.split("\n")
		.filter(Boolean)
		.map((f) => `${f}\n${c.read(f)}`)
		.join("\n");

/* ── the cases ──────────────────────────────────────────────────────────── */

const ghostSidecar = () => ({
	...baseSidecar(),
	"docs/ghost.md": doc("source-of-truth", { reader: "agent" }),
});

const B4 = (prose: string) =>
	entry("B4", "New figure", prose, [
		"- **Restated in:** none — nothing restates it.",
		"- **Settled at #4**, 4 January 2026.",
	]);

interface Case {
	assertion: number;
	fault: (c: Ctx) => void;
	expected: string;
}

const cases: Record<string, Case> = {
	"UNCOVERED — a tracked in-scope file with no register key, past grace": {
		assertion: 1,
		fault: (c) => {
			c.track("docs/extra.md", "extra\n");
			c.commit("add extra", PAST_GRACE_HOURS);
		},
		expected: "FAIL UNCOVERED",
	},
	"UNCOVERED-GRACE — the same file inside the grace window": {
		assertion: 1,
		fault: (c) => {
			c.track("docs/extra.md", "extra\n");
			c.commit("add extra", IN_GRACE_HOURS);
		},
		expected: "WARN UNCOVERED-GRACE",
	},
	"DEAD-ENTRY — a register row naming no file, past grace": {
		assertion: 2,
		fault: (c) => {
			writeAll(c, { sidecar: ghostSidecar() });
			c.git("add", "-A");
			c.commit("ghost row", PAST_GRACE_HOURS);
		},
		expected: "FAIL DEAD-ENTRY",
	},
	"DEAD-ENTRY-GRACE — the same row inside the grace window": {
		assertion: 2,
		fault: (c) => {
			writeAll(c, { sidecar: ghostSidecar() });
			c.git("add", "-A");
			c.commit("ghost row", IN_GRACE_HOURS);
		},
		expected: "WARN DEAD-ENTRY-GRACE",
	},
	"UNTRACKED-ENTRY — the row's file is on disk but untracked": {
		assertion: 2,
		fault: (c) => {
			writeAll(c, { sidecar: ghostSidecar() });
			c.git("add", "-A");
			c.commit("ghost row", PAST_GRACE_HOURS);
			c.write("docs/ghost.md", "here\n");
		},
		expected: "WARN UNTRACKED-ENTRY",
	},
	"DEAD-ROUTE — a §C route to a file that does not exist": {
		assertion: 4,
		fault: (c) =>
			c.write(
				MAP,
				c
					.read(MAP)
					.replace("**Read:** `docs/guide.md`", "**Read:** `docs/missing.md`"),
			),
		expected: "FAIL DEAD-ROUTE",
	},
	"UNTRACKED-ROUTE — a §C route to a file on disk but untracked": {
		assertion: 4,
		fault: (c) => {
			c.write(
				MAP,
				c
					.read(MAP)
					.replace("**Read:** `docs/guide.md`", "**Read:** `docs/pending.md`"),
			);
			c.write("docs/pending.md", "pending\n");
		},
		expected: "WARN UNTRACKED-ROUTE",
	},
	"DEAD-RESTATEMENT — a restatement path naming no file": {
		assertion: 5,
		fault: (c) =>
			c.writeJson(RESTATEMENTS, { B1: { paths: [{ path: "docs/gone.md" }] } }),
		expected: "FAIL DEAD-RESTATEMENT",
	},
	"DUPLICATE-ENTRY-ID — two `### B1` headings": {
		assertion: 6,
		fault: (c) =>
			c.write(
				MAP,
				c.read(MAP).replace("### B3 · Gadget rate", "### B1 · Gadget rate"),
			),
		expected: "FAIL DUPLICATE-ENTRY-ID",
	},
	"ROUTE-ID-GAP — §C ids C1, C3": {
		assertion: 7,
		fault: (c) => c.write(MAP, c.read(MAP).replace("### C2 ·", "### C3 ·")),
		expected: "FAIL ROUTE-ID-GAP",
	},
	"DUPLICATE-REGISTER-KEY — a key repeated in the sidecar's bytes": {
		assertion: 8,
		fault: (c) =>
			c.write(
				CLASSES,
				c
					.read(CLASSES)
					.replace(
						/\n}\n$/,
						',\n\t"docs/notes.md": {"section": "Docs", "class": "derived"}\n}\n',
					),
			),
		expected: "FAIL DUPLICATE-REGISTER-KEY",
	},
	"STRAY-ENTRY — a `### B4` below §C": {
		assertion: 9,
		fault: (c) => {
			c.write(MAP, `${c.read(MAP)}\n${B4("A figure below §C.")}\n`);
			c.writeJson(ADMISSIONS, { ...baseAdmissions(), B4: admission(4) });
		},
		expected: "FAIL STRAY-ENTRY",
	},
	"SETTLED-AT-MISSING — an entry with no `Settled at` bullet": {
		assertion: 10,
		fault: (c) =>
			c.write(
				MAP,
				c.read(MAP).replace("- **Settled at #3**, 3 January 2026.\n", ""),
			),
		expected: "FAIL SETTLED-AT-MISSING",
	},
	"POINTER-SHAPE — pointer says 1 path, sidecar holds 2, map clean": {
		assertion: 11,
		fault: (c) =>
			c.writeJson(RESTATEMENTS, {
				B1: { paths: [{ path: "docs/notes.md" }, { path: "docs/guide.md" }] },
			}),
		expected: "FAIL POINTER-SHAPE",
	},
	"POINTER-SHAPE — the same fault on a dirty map, softened to WARN": {
		assertion: 11,
		fault: (c) => {
			c.writeJson(RESTATEMENTS, {
				B1: { paths: [{ path: "docs/notes.md" }, { path: "docs/guide.md" }] },
			});
			c.write(MAP, `${c.read(MAP)}\n`);
		},
		expected: "WARN POINTER-SHAPE",
	},
	"REUSED-ENTRY-ID — a new B2, at the mark": {
		assertion: 12,
		fault: (c) => {
			const B2 = entry("B2", "Gizmo size", "The gizmo size is 4 cm.", [
				"- **Restated in:** none — nothing restates it.",
				"- **Settled at #2**, 2 January 2026.",
			]);
			writeAll(c, { sidecar: baseSidecar(), entries: [B1, B2, B3] });
			c.writeJson(ADMISSIONS, { ...baseAdmissions(), B2: admission(2) });
		},
		expected: "FAIL REUSED-ENTRY-ID",
	},
	"HIGH-WATER-MARK — the mark lowered below HEAD's": {
		assertion: 13,
		fault: (c) => c.writeJson(HIGH_WATER, { highWaterMark: 1 }),
		expected: "FAIL HIGH-WATER-MARK",
	},
	"NEW-ENTRY-OVER-CAP — a new entry of 301 prose words": {
		assertion: 14,
		fault: (c) => {
			writeAll(c, {
				sidecar: baseSidecar(),
				entries: [B1, B3, B4(words(CAP_WORDS + 1))],
			});
			c.writeJson(ADMISSIONS, { ...baseAdmissions(), B4: admission(4) });
		},
		expected: "FAIL NEW-ENTRY-OVER-CAP",
	},
	"LEDGER-TRIGGER-VERDICT — bytes staged into the pool file docs/working-contract.md with no new ledger entry":
		{
			assertion: 16,
			fault: (c) => {
				/* docs/working-contract.md is a declared pool member
				 * (vitest.setup.ts's WFC_ALWAYS_LOADED) carrying no host string, so the pool
				 * delta is reachable host-free. A pool file absent from HEAD reads
				 * as 0 bytes (mantahostels#3526), so the whole file staged in one step is the
				 * tranche. */
				writeAll(c, {
					sidecar: {
						...baseSidecar(),
						"docs/working-contract.md": doc("source-of-truth", {
							reader: "agent",
						}),
					},
				});
				c.track("docs/working-contract.md", "How work is sequenced.\n");
			},
			expected: "FAIL LEDGER-TRIGGER-VERDICT",
		},
	"LEDGER-ENTRY-OVER-CAP — a non-newest ledger entry over 440 B": {
		assertion: 15,
		fault: (c) =>
			c.write(
				MAP,
				c
					.read(MAP)
					.replace("trimmed a word.", `trimmed a word. ${words(120)}.`),
			),
		expected: "FAIL LEDGER-ENTRY-OVER-CAP",
	},
	"SECTION-A-DRIFT — a hand-edited §A row": {
		assertion: 17,
		fault: (c) =>
			c.write(
				MAP,
				c
					.read(MAP)
					.replace(
						"| `docs/notes.md` | Notes |",
						"| `docs/notes.md` | Notes, edited |",
					),
			),
		expected: "FAIL SECTION-A-DRIFT",
	},
	"ROLE-OVER-CAP — a `role` override of 301 words": {
		assertion: 18,
		fault: (c) => {
			const sidecar = baseSidecar();
			sidecar["docs/notes.md"].role = words(CAP_WORDS + 1);
			writeAll(c, { sidecar });
		},
		expected: "FAIL ROLE-OVER-CAP",
	},
	"UNKNOWN-CLASS — a class token outside the six": {
		assertion: 19,
		fault: (c) => {
			const sidecar = baseSidecar();
			sidecar["docs/notes.md"].class = "bogus";
			writeAll(c, { sidecar });
		},
		expected: "FAIL UNKNOWN-CLASS",
	},
	"LEDGER-COMPACTION-VERDICT — HEAD's newest entry carried a prediction, its compaction no verdict":
		{
			assertion: 20,
			fault: (c) =>
				writeAll(c, {
					sidecar: baseSidecar(),
					ledger: ledgerOf([
						"  - #3, 3 January 2026, -20 B, trimmed a paragraph. **Residual:** none. **Trigger:** none nameable — no rule moved.",
						"  - #2, 2 January 2026, -10 B, trimmed a sentence. **Residual:** none.",
						"  - #1, 1 January 2026, -5 B, trimmed a word. **Residual:** none.",
					]),
				}),
			expected: "FAIL LEDGER-COMPACTION-VERDICT",
		},
	"STALE-OVER-CAP-MARKER — a marker on an entry under the cap": {
		assertion: 21,
		fault: (c) =>
			c.write(
				MAP,
				c
					.read(MAP)
					.replace(
						"- **Settled at #3**",
						"- **Over cap by ruling (#9):** held.\n- **Settled at #3**",
					),
			),
		expected: "FAIL STALE-OVER-CAP-MARKER",
	},
	"MALFORMED-OVER-CAP-MARKER — the marker without its bold": {
		assertion: 23,
		fault: (c) =>
			c.write(
				MAP,
				c
					.read(MAP)
					.replace(
						"- **Settled at #3**",
						"- Over cap by ruling (#9): held.\n- **Settled at #3**",
					),
			),
		expected: "WARN MALFORMED-OVER-CAP-MARKER",
	},
	"DEAD-CONSUMES — a `path` reference to no file, map clean": {
		assertion: 25,
		fault: (c) => {
			const sidecar = baseSidecar();
			sidecar["docs/guide.html"].consumes = [
				{ kind: "path", ref: "docs/nowhere.md" },
			];
			writeAll(c, { sidecar });
			c.git("add", "-A");
			c.commit("dead consumes", IN_GRACE_HOURS);
		},
		expected: "FAIL DEAD-CONSUMES",
	},
	"DEAD-CONSUMES — a `figure` reference to the removed B2": {
		assertion: 25,
		fault: (c) => {
			const sidecar = baseSidecar();
			sidecar["docs/guide.md"].consumes = [{ kind: "figure", ref: "B2" }];
			writeAll(c, { sidecar });
			c.git("add", "-A");
			c.commit("removed figure", IN_GRACE_HOURS);
		},
		expected: "FAIL DEAD-CONSUMES",
	},
	"MALFORMED-CONSUMES — an unknown `kind`": {
		assertion: 25,
		fault: (c) => {
			const sidecar = baseSidecar();
			sidecar["docs/guide.md"].consumes = [{ kind: "bogus", ref: "x" }];
			writeAll(c, { sidecar });
		},
		expected: "FAIL MALFORMED-CONSUMES",
	},
	"UNTRACKED-CONSUMES — a `path` reference to a file on disk but untracked": {
		assertion: 25,
		fault: (c) => {
			/* On guide.md, not the page: a page whose source lost its key trips
			 * PAGE-SOURCE (assertion 32) too, and this case is about the WARN alone. */
			const sidecar = baseSidecar();
			sidecar["docs/guide.md"].consumes = [
				{ kind: "path", ref: "docs/pending.md" },
			];
			writeAll(c, { sidecar });
			c.git("add", "-A");
			c.commit("pending consumes", IN_GRACE_HOURS);
			c.write("docs/pending.md", "pending\n");
		},
		expected: "WARN UNTRACKED-CONSUMES",
	},
	"PAIR-SCOPE — a `with #9:` gloss naming the wrong neighbour": {
		assertion: 26,
		fault: (c) => {
			const sidecar = baseSidecar();
			(sidecar["docs/guide.md"].consumes as Ref[])[1].gloss =
				"with #9: its source";
			writeAll(c, { sidecar });
		},
		expected: "FAIL PAIR-SCOPE",
	},
	"LINE-LOCATOR — an `L1` token in a locator": {
		assertion: 27,
		fault: (c) =>
			c.writeJson(RESTATEMENTS, {
				B1: { paths: [{ path: "docs/notes.md", locator: "L1" }] },
			}),
		expected: "FAIL LINE-LOCATOR",
	},
	"LINE-LOCATOR — a `file:line` citation in a gloss": {
		assertion: 27,
		fault: (c) =>
			c.writeJson(RESTATEMENTS, {
				B1: {
					paths: [{ path: "docs/notes.md", gloss: "see docs/notes.md:1" }],
				},
			}),
		expected: "FAIL LINE-LOCATOR",
	},
	"DEAD-ANCHOR — a quoted phrase the file does not hold": {
		assertion: 28,
		fault: (c) =>
			c.writeJson(RESTATEMENTS, {
				B1: {
					paths: [
						{ path: "docs/notes.md", locator: 'the line "no such phrase"' },
					],
				},
			}),
		expected: "FAIL DEAD-ANCHOR",
	},
	"UNRECORDED-ADMISSION — a new entry with no admission row": {
		assertion: 29,
		fault: (c) =>
			writeAll(c, {
				sidecar: baseSidecar(),
				entries: [B1, B3, B4("A new figure.")],
			}),
		expected: "FAIL UNRECORDED-ADMISSION",
	},
	"SIDECAR-NOT-CANONICAL — two-space indentation": {
		assertion: 30,
		fault: (c) =>
			c.write(
				CLASSES,
				`${JSON.stringify(JSON.parse(c.read(CLASSES)), null, 2)}\n`,
			),
		expected: "FAIL SIDECAR-NOT-CANONICAL",
	},
	"MISSING-READER — a `.md` key with no reader": {
		assertion: 31,
		fault: (c) => {
			const sidecar = baseSidecar();
			delete sidecar["docs/notes.md"].reader;
			writeAll(c, { sidecar });
		},
		expected: "FAIL MISSING-READER",
	},
	"UNKNOWN-READER — a reader outside the three": {
		assertion: 31,
		fault: (c) => {
			const sidecar = baseSidecar();
			sidecar["docs/notes.md"].reader = "robot";
			writeAll(c, { sidecar });
		},
		expected: "FAIL UNKNOWN-READER",
	},
	"READER-ON-NON-PROSE — a reader on a `.json` key": {
		assertion: 31,
		fault: (c) => {
			const sidecar = baseSidecar();
			sidecar[HIGH_WATER].reader = "agent";
			writeAll(c, { sidecar });
		},
		expected: "FAIL READER-ON-NON-PROSE",
	},
	"PAGE-SOURCE — a page whose source is read by `agent` alone": {
		assertion: 32,
		fault: (c) => {
			const sidecar = baseSidecar();
			sidecar["docs/guide.md"].reader = "agent";
			writeAll(c, { sidecar });
		},
		expected: "FAIL PAGE-SOURCE",
	},
};

const markedCases: Record<string, Case> = {
	"OVER-CAP-ENTRY-GREW — a marked over-cap entry grows": {
		assertion: 22,
		fault: (c) =>
			c.write(
				MAP,
				c.read(MAP).replace(words(CAP_WORDS + 20), words(CAP_WORDS + 30)),
			),
		expected: "WARN OVER-CAP-ENTRY-GREW",
	},
	"OVER-CAP-MARKER-DROPPED — a marked over-cap entry loses its marker": {
		assertion: 24,
		fault: (c) =>
			c.write(
				MAP,
				c
					.read(MAP)
					.replace("- **Over cap by ruling (#9):** cannot be cut.\n", ""),
			),
		expected: "WARN OVER-CAP-MARKER-DROPPED",
	},
};

/* ── the gate ─────────────────────────────────────────────────────────── */

const withFresh = (
	t: typeof template,
	prefix: string,
	body: (c: Ctx) => void,
) => {
	const dir = mkScratchDir(prefix);
	t.instantiate(dir);
	const c = ctxFor(dir);
	try {
		body(c);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

describe("check-doc-map.js against a doc map holding no host string (mantahostels#3510)", () => {
	it("the fixture tree holds no host string", () =>
		withFresh(template, "doc-map-generic-", (c) => {
			expect(trackedText(c)).not.toMatch(HOST_STRING);
			expect(c.git("ls-files").split("\n").filter(Boolean)).toHaveLength(10);
		}));

	it("runs green — the passing form of every assertion below", () =>
		withFresh(template, "doc-map-generic-", (c) => {
			const r = check(c.repo);
			expect(r.out).toContain(
				"OK: doc map covers all 10 tracked files in scope",
			);
			expect(r.status).toBe(0);
			expect(r.tags).toEqual([]);
		}));

	it("the marked base (assertions 22 and 24) is itself green", () =>
		withFresh(markedTemplate, "doc-map-generic-marked-", (c) => {
			expect(trackedText(c)).not.toMatch(HOST_STRING);
			const r = check(c.repo);
			expect(r.status, r.out).toBe(0);
			expect(r.tags).toEqual([]);
		}));

	it("the compacted-with-verdict ledger stays green (assertion 20's pass form)", () =>
		withFresh(template, "doc-map-generic-", (c) => {
			writeAll(c, {
				sidecar: baseSidecar(),
				ledger: ledgerOf([
					"  - #3, 3 January 2026, -20 B, trimmed a paragraph. **Residual:** none. **Trigger:** none nameable — no rule moved.",
					"  - #2, 2 January 2026, -10 B, trimmed a sentence. **Residual:** none. **Verdict: held** — the sentence stayed out for a year.",
					"  - #1, 1 January 2026, -5 B, trimmed a word. **Residual:** none.",
				]),
			});
			const r = check(c.repo);
			expect(r.status, r.out).toBe(0);
			expect(r.tags).toEqual([]);
		}));

	const exitFor = (expected: string) => (expected.startsWith("FAIL") ? 1 : 0);
	const run = (
		t: typeof template,
		prefix: string,
		table: Record<string, Case>,
	) => {
		for (const [name, { assertion, fault, expected }] of Object.entries(table))
			it(`reports ${expected} on ${name.split(" — ")[1]}, exiting ${exitFor(expected)} (assertion ${assertion})`, () =>
				withFresh(t, prefix, (c) => {
					fault(c);
					const r = check(c.repo);
					expect(r.tags, r.out).toContain(expected);
					expect(r.status).toBe(exitFor(expected));
				}));
	};
	run(template, "doc-map-generic-", cases);
	run(markedTemplate, "doc-map-generic-marked-", markedCases);
});
