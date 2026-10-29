/*
 * The reporting tail every check-*.js shares: argv, severity, streams, the
 * summary line, annotations and the exit code.
 *
 * Built to the alphabet settled at mantahostels#155 (the checker family's exit-code and
 * severity model). Five outcomes over three exit codes:
 *
 *   OK      ran, found nothing                                       exit 0
 *   SKIP    could not run, and not the repo's fault                  exit 0
 *   WARN    real findings, deliberately not gating                   exit 0
 *   FAIL    real findings that gate                                  exit 1
 *   BROKEN  the checker itself cannot do its job — bad usage,        exit 2
 *           unreadable or unparseable input
 *
 * The SKIP/BROKEN boundary is applied without judgement, and it runs on
 * SUBJECT vs APPARATUS — not on where the missing thing lives:
 *
 *   SUBJECT    what the checker is ASKING ABOUT is unavailable — GitHub is
 *              down, the gitignored data/ corpus is absent => SKIP. These have
 *              a real base rate, and gating on them teaches the reader to
 *              ignore the gate.
 *   APPARATUS  what the checker READS THE REPO WITH failed — fs will not read a
 *              tracked file, git will not enumerate the tracked set => BROKEN.
 *
 * lib/gh.js already runs on exactly this split and is the model generalised
 * here: parseGhFailureReason() sends an unreachable GitHub (subject) to SKIP and
 * every other gh failure (apparatus) to BROKEN.
 *
 * Severity is intrinsic to a finding, assigned by the checker that raises it;
 * the outcome is the worst severity present. --warn is a caller-side CAP, not a
 * property of the finding: it lowers the ceiling to WARN so FAIL findings still
 * print but no longer gate. It cannot cap BROKEN.
 *
 * Streams. stdout is reserved for machine readers: the --json envelope, and the
 * ::error::/::warning:: workflow commands Actions only parses there. Human text
 * goes to stderr. --notify inverts that one case — a SessionStart hook injects
 * its stdout into the session's context, so the report has to be on stdout to be
 * read at all.
 *
 * --against <rev>. THE ONE CONVENTION FOR JUDGING THE COMMIT RATHER THAN THE
 * WORKING TREE (mantahostels#1801). A checker that direction-gates declares
 * `against` in its spec; runCheck then does the whole job for it:
 *
 *   1. materialise the INDEX as a tree and re-exec ITSELF over it
 *      (`node <argv[1]> --root <dir> --json`);
 *   2. only if that reading holds gating faults, do the same for <rev>;
 *   3. report the faults the index side has and <rev> does not, through
 *      scripts/lib/fault-profiles.js's profile table.
 *
 * BOTH SIDES ARE COMMIT BYTES. The parent does no checking of its own: this
 * tree is repo-global, so reading a file in place judges a parallel session's
 * half-written copy rather than this commit's.
 *
 * `--head <rev>` beside `--against <rev>` names a commit as the judged side in
 * place of the index (#3074).
 *
 * NOT `--baseline`: taken twice in this family already, for a file of anchor
 * text (check-instruction-surface.js) and a number of test files
 * (check-suite-size-drift.js).
 *
 * TWO MATERIALISATIONS, CHOSEN BY THE SPEC AND NEVER BY THE CALLER, because
 * which one is right is a property of how the checker finds its scan scope:
 * `tree` where it discovers its own roots by walking, `blobs` where the spec
 * declares a pathspec — see MATERIALISERS.
 *
 * DIRECTION IS A SET DIFFERENCE, AND A MEASUREMENT NEEDS MORE. A fault carrying
 * a number — "the pool is 38,200 B against a 38,000 B cap" — is not answered by
 * "is it in the baseline": a shed that leaves the surface still over cap would
 * read as a fault this commit added. lib/fault-diff.js's `family`/`worse` pair
 * is where a profile says what getting worse means (mantahostels#1834), and its `measure`
 * is where it says what the number IS, so the refusal can carry the baseline
 * and the delta rather than the total alone — measuredDelta() (mantahostels#1939).
 *
 * FAIL-CLOSED ON THE BASELINE. A <rev> reading that cannot answer —
 * unreadable, unparseable, BROKEN or SKIP — is BROKEN here, never "inherited",
 * which is the answer that would pass the commit. The INDEX side is the
 * exception and deliberately: its SKIP is a SUBJECT skip, above.
 */

const { spawnSync } = require("node:child_process");
const { spawnGitSync } = require("./git.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
/* PERSIST MODE (mantahostels#1974, the seam mantahostels#1949's persist-and-replay hangs off) — the
 * `WFC_NOTIFY_PERSIST` gate, shared with `reap-finished-sessions.js` since
 * mantahostels#2252 so the two cannot drift. What the mode is and why the gate is spelled
 * as it is: lib/persist-mode.js's header. */
const { persisting } = require("./persist-mode.js");
const { fromEnv: sessionFromEnv } = require("./session-id.js");
const { ENVELOPE_FRAME_KEYS } = require("./envelope-frame-keys.js");
const { isUnder } = require("./is-under.js");
const { readCommitOrBroken } = require("./commit-sha.js");
const { GIT_MODE } = require("./git-mode.js");
const {
	brokenError,
	isOutcomeError,
	outcomeOf,
	skipError,
} = require("./outcome-error.js");
const { readObjectBatch, listTree } = require("./git-objects.js");

/*
 * PERSIST MODE'S BACKEND IS REQUIRED BY A COMPUTED PATH, so no literal
 * `require` edge leads from the harness to notify-report.js and, behind it, the
 * whole arbiter-* store (#459). The release render still ships it:
 * lib/surface-closure.js reads this `path.join(__dirname, …)` spelling as an
 * edge (#464). Keep the spelling, or the render stops guarding the file.
 * Persist mode runs from a core SessionStart hook alone, so only a persisting
 * run loads it. A tree without the file fails persist mode SILENTLY: the crash
 * line goes to stdout, which the async hook discards.
 */
const NOTIFY_REPORT = path.join(__dirname, "notify-report.js");
/** @returns {typeof import("./notify-report.js")} */
const loadNotify = () => require(NOTIFY_REPORT);

const AGAINST = "--against";
const HEAD_FLAG = "--head";

/* The flags this library reads itself, which every checker accepts without
 * declaring them (#938). */
const LIBRARY_FLAGS = [
	"--warn",
	"--json",
	"--json-text",
	"--notify",
	"--help",
	AGAINST,
	HEAD_FLAG,
];

/* What a direction-gating checker accepts on top: the re-exec passes it. */
const AGAINST_FLAGS = ["--root"];

/*
 * Where a --json run's human report goes instead of nowhere. Set by the
 * --against re-exec below and by nothing else: the child is run under --json
 * for its envelope, but its own report is what a pre-commit session actually
 * reads — check-guard-registry.js's implicit-behaviour roster (mantahostels#1261) and every
 * checker's fix advice live there — so it is streamed to the parent's stderr
 * while stdout stays a single parseable document.
 *
 * PERSIST MODE NEVER MEETS THIS, though it would outrank it: the `--against`
 * re-exec that sets it runs the child under `--json`, which persist mode's gate
 * refuses (lib/persist-mode.js), and say()'s capture route is checked before
 * its fd route either way. Reordering those two routes needs that read again.
 */
const SAY_FD_ENV = "WFC_CHECK_SAY_FD";

/*
 * Which side of an --against run this child reads: `baseline` on the <rev>
 * side, `index` on the commit's. Set by the re-exec below and by nothing else,
 * so a checker can skip work that feeds only a non-gating finding on the
 * baseline side — a network lookup, say — and its profile marks that finding
 * `indexOnly` so the diff never reads the gap as new (#2056).
 */
const SIDE_ENV = "WFC_CHECK_SIDE";

/** @returns {boolean} whether this run is an --against re-exec over <rev> */
const isBaselineSide = () => process.env[SIDE_ENV] === "baseline";

/*
 * The checker name a persist-mode run opened its record under, so the crash
 * reporter closes THAT record rather than one it guessed — see persistCrash.
 * Module-level because one process runs one checker, so there is nothing to key.
 */
/** @type {string | null} */
let openedKey = null;

/*
 * The cap on every child-process stream an `--against` run reads, and on the
 * one exported use in check-context-budget.js: lib/child-buffer.js's, whose
 * header carries the derivation (#1440). Per-stream measurements: mantahostels#1940.
 *
 * Exceeding it is not silent HERE. spawnSync sets `error` to ENOBUFS with a
 * status of 0, so a caller testing only the status would read a truncated
 * stream as a clean one; all three callers below test `error` too and turn it
 * into BROKEN. The exported fourth use deliberately fails open.
 */
const { CHILD_MAX_BUFFER: MAX_BUFFER } = require("./child-buffer.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

const OUTCOMES = {
	OK: { rank: 0, exit: 0 },
	SKIP: { rank: 0, exit: 0 },
	WARN: { rank: 1, exit: 0 },
	FAIL: { rank: 2, exit: 1 },
	BROKEN: { rank: 3, exit: 2 },
};

/**
 * @typedef {"OK" | "SKIP" | "WARN" | "FAIL" | "BROKEN"} Outcome
 * @typedef {{ severity: "FAIL" | "WARN", tag: string, message: string, key?: string, [k: string]: unknown }} Finding
 *   `key` is the finding's stable IDENTITY, and the only field a set-diffing
 *   reader may compare (mantahostels#2490).
 * @typedef {{ okLine?: string, noun?: string, count?: number, data?: object,
 *   stamp?: string, stamps?: Record<string, string> }} CheckResult `stamp` is
 *   the once-only delivery signature a persisted report carries so the reader
 *   can stamp it once shown (mantahostels#1975); `stamps` is the same idea for a checker
 *   whose findings do not reduce to one signature — a name-to-signature map
 *   the reader applies entry by entry (mantahostels#2277)
 * @typedef {{
 *   profile: string,
 *   materialise: "tree" | "blobs",
 *   pathspecs?: (ctx: CheckContext, rev: string) => string[],
 *   baseline?: "lazy" | "always",
 *   refuse?: (ctx: CheckContext) => void,
 *   settle?: (ctx: CheckContext, added: FaultItem[]) => { refuse: FaultItem[], remedy: string[], data?: object },
 * }} AgainstSpec `settle`'s `data` joins the --json envelope, under the
 *   envelope's own keys
 * @typedef {{
 *   name: string,
 *   usage: string,
 *   valueFlags?: string[],
 *   flags?: string[],
 *   module?: import("./workflow-core-config.js").ModuleGate,
 *   against?: AgainstSpec,
 *   run: (ctx: CheckContext) => CheckResult | void | Promise<CheckResult | void>,
 * }} CheckSpec
 *
 * @typedef {{ lines: string[], notify: typeof import("./notify-report.js"),
 *   startedAtMono: number }} Persist
 */

/**
 * A checker whose spec names a `module` the host config does not list SKIPs
 * with the one line naming it (#2) — the first that is off, where the spec
 * names several (#418) — before --against materialises anything, so a
 * module-off commit pays no tree extraction. Read at the host root, never
 * --root's tree, because the opt-in is the host's and not the commit's.
 * @param {import("./workflow-core-config.js").ModuleGate} modules
 */
function skipUnlessModuleOn(modules) {
	const config = require("./workflow-core-config.js");
	let off;
	try {
		off = config.firstModuleOff(modules);
	} catch (e) {
		throw brokenError(caught(e).message);
	}
	if (off) throw skipError(config.buildModuleOffLine(off));
}

/** The context handed to a checker's run(). */
class CheckContext {
	/**
	 * @param {string[]} argv
	 * @param {{ usage: string, valueFlags?: string[], capture?: string[],
	 *   persisting?: boolean }} opts
	 */
	constructor(argv, opts) {
		this.argv = argv;
		this.warnOnly = argv.includes("--warn");
		this.asJson = argv.includes("--json");
		/* Whether the envelope also carries say()'s text, as `text` — opt-in,
		 * because `--json` has consumers that assert on what its stdout does NOT
		 * contain (mantahostels#2490). */
		this.jsonText = argv.includes("--json-text");
		this.notify = argv.includes("--notify");
		/* Whether this run persists its report rather than being the delivery
		 * itself — read by lib/delivery-stamp.js (mantahostels#1975). Set from runCheck
		 * rather than re-derived, so one place decides persist mode. */
		this.persisting = Boolean(opts.persisting);
		this.inActions = process.env.GITHUB_ACTIONS === "true";
		/** @type {Finding[]} */
		this.findings = [];
		/* Tracked-file side effects, said last — see dirtied() below and the
		 * ordering note in finish(). */
		/** @type {string[]} */
		this.dirtyNotes = [];
		this._usage = opts.usage;
		/* An in-process caller's own array, collecting say()'s text instead of a
		 * fd — how report-manual-staleness.js reads a checker's human report
		 * without spawning it (mantahostels#2062). Takes priority over every other say()
		 * route, --json included, since capturing IS the point of passing it. */
		this._capture = opts.capture || null;
		/** say()'s text under --json-text, which the envelope carries as `text`. */
		this._jsonLines = /** @type {string[]} */ ([]);
		/* See SAY_FD_ENV. A non-numeric or absent value leaves say() alone. */
		const fd = Number(process.env[SAY_FD_ENV]);
		this._sayFd = Number.isInteger(fd) && fd > 0 ? fd : null;
		/* Bare arguments, in order. Flag VALUES are pulled by name via value()
		 * before this is read, so a checker that takes `--ref main` must declare it
		 * in `valueFlags` or `main` shows up here as a positional. */
		this.args = positionals(argv, opts.valueFlags || []);
	}

	/** @param {string} flag */
	has(flag) {
		return this.argv.includes(flag);
	}

	/**
	 * The value after `--flag`, or `fallback` when absent.
	 *
	 * Two overloads rather than one `string | null` return: a caller that
	 * supplies a fallback can never be handed null, and saying so is what lets
	 * `path.join(ctx.value("--data-dir", dir), …)` type without a cast.
	 *
	 * @overload
	 * @param {string} flag
	 * @returns {string | null}
	 *
	 * @overload
	 * @param {string} flag
	 * @param {string} fallback
	 * @returns {string}
	 *
	 * @param {string} flag
	 * @param {string | null} [fallback]
	 * @returns {string | null}
	 */
	value(flag, fallback = null) {
		const i = this.argv.indexOf(flag);
		if (i === -1) return fallback;
		const v = this.argv[i + 1];
		if (v === undefined || v.startsWith("--"))
			throw brokenError(`${flag} needs a value.\nusage: ${this._usage}`);
		return v;
	}

	/**
	 * Bad invocation is BROKEN, never a finding: nothing was checked.
	 *
	 * @param {string} message
	 * @returns {never}
	 */
	usageError(message) {
		throw brokenError(`${message}\nusage: ${this._usage}`);
	}

	/**
	 * The number after `--flag`, or `fallback` when absent. One that is not
	 * finite, or falls outside `bound`, is a usage error.
	 *
	 * @param {string} flag
	 * @param {number} fallback
	 * @param {"positive" | "non-negative"} bound
	 * @returns {number}
	 */
	numberValue(flag, fallback, bound) {
		const n = this.has(flag) ? Number(this.value(flag)) : fallback;
		const inBound = bound === "positive" ? n > 0 : n >= 0;
		if (!(Number.isFinite(n) && inBound))
			this.usageError(`${flag} must be a ${bound} number.`);
		return n;
	}

	/**
	 * Human-readable report text. Suppressed under --json so stdout stays a
	 * single parseable document.
	 *
	 * writeFd, not console: node buffers writes to a PIPE and drops whatever is
	 * still buffered at process.exit — and a hook's stdout is always a pipe.
	 *
	 * @param {string} message
	 */
	say(message = "") {
		if (this._capture) {
			this._capture.push(message);
			return;
		}
		if (this._sayFd !== null) {
			writeFd(this._sayFd, `${message}\n`);
			return;
		}
		/* Under --json-text the human report is KEPT rather than dropped (mantahostels#2490),
		 * and rides out as the envelope's `text` rather than stdout, which the
		 * envelope owns. */
		if (this.asJson) {
			if (this.jsonText) this._jsonLines.push(message);
			return;
		}
		writeFd(this.notify ? 1 : 2, `${message}\n`);
	}

	/**
	 * A finding that gates (subject to the --warn cap).
	 *
	 * @param {string} tag
	 * @param {string} message
	 * @param {object} [data]
	 * @param {string} [key] the finding's stable identity — see the Finding
	 *   typedef. Spread LAST so a `data` that happens to carry a `key` of its own
	 *   cannot silently become the diffing identity.
	 */
	fail(tag, message, data, key) {
		this.findings.push({
			severity: "FAIL",
			tag,
			message,
			...data,
			...(key === undefined ? {} : { key }),
		});
	}

	/**
	 * A finding that is real but deliberately does not gate.
	 *
	 * @param {string} tag
	 * @param {string} message
	 * @param {object} [data]
	 * @param {string} [key] see fail() above.
	 */
	warn(tag, message, data, key) {
		this.findings.push({
			severity: "WARN",
			tag,
			message,
			...data,
			...(key === undefined ? {} : { key }),
		});
	}

	/**
	 * Could not run; cause is outside the repo. Declared `never` so a checker's
	 * code after the call narrows as unreachable rather than reading as a branch
	 * that falls through (mantahostels#1463).
	 *
	 * @param {string} message
	 * @returns {never}
	 */
	skip(message) {
		throw skipError(message);
	}

	/**
	 * Could not run; cause is tracked in the repo, or the invocation is wrong.
	 * `never` for the same reason skip() is.
	 *
	 * @param {string} message
	 * @returns {never}
	 */
	broken(message) {
		throw brokenError(message);
	}

	/**
	 * A tracked file this run wrote to, whatever severity the run itself ended
	 * up at — the "clean, but I changed a tracked file" channel mantahostels#2665 built.
	 * status-report.js's verdict() (`scripts/status-report.js:177-183`) drops a
	 * checker's whole report when its LAST line is its own OK:/SKIP: summary,
	 * so an append that happened during an otherwise-clean run went unreported.
	 * Reaches only the PLAIN human route: suppressed under --notify (see
	 * finish()), and under --json/--json-text nothing carries it either —
	 * say() itself drops the message there (`--json`) or would route it
	 * through `_jsonLines`, which dirtied() never feeds.
	 *
	 * @param {string} message
	 */
	dirtied(message) {
		this.dirtyNotes.push(message);
	}
}

/**
 * Bare args, with declared flag values and their flags removed.
 *
 * @param {string[]} argv
 * @param {string[]} valueFlags
 * @returns {string[]}
 */
function positionals(argv, valueFlags) {
	/** @type {string[]} */
	const out = [];
	const args = argv.values();
	for (const a of args) {
		if (valueFlags.includes(a)) {
			args.next();
			continue;
		}
		if (a.startsWith("--")) continue;
		out.push(a);
	}
	return out;
}

/**
 * Why argv is refused for naming a flag this checker never reads, or null
 * (#938). A declared flag spelled `--name=value` is refused too: has() and
 * value() match whole tokens, so it would be dropped just the same.
 *
 * @param {string[]} ownArgs argv before any bare `--`
 * @param {string[]} valueFlags
 * @param {Set<string>} accepted
 * @returns {string | null}
 */
function flagRefusal(ownArgs, valueFlags, accepted) {
	const args = ownArgs.values();
	for (const a of args) {
		if (valueFlags.includes(a)) {
			args.next();
			continue;
		}
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		const name = eq === -1 ? a : a.slice(0, eq);
		if (!accepted.has(name)) return `unknown flag: ${name}`;
		if (eq !== -1)
			return `${name} takes its value as the next argument, not after "=".`;
	}
	return null;
}

/** @type {(a: Outcome, b: Outcome) => Outcome} */
const worst = (a, b) => (OUTCOMES[a].rank >= OUTCOMES[b].rank ? a : b);

// --- --against ---------------------------------------------------------------

/** git's empty tree, the baseline a repo with no commits compares against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Whether this repo holds no commit by any ref — the unborn HEAD an adopter's
 * first commit is made against, as opposed to a HEAD that exists and cannot be
 * read, which is an apparatus fault and must stay one.
 */
function unborn() {
	const r = spawnGitSync(["rev-list", "--all", "--count"], {
		encoding: "utf8",
	});
	return r.status === 0 && r.stdout.trim() === "0";
}

/**
 * The rev a diff against `rev` reads. The baseline against an unborn HEAD is
 * the empty tree: every fault the index carries is new, which is the truth
 * about a first commit rather than a checker that cannot run (#5).
 *
 * @param {string} rev
 */
function baselineOf(rev) {
	if (rev !== "HEAD") return rev;
	return readCommitOrBroken(rev) === null && unborn() ? EMPTY_TREE : rev;
}

/**
 * `git`, with a non-zero exit reported as APPARATUS — BROKEN, never a finding.
 *
 * @param {string[]} args
 * @param {string} what
 * @returns {string}
 */
function git(args, what, env = process.env) {
	const r = spawnGitSync(args, { encoding: "utf8", env });
	if (r.error || r.status !== 0)
		throw brokenError(
			`git ${args[0]} failed while ${what}: ` +
				`${(r.stderr || "").trim() || r.error?.message || `exit ${r.status}`}`,
		);
	return r.stdout;
}

/**
 * The index as a tree object, so the side being judged is the bytes this commit
 * carries rather than the shared worktree's (mantahostels#1801 Q2).
 *
 * AGAINST A PRIVATE COPY OF THE INDEX, never the index itself: `git write-tree`
 * refreshes what it reads and takes `index.lock` to do it, and by the time a
 * pre-commit hook runs, `git commit` is already holding that lock — so reading
 * the real one fails outright, and off a hook it would collide with whichever
 * parallel session is mid-commit. The copy is safe to take at any moment: git
 * replaces an index by rename, so a reader sees the whole of one version or the
 * whole of the other.
 *
 * `--git-path index` RATHER THAN `.git/index`. `git commit -- <paths>` — this repo's committing convention (mantahostels#63) — builds a
 * temporary index holding only those paths and points its hooks at it through
 * GIT_INDEX_FILE, which is exactly what `--git-path index` resolves to when it
 * is set. Spelling `.git/index` would judge the WHOLE index there, a
 * neighbour's staged files included.
 *
 * @param {string} privateIndex
 * @returns {string}
 */
function indexTree(privateIndex) {
	const live = git(
		["rev-parse", "--git-path", "index"],
		"locating the index",
	).trim();
	/* Absent in a repo where nothing has ever been staged; write-tree then
	 * creates the copy itself and answers with the empty tree. */
	if (fs.existsSync(live)) fs.copyFileSync(live, privateIndex);
	return git(["write-tree"], "reading the index", {
		...process.env,
		GIT_INDEX_FILE: privateIndex,
	}).trim();
}

/**
 * The whole of `rev` extracted into `dir`.
 *
 * @param {string} rev
 * @param {string} dir
 */
function extractTree(rev, dir) {
	const tar = path.join(dir, "tree.tar");
	git(["archive", "--format=tar", "-o", tar, rev], `extracting ${rev}`);
	const x = spawnSync("tar", ["-xf", tar, "-C", dir], { encoding: "utf8" });
	if (x.error || x.status !== 0)
		throw brokenError(
			`could not unpack ${rev}: ${(x.stderr || "").trim() || x.error?.message}`,
		);
	fs.rmSync(tar, { force: true });
}

/**
 * How a rev becomes a directory a checker can be pointed at with --root.
 *
 * `tree` is the whole rev extracted, for a checker that DISCOVERS its own scan
 * roots by walking — the alternative, spelling those roots out again here, is a
 * second copy of a scope that drifts with nothing keeping the two in step
 * (mantahostels#1753).
 *
 * `blobs` is the paths a `pathspecs()` names, fetched by sha, for a checker
 * whose scan scope IS a declared pathspec (mantahostels#1834). It exists to keep the cheap
 * path cheap: extracting mantahostels' whole 19 MB tree cost 0.42 s a side, where
 * the two pathspec checkers between them name a few hundred KB, so putting them
 * on `tree` would be a measured cost regression for no reading they could not
 * already do.
 *
 * @type {Record<string, (rev: string, dir: string, pathspecs: string[]) => void>}
 */
const MATERIALISERS = {
	tree: extractTree,

	blobs(rev, dir, pathspecs) {
		/* A pathspec set that names nothing is a gate about to go green over scope
		 * it never looked at. */
		if (pathspecs.length === 0)
			throw brokenError(
				`${AGAINST} asked for a blob fetch at ${rev} and the spec named no pathspec.`,
			);
		const entries = listTree(rev, pathspecs);

		/* A pathspec that resolved and matched nothing is NOT the refusal above
		 * (mantahostels#1940). An empty spec is a fault in the spec — apparatus, and this
		 * library's to judge. An empty listing is a fact about the REVISION,
		 * which both sides read the same way, and what it means is the checker's
		 * to say. */
		if (entries.length === 0) return;

		/* One `cat-file --batch` for the lot: the per-blob alternative is a process
		 * per file. */
		const bodies = readObjectBatch(
			entries.map((e) => e.sha),
			`${rev}'s blobs`,
		);

		for (const [i, e] of entries.entries()) {
			/* cat-file rightly says a gitlink is missing. Nothing downstream
			 * measures a submodule, so it is skipped rather than refused. */
			if (e.mode === GIT_MODE.gitlink) continue;
			const body = bodies[i]?.body;
			/* git listed the entry and then would not hand it over, so the tree we
			 * are about to judge is incomplete. Counting the path 0 B would read as
			 * a SHED to a cap gate and pass the very commit that broke it (mantahostels#1834). */
			if (!body)
				throw brokenError(
					`git cat-file would not return ${rev}'s blob for ${e.path}, ` +
						"which ls-tree had listed.",
				);
			writeEntry(e, body, { rev, dir });
		}
	},
};

/**
 * @param {{ mode: string, path: string }} e
 * @param {Buffer} body
 * @param {{ rev: string, dir: string }} at
 */
function writeEntry(e, body, { rev, dir }) {
	const dest = path.join(dir, e.path);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	/* A symlink is written back as a symlink, not as its target's path in a
	 * file: check-context-budget.js draws its own/vendored split with
	 * lstat().isSymbolicLink(), so flattening one here would charge a
	 * vendored skill's description to the capped pool. */
	if (e.mode === GIT_MODE.symlink) {
		const target = body.toString("utf8");
		/* git stores the target verbatim, absolute paths included, and every
		 * reader downstream stats through the link. A target resolving outside
		 * the materialised tree therefore reads the live working tree — the
		 * one thing --against exists to stop, and it fails OPEN: both sides
		 * read the same live bytes and agree, so the gate passes (mantahostels#1834). */
		const landing = path.resolve(path.dirname(dest), target);
		const root = path.resolve(dir);
		if (!isUnder(landing, [root], path.sep))
			throw brokenError(
				`${rev}'s ${e.path} is a symlink to ${target}, which resolves ` +
					"outside the materialised tree — reading it would judge the " +
					"working tree rather than the commit.",
			);
		fs.symlinkSync(target, dest);
		return;
	}
	fs.writeFileSync(dest, body);
}

/**
 * This same checker, re-run against a materialised tree, as its --json envelope.
 *
 * `stream` puts the child's own human report on our stderr — see SAY_FD_ENV.
 * The baseline side is silent.
 *
 * The parent's POSITIONALS are forwarded: a checker whose scan roots are bare
 * arguments (`check-website-copy.js app docs`) would otherwise read its default
 * root on both sides and judge a scope nobody asked about. Flags are not — the
 * child's invocation is this library's, not the caller's.
 *
 * @param {string} dir
 * @param {string} label
 * @param {{ stream: boolean, side: "index" | "baseline" }} opts
 * @param {string[]} args
 * @returns {{ outcome: Outcome, summary: string, envelope: Record<string, unknown> }}
 */
function reread(dir, label, { stream, side }, args) {
	const self = process.argv[1];
	if (self === undefined)
		throw brokenError(`process.argv names no script to re-run over ${label}.`);
	const r = spawnSync(
		process.execPath,
		[self, "--root", dir, "--json", ...args],
		{
			encoding: "utf8",
			maxBuffer: MAX_BUFFER,
			stdio: ["ignore", "pipe", stream ? "inherit" : "ignore"],
			env: {
				...process.env,
				[SIDE_ENV]: side,
				...(stream && { [SAY_FD_ENV]: "2" }),
			},
		},
	);
	if (r.error)
		throw brokenError(
			`could not re-run this check over ${label}: ${r.error.message}`,
		);
	let envelope;
	try {
		envelope = JSON.parse(r.stdout);
	} catch (e) {
		throw brokenError(
			`this check produced no readable --json envelope over ${label} (exit ${r.status}).`,
			{ cause: e },
		);
	}
	const outcome = /** @type {Outcome} */ (envelope?.outcome);
	if (!OUTCOMES[outcome])
		throw brokenError(`this check's envelope over ${label} names no outcome.`);
	return { outcome, summary: String(envelope.summary ?? ""), envelope };
}

/**
 * THE FIGURE A SHED IS MEASURED AGAINST (mantahostels#1939).
 *
 * The refusal a measurement-carrying fault prints is written by the CHILD, in
 * report mode, which has read one revision and so knows one number: "the pool
 * is 38,200 B against a 38,000 B cap". Its own instruction is to name the shed
 * that pays for the bytes, and a shed is sized on the DELTA — a session told a
 * surface is 1,037 B over cap cannot otherwise tell whether it added 20 of them
 * or 900. Both readings exist only here, so the line is composed here and
 * printed under the parent's own fault list rather than inside the child's
 * refusal.
 *
 * IT BELONGS TO EVERY MEASURING PROFILE, NOT TO ONE CHECKER. `family`/`worse`
 * already generalise "a fault carrying a number" (lib/fault-diff.js), and
 * `measure` is the third member of that set: it reads ONE fault's subject out
 * of EITHER envelope, so passing the staged item against the baseline gives the
 * same surface at <rev>. Nothing here knows what is being measured, and a
 * profile without `measure` prints exactly what it printed before.
 *
 * NOT THE BASELINE'S OWN FAULT LIST, which is why `measure` takes an envelope
 * and not a kin item: a commit that FIRST breaches a cap faces a baseline
 * carrying no fault for that surface at all, and that is precisely the commit
 * whose delta is worth printing.
 *
 * @param {import("./fault-diff.js").FaultDiffProfile} profile
 * @param {{ key: string, item: unknown }} fault
 * @param {{ staged: Record<string, unknown>, baseline: Record<string, unknown> | undefined, rev: string }} envelopes
 * @returns {{ base: number, delta: number, line: string } | undefined}
 */
function measuredDelta(profile, fault, { staged, baseline, rev }) {
	if (!profile.measure || !baseline) return;
	const now = profile.measure(fault.item, fault.key, staged);
	const base = profile.measure(fault.item, fault.key, baseline);
	/* Silence rather than a guess: a profile that measures some of its keys and
	 * not others is the ordinary case, and half a delta is worse than none. */
	if (typeof now !== "number" || typeof base !== "number") return;
	const delta = now - base;
	/* A NON-POSITIVE DELTA IS NOT A CASE TO PHRASE, so the answer to it is
	 * silence: "this commit adds -40 B" would send the reader shedding bytes
	 * that are not the cause.
	 *
	 * IT IS A GUARD, NOT DEAD CODE. Whether a fault can be new for a reason the
	 * measurement does not explain is a property of the PROFILE, not of this
	 * function. Unreachable through the one profile that measures today
	 * (mantahostels#1939), and nothing keeps it so: a profile whose `measure` outruns its
	 * `worse` lands here, and gets silence instead of nonsense. */
	if (delta <= 0) return;
	const u = ` ${profile.unit}`;
	const line = `  ${rev} had ${base}${u}, so this commit adds ${delta}${u}.`;
	return { base, delta, line };
}

/**
 * The whole --against run: materialise, re-exec twice, diff.
 *
 * Findings are about DIRECTION and nothing else.
 *
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @returns {CheckResult}
 */
function runAgainst(spec, ctx) {
	const { against, rev, head } = readAgainst(spec, ctx);

	// Required lazily: most checkers load this library and never direction-gate.
	const { PROFILES } = require("./fault-profiles.js");
	const profile = PROFILES[against.profile];
	if (!profile)
		ctx.broken(
			`lib/fault-profiles.js carries no ${against.profile} profile, so there is ` +
				"no rule for what makes two of this check's faults the same fault.",
		);

	const materialise = MATERIALISERS[against.materialise];
	if (!materialise)
		ctx.broken(
			`no ${against.materialise} materialisation — expected one of ${Object.keys(MATERIALISERS).join(", ")}.`,
		);

	const baseRev = baselineOf(rev);

	/* Resolved BEFORE the index is read, not when the baseline is: the baseline
	 * is only materialised where there is a fault to attribute, so a typo'd rev
	 * would otherwise pass every clean commit in silence. */
	git(["rev-parse", "--verify", `${baseRev}^{tree}`], `resolving ${baseRev}`);
	const headTree =
		head &&
		git(
			["rev-parse", "--verify", `${head}^{tree}`],
			`resolving ${head}`,
		).trim();

	const sides = compareSides(spec, ctx, {
		against,
		profile,
		materialise,
		revs: { rev, baseRev, head, headTree },
	});
	const { added, inherited, notes, commit, baselineSummary } = sides;

	/** The measurement both sides carry, where the profile can read one. */
	const measured = (/** @type {FaultItem} */ f) =>
		measuredDelta(profile, f, {
			staged: commit.envelope,
			baseline: sides.baselineEnvelope,
			rev,
		});

	/* The checker's own last word on what it adds, run in the PARENT, where the
	 * live tree and the session's claims are readable: the exemptions only it
	 * can judge, and the way out it owes the refusal. */
	const {
		refuse,
		remedy,
		data: settled,
	} = against.settle?.(ctx, added) ?? {
		refuse: added,
		remedy: [],
	};

	const judged = head ?? "this commit";
	reportAgainst(
		ctx,
		{ added: refuse, inherited, notes, rev, judged },
		measured,
	);
	for (const line of refuse.length > 0 ? remedy : []) ctx.say(line);

	return {
		okLine: `no gating fault in ${head ?? "the index"} that ${rev} does not already carry.`,
		noun: refuse.length > 0 ? `fault(s) ${judged} adds` : "inherited fault(s)",
		data: {
			...settled,
			against: rev,
			added: refuse.map((f) => f.line),
			inherited,
			notes: notes.map((f) => f.line),
			indexSummary: commit.summary,
			baselineSummary,
		},
	};
}

/** @typedef {{ key: string, item: unknown, line: string }} FaultItem */

/**
 * The baseline rev and, under `--head`, the judged commit.
 *
 * @param {CheckContext} ctx
 * @returns {{ rev: string, head: string | undefined }}
 */
function againstRevs(ctx) {
	return {
		rev: ctx.value(AGAINST, ""),
		head: ctx.value(HEAD_FLAG, "") || undefined,
	};
}

/**
 * The --against spec and rev, refusing any invocation that cannot direction-gate.
 *
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @returns {{ against: AgainstSpec, rev: string, head: string | undefined }}
 */
function readAgainst(spec, ctx) {
	const against = spec.against;
	if (!against)
		ctx.usageError(
			`${spec.name} does not direction-gate, so it takes no ${AGAINST}.`,
		);
	if (ctx.has("--root"))
		ctx.usageError(
			`${AGAINST} materialises its own trees, so it cannot be combined with --root.`,
		);

	const rev = ctx.value(AGAINST, "");
	if (!rev) ctx.usageError(`${AGAINST} needs a rev.`);

	/* AFTER the rev is read and BEFORE anything reads the repo (mantahostels#1940). Above
	 * the rev check, a bare `--against` with no value reports the checker's own
	 * usage complaint instead of the missing value; below any git call, the git
	 * failure gets there first and the usage error is lost. */
	if (against.refuse) against.refuse(ctx);
	const head = ctx.has(HEAD_FLAG) ? ctx.value(HEAD_FLAG, "") : undefined;
	if (head === "") ctx.usageError(`${HEAD_FLAG} needs a rev.`);
	return { against, rev, head };
}

/**
 * Re-runs the checker over the index and, where there is a gating fault to
 * attribute, over the baseline, and diffs the two.
 *
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @param {{ against: AgainstSpec,
 *   profile: import("./fault-diff.js").FaultDiffProfile,
 *   materialise: (rev: string, dir: string, pathspecs: string[]) => void,
 *   revs: { rev: string, baseRev: string, head?: string, headTree?: string } }} at
 */
function compareSides(spec, ctx, { against, profile, materialise, revs }) {
	const { newFaultItems } = require("./fault-diff.js");
	const { rev, baseRev, head, headTree } = revs;
	const gate = profile.gating ?? (() => true);
	const work = fs.mkdtempSync(
		path.join(os.tmpdir(), `check-against-${spec.name}-`),
	);
	/** A rev read by this same checker, in a directory removed on the way out. */
	const read = (
		/** @type {string} */ rev_,
		/** @type {string} */ label,
		/** @type {"index" | "baseline"} */ which,
	) => {
		const dir = fs.mkdtempSync(path.join(work, "tree-"));
		/* Resolved PER SIDE, not once: a pathspec set read out of the tree it
		 * describes — check-context-budget.js's injected-docs array is one — can
		 * legitimately differ between the index and <rev>, and pinning one side's
		 * list onto the other would measure a file the rev does not name. */
		materialise(rev_, dir, against.pathspecs?.(ctx, rev_) ?? []);
		return reread(
			dir,
			label,
			{ stream: which === "index" && !ctx.asJson, side: which },
			ctx.args,
		);
	};

	let added = /** @type {FaultItem[]} */ ([]);
	let inherited = /** @type {string[]} */ ([]);
	let notes = /** @type {FaultItem[]} */ ([]);
	/* The envelopes outlive the directories they were read from: measuredDelta
	 * reads this one after the trees are removed. */
	let baselineEnvelope = /** @type {Record<string, unknown> | undefined} */ (
		undefined
	);
	let baselineSummary =
		"unread — the index carries no gating fault to attribute";
	try {
		/* Unreferenced, and collected with every other loose object. */
		const commitSide = headTree ?? indexTree(path.join(work, "index-copy"));
		const commit = read(commitSide, head ?? "the index", "index");

		/* The index side did not finish, so it has no fault list to compare —
		 * carry its verdict rather than inventing one. */
		/* The summary already carries its own outcome word, so it is stripped
		 * rather than passed whole: `broken()` adds one, and "BROKEN: BROKEN: …"
		 * reads as two failures. */
		const carry = (/** @type {string} */ s) => s.replace(/^\w+: /, "");
		if (commit.outcome === "BROKEN") ctx.broken(carry(commit.summary));
		if (commit.outcome === "SKIP") ctx.skip(carry(commit.summary));

		/* Every gating fault the index side has, by diffing it against nothing. */
		const gating = newFaultItems(commit.envelope, {}, profile);
		/* THE BASELINE IS READ ONLY WHEN THERE IS SOMETHING TO ATTRIBUTE. A clean
		 * index is the ordinary case and needs no <rev> at all, which keeps the
		 * green-path cost at one materialisation rather than two (mantahostels#1833).
		 *
		 * `baseline: "always"` opts out, for a checker whose NON-gating findings
		 * are also direction-dependent — check-context-budget.js's admissibility
		 * prompt fires on a pool that grew without breaching anything, so a lazy
		 * baseline would silence it on exactly the commits it exists for. Only a
		 * blob fetch may ask: on `tree` the second extraction is the 0.42 s the
		 * laziness was bought to avoid (mantahostels#1834). */
		if (gating.length > 0 || against.baseline === "always") {
			const baseline = read(baseRev, rev, "baseline");
			baselineSummary = baseline.summary;
			baselineEnvelope = baseline.envelope;
			/* FAILING CLOSED: an unanswerable baseline must not read as
			 * "inherited", which is the answer that passes the commit. */
			if (baseline.outcome === "BROKEN" || baseline.outcome === "SKIP")
				ctx.broken(
					`no readable ${rev} baseline to compare against — ${baseline.summary}`,
				);
			added = newFaultItems(commit.envelope, baseline.envelope, profile);
			const addedLines = added.map((f) => f.line);
			inherited = gating
				.filter((f) => !profile.newOnly?.(f.key))
				.map((f) => f.line)
				.filter((line) => !addedLines.includes(line));
			/* The same diff over what the profile does NOT gate on. A non-gating
			 * finding says something true about the commit — that the pool grew —
			 * and dropping it silently would lose mantahostels#1177's prompt. It warns
			 * and never refuses. */
			notes = newFaultItems(commit.envelope, baseline.envelope, {
				...profile,
				gating: (item, key) => !gate(item, key),
			});
		}
		return {
			added,
			inherited,
			notes,
			commit,
			baselineEnvelope,
			baselineSummary,
		};
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Says what the diff found: faults this commit adds, else the inherited ones
 * it passes over, and every non-gating note.
 *
 * @param {CheckContext} ctx
 * @param {{ added: FaultItem[], inherited: string[], notes: FaultItem[],
 *   rev: string, judged: string }} found
 * @param {(f: FaultItem) => { base: number, delta: number, line: string } | undefined} measured
 */
function reportAgainst(
	ctx,
	{ added, inherited, notes, rev, judged },
	measured,
) {
	if (added.length > 0) {
		ctx.say(`The fault(s) below are NOT in ${rev} — ${judged} adds them:`);
		for (const f of added) {
			const d = measured(f);
			ctx.fail("NEW-FAULT", f.line, {
				against: rev,
				...(d && { base: d.base, delta: d.delta }),
			});
			ctx.say(`  ${f.line}`);
			if (d) ctx.say(d.line);
		}
	} else if (inherited.length > 0) {
		for (const line of inherited)
			ctx.warn("INHERITED-FAULT", line, { against: rev });
		ctx.say(
			`Every gating fault reported above is already in ${rev}, so ${judged} did not cause one — passing (mantahostels#1753).`,
		);
		ctx.say(
			"  They still FAIL the scheduled sweeps, which run a clean checkout, and block nothing here only because they are inherited.",
		);
	}

	for (const f of notes) {
		const d = measured(f);
		ctx.warn("NEW-NOTE", f.line, {
			against: rev,
			...(d && { base: d.base, delta: d.delta }),
		});
		ctx.say(f.line);
		if (d) ctx.say(d.line);
	}
}

/**
 * Persist a crash summary, returning whether it landed. Anything at all going
 * wrong returns false and the stream route below carries the summary instead:
 * this runs inside the uncaughtException handler, where a second throw would
 * end the process with nothing printed anywhere.
 *
 * KEYED ON THE RECORD ACTUALLY OPENED wherever there is one. A key derived
 * from the filename disagrees with `spec.name` the moment a checker names
 * itself anything but its own basename minus `check-`, and closing the wrong
 * key orphans the real record — which the reader reads as a cancellation,
 * for good (mantahostels#1974).
 *
 * The derived name is the fallback for the case this reporter exists for: a
 * throw during the checker's own top-level requires, where no spec was ever
 * read and no record was ever opened.
 *
 * @param {string} name basename of the crashing script
 * @param {string} summary
 */
function persistCrash(name, summary) {
	try {
		const notify = loadNotify();
		const key = openedKey || name.replace(/\.js$/, "").replace(/^check-/, "");
		const wrote = notify.writeReport(key, {
			outcome: "BROKEN",
			text: `${summary}\n`,
			owner: sessionFromEnv(),
		});
		// CLOSED ONLY WHERE THE REPORT LANDED. Closing after a failed write
		// leaves no report AND no open record: the run vanishes, which is
		// mantahostels#1899's own class reintroduced on the path added to catch it. Left
		// open, a dead pid reads as cancelled — wrong about the cause, but
		// visible.
		if (wrote) notify.closeRun(key);
		return wrote;
	} catch {
		return false;
	}
}

/**
 * THE LAST-RESORT REPORTER (mantahostels#1899).
 *
 * runCheck's own try/catch begins after the checker's top-level `require()`s
 * have run and after `new CheckContext(...)` has parsed argv, so a throw in
 * either is outside it: node prints a stack to STDERR and exits non-zero. A
 * SessionStart hook injects STDOUT alone (see the Streams note above) and
 * settings.json wraps each of these in `|| true`, so both signals are
 * discarded and the checker vanishes — running, reporting nothing, for as long
 * as nobody thinks to run it by hand (mantahostels#1854).
 *
 * Installed at require time so it covers the checker's own later requires. The
 * throw becomes a BROKEN line on whichever stream the run's own flags say a
 * reader is on — read off `process.argv` rather than off a ctx, because the
 * case this exists for includes the one where the ctx could not be built.
 *
 * @param {unknown} e
 * @returns {never}
 */
function reportCrash(e) {
	const argv = process.argv.slice(2);
	const notify = argv.includes("--notify");
	const name = path.basename(process.argv[1] || "a checker");
	/* The stack, not the message: at this point nobody knows what happened, and
	 * this is the only place it will ever be printed. */
	const said = (e instanceof Error && e.stack) || errMessage(e);
	const summary = `BROKEN: ${name} threw before it could check anything: ${said}`;
	/* Persist mode has to reach this path too, or the class mantahostels#1899 exists to
	 * catch goes back to being invisible under an `async` hook.
	 *
	 * Where no record was opened the key is derived from the FILE, no spec
	 * having been read. A checker naming itself something else lands its crash
	 * under a second key rather than overwriting its report; the reader
	 * enumerates the directory, so it is still delivered. */
	if (persisting(argv) && persistCrash(name, summary)) process.exit(0);
	if (argv.includes("--json"))
		writeFd(
			1,
			`${JSON.stringify({ checker: name, outcome: "BROKEN", exit: notify ? 0 : 2, summary })}\n`,
		);
	else writeFd(notify ? 1 : 2, `${summary}\n`);
	/* --notify exits 0, as exitFor does and for its reason. */
	process.exit(notify ? 0 : 2);
}

process.on("uncaughtException", reportCrash);
process.on("unhandledRejection", reportCrash);

/**
 * Run a checker and end the process.
 *
 * spec:
 *   name        checker name, as it appears in the --json envelope
 *   usage       one-line usage string, printed on a usage error
 *   valueFlags  flags that take a value (`["--ref"]`), so neither positionals()
 *               nor the unknown-flag refusal mistakes the value for an argument
 *   flags       the boolean flags run() reads (`["--all"]`). Any flag outside
 *               these two lists and the library's own is refused as BROKEN
 *               before any work (#938)
 *   against     present on a direction-gating checker alone, and what makes
 *               `--against <rev>` legal at all — see the header. Names the
 *               lib/fault-profiles.js profile that decides what makes two of
 *               its faults the same fault, the materialisation its scan scope
 *               needs, and optionally a refuse() for any argument it cannot
 *               honour — a flag pair, or a positional run() would have judged,
 *               and a settle() that, given the faults the commit adds, returns
 *               those that refuse it and the remedy lines printed after them.
 *               A spec with an async run() is refused as BROKEN: no
 *               direction-gating checker is async yet, so that path is unbuilt
 *               (#1586)
 *   run(ctx)    the checker's own logic. Returns, or resolves a Promise to —
 *               runCheck awaits it, and a rejection is classified as a throw:
 *                 okLine the OK line, used when nothing was found
 *                 noun   what the summary counts ("stranded artefacts")
 *                 count  overrides the finding count where the checker counts
 *                        something finer than its own findings (citations are
 *                        counted per citation, not per issue)
 *                 data   checker-specific payload for the --json envelope
 *
 * @param {CheckSpec} spec
 */
function runCheck(spec) {
	const argv = process.argv.slice(2);
	/* Before any work, as lib/cli-args.js answers it (#920). */
	const ownArgs = argv.includes("--")
		? argv.slice(0, argv.indexOf("--"))
		: argv;
	exitOnHelp(ownArgs, spec.usage);
	/* Persist mode routes say() into an array instead of a fd, so the decision
	 * is taken here — before the ctx exists — and the captured lines become the
	 * report file's text in finish(). `capture`'s other user builds its own ctx
	 * (mantahostels#2062), so the two never contend. */
	const persist = persisting(argv)
		? {
				lines: /** @type {string[]} */ ([]),
				notify: loadNotify(),
				startedAtMono: performance.now(),
			}
		: null;
	/* --against is the library's own flag, so its rev is declared a flag VALUE
	 * for every checker rather than by each spec — otherwise the rev lands in
	 * ctx.args as a positional in whichever checker forgot. */
	const valueFlags = [
		...(spec.valueFlags || []),
		AGAINST,
		HEAD_FLAG,
		...(spec.against ? AGAINST_FLAGS : []),
	];
	const accepted = new Set([
		...LIBRARY_FLAGS,
		...valueFlags,
		...(spec.flags || []),
	]);
	const ctx = new CheckContext(argv, {
		usage: spec.usage,
		valueFlags,
		capture: persist ? persist.lines : undefined,
		persisting: Boolean(persist),
	});
	/* Opened before any work and closed in finish(), so a run cut off midway
	 * leaves the record standing — which is the whole signal a reader has that
	 * a producer was cancelled rather than merely quiet (mantahostels#1949). */
	if (persist) {
		openedKey = spec.name;
		persist.notify.openRun(spec.name);
	}
	const run = runBody(spec, ctx, () =>
		flagRefusal(ownArgs, valueFlags, accepted),
	);
	if (run instanceof Promise) finishWhenSettled(ctx, spec, run, persist);
	else finish(ctx, spec, run, persist);
}

/**
 * runCheck's tail for an async run() (#1586).
 *
 * @param {CheckContext} ctx
 * @param {CheckSpec} spec
 * @param {Promise<Ran>} run
 * @param {Persist | null} persist
 */
function finishWhenSettled(ctx, spec, run, persist) {
	/* A rejection run() started but never awaited — the second of two parallel
	 * reads, failing while the first is awaited — misses run's own Promise.
	 * Ahead of reportCrash, so it folds as a throw would. */
	process.prependOnceListener("unhandledRejection", (e) =>
		finish(ctx, spec, fromThrow(spec, e), persist),
	);
	/* A run() awaiting something that can never settle leaves node an empty
	 * loop, and node then exits 0 having printed nothing. finish() exits, so
	 * this fires only if it never ran. */
	process.once("beforeExit", () =>
		finish(
			ctx,
			spec,
			{
				outcome: "BROKEN",
				result: {},
				message:
					`${spec.name}'s run() returned a Promise that never settled — ` +
					"every await in run() must resolve or reject.",
			},
			persist,
		),
	);
	run.then((ran) => finish(ctx, spec, ran, persist)).catch(reportCrash);
}

/**
 * @param {string[]} ownArgs
 * @param {string} usage
 */
function exitOnHelp(ownArgs, usage) {
	if (ownArgs.includes("--help") || ownArgs.includes("-h")) {
		writeFd(1, `usage: ${usage}\n`);
		process.exit(0);
	}
}

/**
 * The checker's own run, or `--against`'s, folded into an outcome — a thrown
 * SKIP or BROKEN included. A run() returning a thenable gets a Promise of the
 * same, its rejection folded exactly as a throw; a synchronous run() gets its
 * outcome synchronously.
 *
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @param {() => string | null | undefined} refusalOf
 * @returns {Ran | Promise<Ran>}
 */
function runBody(spec, ctx, refusalOf) {
	try {
		const refusal = refusalOf();
		if (refusal) ctx.usageError(refusal);
		if (spec.module) skipUnlessModuleOn(spec.module);
		/* Caught by its keyword before any work, because under --against the
		 * parent never calls run() — only the re-exec'd children do. */
		if (spec.against && require("node:util").types.isAsyncFunction(spec.run))
			throw brokenError(asyncAgainstRefusal(spec));
		if (ctx.has(HEAD_FLAG) && !ctx.has(AGAINST))
			ctx.usageError(
				`${HEAD_FLAG} names the judged side of ${AGAINST}, so it needs one.`,
			);
		const returned = ctx.has(AGAINST) ? runAgainst(spec, ctx) : spec.run(ctx);
		if (!isThenable(returned)) return fromReturn(ctx, returned);
		if (spec.against) {
			/* A plain function returning a thenable reaches here instead (#1586).
			 * Its work has started, so its rejection is swallowed rather than left
			 * to reportCrash, which would end the process first. */
			returned.then(undefined, () => {
				/* The refusal below is the report. */
			});
			throw brokenError(asyncAgainstRefusal(spec));
		}
		return Promise.resolve(returned).then(
			(value) => fromReturn(ctx, value),
			(e) => fromThrow(spec, e),
		);
	} catch (e) {
		return fromThrow(spec, e);
	}
}

/** @typedef {{ outcome: Outcome, result: CheckResult, message: string }} Ran */

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
function isThenable(value) {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (/** @type {{then?: unknown}} */ (value).then) === "function"
	);
}

/** @param {CheckSpec} spec */
function asyncAgainstRefusal(spec) {
	return (
		`${spec.name} declares \`against\` and its run() is async, but --against ` +
		"has no async path yet (#1586) — make run() synchronous, or build that path."
	);
}

/**
 * @param {CheckContext} ctx
 * @param {CheckResult | void} returned
 * @returns {Ran}
 */
function fromReturn(ctx, returned) {
	/** @type {Outcome} */
	let outcome = "OK";
	for (const f of ctx.findings) outcome = worst(outcome, f.severity);
	// The cap, applied to the outcome and never to the findings themselves.
	// Reached by a completed run alone, so it cannot touch a SKIP or BROKEN.
	if (ctx.warnOnly && outcome === "FAIL") outcome = "WARN";
	return { outcome, result: returned || {}, message: "" };
}

/**
 * A throw or a rejection, folded into its outcome.
 *
 * @param {CheckSpec} spec
 * @param {unknown} e
 * @returns {Ran}
 */
function fromThrow(spec, e) {
	if (e instanceof Error) {
		const thrown = outcomeOf(e);
		if (thrown) return { outcome: thrown, result: {}, message: e.message };
	}
	/* An unexpected throw is the checker being broken, not a finding about
	 * the thing it checks. The stack goes out because at this point nobody
	 * knows what happened. */
	const stack = e instanceof Error ? e.stack : undefined;
	const named = e instanceof Error ? e.name : "a value with no message";
	return {
		outcome: "BROKEN",
		result: {},
		message: `unhandled error in ${spec.name}: ${stack || caught(e).message || named}`,
	};
}

/**
 * @param {CheckContext} ctx
 * @param {CheckSpec} spec
 * @param {Ran} ran
 * @param {Persist | null} persist present under persist mode alone — see
 *   lib/persist-mode.js
 * @returns {never}
 */
function finish(ctx, spec, { outcome, result, message }, persist) {
	const gating = ctx.findings.filter((f) => f.severity === "FAIL");
	const warned = ctx.findings.filter((f) => f.severity === "WARN");
	/* What the summary counts: the findings that drove the outcome. A FAIL
	 * demoted by --warn still counts its FAIL findings — they are what was
	 * reported.
	 *
	 * A checker that raised findings and THEN hit a SKIP or BROKEN did not
	 * finish, so those findings are not a verdict on anything: they stay in the
	 * envelope, having genuinely been raised, but count 0. Counting them would
	 * put "1 finding(s)" beside "SKIP: GitHub unreachable" — a partial scan
	 * reported as a result. */
	const incomplete = outcome === "SKIP" || outcome === "BROKEN";
	const count = incomplete ? 0 : findingCount(result, gating, warned);
	const noun = result.noun || "finding(s)";
	/* The set a delta-gated reader diffs (mantahostels#2490), sorted and deduplicated so two
	 * runs of the same standing findings produce byte-identical sets.
	 *
	 * Empty on an incomplete run, for `count`'s reason above: a checker that
	 * SKIPped drew no conclusion, and an empty set read as a verdict would report
	 * every standing finding as newly ADDED at the next complete run.
	 *
	 * A finding with no `key` falls back to tag and message. A checker that does
	 * not key is therefore noisy, never silent, which is why this falls back
	 * instead of refusing. */
	const keys = incomplete
		? []
		: [
				...new Set(ctx.findings.map((f) => f.key ?? `${f.tag}\t${f.message}`)),
			].sort();

	const summary = buildSummaryLine(outcome, { result, message, count, noun });

	if (ctx.asJson) {
		writeEnvelope(ctx, spec, { outcome, result, count, keys, noun, summary });
		process.exit(exitFor(ctx, outcome));
	}

	annotate(ctx, outcome, message);

	/* --notify's stdout is injected into every session that starts, so an "OK:
	 * nothing found" line on each one is the noise the flag exists to avoid.
	 * Anything above OK/SKIP still prints. */
	if (!(ctx.notify && (outcome === "OK" || outcome === "SKIP")))
		ctx.say(summary);
	/* Order matters: this must stay after the ctx.say(summary) call above, or
	 * the note stops being the last line. Suppressed under --notify: no
	 * SessionStart reader exists yet to serve. */
	if (!ctx.notify) for (const note of ctx.dirtyNotes) ctx.say(note);
	if (persist) persistReport(spec, outcome, result, persist);
	process.exit(exitFor(ctx, outcome));
}

/**
 * @param {CheckResult} result
 * @param {unknown[]} gating
 * @param {unknown[]} warned
 * @returns {number}
 */
function findingCount(result, gating, warned) {
	return result.count ?? (gating.length > 0 ? gating.length : warned.length);
}

/**
 * @param {Outcome} outcome
 * @param {{ result: CheckResult, message: string, count: number, noun: string }} run
 * @returns {string}
 */
function buildSummaryLine(outcome, { result, message, count, noun }) {
	if (outcome === "OK") return `OK: ${result.okLine || "nothing found."}`;
	if (outcome === "SKIP" || outcome === "BROKEN")
		return `${outcome}: ${message}`;
	return `${outcome}: ${count} ${noun}`;
}

/**
 * @param {CheckContext} ctx
 * @param {CheckSpec} spec
 * @param {{ outcome: Outcome, result: CheckResult, count: number,
 *   keys: string[], noun: string, summary: string }} run
 */
function writeEnvelope(
	ctx,
	spec,
	{ outcome, result, count, keys, noun, summary },
) {
	/* Every key built here — see ENVELOPE_FRAME_KEYS above — must join that
	 * Set (mantahostels#2600); the loop below throws before writing the envelope where
	 * one doesn't. */
	const frame = {
		checker: spec.name,
		outcome,
		exit: exitFor(ctx, outcome),
		count,
		keys,
		/* say()'s lines in order, without the summary, which follows them
		 * and has a field of its own. Absent unless --json-text asked. */
		...(ctx.jsonText ? { text: ctx._jsonLines.join("\n") } : {}),
		noun,
		summary,
		findings: ctx.findings,
	};
	for (const key of Object.keys(frame))
		if (!ENVELOPE_FRAME_KEYS.has(key))
			throw new Error(
				`lib/check.js: envelope frame key "${key}" is missing from ` +
					"ENVELOPE_FRAME_KEYS — add it there too (mantahostels#2600).",
			);
	/* writeFd for the same reason say() uses it: node buffers writes to a
	 * pipe and drops what is still buffered at process.exit, which truncates a
	 * large envelope mid-string and hands the reader invalid JSON. */
	writeFd(
		1,
		`${JSON.stringify(
			{
				/* The checker's own payload goes FIRST, so the envelope's own keys
				 * always win. Several checkers carry a `findings` array of their own,
				 * which spread last silently replaced the envelope's. */
				...(result.data || {}),
				...frame,
			},
			null,
			2,
		)}\n`,
	);
}

/**
 * Annotations come off the same `outcome` that sets the exit code, so a
 * demoted exit cannot leave an ::error:: on a green job.
 *
 * GitHub renders at most 10 per severity per step.
 *
 * @param {CheckContext} ctx
 * @param {Outcome} outcome
 * @param {string} message
 */
function annotate(ctx, outcome, message) {
	if (!ctx.inActions) return;
	if (outcome === "BROKEN") {
		writeFd(1, `::error::${toOneLine(message)}\n`);
		return;
	}
	if (outcome !== "FAIL" && outcome !== "WARN") return;
	for (const f of ctx.findings) {
		// A FAIL demoted by --warn annotates as a warning, matching its exit.
		const level = f.severity === "FAIL" && !ctx.warnOnly ? "error" : "warning";
		writeFd(1, `::${level}::${toOneLine(f.message)}\n`);
	}
}

/**
 * Land a persist-mode run: the report file, then the open run record closed.
 *
 * That order, because a report present with the record still open is a reader
 * seeing a producer mid-flight for an instant, while the reverse is a window
 * where a finished run looks like one that never wrote anything.
 *
 * The text is the bytes stdout would have carried, newline per say() and all.
 * An OK or SKIP run persists an EMPTY text rather than no file, deliberately:
 * the file is how a reader tells "ran, nothing to say" apart from "never ran".
 *
 * A FAILED WRITE FALLS BACK TO STDOUT.
 * notify-report.js degrades to a no-op rather than throwing, so without this an
 * unwritable state directory would swallow the run silently.
 *
 * @param {CheckSpec} spec
 * @param {Outcome} outcome
 * @param {CheckResult} result
 * @param {Persist} persist
 */
function persistReport(spec, outcome, result, persist) {
	const text = persist.lines.map((line) => `${line}\n`).join("");
	const wrote = persist.notify.writeReport(spec.name, {
		outcome,
		text,
		/* Carried rather than applied: the reader stamps with it once it has
		 * shown this report (mantahostels#1975), `stamps` beside it for a checker whose
		 * findings need more than one signature (mantahostels#2277). */
		stamp: result.stamp,
		stamps: result.stamps,
		durationMs: performance.now() - persist.startedAtMono,
		// The session whose start ran this hook, for scripts/deliver-to-session.js (#853).
		owner: sessionFromEnv(),
	});
	// Closed only where the report landed, for persistCrash's reason. The
	// stdout fallback below reaches a hand run alone — the async hook discards
	// it.
	if (wrote) persist.notify.closeRun(spec.name);
	if (!wrote && text) writeFd(1, text);
}

/* --notify exits 0 unconditionally, BROKEN included. Claude Code reads a
 * non-zero SessionStart hook as the hook itself being broken and stops showing
 * it, so a typo'd --days must surface as visible text in the session rather than
 * as a dead hook. */
/** @type {(ctx: CheckContext, outcome: Outcome) => number} */
const exitFor = (ctx, outcome) => (ctx.notify ? 0 : OUTCOMES[outcome].exit);

/* Workflow commands are line-oriented: a newline inside one silently ends it and
 * leaves the rest as loose log text. */
/** @type {(s: unknown) => string} */
const toOneLine = (s) =>
	String(s)
		.replace(/\s+/g, (run) => (run.includes("\n") ? " " : run))
		.trim();

/**
 * A caught value's message, unknown under `strict` until narrowed.
 *
 * @type {(e: unknown) => string}
 */
const errMessage = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Why a git or gh call failed: its stderr, else its message. The message holds
 * the call's whole argv, a filed body included, so stderr comes first.
 *
 * @param {unknown} e
 */
function failureReason(e) {
	const stderr =
		e && typeof e === "object" && "stderr" in e ? String(e.stderr).trim() : "";
	return stderr || errMessage(e);
}

/**
 * The wall clock, injectable through WFC_NOW so a check's tests do not depend
 * on the time of day or the calendar date they happen to run at (mantahostels#2176, mantahostels#2209).
 *
 * A malformed value throws rather than falling back to the wall clock: silent
 * fallback would turn a typo'd test clock into a report that passes or fails by
 * time of day.
 *
 * RESIDUAL: the variable is process-wide, so an unrelated session exporting
 * WFC_NOW skews or silences any DURABLE stamp a caller writes off this clock,
 * not just its in-test reading (mantahostels#2161). A caller that persists a timestamp
 * inherits that and should say so at its own call site.
 *
 * A guard core passes its injected `ctx.env`, never the process's (#3566).
 *
 * @type {(env?: Record<string, string | undefined>) => number}
 */
const now = (env = process.env) => {
	const raw = env.WFC_NOW;
	if (!raw) return Date.now();
	const t = Date.parse(raw);
	if (Number.isNaN(t)) throw new Error(`WFC_NOW is not a date: ${raw}`);
	return t;
};

/**
 * CheckContext under the name every check-*.js call site already uses:
 * `import("./lib/check").Ctx` instead of a hand-cut local slice (mantahostels#1315).
 *
 * Residual: a checker that still declares its OWN `Ctx`-named slice, rather
 * than importing this one, passes tsc regardless — method parameters are
 * checked bivariantly, so a mismatched hand-cut slice is caught at runtime
 * only, never at the call site.
 *
 * @typedef {CheckContext} Ctx
 */

/* The outcome errors and the outcome table stay internal: `lib/gh.js` raises
 * a SKIP or BROKEN through skipError/brokenError and never inspects one. */
// CheckContext is exported for its TYPE alone (also reachable as `Ctx`), and
// errMessage and failureReason for their narrowing logic, so a checker imports
// either instead of
// re-deriving it locally (mantahostels#1315).
module.exports = {
	runCheck,
	now,
	skipError,
	brokenError,
	isOutcomeError,
	errMessage,
	failureReason,
	CheckContext,
	MAX_BUFFER,
	/* biome-staged.js extracts the index and runs git through them (#2429). */
	git,
	indexTree,
	extractTree,
	baselineOf,
	isBaselineSide,
	againstRevs,
};
