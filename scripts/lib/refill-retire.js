/*
 * refill-retire.js — the refill loop's retry of a copy's original whose job
 * would not retire when the copy started (#4646). lib/refill-resume.js's
 * settleCopy stops the original's job and removes its row so one row of the
 * work is left to revive (#4098); one refused, as by a busy daemon, rides on
 * the launch the copy runs as, and each tick tries it again until it goes or
 * the tries run out, when the issue is told two rows are live.
 */

const { shortJobId } = require("./job-paths.js");
const { launchName } = require("./refill-block-core.js");

/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {import("./refill-blocks.js").Unretired} Unretired */
/** @typedef {import("./refill-blocks.js").BlockIo} BlockIo */

/* The retirements of a copy's original tried, settleCopy's first among them,
 * before the loop gives up and comments; untraced. */
const RETIRE_TRIES = 3;

/**
 * Each launch's unretired originals tried again: one retired leaves the
 * list, one refused counts a try, and one out of tries leaves it with a
 * comment on the launch's issues naming both job ids.
 * @param {LoopLaunch[]} launches
 * @param {Pick<BlockIo, "retireJob"|"comment"|"log">} io
 * @returns {LoopLaunch[]}
 */
function retireOriginals(launches, io) {
	return launches.map((l) => {
		if (!l.unretired) return l;
		const left = l.unretired.flatMap((u) => retireOriginal(l, u, io));
		const { unretired: _, ...rest } = l;
		return left.length > 0 ? { ...rest, unretired: left } : rest;
	});
}

/**
 * Original `u` of launch `l`'s copy tried again: nothing once retired, else
 * `u` with the try counted, or nothing once out of tries, its issue told.
 * @param {LoopLaunch} l
 * @param {Unretired} u
 * @param {Pick<BlockIo, "retireJob"|"comment"|"log">} io
 * @returns {Unretired[]}
 */
function retireOriginal(l, u, io) {
	const original = shortJobId(u.sessionId);
	const what = `original ${original} of ${launchName(l)}'s copy ${u.copyJobId}`;
	const failed = io.retireJob(u.seat, u.sessionId, u.cwd);
	if (!failed) {
		io.log(`retired ${what}`);
		return [];
	}
	const tries = u.tries + 1;
	io.log(`${what} not retired, try ${tries} of ${RETIRE_TRIES}: ${failed}`);
	if (tries < RETIRE_TRIES) return [{ ...u, tries }];
	io.comment(
		l,
		`Refill loop: two rows of this session are live in \`claude agents\` on ${u.seat}: original job ${original} and its copy ${u.copyJobId}. The original would not retire after ${RETIRE_TRIES} tries (${failed}); stop and remove it by hand (\`claude stop ${original}\`, then \`claude rm ${original}\`) so only the copy is revived.`,
	);
	return [];
}

module.exports = { RETIRE_TRIES, retireOriginals };
