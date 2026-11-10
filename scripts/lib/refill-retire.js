/*
 * refill-retire.js — the refill loop's retry of a copy's original whose job
 * would not retire when the copy started (workflow-core#4646). lib/refill-resume.js's
 * settleCopy stops the original's job and removes its row so one row of the
 * work is left to revive (workflow-core#4098); one refused, as by a busy daemon, rides on
 * the launch the copy runs as, or the outside session's record (workflow-core#4829), and
 * each tick tries it again.
 */

const { shortJobId } = require("./job-paths.js");
const { launchName } = require("./refill-block-core.js");

/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {import("./refill-blocks.js").Unretired} Unretired */
/** @typedef {import("./refill-blocks.js").HasUnretired} HasUnretired */
/** @typedef {import("./refill-blocks.js").BlockIo} BlockIo */

/* The retirements of a copy's original tried, settleCopy's first among them,
 * before the loop gives up and comments; untraced. */
const RETIRE_TRIES = 3;

/**
 * What to do by hand about original `original` of copy `u` once out of tries.
 * @param {Unretired} u
 * @param {string} original  its short job id
 * @param {string} failed  the last refusal
 */
const buildGiveUpFix = (u, original, failed) =>
	`two rows of this session are live in \`claude agents\` on ${u.seat}: original job ${original} and its copy ${u.copyJobId}. The original would not retire after ${RETIRE_TRIES} tries (${failed}); stop and remove it by hand (\`claude stop ${original}\`, then \`claude rm ${original}\`) so only the copy is revived.`;

/**
 * @param {LoopLaunch[]} launches
 * @param {Pick<BlockIo, "retireJob"|"comment"|"log">} io
 * @returns {LoopLaunch[]}
 */
function retireOriginals(launches, io) {
	return launches.map((l) =>
		withRetried(l, launchName(l), io, (u, original, failed) =>
			io.comment(l, `Refill loop: ${buildGiveUpFix(u, original, failed)}`),
		),
	);
}

/**
 * `r` with each of its copy's unretired originals tried again, those retired
 * or out of tries dropped (retireOriginal); `r` itself where it has none.
 * @template {HasUnretired} R
 * @param {R} r
 * @param {string} name  whose copy it is, for the log
 * @param {Pick<BlockIo, "retireJob"|"log">} io
 * @param {(u: Unretired, original: string, failed: string) => void} giveUp
 *   told of an original out of tries
 * @returns {R}
 */
function withRetried(r, name, io, giveUp) {
	if (!r.unretired) return r;
	const left = r.unretired.flatMap((u) => retireOriginal(u, name, io, giveUp));
	const { unretired: _, ...rest } = r;
	return /** @type {R} */ (
		left.length > 0 ? { ...rest, unretired: left } : rest
	);
}

/**
 * Original `u` of `name`'s copy tried again: nothing once retired, else `u`
 * with the try counted, or nothing once out of tries, `giveUp` told.
 * @param {Unretired} u
 * @param {string} name
 * @param {Pick<BlockIo, "retireJob"|"log">} io
 * @param {(u: Unretired, original: string, failed: string) => void} giveUp
 * @returns {Unretired[]}
 */
function retireOriginal(u, name, io, giveUp) {
	const original = shortJobId(u.sessionId);
	const what = `original ${original} of ${name}'s copy ${u.copyJobId}`;
	const failed = io.retireJob(u.seat, u.sessionId, u.cwd);
	if (!failed) {
		io.log(`retired ${what}`);
		return [];
	}
	const tries = u.tries + 1;
	io.log(`${what} not retired, try ${tries} of ${RETIRE_TRIES}: ${failed}`);
	if (tries < RETIRE_TRIES) return [{ ...u, tries }];
	giveUp(u, original, failed);
	return [];
}

module.exports = { buildGiveUpFix, retireOriginals, withRetried };
