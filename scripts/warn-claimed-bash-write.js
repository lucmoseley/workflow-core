#!/usr/bin/env node
/*
 * warn-claimed-bash-write.js — is this Bash command about to write, by a route
 * no hook refuses, over a file another live session holds? (mantahostels#1818, split out of
 * mantahostels#1772; route (f) under docs/doc-map.md §Capture and placement.)
 *
 * Usage:
 *   node scripts/warn-claimed-bash-write.js [--ledger <path>] [--credit <path>]… \
 *     [--select <path>]… <session-id> <target>…
 *
 * Prints the LIVE CLAIM LIST FILTERED TO THE TARGETS the command names, and
 * nothing at all otherwise. It ALWAYS exits 0 and never blocks anything:
 * guard-claimed-bash-write.sh, the PreToolUse hook that drives it, turns
 * whatever comes back into `additionalContext`.
 *
 * THE SESSION LEDGER (mantahostels#2345). `--ledger <path>` names a per-session file this
 * script reads and writes to bound what one session can be made to pay here.
 * Its rules, and why the unit is the (target, holder) pair rather than the rule,
 * are guard-claimed-bash-write.sh's header. WITHOUT the flag nothing is
 * remembered and every qualifying call pays the whole payload.
 *
 * SPENDING IT IS NOT THE END (mantahostels#2364). The pointer that replaces the payload
 * decays hourly and is said again on a contended pair this session has not
 * already been handed, rather than latching the guard silent for good.
 *
 * THE FAILURE (mantahostels#287, mantahostels#295). `scripts/guard-file-claim.sh` sees Write, Edit and
 * NotebookEdit; a shell redirect, a `cp`, a `sed -i` is invisible to it, so a
 * Bash-route write over a neighbour's held file is neither refused nor
 * announced. mantahostels#287 declined a Bash-route DENY on price — the parser is
 * outrunnable (mantahostels#201).
 *
 * TIER 1 ONLY FOR THE WARNING, which is `store.isGuarded` — `docs/`, `.claude/`,
 * `CLAUDE.md`, `AGENTS.md`. The `scripts/` tier is detect-only by mantahostels#287's own
 * ruling and a prompt there buys the least; adding it is a separate call
 * (mantahostels#1772).
 *
 * `--credit <path>` IS THE OTHER HALF AND IS NOT TIER-BOUND (mantahostels#2778): it
 * attributes a code write this command makes to this session's write ledger,
 * skipping any path another live session holds. It prints nothing, ever, and
 * runs even when there are no tier-1 targets at all. See `credit` below.
 *
 * `--select <path>` IS A THIRD, FOR TEST SELECTION ALONE (#1220): a path an
 * inline `python`/`node` program quoted, noted on the selection ledger
 * (`store.recordSelect`) and never the write ledger, because the program may
 * only have read it (mantahostels#114). No contention skip here: the reader,
 * lib/own-selection.js's `attributeDirty` wherever test selection calls it — never
 * for the `--isolated` refusal — subtracts a live neighbour's claim itself.
 *
 * A TARGET is a repo-relative or absolute path the guard read as the WRITE
 * TARGET of one command — never a path merely mentioned. Which spellings it
 * reads, and what it misses, is guard-claimed-bash-write.sh's own header.
 *
 * THE HOLDER IS NAMED BY SESSION ID, on warn-stale-script.js's reasoning (mantahostels#317).
 */

const fs = require("node:fs");
const store = require("./lib/arbiter-store.js");

/** @typedef {import("./lib/arbiter-store").ListedLock} Lock */
/** @typedef {Exclude<Lock, { unreadable: true }>} LiveLock */

/**
 * 4,000 B is `GP_RULE_CAP`'s figure (scripts/lib/guard-parse.sh), tracked
 * deliberately so the two things a Bash call can be handed are bounded alike.
 */
const WARN_MAX_BYTES = 4000;

/**
 * Bytes held back from the line budget for the overflow notice that replaces
 * the lines that did not fit. The notice is fixed text plus a decimal count,
 * 60 B at a three-digit count (measured), rounded up so a later reword of it
 * does not silently overrun the reserve.
 */
const OVERFLOW_RESERVE = 80;

/**
 * What this guard may spend on one session's PAYLOADS, plus the first pointer
 * that ends them (mantahostels#2345, re-derived at mantahostels#2363).
 *
 * SELF-IMPOSED, because route (f)'s caps cannot reach a payload composed here
 * from live state.
 *
 * DERIVED, and the case it prices is guard-claimed-bash-write.sh's header —
 * which also states what this leaves overrunning against route (f). Re-derive
 * there before moving this constant; POINTER interpolates it, so a budget of a
 * different digit count changes POINTER_BYTES and falsifies the derivation
 * there.
 *
 * WHAT IT DOES NOT BOUND, once the pointer decays (mantahostels#2364): each hourly repeat
 * costs a further POINTER_BYTES on top of this figure.
 */
const SESSION_BUDGET_BYTES = 2000;

/**
 * How long the pointer silences this guard before it speaks again (mantahostels#2364).
 *
 * THE HOUSE SHAPE FOR A BOUNDED REPEAT, which is the arbiter `request` marker's
 * hourly decay (docs/agents/guard-registry.md §Conventions). THE INTERVAL IS COPIED, NOT READ:
 * nothing here consults that marker, so the two drift independently. Not a
 * terminal latch: what it silences is a clobber warning, the direction
 * AGENTS.md §Supervision priors says to err away from.
 */
const POINTER_DECAY_MS = 60 * 60 * 1000;

/**
 * What replaces the payload once the session's remainder is too small to afford
 * one — which is usually, but not always, the whole budget spent. Said once,
 * then again at most once an hour — `pointedAt` in the ledger.
 */
const POINTER =
	"A live session holds a path this command writes; this guard has spent " +
	`its ${SESSION_BUDGET_BYTES} B session budget (mantahostels#2345). It repeats hourly ` +
	"on a NEW contended path (mantahostels#2364). Read the claims: " +
	"`node scripts/session-arbiter.js list`.";

const POINTER_BYTES = Buffer.byteLength(POINTER);

/**
 * What one session has already been told, and what it has cost.
 *
 * `pairs` holds `<lock path> <holder session> <target>` for every line already
 * delivered. Why that triple and not the rule: guard-claimed-bash-write.sh's
 * header.
 *
 * `pointedAt` is when the pointer last replaced a payload, in epoch ms, or
 * null while payloads are still being paid for.
 *
 * A LEDGER FROM BEFORE mantahostels#2364 carries the boolean `pointed` and no stamp, so it
 * reads as never-pointed — but `bytes` survives, and a ledger that had pointed
 * is by construction one that spent the old 4,000 B budget. Its remainder is
 * therefore negative and the very next firing gets the POINTER, not a payload,
 * and the decay runs from there.
 * @typedef {{ bytes: number, pairs: string[], pointedAt: number | null }} Ledger
 */

/** A session that has been told nothing. @returns {Ledger} */
const emptyLedger = () => ({ bytes: 0, pairs: [], pointedAt: null });

/**
 * The ledger at `file`, or an empty one.
 *
 * ANYTHING UNREADABLE READS AS EMPTY — absent, truncated, malformed, a shape
 * from an older revision. Erring the other way would suppress a first warning.
 * @param {string | null} file
 * @returns {Ledger}
 */
function readLedger(file) {
	if (!file) return emptyLedger();
	try {
		const d = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!d || typeof d !== "object") return emptyLedger();
		return {
			bytes: Number.isFinite(d.bytes) && d.bytes > 0 ? d.bytes : 0,
			pairs: Array.isArray(d.pairs) ? d.pairs.filter(isString) : [],
			pointedAt:
				Number.isFinite(d.pointedAt) && d.pointedAt > 0 ? d.pointedAt : null,
		};
	} catch {
		return emptyLedger();
	}
}

/** @param {unknown} v @returns {v is string} */
const isString = (v) => typeof v === "string";

/**
 * Record what was just said. Best-effort: an unwritable ledger costs the repeat
 * this bound was to save, and must not cost the warning itself.
 *
 * WRITTEN BEFORE THE EMISSION, and structurally so — `gp_warn` in the driving
 * hook does not return, so there is no after. A hook cancelled at its timeout
 * therefore has its stdout discarded with the ledger already marked, and the
 * session is told-but-not-told for that one path — mantahostels#2261's window on gp_rule's
 * own latch.
 * @param {string | null} file
 * @param {Ledger} led
 */
function writeLedger(file, led) {
	// Not a behaviour guard — the catch below would absorb the throw — but the
	// difference between silence and a fail-open logged on every unledgered call.
	if (!file) return;
	try {
		fs.writeFileSync(file, JSON.stringify(led));
	} catch (e) {
		store.logError("claimed-bash-write", e);
	}
}

/**
 * Every target resolved to a repo-relative tier-1 path, de-duplicated. A path
 * outside the repo, or inside it but outside the refusing tier, is dropped
 * here: `isGuarded` is the authority on which tier a path sits in, and the
 * guard's own prefix test is only a spawn-saver.
 * @param {string[]} targets
 */
function resolveTargets(targets) {
	/** @type {string[]} */
	const out = [];
	for (const raw of targets) {
		const rel = store.relativeToRepo(raw);
		if (rel !== null && store.isGuarded(rel) && !out.includes(rel))
			out.push(rel);
	}
	return out;
}

/**
 * Attribute this command's code write targets to this session (mantahostels#2778).
 *
 * WHY IT EXISTS. scripts/record-write.sh records the Write/Edit/NotebookEdit
 * tools only, so a session that edits code through `sed -i` or a redirect
 * reaches concision-backstop.sh with an empty ledger, and that backstop's code
 * signal never fires — no threshold, mantahostels#2769's zero one included, is ever
 * consulted. What it cost is measured in that file's header.
 *
 * WHAT MAKES IT SAFE, and it is not the parser. mantahostels#114 forbids over-billing
 * because a nag naming a neighbour's file sends this session to edit a file a
 * live session holds — the collision guard-file-claim.sh refuses. A path any
 * OTHER live session holds a claim on is therefore skipped outright, so that
 * harm cannot be produced here whatever the parser gets wrong. The two remaining
 * error directions both cost nothing: a target the guard could not read is never
 * passed at all, and a target that turns out not to have changed is dropped by
 * the backstop's own `git diff --name-only` before it is counted.
 *
 * AN UNREADABLE LOCK STORE CREDITS NOTHING. Under-attribution is the safe
 * direction and is the status quo this narrows; guessing is not.
 *
 * IT DOES NOT TOUCH THE CLAIM STORE: `store.recordWrite` writes the ledger
 * alone, so a `scripts/` path stays as unclaimed as it was.
 * @param {string[]} paths repo-relative code paths this command writes
 * @param {string} sessionId
 * @returns {string[]} the paths actually credited
 */
function credit(paths, sessionId) {
	const locks = store.listLocks();
	if (locks === null) {
		store.logError(
			"claimed-bash-write",
			new Error(
				"the lock store could not be read — a Bash-route code write went uncredited (mantahostels#2778)",
			),
		);
		return [];
	}
	/** @type {string[]} */
	const done = [];
	for (const rel of new Set(paths)) {
		/* NO `lock.sessionId &&` LIMB, unlike `contends()` below. A live lock may
		 * legally carry a null sessionId (arbiter-records.js), and there it is
		 * skipped because a warning naming no holder says nothing. Here skipping
		 * would CREDIT the path — the over-bill mantahostels#114 forbids — so an unidentified
		 * live holder counts as contention. */
		const contended = locks.some(
			(lock) =>
				!lock.unreadable &&
				lock.alive &&
				lock.sessionId !== sessionId &&
				store.subjectsOverlap(lock.path, rel),
		);
		if (contended) continue;
		if (store.recordWrite(rel, sessionId) !== null) done.push(rel);
	}
	return done;
}

/**
 * How the list names the session holding a target.
 * @param {LiveLock} lock
 */
function describeHolder(lock) {
	const who = lock.sessionId || "an unidentified session";
	const when = lock.claimedAt ? `, holding it since ${lock.claimedAt}` : "";
	return `${who} (pid ${lock.pid ?? "unknown"})${when}`;
}

/**
 * One line of the filtered claim list.
 * @param {string} target
 * @param {LiveLock} lock
 */
function line(target, lock) {
	// The lock's own subject, not the target: a region claim
	// (`docs/doc-map.md#B42`) contends with a whole-file write.
	const held =
		lock.path === target ? target : `${lock.path} (covers ${target})`;
	return `  HELD  ${held} — session ${describeHolder(lock)}`;
}

/**
 * The whole warning for `targets`, or "" where there is nothing to say.
 *
 * Empty is also the answer where the store cannot be read: an unreadable lock
 * store must not manufacture a warning, and mantahostels#103 §6 allows unchecked rather
 * than guessing.
 * @param {string[]} targets
 * @param {string | null} sessionId
 * @param {string | null} [ledgerFile] the session ledger (mantahostels#2345), or null for
 *   the unbounded pre-mantahostels#2345 behaviour
 */
function warnings(targets, sessionId, ledgerFile = null) {
	const locks = store.listLocks();
	if (locks === null) {
		// mantahostels#147: every fail-open is recorded.
		store.logError(
			"claimed-bash-write",
			new Error(
				"the lock store could not be read — a Bash-route write allowed unchecked",
			),
		);
		return "";
	}
	const led = readLedger(ledgerFile);
	// Once pointed, the pointer is the ONLY thing this guard says — an hour's
	// silence, then the pointer again (mantahostels#2364). Latched here rather than inside
	// the over-budget branch, where a later payload small enough to fit the
	// unspent remainder would get through and the stated ceiling would not be
	// the enforced one.
	// Bound to a local so the null check narrows both uses; `led.pointedAt`
	// reads as nullable at each one.
	const pointedAt = led.pointedAt;
	if (pointedAt !== null && Date.now() - pointedAt < POINTER_DECAY_MS)
		return "";
	const { lines, fresh } = contention(targets, locks, led, sessionId);
	if (lines.length === 0) return "";

	// Pointed, and the hour is up: the pointer again and never a payload.
	if (pointedAt !== null) return point(ledgerFile, led);
	return deliver(ledgerFile, led, lines, fresh);
}

/**
 * The HELD line for every live claim of another session on one of `targets`,
 * and the ledger key of each, skipping the pairs this session was already
 * handed (mantahostels#2345).
 * @param {string[]} targets
 * @param {Lock[]} locks
 * @param {Ledger} led
 * @param {string | null} sessionId
 * @returns {{ lines: string[], fresh: string[] }}
 */
function contention(targets, locks, led, sessionId) {
	/** @type {string[]} */
	const lines = [];
	/** @type {string[]} */
	const fresh = [];
	for (const target of resolveTargets(targets)) {
		for (const lock of locks) {
			if (!contends(lock, target, sessionId)) continue;
			const key = `${lock.path} ${lock.sessionId} ${target}`;
			if (led.pairs.includes(key)) continue;
			fresh.push(key);
			lines.push(line(target, lock));
		}
	}
	return { lines, fresh };
}

/**
 * @param {Lock} lock
 * @param {string} target
 * @param {string | null} sessionId
 * @returns {lock is LiveLock}
 */
function contends(lock, target, sessionId) {
	if (lock.unreadable || !lock.alive) return false;
	if (!store.subjectsOverlap(lock.path, target)) return false;
	// The session's own claim is not news to it.
	return Boolean(lock.sessionId) && lock.sessionId !== sessionId;
}

const WARN_HEAD =
	"This command writes through Bash to a file another LIVE session holds. " +
	"Nothing will refuse it — `guard-file-claim.sh` sees Write/Edit/NotebookEdit " +
	"only, so the Bash route is unguarded on both tiers (mantahostels#287, mantahostels#295).\n\n" +
	"The live claims on the paths this command names:\n\n";
const WARN_TAIL =
	"\n\nWrite anyway and you clobber an edit git cannot merge back. " +
	"Wait for it instead, backgrounded — `node scripts/session-arbiter.js wait <path>` " +
	"— and carry on with your ticket; past its ceiling, ask the holder with `request`.\n\n" +
	"Residual: a write no parse here recognises — a heredoc, a wrapper, a script that writes for you — " +
	"is invisible, so silence is not proof the path is free.";

/**
 * The payload for `lines` under this session's remaining budget, recording
 * what it said in the ledger — or the pointer where not even one line fits.
 * @param {string | null} ledgerFile
 * @param {Ledger} led
 * @param {string[]} lines
 * @param {string[]} fresh the ledger key of each of `lines`
 */
function deliver(ledgerFile, led, lines, fresh) {
	// The per-delivery ceiling, floored at what the session has left with the
	// terminating pointer already reserved. Floored rather than fixed (mantahostels#2363):
	// once the session budget is under one delivery's ceiling, a large first
	// firing must be TRIMMED to the remainder — `… and N more` carries the
	// recovery — instead of being replaced wholesale by a pointer that names no
	// path at all.
	//
	// UNLEDGERED, there is no session spend to be a remainder of, and the
	// documented pre-mantahostels#2345 contract is that every call pays the whole payload —
	// so the per-delivery ceiling stands alone, unbounded across firings.
	//
	// THE `Math.min` BELOW IS UNREACHABLE ON THE LEDGERED BRANCH while the
	// budget is under WARN_MAX_BYTES. It is kept so that raising the budget past
	// 4,000 B restores the per-delivery cap rather than silently retiring it.
	const remaining = ledgerFile
		? SESSION_BUDGET_BYTES - POINTER_BYTES - led.bytes
		: WARN_MAX_BYTES;
	const { text, kept } = clamp(
		WARN_HEAD,
		lines,
		WARN_TAIL,
		Math.min(WARN_MAX_BYTES, remaining),
	);

	// Not even one line fits: clamp keeps a first line whatever it costs, so this
	// is what tests that the payload was actually affordable.
	if (Buffer.byteLength(text) > remaining) return point(ledgerFile, led);

	// `kept`, never `fresh` whole: a pair the size ceiling dropped was counted in
	// the overflow line and not said, so recording it would suppress the only
	// delivery it was ever going to get.
	writeLedger(ledgerFile, {
		...led,
		bytes: led.bytes + Buffer.byteLength(text),
		pairs: [...led.pairs, ...fresh.slice(0, kept)],
	});
	return text;
}

/**
 * Emit the pointer and stamp the ledger with the hour it starts (mantahostels#2364).
 * No pair is recorded as delivered: a pointed session was told nothing about
 * them, so a compaction clearing the ledger must leave them all still to come.
 * @param {string | null} file
 * @param {Ledger} led
 */
function point(file, led) {
	writeLedger(file, {
		...led,
		bytes: led.bytes + POINTER_BYTES,
		pointedAt: Date.now(),
	});
	return POINTER;
}

/**
 * The three parts, with as many lines as fit under `ceiling` and a count of
 * those that did not. `kept` is how many of `lines` survived, in order, so the
 * caller can record exactly what was said (mantahostels#2345).
 * @param {string} head
 * @param {string[]} lines
 * @param {string} tail
 * @param {number} ceiling bytes the whole payload may occupy
 * @returns {{ text: string, kept: number }}
 */
function clamp(head, lines, tail, ceiling) {
	const budget = ceiling - Buffer.byteLength(head + tail);
	/** @type {string[]} */
	const kept = [];
	let used = 0;
	for (const l of lines) {
		// +1 for the newline joining it to the previous line.
		const cost = Buffer.byteLength(l) + 1;
		if (used + cost > budget - OVERFLOW_RESERVE) break;
		kept.push(l);
		used += cost;
	}
	// A first line longer than the whole budget would otherwise empty `kept`, and
	// the payload would then assert contention and name none. It is kept
	// whatever it costs.
	const [first] = lines;
	if (kept.length === 0 && first !== undefined) kept.push(first);
	const dropped = lines.length - kept.length;
	const more = dropped
		? `\n  … and ${dropped} more — node scripts/session-arbiter.js list`
		: "";
	return { text: head + kept.join("\n") + more + tail, kept: kept.length };
}

/**
 * @param {string[]} argv
 */
function parseFlags(argv) {
	/** @type {{ ledgerFile: string | null, credits: string[], selects: string[] }} */
	const opts = { ledgerFile: null, credits: [], selects: [] };
	for (;;) {
		const [flag, value] = argv;
		if (flag === "--ledger") opts.ledgerFile = value || null;
		else if (flag === "--credit") {
			if (value) opts.credits.push(value);
		} else if (flag === "--select") {
			if (value) opts.selects.push(value);
		} else return { ...opts, rest: argv };
		argv = argv.slice(2);
	}
}

/**
 * @param {() => void} fn
 */
function failOpen(fn) {
	try {
		fn();
	} catch (e) {
		store.logError("claimed-bash-write", e);
	}
}

/* cli-args-exempt: only guard-claimed-bash-write.sh calls it, and it must exit
 * 0 on any argv; a `--help` reply would be injected as the hook's warning. */
/** @param {string[]} argv */
function main(argv) {
	/* Flags lead, so the variadic targets keep the tail. A flag with no value is
	 * dropped rather than swallowing the session id — which holds only because the
	 * driving hook always pairs them; a hand-run flag with nothing after it takes
	 * the session id with it. */
	const { ledgerFile, credits, selects, rest } = parseFlags(argv);
	const [sessionId, ...targets] = rest;
	/* Credit first and unconditionally: it must run for a command whose only
	 * write target is code, which leaves `targets` empty. Its own try/catch, so a
	 * fault in one half cannot silence the other. */
	if (credits.length > 0 && sessionId)
		failOpen(() => credit(credits, sessionId));
	if (selects.length > 0 && sessionId)
		failOpen(() => {
			for (const rel of new Set(selects)) store.recordSelect(rel, sessionId);
		});
	if (targets.length === 0) return 0;
	let text = "";
	try {
		text = warnings(targets, sessionId || null, ledgerFile);
	} catch (e) {
		// Fail open, and leave a record (mantahostels#147).
		store.logError("claimed-bash-write", e);
		return 0;
	}
	if (text) process.stdout.write(`${text}\n`);
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
