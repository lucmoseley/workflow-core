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
 * moved.
 *
 * A FAST-FORWARD THAT CHANGES THE SELF-PLUGIN CANARY first re-marks every live
 * session for the target's canary (lib/canary-remark.js), and is refused where
 * that canary would still refuse one, naming each. After it, the sessions that
 * started meanwhile are re-marked, and any still refused is named.
 *
 * A REFUSAL NAMES EACH BLOCKING FILE — a tracked edit, staged or not, or an
 * untracked file, at a path the fast-forward changes or at a directory above
 * or below one — with its age (mtime) and its last writer (the write ledger).
 *
 * THE INSTALL runs where `main` is level, after any fast-forward, and the
 * lockfile blob at `HEAD` is not the one `node_modules` was built for, read
 * from a marker inside it. Keyed on the blob, not on the fast-forward's diff,
 * so a failed install is retried on the next pass; built from `HEAD`'s
 * manifests, never the working tree's, so a stray lockfile edit is never
 * installed. It builds into a staging directory under the git dir
 * (lib/npm-ci-staging.js), swapped in by two renames.
 *
 * ONE PASS AT A TIME, under a pidfile in the git dir: the refill loop and the
 * lander both run it (#4229), and two `npm ci` runs at once would spend the
 * memory of two. The holder sweeps the staging directory a killed pass left.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { remarkForCanary, remarkLatecomers } = require("./canary-remark.js");
const { caught } = require("./caught.js");
const {
	execGit,
	gitCommonDirOrThrow,
	GIT_TIMEOUT_MS,
	SHORT_SHA,
} = require("./git.js");
const { isCutOver } = require("./cutover.js");
const { LANDING_REF, QUEUE_TRACKING_GLOB } = require("./landing-refs.js");
const { pidLock } = require("./pid-lock.js");
const { buildCheckoutEnv, startDetachedIn } = require("./refill-repos.js");
const { scriptPath } = require("./script-path.js");
const { isUnder } = require("./is-under.js");
const {
	INSTALL_TIMEOUT_MS,
	LOCKFILE,
	npmCi,
	stageInstall,
} = require("./npm-ci-staging.js");

const BRANCH = "main";
const UPSTREAM = `origin/${BRANCH}`;
/* Inside `node_modules`, so it is swapped in with the tree it describes. */
const MARKER = ".wfc-lockfile-blob";
const HOLDERS = ["level-main.js", "refill-loop.js"];

/**
 * @typedef {import("./npm-ci-staging.js").Install} Install
 * @typedef {import("./canary-remark.js").ListSessions} ListSessions
 * @typedef {import("./canary-remark.js").Stranding} Stranding
 * @typedef {(rel: string) => {sessionId: string, at: number} | null} LastWriter
 * @typedef {{ path: string, ageMs: number | null, writer: {sessionId: string, at: number} | null }} Blocker
 * @typedef {{ installed: boolean, error?: string }} InstallResult
 * @typedef {(
 *   | { status: "level", head: string }
 *   | { status: "forwarded", from: string, head: string, late: Stranding | null }
 *   | { status: "off-branch", branch: string | null }
 *   | { status: "shared" }
 *   | { status: "ahead", local: string[], unqueued: string[] }
 *   | { status: "blocked", from: string, to: string, blockers: Blocker[] }
 *   | { status: "refused", from: string, to: string, why: string }
 *   | ({ status: "stranding", from: string, to: string } & Stranding)
 * )} Moved
 * @typedef {(
 *   | (Moved & { fetchError: string | null })
 *   | { status: "busy", holder: number | null, fetchError: null }
 * ) & { install: InstallResult }} Outcome
 */

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
	changed.some((c) => isUnder(c, [edited]) || isUnder(edited, [c]));

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
 * Every edit in the main checkout, each an Orphaned edit: no session works
 * there once it is cut over.
 * @param {string} root
 * @param {number} now
 * @param {LastWriter} lastWriter
 * @returns {Blocker[]}
 */
const readOrphanedEdits = (root, now, lastWriter) =>
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
	const built = stageInstall(
		staging,
		(name) => {
			const blob = readHeadBlob(root, name);
			if (blob === null) return null;
			return execGit(["cat-file", "blob", blob], {
				cwd: root,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: GIT_TIMEOUT_MS,
			});
		},
		install,
	);
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
 * Which of `local` no last-fetched queue ref's tracking ref holds, as
 * lib/cutover.js's land leaves them queued.
 * @param {string} root
 * @returns {string[]}
 */
function readUnqueued(root) {
	return git(
		[
			"rev-list",
			"--reverse",
			"HEAD",
			`^${UPSTREAM}`,
			"--not",
			`--glob=${QUEUE_TRACKING_GLOB}`,
		],
		root,
	)
		.split("\n")
		.filter(Boolean);
}

/**
 * The fast-forward half of a pass: what `main` did, no install.
 * @param {string} root the main checkout
 * @param {{ now: number, lastWriter: LastWriter, work: string,
 *   listSessions?: ListSessions }} how
 * @returns {Moved}
 */
function forward(root, { now, lastWriter, work, listSessions }) {
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
		return { status: "ahead", local, unqueued: readUnqueued(root) };
	const changed = parseNulList(
		git(["diff", "--name-only", "--no-renames", "-z", from, to], root),
	);
	const blockers = [...readEditedPaths(root)]
		.filter((p) => clashes(p, changed))
		.sort()
		.map((p) => readBlocker(root, p, now, lastWriter));
	if (blockers.length > 0) return { status: "blocked", from, to, blockers };
	const scratch = path.join(work, "canary");
	const remark = remarkForCanary(root, {
		from,
		to,
		changed,
		scratch,
		listSessions,
	});
	if (remark !== null && !("owed" in remark))
		return { status: "stranding", from, to, ...remark };
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
	const late =
		remark === null
			? null
			: remarkLatecomers(root, { owed: remark.owed, scratch, listSessions });
	return { status: "forwarded", from, head: to, late };
}

/**
 * One levelling pass over the main checkout `root`. A pass another holds is
 * `busy`, doing nothing. A git fault outside the fetch and the fast-forward
 * throws.
 * @param {string} root the main checkout
 * @param {{ install?: Install, lastWriter?: LastWriter,
 *   listSessions?: ListSessions, now: number }} options
 * @returns {Outcome}
 */
function level(
	root,
	{ install = npmCi, lastWriter = () => null, listSessions, now },
) {
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
		const moved = forward(root, { now, lastWriter, work, listSessions });
		return {
			...moved,
			fetchError,
			install: isAtUpstream(moved)
				? installIfStale(root, work, install)
				: { installed: false },
		};
	} finally {
		lock.release();
	}
}

/** @param {{ status: string }} o */
const isAtUpstream = (o) => o.status === "level" || o.status === "forwarded";

/**
 * Whether the fetch and any install went through.
 * @param {Outcome} o
 */
const isFaultless = (o) => o.fetchError === null && !o.install.error;

/**
 * Whether the pass has nothing to report under `--quiet`: `main` already
 * level, another pass holding the lock, or the checkout not yet cut over,
 * with nothing failed or installed.
 * @param {Outcome} o
 */
const isRoutine = (o) =>
	isFaultless(o) &&
	!o.install.installed &&
	["level", "busy", "shared"].includes(o.status);

/**
 * What scripts/level-main.js prints and exits with for one pass: the report
 * under a `levelling <root>` line, which tells one checkout's report from
 * another's in the refill loop's log (scripts/measure-worktree-model.js), or
 * nothing where `quiet` and the pass was routine; exit 0 where `main` sits at
 * `origin/main` with the fetch and any install done, else 1.
 * @param {string} root
 * @param {Outcome} o
 * @param {{ now: number, quiet: boolean }} how
 * @returns {{ text: string, code: 0 | 1 }}
 */
function buildReport(root, o, { now, quiet }) {
	const text =
		quiet && isRoutine(o)
			? ""
			: `levelling ${root}\n${renderOutcome(o, now).join("\n")}\n`;
	return { text, code: isAtUpstream(o) && isFaultless(o) ? 0 : 1 };
}

/**
 * Start a quiet levelling pass over the main checkout at `root`
 * (scripts/level-main.js), detached, as the lander does after it moves
 * `origin/main` and the refill loop's tick does each tick (#4229): an `npm ci`
 * in it may outlast either. Fails open (#3765): a failed start goes to
 * `notStarted`, and the next move or tick starts another; the pass's pid lock
 * turns away one started while one runs. `WFC_LEVEL_MAIN_SCRIPT` names
 * another script to start, the lander suite's seam: a real pass would move
 * the sandbox's `main` under it.
 * @param {string} root
 * @param {(err: unknown) => void} notStarted
 */
function startLevelling(root, notStarted) {
	startDetachedIn(root, [levelScript(), "--quiet"], notStarted);
}

const levelScript = () =>
	process.env.WFC_LEVEL_MAIN_SCRIPT ||
	path.join(__dirname, "..", "level-main.js");

/* Room for the `npm ci` the pass runs where the lockfile changed, plus its
 * git steps. Untraced: one minute for the git. */
const LEVEL_NOW_TIMEOUT_MS = INSTALL_TIMEOUT_MS + 60_000;

/**
 * One levelling pass, waited for, in the environment the detached one gets:
 * where a fresh lander must start on what `main` now holds. What it printed
 * where it failed or another pass held the lock, else null.
 * @param {string} root
 * @returns {string|null}
 */
function levelNow(root) {
	const r = spawnSync(process.execPath, [levelScript(), "--quiet"], {
		cwd: root,
		env: buildCheckoutEnv(root),
		encoding: "utf8",
		timeout: LEVEL_NOW_TIMEOUT_MS,
	});
	return r.status === 0
		? null
		: (r.stderr || r.error?.message || `exit ${r.status}`).trim();
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

/** @param {import("./canary-remark.js").Stranded} s */
const renderStranded = (s) =>
	`  session ${s.sessionId} in ${s.projectDir} — ${s.refusal}`;

/**
 * The sessions that started during the canary re-mark, where any is left
 * refused after the fast-forward.
 * @param {Stranding | null} late
 * @returns {string[]}
 */
function renderLate(late) {
	if (late === null) return [];
	if ("why" in late)
		return [
			`warning: the sessions that started during the canary re-mark could not be re-marked, so any the old writer marked is refused from now on — end and restart each such session: ${late.why}`,
		];
	return [
		`warning: ${late.stranded.length} session(s) that started during the canary re-mark are refused by the new canary even after re-marking — end and restart each:`,
		...late.stranded.map(renderStranded),
	];
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
			lines.push(...renderLate(o.late));
			break;
		case "off-branch":
			lines.push(
				`refused: the main checkout is ${o.branch === null ? "on a detached HEAD" : `on ${o.branch}`}, not main, so main was not moved — switch it back to main, ${next}`,
			);
			break;
		case "shared":
			lines.push(
				`refused: the main checkout's main still tracks ${LANDING_REF}, so it has not been cut over to the worktree model and main was not moved — run \`node ${scriptPath("cutover-main-checkout.js")}\`, ${next}`,
			);
			break;
		case "ahead":
			lines.push(
				o.unqueued.length === 0
					? `waiting: main carries ${o.local.length} commit(s) not yet on ${UPSTREAM}, all on a queue ref — once the lander takes them, ${next}`
					: `refused: main carries ${o.unqueued.length} commit(s) on neither ${UPSTREAM} nor a queue ref, which a fast-forward cannot keep — land them from a session worktree; once the lander takes them, ${next}:`,
				...o.unqueued.map((sha) => `  ${short(sha)}`),
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
		case "stranding":
			if ("why" in o) {
				lines.push(
					`refused: ${short(o.from)}..${short(o.to)} changes the self-plugin canary, and the re-mark it owes the live sessions could not run, so main was not moved — ${next}: ${o.why}`,
				);
				break;
			}
			lines.push(
				`refused: ${short(o.from)}..${short(o.to)} changes the self-plugin canary, which would still refuse ${o.stranded.length} live session(s) after re-marking them, so main was not moved — land a canary that passes them, or end them, ${next}:`,
				...o.stranded.map(renderStranded),
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

module.exports = {
	buildReport,
	describeAge,
	level,
	levelNow,
	readOrphanedEdits,
	renderOutcome,
	startLevelling,
};
