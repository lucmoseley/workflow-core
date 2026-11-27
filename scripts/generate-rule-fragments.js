#!/usr/bin/env node

const fs = require("node:fs");
const { capture } = require("./lib/check-sink.js");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args");
const { worktreeRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { trimEndRun, trimRun } = require("./lib/trim-run.js");
const { caught } = require("./lib/caught.js");
const { scriptPath } = require("./lib/script-path.js");

/** @param {string} root */
const storeOf = (root) => path.join(root, "docs", "agents", "rules");
/** @param {string} root */
const manifestOf = (root) =>
	path.join(
		storeOf(root),
		path.basename(require("./lib/rule-text").manifestPath()),
	);

const SOURCES = [
	"docs/agents/triage-labels.md",
	"docs/agents/issue-tracker.md",
	"docs/code-standards-base.md",
	"docs/agents/dependabot.md",
];

const TEST_WRITE = "a `Write`, `Edit` or `NotebookEdit` to a test file";

const TAKES_HUMAN =
	"a `gh issue create`, `gh issue edit` or `scripts/file-issue.js` applying `takes:human` to a body whose Outside line fails";

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
		"a `gh issue create`, `comment`, `edit`, `close` or `gh api` on a Bash command naming a body file under the job directory, in a `gh` body flag or a `cat`",
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
		"a `git commit` whose message names an issue-closing keyword — on the Bash tool, and at the git hooks whatever route wrote the message (workflow-core#138)",
	"research-in-tree":
		"a commit adding a file under `docs/research/`, at `.husky/pre-commit`",
	"test-run-cost": TEST_WRITE,
	"test-time-seam": TEST_WRITE,
	"test-reads-visible": TEST_WRITE,
	"hot-path-cost":
		"a `Write`, `Edit` or `NotebookEdit` to a hot-path program or a hook registration",

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
	"size-line":
		"filing a spec's tickets: how many build units, which chunks may run in parallel, and how the quiz step presents them",
	"spec-only-contract":
		"writing, amending or reading a spec, or lifting one filed under a `kind:brief` up to its map with `node scripts/promote-spec.js <brief>`",
	"takes-label-nuances":
		"applying, removing or reading `takes:children` or `takes:human`",

	"founder-acts": TAKES_HUMAN,
	"no-command-opens-shape": TAKES_HUMAN,
	"repo-file-act": TAKES_HUMAN,
	"gate-basis-line":
		"a `gh issue create`, `scripts/file-issue.js` or `scripts/issue-body.js` write adding a gate line or a prose wait with no basis naming its windows, or a basis with no warrant",
	"close-outstanding-where": "a `gh issue close` on the Bash tool",
	"install-scripts-first":
		"an `npm install` adding a package without `--ignore-scripts`, on the Bash tool",
};

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BEGIN_RE = /^<!--\s*rule:([^\s:]+):begin\s*-->$/;
const END_RE = /^<!--\s*rule:([^\s:]+):end\s*-->$/;
const SPAN_RE = /<!--\s*rule:([^\s:]+):(begin|end)\s*-->/g;
const HAS_SPAN = new RegExp(SPAN_RE.source);

/** @typedef {{ source: string, open: string | null, body: string[], out: { id: string, text: string, source: string }[] }} RegionScan */

/**
 * @param {string} root
 * @param {string} relPath
 * @returns {{ id: string, text: string, source: string }[]}
 */
function readRegionsIn(root, relPath) {
	const lines = fs.readFileSync(path.join(root, relPath), "utf8").split("\n");
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
		else if (HAS_SPAN.test(line))
			throw new Error(`${at}: a rule span sits outside every anchored region`);
	});
	if (scan.open)
		throw new Error(`${relPath}: rule:${scan.open} is never closed`);
	return scan.out;
}

/**
 * @param {RegionScan} scan
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
 * @param {RegionScan} scan
 * @param {RegExpExecArray} end
 * @param {string} at
 */
function closeRegion(scan, end, at) {
	const { open } = scan;
	if (open !== end[1])
		throw new Error(
			`${at}: rule:${end[1]} closes ${open ? `rule:${open}` : "nothing"}`,
		);
	const raw = `${trimRun(scan.body.join("\n"), "\n")}\n`;
	if (!raw.trim())
		throw new Error(`${at}: rule:${open}'s anchored region is empty`);
	const { text, spans } = splitSpans(raw, `${at} (in rule:${open})`);
	scan.out.push({ id: open, text, source: scan.source });
	for (const s of spans) scan.out.push({ ...s, source: scan.source });
	scan.open = null;
}

/**
 * @param {string} raw
 * @param {string} at
 * @returns {{ text: string, spans: { id: string, text: string }[] }}
 */
function splitSpans(raw, at) {
	/** @type {{ id: string, text: string }[]} */
	const spans = [];
	/** @type {{ id: string, from: number } | null} */
	let open = null;
	for (const m of raw.matchAll(SPAN_RE)) {
		const id = requiredGroup(m, 1, SPAN_RE);
		if (m[2] === "begin") open = openSpan(open, id, m, at);
		else {
			spans.push(closeSpan(open, id, raw.slice(open?.from, m.index), at));
			open = null;
		}
	}
	if (open) throw new Error(`${at}: span rule:${open.id} is never closed`);
	return { text: raw.replace(SPAN_RE, ""), spans };
}

/**
 * @param {{ id: string } | null} open
 * @param {string} id
 * @param {RegExpExecArray} m
 * @param {string} at
 * @returns {{ id: string, from: number }}
 */
function openSpan(open, id, m, at) {
	if (open)
		throw new Error(`${at}: span rule:${id} opens inside rule:${open.id}`);
	if (!ID_RE.test(id))
		throw new Error(
			`${at}: "${id}" is not a rule id — ids are lowercase kebab-case`,
		);
	return { id, from: m.index + m[0].length };
}

/**
 * @param {{ id: string } | null} open
 * @param {string} id
 * @param {string} body
 * @param {string} at
 * @returns {{ id: string, text: string }}
 */
function closeSpan(open, id, body, at) {
	if (open?.id !== id)
		throw new Error(
			`${at}: span rule:${id} closes ${open ? `rule:${open.id}` : "nothing"}`,
		);
	const text = body.trim();
	if (!text) throw new Error(`${at}: span rule:${id} is empty`);
	return { id, text: `${text}\n` };
}

/**
 * @param {string} root
 * @param {import("./lib/write-fd.js").Write} write
 * @returns {{ id: string, text: string, source: string }[]}
 */
function collect(root, write) {
	/** @type {Map<string, { id: string, text: string, source: string }>} */
	const seen = new Map();
	for (const src of SOURCES) {
		if (!fs.existsSync(path.join(root, src))) {
			write(
				1,
				`generate-rule-fragments: SKIP ${src} (absent — anchors nothing)\n`,
			);
			continue;
		}
		for (const r of readRegionsIn(root, src)) {
			const prior = seen.get(r.id);
			if (prior)
				throw new Error(
					`rule:${r.id} is anchored in both ${prior.source} and ${r.source} — keep one region and delete the other`,
				);
			if (!TRIGGERS[r.id])
				throw new Error(
					`rule:${r.id} is anchored in ${r.source} but names no trigger — add a TRIGGERS row in ${path.relative(root, __filename)}`,
				);
			seen.set(r.id, r);
		}
	}
	return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** @param {{ id: string, text: string, source: string }[]} regions */
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
 * @param {string} root
 * @param {{ id: string, text: string, source: string }[]} regions
 * @param {boolean} check
 * @returns {string[]}
 */
function reconcile(root, regions, check) {
	const store = storeOf(root);
	const manifest = manifestOf(root);
	const want = new Map(
		regions.map((r) => [path.join(store, `${r.id}.txt`), r.text]),
	);
	want.set(manifest, manifestFor(regions));

	const stale = [];
	for (const [file, text] of want) {
		const on = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
		const same =
			file === manifest
				? on === text
				: on !== null && trimEndRun(on, "\n") === trimEndRun(text, "\n");
		if (same) continue;
		stale.push(path.relative(root, file));
		if (check) continue;
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(file, text);
	}
	return stale;
}

const USAGE = `usage: node ${scriptPath("generate-rule-fragments.js")} [--check]`;

/** @param {string[]} argv */
function main(argv) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--check": "boolean" },
	});
	return render(worktreeRoot(), flags["--check"] === true, writeFd);
}

/**
 * @param {string} root
 * @param {boolean} check
 * @param {import("./lib/write-fd.js").Write} write
 * @returns {number}
 */
function render(root, check, write) {
	/** @type {{ id: string, text: string, source: string }[]} */
	let regions;
	try {
		regions = collect(root, write);
	} catch (e) {
		write(2, `generate-rule-fragments: ${caught(e).message}\n`);
		return 1;
	}

	const stale = reconcile(root, regions, check);
	if (check && stale.length > 0) {
		write(
			2,
			`generate-rule-fragments: ${stale.length} generated file(s) out of step with their anchored source:\n` +
				stale.map((f) => `  ${f}\n`).join("") +
				`Run \`npm run gen:rule-fragments\` (outside this repo: \`node ${__filename}\`) and commit the result.\n`,
		);
		return 1;
	}
	if (!check && stale.length > 0)
		write(1, `generate-rule-fragments: wrote ${stale.join(", ")}\n`);
	return 0;
}

/** @type {import("./lib/precommit-gates.js").Program} */
const PROGRAM = ({ cwd }) => capture((write) => render(cwd, true, write));

module.exports = { PROGRAM, SOURCES };

if (require.main === module) process.exit(main(process.argv.slice(2)));
