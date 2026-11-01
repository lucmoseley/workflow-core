/*
 * repo-holds.js — the repo hold's record and lifecycle (#3857, spec #3597): a
 * per-checkout record that one founder-only act blocks shared state.
 * scripts/repo-hold.js is its CLI; lib/refill-tick.js runs tendHolds each
 * tick. It is the adapter behind that tick's I/O (#3857's "behind the loop's
 * port"), so it holds fs, gh and the clear checks' runs together, tested through
 * the real tick and the CLI as that ticket asks, with no core split out.
 *
 * THE STORE is one file a hold, under the loop's machine-wide directory
 * (lib/refill-dir.js), in a directory keyed on git's common dir. So every
 * worktree of a checkout and the loop read one store, a raise overwrites no
 * other hold, and lib/scratch-sweep.js, which reaps `.claude/tmp/`, cannot age
 * out a hold the founder has yet to answer. RESIDUAL: where git will not name
 * the common dir at all, a worktree keys on its own `.git`, so its holds split
 * from the checkout's until git answers again.
 *
 * A LIFT IS THE UNLINK, so a tick and a hand lift racing get one winner and one
 * log line.
 *
 * THE PROBE (#3860): each tick, each served checkout's shared `.git` must fetch
 * origin and resolve `main`, and `origin/landing` with the landing module on. A
 * checkout that fails holds the one `probe` hold its store can hold, under a
 * fixed id, so a raise never makes a second and a torn one is written over. The
 * failing roots are also returned to the tick, which stops launches on them even
 * where no record could be written (#3860). A probe hold's issue is filed once
 * its record stands, and the filing retried each tick; a hand lift of one still
 * failing is raised anew, with a new issue, on the next tick.
 *
 * RESIDUAL: a close that fails on a clear is logged and not retried, there being
 * no hold left to retry it from. The issue's body says what to do, and the fetch
 * that just passed makes `gh` likely to answer.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { spawnChild } = require("./child-spawn.js");
const { deref } = require("./deref.js");
const { fileThrough } = require("./file-through.js");
const { gh, ghJson, parseErrLine } = require("./gh.js");
const { gitCommonDir, gitOutcome } = require("./git.js");
const { mainCheckout } = require("./main-checkout.js");
const { FETCH_TIMEOUT_MS } = require("./refill-code.js");
const { refillPath } = require("./refill-dir.js");
const { checkoutEnv } = require("./refill-repos.js");
const {
	KILLED_EXIT,
	RUN_BUDGETED,
	TIMEOUT_EXIT,
} = require("./run-budgeted.js");
const { takesLabel } = require("./takes-label.js");
const { moduleReader, resolveKey } = require("./workflow-core-config.js");

/**
 * @typedef {{command: string} | {issueClosed: number} | {probe: true}} ClearCheck
 *
 * @typedef {object} RepoHold
 * @property {string} id
 * @property {string} checkout  the main checkout's root
 * @property {"probe"|"park"} kind  a `probe` hold alone stops launches
 * @property {string} act  the founder act, in plain words
 * @property {number|null} issue  the issue holding the question, null on a
 *   probe hold whose filing has yet to land
 * @property {ClearCheck} clearCheck
 * @property {number} raisedAt
 * @property {string[]} sessions  the job ids of the sessions parked on it
 * @property {{raiseSent: boolean, clearSent: boolean}} notice  #3871's to read
 *   and write, the morning review's to read; nothing writes it yet
 *
 * @typedef {(line: string) => void} Log
 */

/* Untraced: a clear check runs inside a tick, which it must not hold for long,
 * and has to span a slow `git fetch`. */
const CLEAR_CHECK_TIMEOUT_MS = 30_000;

/* How long the runner waits after its TERM before its KILL; a guess, as
 * lib/gate-check.js's is. */
const CLEAR_CHECK_KILL_AFTER_MS = 5000;

/* A guess: few holds open at once, and short enough to type at `lift`. A
 * repeat would overwrite the hold it repeats. */
const ID_BYTES = 3;

const PROBE_ID = "probe";

const ID_PATTERN = new RegExp(`^(?:[0-9a-f]+|${PROBE_ID})$`);

const PROBE_FILED_WHY =
	"a probe hold is raised by the refill loop, with no asking session to hold its question (#3860)";

/* A guess: 48 bits of the key's hash, in a directory holding a few checkouts. */
const STORE_KEY_LENGTH = 12;

/**
 * The checkout a command run from `cwd` holds holds in.
 * @param {string} cwd
 */
const readCheckout = (cwd) => mainCheckout(cwd) ?? cwd;

/**
 * The checkout's store: named for a reader, and hashed because two paths can
 * flatten to one name. A broken `.git` that git will not name still keys on its
 * path, as a probe hold raised on one must be found once it is repaired.
 * @param {string} root
 */
function holdsDir(root) {
	const key = deref(gitCommonDir(root) ?? path.join(root, ".git"));
	const hash = createHash("sha256").update(key).digest("hex");
	return refillPath(
		path.join(
			"repo-holds",
			`${path.basename(root)}-${hash.slice(0, STORE_KEY_LENGTH)}`,
		),
	);
}

/**
 * @param {string} root
 * @param {string} id
 */
const holdFile = (root, id) => path.join(holdsDir(root), `${id}.json`);

/**
 * Whether `value` is a hold, and the one its file is named for: an id off the
 * pattern would make a path out of the store.
 * @param {unknown} value
 * @param {string} name  the file's name
 * @returns {value is RepoHold}
 */
function isHold(value, name) {
	const hold = /** @type {Partial<RepoHold>|null} */ (value);
	const check =
		/** @type {Partial<{command: unknown, issueClosed: unknown, probe: unknown}>} */ (
			hold?.clearCheck ?? {}
		);
	return (
		typeof hold?.id === "string" &&
		ID_PATTERN.test(hold.id) &&
		name === `${hold.id}.json` &&
		typeof hold.checkout === "string" &&
		(hold.kind === "probe" || hold.kind === "park") &&
		typeof hold.act === "string" &&
		(typeof hold.issue === "number" ||
			(hold.kind === "probe" && hold.issue === null)) &&
		typeof hold.raisedAt === "number" &&
		typeof hold.notice?.raiseSent === "boolean" &&
		typeof hold.notice?.clearSent === "boolean" &&
		Array.isArray(hold.sessions) &&
		(typeof check.command === "string" ||
			typeof check.issueClosed === "number" ||
			(hold.kind === "probe" && check.probe === true))
	);
}

/**
 * The checkout's open holds, oldest first, and why any of them would not read.
 * @param {string} root
 * @returns {{holds: RepoHold[], unread: string[]}}
 */
function readHolds(root) {
	const dir = holdsDir(root);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		const { code, message } = caught(err);
		return code === "ENOENT"
			? { holds: [], unread: [] }
			: { holds: [], unread: [`${dir}: ${message}`] };
	}
	/** @type {RepoHold[]} */
	const holds = [];
	/** @type {string[]} */
	const unread = [];
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const file = path.join(dir, name);
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf8"));
			if (isHold(value, name)) holds.push(value);
			else unread.push(`${file}: not a hold`);
		} catch (err) {
			/* ENOENT: lifted between the listing and this read. */
			if (caught(err).code !== "ENOENT")
				unread.push(`${file}: ${caught(err).message}`);
		}
	}
	return { holds: holds.sort((a, b) => a.raisedAt - b.raisedAt), unread };
}

/** @param {ClearCheck} check */
function buildCheckText(check) {
	if ("probe" in check) return "the shared .git probe";
	return "command" in check
		? `command: ${check.command.replace(/\s+/g, " ").trim()}`
		: `issue #${check.issueClosed} closed`;
}

/** @param {RepoHold} hold */
const buildHoldRef = (hold) => `${hold.id} in ${hold.checkout}: ${hold.act}`;

/** @param {RepoHold} hold */
const buildIssueText = (hold) =>
	hold.issue === null ? "no issue filed yet" : `issue #${hold.issue}`;

/**
 * @param {string} root
 * @param {RepoHold} hold
 */
const writeHold = (root, hold) =>
	writeFileAtomic(
		holdFile(root, hold.id),
		`${JSON.stringify(hold, null, "\t")}\n`,
		{ mkdir: true },
	);

/**
 * Record a new hold and return it.
 * @param {string} root
 * @param {{id?: string, kind: RepoHold["kind"], act: string,
 *   issue: number|null, clearCheck: ClearCheck, session: string|null,
 *   now: number}} raised  `id`, a fixed one in place of a fresh one
 * @returns {RepoHold}
 */
function raiseHold(
	root,
	{
		id = randomBytes(ID_BYTES).toString("hex"),
		kind,
		act,
		issue,
		clearCheck,
		session,
		now,
	},
) {
	/** @type {RepoHold} */
	const hold = {
		id,
		checkout: root,
		kind,
		/* One line, as the log and status print it. */
		act: act.replace(/\s+/g, " ").trim(),
		issue,
		clearCheck,
		raisedAt: now,
		sessions: session === null ? [] : [session],
		notice: { raiseSent: false, clearSent: false },
	};
	writeHold(root, hold);
	return hold;
}

/** @param {RepoHold} hold */
const buildRaisedLine = (hold) =>
	`repo hold raised: ${buildHoldRef(hold)}; ${buildIssueText(hold)}; clears on ${buildCheckText(hold.clearCheck)}`;

/**
 * End a hold; false where it was already gone.
 * @param {string} root
 * @param {string} id
 */
function removeHold(root, id) {
	try {
		fs.unlinkSync(holdFile(root, id));
		return true;
	} catch (err) {
		if (caught(err).code === "ENOENT") return false;
		throw err;
	}
}

/**
 * Lift a hold by hand, whatever its clear check reads: its log line, or null
 * where no file has that id. A record too damaged to read lifts too, by its bare
 * id, as nothing else could end it (#3857). A probe hold's filed issue closes
 * with it.
 * @param {string} root
 * @param {string} id
 * @returns {string|null}
 */
function liftHold(root, id) {
	if (!ID_PATTERN.test(id)) return null;
	const hold = readHolds(root).holds.find((h) => h.id === id);
	if (!removeHold(root, id)) return null;
	const line = `repo hold lifted by hand: ${hold ? buildHoldRef(hold) : id}`;
	const closeFailure =
		hold && closeProbeIssue(hold, "Its hold was lifted by hand.");
	return closeFailure ? `${line}; ${closeFailure}` : line;
}

/**
 * Whether a command check passes. Run under run-budgeted.js, which reaps its
 * whole group, as a straggler would outlive a plain spawn's timeout. One that
 * will not start or outlives its time reads as not passing, logged (#3857), so
 * the hold stands and the next tick tries again.
 * @param {RepoHold} hold
 * @param {string} command
 * @param {Log} log
 */
function isCommandPassed(hold, command, log) {
	const run = spawnChild(
		process.execPath,
		[
			RUN_BUDGETED,
			String(CLEAR_CHECK_TIMEOUT_MS),
			String(CLEAR_CHECK_KILL_AFTER_MS),
			"sh",
			"-c",
			command,
		],
		{
			cwd: hold.checkout,
			env: checkoutEnv(hold.checkout),
			timeout: CLEAR_CHECK_TIMEOUT_MS + 2 * CLEAR_CHECK_KILL_AFTER_MS,
		},
	);
	if (run.error) {
		log(
			`repo hold ${hold.id}: clear check did not finish: ${run.error.message}`,
		);
		return false;
	}
	if (run.status === TIMEOUT_EXIT || run.status === KILLED_EXIT)
		log(
			`repo hold ${hold.id}: clear check outlived ${CLEAR_CHECK_TIMEOUT_MS} ms`,
		);
	return run.status === 0;
}

/**
 * The checkout's tracker, or a throw.
 * @param {string} root
 */
function readTracker(root) {
	const tracker = resolveKey("tracker", { root });
	if (typeof tracker !== "string") throw new Error("no tracker configured");
	return tracker;
}

/**
 * Whether the issue reads closed; an unread issue reads as not closed, logged
 * (#3857).
 * @param {RepoHold} hold
 * @param {number} issue
 * @param {Log} log
 */
function isIssueClosed(hold, issue, log) {
	try {
		const state = gh(
			[
				"issue",
				"view",
				String(issue),
				"--repo",
				readTracker(hold.checkout),
				"--json",
				"state",
				"--jq",
				".state",
			],
			{ timeout: CLEAR_CHECK_TIMEOUT_MS },
		);
		return state.trim() === "CLOSED";
	} catch (e) {
		log(`repo hold ${hold.id}: could not read #${issue}: ${parseErrLine(e)}`);
		return false;
	}
}

/**
 * What fails of `root`'s shared `.git`, or null where the probe passes. `origin`
 * and `main` are the shared tree's, and `landing` is read as `origin/landing`, as
 * the shared tree keeps no local one. Reads off a config fault, logged, with the
 * landing module off.
 * @param {string} root
 * @param {Log} log
 */
function readProbeFailure(root, log) {
	const hasLanding = moduleReader(root, (what, detail) =>
		log(`probe of ${root}: ${what}: ${detail}`),
	)("landing");
	const steps = [
		{
			name: "fetch origin",
			args: [
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-write-fetch-head",
				"origin",
			],
			timeout: FETCH_TIMEOUT_MS,
		},
		{
			name: "resolve main",
			args: ["rev-parse", "--verify", "refs/heads/main^{commit}"],
		},
		...(hasLanding
			? [
					{
						name: "resolve origin/landing",
						args: [
							"rev-parse",
							"--verify",
							"refs/remotes/origin/landing^{commit}",
						],
					},
				]
			: []),
	];
	const failed = steps.flatMap(({ name, args, timeout }) => {
		const read = gitOutcome(args, [], root, timeout);
		return read.ok ? [] : [`${name}: ${read.why}`];
	});
	return failed.length > 0 ? failed.join("; ") : null;
}

/**
 * Close a probe hold's filed issue, with `why`: null once closed or where there
 * is none to close, else what failed.
 * @param {RepoHold} hold
 * @param {string} why
 */
function closeProbeIssue(hold, why) {
	if (hold.kind !== "probe" || hold.issue === null) return null;
	try {
		gh(
			[
				"issue",
				"close",
				String(hold.issue),
				"--repo",
				readTracker(hold.checkout),
				"--comment",
				`${why} The refill loop launches into ${hold.checkout} again unless it reads another failure.`,
			],
			{ timeout: CLEAR_CHECK_TIMEOUT_MS },
		);
		return null;
	} catch (e) {
		return `could not close #${hold.issue}: ${parseErrLine(e)}`;
	}
}

/**
 * @param {RepoHold} hold
 * @param {(root: string) => string|null} readFailure  the tick's one probe of a
 *   checkout, shared with its failing-tick raise
 * @param {Log} log
 */
function isCheckPassed(hold, readFailure, log) {
	if ("probe" in hold.clearCheck) return readFailure(hold.checkout) === null;
	return "command" in hold.clearCheck
		? isCommandPassed(hold, hold.clearCheck.command, log)
		: isIssueClosed(hold, hold.clearCheck.issueClosed, log);
}

/**
 * Each distinct store's root among `roots`: two can be one checkout's.
 * @param {string[]} roots
 */
const readStoreRoots = (roots) => [
	...new Map(roots.map((root) => [holdsDir(root), root])).values(),
];

/**
 * Re-run one hold's clear check, lifting it where it passes. Any throw is logged
 * and costs this hold alone its tick, never the launches (#3857).
 * @param {string} root
 * @param {RepoHold} hold
 * @param {(root: string) => string|null} readFailure  as isCheckPassed's
 * @param {Log} log
 */
function settleHold(root, hold, readFailure, log) {
	try {
		if (!isCheckPassed(hold, readFailure, log) || !removeHold(root, hold.id))
			return;
		log(
			`repo hold cleared: ${buildHoldRef(hold)}; passed ${buildCheckText(hold.clearCheck)}`,
		);
		const closeFailure = closeProbeIssue(
			hold,
			"The shared `.git` probe passes again, so its hold has cleared.",
		);
		if (closeFailure) log(`repo hold ${hold.id}: ${closeFailure}`);
	} catch (err) {
		log(`repo hold ${hold.id}: not settled: ${caught(err).message}`);
	}
}

/**
 * The checkout's probe hold, read by its fixed name so that a store that will not
 * list still shows it; null where none is there or its record is torn, which the
 * listing logs and a raise writes over (#3860). Any other failure throws.
 * @param {string} root
 * @returns {RepoHold|null}
 */
function readProbeHold(root) {
	try {
		const value = JSON.parse(fs.readFileSync(holdFile(root, PROBE_ID), "utf8"));
		return isHold(value, `${PROBE_ID}.json`) ? value : null;
	} catch (err) {
		if (err instanceof SyntaxError || caught(err).code === "ENOENT")
			return null;
		throw err;
	}
}

/**
 * @param {string} root
 * @param {string} failure
 */
const buildProbeIssueBody = (root, failure) =>
	`The refill loop's probe of the shared \`.git\` of \`${root}\` failed, so the loop launches nothing into that checkout until it passes.

**Failure:** ${failure}

**To clear:** repair the checkout. The loop re-runs the probe each tick, lifts its hold the tick it passes and closes this issue. Where \`node scripts/repo-hold.js list\` shows no \`probe\` hold for this checkout and this issue is still open, its close failed: close it.`;

/**
 * The open issue already carrying `title`, or null: a record torn since its
 * filing, or a tick that died between filing and recording, has lost its number,
 * and a second issue would leave this one open for good. Throws where it cannot
 * tell. RESIDUAL: search lags a filing by moments, and only these two rare paths
 * read it, so a second can still slip through.
 * @param {string} root
 * @param {string} title
 * @returns {number|null}
 */
function readOpenProbeIssue(root, title) {
	const rows = /** @type {{number: number, title: string}[]} */ (
		ghJson(
			[
				"issue",
				"list",
				"--repo",
				readTracker(root),
				"--state",
				"open",
				"--search",
				`"${title}" in:title`,
				"--json",
				"number,title",
			],
			{ timeout: CLEAR_CHECK_TIMEOUT_MS },
		)
	);
	return rows.find((r) => r.title === title)?.number ?? null;
}

/**
 * File the probe hold's issue, or take up the one already open, recording it on
 * the hold. A failure is logged and the hold stands with no issue, for the next
 * tick to retry (#3860).
 * @param {string} root
 * @param {RepoHold} hold
 * @param {string} failure
 * @param {Log} log
 */
function fileProbeIssue(root, hold, failure, log) {
	const title = `Refill loop probe: shared .git failing in ${path.basename(root)}`;
	let open;
	try {
		open = readOpenProbeIssue(root, title);
	} catch (e) {
		log(
			`repo hold ${hold.id} in ${root}: issue not filed, the next tick retries: could not look for an open one: ${parseErrLine(e)}`,
		);
		return;
	}
	if (open !== null) {
		writeHold(root, { ...hold, issue: open });
		log(`repo hold ${hold.id} in ${root}: took up open #${open}`);
		return;
	}
	const filed = fileThrough(
		[
			"--title",
			title,
			"--label",
			takesLabel("triage"),
			"--standalone",
			PROBE_FILED_WHY,
			"--body-file",
			"-",
		],
		buildProbeIssueBody(root, failure),
		root,
	);
	const number = (filed.stdout ?? "").match(/^Filed #(\d+)/m)?.[1];
	if (number === undefined) {
		log(
			`repo hold ${hold.id} in ${root}: issue not filed, the next tick retries: ${(filed.stderr || filed.error?.message || "no reason given").trim()}`,
		);
		return;
	}
	writeHold(root, { ...hold, issue: Number(number) });
	log(`repo hold ${hold.id} in ${root}: filed #${number}`);
}

/**
 * Raise or keep `root`'s probe hold, and file its issue where it has none. Any
 * throw is logged and fails open on the record alone, the caller stopping
 * launches whatever the store took (#3860).
 * @param {string} root
 * @param {string} failure
 * @param {number} now
 * @param {Log} log
 */
function keepProbeHold(root, failure, now, log) {
	try {
		let hold = readProbeHold(root);
		if (hold === null) {
			hold = raiseHold(root, {
				id: PROBE_ID,
				kind: "probe",
				act: `repair the shared .git: ${failure}`,
				issue: null,
				clearCheck: { probe: true },
				session: null,
				now,
			});
			log(buildRaisedLine(hold));
		}
		if (hold.issue === null) fileProbeIssue(root, hold, failure, log);
	} catch (err) {
		log(`repo hold ${PROBE_ID} in ${root}: not kept: ${caught(err).message}`);
	}
}

/**
 * One tick's holds: every open hold's clear check re-run, each that passes
 * lifted, then each served checkout probed. An unreadable store is logged and
 * read as holding no open hold, the tick carrying on (#3857), but for the probe,
 * whose failing roots it returns whatever the store took (#3860).
 * @param {string[]} roots  every checkout whose holds are settled
 * @param {string[]} served  the checkouts probed
 * @param {number} now
 * @param {Log} log  passed, as lib/refill-tick.js, which owns the loop's, requires this
 * @returns {string[]} the served checkouts whose probe failed
 */
function tendHolds(roots, served, now, log) {
	/** @type {Map<string, string|null>} */
	const probed = new Map();
	/** One fetch a checkout a tick, for its hold's check and its probe alike.
	 * @param {string} root */
	const readFailure = (root) => {
		const known = probed.get(root);
		if (known !== undefined) return known;
		const failure = readProbeFailure(root, log);
		probed.set(root, failure);
		return failure;
	};
	for (const root of readStoreRoots(roots)) {
		const { holds, unread } = readHolds(root);
		for (const why of unread)
			log(`repo holds unread, read as not open this tick: ${why}`);
		for (const hold of holds) settleHold(root, hold, readFailure, log);
	}
	return served.filter((root) => {
		const failure = readFailure(root);
		if (failure === null) return false;
		log(`probe failed in ${root}: ${failure}`);
		keepProbeHold(root, failure, now, log);
		return true;
	});
}

/**
 * The open holds a tick decides on: `broken`'s probe, whatever its store took,
 * and each checkout's stored holds.
 * @param {string[]} roots
 * @param {string[]} broken  tendHolds's answer
 * @returns {{root: string, kind: RepoHold["kind"]}[]}
 */
const readTickHolds = (roots, broken) => [
	...broken.map((root) => ({ root, kind: /** @type {const} */ ("probe") })),
	...roots.flatMap((root) =>
		readHolds(root).holds.map(({ kind }) => ({ root, kind })),
	),
];

/**
 * @param {number} ms
 */
function buildAgeText(ms) {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	return minutes < 60
		? `${minutes}m`
		: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * What the founder reads of each open hold, and of any store that would not read.
 * @param {string[]} roots
 * @param {number} now
 * @returns {string[]}
 */
function buildHoldLines(roots, now) {
	const reads = readStoreRoots(roots).map(readHolds);
	const holds = reads.flatMap((r) => r.holds);
	return [
		holds.length === 0
			? "holds:     none open"
			: `holds:     ${holds.length} open`,
		...holds.map(
			(h) =>
				`  ${h.id} ${path.basename(h.checkout)}: ${h.act} — ${buildIssueText(h)}, age ${buildAgeText(now - h.raisedAt)}, sessions: ${h.sessions.join(", ") || "none"}, stops launches: ${h.kind === "probe" ? "yes" : "no"}`,
		),
		...reads
			.flatMap((r) => r.unread)
			.map((why) => `  unread: ${why}; lift its id or remove the file`),
	];
}

module.exports = {
	buildAgeText,
	buildHoldLines,
	buildRaisedLine,
	liftHold,
	raiseHold,
	readCheckout,
	readHolds,
	readTickHolds,
	tendHolds,
};
