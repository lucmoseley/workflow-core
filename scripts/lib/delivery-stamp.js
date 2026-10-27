/*
 * delivery-stamp.js — the once-only stamp a `--notify` checker reports under,
 * held in one place instead of three (mantahostels#1975).
 *
 * WHY IT MOVED. Under plain `--notify` a checker's stdout IS the delivery, so
 * a producer that suppressed its own repeat was suppressing something the
 * founder had genuinely already seen. Under persist mode (mantahostels#1974) stdout is a
 * report FILE, and whether that file ever reaches a session is the reader's
 * business — so a producer suppressing on its own stamp can bury a finding
 * nobody was ever shown.
 *
 * WHAT IS SHARED AND WHAT IS NOT. The store, the persist-awareness, the
 * `--notify`-only gating and the COMPARISON are shared. The signature — what
 * "the same report" means — stays with each checker, because the three
 * disagree: ghost-jobs compares a set of ghost keys, ci-status a monotonic run
 * id, and stop-guard-outcomes a bucketed distribution string.
 *
 * A signature is an opaque string, with one exception the comparison itself
 * has to know about. `highWater(n)` marks a signature as a high-water mark
 * rather than an identity, because ci-status's stamp is the newest failing run
 * id and anything no newer has already been delivered. The rule rides IN the
 * string rather than beside it so that the delivery half — which holds nothing
 * but the checker name and the persisted stamp — can apply it without a
 * per-checker table of its own.
 *
 * THE STORE IS notify-report.js's, not the arbiter's. It has to be: a stamp
 * the reader owns must be found by whichever `~/.claude*` plan reads it, and
 * that library already resolves one location per machine (mantahostels#1949 story 17).
 * `stateDir()` would give each plan a stamp of its
 * own, so one report would be delivered once per plan. Required lazily so a
 * checker that never stamps does not pay for that dependency tree.
 *
 * DEGRADES TO A NO-OP, ALWAYS. An unreadable stamp reads as never-delivered
 * and an unwritable one is dropped: both mean a repeated notice.
 *
 * Mutated again at mantahostels#2244, eleven of them, each failing exactly its own test.
 *
 * Mutated at mantahostels#1975, seven of them, each failing exactly its own test: dropping
 * the persist limb from readSeenStamp and from markDelivered; dropping the notify
 * limb from readSeenStamp; dropping the stamp from the persisted report
 * (lib/check.js persistReport); never telling the ctx it is persisting;
 * ghost-jobs stamping the reported set rather than the standing one; and each
 * of the three producers calling the ctx-less `delivered` where
 * `alreadyDelivered` was meant.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {{ notify: boolean, persisting: boolean }} StampCtx a CheckContext,
 *   narrowed to the two flags that decide whether this run is the delivery
 */

/** The one directory per machine both halves agree on — see the header. */
const base = () => require("./notify-report.js").base();

/** @param {string} checker */
const stampFile = (checker) => path.join(base(), `${checker}.notified`);

/** Marks `value` as a high-water mark: anything no higher is already delivered. */
const HIGH_WATER = "max:";

/** @param {number|string} value */
const highWater = (value) => `${HIGH_WATER}${value}`;

/**
 * Whether `seen` already covers `signature`. Identity, unless both are
 * high-water marks — and a high-water pair that will not read as numbers
 * falls back to identity rather than guessing an order.
 * @param {string} seen
 * @param {string} signature
 */
function covers(seen, signature) {
	const want = Number(signature.slice(HIGH_WATER.length));
	const had = Number(seen.slice(HIGH_WATER.length));
	const ordered =
		signature.startsWith(HIGH_WATER) &&
		seen.startsWith(HIGH_WATER) &&
		Number.isFinite(want) &&
		Number.isFinite(had);
	return ordered ? want <= had : seen === signature;
}

/**
 * The stamp `checker` last delivered under — null where it has never been
 * delivered, or the stamp cannot be read.
 * @param {string} checker
 * @returns {string | null}
 */
function readStamp(checker) {
	try {
		return fs.readFileSync(stampFile(checker), "utf8").trim();
	} catch {
		return null;
	}
}

/**
 * Record that `checker`'s report reached the founder. Called by whichever step
 * is the delivery: the producer itself under plain `--notify`, and the replay
 * reader under persist mode.
 * @param {string} checker
 * @param {string} signature
 * @returns {boolean} whether the stamp landed
 */
function recordDelivery(checker, signature) {
	try {
		fs.mkdirSync(base(), { recursive: true });
		fs.writeFileSync(stampFile(checker), signature);
		return true;
	} catch {
		return false;
	}
}

/**
 * Forget that `checker` was ever delivered, so its next report is said again.
 *
 * UNGATED, unlike markDelivered: a checker whose finding set has emptied clears
 * on every path that noticed, hand run included.
 * @param {string} checker
 * @returns {boolean} whether the stamp is now gone
 */
function clearDelivery(checker) {
	try {
		fs.rmSync(stampFile(checker), { force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether a report carrying `signature` has already been delivered. The
 * delivery half's read — this is what the replay reader asks before showing a
 * persisted report.
 * @param {string} checker
 * @param {string} signature
 */
function delivered(checker, signature) {
	const seen = readStamp(checker);
	return seen !== null && covers(seen, signature);
}

/**
 * The stamp a PRODUCER should judge its findings against, or null where it
 * should judge them against nothing and report everything.
 *
 * Null in two cases beyond an unwritten stamp. Not `--notify` at all — a hand
 * run, pre-commit or CI always answers
 * in full. And persist mode, where this run is not the delivery.
 *
 * @param {StampCtx} ctx
 * @param {string} checker
 * @returns {string | null}
 */
function readSeenStamp(ctx, checker) {
	if (!ctx.notify || ctx.persisting) return null;
	return readStamp(checker);
}

/**
 * The high-water mark a producer should judge its findings against, as a
 * number, or null where it should judge them against nothing. Null for
 * everything `readSeenStamp` answers null for, and for a stamp that is an identity
 * rather than a mark, or a mark that will not read as a number — all of which
 * mean the same thing here: report everything.
 *
 * The `max:` spelling is this module's (workflow-core#202): a producer parsing it back for
 * itself would be reading a private prefix from the outside.
 * @param {StampCtx} ctx
 * @param {string} checker
 * @returns {number|null}
 */
function readSeenHighWater(ctx, checker) {
	const seen = readSeenStamp(ctx, checker);
	if (seen === null || !seen.startsWith(HIGH_WATER)) return null;
	const ms = Number(seen.slice(HIGH_WATER.length));
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether a producer should stay silent because it has already delivered this
 * exact report. Always false under persist mode.
 * @param {StampCtx} ctx
 * @param {string} checker
 * @param {string} signature
 */
function alreadyDelivered(ctx, checker, signature) {
	const seen = readSeenStamp(ctx, checker);
	return seen !== null && covers(seen, signature);
}

/**
 * A producer's own stamping, after its report is out. A no-op unless this run
 * was the delivery — under persist mode the replay reader stamps instead, once
 * it has actually shown the report.
 * @param {StampCtx} ctx
 * @param {string} checker
 * @param {string} signature
 */
function markDelivered(ctx, checker, signature) {
	if (!ctx.notify || ctx.persisting) return;
	recordDelivery(checker, signature);
}

/*
 * `stampFile`, `readStamp`, `recordDelivery` and `delivered` are the DELIVERY
 * half, and their consumer — mantahostels#1949's synchronous reader,
 * scripts/replay-notify-reports.js — is a later ticket.
 */
module.exports = {
	highWater,
	stampFile,
	readStamp,
	recordDelivery,
	clearDelivery,
	delivered,
	readSeenStamp,
	readSeenHighWater,
	alreadyDelivered,
	markDelivered,
};
