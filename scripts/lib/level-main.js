const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { describeAge: describeAgeText, HOUR_MS } = require("./age-text.js");
const { remarkAroundMove } = require("./canary-remark.js");
const { buildHostPorts: buildRemarkPorts } = require("./canary-remark-host.js");
const { porcelainEntries } = require("./dirty-tree.js");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const {
	execGit,
	gitCommonDirOrThrow,
	GIT_TIMEOUT_MS,
	SHORT_SHA,
} = require("./git.js");
const { isCutOver, LANDING_REF } = require("./cutover.js");
const { literal, readLevelClear } = require("./landed-edit.js");
const { QUEUE_TRACKING_GLOB } = require("./landing-refs.js");
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
const MARKER = ".wfc-lockfile-blob";
const HOLDERS = ["level-main.js", "refill-loop.js"];

/**
 * @typedef {import("./npm-ci-staging.js").Install} Install
 * @typedef {import("./canary-remark.js").ListSessions} ListSessions
 * @typedef {import("./canary-remark.js").Stranding} Stranding
 * @typedef {(rel: string) => {sessionId: string, at: number} | null} LastWriter
 * @typedef {{ path: string, ageMs: number | null, writer: {sessionId: string, at: number} | null }} Blocker
 * @typedef {import("./landed-edit.js").LandedCopy} Discard
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
 *   | Extract<Moved, { status: "off-branch" | "shared" | "level" | "ahead" | "blocked" }>
 *   | { status: "clear", from: string, to: string, changed: string[], landed: Landed[] }
 * )} Survey
 * @typedef {import("./landed-edit.js").LandedCopy & { inHead: boolean }} Landed
 * @typedef {{ survey: Survey, behind: number, fetchedAt: number | null }} MainLag
 * @typedef {(
 *   | (Moved & { fetchError: string | null, discarded: Discard[] })
 *   | { status: "busy", holder: number | null, fetchError: null, discarded: [] }
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
 * @param {string} out
 * @returns {string[]}
 */
const parseNulList = (out) => out.split("\0").filter(Boolean);

/**
 * @param {string} root
 * @returns {Set<string>}
 */
function readEditedPaths(root) {
	const paths = new Set();
	for (const { path: p, source } of porcelainEntries(
		git(["--no-optional-locks", "status", "--porcelain", "-z", "-uall"], root),
	)) {
		paths.add(p);
		if (source) paths.add(source);
	}
	return paths;
}

/**
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
	const st = fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false });
	const ageMs = st ? Math.max(0, now - st.mtimeMs) : null;
	return { path: rel, ageMs, writer: lastWriter(rel) };
}

/**
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
 * @param {string} root
 * @param {string} name
 * @returns {string | null}
 */
function readHeadBlob(root, name) {
	const out = git(["ls-tree", "-z", "HEAD", "--", name], root);
	const id = out.split("\t")[0]?.split(" ")[2];
	return id || null;
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string | null}
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
 * @param {string} dir
 * @returns {string | null}
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
 * @param {string} live
 * @returns {string | null}
 */
function readMarker(live) {
	const r = readText(path.join(live, MARKER));
	if (r.state === "read") return r.data.trim();
	if (r.state === "absent" || caught(r.error).code === "ENOTDIR") return null;
	throw r.error;
}

/**
 * @param {string} root
 * @param {string} staging
 * @param {string} want
 * @param {Install} install
 * @returns {string}
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
 * @param {string} root
 * @param {string} work
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
 * @param {string} root
 * @param {string} rel
 * @param {boolean} inHead
 */
function discard(root, rel, inHead) {
	if (inHead) {
		git(
			[
				"restore",
				"--source=HEAD",
				"--staged",
				"--worktree",
				"--",
				literal(rel),
			],
			root,
		);
		return;
	}
	fs.rmSync(path.join(root, rel));
	git(["rm", "-q", "--cached", "--ignore-unmatch", "--", literal(rel)], root);
}

/**
 * @param {string} root
 * @param {Landed[]} landed
 * @param {Discard[]} discarded
 * @returns {string | null}
 */
function discardLanded(root, landed, discarded) {
	for (const { inHead, ...copy } of landed) {
		try {
			discard(root, copy.path, inHead);
		} catch (err) {
			return `discarding ${copy.path}, which ${UPSTREAM} holds byte for byte, failed: ${(caught(err).stderr || caught(err).message).trim()}`;
		}
		discarded.push(copy);
	}
	return null;
}

/**
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
 * @param {string} root
 * @param {{ now: number, lastWriter: LastWriter, work: string,
 *   listSessions?: ListSessions }} how
 * @returns {Moved & { discarded: Discard[] }}
 */
function forward(root, how) {
	/** @type {Discard[]} */
	const discarded = [];
	return { ...advance(root, how, discarded), discarded };
}

/**
 * @param {string} root
 * @param {{ now: number, lastWriter: LastWriter }} how
 * @returns {Survey}
 */
function survey(root, { now, lastWriter }) {
	let branch = null;
	try {
		branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], root).trim();
	} catch (err) {
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
	const judged = [...readEditedPaths(root)]
		.filter((p) => clashes(p, changed))
		.sort()
		.map((rel) => ({ rel, clear: readLevelClear(root, rel, UPSTREAM) }));
	const blockers = judged
		.filter((j) => j.clear === null)
		.map((j) => readBlocker(root, j.rel, now, lastWriter));
	if (blockers.length > 0) return { status: "blocked", from, to, blockers };
	const landed = judged.flatMap((j) => (j.clear === null ? [] : [j.clear]));
	return { status: "clear", from, to, changed, landed };
}

/**
 * @param {string} root
 * @param {{ now: number, lastWriter: LastWriter, work: string,
 *   listSessions?: ListSessions }} how
 * @param {Discard[]} discarded
 * @returns {Moved}
 */
function advance(root, { now, lastWriter, work, listSessions }, discarded) {
	const surveyed = survey(root, { now, lastWriter });
	if (surveyed.status !== "clear") return surveyed;
	const { from, to, changed } = surveyed;
	const failed = discardLanded(root, surveyed.landed, discarded);
	if (failed !== null) return { status: "refused", from, to, why: failed };
	const moved = remarkAroundMove(
		buildRemarkPorts(root, path.join(work, "canary"), listSessions),
		{ from, to, changed },
		() => {
			try {
				git(["merge", "--ff-only", "--quiet", to], root);
				return null;
			} catch (err) {
				return (caught(err).stderr || caught(err).message).trim();
			}
		},
	);
	switch (moved.status) {
		case "stranding":
			return { status: "stranding", from, to, ...moved.stranding };
		case "refused":
			return { status: "refused", from, to, why: moved.why };
		case "moved":
			return { status: "forwarded", from, head: to, late: moved.late };
	}
}

/**
 * @param {string} root
 * @param {{ now: number, lastWriter: LastWriter }} how
 * @returns {MainLag}
 */
function readMainLag(root, how) {
	const surveyed = survey(root, how);
	const behind = Number(
		git(["rev-list", "--count", `HEAD..${UPSTREAM}`], root).trim(),
	);
	const common = gitCommonDirOrThrow(root, { timeout: GIT_TIMEOUT_MS });
	const stamps = [
		"FETCH_HEAD",
		path.join("logs", "refs", "remotes", ...UPSTREAM.split("/")),
	].flatMap(
		(rel) =>
			fs.statSync(path.join(common, rel), { throwIfNoEntry: false })?.mtimeMs ??
			[],
	);
	return {
		survey: surveyed,
		behind,
		fetchedAt: stamps.length === 0 ? null : Math.max(...stamps),
	};
}

/**
 * @param {string} root
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
			discarded: [],
			install: { installed: false },
		};
	try {
		const work = path.join(common, "wfc-level");
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
 * @param {Outcome} o
 */
const isFaultless = (o) =>
	o.fetchError === null &&
	!o.install.error &&
	(o.status !== "forwarded" || o.late === null);

/**
 * @param {Outcome} o
 */
const isRoutine = (o) =>
	isFaultless(o) &&
	!o.install.installed &&
	["level", "busy", "shared"].includes(o.status);

/**
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
 * @param {string} root
 * @param {(err: unknown) => void} notStarted
 */
function startLevelling(root, notStarted) {
	startDetachedIn(root, [levelScript(), "--quiet"], notStarted);
}

const levelScript = () =>
	process.env.WFC_LEVEL_MAIN_SCRIPT ||
	path.join(__dirname, "..", "level-main.js");

// guess, #4521
const LEVEL_NOW_TIMEOUT_MS = INSTALL_TIMEOUT_MS + 60_000;

/**
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
 * @param {Blocker} b
 * @param {number} now
 * @returns {string}
 */
const renderBlocker = (b, now) =>
	`  ${b.path} — ${b.ageMs === null ? "deleted" : `${describeAge(b.ageMs)} old`}; last writer ${b.writer ? `session ${b.writer.sessionId}, ledger written ${describeAge(now - b.writer.at)} ago` : "unknown — no surviving write ledger names it"}`;

/**
 * @param {number} ms
 * @returns {string}
 */
const describeAge = (ms) => describeAgeText(ms, { minutesUnder: HOUR_MS });

/** @param {import("./canary-remark.js").Stranded} s */
const renderStranded = (s) =>
	`  session ${s.sessionId} in ${s.projectDir} — ${s.refusal}`;

/**
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
 * @param {Survey} s
 * @param {number} now
 * @returns {string[]}
 */
function renderSurvey(s, now) {
	if (s.status !== "clear") return renderStatus(s, now);
	const landed =
		s.landed.length === 0
			? ""
			: `, after discarding ${s.landed.map((l) => l.path).join(", ")}, which ${UPSTREAM} holds byte for byte`;
	return [
		`clear: the next levelling pass takes main to ${UPSTREAM}${landed} — \`node ${scriptPath("level-main.js")}\` runs one now`,
	];
}

/**
 * @param {Moved | { status: "busy", holder: number | null }} o
 * @param {number} now
 * @returns {string[]}
 */
function renderStatus(o, now) {
	const short = (/** @type {string} */ sha) => sha.slice(0, SHORT_SHA);
	const next = "then the next pass levels main";
	/** @type {string[]} */
	const lines = [];
	switch (o.status) {
		case "busy":
			lines.push(
				`skipped: another levelling pass${o.holder === null ? "" : ` (pid ${o.holder})`} holds the lock`,
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
				...o.blockers.map((b) => renderBlocker(b, now)),
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
	return lines;
}

/**
 * @param {Outcome} o
 * @param {number} now
 * @returns {string[]}
 */
function renderOutcome(o, now) {
	const short = (/** @type {string} */ sha) => sha.slice(0, SHORT_SHA);
	const lines = renderStatus(o, now);
	for (const d of o.discarded)
		lines.push(
			`discarded ${d.path} from the main checkout: its blob ${short(d.blob)} is the file at ${short(d.commit)} on ${UPSTREAM}, so nothing was lost`,
		);
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
	readMainLag,
	readOrphanedEdits,
	renderBlocker,
	renderOutcome,
	renderSurvey,
	startLevelling,
};
