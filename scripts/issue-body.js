#!/usr/bin/env node
/*
 * issue-body.js — the only safe way to change a GitHub issue's body (mantahostels#131,
 * building what mantahostels#128 ruled).
 *
 * The hazard. Changing body text means download-whole, edit, upload-whole.
 * Two sessions doing that at once means the second silently erases the first.
 * mantahostels#128 established live against this repo that GitHub offers
 * nothing to lean on — PATCH /repos/{o}/{r}/issues/{n} rejects every
 * conditional-request header with HTTP 400 (not 412, so it cannot even serve as
 * a probe), GraphQL updateIssue has no version field, and updated_at is
 * unusable as a detector on three counts: one-second resolution (which is the
 * race window itself), it bumps on comments and labels, and a no-op write does
 * not move it.
 *
 * THE CONTRACT: a transform is one pure, IDEMPOTENT function of the body.
 *
 * Idempotence collapses three separate things into one operation:
 *
 *   verify      apply(current) === current   ("my change is already present")
 *   repair      apply(current)               (re-apply onto THEIR body)
 *   no-op check apply(current) === current   (nothing to write at all)
 *
 * A transform that is not idempotent is a caller bug: apply(apply(b)) is
 * compared against apply(b) before the first write, and a mismatch aborts
 * having written nothing.
 *
 * The loop. Fetch, apply, write, re-fetch. If the re-fetch does not satisfy the
 * transform, someone wrote over us in the window — re-apply onto THEIR body,
 * never re-upload our stale one, and both changes survive.
 *
 * The residual window. The loser of a race only repairs if its
 * re-fetch lands AFTER the winner's write. Where it lands before, the loser
 * sees its own change present, exits happy, and the winner's later write
 * destroys it with nobody left to notice. The retry loop cannot close that; a
 * local lock can, for the threat model that actually exists here — parallel
 * sessions on one machine — so writers serialise through one (see acquire()).
 * The loop remains the backstop for what the lock cannot cover: the founder's
 * own terminal, another machine, CI. Where both fail, mantahostels#128's other finding is
 * the recovery route — GraphQL Issue.userContentEdits holds every past body in
 * full, so a clobbered body is recoverable, not lost.
 *
 * GitHub is called from Node, by execFile, NOT through the Bash tool:
 * mantahostels#132's PreToolUse guard denies a raw `gh issue edit --body`,
 * and a hook only sees Bash *tool* calls, so this permitted path never trips
 * its own guard and needs no WFC_ALLOW_* escape. Auth is gh's own credential
 * store — there is no GH_TOKEN in a hook environment, which is why this shells
 * to gh rather than speaking HTTP.
 *
 * This script FAILS LOUD. The guards in this repo fail open because a broken
 * guard must not block work; a broken writer must not silently drop a decision.
 *
 * Two things the recovery route does not do (mantahostels#1579): `userContentEdits` is
 * not returned in edit order, so a caller must sort by `editedAt` before
 * taking the latest node rather than trusting `last:1`. And `scripts/check-
 * clobbered-bodies.js`'s daily reading keys off a stale base, not a shrink, so
 * it misses an emptied body.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const os = require("node:os");
const path = require("node:path");
const { configDir } = require("./lib/config-dir.js");

const { parse, exitWith, CliExit } = require("./lib/cli-args");
const { gh: ghRun } = require("./lib/gh");
const {
	introducedBasisFaults,
	basisRefusal,
	gateRuleHandover,
} = require("./lib/issue-gate");
const { readRuleText } = require("./lib/rule-text");
const { sleepSync } = require("./lib/sleep-sync");
const { caught } = require("./lib/caught.js");

/**
 * The parsed command line. `command` and `issue` are positional; every other
 * `--flag value` is stored under its own camelCased name, which is why this
 * carries an index signature (see `parseArgs`).
 *
 * @typedef {{command?: string, issue?: string, repo?: string, file?: string,
 *   text?: string, heading?: string, match?: string, attempts?: string,
 *   dryRun?: boolean} & Record<string, any>} Opts
 * @typedef {Opts & {issue: string}} IssueOpts  once main has checked it
 * @typedef {(body: string) => string} Transform
 */

/** `|| fallback` would swallow a deliberate 0 — and 0 is the meaningful case here. */
/**
 * @param {string} name
 * @param {number} fallback
 */
const numEnv = (name, fallback) => {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
};

const GH_TIMEOUT_MS = numEnv("WFC_ISSUE_GH_TIMEOUT_MS", 20_000);
/** One write plus three repairs. */
const DEFAULT_ATTEMPTS = 4;
const LOCK_WAIT_MS = numEnv("WFC_ISSUE_LOCK_WAIT_MS", 15_000);
const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 25;

/**
 * Thrown for a caller's mistake — usage, a bad transform, a missing heading.
 * append-decision's missing heading is a missing-section error instead: the
 * map needs fixing, not the call.
 */
class CallerError extends Error {}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * CRLF folded to LF and ALL trailing whitespace stripped, so a transform cannot
 * depend on how a body happened to end. A body with trailing blank lines is
 * therefore rewritten once, then converges.
 */
/** @param {string} body */
const normalise = (body) => body.replace(/\r\n/g, "\n").replace(/\s*$/, "");

/**
 * Append a block at the end of the body, once. Idempotent because the block is
 * added only when absent.
 *
 * @param {string} text
 * @returns {Transform}
 */
const append = (text) => {
	const block = normalise(text);
	if (block === "") throw new CallerError("nothing to append");
	return (body) => {
		const base = normalise(body);
		if (base.includes(block)) return `${base}\n`;
		return base === "" ? `${block}\n` : `${base}\n\n${block}\n`;
	};
};

/**
 * Append each non-blank line of `text` at the end of one `## ` section, in
 * order, each once, in one write (#1019). A map's Decisions so far line goes
 * through appendDecision instead, which keys on the child. Scoped to the
 * section so an identical line under a different heading is not mistaken for
 * one of these.
 *
 * Residual: presence ignores indentation, so `  - x` is skipped under a
 * section already holding `- x`, and a line repeated in `text` lands once.
 *
 * @param {string} heading
 * @param {string} text
 * @returns {Transform}
 */
const appendSection = (heading, text) => {
	const incoming = normalise(text)
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.filter((l) => l.trim() !== "");
	if (incoming.length === 0) throw new CallerError("nothing to append");
	if (incoming.some((l) => /^##\s/.test(l)))
		throw new CallerError(
			"append-section appends under an existing heading; for a new '## ' section use append --file",
		);
	return (body) => {
		const lines = normalise(body).split("\n");
		const found = findSection(lines, heading);
		if (!found)
			throw new CallerError(`no '## ${heading}' section in this body`);
		const { start, end } = found;
		const section = lines.slice(start + 1, end);
		// Insert after the section's last non-blank line, so a blank separator
		// before the next heading survives and entries stay contiguous.
		let at = section.findLastIndex((l) => l.trim() !== "") + 1;
		for (const line of incoming) {
			if (section.some((l) => l.trim() === line.trim())) continue;
			section.splice(at++, 0, line);
		}
		return `${[...lines.slice(0, start + 1), ...section, ...lines.slice(end)].join("\n")}\n`;
	};
};

/**
 * The `## <heading>` section's bounds: `start` is the heading line, `end` the
 * next `## ` heading or the end of the body. Null where there is none.
 *
 * @param {string[]} lines
 * @param {string} heading
 * @returns {{start: number, end: number} | null}
 */
function findSection(lines, heading) {
	const wanted = heading.trim().toLowerCase();
	const start = lines.findIndex(
		(l) =>
			/^##\s+/.test(l) &&
			l
				.replace(/^##\s+/, "")
				.trim()
				.toLowerCase() === wanted,
	);
	if (start === -1) return null;
	const next = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
	return { start, end: next === -1 ? lines.length : next };
}

const DECISIONS = "Decisions so far";

/**
 * The non-blank lines of a body's Decisions so far section, trimmed; null
 * where the section is missing.
 *
 * @param {string} body
 * @returns {string[] | null}
 */
function parseDecisionLines(body) {
	const lines = normalise(body).split("\n");
	const found = findSection(lines, DECISIONS);
	if (!found) return null;
	return lines
		.slice(found.start + 1, found.end)
		.map((l) => l.trim())
		.filter(Boolean);
}

/** A section line keyed to `child`: `- #<child>` not followed by another digit. */
/**
 * @param {string} child
 * @returns {RegExp}
 */
const childKey = (child) => new RegExp(`^[-*]\\s+#${child}(?!\\d)`);

/* Errors appendDecision throws for a map with no Decisions section, kept in a
 * set rather than a second class: Biome allows one a file (#1381). */
/** @type {WeakSet<Error>} */
const missingSection = new WeakSet();

/**
 * Append `- #<child> — <gist>` to Decisions so far, keyed by the child: a line
 * already there for `#<child>`, whatever its gist, is left as it is (#531).
 * A missing section throws a missing-section error rather than inventing one.
 *
 * @param {string} child
 * @param {string} gist
 * @returns {Transform}
 */
const appendDecision = (child, gist) => {
	if (!/^\d+$/.test(child))
		throw new CallerError(`--child must be an issue number: ${child}`);
	const text = gist.trim();
	if (text === "") throw new CallerError("append-decision needs a --gist");
	if (text.includes("\n"))
		throw new CallerError("append-decision takes a single-line --gist");
	const key = childKey(child);
	const insert = appendSection(DECISIONS, `- #${child} — ${text}`);
	return (body) => {
		const existing = parseDecisionLines(body);
		if (!existing) {
			const error = new Error(`no '## ${DECISIONS}' section`);
			missingSection.add(error);
			throw error;
		}
		// The body untouched, not normalised: a skip must compare equal to the
		// body as fetched, or a missing trailing newline is written as a change.
		if (existing.some((l) => key.test(l))) return body;
		return insert(body);
	};
};

/** Drop every line containing a literal substring. Idempotent: nothing is left to drop. */
/**
 * @param {string} match
 * @returns {Transform}
 */
const deleteLines = (match) => {
	if (match === "") throw new CallerError("delete-lines needs a match");
	return (body) =>
		`${normalise(body)
			.split("\n")
			.filter((l) => !l.includes(match))
			.join("\n")
			.replace(/\s*$/, "")}\n`;
};

/**
 * Tick `- [ ]` on lines containing a literal substring — the acceptance-criteria
 * close step. Idempotent: an already-ticked box is left alone.
 *
 * @param {string} match
 * @returns {Transform}
 */
const tick = (match) => {
	if (match === "") throw new CallerError("tick needs a match");
	return (body) => {
		const lines = normalise(body).split("\n");
		let hit = false;
		const out = lines.map((l) => {
			if (!l.includes(match)) return l;
			if (/^(\s*[-*]\s*)\[[ ]\]/.test(l)) {
				hit = true;
				return l.replace(/^(\s*[-*]\s*)\[[ ]\]/, "$1[x]");
			}
			if (/^(\s*[-*]\s*)\[[xX]\]/.test(l)) hit = true;
			return l;
		});
		if (!hit) throw new CallerError(`no checkbox line contains: ${match}`);
		return `${out.join("\n")}\n`;
	};
};

/**
 * Append a suffix to every line containing a literal substring, once — the
 * `**waived:** <why>` case on an acceptance criterion. Idempotent: a line that
 * already carries the suffix is left alone.
 *
 * @param {string} match
 * @param {string} suffix
 * @returns {Transform}
 */
const annotate = (match, suffix) => {
	if (match === "") throw new CallerError("annotate needs a match");
	const tail = suffix.trim();
	if (tail === "") throw new CallerError("annotate needs text");
	return (body) => {
		const lines = normalise(body).split("\n");
		let hit = false;
		const out = lines.map((l) => {
			if (!l.includes(match)) return l;
			hit = true;
			return l.includes(tail) ? l : `${l.replace(/\s+$/, "")} ${tail}`;
		});
		if (!hit) throw new CallerError(`no line contains: ${match}`);
		return `${out.join("\n")}\n`;
	};
};

// ---------------------------------------------------------------------------
// GitHub, from Node
// ---------------------------------------------------------------------------

/**
 * @param {string[]} args
 * @returns {string}
 */
function gh(args) {
	try {
		return ghRun(args, { timeout: GH_TIMEOUT_MS });
	} catch (e) {
		const err = caught(e);
		// Full stderr, not the last line: recovery here leans on the whole message.
		const detail = (err.stderr || err.message).trim();
		throw new Error(`gh ${args.join(" ")} failed: ${detail}`, { cause: e });
	}
}

/** @param {string|undefined} repo */
const repoArgs = (repo) => (repo ? ["--repo", repo] : []);

/**
 * @param {number|string} issue
 * @param {string|undefined} repo
 * @returns {string}
 */
function fetchBody(issue, repo) {
	const out = gh([
		"issue",
		"view",
		String(issue),
		...repoArgs(repo),
		"--json",
		"body",
	]);
	let parsed;
	try {
		parsed = JSON.parse(out);
	} catch (e) {
		throw new Error(
			`gh returned no JSON for issue ${issue}: ${out.slice(0, 200)}`,
			{ cause: e },
		);
	}
	if (typeof parsed.body !== "string")
		throw new Error(`issue ${issue} returned no body field`);
	return parsed.body.replace(/\r\n/g, "\n");
}

/**
 * @param {number|string} issue
 * @param {string|undefined} repo
 * @param {string} body
 */
function writeBody(issue, repo, body) {
	const tmp = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "issue-body-")),
		"body.md",
	);
	fs.writeFileSync(tmp, body);
	try {
		gh(["issue", "edit", String(issue), ...repoArgs(repo), "--body-file", tmp]);
	} finally {
		fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
	}
}

/** Park a body this process could not land, and return where it went. */
/**
 * @param {number|string} issue
 * @param {string} suffix
 * @param {string} body
 * @returns {string}
 */
function rescueTo(issue, suffix, body) {
	const dir = process.env.CLAUDE_JOB_DIR
		? path.join(process.env.CLAUDE_JOB_DIR, "tmp")
		: os.tmpdir();
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `issue-${issue}-${suffix}.md`);
	fs.writeFileSync(file, body);
	return file;
}

// ---------------------------------------------------------------------------
// The local write lock
// ---------------------------------------------------------------------------

/**
 * Machine-global, keyed on the GitHub issue rather than the working tree: a
 * worktree is a different tree but the same issue, so a tree-keyed lock would
 * let a worktree session race the shared tree.
 *
 * @param {number|string} issue
 * @param {string|undefined} repo
 * @returns {string}
 */
function lockPath(issue, repo) {
	const dir = path.join(configDir(), "issue-locks");
	fs.mkdirSync(dir, { recursive: true });
	const key = (repo || process.env.WFC_ISSUE_REPO || "default").replace(
		/[^a-zA-Z0-9]/g,
		"-",
	);
	return path.join(dir, `${key}-${issue}.lock`);
}

/** @param {number} pid */
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** True when `file` has not been touched for `ms`, or cannot be stat'd. */
/**
 * @param {string} file
 * @param {number} ms
 */
function olderThan(file, ms) {
	try {
		return Date.now() - fs.statSync(file).mtimeMs > ms;
	} catch {
		return true; // gone: whoever holds it is past caring
	}
}

/**
 * Create the lock so that it never exists without its holder's identity in it.
 *
 * `writeFileSync(..., {flag:"wx"})` cannot do this: it creates the file, then
 * writes, and a competitor reading between the two sees an empty lock. Linking a
 * fully-written temp file into place is one atomic step, and fails EEXIST when
 * the lock is already held.
 */
/** @param {string} file */
function createLock(file) {
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
	fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }));
	try {
		fs.linkSync(tmp, file);
	} finally {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* best effort: the lock itself is placed either way */
		}
	}
}

/**
 * Take the lock, or give up and proceed without it (mantahostels#131). It NEVER
 * blocks indefinitely: a lock that can wedge a session is worse than the race it
 * prevents. Proceeding unlocked is safe — it is exactly the fetch/verify/
 * re-apply behaviour the lock is an optimisation over. Every give-up prints
 * one stderr line naming the lock and why (#595).
 *
 * @param {string} file
 * @param {number} waitMs
 * @returns {boolean}
 */
function acquire(file, waitMs) {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const created = tryCreateLock(file);
		if (created !== null) return created;
		const holder = readLockHolder(file);
		// An unparseable lock names no holder, so nothing proves it dead — age it
		// out by the file's own mtime instead of stealing it at once (mantahostels#139).
		const { removed, undeletable } = isLockStale(file, holder)
			? removeStaleLock(file)
			: { removed: false, undeletable: undefined };
		if (removed) continue;
		if (Date.now() >= deadline) {
			giveUpLock({ file, holder, undeletable, waitMs });
			return false;
		}
		// Busy-wait: the hold is one gh round-trip, so a sleep granularity coarser
		// than this costs more than it saves.
		sleepSync(LOCK_POLL_MS);
	}
}

/**
 * One attempt to create the lock: true when taken, false when it cannot be
 * created at all (warned), null when another holder has it.
 * @param {string} file
 * @returns {boolean | null}
 */
function tryCreateLock(file) {
	try {
		createLock(file);
		return true;
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "EEXIST") {
			warnWritingUnlocked(file, `cannot be created (${code || message})`);
			return false;
		}
	}
	return null;
}

/**
 * A lock's named holder, as `createLock` writes it. Only `pid` is checked on
 * the way in; `at` is read as written, so a missing one never ages it out.
 * @typedef {{pid: number, at: number}} LockHolder
 */

/**
 * The lock's named holder, or null where it cannot be read or parsed or
 * names no pid.
 * @param {string} file
 * @returns {LockHolder | null}
 */
function readLockHolder(file) {
	let held;
	try {
		held = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
	return held && typeof held.pid === "number" ? held : null;
}

/**
 * @param {string} file
 * @param {LockHolder | null} holder
 * @returns {boolean}
 */
function isLockStale(file, holder) {
	return holder === null
		? olderThan(file, LOCK_STALE_MS)
		: !alive(holder.pid) || Date.now() - holder.at > LOCK_STALE_MS;
}

/**
 * Removes a stale lock; where it cannot be removed, names why.
 * @param {string} file
 * @returns {{removed: boolean, undeletable: string | undefined}}
 */
function removeStaleLock(file) {
	try {
		fs.rmSync(file, { force: true });
		return { removed: true, undeletable: undefined };
	} catch (e) {
		const { code, message } = caught(e);
		// EPERM or EACCES: retrying at once looped for ever, so the deadline
		// decides, and the fail-open is printed (#586).
		return { removed: false, undeletable: code || message };
	}
}

/**
 * Prints the give-up line once the deadline has passed.
 * @param {{file: string, holder: LockHolder | null, undeletable: string | undefined, waitMs: number}} a
 */
function giveUpLock({ file, holder, undeletable, waitMs }) {
	const who = holder ? `pid ${holder.pid}` : "an unnamed holder";
	warnWritingUnlocked(
		file,
		undeletable
			? `is stale and cannot be removed (${undeletable})`
			: `is still held by ${who} after ${waitMs}ms`,
	);
}

/**
 * @param {string} file
 * @param {string} why
 */
function warnWritingUnlocked(file, why) {
	process.stderr.write(`issue-body: lock ${file} ${why}; writing without it\n`);
}

/** @param {string} file */
function releaseLock(file) {
	try {
		const held = JSON.parse(fs.readFileSync(file, "utf8"));
		if (held.pid === process.pid) fs.rmSync(file, { force: true });
	} catch {
		/* already gone, or never ours */
	}
}

/** Run `fn` holding the issue's lock where it can be had, without it where not. */
/**
 * @template T
 * @param {number|string} issue
 * @param {string|undefined} repo
 * @param {() => T} fn
 * @returns {T}
 */
function withLock(issue, repo, fn) {
	const file = lockPath(issue, repo);
	const held = acquire(file, LOCK_WAIT_MS);
	try {
		return fn();
	} finally {
		if (held) releaseLock(file);
	}
}

// ---------------------------------------------------------------------------
// The safe edit
// ---------------------------------------------------------------------------

/**
 * Apply `transform` to issue `issue`'s body, safely under concurrency.
 *
 * @param {object} o
 * @param {number|string} o.issue    issue number
 * @param {(body: string) => string} o.transform  pure and IDEMPOTENT
 * @param {string} [o.repo]          owner/name; omitted lets gh resolve from cwd
 * @param {number} [o.attempts]      total writes before giving up
 * @param {boolean} [o.dryRun]       compute and return, never write
 * @returns {{changed: boolean, attempts: number, body: string, before: string}}
 *   `before` is the body as first read, ahead of any write
 */
function editIssueBody({
	issue,
	transform,
	repo,
	attempts = DEFAULT_ATTEMPTS,
	dryRun = false,
}) {
	if (typeof transform !== "function")
		throw new CallerError("transform must be a function");
	if (!/^\d+$/.test(String(issue)))
		throw new CallerError(`not an issue number: ${issue}`);
	// Unvalidated, `--attempts abc` is NaN, skips the loop, and reports "gave up
	// after NaN writes".
	if (!Number.isInteger(attempts) || attempts < 1)
		throw new CallerError(
			`attempts must be a positive whole number: ${attempts}`,
		);

	const run = () => {
		const before = fetchBody(issue, repo);
		let current = before;

		// The caller-bug check, before anything is written.
		const once = transform(current);
		const twice = transform(once);
		if (once !== twice)
			throw new CallerError(
				"transform is not idempotent — applying it twice differs from once, " +
					"so it cannot be re-applied onto a concurrent write. See the contract " +
					"at the top of scripts/issue-body.js.",
			);

		if (once === current)
			return { changed: false, attempts: 0, body: current, before };
		if (dryRun) return { changed: true, attempts: 0, body: once, before };

		let desired = once;
		for (let n = 1; n <= attempts; n++) {
			writeBody(issue, repo, desired);
			current = fetchBody(issue, repo);
			// Verify and repair are the same question: if re-applying changes
			// nothing, the change is present.
			const reapplied = transform(current);
			if (reapplied === current)
				return { changed: true, attempts: n, body: current, before };
			desired = reapplied;
		}

		const rescue = rescueTo(issue, "unwritten", desired);
		throw new Error(
			`gave up after ${attempts} writes to issue ${issue}: another writer kept ` +
				`overwriting it. The body this would have written is at ${rescue} — ` +
				"re-run once the other session is done, or apply it by hand.",
		);
	};

	// A dry run writes nothing, so it has no reason to hold anyone else up.
	return dryRun ? run() : withLock(issue, repo, run);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const OPTIONS = "options: --repo <owner/name>  --attempts <n>  --dry-run";

const USAGE = `usage: issue-body.js <command> <issue> [options]

  show           <issue>
  append         <issue> (--text <s> | --file <f>)
  append-section <issue> --heading <h> (--text <s> | --file <f>)
                                            each non-blank line under ## <h>,
                                            in order, skipping one already
                                            there, in one write
  append-decision <issue> --child <n> --gist <s>
                                            '- #<n> — <gist>' into Decisions
                                            so far; skips where #<n> has a
                                            line, exits 1 where a line read
                                            before the write is gone after it
  delete-lines   <issue> --match <s>
  tick           <issue> --match <s>
  annotate       <issue> --match <s> (--text <s> | --file <f>)
  replace        <issue> --file <f>        whole-body; refuses a write that
                                            lands during the replace, and on
                                            an empty/blank file — a hand edit
                                            already sitting in the body is
                                            silently overwritten

${OPTIONS}

Every command but 'replace' is idempotent and converges under concurrent
writes. 'replace' cannot be — see the contract in this file's header.`;

/**
 * One command's usage, for `issue-body.js <command> --help` and its refusals.
 *
 * @param {string} line
 * @param {Record<string, import("./lib/cli-args").FlagType>} [flags]
 * @returns {import("./lib/cli-args").CommandSpec}
 */
const buildCommand = (line, flags = {}) => ({
	usage: `usage: issue-body.js ${line}\n\n${OPTIONS}`,
	flags,
	min: 1,
});

const BODY_FLAGS = /** @type {const} */ ({
	"--text": "value",
	"--file": "value",
});

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: USAGE,
	flags: { "--repo": "value", "--attempts": "value", "--dry-run": "boolean" },
	commands: {
		show: buildCommand("show <issue>"),
		append: buildCommand(
			"append <issue> (--text <s> | --file <f>)",
			BODY_FLAGS,
		),
		"append-section": buildCommand(
			"append-section <issue> --heading <h> (--text <s> | --file <f>)",
			{ "--heading": "value", ...BODY_FLAGS },
		),
		"append-decision": buildCommand(
			"append-decision <issue> --child <n> --gist <s>",
			{ "--child": "value", "--gist": "value" },
		),
		"delete-lines": buildCommand("delete-lines <issue> --match <s>", {
			"--match": "value",
		}),
		tick: buildCommand("tick <issue> --match <s>", { "--match": "value" }),
		annotate: buildCommand(
			"annotate <issue> --match <s> (--text <s> | --file <f>)",
			{
				"--match": "value",
				...BODY_FLAGS,
			},
		),
		replace: buildCommand("replace <issue> --file <f>", { "--file": "value" }),
	},
};

/**
 * Throws lib/cli-args.js's CliExit on `--help` or a bad command line, before
 * anything is fetched.
 *
 * @param {string[]} argv
 * @returns {Opts}
 */
function parseArgs(argv) {
	const { command: verb, flags, positionals } = parse(argv, CLI);
	/** @type {Opts} */
	const opts = { command: verb, issue: positionals[0] };
	for (const [flag, value] of Object.entries(flags)) {
		const key = flag
			.slice(2)
			.replace(
				/-([a-z])/g,
				(/** @type {string} */ _, /** @type {string} */ c) => c.toUpperCase(),
			);
		opts[key] = value;
	}
	return opts;
}

/**
 * @param {Opts} o
 * @returns {string}
 */
const readTextOf = (o) => {
	if (o.text !== undefined) return o.text;
	if (o.file !== undefined) return fs.readFileSync(o.file, "utf8");
	throw new CallerError("need --text or --file");
};

/**
 * @param {Opts} o
 * @returns {Transform}
 */
function buildTransform(o) {
	switch (o.command) {
		case "append":
			return append(readTextOf(o));
		case "append-section":
			if (!o.heading) throw new CallerError("append-section needs --heading");
			return appendSection(o.heading, readTextOf(o));
		case "delete-lines":
			if (o.match === undefined)
				throw new CallerError("delete-lines needs --match");
			return deleteLines(o.match);
		case "tick":
			if (o.match === undefined) throw new CallerError("tick needs --match");
			return tick(o.match);
		case "annotate":
			if (o.match === undefined)
				throw new CallerError("annotate needs --match");
			return annotate(o.match, readTextOf(o));
		default:
			throw new CallerError(`unknown command: ${o.command}`);
	}
}

/**
 * Whole-body replacement, for the one job no idempotent transform can express:
 * rewriting a body wholesale (mantahostels#133). It is NOT re-appliable, so it must not
 * retry — a retry here is the clobber. A dry run prints `next` where a real
 * run would write it, and writes nothing (#821).
 *
 * @param {number|string} issue
 * @param {string|undefined} repo
 * @param {string} next
 * @param {boolean} [dryRun]
 * @returns {number}
 */
function replaceWhole(issue, repo, next, dryRun = false) {
	const run = () => {
		const before = fetchBody(issue, repo);
		refuseBasisFaults(before, next);
		if (normalise(before) === normalise(next)) {
			writeFd(1, `issue ${issue}: already identical, nothing written\n`);
			return 0;
		}
		if (dryRun) {
			writeFd(1, next);
			return 0;
		}
		writeBody(issue, repo, next);
		const after = fetchBody(issue, repo);
		if (normalise(after) !== normalise(next)) {
			const rescue = rescueTo(issue, "overwritten", after);
			writeFd(
				2,
				`issue ${issue}: another session wrote to this body during the replace. ` +
					`Its version is at ${rescue}. A whole-body replace cannot be re-applied, ` +
					"so nothing further was written — reconcile by hand.\n",
			);
			return 1;
		}
		writeFd(1, `issue ${issue}: body replaced\n`);
		return 0;
	};
	// As editIssueBody: a dry run writes nothing, so it holds no lock.
	return dryRun ? run() : withLock(issue, repo, run);
}

/* A transform runs more than once a write — the idempotence check, a repair —
 * so the hand-over prints once a run. */
let gateRuleHanded = false;

/**
 * A gate or a prose wait the write would add with no `**Gate basis:**`, or
 * with a window its basis does not name, is refused before anything is
 * written (#672, #823) — after `rule:roadmap-gating` is handed over where the
 * write adds a gate line. The command line only: a script calling
 * editIssueBody writes machine text, and is left alone.
 *
 * @param {string} before
 * @param {string} after
 */
function refuseBasisFaults(before, after) {
	const handover = gateRuleHanded
		? null
		: gateRuleHandover(before, after, () => readRuleText("roadmap-gating"));
	if (handover) {
		gateRuleHanded = true;
		writeFd(2, handover);
	}
	const added = introducedBasisFaults(before, after);
	if (added.length === 0) return;
	throw new CallerError(
		`Nothing written: this edit adds ${basisRefusal(added, after)}`,
	);
}

/**
 * Checked against the transform's own input, so a re-application onto a
 * neighbour's body judges what this edit adds to THAT body.
 *
 * @param {Transform} transform
 * @returns {Transform}
 */
const basisChecked = (transform) => (body) => {
	const next = transform(body);
	refuseBasisFaults(body, next);
	return next;
};

/**
 * One idempotent edit as the command line asks for it. A dry run prints the
 * body it would write and returns null.
 *
 * @param {IssueOpts} o
 * @param {string|undefined} repo
 * @param {Transform} transform
 */
function runEdit(o, repo, transform) {
	const r = editIssueBody({
		issue: o.issue,
		transform: basisChecked(transform),
		repo,
		attempts: o.attempts === undefined ? DEFAULT_ATTEMPTS : Number(o.attempts),
		dryRun: Boolean(o.dryRun),
	});
	if (!o.dryRun) return r;
	writeFd(1, r.body);
	return null;
}

/**
 * @param {number|string} issue
 * @param {number} attempts
 */
const verified = (issue, attempts) =>
	`issue ${issue}: written and verified (${attempts} write${attempts === 1 ? "" : "s"})\n`;

/**
 * The keyed map append, plus the survival check the loop alone cannot give:
 * a rival writing from a stale base can drop a neighbour's line while the loop
 * repairs ours, and the loop only ever re-checks our own line (#531).
 *
 * @param {IssueOpts} o
 * @param {string|undefined} repo
 * @returns {number}
 */
function appendDecisionCli(o, repo) {
	if (o.child === undefined || o.gist === undefined)
		throw new CallerError("append-decision needs --child and --gist");
	const transform = appendDecision(o.child, o.gist);
	let r;
	try {
		r = runEdit(o, repo, transform);
	} catch (e) {
		if (!(e instanceof Error && missingSection.has(e))) throw e;
		writeFd(
			2,
			`issue ${o.issue}: no '## ${DECISIONS}' section — ` +
				"add the section to the map by hand, then re-run.\n",
		);
		return 1;
	}
	if (!r) return 0;
	if (!r.changed) {
		const key = childKey(o.child);
		const held = (parseDecisionLines(r.body) || []).find((l) => key.test(l));
		writeFd(
			1,
			`issue ${o.issue}: #${o.child} already has a line in ${DECISIONS}, nothing written: ${held}\n`,
		);
		return 0;
	}
	// Checked against the first read only: a line arriving after it and lost to
	// a retry goes unseen, a window the lock already closes for local writers.
	const after = new Set(parseDecisionLines(r.body) || []);
	const lost = (parseDecisionLines(r.before) || []).filter(
		(l) => !after.has(l),
	);
	if (lost.length > 0) {
		const rescue = rescueTo(o.issue, "before-append", r.before);
		writeFd(
			2,
			`issue ${o.issue}: #${o.child}'s line landed, but these ${DECISIONS} lines ` +
				"read before the write are gone after it — another writer dropped them:\n" +
				lost.map((l) => `  ${l}\n`).join("") +
				`The body as first read is at ${rescue}. Restore each with append-section, ` +
				"one per call.\n",
		);
		return 1;
	}
	writeFd(1, verified(o.issue, r.attempts));
	return 0;
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const parsed = parseArgs(argv);
	const o = /** @type {IssueOpts} */ (parsed);
	const repo = o.repo || process.env.WFC_ISSUE_REPO || undefined;

	if (o.command === "show") {
		writeFd(1, fetchBody(o.issue, repo));
		return 0;
	}
	if (o.command === "replace") {
		if (!o.file) throw new CallerError("replace needs --file");
		const next = fs.readFileSync(o.file, "utf8");
		// mantahostels#1579: divergence was the only guard, and an empty file isn't
		// divergence. No escape flag: no session has ever needed to blank a body.
		if (next.trim() === "")
			throw new CallerError(
				`replace refuses an empty or whitespace-only --file (${o.file}) — ` +
					"a whole-body replace with nothing in it is almost always a " +
					"truncated or mis-read file, not an intended edit.",
			);
		return replaceWhole(o.issue, repo, next, Boolean(o.dryRun));
	}
	if (o.command === "append-decision") return appendDecisionCli(o, repo);

	const r = runEdit(o, repo, buildTransform(o));
	if (!r) return 0;
	writeFd(
		1,
		r.changed
			? verified(o.issue, r.attempts)
			: `issue ${o.issue}: already present, nothing written\n`,
	);
	return 0;
}

if (require.main === module) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (e) {
		if (e instanceof CliExit) exitWith(e);
		writeFd(2, `${caught(e).message}\n`);
		process.exit(e instanceof CallerError ? 2 : 1);
	}
}

module.exports = { main };
