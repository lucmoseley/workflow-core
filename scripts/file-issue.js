#!/usr/bin/env node
/*
 * file-issue.js — file an issue in one call: validate, create with every
 * label, read the number back, link it under its parent and verify, so
 * create, label and link cannot half-happen unnoticed (#533; spec #528,
 * ruled at #481).
 *
 *   node scripts/file-issue.js --title T --label L [--label L…]
 *     (--parent P | --standalone "<why>") --body-file F|- [--assign-self]
 *     [--distinct-from N[,N…]]
 *   node scripts/file-issue.js --check "<title>"
 *
 * Before every create it lists up to three open issues whose titles most
 * resemble the new one, so a duplicate or its natural parent is noticed
 * (#536), and refuses while any listed issue is neither named in
 * `--distinct-from` nor the `--parent` (#1073). No score cut-off does the
 * refusing: unrelated titles and real duplicates overlap in score. A failed
 * fetch files anyway, saying so.
 * Residual: `--distinct-from` records a claim, never a reading — pasting the
 * refusal's own hint back files unread.
 * `--check` prints the same list and files nothing — "is it ticketed?"
 * answered from the tracker.
 *
 * NO HOOK SEES A gh CALL A SCRIPT MAKES, so this enforces for itself what
 * the guard-issue-create-label core and place-new-issue.sh enforce on the hand
 * spelling: exactly one `takes:` value, the `takes:human` Outside-line tests
 * (lib/takes-label.js), every label known to the tracker — a label GitHub
 * does not know aborts `gh issue create` while it exits 0 — and the family
 * label the parent implies, and no second `wayfinder:map` while an open one's
 * Destination is unfilled (lib/issue-gate.js, #717).
 *
 * ORDER: every other refusal, then the similar-title list's, then create,
 * then link, then (--assign-self, or a map under a session id) claim.
 * A failure after the create exits 1 naming the created issue and the
 * remedy, and deletes nothing: re-running files a duplicate.
 *
 * Unassigned unless --assign-self, which takes claim-issue's path (the
 * arbiter record, then @me) — an assigned issue drops off /wayfinder's
 * frontier (mantahostels#702). A `wayfinder:map` filed where a session id is
 * set takes that path without the flag: the charting session holds its map
 * from the moment it files it, so the parent-claim refusal keeps the loop off
 * the children it is still wiring (#2314, ruled at #2211). Those children
 * stay unassigned, held by the map's claim until it ends.
 *
 * Joins no §N3 family: its exits are the three the spec gives all three
 * tracker scripts — 0 done, 1 retry or finish by hand (a gh read or write
 * did not land), 2 fix the input (a usage error or a refusal).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { parseErrLine, gh, ghApiSlurp } = require("./lib/gh.js");
const { buildDistinctFromHint } = require("./lib/similar-titles.js");
const { hasStandaloneLine } = require("./lib/standalone-line.js");
const { readRuleText } = require("./lib/rule-text.js");
const { fromEnv } = require("./lib/session-id.js");
const { takesLabel, takesRefusal } = require("./lib/takes-label.js");

const HUMAN_LABEL = takesLabel("human");
const {
	basisFaults,
	basisRefusal,
	gateRuleHandover,
	listOpenMaps,
	MAP_LABEL,
	secondMapVerdict,
} = require("./lib/issue-gate.js");
const {
	assignSelf,
	claimIfFree,
	readIssue,
	recordOwnAct,
	scriptIo,
	similarTitles,
} = require("./lib/tracker-ops.js");
const { caught } = require("./lib/caught.js");
const { parseIssueNumber } = require("./lib/issue-number.js");

const USAGE =
	'usage: node scripts/file-issue.js --title T --label L [--label L…] (--parent P | --standalone "<why>") --body-file F|- [--assign-self] [--distinct-from N[,N…]]\n       node scripts/file-issue.js --check "<title>"';

/** @type {import("./lib/cli-args.js").CliSpec} */
const SPEC = {
	usage: USAGE,
	flags: {
		"--title": "value",
		"--label": "list",
		"--parent": "value",
		"--standalone": "value",
		"--body-file": "value",
		"--distinct-from": "list",
		"--assign-self": "boolean",
		"--check": "list",
	},
};

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("file-issue");

/** @param {import("./lib/cli-args.js").Parsed} parsed */
function readOpts({ flags, lists }) {
	/** @type {{title?: string, labels: string[], parent?: number, standalone?: string, bodyFile?: string, assignSelf: boolean, distinct: Set<number>}} */
	const opts = {
		title: flagValue(flags, "--title"),
		labels: lists["--label"] ?? [],
		standalone: flagValue(flags, "--standalone"),
		bodyFile: flagValue(flags, "--body-file"),
		assignSelf: flags["--assign-self"] === true,
		distinct: distinctFrom(lists["--distinct-from"] ?? []),
	};
	const parent = flagValue(flags, "--parent");
	if (parent !== undefined) {
		const n = parseIssueNumber(parent);
		if (n === null) io.fail(`--parent '${parent}' is not an issue number.`, 2);
		opts.parent = /** @type {number} */ (n);
	}
	if (!opts.title?.trim()) io.fail(`--title is required. ${USAGE}`, 2);
	if (opts.labels.length === 0)
		io.fail(`at least one --label is required. ${USAGE}`, 2);
	if (opts.bodyFile === undefined)
		io.fail(
			`--body-file is required — a file, or - for standard input; never a shell string. ${USAGE}`,
			2,
		);
	if ((opts.parent === undefined) === (opts.standalone === undefined))
		io.fail(
			'give exactly one of --parent <n> or --standalone "<why>": an issue with no parent sits outside every map, so /wayfinder\'s frontier never offers it.',
			2,
		);
	if (opts.standalone !== undefined && !opts.standalone.trim())
		io.fail(
			"--standalone needs its reason, written into the body unless it carries its own Standalone: line.",
			2,
		);
	return opts;
}

/**
 * --distinct-from's issue numbers, refused where any part of a list is not one.
 * @param {string[]} csvs
 * @returns {Set<number>}
 */
function distinctFrom(csvs) {
	/** @type {Set<number>} */
	const distinct = new Set();
	for (const csv of csvs)
		for (const part of csv.split(",")) {
			const n = parseIssueNumber(part);
			if (n === null)
				io.fail(
					`--distinct-from '${csv}' is not a comma-separated list of issue numbers.`,
					2,
				);
			distinct.add(n);
		}
	return distinct;
}

/** @param {string} file */
function readBody(file) {
	try {
		return fs.readFileSync(file === "-" ? 0 : file, "utf8");
	} catch (e) {
		const { code, message } = caught(e);
		return io.fail(
			`could not read the body from ${file} (${code ?? message}). Write it first, or pipe it in with --body-file -.`,
			2,
		);
	}
}

/**
 * The link, through link-sub-issue.sh, which verifies from the parent side.
 * `{ok}` carrying its stdout, or `{error}` carrying its stderr.
 * @param {string} repo
 * @param {number} parent
 * @param {number} child
 */
function link(repo, parent, child) {
	const r = spawnSync(
		"bash",
		[path.join(__dirname, "link-sub-issue.sh"), String(parent), String(child)],
		{ encoding: "utf8", env: { ...process.env, WFC_LINK_REPO: repo } },
	);
	if (r.status === 0) return { ok: r.stdout.trim() };
	return { error: (r.stderr || r.error?.message || "no output").trim() };
}

/**
 * @param {import("./lib/cli-args.js").Parsed} parsed
 * @param {string[]} titles  the `--check` values
 */
function checkTitle({ flags, lists }, titles) {
	const [title, ...more] = titles;
	if (
		title === undefined ||
		more.length > 0 ||
		Object.keys(flags).length > 0 ||
		Object.keys(lists).length !== 1 ||
		!title.trim()
	)
		io.fail(`--check takes one title and nothing else. ${USAGE}`, 2);
	const repo = io.trackerOrFail();
	try {
		io.out(similarTitles(repo, title).text);
	} catch (e) {
		io.fail(`could not list ${repo}'s issues (${parseErrLine(e)}).`, 1);
	}
}

function main() {
	const parsed = parseOrExit(process.argv.slice(2), SPEC);
	const titles = parsed.lists["--check"];
	if (titles) return checkTitle(parsed, titles);
	const opts = readOpts(parsed);
	const body = readBody(/** @type {string} */ (opts.bodyFile));
	if (!body.trim())
		io.fail(
			"the body is empty — nothing to act on. Write the body into the file, or pipe it in with --body-file -.",
			2,
		);
	checkBody(opts.labels, body);

	const repo = io.trackerOrFail();
	checkSecondMap(repo, opts.labels);

	const given = [...new Set(opts.labels)];
	const read =
		opts.parent === undefined
			? undefined
			: readParent({ repo, number: opts.parent, labels: given });
	const parent = read?.parent;
	const added = read?.added ?? [];
	const labels = [...given, ...added];
	checkKnownLabels(repo, labels);
	checkSimilar(repo, opts);

	// A body carrying its own line keeps it, never gaining a second (#1027).
	// Residual: the flag's reason is then dropped even where it differs.
	const hasOwnStandalone = hasStandaloneLine(body);
	const filedBody =
		opts.standalone === undefined || hasOwnStandalone
			? body
			: `${body.replace(/\s+$/, "")}\n\nStandalone: ${opts.standalone.trim()}\n`;
	const { n, url } = create({
		repo,
		title: /** @type {string} */ (opts.title),
		labels,
		filedBody,
	});
	recordOwnAct("file", repo, n);
	io.out(
		`Filed #${n}: ${url}\nlabels: ${labels.join(", ")}${added.length > 0 ? ` (${added.join(", ")} added: #${opts.parent} is a spec)` : ""}\n`,
	);

	const sessionId = fromEnv();
	// Residual (#2314): a map filed with no session id is held by nobody, so
	// its children are launchable.
	const willClaim =
		opts.assignSelf || (labels.includes(MAP_LABEL) && sessionId !== null);
	const claimLater = willClaim
		? ` It is not yet claimed: node scripts/claim-issue.js ${n} once it is placed.`
		: "";
	if (parent) linkFiled({ repo, parent, n, claimLater });
	else {
		io.out(
			hasOwnStandalone
				? "Standalone: the body's own Standalone line was kept; the flag's was not written.\n"
				: `Standalone: ${opts.standalone?.trim()} — written into the body.\n`,
		);
	}

	if (!willClaim) {
		io.out(`#${n} is unassigned.\n`);
		return;
	}
	claimFiled(repo, n, sessionId);
}

/**
 * The body's own refusals — the `takes:` tests and the basis check.
 * @param {string[]} labels
 * @param {string} body
 */
function checkBody(labels, body) {
	// The template, handed over before the takes:human checks can refuse (#983).
	if (labels.includes(HUMAN_LABEL))
		writeFd(2, `${readRuleText("founder-deliverable")}\n\n`);
	const takes = takesRefusal(labels, body);
	if (takes) io.fail(`${takes} Nothing filed.`, 2);

	// Advice, handed over before the basis check can refuse (#823).
	const handover = gateRuleHandover("", body, () =>
		readRuleText("roadmap-gating"),
	);
	if (handover) writeFd(2, handover);
	const unbased = basisFaults(body);
	if (unbased.length > 0)
		io.fail(
			`Nothing filed: the body carries ${basisRefusal(unbased, body)}`,
			2,
		);
}

/**
 * Refuses a second `wayfinder:map` while an open one's Destination is
 * unfilled.
 * @param {string} repo
 * @param {string[]} labels
 */
function checkSecondMap(repo, labels) {
	const map = secondMapVerdict(labels, () => listOpenMaps(repo));
	if (map && "refusal" in map) io.fail(`${map.refusal} Nothing filed.`, 2);
	// Fails open, recorded, as the /new-repo spec rules (#713).
	if (map && "unreadable" in map) {
		io.warn(`${map.unreadable} — filing without the second-map check.`);
		require("./lib/arbiter-core.js").logError(
			"file-issue second-map",
			map.unreadable,
		);
	}
}

/**
 * The --parent issue, refused where it cannot take a child, and the family
 * label it implies.
 * @param {{repo: string, number: number, labels: string[]}} at
 * @returns {{parent: ReturnType<typeof readIssue>, added: string[]}} the parent,
 *   and the labels it adds to `labels`
 */
function readParent({ repo, number, labels }) {
	let parent;
	try {
		parent = readIssue(repo, number);
	} catch (e) {
		io.fail(
			`could not read parent #${number} from ${repo} (${parseErrLine(e)}). Nothing filed.`,
			1,
		);
	}
	if (parent.isPullRequest)
		io.fail(`#${number} is a pull request, not an issue. Nothing filed.`, 2);
	if (parent.state !== "open")
		io.fail(
			`#${number} is ${parent.state} — a child filed under it drops off every map. Place it under an open issue, or --standalone. Nothing filed.`,
			2,
		);
	const added =
		parent.labels.includes("kind:spec") && !labels.includes("kind:ticket")
			? ["kind:ticket"]
			: [];
	// A spec or brief under a map takes no type — place-new-issue.sh's
	// exemption (#578, #714), hand-copied: nothing keeps the two in step.
	if (
		parent.labels.some((l) => l.startsWith("wayfinder:")) &&
		!labels.some((l) => l.startsWith("wayfinder:")) &&
		!labels.includes("kind:spec") &&
		!labels.includes("kind:brief")
	)
		io.fail(
			`#${number} is a wayfinder map or a map's child (${parent.labels.join(", ")}), so a child of it takes a wayfinder:<type> — research, prototype, grilling or task — or the map's frontier cannot read it; a kind:spec or kind:brief is exempt. Nothing filed.`,
			2,
		);
	return { parent, added };
}

/**
 * Refuses any label the tracker does not know.
 * @param {string} repo
 * @param {string[]} labels
 */
function checkKnownLabels(repo, labels) {
	let known;
	try {
		known = new Set(
			ghApiSlurp([`repos/${repo}/labels`]).map(
				(/** @type {{name: string}} */ l) => l.name,
			),
		);
	} catch (e) {
		io.fail(
			`could not read ${repo}'s label list (${parseErrLine(e)}). Nothing filed.`,
			1,
		);
	}
	const unknown = labels.filter((l) => !known.has(l));
	if (unknown.length > 0)
		io.fail(
			`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a label on ${repo} — gh would abort the create and still exit 0. Fix the spelling; a new label is a vocabulary change (docs/agents/triage-labels.md). Nothing filed.`,
			2,
		);
}

/**
 * The similar-title list, refused while any listed issue is neither named in
 * --distinct-from nor the --parent.
 * @param {string} repo
 * @param {ReturnType<typeof readOpts>} opts
 */
function checkSimilar(repo, opts) {
	let similar;
	try {
		similar = similarTitles(repo, /** @type {string} */ (opts.title));
	} catch (e) {
		// Fails open: a gh outage would otherwise stop every filing.
		io.out(
			`Could not list similar open issues (${parseErrLine(e)}) — filing without the check.\n`,
		);
	}
	if (!similar) return;
	const unchecked = similar.found.filter(
		(c) => !opts.distinct.has(c.number) && c.number !== opts.parent,
	);
	if (unchecked.length > 0)
		io.fail(
			`${similar.text}Nothing filed: ${unchecked.map((c) => `#${c.number}`).join(", ")} ${unchecked.length === 1 ? "is" : "are"} not yet checked. Read each listed issue. A duplicate is not filed — add to it instead; a natural parent is --parent. Where every one is different, re-run with ${buildDistinctFromHint(similar.found.map((c) => c.number))}`,
			2,
		);
	io.out(similar.text);
}

/**
 * The create, with every label, and the number read back off its URL.
 * @param {{repo: string, title: string, labels: string[], filedBody: string}} at
 * @returns {{n: number, url: string}}
 */
function create({ repo, title, labels, filedBody }) {
	const createArgs = [
		"issue",
		"create",
		"--repo",
		repo,
		"--title",
		title,
		"--body-file",
		"-",
	];
	for (const l of labels) createArgs.push("--label", l);
	let created;
	try {
		created = gh(createArgs, {
			input: filedBody,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (e) {
		io.fail(
			`gh issue create failed (${parseErrLine(e)}). Search ${repo}'s open issues for the title before re-running — a create can land and still report failure.`,
			1,
		);
	}
	const url = created.match(/https:\/\/\S+\/issues\/(\d+)/);
	if (!url)
		io.fail(
			`gh issue create printed no issue URL ("${created.trim()}"), so nothing can be linked or verified. Search ${repo}'s open issues for the title before re-running.`,
			1,
		);
	return { n: Number(url[1]), url: url[0] };
}

/**
 * The link under the parent, through link-sub-issue.sh; a failure exits 1
 * naming the remedy that fits GitHub's refusal.
 * @param {{repo: string, parent: ReturnType<typeof readIssue>, n: number,
 *   claimLater: string}} at
 */
function linkFiled({ repo, parent, n, claimLater }) {
	const linked = link(repo, parent.number, n);
	if (linked.error !== undefined)
		io.fail(
			`#${n} was filed but not linked under #${parent.number}: ${linked.error}\n${linkRemedy(linked.error, parent, n)} Do NOT file it again.${claimLater}`,
			1,
		);
	io.out(`${linked.ok}\n`);
}

/**
 * How to finish a link GitHub refused.
 * @param {string} error
 * @param {ReturnType<typeof readIssue>} parent
 * @param {number} n
 * @returns {string}
 */
function linkRemedy(error, parent, n) {
	const grand = parent.parentPath?.match(/(\d+)$/)?.[1];
	// Both caps are told apart by gh's 422 prose alone, as link-sub-issue.sh
	// tells the 7-layer one: a reword by GitHub demotes either to the
	// generic remedy, which still names the finishing link.
	if (/7 layers/.test(error))
		return `#${parent.number} is at GitHub's 7-layer cap: give #${n} #${parent.number}'s own parent${grand ? ` — scripts/link-sub-issue.sh ${grand} ${n}` : ""} — and say in its body why it is a peer.`;
	if (/100 sub-issues/.test(error))
		return `#${parent.number} is at GitHub's 100-child cap: node scripts/archive-closed-children.js ${parent.number}, then scripts/link-sub-issue.sh ${parent.number} ${n}.`;
	return `Finish it with scripts/link-sub-issue.sh ${parent.number} ${n} once the cause is fixed.`;
}

/**
 * --assign-self, or a map filed under a session id: the arbiter record where
 * a session id is set, then @me.
 * @param {string} repo
 * @param {number} n
 * @param {string|null} sessionId
 */
function claimFiled(repo, n, sessionId) {
	let recorded =
		"No session id (CLAUDE_CODE_SESSION_ID is unset), so no arbiter record was written — assigned only.";
	if (sessionId) {
		const claim = claimIfFree(n, sessionId);
		if (claim.status !== "claimed" && claim.status !== "reclaimed")
			io.fail(
				`#${n} is filed and placed, but the arbiter would not record the claim (${claim.status === "unreadable" ? claim.why : claim.status}). Claim it with node scripts/claim-issue.js ${n}.`,
				1,
			);
		recorded = `Recorded the arbiter claim for session ${sessionId}.`;
	}
	const assignError = assignSelf(repo, n);
	if (assignError)
		io.fail(
			`${recorded} But assigning #${n} failed (${assignError}) — re-run node scripts/claim-issue.js ${n} to assign.`,
			1,
		);
	io.out(`${recorded} Assigned #${n} to @me.\n`);
}

main();
