#!/usr/bin/env node
/*
 * generate-rule-fragments.js — render `docs/agents/rules/<id>.txt` from an
 * anchor pair in the document that authors the rule (mantahostels#2493, spec mantahostels#2457 §T2).
 *
 * WHY A GENERATOR RATHER THAN A CUT. `docs/agents/triage-labels.md` and
 * `docs/agents/issue-tracker.md` stay the authored home of their rules and keep
 * their `docs/doc-map.md` §A class; the fragment is a second copy on disk,
 * policed by `--check` rather than by a reader's memory. The fragment is never
 * the sole home (§T2): that would be a one-way change that strands each
 * document's §Where decisions get written material.
 *
 * THE ANCHOR PAIR is two HTML comments on their own lines:
 *
 *     <!-- rule:<id>:begin -->
 *     …the rule…
 *     <!-- rule:<id>:end -->
 *
 * The region is every line BETWEEN them, joined by newlines with one trailing
 * newline.
 *
 * THE MANIFEST records, per id, the document and the trigger that makes the
 * rule bind. Nothing reads that field yet. The trigger is never inferred from
 * the anchor: an anchored id with no TRIGGERS row refuses.
 *
 * --sources prints the documents scanned, one a line, so `.husky/pre-commit`
 * arms `--check` on this list rather than a copy of it (#3118).
 *
 * EXIT CODES: 0 wrote (or, under --check, everything matches); 1 a fault —
 * an unpaired anchor, an empty region, an id the grammar refuses, an id with
 * no TRIGGERS row, or (under --check) a fragment or manifest out of step.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { caught } = require("./lib/caught.js");

/* Every path here — the source documents and the fragment store — is host
 * content (#1): a plugin install keeps this script beside the core's own
 * files, but `docs/agents/rules` lives in the repository being worked on. */
const ROOT = hostRoot();
const STORE = path.join(ROOT, "docs", "agents", "rules");
/* The host's store, never rule-text's store in force: that falls back to the
 * core's own where the host has none, and a write there from an adopter
 * would overwrite the core's manifest. */
const MANIFEST = path.join(
	STORE,
	path.basename(require("./lib/rule-text").manifestPath()),
);

/* The documents scanned for anchors, and the trigger each anchored id binds
 * at. One table, not a per-document one: an id is unique across the store, so
 * a second table would only let two documents claim the same id. Repo-relative
 * with `/`, as git names a staged path: `--sources` hands them to the hook's
 * `armed -F`. */
const SOURCES = [
	"docs/agents/triage-labels.md",
	"docs/agents/issue-tracker.md",
	"docs/code-standards-base.md",
	"docs/agents/dependabot.md",
];

/* scripts/lib/test-rules-inject.js's trigger, shared by base §X8, §X9 and §X10. */
const TEST_WRITE = "a `Write`, `Edit` or `NotebookEdit` to a test file";

/* id → the observable moment the rule binds, in the words a session reads.
 * Never inferred from the anchor. */
/** @type {Record<string, string>} */
const TRIGGERS = {
	"create-command-shape": "a `gh issue create` on the Bash tool",
	"takes-value-vocabulary": "a `gh issue create` on the Bash tool",
	"issue-parent-unplaced": "a `gh issue create` on the Bash tool",
	"issue-created-assigned": "a `gh issue create` on the Bash tool",
	"close-outstanding-line": "a `gh issue close` on the Bash tool",
	"ticket-criteria-unticked": "a `gh issue close` on the Bash tool",
	"issue-body-raw-write":
		"a `gh issue edit` carrying a body flag on the Bash tool",
	"issue-claim-scope": "a `gh issue edit --add-assignee` on the Bash tool",
	"dependency-edge-false-success":
		"a `gh api` on an issue's `dependencies/blocked_by` or `sub_issues` endpoint, on the Bash tool",
	"citation-number-first": "a `gh issue comment` on the Bash tool",
	"blocked-ticket-gate":
		"a `gh issue comment` whose body opens `**Blocked` or `**Refused attempt`, on the Bash tool",
	"citation-inferred-number": "a `gh issue create` on the Bash tool",
	"issue-body-success-signal":
		"a writing `scripts/issue-body.js` subcommand on the Bash tool, `node` in front of it or not",
	"gh-job-dir-unreadable":
		"a `gh issue create`, `comment`, `edit`, `close` or `gh api` on a Bash command whose text carries a path under the job directory",
	"gh-cli-limits":
		"a `gh pr checks`, a `gh` call naming `statusCheckRollup` or a `check-runs` endpoint, a `gh run list --commit`, or a `gh issue view --comments`, on the Bash tool",
	"triage-role-labels":
		"a `gh issue edit` or `gh pr edit` adding or removing a label, on the Bash tool",
	"urgent-label":
		"a `gh issue edit` or `gh pr edit` adding or removing `urgent`, on the Bash tool",
	"waiting-external-vocabulary":
		"a `gh issue edit` or `gh pr edit` adding or removing a `waiting:` label, on the Bash tool — and, unguarded, reading `waiting:external`",
	"dependabot-merge":
		"a `gh pr merge` of a Dependabot pull request, on the Bash tool",
	"commit-closes-keyword":
		"a `git commit` whose message names an issue-closing keyword — on the Bash tool, and at the git hooks whatever route wrote the message (#138)",
	"research-in-tree":
		"a commit adding a file under `docs/research/`, at `.husky/pre-commit`",
	"test-run-cost": TEST_WRITE,
	"test-time-seam": TEST_WRITE,
	"test-reads-visible": TEST_WRITE,

	/* THE SECOND CLASS (mantahostels#2496, mantahostels#2499). No Bash shape observes these — a session
	 * is told the id and the moment in its command's injected index instead, and
	 * fetches the text with scripts/lib/rule-text.sh when that moment arrives.
	 * The trigger text here is that moment, in the reader's own words, not a
	 * guard's match predicate. */
	"roadmap-gating":
		"gating or closing an issue tied to a roadmap card's timing",
	"card-close-route": "closing an issue that carries a roadmap card",
	"issue-title-card-id": "naming a new issue that carries a roadmap card",
	"decisions-search-first":
		"calling a figure, term or card unsourced, undefined or undesigned",
	"research-artefact-scratch":
		"dispatching a research subagent or posting its artefact outside /wayfinder",
	"wayfinder-ops-shapes":
		"a map, child ticket, blocking edge, frontier query, claim or resolve step, or a map left with nothing to resolve",
	"kind-label-vocabulary": "applying or reading a `kind:` label",
	"spec-only-contract":
		"writing, amending or reading a spec, or lifting one filed under a `kind:brief` up to its map with `node scripts/promote-spec.js <brief>`",
	"takes-label-nuances":
		"applying, removing or reading `takes:children` or `takes:human`",
};

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BEGIN_RE = /^<!--\s*rule:([^\s:]+):begin\s*-->$/;
const END_RE = /^<!--\s*rule:([^\s:]+):end\s*-->$/;

/**
 * One document's anchor scan in progress: the region open, if any, the lines
 * it holds so far, and the regions already closed.
 * @typedef {{ source: string, open: string | null, body: string[], out: { id: string, text: string, source: string }[] }} RegionScan
 */

/**
 * Every anchored region in one document. Throws on a fault.
 * @param {string} relPath
 * @returns {{ id: string, text: string, source: string }[]}
 */
function readRegionsIn(relPath) {
	const lines = fs.readFileSync(path.join(ROOT, relPath), "utf8").split("\n");
	/** @type {RegionScan} */
	const scan = { source: relPath, open: null, body: [], out: [] };
	lines.forEach((line, i) => {
		const at = `${relPath}:${i + 1}`;
		const begin = BEGIN_RE.exec(line);
		const end = END_RE.exec(line);
		if (begin) {
			openRegion(scan, begin, at);
			return;
		}
		if (end) {
			closeRegion(scan, end, at);
			return;
		}
		if (scan.open) scan.body.push(line);
	});
	if (scan.open)
		throw new Error(`${relPath}: rule:${scan.open} is never closed`);
	return scan.out;
}

/**
 * A begin anchor: opens its region, refusing one inside another or an id the
 * grammar refuses.
 * @param {RegionScan} scan accumulator: the parser's scan state, its region opened
 * @param {RegExpExecArray} begin
 * @param {string} at
 */
function openRegion(scan, begin, at) {
	const id = requiredGroup(begin, 1, BEGIN_RE);
	if (scan.open)
		throw new Error(`${at}: rule:${id} opens inside rule:${scan.open}`);
	if (!ID_RE.test(id))
		throw new Error(
			`${at}: "${id}" is not a rule id — ids are lowercase kebab-case`,
		);
	scan.open = id;
	scan.body = [];
}

/**
 * An end anchor: closes the open region into `scan.out`, refusing one that
 * closes another id or nothing, or whose region is empty.
 * @param {RegionScan} scan accumulator: the parser's scan state, its region closed into out
 * @param {RegExpExecArray} end
 * @param {string} at
 */
function closeRegion(scan, end, at) {
	const { open } = scan;
	if (open !== end[1])
		throw new Error(
			`${at}: rule:${end[1]} closes ${open ? `rule:${open}` : "nothing"}`,
		);
	const text = `${scan.body.join("\n").replace(/^\n+|\n+$/g, "")}\n`;
	if (!text.trim())
		throw new Error(`${at}: rule:${open}'s anchored region is empty`);
	scan.out.push({ id: open, text, source: scan.source });
	scan.open = null;
}

/**
 * Every anchored region across every source, id-collision checked.
 * @returns {{ id: string, text: string, source: string }[]}
 */
function collect() {
	/** @type {Map<string, { id: string, text: string, source: string }>} */
	const seen = new Map();
	for (const src of SOURCES) {
		/* An adopter need not carry every source — fantasy-books has no
		 * triage-labels.md — so an absent one anchors nothing. Said aloud, since
		 * a silent skip would also hide a source renamed out from under the list. */
		if (!fs.existsSync(path.join(ROOT, src))) {
			process.stdout.write(
				`generate-rule-fragments: SKIP ${src} (absent — anchors nothing)\n`,
			);
			continue;
		}
		for (const r of readRegionsIn(src)) {
			const prior = seen.get(r.id);
			if (prior)
				throw new Error(
					`rule:${r.id} is anchored in both ${prior.source} and ${r.source}`,
				);
			if (!TRIGGERS[r.id])
				throw new Error(
					`rule:${r.id} is anchored in ${r.source} but names no trigger — add a TRIGGERS row in ${path.relative(ROOT, __filename)}`,
				);
			seen.set(r.id, r);
		}
	}
	return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The manifest body for a set of regions. Sorted, so a re-render is stable.
 * @param {{ id: string, text: string, source: string }[]} regions
 */
const manifestFor = (regions) =>
	`${JSON.stringify(
		{
			comment:
				"Generated by scripts/generate-rule-fragments.js. Never hand-edited.",
			rules: Object.fromEntries(
				regions.map((r) => [
					r.id,
					{ source: r.source, trigger: TRIGGERS[r.id] },
				]),
			),
		},
		null,
		"\t",
	)}\n`;

/**
 * The generated files out of step with `regions`, repo-relative; each is
 * rewritten unless `check`.
 * @param {{ id: string, text: string, source: string }[]} regions
 * @param {boolean} check
 * @returns {string[]}
 */
function reconcile(regions, check) {
	const want = new Map(
		regions.map((r) => [path.join(STORE, `${r.id}.txt`), r.text]),
	);
	want.set(MANIFEST, manifestFor(regions));

	const stale = [];
	for (const [file, text] of want) {
		const on = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
		/* Trailing newlines are trimmed by both accessors (lib/rule-text.sh's
		 * command substitution, lib/rule-text.js's own trim), so they cannot make
		 * a fragment stale — comparing them would refuse a commit over bytes no
		 * reader ever sees. The manifest is JSON and compared whole. */
		const same =
			file === MANIFEST
				? on === text
				: on !== null && on.replace(/\n+$/, "") === text.replace(/\n+$/, "");
		if (same) continue;
		stale.push(path.relative(ROOT, file));
		if (check) continue;
		fs.mkdirSync(STORE, { recursive: true });
		fs.writeFileSync(file, text);
	}
	return stale;
}

const USAGE =
	"usage: node scripts/generate-rule-fragments.js [--check | --sources]";

/** @param {string[]} argv */
function main(argv) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--check": "boolean", "--sources": "boolean" },
	});
	if (flags["--sources"] === true && flags["--check"] === true) {
		process.stderr.write(
			`generate-rule-fragments: --check and --sources are exclusive\n${USAGE}\n`,
		);
		return 2;
	}
	if (flags["--sources"] === true) {
		process.stdout.write(SOURCES.map((s) => `${s}\n`).join(""));
		return 0;
	}
	const check = flags["--check"] === true;
	/** @type {{ id: string, text: string, source: string }[]} */
	let regions;
	try {
		regions = collect();
	} catch (e) {
		process.stderr.write(`generate-rule-fragments: ${caught(e).message}\n`);
		return 1;
	}

	const stale = reconcile(regions, check);
	if (check && stale.length > 0) {
		process.stderr.write(
			`generate-rule-fragments: ${stale.length} generated file(s) out of step with their anchored source:\n` +
				stale.map((f) => `  ${f}\n`).join("") +
				`Run \`npm run gen:rule-fragments\` (outside this repo: \`node ${__filename}\`) and commit the result.\n`,
		);
		return 1;
	}
	if (!check && stale.length > 0)
		process.stdout.write(
			`generate-rule-fragments: wrote ${stale.join(", ")}\n`,
		);
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
