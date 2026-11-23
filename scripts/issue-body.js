#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const os = require("node:os");
const path = require("node:path");
const { configDir } = require("./lib/config-dir.js");
const { readJobDir } = require("./lib/job-paths.js");

const { parse, exitWith, CliExit } = require("./lib/cli-args");
const { gh: ghRun, ghDefaultRepo } = require("./lib/gh");
const { gateRuleHandover, isNewlyGated } = require("./lib/issue-gate");
const { readGateWrite } = require("./lib/gate-judge.js");
const { recordOwnAct } = require("./lib/own-acts.js");
const { readRuleText } = require("./lib/rule-text");
const { sleepSync } = require("./lib/sleep-sync");
const { caught, ignoreFailure } = require("./lib/caught.js");
const { CHILD_ERROR_CHARS } = require("./lib/child-buffer.js");
const { pidAlive } = require("./lib/arbiter-proc.js");
const { addedCheckVerdict } = require("./lib/gate-check.js");

/**
 * @typedef {{command?: string, issue?: string, repo?: string, file?: string,
 *   text?: string, heading?: string, match?: string, attempts?: string,
 *   dryRun?: boolean} & Record<string, any>} Opts
 * @typedef {Opts & {issue: string}} IssueOpts
 * @typedef {(body: string) => string} Transform
 */

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
// guess: one write plus three repairs, lucmoseley/mantahostels#128
const DEFAULT_ATTEMPTS = 4;
const LOCK_WAIT_MS = numEnv("WFC_ISSUE_LOCK_WAIT_MS", 15_000);
const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 25;

class CallerError extends Error {}

/** @param {string} body */
const normalise = (body) => body.replace(/\r\n/g, "\n").trimEnd();

/**
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
 * @param {string} heading
 * @param {string} text
 * @returns {Transform}
 */
const appendSection = (heading, text) => {
	const incoming = normalise(text)
		.split("\n")
		.map((l) => l.trimEnd())
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
		let at = section.findLastIndex((l) => l.trim() !== "") + 1;
		for (const line of incoming) {
			if (section.some((l) => l.trim() === line.trim())) continue;
			section.splice(at++, 0, line);
		}
		return `${[...lines.slice(0, start + 1), ...section, ...lines.slice(end)].join("\n")}\n`;
	};
};

/**
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

/**
 * @param {string} child
 * @returns {RegExp}
 */
const childKey = (child) => new RegExp(`^[-*]\\s+#${child}(?!\\d)`);

// #1381
/** @type {WeakSet<Error>} */
const missingSection = new WeakSet();

/**
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
		if (existing.some((l) => key.test(l))) return body;
		return insert(body);
	};
};

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
			.trimEnd()}\n`;
};

/**
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
			return l.includes(tail) ? l : `${l.trimEnd()} ${tail}`;
		});
		if (!hit) throw new CallerError(`no line contains: ${match}`);
		return `${out.join("\n")}\n`;
	};
};

/**
 * @param {string[]} args
 * @returns {string}
 */
function gh(args) {
	try {
		return ghRun(args, { timeout: GH_TIMEOUT_MS });
	} catch (e) {
		const err = caught(e);
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
			`gh returned no JSON for issue ${issue}: ${out.slice(0, CHILD_ERROR_CHARS)}`,
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

/**
 * @param {number|string} issue
 * @param {string} suffix
 * @param {string} body
 * @returns {string}
 */
function rescueTo(issue, suffix, body) {
	const jobDir = readJobDir(process.env);
	const dir = jobDir ? path.join(jobDir, "tmp") : os.tmpdir();
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `issue-${issue}-${suffix}.md`);
	fs.writeFileSync(file, body);
	return file;
}

/**
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

/**
 * @param {string} file
 * @param {number} ms
 */
function olderThan(file, ms) {
	try {
		return Date.now() - fs.statSync(file).mtimeMs > ms;
	} catch {
		return true;
	}
}

// lucmoseley/mantahostels#139
/** @param {string} file */
function createLock(file) {
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
	fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }));
	try {
		fs.linkSync(tmp, file);
	} finally {
		ignoreFailure(() => fs.rmSync(tmp, { force: true }));
	}
}

/**
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
		// lucmoseley/mantahostels#139
		const { removed, undeletable } = isLockStale(file, holder)
			? removeStaleLock(file)
			: { removed: false, undeletable: undefined };
		if (removed) continue;
		if (Date.now() >= deadline) {
			giveUpLock({ file, holder, undeletable, waitMs });
			return false;
		}
		sleepSync(LOCK_POLL_MS);
	}
}

/**
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
 * @typedef {{pid: number, at: number}} LockHolder
 */

/**
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
		: !pidAlive(holder.pid) || Date.now() - holder.at > LOCK_STALE_MS;
}

/**
 * @param {string} file
 * @returns {{removed: boolean, undeletable: string | undefined}}
 */
function removeStaleLock(file) {
	try {
		fs.rmSync(file, { force: true });
		return { removed: true, undeletable: undefined };
	} catch (e) {
		const { code, message } = caught(e);
		// #586
		return { removed: false, undeletable: code || message };
	}
}

/**
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
	writeFd(2, `issue-body: lock ${file} ${why}; writing without it\n`);
}

/** @param {string} file */
function releaseLock(file) {
	ignoreFailure(() => {
		const held = JSON.parse(fs.readFileSync(file, "utf8"));
		if (held.pid === process.pid) fs.rmSync(file, { force: true });
	});
}

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

/** @param {number|string} issue */
function refuseNonIssueNumber(issue) {
	if (!/^\d+$/.test(String(issue)))
		throw new CallerError(`not an issue number: ${issue}`);
}

/**
 * @param {object} o
 * @param {number|string} o.issue
 * @param {(body: string) => string} o.transform
 * @param {string} [o.repo]
 * @param {number} [o.attempts]
 * @param {boolean} [o.dryRun]
 * @returns {{changed: boolean, attempts: number, body: string, before: string,
 *   base: string}}
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
	refuseNonIssueNumber(issue);
	if (!Number.isInteger(attempts) || attempts < 1)
		throw new CallerError(
			`attempts must be a positive whole number: ${attempts}`,
		);

	const run = () => {
		const before = fetchBody(issue, repo);
		let current = before;

		const once = transform(current);
		const twice = transform(once);
		if (once !== twice)
			throw new CallerError(
				"transform is not idempotent — applying it twice differs from once, " +
					"so it cannot be re-applied onto a concurrent write. See the contract " +
					"at the top of scripts/issue-body.js.",
			);

		if (once === current)
			return {
				changed: false,
				attempts: 0,
				body: current,
				before,
				base: before,
			};
		if (dryRun)
			return { changed: true, attempts: 0, body: once, before, base: before };

		let desired = once;
		let base = before;
		for (let n = 1; n <= attempts; n++) {
			writeBody(issue, repo, desired);
			current = fetchBody(issue, repo);
			const reapplied = transform(current);
			if (reapplied === current)
				return { changed: true, attempts: n, body: current, before, base };
			desired = reapplied;
			base = current;
		}

		const rescue = rescueTo(issue, "unwritten", desired);
		throw new Error(
			`gave up after ${attempts} writes to issue ${issue}: another writer kept ` +
				`overwriting it. The body this would have written is at ${rescue} — ` +
				"re-run once the other session is done, or apply it by hand.",
		);
	};

	return dryRun ? run() : withLock(issue, repo, run);
}

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
 * @param {number|string} issue
 * @param {string|undefined} repo
 * @param {string} next
 * @param {boolean} [dryRun]
 * @returns {number}
 */
function replaceWhole(issue, repo, next, dryRun = false) {
	const run = () => {
		const before = fetchBody(issue, repo);
		refuseGateFaults(before, next, repo, issue);
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
		recordNewGate(issue, repo, before, after);
		writeFd(1, `issue ${issue}: body replaced\n`);
		return 0;
	};
	return dryRun ? run() : withLock(issue, repo, run);
}

let gateRuleHanded = false;

/** @type {Map<string, ReturnType<typeof readGateWrite>>} */
const readings = new Map();
/** @type {Set<string>} */
const advicePrinted = new Set();

/**
 * @param {string} before
 * @param {string} after
 * @param {number} own
 */
function readGateWriteOnce(before, after, own) {
	const key = JSON.stringify([before, after]);
	const known = readings.get(key);
	if (known) return known;
	const read = readGateWrite(after, { route: "issue-body", own, before });
	readings.set(key, read);
	return read;
}

/**
 * @param {string} before
 * @param {string} after
 * @param {string|undefined} repo
 * @param {number|string} issue
 */
function refuseGateFaults(before, after, repo, issue) {
	const handover = gateRuleHanded
		? null
		: gateRuleHandover(before, after, () => readRuleText("roadmap-gating"));
	if (handover) {
		gateRuleHanded = true;
		writeFd(2, handover);
	}
	refuseNonIssueNumber(issue);
	const { refusal, advice } = readGateWriteOnce(before, after, Number(issue));
	if (refusal)
		throw new CallerError(`Nothing written: this edit adds ${refusal}`);
	if (advice && !advicePrinted.has(advice)) {
		advicePrinted.add(advice);
		writeFd(2, `${advice}\n`);
	}
	const checks = addedCheckVerdict(before, after, { run: true, repo });
	for (const w of checks.warnings) writeFd(2, `${w}\n`);
	if (checks.refusals.length > 0)
		throw new CallerError(`Nothing written: ${checks.refusals.join(" ")}`);
}

/**
 * @param {number|string} issue
 * @param {string|undefined} repo
 * @param {string} before
 * @param {string} after
 */
function recordNewGate(issue, repo, before, after) {
	if (!process.env.CLAUDE_CODE_SESSION_ID || !isNewlyGated(before, after))
		return;
	let named = repo;
	try {
		named ??= ghDefaultRepo({ timeout: GH_TIMEOUT_MS });
	} catch (e) {
		// #2308
		writeFd(
			2,
			`issue ${issue}: gated, but no gate act was recorded — the repo would not resolve (${caught(e).message}).\n`,
		);
		return;
	}
	recordOwnAct("gate", named, issue);
}

/**
 * @param {Transform} transform
 * @param {string|undefined} repo
 * @param {number|string} issue
 * @returns {Transform}
 */
const basisChecked = (transform, repo, issue) => (body) => {
	const next = transform(body);
	refuseGateFaults(body, next, repo, issue);
	return next;
};

/**
 * @param {IssueOpts} o
 * @param {string|undefined} repo
 * @param {Transform} transform
 */
function runEdit(o, repo, transform) {
	const r = editIssueBody({
		issue: o.issue,
		transform: basisChecked(transform, repo, o.issue),
		repo,
		attempts: o.attempts === undefined ? DEFAULT_ATTEMPTS : Number(o.attempts),
		dryRun: Boolean(o.dryRun),
	});
	if (o.dryRun) {
		writeFd(1, r.body);
		return null;
	}
	if (r.changed) recordNewGate(o.issue, repo, r.base, r.body);
	return r;
}

/**
 * @param {number|string} issue
 * @param {number} attempts
 */
const verified = (issue, attempts) =>
	`issue ${issue}: written and verified (${attempts} write${attempts === 1 ? "" : "s"})\n`;

/**
 * #531
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
		// lucmoseley/mantahostels#1579
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
