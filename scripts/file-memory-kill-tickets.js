#!/usr/bin/env node
/*
 * file-memory-kill-tickets.js — file one `takes:triage` ticket for each
 * earlyoom kill incident that is over (workflow-core#3094, ruled at workflow-core#3082): kills no more
 * than 30 min apart, read from earlyoom's journal (lib/earlyoom-kills.js).
 * A kill means admission let memory run out, so each incident has a cause
 * for a session to find.
 *
 *   node scripts/file-memory-kill-tickets.js [--dry-run]
 *
 * ONCE PER INCIDENT, never a second: the incident's title carries its first
 * kill's minute, and an issue with that title, open or closed, files nothing.
 * The titles filed are kept in the main checkout's markers, found through
 * git's common dir, so a tick that has filed one reads nothing from the
 * tracker for it again and GitHub's search lag cannot let a second through;
 * a pid lock beside them keeps a hand run in any worktree and a loop tick
 * from both filing.
 *
 * Reads back LOOKBACK_MS, so a refill loop down for under that files its
 * missed incidents when it returns. An incident not yet over waits for a
 * later tick: a kill may still join it.
 *
 * Files through lib/file-through.js, so file-issue.js's label refusals bind
 * it as they bind a session.
 *
 * Joins no §N3 family: it files issues as `report-*` does, but a failed
 * filing exits 1 so the refill loop logs it, as file-morning-review.js does.
 *
 * Prints nothing where there is nothing to file. Exit codes: 0 on a pass, an
 * unreadable journal included (said on stderr: earlyoom's log is subject, not
 * apparatus); 1 where a filing or the tracker read failed; 2 on a command line
 * it refuses.
 *
 * Caller: the refill loop, every tick (scripts/refill-loop.js).
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const kills = require("./lib/earlyoom-kills.js");
const { parseErrLine } = require("./lib/gh.js");
const { gitCommonDir } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const { fileThrough } = require("./lib/file-through.js");
const { markersDir } = require("./lib/marker-root.js");
const { pidLock } = require("./lib/pid-lock.js");
const { takesLabel } = require("./lib/takes-label.js");
const { requireKey } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = "usage: node scripts/file-memory-kill-tickets.js [--dry-run]";
const LABEL = takesLabel("triage");
/* Untraced: covers a refill loop down over a weekend. */
const LOOKBACK_MS = 72 * 60 * 60 * 1000;
const STANDALONE =
	"a memory kill incident has no originating ticket, so one is filed per incident (workflow-core#3094)";

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
 * @param {import("./lib/earlyoom-kills.js").Incident} i
 * @param {string} root
 * @returns {number|null}
 */
function fileIncident(i, root) {
	const title = kills.incidentTitle(i);
	const ran = fileThrough(
		[
			"--title",
			title,
			"--label",
			LABEL,
			"--standalone",
			STANDALONE,
			"--body-file",
			"-",
		],
		kills.buildIncidentBody(i),
		root,
	);
	const m = (ran.stdout ?? "").match(/^Filed #(\d+)/m);
	if (!m) {
		writeFd(
			2,
			`${title}: not filed: ${(ran.stderr || ran.error?.message || "").trim()}\n`,
		);
		return null;
	}
	process.stdout.write(`${title}: filed #${m[1]}.\n`);
	return Number(m[1]);
}

/**
 * Ticket each incident in `due` that no ticket of its title covers, recording
 * each covered title in the marker. The exit code.
 * @param {() => import("./lib/earlyoom-kills.js").Incident[]} due
 * @param {string} markerFile
 * @param {string} root
 */
function fileDue(due, markerFile, root) {
	const repo = requireKey("tracker", { root });
	let filed;
	try {
		filed = kills.readIncidentTickets(repo);
	} catch (e) {
		writeFd(
			2,
			`could not list ${repo}'s memory kill tickets (${parseErrLine(e)}). Nothing filed.\n`,
		);
		return 1;
	}
	let code = 0;
	for (const i of due()) {
		const title = kills.incidentTitle(i);
		const n = filed.get(title) ?? fileIncident(i, root);
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
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const root = hostRoot();
	const now = Date.now();
	const { incidents, why } = kills.readIncidents(now - LOOKBACK_MS);
	if (why !== null) {
		writeFd(2, `earlyoom's journal unread, nothing filed: ${why}\n`);
		return 0;
	}
	const markers = sharedMarkersDir(root);
	const markerFile = path.join(markers, "memory-kill-tickets.json");
	/* Re-read under the lock, so a run that waited on another files nothing
	 * that one filed. */
	const due = () => {
		const marker = readMarker(markerFile);
		return incidents.filter(
			(i) => kills.isOver(i, now) && !(kills.incidentTitle(i) in marker),
		);
	};
	if (due().length === 0) return 0;
	if (flags["--dry-run"] === true) {
		for (const i of due())
			process.stdout.write(
				`${kills.incidentTitle(i)}\n\n${kills.buildIncidentBody(i)}\n`,
			);
		return 0;
	}
	const lock = pidLock(
		path.join(markers, "memory-kill-tickets.lock"),
		path.basename(__filename),
	);
	if (!lock.acquire()) return 0;
	try {
		return fileDue(due, markerFile, root);
	} finally {
		lock.release();
	}
}

if (require.main === module) process.exitCode = main();
