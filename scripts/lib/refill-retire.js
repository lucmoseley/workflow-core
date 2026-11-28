const { LOOP_NOTICE_PREFIX } = require("./refill-notice.js");
const { shortJobId } = require("./job-paths.js");
const { launchName } = require("./refill-block-core.js");

/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {import("./refill-blocks.js").Unretired} Unretired */
/** @typedef {import("./refill-blocks.js").HasUnretired} HasUnretired */
/** @typedef {import("./refill-blocks.js").BlockIo} BlockIo */

// guess, #4646
const RETIRE_TRIES = 3;

/**
 * @param {Unretired} u
 * @param {string} original
 * @param {string} failed
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
			io.comment(
				l,
				`${LOOP_NOTICE_PREFIX}${buildGiveUpFix(u, original, failed)}`,
			),
		),
	);
}

/**
 * @template {HasUnretired} R
 * @param {R} r
 * @param {string} name
 * @param {Pick<BlockIo, "retireJob"|"log">} io
 * @param {(u: Unretired, original: string, failed: string) => void} giveUp
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
