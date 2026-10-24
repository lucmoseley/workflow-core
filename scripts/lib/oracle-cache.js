/*
 * oracle-cache.js — single-flight over `claude agents --json`, the oracle
 * agent-liveness.js reads. `readFresh` carries a TTL, but no caller of
 * agent-liveness.js is ever offered a hit from it standing alone (mantahostels#1960) — only
 * `waitForLeader` consults it (below).
 *
 * WHY SINGLE-FLIGHT AND NOT A PLAIN CACHE (mantahostels#1924, measuring mantahostels#1921). It
 * was built for three SessionStart hooks launching at the SAME INSTANT, where a
 * TTL cache alone is missed by all three: they race, none has written yet. One
 * spawn cost 8.89 s cold and 2.75 s warm (mantahostels#1921). Two of the three
 * now run under `npm run status`, which launches its checkers concurrently
 * (`status-report.js`'s `Promise.all`), so the burst moved rather than went
 * (#1446).
 *
 * THE PLAIN TTL HIT IS GONE (mantahostels#1960): IT LET A CACHED SUCCESS OUTLIVE A DAEMON
 * FAILURE (mantahostels#1946).
 *
 * RESIDUAL, ACCEPTED: THE SECOND WIN IS GONE WITH IT. A reader that starts
 * just after the leader has published always spawns its own oracle rather
 * than being served the leader's.
 *
 * DEGRADES TO TODAY'S BEHAVIOUR, NEVER TO A REFUSAL. Every failure here — an
 * unwritable config dir, a wedged leader, a corrupt cache file — ends in the
 * caller running its own oracle. agent-liveness.js's contract is that a bad read
 * degrades to doubt, and a throw from a cache would abort a SessionStart hook
 * mid-pass.
 *
 * IT CACHES RAW STDOUT, NEVER A CLASSIFIED LISTING. Every check
 * agent-liveness.js makes — the shape guards and the self-test above all — is
 * per-caller, and the self-test's answer differs between two sessions reading
 * one listing. Caching before classification keeps those checks live on every
 * read; caching after would let one session's self-test verdict stand in for
 * another's.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { configDir } = require("./config-dir.js");
const { sleepSync } = require("./sleep-sync.js");
const { caught } = require("./caught.js");

/*
 * EVERY PATH IS KEYED TO THE ORACLE BINARY, and that is a correctness guard
 * rather than tidiness. The suite stands a fake `claude` on WFC_CLAUDE_BIN;
 * unkeyed, a fake would be served the real daemon's listing from a session
 * start seconds earlier, and — worse — would queue behind that start's lock for
 * the follower wait. Keyed, a fake shares nothing with the real oracle and
 * nothing with another fake.
 */
/** @param {string} bin */
const keyOf = (bin) =>
	crypto.createHash("sha1").update(String(bin)).digest("hex").slice(0, 12);

/** @param {string} bin */
const cachePath = (bin) =>
	path.join(configDir(), `wfc-oracle-cache-${keyOf(bin)}.json`);

/* A DIRECTORY, not a file: mkdir is the atomic create-or-fail every platform
 * agrees on, and an O_EXCL open is not on a network-mounted home. */
/** @param {string} bin */
const lockPath = (bin) =>
	path.join(configDir(), `wfc-oracle-cache-${keyOf(bin)}.lock`);

/**
 * A positive millisecond knob from `env`, else `fallback` — a garbled value must
 * not disable the bound it carries. Mirrors agent-liveness.js's `capMs`; the two
 * are not shared because importing that module from here would be a cycle.
 *
 * @param {string} env
 * @param {number} fallback
 * @returns {number}
 */
function capMs(env, fallback) {
	const n = Number(process.env[env]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* HOW LONG A LISTING STAYS GOOD — `readFresh`'s own outer bound, kept for its
 * stand-alone contract. DEAD AT THE SHIPPED DEFAULTS (mantahostels#1960): nothing asks
 * for a record older than `waitMs` (4 s) — always inside this 20 s figure — so
 * this can only reject anything if the env knob is set below `waitMs`. */
const ttlMs = () => capMs("WFC_ORACLE_CACHE_TTL_MS", 20_000);

/*
 * HOW LONG A FOLLOWER WAITS ON THE LEADER before spawning its own.
 *
 * NO HOOK BUDGET BINDS IT (#1446). A follower waits AND THEN SPAWNS, so its
 * worst case is this figure plus its own read, which agent-liveness.js caps at
 * 30 s (10 s and a 20 s retry). The SessionStart readers left are
 * reap-finished-sessions.js, async, so its timeout is inert
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/async-hook-timeout-enforcement.md); check-orphaned-edits.js,
 * under a 60 s timeout and only where a dirty file is old enough; and the
 * detached `prune-markers` and scratch sweep, under none. 4 s plus 30 s sits
 * inside that 60 s. `npm run status`'s readers have no budget.
 *
 * SO 4 s STANDS ON THE LEADER'S SPEED ALONE. It catches a warm spawn — 2.75 s
 * at mantahostels#1921, 0.78-1.21 s at #1446 — and lets a cold leader go,
 * which costs a second spawn, but a STAGGERED one: the contention between
 * concurrent spawns is where the measured cost was. A longer wait would trade
 * that second spawn for waiting out the cold one; which is faster is unmeasured.
 */
const waitMs = () => capMs("WFC_ORACLE_CACHE_WAIT_MS", 4000);

/* WHEN A LOCK IS RUBBISH RATHER THAN HELD. A leader killed mid-run — which is
 * exactly what mantahostels#1920 records happening to these hooks — leaves the directory
 * behind, and without this every later start would follow a leader that is not
 * coming back.
 *
 * 60 s CLEARS THE LONGEST HONEST RUN. agent-liveness.js caps one oracle call at
 * 10 s and its single retry at 20 s, so a leader doing everything it is allowed
 * to do holds the lock for 30 s. Double that, so a merely slow leader is never
 * mistaken for a dead one. */
const lockStaleMs = () => capMs("WFC_ORACLE_CACHE_LOCK_STALE_MS", 60_000);

/* HOW OFTEN A FOLLOWER LOOKS. Two spawns of the oracle cost seconds, so a
 * hundred milliseconds of latency on the answer is free; below that the polling
 * itself starts to cost more than it saves. */
const pollMs = () => capMs("WFC_ORACLE_CACHE_POLL_MS", 100);

/*
 * OFF BY ONE ENV VAR, so a session that suspects the cache can rule it out.
 *
 * IT IS DELIBERATELY NOT KEYED OFF `WFC_CLAUDE_BIN` BEING SET. That was tried
 * and measured wrong: this machine exports WFC_CLAUDE_BIN in the real shell —
 * `~/.local/bin/claude-agents-union` — so treating it as a test-only seam turned
 * the cache off in production and the benchmark read a flat nothing. The suite
 * is kept out of the way by keying every path to the binary instead, and the
 * sweep in `write` collects what the suite leaves.
 */
const isDisabled = () => process.env.WFC_ORACLE_CACHE === "0";

/**
 * Sleep, synchronously, and say whether it could. Every caller here is a hook
 * already blocking on a subprocess, and making this module async would make
 * `readListing` async and every consumer with it.
 *
 * False where it could not sleep at all. The caller then abandons the wait
 * rather than polling with no delay: a hot loop of readFileSync for seconds, on
 * the machine whose whole defect is SessionStart contention, costs more than the
 * spawn it is trying to save.
 *
 * @param {number} ms
 * @returns {boolean}
 */
function trySleep(ms) {
	try {
		sleepSync(ms);
		return true;
	} catch {
		return false;
	}
}

/**
 * The cached stdout if one was written within the TTL, else null.
 *
 * `minAt` narrows that to records written since a given moment, which is how a
 * follower avoids mistaking a record left by an EARLIER start for the answer the
 * leader it is waiting on has not published yet.
 *
 * @param {string} bin
 * @param {number} [minAt]
 * @returns {string|null}
 */
function readFresh(bin, minAt) {
	if (isDisabled()) return null;
	try {
		const rec = JSON.parse(fs.readFileSync(cachePath(bin), "utf8"));
		if (!rec || typeof rec.raw !== "string") return null;
		const at = Number(rec.at);
		if (!Number.isFinite(at)) return null;
		/* A record dated ahead of the clock is a clock that moved, not a fresh
		 * read, and believing it would pin the cache open for the offset. */
		const age = Date.now() - at;
		if (age < 0 || age > ttlMs()) return null;
		if (minAt !== undefined && at < minAt) return null;
		return rec.raw;
	} catch {
		/* ENOENT on the first read of a start, and a partial or unreadable record
		 * otherwise. Both mean the same thing to a caller — spawn. */
		return null;
	}
}

/**
 * Publish stdout for the next reader, atomically.
 *
 * @param {string} bin
 * @param {string} raw
 */
function write(bin, raw) {
	if (isDisabled()) return;
	try {
		writeFileAtomic(cachePath(bin), JSON.stringify({ at: Date.now(), raw }), {
			mkdir: true,
		});
		sweep();
	} catch {
		/* An unwritable config dir, or a full disk. Publishing is best-effort by
		 * design: the caller already has its answer, and the next reader simply
		 * spawns. */
	}
}

/* HOW LONG A RECORD IS KEPT ON DISK, as against how long it is BELIEVED. Long
 * enough to be irrelevant to any reader — 15x the TTL, so no record still in
 * use is ever collected — and short enough that the suite's litter does not
 * outlive a run. */
const keepMs = () => capMs("WFC_ORACLE_CACHE_KEEP_MS", 300_000);

/*
 * Collect abandoned records. One per oracle binary is the steady state, but the
 * suite stands up a fresh temp `claude` per test, so without this the config dir
 * gathers a record per test for ever (mantahostels#1924). Swept on write because that is the only moment this
 * module is certainly allowed to write to the directory at all.
 */
function sweep() {
	try {
		const dir = configDir();
		const cutoff = Date.now() - keepMs();
		for (const name of fs.readdirSync(dir)) {
			if (!name.startsWith("wfc-oracle-cache-")) continue;
			/* `.tmp` as well as `.json`: a writer killed between its write and its
			 * rename leaves one behind, and nothing else would ever collect it. */
			if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
			const full = path.join(dir, name);
			if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
		}
	} catch {
		/* A sweep is housekeeping: never let it cost a caller its answer. */
	}
}

/**
 * Take the right to spawn. True means this caller leads and MUST call
 * `release`; false means another caller is already spawning.
 *
 * @param {string} bin
 * @returns {boolean}
 */
function acquire(bin) {
	if (isDisabled()) return true;
	/* No usable config dir means no lock is possible for anyone, so leading is
	 * the honest answer: following would wait out a leader that can never
	 * publish. */
	try {
		fs.mkdirSync(configDir(), { recursive: true });
	} catch {
		return true;
	}
	try {
		fs.mkdirSync(lockPath(bin));
		return true;
	} catch (e) {
		/* EEXIST is the only failure that means SOMEBODY ELSE IS SPAWNING. Any
		 * other — a permission, a full disk — means this caller cannot take part in
		 * the protocol at all, and goes alone rather than waiting on nothing. */
		if (caught(e).code !== "EEXIST") return true;
		/* Held — unless it is the corpse of a killed leader, which is broken once
		 * and retaken. A second failure means a live leader took it in between. */
		if (!breakIfStale(bin)) return false;
		try {
			fs.mkdirSync(lockPath(bin));
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Remove a lock older than the stale bound. True where one was removed.
 *
 * @param {string} bin
 * @returns {boolean}
 */
function breakIfStale(bin) {
	try {
		const age = Date.now() - fs.statSync(lockPath(bin)).mtimeMs;
		if (age <= lockStaleMs()) return false;
		fs.rmSync(lockPath(bin), { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/*
 * RESIDUAL, ACCEPTED: THE LOCK CARRIES NO OWNER. A leader that overran the stale
 * bound, had its lock broken and its successor's taken, then finished, deletes
 * the successor's lock here — and a third caller can lead beside the second. The
 * cost of that is one extra oracle spawn, which is the cost of not having this
 * module at all, so it is bounded by the thing it optimises. An owner token
 * would fix it and needs a write-and-verify the mkdir does not give.
 */
/** @param {string} bin */
function release(bin) {
	if (isDisabled()) return;
	try {
		fs.rmSync(lockPath(bin), { recursive: true, force: true });
	} catch {
		/* A lock we cannot remove goes stale on its own bound. */
	}
}

/**
 * Wait for the leader to publish, and answer with what it published. Null means
 * the leader overran or produced nothing usable — the caller then spawns its
 * own, which is what it would have done without this module.
 *
 * IT ACCEPTS ONLY A RECORD WRITTEN SINCE THE WAIT BEGAN. Without that a
 * follower takes whatever sits in the cache — a record from an earlier start,
 * inside the TTL but not the answer anybody is waiting for — and the wait
 * silently becomes an ordinary cache read.
 *
 * `sleep` is injected so a test counts the polls rather than timing them (base
 * §X9).
 *
 * @param {string} bin
 * @param {{ sleep?: (ms: number) => boolean }} [deps]
 * @returns {string|null}
 */
function waitForLeader(bin, { sleep = trySleep } = {}) {
	if (isDisabled()) return null;
	const began = Date.now();
	const deadline = began + waitMs();
	const step = pollMs();
	while (Date.now() < deadline) {
		if (!sleep(step)) return null;
		const hit = readFresh(bin, began);
		if (hit !== null) return hit;
		/* Leader gone without publishing — it failed or was killed. Nothing more
		 * will arrive, so stop waiting and go alone. */
		if (!isHeldByAnother(bin)) return null;
	}
	return null;
}

/**
 * @param {string} bin
 * @returns {boolean}
 */
function isHeldByAnother(bin) {
	try {
		return fs.existsSync(lockPath(bin));
	} catch {
		return false;
	}
}

module.exports = {
	write,
	acquire,
	release,
	waitForLeader,
};
