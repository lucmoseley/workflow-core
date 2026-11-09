/*
 * incident-tickets.js — one `takes:triage` ticket per machine incident, never
 * a second (#3094, #3807): the filing the memory kill and process runaway
 * filers share, and the helpers their titles and bodies share.
 *
 * ONCE PER INCIDENT: the incident's title carries its first minute, and an
 * issue with that title, open or closed, files nothing. The titles filed are
 * kept in the main checkout's markers, found through git's common dir, so a
 * tick that has filed one reads nothing from the tracker for it again and
 * GitHub's search lag cannot let a second through; a pid lock beside them keeps
 * a hand run in any worktree and a loop tick from both filing.
 *
 * Files through file-through.js, so file-issue.js's label refusals bind it as
 * they bind a session.
 */

const fs = require("node:fs");
const path = require("node:path");
const { fileThrough } = require("./file-through.js");
const { findFiledLine } = require("./filed-line.js");
const { ghIssueListAll, parseErrLine } = require("./gh.js");
const { gitCommonDir } = require("./git.js");
const { markersDir } = require("./marker-root.js");
const { pidLock } = require("./pid-lock.js");
const { takesLabel } = require("./takes-label.js");
const { requireKey } = require("./workflow-core-config.js");
const { writeFd } = require("./write-fd.js");

const LABEL = takesLabel("triage");

/* Untraced: covers a refill loop down over a weekend. */
const LOOKBACK_MS = 72 * 60 * 60 * 1000;

/** @param {string} file @returns {Record<string, number>} */
function readMarker(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		/* Absent or torn reads as nothing recorded: the title lookup on the
		 * tracker is the duplicate check, the marker only spares it. */
		return {};
	}
}

/**
 * The markers directory of the checkout whose `.git` every worktree shares,
 * else this one's.
 * @param {string} root
 */
function sharedMarkersDir(root) {
	const common = gitCommonDir(root) ?? "";
	return markersDir(
		path.basename(common) === ".git" ? path.dirname(common) : root,
	);
}

/**
 * File one incident's ticket, returning its number, or null where
 * file-issue.js did not file it (said on stderr).
 * @param {string} title
 * @param {string} body
 * @param {string} standalone
 * @param {string} root
 * @returns {number|null}
 */
function fileOne(title, body, standalone, root) {
	const ran = fileThrough(
		[
			"--title",
			title,
			"--label",
			LABEL,
			"--standalone",
			standalone,
			"--origin",
			"incident",
			"--no-fault",
			"--body-file",
			"-",
		],
		body,
		root,
	);
	const n = findFiledLine(ran.stdout ?? "")?.n;
	if (n === undefined) {
		writeFd(
			2,
			`${title}: not filed: ${(ran.stderr || ran.error?.message || "").trim()}\n`,
		);
		return null;
	}
	writeFd(1, `${title}: filed #${n}.\n`);
	return n;
}

/**
 * Ticket each incident no marker or ticket of its title covers. The exit code:
 * 0 on a pass, 1 where a filing or the tracker read failed.
 * @template T
 * @param {object} o
 * @param {string} o.root
 * @param {string} o.script the calling script's basename, naming the lock's holder
 * @param {string} o.marker the marker and lock files' stem
 * @param {string} o.what what the tickets are called in a failure
 * @param {string} o.standalone why an incident has no originating ticket
 * @param {T[]} o.incidents the incidents ready to file
 * @param {(i: T) => string} o.titleOf
 * @param {(i: T) => string} o.bodyOf
 * @param {(repo: string) => Map<string, number>} o.readTickets
 * @param {boolean} o.dryRun print what is due instead of filing it
 */
function fileIncidents({
	root,
	script,
	marker,
	what,
	standalone,
	incidents,
	titleOf,
	bodyOf,
	readTickets,
	dryRun,
}) {
	const markers = sharedMarkersDir(root);
	const markerFile = path.join(markers, `${marker}.json`);
	/* Re-read under the lock, so a run that waited on another files nothing
	 * that one filed. */
	const due = () => {
		const recorded = readMarker(markerFile);
		return incidents.filter((i) => !(titleOf(i) in recorded));
	};
	if (due().length === 0) return 0;
	if (dryRun) {
		for (const i of due()) writeFd(1, `${titleOf(i)}\n\n${bodyOf(i)}\n`);
		return 0;
	}
	const lock = pidLock(path.join(markers, `${marker}.lock`), script);
	if (!lock.acquire()) return 0;
	try {
		const repo = requireKey("tracker", { root });
		let filed;
		try {
			filed = readTickets(repo);
		} catch (e) {
			writeFd(
				2,
				`could not list ${repo}'s ${what} (${parseErrLine(e)}). Nothing filed.\n`,
			);
			return 1;
		}
		let code = 0;
		for (const i of due()) {
			const title = titleOf(i);
			const n = filed.get(title) ?? fileOne(title, bodyOf(i), standalone, root);
			if (n === null) {
				code = 1;
				continue;
			}
			fs.writeFileSync(
				markerFile,
				`${JSON.stringify({ ...readMarker(markerFile), [title]: n })}\n`,
			);
		}
		return code;
	} finally {
		lock.release();
	}
}

/**
 * The tickets on `repo` whose titles start with `prefix`, open or closed, by
 * title; throws where the tracker cannot be read.
 * @param {string} repo
 * @param {string} what names the read in a failure
 * @param {string} prefix
 * @returns {Map<string, number>}
 */
function readTicketsByPrefix(repo, what, prefix) {
	/** @type {{number: number, title: string}[]} */
	const found = ghIssueListAll(what, [
		"--repo",
		repo,
		"--state",
		"all",
		"--search",
		`in:title "${prefix.trim()}"`,
		"--json",
		"number,title",
	]);
	return new Map(
		found
			.filter((i) => i.title.startsWith(prefix))
			.map((i) => [i.title, i.number]),
	);
}

/** @param {Date} d UTC `YYYY-MM-DD HH:MM` */
const utcMinute = (d) => d.toISOString().slice(0, 16).replace("T", " ");

/** @param {Date} d machine-local `YYYY-MM-DD HH:MM` */
const localMinute = (d) =>
	`${[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-")} ${[d.getHours(), d.getMinutes()]
		.map((v) => String(v).padStart(2, "0"))
		.join(":")}`;

/**
 * Text a process set for itself, as a code span: a backtick, a pipe or a
 * control character is replaced.
 * @param {string} name
 */
const buildProcessSpan = (name) =>
	`\`${name.replace(/[`|\p{Cc}]/gu, "?") || "(empty)"}\``;

module.exports = {
	LOOKBACK_MS,
	buildProcessSpan,
	fileIncidents,
	localMinute,
	readTicketsByPrefix,
	utcMinute,
};
