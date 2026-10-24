#!/usr/bin/env node
/*
 * check-landing-stall.js — name a stalled, held or lander-less landing queue
 * at session start (workflow-core#2406, spec workflow-core#2261). lib/landing-stall.js judges the
 * reading.
 *
 * Usage:  node scripts/check-landing-stall.js [--notify] [--json]
 *
 * A LANDER STARTING BESIDE IT. The session start that runs this also starts
 * the lander, so a reading of no lander is taken again after START_GRACE_MS
 * before it is named. WFC_LANDER_START_GRACE_MS replaces the grace, for
 * tests.
 *
 * Where the `landing` module is off it prints nothing under --notify.
 *
 * IMPLICIT:  at every session start where the `landing` module is on, reads the remote's two branches, fetching their commits where missing, and warns where `landing` holds a commit over 90 min old that is not on `main`, or where `landing` is ahead and no lander is running.
 * JUSTIFIED: fail-safe — the lander runs outside any session, so nothing else reports it stalling or dying.
 * DEFEAT:    none needed — it never blocks.
 */

const { execFileSync } = require("node:child_process");
const { pidAlive } = require("./lib/arbiter-proc.js");
const { runCheck } = require("./lib/check");
const {
	GIT_TIMEOUT_MS,
	landerFiles,
	readHeartbeat,
	remoteGit,
} = require("./lib/lander.js");
const { stallFindings } = require("./lib/landing-stall.js");
const { scriptPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { repoRoot } = require("./lib/test-pass-marker.js");

/* Untraced: a lander's first beat follows its node start and lock, well
 * under a second. */
const START_GRACE_MS = 15 * 1000;

/**
 * The oldest commit on `landing` not on `main`, by committer time.
 * @param {string} root
 * @param {string|null} main
 * @param {string} landing
 * @returns {{sha: string, at: number}|null}
 */
function oldestQueued(root, main, landing) {
	const out = execFileSync(
		"git",
		[
			"log",
			"--format=%H %ct",
			...(main === null ? [landing] : [`${main}..${landing}`]),
		],
		{ cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS },
	);
	/** @type {{sha: string, at: number}|null} */
	let oldest = null;
	for (const line of out.split("\n").filter(Boolean)) {
		const [sha, seconds] = line.split(" ");
		const at = Number(seconds) * 1000;
		if (!sha || !Number.isFinite(at))
			throw new Error(`git log printed an unreadable line: ${line}`);
		if (oldest === null || at < oldest.at) oldest = { sha, at };
	}
	return oldest;
}

runCheck({
	name: "landing-stall",
	usage: "node check-landing-stall.js [--notify] [--json]",
	module: "landing",
	run(ctx) {
		const root = repoRoot() ?? ctx.skip("not in a git checkout.");
		const { main, landing, relation } = remoteGit(root).refs();
		const oldest =
			landing === null || relation === "equal" || relation === "behind"
				? null
				: oldestQueued(root, main, landing);
		const { heartbeat: file } = landerFiles(root);
		const read = () =>
			stallFindings({
				now: Date.now(),
				landing,
				relation,
				oldest,
				heartbeat: readHeartbeat(file),
				alive: pidAlive,
			});
		let found = read();
		if (found.some((f) => f.tag === "LANDER-DEAD")) {
			sleepSync(
				Number(process.env.WFC_LANDER_START_GRACE_MS ?? START_GRACE_MS),
			);
			found = read();
		}
		for (const f of found) {
			ctx.warn(f.tag, f.line);
			ctx.say(`${f.tag} — ${f.line}\n`);
		}
		if (found.length > 0)
			ctx.say(
				`  Run the lander by hand to see where it stops: node ${scriptPath("lander.js")} run\n`,
			);
		return {
			okLine: "the landing queue is moving.",
			noun: "landing queue finding(s)",
			count: found.length,
			data: { main, landing, relation, oldest },
		};
	},
});
