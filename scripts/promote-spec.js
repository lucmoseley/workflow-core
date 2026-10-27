#!/usr/bin/env node
/*
 * promote-spec.js — move a brief's spec up to hang directly under its map, and
 * close the brief, in one call (#608; spec #606, ruled at #578).
 *
 *   node scripts/promote-spec.js <brief>
 *
 * The spec and the map are derived, never passed: the spec is the brief's one
 * open `kind:spec` sub-issue, the map is the brief's parent, which must carry
 * `wayfinder:map`.
 *
 * NO HOOK SEES A gh CALL A SCRIPT MAKES, so this holds for itself what
 * guard-issue-close.js holds on the hand spelling — `**Outstanding:**`, and a
 * roadmap card's own issue going to /card-close — and does what
 * release-issue-claim.js does after it.
 *
 * ORDER: every refusal, then re-parent, read-back, comment, close, release.
 * Nothing is written on the spec, and the brief is never closed before the
 * read-back shows the spec under the map.
 *
 * THE READ-BACK IS FROM THE MAP'S SIDE, in a separate call after a pause: the
 * spec's own `parent_issue_url` lags a move by minutes, and a list read in the
 * same breath as the POST comes back empty (link-sub-issue.sh's header).
 * WFC_PROMOTE_SLEEP (seconds) is the pause and the test seam; its default is
 * link-sub-issue.sh's, an unmeasured guess there too.
 *
 * RE-RUN FINISHES ONLY WHAT IS MISSING. Once the move lands the spec is no
 * longer the brief's child, so a brief with no open spec child is looked up in
 * its timeline: a `sub_issue_removed` spec the map now lists — open, where the
 * brief is still open — is the one this command moved, and the re-parent is
 * skipped. A closed brief skips the comment
 * and the close; an open one whose latest comment by this account is the close
 * comment skips the comment.
 *
 * A 422 is read as the 100-child cap only on GitHub's own prose for it, as
 * file-issue.js reads it; any other 422 still names the archive remedy, as a
 * possibility.
 *
 * Exits, as the other tracker scripts: 0 done or already done, 1 a write did
 * not land or could not be verified, 2 a usage error or a refusal.
 *
 * cli-args-exempt: it refuses any argv but one issue number, `--help`
 * included, before any gh call.
 */

const { parseErrLine, gh, ghApiSlurp } = require("./lib/gh.js");
const { scriptPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const {
	alreadyCommented,
	isCardOwnIssue,
	labelNames,
	readIssue,
	readParent,
	releaseOwnClaim,
	scriptIo,
} = require("./lib/tracker-ops.js");

const USAGE = "usage: node scripts/promote-spec.js <brief>";

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("promote-spec");

const PAUSE_S = 2;

/** @typedef {{number: number, id: number, state: string, labels?: Array<string|{name: string}>}} SubIssue */

/** @param {SubIssue} raw */
const isSpec = (raw) => labelNames(raw).includes("kind:spec");

/**
 * @param {string} repo
 * @param {number} n
 * @returns {SubIssue[]}
 */
const readSubIssues = (repo, n) =>
	ghApiSlurp([`repos/${repo}/issues/${n}/sub_issues`]);

/**
 * @param {string} repo
 * @param {number} brief
 */
const readRemovedSubIssues = (repo, brief) =>
	ghApiSlurp([`repos/${repo}/issues/${brief}/timeline`])
		.filter((e) => e.event === "sub_issue_removed" && e.sub_issue?.number)
		.map((e) => /** @type {number} */ (e.sub_issue.number));

const pause = () => {
	const s = Number(process.env.WFC_PROMOTE_SLEEP ?? PAUSE_S);
	if (s > 0) sleepSync(s * 1000);
};

/** @typedef {import("./lib/tracker-ops.js").Issue} Issue */

function parseIssueArg() {
	const [arg, ...extra] = process.argv.slice(2);
	if (arg === undefined || extra.length > 0 || !/^#?\d+$/.test(arg))
		io.fail(`one issue number, the brief's, and nothing else. ${USAGE}`, 2);
	return Number(arg.replace(/^#/, ""));
}

/**
 * @param {string} repo
 * @param {number} n
 * @returns {Issue}
 */
function readBriefOrFail(repo, n) {
	let brief;
	try {
		brief = readIssue(repo, n);
	} catch (e) {
		io.fail(
			`could not read #${n} from ${repo} (${parseErrLine(e)}). Nothing written.`,
			1,
		);
	}
	if (!brief.labels.includes("kind:brief"))
		io.fail(
			`#${n} is not labelled kind:brief, so it has no spec to promote — run this on the kind:brief the spec was filed under. Nothing written.`,
			2,
		);
	if (isCardOwnIssue(brief))
		io.fail(
			`#${n} is roadmap card ${brief.title.split(" — ")[0]}'s own issue: close it with /card-close ${n}. Nothing written.`,
			2,
		);
	return brief;
}

/**
 * @param {Issue} brief
 * @param {number} n
 * @returns {Issue}
 */
function readMapOrFail(brief, n) {
	let map;
	try {
		map = readParent(brief);
	} catch (e) {
		io.fail(
			`could not read #${n}'s parent (${brief.parentPath}) (${parseErrLine(e)}). Nothing written.`,
			1,
		);
	}
	if (!map)
		io.fail(
			`#${n} has no parent, so there is no map to move its spec under — link it under its map (${scriptPath("link-sub-issue.sh")} <map> ${n}), then re-run. Nothing written.`,
			2,
		);
	if (!map.labels.includes("wayfinder:map"))
		io.fail(
			`#${n}'s parent #${map.number} is not a wayfinder:map, so its spec has nowhere to go — a brief hangs directly under its map: move it there (the sub-issues POST with -F replace_parent=true), then re-run. Nothing written.`,
			2,
		);
	return map;
}

/**
 * The brief's open specs and the map's children, refusing more than one spec.
 * @param {string} repo
 * @param {number} n
 * @param {Issue} map
 */
function listSpecsOrFail(repo, n, map) {
	let specs;
	let mapKids;
	try {
		specs = readSubIssues(repo, n).filter(
			(k) => k.state === "open" && isSpec(k),
		);
		mapKids = readSubIssues(repo, map.number);
	} catch (e) {
		io.fail(
			`could not list the sub-issues of #${n} or #${map.number} (${parseErrLine(e)}). Nothing written.`,
			1,
		);
	}
	if (specs.length > 1)
		io.fail(
			`#${n} has ${specs.length} open kind:spec children (${specs.map((s) => `#${s.number}`).join(", ")}) — a brief holds one spec: close or re-parent the extra ones by hand, then re-run. Nothing written.`,
			2,
		);
	return { specs, mapKids };
}

/**
 * @param {{repo: string, n: number, brief: Issue, map: Issue}} at
 * @param {SubIssue[]} mapKids
 * @returns {number}
 */
function readPriorSpecOrFail(at, mapKids) {
	const { repo, n, brief, map } = at;
	let removed;
	try {
		removed = readRemovedSubIssues(repo, n);
	} catch (e) {
		io.fail(
			`could not read #${n}'s timeline (${parseErrLine(e)}). Nothing written.`,
			1,
		);
	}
	const onMap = new Map(mapKids.map((k) => [k.number, k]));
	const prior = [...new Set(removed)].filter((r) => {
		const k = onMap.get(r);
		return k && isSpec(k) && (brief.state === "closed" || k.state === "open");
	});
	if (prior.length !== 1)
		io.fail(
			prior.length > 0
				? `#${n} has no open kind:spec child, and more than one spec it once held now sits under #${map.number} (${prior.map((p) => `#${p}`).join(", ")}) — close the brief by hand, naming the right one. Nothing written.`
				: `#${n} has no open kind:spec child — publish its spec under it first. Nothing written.`,
			2,
		);
	const spec = /** @type {number} */ (prior[0]);
	io.out(`#${spec} is already under #${map.number} — re-parent skipped.\n`);
	return spec;
}

/**
 * @param {string} line
 * @param {number} spec
 * @param {number} mapNumber
 * @param {number} n
 * @returns {string}
 */
function moveRefusal(line, spec, mapNumber, n) {
	if (/100 sub-issues/.test(line))
		return `moving #${spec} under #${mapNumber} was refused (${line}) — #${mapNumber} is at GitHub's 100-child cap: node ${scriptPath("archive-closed-children.js")} ${mapNumber}, then re-run. #${n} left open.`;
	if (/422/.test(line))
		return `moving #${spec} under #${mapNumber} was refused (${line}). If #${mapNumber} is at GitHub's 100-child cap, node ${scriptPath("archive-closed-children.js")} ${mapNumber}, then re-run. #${n} left open.`;
	return `moving #${spec} under #${mapNumber} failed (${line}). #${n} left open — re-run.`;
}

/**
 * Moves the held spec under the map and reads the move back.
 * @param {string} repo
 * @param {number} n
 * @param {Issue} map
 * @param {SubIssue} held
 */
function moveSpecOrFail(repo, n, map, held) {
	const spec = held.number;
	try {
		gh([
			"api",
			"--method",
			"POST",
			`repos/${repo}/issues/${map.number}/sub_issues`,
			"-F",
			`sub_issue_id=${held.id}`,
			"-F",
			"replace_parent=true",
		]);
	} catch (e) {
		io.fail(moveRefusal(parseErrLine(e), spec, map.number, n), 1);
	}
	pause();
	let listed;
	try {
		listed = readSubIssues(repo, map.number).some((k) => k.number === spec);
	} catch (e) {
		io.fail(
			`moved #${spec}, but #${map.number}'s sub-issues could not be read back (${parseErrLine(e)}). #${n} left open — re-run.`,
			1,
		);
	}
	if (!listed)
		io.fail(
			`gh moved #${spec} without error, but #${map.number} does not list it. #${n} left open — re-run.`,
			1,
		);
	io.out(`#${spec}: moved under #${map.number}.\n`);
}

/**
 * Posts the hand-off comment on the brief, unless it is already its latest.
 * @param {string} repo
 * @param {number} n
 * @param {number} spec
 * @param {Issue} map
 */
function commentOnce(repo, n, spec, map) {
	const comment = `Specced at #${spec}, moved under #${map.number}.\n\n**Outstanding:** #${spec} (the spec carries this brief's work)\n`;
	let posted;
	try {
		posted = alreadyCommented(repo, n, comment);
	} catch (e) {
		io.fail(
			`#${spec} is under #${map.number}, but #${n}'s comments could not be read to rule out a second post (${parseErrLine(e)}). Re-run to finish.`,
			1,
		);
	}
	if (posted) {
		io.out(
			`#${n}: your latest comment is this one already — not posted again.\n`,
		);
		return;
	}
	try {
		gh(["issue", "comment", String(n), "--repo", repo, "--body-file", "-"], {
			input: comment,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (e) {
		io.fail(
			`#${spec} is under #${map.number}, but the comment on #${n} failed (${parseErrLine(e)}). Re-run to finish.`,
			1,
		);
	}
	io.out(`#${n}: comment posted.\n`);
}

/**
 * Closes the brief and reads the close back.
 * @param {string} repo
 * @param {number} n
 */
function closeBriefOrFail(repo, n) {
	let state;
	try {
		gh(["issue", "close", String(n), "--repo", repo, "--reason", "completed"]);
		state = readIssue(repo, n).state;
	} catch (e) {
		io.fail(
			`the comment is on #${n}, but closing it failed or could not be read back (${parseErrLine(e)}). Re-run to finish.`,
			1,
		);
	}
	if (state !== "closed")
		io.fail(
			`gh closed #${n} without error, but it reads back as ${state}. Re-run to finish.`,
			1,
		);
	io.out(`#${n}: closed.\n`);
}

function main() {
	const n = parseIssueArg();

	const repo = io.trackerOrFail();

	const brief = readBriefOrFail(repo, n);
	const map = readMapOrFail(brief, n);
	const { specs, mapKids } = listSpecsOrFail(repo, n, map);

	/* At most one, past `listSpecsOrFail`'s refusal: the spec still under the brief,
	 * which this run moves. */
	const [held] = specs;
	const spec =
		held === undefined
			? readPriorSpecOrFail({ repo, n, brief, map }, mapKids)
			: held.number;

	if (held !== undefined) moveSpecOrFail(repo, n, map, held);

	if (brief.state === "closed") {
		io.out(`#${n} is already closed — comment and close skipped.\n`);
	} else {
		commentOnce(repo, n, spec, map);
		closeBriefOrFail(repo, n);
	}

	process.exitCode = releaseOwnClaim(io, n);
}

main();
