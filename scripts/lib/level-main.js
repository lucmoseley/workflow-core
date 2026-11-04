/*
 * level-main.js — the levelling step (#4238):
 * the main checkout's `main` follows `origin/main`, the lander-green tip, by a
 * fast-forward and nothing else.
 *
 * ONE PASS fetches `main`, then fast-forwards the main checkout's `main` to
 * `origin/main` where it is behind. It never merges, rebases or resets: a
 * local commit or a blocking edit is reported, never moved or discarded,
 * because under the worktree model nothing should be written here at all. A
 * failed fetch is reported, and the pass levels against the `origin/main` last
 * fetched. A main checkout not yet cut over (lib/cutover.js) is refused, never
 * moved: a session may still be writing there.
 *
 * A REFUSAL NAMES EACH BLOCKING FILE — a tracked edit, staged or not, or an
 * untracked file, at a path the fast-forward changes or at a directory above
 * or below one — with its age (mtime) and its last writer (the write ledger),
 * so a stale edit gets judged rather than waited on. The paths are read before
 * git is asked, not parsed from its refusal text.
 *
 * THE INSTALL runs where `main` is level, after any fast-forward, and the
 * lockfile blob at `HEAD` is not the one `node_modules` was built for, read
 * from a marker inside it. Keyed on the blob, not on the fast-forward's diff,
 * so a failed install is retried on the next pass; built from `HEAD`'s
 * manifests, never the working tree's, so a stray lockfile edit is never
 * installed. `npm ci --ignore-scripts`
 * (docs/practice/dependency-and-release-management.md) builds into a staging
 * directory under the git dir, which is swapped in by two renames: `npm ci`
 * into the live tree would delete it first, and hook code loads from it
 * throughout.
 *
 * ONE PASS AT A TIME, under a pidfile in the git dir: the refill loop and the
 * lander both run it (#4229), and two `npm ci` runs at once would spend the
 * memory of two. The holder sweeps the staging directory a killed pass left.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { execGit, gitCommonDirOrThrow, GIT_TIMEOUT_MS } = require("./git.js");
const { isCutOver } = require("./cutover.js");
const { pidLock } = require("./pid-lock.js");

const BRANCH = "main";
const UPSTREAM = `origin/${BRANCH}`;
const LOCKFILE = "package-lock.json";
/* What `npm ci` reads besides the lockfile; `.npmrc` only where present. */
const MANIFESTS = ["package.json", LOCKFILE, ".npmrc"];
/* Inside `node_modules`, so it is swapped in with the tree it describes. */
const MARKER = ".wfc-lockfile-blob";
const HOLDERS = ["level-main.js", "refill-loop.js", "lander.js"];
/* Untraced: room for a cold `npm ci` over a slow link. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;
/* Untraced: long enough to stay unique in a repository this size. */
const SHORT_SHA = 9;

/**
 * @typedef {(dir: string) => void} Install builds `node_modules` in `dir`,
 *   which holds the manifests; throws where it fails
 * @typedef {(rel: string) => {sessionId: string, at: number} | null} LastWriter
 * @typedef {{ path: string, ageMs: number | null, writer: {sessionId: string, at: number} | null }} Blocker
 * @typedef {{ installed: boolean, error?: string }} InstallResult
 * @typedef {(
 *   | { status: "level", head: string }
 *   | { status: "forwarded", from: string, head: string }
 *   | { status: "off-branch", branch: string | null }
 *   | { status: "shared" }
 *   | { status: "ahead", local: string[], unlanded: string[] }
 *   | { status: "blocked", from: string, to: string, blockers: Blocker[] }
 *   | { status: "refused", from: string, to: string, why: string }
 * )} Moved
 * @typedef {(
 *   | (Moved & { fetchError: string | null })
 *   | { status: "busy", holder: number | null, fetchError: null }
 * ) & { install: InstallResult }} Outcome
 */

/**
 * `npm ci` into `dir`, its output on stderr. `WFC_NPM` names the program, as
 * it does for the install guard.
 * @type {Install}
 */
function npmCi(dir) {
	const r = spawnSync(
		process.env.WFC_NPM || "npm",
		["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
		{ cwd: dir, stdio: ["ignore", 2, 2], timeout: INSTALL_TIMEOUT_MS },
	);
	if (r.error) throw r.error;
	if (r.status !== 0)
		throw new Error(`npm ci exited ${r.status ?? r.signal} in ${dir}`);
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
const git = (args, cwd) =>
	String(
		execGit(args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		}),
	);

/**
 * @param {string} out NUL-separated git output
 * @returns {string[]}
 */
const parseNulList = (out) => out.split("\0").filter(Boolean);

/**
 * Paths with a tracked edit, staged or not, or an untracked file: what the
 * fast-forward would overwrite. A rename's source counts too.
 * @param {string} root
 * @returns {Set<string>}
 */
function readEditedPaths(root) {
	const fields = git(["status", "--porcelain", "-z", "-uall"], root)
		.split("\0")
		.values();
	const paths = new Set();
	for (const entry of fields) {
		if (entry.length < 4) continue;
		paths.add(entry.slice(3));
		if (/[RC]/.test(entry.slice(0, 2))) {
			const source = fields.next().value;
			if (source) paths.add(source);
		}
	}
	return paths;
}

/**
 * Whether an edit at `edited` stands in the way of a change at `changed`: the
 * same path, or either one a directory holding the other.
 * @param {string} edited
 * @param {string[]} changed
 */
const clashes = (edited, changed) =>
	changed.some(
		(c) =>
			c === edited || c.startsWith(`${edited}/`) || edited.startsWith(`${c}/`),
	);

/**
 * @param {string} root
 * @param {string} rel
 * @param {number} now
 * @param {LastWriter} lastWriter
 * @returns {Blocker}
 */
function readBlocker(root, rel, now, lastWriter) {
	let ageMs = null;
	try {
		ageMs = Math.max(0, now - fs.lstatSync(path.join(root, rel)).mtimeMs);
	} catch (err) {
		/* A deletion is still a blocking edit; it has no age to read. */
		if (caught(err).code !== "ENOENT") throw err;
	}
	return { path: rel, ageMs, writer: lastWriter(rel) };
}

/**
 * Every edited path in `root`, sorted, each with its age and last writer.
 * @param {string} root
 * @param {number} now
 * @param {LastWriter} lastWriter
 * @returns {Blocker[]}
 */
const readDirt = (root, now, lastWriter) =>
	[...readEditedPaths(root)]
		.sort()
		.map((p) => readBlocker(root, p, now, lastWriter));

/**
 * The blob id of `name` at `HEAD`, or null where `HEAD` has none.
 * @param {string} root
 * @param {string} name
 * @returns {string | null}
 */
function readHeadBlob(root, name) {
	const out = git(["ls-tree", "-z", "HEAD", "--", name], root);
	/* `<mode> blob <id>\t<path>` */
	const id = out.split("\t")[0]?.split(" ")[2];
	return id || null;
}

/**
 * A rename, reporting rather than throwing, for a rollback that must not mask
 * the error a caller is already returning.
 * @param {string} from
 * @param {string} to
 * @returns {string | null} why it failed
 */
function tryRename(from, to) {
	try {
		fs.renameSync(from, to);
		return null;
	} catch (err) {
		return caught(err).message.trim();
	}
}

/**
 * `rm -rf`, reporting rather than throwing.
 * @param {string} dir
 * @returns {string | null} why it failed
 */
function tryRemove(dir) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
		return null;
	} catch (err) {
		return caught(err).message.trim();
	}
}

/**
 * The lockfile blob the tree at `live` was built for, or null where it carries
 * no marker.
 * @param {string} live
 * @returns {string | null}
 */
function readMarker(live) {
	try {
		return fs.readFileSync(path.join(live, MARKER), "utf8").trim();
	} catch (err) {
		/* No tree, or one no levelling pass built: either way, build. */
		if (!["ENOENT", "ENOTDIR"].includes(caught(err).code ?? "")) throw err;
		return null;
	}
}

/**
 * Install `HEAD`'s manifests into `staging`, marked as built for `want`.
 * @param {string} root
 * @param {string} staging
 * @param {string} want the lockfile blob
 * @param {Install} install
 * @returns {string} the built `node_modules`
 */
function buildStaging(root, staging, want, install) {
	fs.mkdirSync(staging, { recursive: true });
	for (const name of MANIFESTS) {
		const blob = readHeadBlob(root, name);
		if (blob === null) continue;
		const bytes = execGit(["cat-file", "blob", blob], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
		fs.writeFileSync(path.join(staging, name), bytes);
	}
	install(staging);
	const built = path.join(staging, "node_modules");
	if (!fs.existsSync(built))
		throw new Error(`the install left no node_modules in ${staging}`);
	fs.writeFileSync(path.join(built, MARKER), `${want}\n`);
	return built;
}

/**
 * Rebuild `root`'s `node_modules` from `HEAD`'s manifests where it was built
 * for another lockfile blob, or carries no marker. Never throws: a failure is
 * the result's `error`, and the next pass tries again.
 * @param {string} root
 * @param {string} work this pass's directory under the git dir
 * @param {Install} install
 * @returns {InstallResult}
 */
function installIfStale(root, work, install) {
	const live = path.join(root, "node_modules");
	const old = path.join(work, "old");
	/** @type {string[]} */
	const errors = [];
	let installed = false;
	try {
		const want = readHeadBlob(root, LOCKFILE);
		if (want === null || readMarker(live) === want) return { installed };
		const built = buildStaging(root, path.join(work, "install"), want, install);
		if (fs.existsSync(live)) fs.renameSync(live, old);
		fs.renameSync(built, live);
		installed = true;
	} catch (err) {
		errors.push(caught(err).message.trim());
		/* The swap's second rename failed: put the old tree back. */
		const back =
			!fs.existsSync(live) && fs.existsSync(old) ? tryRename(old, live) : null;
		if (back !== null) {
			errors.push(
				`and the old tree would not go back (${back}) — it is at ${old}`,
			);
			return { installed, error: errors.join("; ") };
		}
	}
	const left = tryRemove(work);
	if (left !== null) errors.push(`cleanup of ${work} failed: ${left}`);
	return errors.length > 0
		? { installed, error: errors.join("; ") }
		: { installed };
}

/**
 * Which of `local` the last-fetched `origin/landing` lacks: all of them where
 * there is none.
 * @param {string} root
 * @param {string[]} local
 * @returns {string[]}
 */
function readUnlanded(root, local) {
	try {
		git(
			["rev-parse", "--verify", "--quiet", "refs/remotes/origin/landing"],
			root,
		);
	} catch (err) {
		if (caught(err).status !== 1) throw err;
		return local;
	}
	return git(["rev-list", "--reverse", "origin/landing..HEAD"], root)
		.split("\n")
		.filter(Boolean);
}

/**
 * The fast-forward half of a pass: what `main` did, no install.
 * @param {string} root the main checkout
 * @param {number} now
 * @param {LastWriter} lastWriter
 * @returns {Moved}
 */
function forward(root, now, lastWriter) {
	let branch = null;
	try {
		branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], root).trim();
	} catch (err) {
		/* `--quiet` exits 1 on a detached HEAD alone; anything else is a fault. */
		if (caught(err).status !== 1) throw err;
	}
	if (branch !== BRANCH) return { status: "off-branch", branch };
	if (!isCutOver(root)) return { status: "shared" };
	const from = git(["rev-parse", "HEAD"], root).trim();
	const to = git(["rev-parse", UPSTREAM], root).trim();
	if (from === to) return { status: "level", head: from };
	const local = git(["rev-list", "--reverse", `${UPSTREAM}..HEAD`], root)
		.split("\n")
		.filter(Boolean);
	if (local.length > 0)
		return {
			status: "ahead",
			local,
			unlanded: readUnlanded(root, local),
		};
	const changed = parseNulList(
		git(["diff", "--name-only", "--no-renames", "-z", from, to], root),
	);
	const blockers = [...readEditedPaths(root)]
		.filter((p) => clashes(p, changed))
		.sort()
		.map((p) => readBlocker(root, p, now, lastWriter));
	if (blockers.length > 0) return { status: "blocked", from, to, blockers };
	try {
		git(["merge", "--ff-only", "--quiet", to], root);
	} catch (err) {
		return {
			status: "refused",
			from,
			to,
			why: (caught(err).stderr || caught(err).message).trim(),
		};
	}
	return { status: "forwarded", from, head: to };
}

/**
 * One levelling pass over the main checkout `root`. A pass another holds is
 * `busy`, doing nothing. A git fault outside the fetch and the fast-forward
 * throws.
 * @param {string} root the main checkout
 * @param {{ install?: Install, lastWriter?: LastWriter, now: number }} options
 * @returns {Outcome}
 */
function level(root, { install = npmCi, lastWriter = () => null, now }) {
	const common = gitCommonDirOrThrow(root, { timeout: GIT_TIMEOUT_MS });
	const lock = pidLock(path.join(common, "wfc-level.pid"), HOLDERS);
	if (!lock.acquire())
		return {
			status: "busy",
			holder: lock.holder(),
			fetchError: null,
			install: { installed: false },
		};
	try {
		const work = path.join(common, "wfc-level");
		/* Only a killed pass leaves this, and the lock says none is running. */
		fs.rmSync(work, { recursive: true, force: true });
		let fetchError = null;
		try {
			git(
				[
					"fetch",
					"--quiet",
					"origin",
					`+refs/heads/${BRANCH}:refs/remotes/${UPSTREAM}`,
				],
				root,
			);
		} catch (err) {
			fetchError = (caught(err).stderr || caught(err).message).trim();
		}
		const moved = forward(root, now, lastWriter);
		const settled = moved.status === "level" || moved.status === "forwarded";
		return {
			...moved,
			fetchError,
			install: settled
				? installIfStale(root, work, install)
				: { installed: false },
		};
	} finally {
		lock.release();
	}
}

/**
 * An age as minutes under an hour, then check-orphaned-edits.js's cut-over:
 * hours under two days, days beyond.
 * @param {number} ms
 * @returns {string}
 */
function describeAge(ms) {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The outcome as report lines, the first naming what happened to `main`, each
 * refusal with its way out.
 * @param {Outcome} o
 * @param {number} now
 * @returns {string[]}
 */
function renderOutcome(o, now) {
	const short = (/** @type {string} */ sha) => sha.slice(0, SHORT_SHA);
	const next = "then the next pass levels main";
	/** @type {string[]} */
	const lines = [];
	switch (o.status) {
		case "busy":
			lines.push(
				`skipped: another levelling pass${o.holder === null ? "" : ` (pid ${o.holder})`} holds the lock, so this one did nothing`,
			);
			break;
		case "level":
			lines.push(`main is level with ${UPSTREAM} at ${short(o.head)}`);
			break;
		case "forwarded":
			lines.push(
				`main fast-forwarded ${short(o.from)}..${short(o.head)} to ${UPSTREAM}`,
			);
			break;
		case "off-branch":
			lines.push(
				`refused: the main checkout is ${o.branch === null ? "on a detached HEAD" : `on ${o.branch}`}, not main, so main was not moved — switch it back to main, ${next}`,
			);
			break;
		case "shared":
			lines.push(
				`refused: the main checkout's main still tracks origin/landing, so it has not been cut over to the worktree model and main was not moved — run \`node scripts/cutover-main-checkout.js\`, ${next}`,
			);
			break;
		case "ahead":
			lines.push(
				o.unlanded.length === 0
					? `waiting: main carries ${o.local.length} commit(s) not yet on ${UPSTREAM}, all on origin/landing — once the lander takes them, ${next}`
					: `refused: main carries ${o.unlanded.length} commit(s) on neither ${UPSTREAM} nor origin/landing, which a fast-forward cannot keep — land them from a session worktree; once the lander takes them, ${next}:`,
				...o.unlanded.map((sha) => `  ${short(sha)}`),
			);
			break;
		case "blocked":
			lines.push(
				`refused: ${o.blockers.length} edit(s) in the main checkout sit on paths ${short(o.from)}..${short(o.to)} changes — move each to its session's own worktree or discard it, ${next}:`,
				...o.blockers.map(
					(b) =>
						`  ${b.path} — ${b.ageMs === null ? "deleted" : `${describeAge(b.ageMs)} old`}; last writer ${b.writer ? `session ${b.writer.sessionId}, ledger written ${describeAge(now - b.writer.at)} ago` : "unknown — no surviving write ledger names it"}`,
				),
			);
			break;
		case "refused":
			lines.push(
				`refused: git would not fast-forward ${short(o.from)}..${short(o.to)} — clear what git names, ${next}: ${o.why}`,
			);
			break;
	}
	if (o.fetchError !== null)
		lines.push(
			`fetching ${UPSTREAM} failed, so this pass used the last one fetched: ${o.fetchError}`,
		);
	if (o.install.installed)
		lines.push("node_modules rebuilt for the main checkout's lockfile");
	if (o.install.error)
		lines.push(
			`node_modules rebuild failed, and the next pass retries it: ${o.install.error}`,
		);
	return lines;
}

module.exports = { describeAge, level, readDirt, renderOutcome };
