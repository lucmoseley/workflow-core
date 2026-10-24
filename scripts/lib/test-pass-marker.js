/*
 * test-pass-marker.js — do green runs cover the commits being pushed?
 *
 * mantahostels#906 took CI off push, so between its scheduled sweeps the local
 * suite is the only gate.
 *
 * This check says whether that suite ran green. mantahostels#908 ruled it WARNS AND
 * NEVER REFUSES, and it runs no tests at all: it reads a marker a green run left
 * behind, and prints.
 *
 * WHAT A MARKER ATTESTS IS WEAKER THAN IT LOOKS. It records the tree state at
 * run time, not the sha exactly: the suite read the working tree, and the sha
 * stamped on it is HEAD as it stood when the run finished. `dirtyAtStart` and
 * `foreign` are what carry that caveat to the reader — a green taken over a
 * tree holding somebody else's uncommitted file attests less than one taken
 * over a still tree, and the warning says which it was.
 *
 * IT ALSO RECORDS THE SCOPE OF THE RUN (mantahostels#1230). `scope` carries what was
 * actually run — the filters, the tests, and the modules against the whole
 * corpus — and only a full or admissible run can cover a push (`attestationOf`). A marker written before
 * mantahostels#1230 carries no `scope` at all, and that reads as UNKNOWN rather than as
 * full.
 *
 * AN ADMISSIBLE FILTERED RUN IS THE WHOLE GATE (mantahostels#2146, mantahostels#2207). `CLAUDE.md`
 * §Conventions asks the push for an `npm run test:changed` green and nothing
 * wider; `scripts/run-vitest.js` decides admissibility at launch, and where the
 * manifest was fresh and nothing narrowed the run beyond the diff's own
 * selection the scope carries `admissible`. It is still a DIFFERENT certificate
 * from a full one and never records as one — mantahostels#1230 stands. What an
 * admissible run misses, the scheduled sweep catches, hours later.
 *
 * `isClean` is about the tree the suite read; `isFullRun` is about how much of
 * the suite ran; `isAdmissibleRun` is about whether a partial one meets the
 * gate. Scope never folds into `isClean`, because other callers read
 * that predicate as tree-cleanliness alone.
 *
 * TWO SUITES SHARE THE STORE (mantahostels#1256). The vitest suite (TypeScript) and
 * `npm run test:py` (pytest, the Python data-pipeline seam) each write their own
 * marker, told apart by `suite`. A line carrying no `suite` is a vitest marker
 * written before mantahostels#1256, which is why the field is read through `suiteOf` and
 * never off the object. The push warns per suite and by name, and a suite
 * carrying a `touches` pattern is asked only about a push whose range reaches
 * it.
 *
 * THE STORE IS APPEND-ONLY JSONL, under the canonical checkout's .claude/tmp/markers.
 * One line per green run, written with O_APPEND so concurrent suites cannot
 * interleave a partial record. A malformed line is skipped rather than thrown
 * on: a store this hook cannot parse must degrade to "no marker", never to a
 * failed push.
 */

const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { delta: cpuDelta } = require("./cpu-sample.js");
const idSeam = require("./session-id.js");
const { commandOrDefault } = require("./workflow-core-config.js");
const { pushedRef, VERIFIED_REF } = require("./landing-refs.js");
const { caught } = require("./caught.js");
const { shellWord } = require("./dirty-tree.js");
const { JS_TEST_FILE } = require("./test-kind.js");

/**
 * One green run as the store records it, and how much of the suite it covered.
 * Everything but the sha is optional: a marker written before the field existed
 * carries none, and every reader below is written to that.
 *
 * @typedef {{modulesRun: number, modulesTotal: number, tests: number,
 *   skipped: number, nameFilter?: string|null,
 *   fileFilters?: string[], changed?: string|boolean|null, admissible?: boolean,
 *   viaChanged?: boolean, full?: "flag"|"stale-manifest"|"dependency-root"|"expansion-failed",
 *   fullCause?: "push-gate"|"coverage"|"empty-diff"|"sha-moved"|"rule-edit"|"other"|null,
 *   failures?: {file: string, tests: string[]}[]}} Scope
 * @typedef {{sha: string, at?: string, suite?: string, scope?: Scope,
 *   startStateUnknown?: boolean, dirtyAtStart?: boolean, dirtyCount?: number,
 *   headMovedDuringRun?: boolean, startedAt?: string, durationMs?: number,
 *   machine?: {ceilingPct: number, busyPct: number, systemPct: number,
 *     nicePct: number, userPct: number, iowaitPct: number, load1: number|null},
 *   foreign?: {path: string, why: string}[], isolated?: boolean,
 *   treeAtEnd?: string, sessionId?: string|null, argv?: string[],
 *   closure?: "*"|string[], selected?: string[], changedPaths?: string[],
 *   imports?: Record<string, string[]>, roots?: string[],
 *   base?: string, refused?: boolean, refusedWhy?: string, refusedWord?: string,
 *   stalled?: boolean, stallMs?: number,
 *   inflight?: {module: string, stage: string}[], finished?: string[]}} Marker
 * @typedef {{closure: "*"|string[], selected?: string[],
 *   changedPaths?: string[]|null, base?: string|null,
 *   imports?: Record<string, string[]>, roots?: string[]}} Attestation
 * @typedef {{root?: string|null, execFn?: typeof execFileSync,
 *   cache?: Map<string, string>}} GitOptions
 * @typedef {GitOptions & {countedPaths?: Set<string>|null}} JudgeOptions
 * @typedef {{git: (args: string[]) => string, countedPaths: Set<string>|null}} DiffReader
 */

/*
 * `closure`/`changedPaths` (workflow-core#189): what a certificate ATTESTS, so a sha other
 * than the one stamped can be cleared by content rather than by identity.
 * `closure` is every repo-relative path the run's verdict depended on — the
 * literal `"*"` for a full run; for a narrowed one the selected tests, their
 * transitive imports off vitest's module graph, the documents
 * docs/test-read-edges.json maps to those tests, and the dependency-graph
 * roots `run-vitest.js` escalates on. `selected` is the tests the run
 * selected, which the manifest is re-read against at the sha judged (workflow-core#799).
 * `changedPaths` is the diff the selection was computed from and `base` what
 * it was diffed against (workflow-core#151). `holdsAt` reads the closure and `selected`,
 * `attestationOf` the `changedPaths`; no gate reads `base` (workflow-core#814). A marker
 * carrying none of them holds at its own sha alone.
 *
 * `imports`/`roots` (workflow-core#1860): the same closure split by test, so a diff voids
 * only the tests whose own reads it touches rather than the whole run.
 * `imports` maps each selected test to the in-repo files vitest's module graph
 * reached from it, the test itself left out; `roots` are the paths every
 * test's verdict rests on. A narrowed marker carrying both is judged test by
 * test (`testsHeldAt`); one carrying neither is judged on `closure` alone.
 */

/*
 * `startedAt`/`durationMs` (mantahostels#1953): `at` dates a run and never says how long it
 * took, so a 14-minute suite and a 264 s one read alike in history. Both are
 * OPTIONAL and absent before mantahostels#1953, so absence is UNKNOWN, never fast.
 *
 * `machine` (mantahostels#1953): duration alone says a run was slow and never
 * WHY, so this block is a CPU figure taken across the run itself: see
 * `lib/cpu-sample.js` for why it splits `system` and `nice` out rather than
 * reporting one busy number.
 *
 * ALSO OPTIONAL, AND FOR A SECOND REASON BEYOND AGE: it reads `/proc`, which CI
 * runners and macOS may not answer. Absence is unknown, never a quiet machine.
 */

const STORE = ".test-pass-markers.jsonl";

/** The read-graph manifest, relative to the checkout root — the one spelling
 * the launcher, the reporter and every message here share. */
const EDGES_FILE = "docs/test-read-edges.json";

// What an import graph can reach, so what a changed module can make a test read.
const IMPORTABLE = /\.(?:[cm]?[jt]sx?|json)$/;

/* The launch that re-runs named tests and certifies them (workflow-core#1860).
 * lib/changed-selection.js parses it. */
const RETEST_FLAG = "--retest";

/**
 * The four reasons `scope.full` can carry (mantahostels#3207): `"flag"` for a session's
 * own `--full`, and the three the default narrowing escalates itself to
 * where it would be worthless (mantahostels#3208) — lib/changed-selection.js's `defaultEscalationReason`.
 */
const FULL_REASONS = [
	"flag",
	"stale-manifest",
	"dependency-root",
	"expansion-failed",
];

/**
 * The six values `--full=<cause>` accepts (workflow-core#182): a session satisfying the push
 * gate without the gate having asked (`push-gate`), a genuine whole-suite coverage need (`coverage`), the
 * empty-diff trap (`empty-diff`), a sha moving under a green run
 * (`sha-moved`), a rule-document edit (`rule-edit`), and the escape hatch for
 * anything else (`other`).
 *
 * A SEPARATE VOCABULARY FROM `FULL_REASONS`, DELIBERATELY (workflow-core#182). `full`
 * (`FULL_REASONS`) is the MECHANISM — why the run was unnarrowed at all,
 * `"flag"` or one of the three escalations — and `isAdmissibleRun` reads it as
 * a disqualifier. `fullCause` is WHY THE SESSION TYPED THE FLAG, and only
 * exists where `full === "flag"`: an escalation's cause is the escalation
 * already named in `full`, so its `fullCause` is always `null`.
 */
const FULL_CAUSES = [
	"push-gate",
	"coverage",
	"empty-diff",
	"sha-moved",
	"rule-edit",
	"other",
];

/*
 * The red store (mantahostels#1942), deliberately a SEPARATE file from the green one.
 *
 * Mixing verdicts in one store would put a `failed` discriminator in front of
 * every existing reader — `readMarkers`, `attestationOf`, the pre-push gate — and
 * one that forgot it would read a red run as a green.
 *
 * It is written for the SESSION, not for a gate: nothing gates on it, and a red
 * run still records no green, exactly as before.
 */
const FAIL_STORE = ".test-fail-markers.jsonl";

/* Above this many lines the store is rewritten down to KEEP. Pruning races an
 * append from a parallel suite; the loss is one marker, whose cost is one
 * spurious warning, so no lock is worth buying here. Both figures are one
 * suite's 400/200 times the two suites that write here (mantahostels#1256); each
 * further writer shortens how far back each reaches.
 * Shared by both stores (append(), below) — mantahostels#1942's red store reuses this
 * figure unmeasured for its own retention depth. */
const PRUNE_AT = 800;
const KEEP = 400;

/* What a prune drops is moved to `<store>.archive.jsonl` and kept this long,
 * because KEEP holds under a day of runs (workflow-core#1231). Seven days is a choice,
 * not a measurement: it holds a 3-day reading such as workflow-core#816's. Nothing reads the
 * archive at a gate; it is for analysis. */
const ARCHIVE_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * Every suite the gate expects to see a green from, and what to tell a session
 * that has none. Adding a row here is what makes a new suite warn — the store,
 * the predicates and the warnings are all suite-agnostic.
 *
 * ORDER IS THE PRINT ORDER at the push, not a precedence.
 */
const SUITES = [
	/* `gate` is what the push asks for, which stopped being the whole suite at
	 * mantahostels#2207. `certifiesFiltered` says whether the suite has an admissible tier
	 * at all — vitest's is minted by scripts/run-vitest.js, and pytest has
	 * none. */
	{
		id: "vitest",
		name: "VITEST",
		gate: "npm run test",
		certifiesFiltered: true,
	},
	{
		id: "pytest",
		name: "PYTEST",
		gate: "npm run test:py",
		certifiesFiltered: false,
		/* A suite that only answers for part of the repo says nothing about a
		 * push that cannot have touched it. Without this the pytest warning
		 * fires on every push, docs-only included — and a warning that always
		 * fires is one nobody reads. */
		touches:
			/\.py$|^(pytest\.ini|requirements-dev\.txt|scripts\/run-pytest\.js)$/,
	},
];

const DEFAULT_SUITE = "vitest";

/* A marker written before mantahostels#1256 names no suite, and every one of those was
 * vitest's — the only suite that wrote markers at all. */
/** @param {Marker} m */
const suiteOf = (m) => m.suite || DEFAULT_SUITE;

/**
 * Which suites a push carrying `changed` should be warned about.
 *
 * A suite with no `touches` always answers — vitest covers the whole repo, so
 * there is no range it can be silent on.
 *
 * @param {string[]} changed
 * @returns {string[]}
 */
function suitesFor(changed) {
	return SUITES.filter(
		(s) => !s.touches || changed.some((f) => s.touches.test(f)),
	).map((s) => s.id);
}

/** @param {string} id */
const suiteMeta = (id) =>
	SUITES.find((s) => s.id === id) || {
		id,
		name: String(id).toUpperCase(),
		gate: `the ${id} suite`,
		certifiesFiltered: false,
	};

/**
 * The canonical checkout's root — the parent of the common git dir, so a
 * throwaway worktree writes to and reads from the same store as the main tree.
 *
 * Null where git will not answer, which every caller reads as "no store".
 *
 * @param {string} [cwd]
 * @returns {string|null}
 */
function repoRoot(cwd = process.cwd()) {
	try {
		return path.dirname(
			execFileSync(
				"git",
				["rev-parse", "--path-format=absolute", "--git-common-dir"],
				{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			).trim(),
		);
	} catch {
		return null;
	}
}

/** @param {string} root @param {string} [store] */
const storePath = (root, store = STORE) => path.join(markersDir(root), store);

/** @param {string} root @param {string} [store] */
const archivePath = (root, store = STORE) =>
	`${storePath(root, store).replace(/\.jsonl$/, "")}.archive.jsonl`;

/**
 * Add the lines a prune dropped to the store's archive, and drop archived lines
 * older than ARCHIVE_MS or with no readable `at`. Throws where the archive
 * exists but cannot be read, so the caller leaves the store unpruned rather
 * than overwrite the archive with one batch.
 *
 * TWO PRUNES RACING archive overlapping batches; a line seen twice is kept
 * once, so the race costs at most the lines one prune's rewrite misses, never
 * a doubled count.
 *
 * @param {string} root
 * @param {string} store
 * @param {string[]} dropped
 */
function archive(root, store, dropped) {
	const file = archivePath(root, store);
	/** @type {string[]} */
	let kept = [];
	try {
		kept = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
	}
	const cutoff = Date.now() - ARCHIVE_MS;
	/** @param {string} line */
	const inReach = (line) => {
		try {
			return Date.parse(JSON.parse(line).at) >= cutoff;
		} catch {
			return false;
		}
	};
	const lines = [...new Set([...kept, ...dropped])].filter(inReach);
	fs.writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

/**
 * Append one green run. Never throws: a suite that has already passed must not
 * be turned red by an unwritable marker store.
 *
 * Returns whether the line landed, for the test to assert on.
 *
 * @param {Marker} entry
 * @param {{root?: string|null, pruneAt?: number, keep?: number}} [options]
 * @returns {boolean}
 */
function record(entry, options) {
	return append(STORE, entry, options);
}

/**
 * Append one RED run to the separate fail store (mantahostels#1942), so a session that has
 * piped the suite's output away can still name what failed instead of paying
 * another whole-suite run for the names.
 *
 * @param {Marker} entry
 * @param {{root?: string|null, pruneAt?: number, keep?: number}} [options]
 * @returns {boolean} whether the line landed
 */
function recordFailure(entry, options) {
	return append(FAIL_STORE, entry, options);
}

/**
 * The one appender both stores use.
 *
 * @param {string} store
 * @param {Marker} entry
 * @param {{root?: string|null, pruneAt?: number, keep?: number}} [options]
 * @returns {boolean}
 */
function append(
	store,
	entry,
	{ root = repoRoot(), pruneAt = PRUNE_AT, keep = KEEP } = {},
) {
	if (!root || !entry?.sha) return false;
	const file = storePath(root, store);
	try {
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
	} catch {
		return false;
	}
	try {
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		if (lines.length > pruneAt) {
			/* archive first: a failed archive leaves the store unpruned, to be
			 * retried at the next append, instead of losing the batch */
			archive(root, store, lines.slice(0, -keep));
			fs.writeFileSync(file, `${lines.slice(-keep).join("\n")}\n`);
		}
	} catch {
		/* the marker is written; a failed prune costs disk, not correctness */
	}
	return true;
}

/**
 * One store's lines, parsed once: the readable markers and how many of the
 * store's non-blank lines were NOT one of them — a torn append (workflow-core#182's
 * NUL-prefixed example), hand-mangled JSON, or a parsed object with no `sha`.
 *
 * THE ONE PARSE READMARKERS AND COUNTMALFORMED BOTH GO THROUGH, so the two can
 * never disagree on what counts as malformed.
 *
 * @param {string} root
 * @param {string} store
 * @returns {{markers: Marker[], malformed: number, total: number}}
 */
function parseStore(root, store) {
	let text;
	try {
		text = fs.readFileSync(storePath(root, store), "utf8");
	} catch {
		return { markers: [], malformed: 0, total: 0 };
	}
	const markers = [];
	let malformed = 0;
	let total = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		total++;
		try {
			const entry = JSON.parse(line);
			if (entry && typeof entry.sha === "string") markers.push(entry);
			else malformed++;
		} catch {
			/* a torn or hand-mangled line is not a marker */
			malformed++;
		}
	}
	return { markers, malformed, total };
}

/**
 * Every readable marker, oldest first. An absent or unreadable store is [].
 *
 * `store` names WHICH store, because the red store (mantahostels#1942) is the same shape
 * and mantahostels#2205 gave it a reader.
 */
function readMarkers({ root = repoRoot(), store = STORE } = {}) {
	if (!root) return [];
	return parseStore(root, store).markers;
}

/**
 * How many of a store's non-blank lines could not be read back as a marker
 * (workflow-core#182) — a real record silently dropped by the same skip that keeps a
 * malformed line from failing a reader (header, "THE STORE IS APPEND-ONLY
 * JSONL"). `{malformed: 0, total: 0}` where the store is absent or
 * unreadable: nothing malformed was SEEN, which is not the same claim as
 * "nothing is wrong".
 *
 * @param {{root?: string|null, store?: string}} [options]
 * @returns {{malformed: number, total: number}}
 */
function countMalformed({ root = repoRoot(), store = STORE } = {}) {
	if (!root) return { malformed: 0, total: 0 };
	const { malformed, total } = parseStore(root, store);
	return { malformed, total };
}

/**
 * What a green run tells the pre-push gate: the sha it finished on, whether
 * anything was uncommitted when it started, and every file that can be shown
 * NOT to have been the running session's own — a neighbour's claimed dirty
 * file, or one that moved under the suite while it ran.
 *
 * Takes `tree-drift.js`'s three results as plain data, so the record can be
 * asserted without a suite run to produce it.
 *
 * @param {import("./tree-drift.js").Snapshot|null} before
 * @param {import("./tree-drift.js").Snapshot} after
 * @param {ReturnType<typeof import("./tree-drift.js").drift>} drifted
 * @param {object} [run]
 * @param {{path: string, sessionId: string, dead?: boolean}[]|null} [run.held]
 *   The three fields this reads off `tree-drift.js`'s held-file rows, rather
 *   than the whole row, so a caller can hand it a record it built itself.
 * @param {Scope|null} [run.scope]
 * @param {string} [run.suite]
 * @param {number|null} [run.startedAtMs] `Date.now()` as the run began. Omitted or
 *   unreadable leaves both time fields off, which reads as unknown.
 * @param {import("./cpu-sample.js").CpuSample|null} [run.machineStart] The CPU
 *   counters as the run began. Omitted or unreadable leaves the `machine` block
 *   off, which reads as unknown — never as a quiet machine.
 * @param {import("./cpu-sample.js").CpuSample|null} [run.machineEnd] The same
 *   counters as the run ENDED, taken per-run by the reporter. See the note on
 *   `finishedAtMs` for why this is never sampled here.
 * @param {number|null} [run.endedAtMs] `Date.now()` as the run ended. Falls back to
 *   now, which is only correct for a one-shot run.
 * @param {boolean} [run.isolated] Whether this run read a frozen `--isolated`
 *   worktree rather than the shared tree (mantahostels#2187). Written on every run, never
 *   omitted: unlike the fields above this is always known by the caller, so
 *   there is no unknown case for absence to mean. A marker written before
 *   this field existed carries neither it nor `treeAtEnd`, and a reader must
 *   read that as UNKNOWN — not as "not isolated".
 * @param {string|null} [run.treeAtEnd] The tracked tree's identity as the run
 *   FINISHED (mantahostels#2187), from `tree-drift.js`'s `endOfRunTreeIdentity` — taken
 *   in the run's own worktree, after the run, unlike every other tree field
 *   here which describes the START. Omitted where git would not answer,
 *   which reads as unknown rather than as a match.
 * @param {string|null} [run.sessionId] The launching session's id (workflow-core#182), off
 *   `session-id.js`'s `fromEnv()` by default — the harness's variable, the
 *   one environment read here. A pointer into a transcript that expires,
 *   never a certificate.
 * @param {string[]|null} [run.argv] The launch's own argv (workflow-core#182), off the
 *   launch record (`suite-handoff.js`) — `process.argv.slice(2)` as `main()`
 *   first saw it, before any flag was stripped.
 * @param {Attestation|null} [run.attestation] What the verdict depended on (workflow-core#189),
 *   from the reporter over the run report. Omitted where the reporter could
 *   not compute it, which reads as "attests its own sha alone".
 * @returns {Marker & {foreign: {path: string, why: string}[]}}
 */
function markerFrom(
	before,
	after,
	drifted,
	{
		held = null,
		scope = null,
		suite = DEFAULT_SUITE,
		startedAtMs = null,
		machineStart = null,
		machineEnd = null,
		endedAtMs = null,
		isolated = false,
		treeAtEnd = null,
		sessionId = idSeam.fromEnv(),
		argv = null,
		attestation = null,
	} = {},
) {
	const attested = attestedFields(attestation);
	const dirtyCount = Object.keys(before?.files ?? {}).length;
	/*
	 * THE RUN'S END, NOT THE MARKER'S WRITE (mantahostels#1953).
	 * This function is reached from `vitest-tree-watch.ts`'s teardown, which is a
	 * globalSetup hook firing ONCE PER PROCESS. In watch mode that is when the
	 * session QUITS, so sampling the end bracket here would span last-run-start →
	 * quit: idle minutes averaged into a duration and a CPU delta, both positive
	 * and plausible, and so unable to fail to absent. A low `busyPct` arrived at
	 * that way reads as a MEASURED quiet machine, the one false reading these
	 * fields exist to prevent.
	 *
	 * The reporter's `onTestRunEnd` fires per run and passes both brackets in.
	 * `Date.now()` remains the fallback for a caller that has none — a test
	 * building a record by hand, and a one-shot run, where teardown follows the
	 * run's end by milliseconds.
	 */
	const finishedAtMs =
		typeof endedAtMs === "number" && Number.isFinite(endedAtMs)
			? endedAtMs
			: Date.now();
	/*
	 * BOTH FIELDS OR NEITHER, AND A BACKWARDS CLOCK IS NEITHER (mantahostels#1953).
	 * Clamping a negative elapsed to 0 would write a marker whose `startedAt`
	 * postdates its own `at` and whose duration attests an instant run — the
	 * reading these fields exist to make trustworthy. Absent instead, matching
	 * `startStateUnknown` below: this file records unknown as absence.
	 */
	const timed = timedFields(startedAtMs, finishedAtMs);
	/*
	 * Same both-or-neither discipline as `timed` above, and delegated whole to
	 * `cpu-sample.js`, which returns null on every reading it will not vouch for
	 * — an unreadable `/proc`, a zero span, an unknown core count.
	 */
	const machineDelta = cpuDelta(machineStart, machineEnd);
	const machine = machineDelta ? { machine: machineDelta } : {};
	return {
		sha: after.head,
		at: new Date(finishedAtMs).toISOString(),
		suite,
		...timed,
		...machine,
		...(scope ? { scope } : {}),
		// An absent snapshot means git would not answer at run start, so nothing
		// is known about what the suite read. Its own field rather than folded
		// into `dirtyAtStart`, which counts files: unknown must warn, and a count
		// of zero would otherwise attest a still tree nobody saw.
		startStateUnknown: !before,
		dirtyAtStart: dirtyCount > 0,
		dirtyCount,
		headMovedDuringRun: Boolean(drifted?.headMoved),
		isolated: Boolean(isolated),
		...(treeAtEnd ? { treeAtEnd } : {}),
		...(sessionId ? { sessionId } : {}),
		...(argv ? { argv } : {}),
		...attested,
		foreign: [
			...(held ?? []).map((e) => ({
				path: e.path,
				why: `held by ${e.sessionId}${e.dead ? " — GONE" : ""}, dirty before this run began`,
			})),
			...(drifted?.moved ?? []).map((e) => ({
				path: e.path,
				why: `${e.kind} while the suite ran`,
			})),
		],
	};
}

/**
 * The attestation's closure where well-formed, and beside a narrowed one the
 * well-formed fields saying what narrowed it.
 * @param {Attestation|null} attestation
 * @returns {Pick<Marker, "closure"|"selected"|"changedPaths"|"base"|"imports"|"roots">}
 */
function attestedFields(attestation) {
	if (!attestation || !isClosure(attestation.closure)) return {};
	const { closure, selected, changedPaths, base, imports, roots } = attestation;
	/* Only beside a narrowed closure: a full run selected on nothing. */
	if (closure === "*") return { closure };
	return {
		closure,
		...(isStringList(selected) ? { selected } : {}),
		...(Array.isArray(changedPaths) ? { changedPaths } : {}),
		...(typeof base === "string" && base ? { base } : {}),
		...(isImportMap(imports) && isStringList(roots) ? { imports, roots } : {}),
	};
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, string[]>}
 */
const isImportMap = (value) =>
	value != null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.values(value).every(isStringList);

/**
 * @typedef {Marker & {closure: string[], selected: string[],
 *   imports: Record<string, string[]>, roots: string[]}} PerTestMarker
 */

/**
 * Whether a narrowed marker records its closure test by test (workflow-core#1860), and so
 * is judged by `testsHeldAt` rather than `holdsAt`.
 * @param {Marker} m
 * @returns {m is PerTestMarker}
 */
const isPerTest = (m) =>
	Array.isArray(m.closure) &&
	isStringList(m.selected) &&
	isImportMap(m.imports) &&
	isStringList(m.roots);

/**
 * @param {unknown} closure
 * @returns {closure is "*"|string[]}
 */
const isClosure = (closure) => closure === "*" || isStringList(closure);

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
const isStringList = (value) =>
	Array.isArray(value) && value.every((p) => typeof p === "string");

/**
 * @param {number|null} startedAtMs
 * @param {number} finishedAtMs
 * @returns {Pick<Marker, "startedAt"|"durationMs">}
 */
function timedFields(startedAtMs, finishedAtMs) {
	return typeof startedAtMs === "number" &&
		Number.isFinite(startedAtMs) &&
		finishedAtMs >= startedAtMs
		? {
				startedAt: new Date(startedAtMs).toISOString(),
				durationMs: finishedAtMs - startedAtMs,
			}
		: {};
}

/**
 * A run nothing can be said against: no uncommitted tracked file at start, no
 * file another session held, nothing moving while it ran.
 *
 * `dirtyAtStart` counts the session's OWN work in progress too, and that is
 * deliberate — the suite read those bytes, and they are not the ones being
 * pushed. Attribution is only possible for `foreign`, so the warning counts
 * those separately from the rest.
 */
/** @param {Marker} m */
const isClean = (m) =>
	!m.startStateUnknown &&
	!m.dirtyAtStart &&
	!m.headMovedDuringRun &&
	(m.foreign || []).length === 0;

/**
 * The whole suite, unnarrowed: no name filter, no file filter, and every module
 * in the corpus collected. A zero corpus is NOT full — it means the glob never
 * resolved, and a run nobody sized is not a run everybody ran.
 *
 * `--changed` IS A NARROWING LIKE ANY OTHER, even where the diff happened to
 * select every module. This follows the file-filter limb above, which already
 * rejects a path-filtered run that collected the whole corpus: what disqualifies
 * a run here is HOW it was selected, not how many files that selection reached.
 * A count-only test would make `CLAUDE.md`'s "a filtered green never records a
 * full certificate" false on the day a diff touched everything (mantahostels#2031).
 *
 * SKIPPED TESTS ARE NOT CONSULTED. A conditional skip — `it.skipIf(AS_ROOT)`,
 * `it.skipIf(!guardExists())` — makes a genuine full run report skips on some
 * machines and none on others, so module count against the corpus is the one
 * signal it cannot confound.
 *
 * ONE DEFINITION, TWO READERS: `isFullRun` answers for a stored marker at the
 * push, `formatFilteredRun` for a live run at the terminal. Both go through
 * here.
 */
/** @param {Scope|null|undefined} scope */
const isFullScope = (scope) =>
	scope != null &&
	!scope.nameFilter &&
	(scope.fileFilters || []).length === 0 &&
	!scope.changed &&
	scope.modulesTotal > 0 &&
	scope.modulesRun === scope.modulesTotal;

/** @param {Marker} m */
const isFullRun = (m) => isFullScope(m.scope);

/** Every readable RED marker, oldest first (mantahostels#2205). */
function readFailures(options = {}) {
	return readMarkers({ ...options, store: FAIL_STORE });
}

/**
 * How much of the corpus a red must have collected before it is evidence that
 * `main` itself is red rather than that one file is (mantahostels#2205).
 *
 * DELIBERATELY LOOSER THAN `isFullScope`, which the green side uses to issue a
 * certificate. Nothing is certified here: the reader is a session comparing a
 * file list against its own diff.
 *
 * 0.9 IS mantahostels#2205's SPECIFIED FIGURE AND NOTHING MEASURED IT — a first cut, and
 * moving it wants that reading first.
 */
const FULL_RED_RATIO = 0.9;

/**
 * A red wide enough to be evidence about `main`.
 *
 * THE NAME FILTER IS THE ONE NARROWING THE RATIO CANNOT SEE. `-t <pattern>`
 * leaves vitest collecting every module and running a handful of tests inside
 * them, so `modulesRun === modulesTotal` on a run that asked almost nothing —
 * and a partial failing set read as a complete one is exactly how the exemption
 * this feeds goes wrong. A file filter and `--changed` both narrow what is
 * COLLECTED, so `modulesRun` already carries them and the ratio is their whole
 * test; `isFullScope`'s stricter rejection of the pair is a certificate's
 * business, not this one's.
 *
 * @param {Scope|null|undefined} scope
 */
const isFullScopeRed = (scope) =>
	scope != null &&
	!scope.nameFilter &&
	scope.modulesTotal > 0 &&
	scope.modulesRun >= FULL_RED_RATIO * scope.modulesTotal;

/**
 * The most recent red wide enough to be evidence about `main`, as a digest —
 * its sha, when it ran and the distinct files that failed — or null.
 *
 * THREE THINGS MAKE IT SKIP A RED AND KEEP WALKING BACK, so what it answers is
 * not always the newest wide red: a suite that is not vitest (the red store
 * holds one today, and a pytest red says nothing about the vitest suite a
 * `result:` turn is being asked to run), a run narrowed past `isFullScopeRed`,
 * and a red naming no failing file at all — an empty list being nothing for a
 * session to check its diff against.
 *
 * A DIGEST RATHER THAN THE MARKER, so the one caller reads a shape whose every
 * field is present. It is prose-building a refusal, and a marker's fields are
 * all optional by age.
 *
 * @param {Marker[]} markers
 * @returns {{sha: string, at: string|null, files: string[]}|null}
 */
function lastFullRed(markers) {
	for (const m of [...markers].reverse()) {
		if (suiteOf(m) !== DEFAULT_SUITE) continue;
		const scope = m.scope;
		if (!isFullScopeRed(scope)) continue;
		const files = [
			...new Set((scope?.failures || []).map((f) => f?.file).filter(Boolean)),
		];
		if (files.length === 0) continue;
		return { sha: m.sha, at: m.at ?? null, files };
	}
	return null;
}

/**
 * A narrowed run the push gate accepts anyway: `npm run test:changed` over a
 * tree whose `docs/test-read-edges.json` was fresh (mantahostels#2146).
 *
 * THE FLAG IS SET AT LAUNCH, NOT HERE. Only `scripts/run-vitest.js` can tell a
 * diff-selected run from a hand-typed one-file run, so it is the only writer of
 * `admissible`, and it sets it only where it ran the freshness check itself and
 * argv carried nothing but `--changed`.
 *
 * SO THIS SIDE CANNOT CHECK THE CLAIM, ONLY ITS SHAPE. The questions below keep
 * the tiers disjoint — a run wide enough to be full is answered by `isFullRun`,
 * and a zero corpus is no run to admit — and none of them separates a real
 * admissible run from a forged one. A launch record claiming `admissible`
 * (`suite-handoff.js`), exported by hand in front of a bare `vitest run
 * <file>`, mints this certificate, and nothing here or at the push can tell. Accepted: the gate warns and never
 * refuses (mantahostels#908).
 *
 * THE NAME FILTER IS THE ONE FORGERY THIS SIDE CAN SEE, so it rejects it
 * (mantahostels#2172). The launcher already refuses a `-t` run — argv must carry nothing
 * but `--changed` — so a marker arriving with both a name filter and the flag
 * did not come from `npm run test:changed`, whatever set the launch record.
 *
 * IT LOOKS REDUNDANT BESIDE `isFullScope` AND IS NOT: that predicate returns
 * false on a name filter, so under the `!` it ADMITS the forged marker.
 * Deleting the clause as a duplicate reopens mantahostels#2172.
 *
 * AND THE FRESHNESS IS READ AT LAUNCH, NEVER AT RECORD TIME. A manifest staled
 * while the suite ran leaves this certificate standing on a check that was true
 * when it was asked.
 *
 * `full` DISQUALIFIES IT TOO (mantahostels#3207): the two tiers are disjoint, so a scope
 * carrying both is a contradiction, not a stronger certificate. This is the
 * limb that rejects it — `isFullRun` is untouched and never reads the field.
 *
 * @param {Scope|null|undefined} scope
 */
const isAdmissibleScope = (scope) =>
	scope != null &&
	scope.admissible === true &&
	scope.modulesTotal > 0 &&
	!scope.nameFilter &&
	!scope.full &&
	!isFullScope(scope);

/** @param {Marker} m */
const isAdmissibleRun = (m) => isAdmissibleScope(m.scope);

/**
 * The documents a parsed manifest maps to any of `tests` — one reading for
 * the reporter stamping a closure and for `holdsAt` re-reading it at a
 * sha (workflow-core#799), so the two cannot disagree. `null` where the manifest is not
 * `{edges: {doc: [test, …]}}`: a caller fails closed on it.
 *
 * @param {unknown} manifest
 * @param {Set<string>} tests
 * @returns {Set<string>|null}
 */
function docsReadBy(manifest, tests) {
	const byTest = docsByTest(manifest);
	if (!byTest) return null;
	const docs = new Set();
	for (const t of tests) for (const doc of byTest.get(t) ?? []) docs.add(doc);
	return docs;
}

/**
 * A parsed manifest turned round: each test to the documents it reads, or
 * `null` where it is not `{edges: {doc: [test, …]}}`.
 *
 * @param {unknown} manifest
 * @returns {Map<string, Set<string>>|null}
 */
function docsByTest(manifest) {
	const edges = /** @type {{edges?: unknown}|null} */ (manifest)?.edges;
	if (!edges || typeof edges !== "object" || Array.isArray(edges)) return null;
	/** @type {Map<string, Set<string>>} */
	const byTest = new Map();
	for (const [doc, readers] of Object.entries(edges)) {
		if (!Array.isArray(readers)) return null;
		for (const t of readers) {
			const docs = byTest.get(t) ?? new Set();
			docs.add(doc);
			byTest.set(t, docs);
		}
	}
	return byTest;
}

/**
 * `options` with every default resolved once, so the root lookup — a git
 * spawn of its own — is not repeated per marker.
 *
 * @param {GitOptions} options
 * @returns {{root: string|null, execFn: typeof execFileSync, cache: Map<string, string>}}
 */
function gitContext({
	root = repoRoot(),
	execFn = execFileSync,
	cache = new Map(),
}) {
	return { root, execFn, cache };
}

/**
 * A memoised `git` in `root`, throwing where there is no root.
 *
 * @param {GitOptions} options
 */
function gitReader(options) {
	const { root, execFn, cache } = gitContext(options);
	/** @param {string[]} args */
	const git = (args) => {
		if (!root) throw new Error("no repository root");
		const key = args.join("\0");
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		const out = String(
			execFn("git", args, {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
		cache.set(key, out);
		return out;
	};
	return { git, root };
}

/** @param {string} out */
const lines = (out) =>
	out
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

/**
 * Whether a run's verdict still holds at `sha`, and by which key (workflow-core#189,
 * settling workflow-core#150).
 *
 * A certificate keyed to a sha alone is voided by the acts between earning
 * it and needing it — the commit, the push, a neighbour's push — even when the
 * content tested is byte-identical (workflow-core#148). So the marker also attests the TREE it
 * read (`treeAtEnd`) plus the paths its verdict depended on (`closure`), and
 * a sha whose tree differs from that one only outside the closure is attested
 * by content. Three rules, in order, first match wins:
 *
 *   1. `marker.sha === sha` — a sha fixes its tree.
 *      Every pre-workflow-core#189 marker matches this way and nothing is migrated.
 *   2. Otherwise the marker needs `treeAtEnd` and `closure`; lacking either
 *      it holds at no other sha.
 *   3. `git diff-tree` between `treeAtEnd` and the sha's tree must touch
 *      nothing in `closure`. With `closure === "*"` (a full run) that is tree
 *      equality, checked as one `rev-parse` rather than a diff. A narrowed
 *      marker carrying `selected` (workflow-core#799) first widens its closure by every
 *      document the manifest AT THE SHA maps to a selected test, so an edit
 *      to an unselected test's edges refuses nothing; a manifest absent,
 *      unreadable or malformed at the sha holds nothing. A marker without
 *      `selected` carries the manifest in its closure and is judged on that
 *      closure alone.
 *
 * A marker recording its closure test by test (workflow-core#1860) is judged by
 * `testsHeldAt` instead, test by test, and composed by `pairAttestation`.
 *
 * `countedPaths`, where given, is the only paths a diff-tree change counts on:
 * the push's range with the `landing` module on (`attestationOf`), so a change
 * already on `landing`, a reconcile merge's included, voids nothing — the
 * lander's full run tests it with the push (workflow-core#2517). Residual: such a change
 * that a certificate's closure reads is tested with the pusher's work by no
 * run before the lander's.
 *
 * IT ASKS NOTHING OF THE RANGE. Whether the commit's range was selected for
 * is asked of the whole set of runs, by `attestationOf` (ADR-0009), never of a
 * lone run's `changedPaths` (workflow-core#814).
 *
 * NOT A SCOPE PREDICATE. `isFullRun`/`isAdmissibleRun` say whether the run
 * was wide enough to answer the gate at all; this says whether it answers for
 * THIS sha. Every gate asks both — a hand-typed one-file green holds at its
 * tree exactly and still certifies nothing.
 *
 * The closure is exactly as blind as the selection that produced it: a
 * document read through an imported helper enters neither the module graph
 * nor the manifest (mantahostels#2131), so a sha differing from the tree only there is
 * attested when it should not be — the same commit `npm run test` would have
 * run nothing for. Accepted at workflow-core#150 Q5.
 *
 * Every git failure — an unknown sha, a tree git cannot read — holds
 * nothing. `cache` memoises the git calls across the markers one gate reads,
 * since the store holds hundreds and the sha is the same for all of them.
 *
 * @typedef {{by: "sha"}|{by: "tree", tree: string, closureSize: number|"*"}} AttestationMatch
 * @param {Marker} m
 * @param {string} sha
 * @param {JudgeOptions} [options]
 * @returns {AttestationMatch|null}
 */
function holdsAt(m, sha, options = {}) {
	if (!m || typeof sha !== "string" || !sha) return null;
	if (m.sha === sha) return { by: "sha" };
	const { treeAtEnd, closure } = m;
	if (!treeAtEnd || closure == null) return null;
	if (closure !== "*" && !Array.isArray(closure)) return null;
	const { git, root } = gitReader(options);
	if (!root) return null;
	const countedPaths = options.countedPaths ?? null;
	try {
		return closure === "*"
			? holdsByTree(sha, treeAtEnd, { git, countedPaths })
			: holdsByClosure(
					sha,
					{ treeAtEnd, closure, selected: m.selected },
					{ git, countedPaths },
				);
	} catch {
		return null;
	}
}

/**
 * The paths `tree` and `sha`'s tree differ by, less any outside `countedPaths`.
 * Throws where git does.
 * @param {string} tree
 * @param {string} sha
 * @param {DiffReader} by
 * @returns {string[]}
 */
function touchedBetween(tree, sha, { git, countedPaths }) {
	const touched = lines(
		git([
			"diff-tree",
			"--name-only",
			"-r",
			"--no-renames",
			tree,
			`${sha}^{tree}`,
		]),
	);
	return countedPaths ? touched.filter((p) => countedPaths.has(p)) : touched;
}

/**
 * Rule 3 for a full run: tree equality, or no change to `countedPaths`.
 * Throws where git does.
 * @param {string} sha
 * @param {string} treeAtEnd
 * @param {DiffReader} by
 * @returns {AttestationMatch|null}
 */
function holdsByTree(sha, treeAtEnd, by) {
	const tree = by.git(["rev-parse", `${sha}^{tree}`]).trim();
	const holds =
		tree === treeAtEnd ||
		(by.countedPaths !== null &&
			touchedBetween(treeAtEnd, sha, by).length === 0);
	return holds ? { by: "tree", tree: treeAtEnd, closureSize: "*" } : null;
}

/**
 * Rule 3 for a narrowed run. Throws where git does.
 * @param {string} sha
 * @param {{treeAtEnd: string, closure: string[], selected?: string[]}} attested
 * @param {DiffReader} by
 * @returns {AttestationMatch|null}
 */
function holdsByClosure(sha, { treeAtEnd, closure, selected }, by) {
	const { git } = by;
	const inClosure = new Set(closure);
	if (Array.isArray(selected)) {
		const docs = docsReadBy(
			JSON.parse(git(["show", `${sha}:${EDGES_FILE}`])),
			new Set(selected),
		);
		if (!docs) return null;
		for (const doc of docs) inClosure.add(doc);
	}
	if (touchedBetween(treeAtEnd, sha, by).some((p) => inClosure.has(p)))
		return null;
	return { by: "tree", tree: treeAtEnd, closureSize: inClosure.size };
}

/**
 * What one sha offers every per-test judgement made at it (workflow-core#1860), each read
 * memoised: the paths a tree differs from it by, split into those
 * `countedPaths` counts (`holdsAt`; all of them where it is null) and the
 * rest, `landed`; its manifest both ways round; and which of a list of paths
 * it tracks. Every read throws where git or the manifest does.
 *
 * @typedef {{sha: string, touched: (tree: string) => Set<string>,
 *   landed: (tree: string) => Set<string>,
 *   docsOf: () => Map<string, Set<string>>,
 *   readersOf: (p: string) => string[],
 *   tracked: (paths: string[]) => Set<string>}} ShaView
 * @param {string} sha
 * @param {DiffReader} by
 * @returns {ShaView}
 */
function shaView(sha, by) {
	const { git, countedPaths } = by;
	/** @type {Map<string, {touched: Set<string>, landed: Set<string>}>} */
	const diffs = new Map();
	/** @param {string} tree */
	const split = (tree) => {
		const hit = diffs.get(tree);
		if (hit) return hit;
		const all = touchedBetween(tree, sha, { git, countedPaths: null });
		const counts = (/** @type {string} */ p) =>
			countedPaths === null || countedPaths.has(p);
		const parts = {
			touched: new Set(all.filter(counts)),
			landed: new Set(all.filter((p) => !counts(p))),
		};
		diffs.set(tree, parts);
		return parts;
	};
	/** @type {{edges: Record<string, unknown>, byTest: Map<string, Set<string>>}|null} */
	let manifest = null;
	const read = () => {
		if (manifest) return manifest;
		const parsed = JSON.parse(git(["show", `${sha}:${EDGES_FILE}`]));
		const byTest = docsByTest(parsed);
		if (!byTest)
			throw new Error(`${EDGES_FILE} at ${shortSha(sha)} is malformed`);
		manifest = { edges: parsed.edges, byTest };
		return manifest;
	};
	return {
		sha,
		touched: (tree) => split(tree).touched,
		landed: (tree) => split(tree).landed,
		docsOf: () => read().byTest,
		readersOf: (p) => {
			const readers = read().edges[p];
			return isStringList(readers) ? readers : [];
		},
		tracked: (paths) =>
			paths.length === 0
				? new Set()
				: new Set(
						lines(git(["ls-tree", "-r", "--name-only", sha, "--", ...paths])),
					),
	};
}

/**
 * Which of a per-test marker's selected tests still hold at the view's sha
 * (workflow-core#1860): those whose own closure — the test, its recorded imports, the
 * documents the manifest AT THE SHA maps to it (workflow-core#799), and the marker's roots
 * — the diff-tree between `treeAtEnd` and the sha leaves untouched.
 * `codeHolds` says the diff touched no selected test
 * and none of their recorded imports: the graph the run's selection was
 * computed over is unchanged, which a witness needs. Null where git or the
 * manifest will not answer, which holds nothing.
 *
 * AS BLIND AS THE UNION, NEVER BLINDER THAN THE SELECTION. A test reaching a
 * file through a module it `require`s at runtime has neither in its closure
 * unless the manifest names the file; the union closure caught that only
 * where another selected test read the file, which no selection relies on.
 *
 * @param {PerTestMarker} m
 * @param {ShaView} view
 * @returns {{held: Set<string>, rootsHold: boolean, codeHolds: boolean,
 *   match: AttestationMatch}|null}
 */
function testsHeldAt(m, view) {
	const { selected, imports, roots } = m;
	if (m.sha === view.sha)
		return {
			held: new Set(selected),
			rootsHold: true,
			codeHolds: true,
			match: { by: "sha" },
		};
	if (!m.treeAtEnd) return null;
	try {
		const touched = view.touched(m.treeAtEnd);
		const closure = new Set(roots);
		/** @type {AttestationMatch} */
		const match = { by: "tree", tree: m.treeAtEnd, closureSize: 0 };
		if (roots.some((p) => touched.has(p)))
			return { held: new Set(), rootsHold: false, codeHolds: false, match };
		const codeHolds = !selected.some(
			(t) => touched.has(t) || (imports[t] ?? []).some((p) => touched.has(p)),
		);
		const docsOf = view.docsOf();
		const held = new Set();
		for (const t of selected) {
			const own = imports[t];
			if (!own) continue;
			const reads = [t, ...own, ...(docsOf.get(t) ?? [])];
			if (reads.some((p) => touched.has(p))) continue;
			held.add(t);
			for (const p of reads) closure.add(p);
		}
		match.closureSize = closure.size;
		return { held, rootsHold: true, codeHolds, match };
	} catch {
		/* Holding nothing leaves each path owed, the safe verdict, and the
		 * push names the path to re-run. */
		return null;
	}
}

/** git's spelling of "no such sha" in a pre-push line: the remote has no tip. */
const ZERO_SHA = /^0+$/;

/**
 * Whether green runs from any sessions cover a commit between them (ADR-0009,
 * workflow-core#810), per suite.
 *
 * A MEMBER is a run whose scope answers the gate — full, or admissible — and
 * whose verdict holds at `sha` (`holdsAt`).
 * Every path in the range must lie in some member's `changedPaths`, and a full-run
 * member covers every path. A covered suite needs at least one member, so an
 * empty range is not covered by nothing.
 *
 * A PER-TEST MARKER HOLDS TEST BY TEST (workflow-core#1860, `testsHeldAt`), so a path is
 * judged against each test that reads it. A range path P that no older marker covers is covered when some
 * per-test member names P in its `changedPaths` with its roots, its tests and
 * their recorded imports untouched — the witness that a selection was
 * computed with P in view over the graph `sha` still has (ADR-0009) — and every
 * test that reads P at `sha` is held by some per-test member that selected
 * it, any session's and whatever its diff. A test reads P where the manifest
 * at `sha` maps P to it, where P is in its recorded imports, or where it is
 * P; only tests `sha` tracks are asked. An uncovered P with a witness names
 * the readers no member holds (`tests`), the only runs owed for it.
 *
 * THE RANGE runs from the published tip to `sha`: `remoteSha` where the caller
 * has one (the pre-push hook's), otherwise the merge-base of `sha` with the
 * pushed ref (lib/landing-refs.js) — the base the narrowed default resolves. Where git cannot
 * name it, nothing is judged. `within` narrows it to those paths: the
 * session's own work, for the re-run guard (workflow-core#1218). An empty `within` leaves
 * an empty range, which any member holding at `sha` covers.
 *
 * WITH THE `landing` MODULE ON, only a change to a range path voids a member
 * (`holdsAt`'s `countedPaths`, the range before `within`): a clean merge of
 * `origin/landing` owes no re-run, the lander testing it (workflow-core#2517), while a
 * file the merge changed beyond `landing`'s side is in the range and voids.
 *
 * EACH SUITE ANSWERS FOR ITSELF (mantahostels#1256), over the suites
 * `suitesFor` asks the range about.
 *
 * An uncovered path is named with the newest commit in the range touching it,
 * or `null` where git names none. An uncovered verdict naming no path carries
 * `why` instead: the range was empty and no member held.
 *
 * @typedef {{marker: Marker, match: AttestationMatch}} Member
 * @typedef {{path: string, commit: string|null, tests?: string[]}} Unattested
 * @typedef {{suite: string, attested: true, members: Member[], note: string|null}
 *   | {suite: string, attested: false, unattested: Unattested[],
 *     why?: string}} SuiteAttestation
 * @param {string} sha
 * @param {Marker[]} markers
 * @param {GitOptions & {remoteSha?: string|null, within?: string[]|null}} [options]
 * @returns {{judged: true, base: string, range: string[], suites: SuiteAttestation[],
 *     within?: boolean}
 *   | {judged: false, why: string}}
 */
function attestationOf(
	sha,
	markers,
	{ remoteSha = null, within = null, ...options } = {},
) {
	const ctx = gitContext(options);
	if (!ctx.root) return { judged: false, why: "no git repository to read" };
	const { git } = gitReader(ctx);
	const fromRemote = Boolean(remoteSha && !ZERO_SHA.test(remoteSha));
	const pushed = pushedRef({ root: ctx.root });
	let base;
	let range;
	try {
		base = fromRemote
			? String(remoteSha)
			: git(["merge-base", sha, pushed]).trim();
		range = lines(git(["diff", "--name-only", "--no-renames", base, sha]));
	} catch {
		return {
			judged: false,
			why: fromRemote
				? `git could not diff ${shortSha(String(remoteSha))}..${shortSha(sha)}`
				: `git could not resolve the merge-base of ${shortSha(sha)} with ${pushed}`,
		};
	}
	/* A pushed ref other than the verified one is the lander's queue. An empty
	 * range keeps tree holding: with nothing to push, no landing change waits
	 * to be tested with the pusher's. */
	const countedPaths =
		pushed !== VERIFIED_REF && range.length > 0 ? new Set(range) : null;
	if (within) {
		const keep = new Set(within);
		range = range.filter((p) => keep.has(p));
	}
	const judging = { ...ctx, countedPaths };
	const suites = suitesFor(range).map((suite) =>
		suiteAttestation(sha, markers, { suite, range }, judging),
	);
	const gaps = suites.flatMap((s) => (s.attested ? [] : s.unattested));
	if (gaps.length > 0) {
		const last = lastTouched(
			base,
			sha,
			gaps.map((g) => g.path),
			git,
		);
		for (const g of gaps) g.commit = last.get(g.path) ?? null;
	}
	return {
		judged: true,
		base,
		range,
		suites,
		...(within ? { within: true } : {}),
	};
}

/**
 * One suite's cover of `range` at `sha`. A full-run member answers alone;
 * otherwise members are taken greedily, widest remaining cover first and the
 * newest on a tie, so the members named are the few that do the covering.
 *
 * @param {string} sha
 * @param {Marker[]} markers
 * @param {{ suite: string, range: string[] }} target the suite, and the paths
 *   it must cover
 * @param {JudgeOptions} ctx
 * @returns {SuiteAttestation}
 */
function suiteAttestation(sha, markers, { suite, range }, ctx) {
	const newestFirst = markers
		.filter((m) => suiteOf(m) === suite && (isFullRun(m) || isAdmissibleRun(m)))
		.reverse();
	const judge = perTestJudge(sha, ctx);
	const { sole, held, perTest } = heldMembers(sha, newestFirst, range, {
		ctx,
		judge,
	});
	if (sole) return buildAttestedVerdict(sha, suite, [sole]);
	if (range.length === 0)
		return {
			suite,
			attested: false,
			unattested: [],
			why: `no green ${suite} run holds at ${shortSha(sha)}`,
		};
	const { members, left } = pickAttesters(held, range);
	const pairs = pairAttestation([...left], perTest, judge);
	if (pairs.unattested.length > 0)
		return { suite, attested: false, unattested: pairs.unattested };
	return buildAttestedVerdict(sha, suite, [...members, ...pairs.members]);
}

/**
 * @param {string} sha
 * @param {JudgeOptions} ctx
 * @returns {{view: () => ShaView|null, held: (m: PerTestMarker) => ReturnType<typeof testsHeldAt>}}
 */
function perTestJudge(sha, ctx) {
	/** @type {ShaView|null|undefined} */
	let view;
	const getView = () => {
		if (view === undefined) {
			const { git, root } = gitReader(ctx);
			view = root
				? shaView(sha, { git, countedPaths: ctx.countedPaths ?? null })
				: null;
		}
		return view;
	};
	/** @type {Map<Marker, ReturnType<typeof testsHeldAt>>} */
	const judged = new Map();
	return {
		view: getView,
		held: (m) => {
			if (!judged.has(m)) {
				const v = getView();
				judged.set(m, v ? testsHeldAt(m, v) : null);
			}
			return judged.get(m) ?? null;
		},
	};
}

/**
 * The runs holding at `sha`, newest first, each with the paths of `range` it
 * selects — or, as `sole`, the first that answers alone: a full run, or over
 * an empty range any run that holds. A per-test marker (workflow-core#1860) is set aside
 * in `perTest` for `pairAttestation`, holding over an empty range where its roots
 * do.
 *
 * @typedef {Member & {selected: Set<string>}} HeldMember
 * @param {string} sha
 * @param {Marker[]} newestFirst the suite's full and admissible runs
 * @param {string[]} range
 * @param {{ctx: JudgeOptions, judge: ReturnType<typeof perTestJudge>}} by
 * @returns {{sole: Member|null, held: HeldMember[], perTest: PerTestMarker[]}}
 */
function heldMembers(sha, newestFirst, range, { ctx, judge }) {
	const inRange = new Set(range);
	/** @type {HeldMember[]} */
	const held = [];
	/** @type {PerTestMarker[]} */
	const perTest = [];
	for (const m of newestFirst) {
		if (!isFullRun(m) && isPerTest(m)) {
			const tests = range.length === 0 ? judge.held(m) : null;
			/* Over an empty range a per-test marker answers alone only whole. */
			if (tests && tests.held.size === m.selected.length)
				return { sole: { marker: m, match: tests.match }, held, perTest };
			perTest.push(m);
			continue;
		}
		const whole = wholeHolding(m, sha, { range, inRange, ctx });
		if (whole?.alone) return { sole: whole.member, held, perTest };
		if (whole) held.push(whole.member);
	}
	return { sole: null, held, perTest };
}

/**
 * A marker judged whole at `sha`, as `heldMembers` takes it: the member, and
 * whether it answers alone — or null where it holds or selects nothing.
 *
 * @param {Marker} m
 * @param {string} sha
 * @param {{range: string[], inRange: Set<string>, ctx: JudgeOptions}} over
 * @returns {{member: HeldMember, alone: boolean}|null}
 */
function wholeHolding(m, sha, { range, inRange, ctx }) {
	const selectsAll = isFullRun(m);
	const selected = new Set(
		selectsAll ? range : (m.changedPaths ?? []).filter((p) => inRange.has(p)),
	);
	/* Only a run selecting something earns a git call — or, over an empty
	 * range, any run at all, since one member must still hold. */
	if (selected.size === 0 && range.length > 0) return null;
	const match = holdsAt(m, sha, ctx);
	if (!match) return null;
	return {
		member: { marker: m, match, selected },
		alone: selectsAll || range.length === 0,
	};
}

/**
 * `left`'s cover by per-test members (workflow-core#1860), by the rule `attestationOf`
 * states: a witness naming each path, and a holder for each of its readers.
 * Newest members are asked first, so the members named are the latest that
 * answer.
 *
 * @param {string[]} left the paths no older marker covered
 * @param {PerTestMarker[]} perTest newest first
 * @param {ReturnType<typeof perTestJudge>} judge
 * @returns {{members: Member[], unattested: Unattested[]}}
 */
function pairAttestation(left, perTest, judge) {
	/** @type {Unattested[]} */
	const unattested = [];
	/** @type {Map<Marker, AttestationMatch>} */
	const used = new Map();
	const view = left.length > 0 && perTest.length > 0 ? judge.view() : null;
	const readers = view ? readerIndex(left, perTest, view) : null;
	for (const p of left) {
		const cover = readers ? pathCover(p, readers, perTest, judge) : null;
		if (cover && "members" in cover)
			for (const { marker, match } of cover.members) used.set(marker, match);
		else unattested.push({ path: p, commit: null, ...cover });
	}
	return {
		members: [...used].map(([marker, match]) => ({ marker, match })),
		unattested,
	};
}

/**
 * `p`'s cover by `perTest`: its witness and each reader's holder, or the
 * readers none holds — or null where no witness names it.
 *
 * An importable `p` needs a witness whose tests' imports are untouched too: a
 * changed module can give `p` an importer no marker recorded, which only a
 * run selecting from `p` again finds. A document's readers are the manifest
 * at the sha, so its witness needs its roots alone (workflow-core#1860).
 *
 * A reader whose own file changed since the witness's tree only outside
 * `countedPaths` came from `landing` — added there, say — so no run of the
 * pusher's could select it, and the lander's is owed it (workflow-core#2517).
 *
 * @param {string} p
 * @param {Map<string, string[]>} readers
 * @param {PerTestMarker[]} perTest newest first
 * @param {ReturnType<typeof perTestJudge>} judge
 * @returns {{members: Member[]} | {tests: string[]} | null}
 */
function pathCover(p, readers, perTest, judge) {
	const witness = firstHolding(
		perTest,
		judge,
		(m) => (m.changedPaths ?? []).includes(p),
		(tests) => tests.rootsHold && (tests.codeHolds || !IMPORTABLE.test(p)),
	);
	if (!witness) return null;
	const view = judge.view();
	const landed =
		view && witness.match.by === "tree"
			? view.landed(witness.match.tree)
			: new Set();
	const { holders, missing } = readersHeld(
		(readers.get(p) ?? []).filter((t) => !landed.has(t)),
		perTest,
		judge,
	);
	return missing.length > 0
		? { tests: missing }
		: { members: [witness, ...holders] };
}

/**
 * The newest member holding each of `tests`, and the tests none holds, sorted.
 *
 * @param {string[]} tests
 * @param {PerTestMarker[]} perTest newest first
 * @param {ReturnType<typeof perTestJudge>} judge
 * @returns {{holders: Member[], missing: string[]}}
 */
function readersHeld(tests, perTest, judge) {
	/** @type {Member[]} */
	const holders = [];
	/** @type {string[]} */
	const missing = [];
	for (const t of tests) {
		const holder = firstHolding(
			perTest,
			judge,
			(m) => Boolean(m.selected?.includes(t)),
			(held) => held.held.has(t),
		);
		if (holder) holders.push(holder);
		else missing.push(t);
	}
	return { holders, missing: missing.sort() };
}

/**
 * The newest of `perTest` that `asks` and whose judgement `accepts`, as a
 * member, or null. `asks` is read first, so only a candidate costs a git call.
 *
 * @param {PerTestMarker[]} perTest
 * @param {ReturnType<typeof perTestJudge>} judge
 * @param {(m: Marker) => boolean} asks
 * @param {(tests: NonNullable<ReturnType<typeof testsHeldAt>>) => boolean} accepts
 * @returns {Member|null}
 */
function firstHolding(perTest, judge, asks, accepts) {
	for (const m of perTest) {
		if (!asks(m)) continue;
		const tests = judge.held(m);
		if (tests && accepts(tests)) return { marker: m, match: tests.match };
	}
	return null;
}

/**
 * Each of `paths` to the tests that read it at the view's sha (workflow-core#1860): the
 * manifest's readers, every per-test marker's recorded importers, and the
 * path itself where it is a test — each only where the sha tracks it, so a
 * deleted test is owed by nobody. Null where git or the manifest will not
 * answer, which leaves every path uncovered.
 *
 * @param {string[]} paths
 * @param {PerTestMarker[]} perTest
 * @param {ShaView} view
 * @returns {Map<string, string[]>|null}
 */
function readerIndex(paths, perTest, view) {
	/** @type {Map<string, Set<string>>} */
	const importers = new Map();
	for (const m of perTest)
		for (const [t, reached] of Object.entries(m.imports ?? {}))
			for (const p of reached) {
				const tests = importers.get(p) ?? new Set();
				tests.add(t);
				importers.set(p, tests);
			}
	try {
		/** @type {Map<string, Set<string>>} */
		const candidates = new Map();
		for (const p of paths)
			candidates.set(
				p,
				new Set([
					...view.readersOf(p),
					...(importers.get(p) ?? []),
					...(JS_TEST_FILE.test(p) ? [p] : []),
				]),
			);
		const tracked = view.tracked([
			...new Set([...candidates.values()].flatMap((s) => [...s])),
		]);
		return new Map(
			[...candidates].map(([p, tests]) => [
				p,
				[...tests].filter((t) => tracked.has(t)),
			]),
		);
	} catch {
		/* No readers leaves every path owed. */
		return null;
	}
}

/**
 * @param {HeldMember[]} held
 * @param {string[]} range
 * @returns {{members: Member[], left: Set<string>}}
 */
function pickAttesters(held, range) {
	const left = new Set(range);
	/** @type {Member[]} */
	const members = [];
	while (left.size > 0) {
		const best = widestAttester(held, left);
		if (!best) break;
		members.push({ marker: best.marker, match: best.match });
		for (const p of best.selected) left.delete(p);
	}
	return { members, left };
}

/**
 * The first of `held` covering the most of `left`, or `null` where none
 * covers any.
 * @param {HeldMember[]} held
 * @param {Set<string>} left
 * @returns {HeldMember|null}
 */
function widestAttester(held, left) {
	let best = null;
	let bestGain = 0;
	for (const h of held) {
		let gain = 0;
		for (const p of h.selected) if (left.has(p)) gain++;
		if (gain > bestGain) {
			best = h;
			bestGain = gain;
		}
	}
	return best;
}

/**
 * @param {string} sha
 * @param {string} suite
 * @param {Member[]} members
 * @returns {SuiteAttestation}
 */
function buildAttestedVerdict(sha, suite, members) {
	const note = members
		.map(({ marker, match }) => treeMatchNote(sha, marker, match, suite))
		.filter(Boolean)
		.join("");
	return { suite, attested: true, members, note: note || null };
}

/**
 * The newest commit in `base..sha` touching each of `paths`, by one `git log`.
 * A path git names no commit for is absent from the map; a failed log leaves
 * it empty.
 *
 * @param {string} base
 * @param {string} sha
 * @param {string[]} paths
 * @param {(args: string[]) => string} git
 * @returns {Map<string, string>}
 */
function lastTouched(base, sha, paths, git) {
	/** @type {Map<string, string>} */
	const last = new Map();
	let out;
	try {
		out = git([
			"log",
			"--format=%x00%H",
			"--name-only",
			"--no-renames",
			`${base}..${sha}`,
			"--",
			...new Set(paths),
		]);
	} catch {
		return last;
	}
	for (const entry of out.split("\0").filter(Boolean)) {
		const [commit, ...touched] = lines(entry);
		// `%x00%H` opens every record with its sha.
		if (commit === undefined)
			throw new Error(
				`git log record carries no sha: ${JSON.stringify(entry)}`,
			);
		for (const p of touched) if (!last.has(p)) last.set(p, commit);
	}
	return last;
}

/**
 * The line that says a sha was cleared by content rather than identity (workflow-core#189
 * §4): a reader must be able to tell the two apart, since a tree match rests
 * on the closure's blind spots and a sha match on none.
 *
 * @param {string} sha
 * @param {Marker} m
 * @param {AttestationMatch} match
 * @param {string} [suite]
 */
function treeMatchNote(sha, m, match, suite = DEFAULT_SUITE) {
	if (match.by !== "tree") return null;
	const { name } = suiteMeta(suite);
	const closure =
		match.closureSize === "*"
			? "closure: the whole tree"
			: `closure of ${match.closureSize} paths`;
	return `ℹ  ${name}: ${shortSha(sha)} attested by tree ${shortSha(match.tree)} from run at ${m.at ?? "an unknown time"} (${closure}) — a content match, not a sha match (workflow-core#189).\n`;
}

/** @param {string} sha */
const shortSha = (sha) => String(sha).slice(0, 12);

/**
 * Whether every suite `attestationOf` asked about is attested.
 *
 * @param {ReturnType<typeof attestationOf>} verdict
 */
const isAttested = (verdict) =>
	verdict.judged && verdict.suites.every((s) => s.attested);

/* How many files a list shows before it truncates — a suite's unattested files
 * here, the last red's failing files in session-verdict.js. A guess: a reader
 * checks the first names against their own diff and reads no further. */
const MAX_LISTED_FILES = 20;

/**
 * A suite's unattested files, each with the commit that carries it, truncated —
 * the list the pre-push hook, `push:check` and the `result:` refusal all print.
 * @param {SuiteAttestation & {attested: false}} s
 * @param {string} indent
 * @returns {string[]}
 */
function unattestedFileLines(s, indent) {
	const more = s.unattested.length - MAX_LISTED_FILES;
	return [
		...s.unattested
			.slice(0, MAX_LISTED_FILES)
			.map(
				({ path: p, commit, tests }) =>
					`${indent}${p} — commit ${commit ? shortSha(commit) : "unknown"}${namesTests({ tests }) ? ` — owed by ${tests?.join(", ")} (workflow-core#1860)` : ""}`,
			),
		...(more > 0 ? [`${indent}…and ${more} more`] : []),
	];
}

/**
 * `attestationOf`'s verdict as the lines a session reads: before a push, from
 * `push:check`, or as one goes out, from the pre-push hook (`pushing`). Each
 * suite speaks for itself (mantahostels#1256).
 *
 * A covered suite at the push says only what qualifies its cover — a tree
 * match (workflow-core#189 §4), or a member matched by sha over a dirty tree — and so is
 * usually silent; `push:check` names the runs that cover.
 *
 * `advise` replaces an owed suite's advice before a push, where it returns lines.
 *
 * @param {string} sha
 * @param {ReturnType<typeof attestationOf>} verdict
 * @typedef {(s: SuiteAttestation & {attested: false}) => string[]|null} Advise
 * @param {{pushing?: boolean, pushCheck?: string, advise?: Advise}} [options]
 * @returns {{state: "attested"|"owed"|"unjudged", text: string}}
 */
function attestationReading(
	sha,
	verdict,
	{ pushing = false, pushCheck, advise = () => null } = {},
) {
	if (!verdict.judged)
		return {
			state: "unjudged",
			text: `⚠  could not judge whether green runs cover ${shortSha(sha)}: ${verdict.why}.${pushing ? " This never refuses a push (mantahostels#908)." : ""}\n`,
		};
	const parts = verdict.suites.map((s) =>
		s.attested
			? attestedLines(sha, s, pushing, Boolean(verdict.within))
			: owedLines(sha, verdict.base, s, { pushing, pushCheck, advise }),
	);
	return {
		state: isAttested(verdict) ? "attested" : "owed",
		text: parts.join(""),
	};
}

/**
 * @param {string} sha
 * @param {SuiteAttestation & {attested: true}} s
 * @param {boolean} pushing
 * @param {boolean} [narrowed] the verdict judged `within` paths, not the range
 */
function attestedLines(sha, s, pushing, narrowed = false) {
	const out = [];
	if (!pushing) {
		const { name } = suiteMeta(s.suite);
		out.push(
			`✓  ${name}: every file ${narrowed ? "this run would test" : "in the range"} is covered by ${s.members.length} green run(s):\n`,
			...s.members.map(
				({ marker: m }) =>
					`     ${m.at ?? "unknown time"} on ${shortSha(m.sha)} — ${isFullRun(m) ? "full run" : `narrowed run over ${(m.changedPaths ?? []).length} changed path(s)`}\n`,
			),
		);
	}
	if (s.note) out.push(s.note);
	const dirty = s.members.find(
		({ marker, match }) => match.by === "sha" && !isClean(marker),
	);
	if (dirty) out.push(dirtyWarning(sha, dirty.marker, s.suite));
	return out.join("");
}

/**
 * @param {string} sha
 * @param {string} base
 * @param {SuiteAttestation & {attested: false}} s
 * @param {{pushing: boolean, pushCheck?: string, advise: Advise}} options
 */
function owedLines(sha, base, s, { pushing, pushCheck, advise }) {
	const { name, gate } = suiteMeta(s.suite);
	const head =
		s.unattested.length > 0
			? [
					`⚠  NO GREEN ${name} RUN COVERS ${s.unattested.length} FILE(S) IN ${shortSha(base)}..${shortSha(sha)}:`,
					...unattestedFileLines(s, "     "),
				]
			: [`⚠  ${s.why ?? `no green ${name.toLowerCase()} run holds`}.`];
	const retest = retestCommand(s.unattested, gate);
	const whole = s.unattested.every(namesTests);
	const advice = pushing
		? [
				"   Those commits are already public.",
				`   Run \`${retest && whole ? retest : gate}\` now, report any red, and run \`${pushCheck ?? commandOrDefault("push_check")}\` before your next push. This never refuses a push (mantahostels#908).`,
			]
		: (advise(s) ?? rerunLines(s.unattested, gate));
	return `${[...head, ...advice].join("\n")}\n`;
}

/** @param {Pick<Unattested, "tests">} u */
const namesTests = (u) => (u.tests?.length ?? 0) > 0;

/**
 * The command re-running only the tests no member holds (workflow-core#1860), across every
 * entry naming them, or null where none does.
 *
 * @param {Unattested[]} unattested
 * @param {string} gate
 * @returns {string|null}
 */
function retestCommand(unattested, gate) {
	const tests = [...new Set(unattested.flatMap((u) => u.tests ?? []))].sort();
	return tests.length > 0
		? `${gate} -- ${RETEST_FLAG} ${tests.map(shellWord).join(" ")}`
		: null;
}

/**
 * What to run for `unattested` before a push: the re-run of the tests it
 * names, and the gate for the files that name none — "for that" where
 * nothing else is said, otherwise "for the other N file(s)" and `others`.
 *
 * @param {Unattested[]} unattested
 * @param {string} gate
 * @param {string|null} [others] what the gate's line calls the other files
 * @returns {string[]}
 */
function rerunLines(unattested, gate, others = null) {
	const retest = retestCommand(unattested, gate);
	const rest = unattested.filter((u) => !namesTests(u)).length;
	const gateLine =
		retest || others !== null
			? `   Run \`${gate}\` for the other ${rest} file(s)${others ?? ""}, then push.`
			: `   Run \`${gate}\` for that, then push.`;
	return [
		...(retest
			? [
					`   ${unattested.length - rest} of them are read by test(s) whose own reads changed since their green; re-run only those (workflow-core#1860):`,
					`     ${retest}`,
				]
			: []),
		...(rest > 0 || !retest ? [gateLine] : []),
	];
}

/**
 * Whether the session's own last commit is covered — or, failing that, a
 * later commit up to HEAD that contains it (workflow-core#807, workflow-core#810 story 32). Every run
 * reads HEAD, so once a neighbour commits on top no run can reproduce the
 * session's commit, and a gate demanding one prescribes a re-run that cannot
 * succeed.
 *
 * The commits tried are `own`, HEAD, and the sha of each full or admissible
 * run lying between them. Never HEAD alone (mantahostels#1253): a neighbour's
 * uncovered commit above an earlier covered one refuses nothing.
 *
 * On a miss the verdict returned is HEAD's where git could judge it, else the
 * first judged; where none could be judged, the first reason. `within` narrows
 * every commit tried to the session's own work, as `attestationOf` reads it.
 *
 * @param {string} own
 * @param {Marker[]} markers
 * @param {GitOptions & {within?: string[]|null}} [options]
 * @returns {{judged: true, attested: boolean, at: string, verdict: ReturnType<typeof attestationOf>}
 *   | {judged: false, why: string}}
 */
function sessionAttestation(own, markers, { within = null, ...options } = {}) {
	const ctx = gitContext(options);
	const { git } = gitReader(ctx);
	let head = null;
	/** @type {Set<string>} */
	let between = new Set();
	try {
		head = git(["rev-parse", "HEAD"]).trim();
		between = new Set(
			lines(git(["rev-list", "--ancestry-path", `${own}..${head}`])),
		);
	} catch {
		/* `own` alone is still judged */
	}
	const tried = new Set([
		own,
		...(head ? [head] : []),
		...markers
			.filter((m) => between.has(m.sha) && (isFullRun(m) || isAdmissibleRun(m)))
			.map((m) => m.sha),
	]);
	/** @type {Map<string, ReturnType<typeof attestationOf>>} */
	const misses = new Map();
	let why = null;
	for (const sha of tried) {
		const verdict = attestationOf(sha, markers, { ...ctx, within });
		if (!verdict.judged) {
			why ??= verdict.why;
			continue;
		}
		if (isAttested(verdict))
			return { judged: true, attested: true, at: sha, verdict };
		misses.set(sha, verdict);
	}
	const at = head && misses.has(head) ? head : [...misses.keys()][0];
	if (!at) return { judged: false, why: why ?? "nothing to judge" };
	return {
		judged: true,
		attested: false,
		at,
		verdict: /** @type {ReturnType<typeof attestationOf>} */ (misses.get(at)),
	};
}

/**
 * The line the reporter prints the moment a narrowed run ends — null for a full
 * one, which prints nothing new.
 *
 * THE PUSH IS TOO LATE FOR THE CASE THIS EXISTS FOR (mantahostels#504). Vitest's own summary
 * already prints the skipped count, but its file denominator is the collected
 * set (`Test Files 1 passed (1)`), never the corpus — so the run looks complete
 * in its own terms.
 *
 * @param {Scope|null|undefined} scope
 * @returns {string|null}
 */
function formatFilteredRun(scope) {
	if (!scope || isFullScope(scope)) return null;
	const bits = [
		`ran ${scope.tests - scope.skipped} of ${scope.tests} tests` +
			` in ${scope.modulesRun} of ${scope.modulesTotal} files`,
	];
	if (scope.skipped) bits.push(`${scope.skipped} skipped`);
	// pytest's filter arrives already carrying its own flag (`-k corpus`), so
	// prefixing vitest's would print `-t -k corpus`.
	if (scope.nameFilter)
		bits.push(
			scope.nameFilter.startsWith("-")
				? scope.nameFilter
				: `-t ${scope.nameFilter}`,
		);
	const files = scope.fileFilters || [];
	if (files.length > 0) bits.push(`paths: ${files.join(", ")}`);
	if (scope.changed)
		bits.push(
			`--changed${typeof scope.changed === "string" ? ` ${scope.changed}` : ""}`,
		);
	if (isAdmissibleScope(scope))
		bits.push("MEETS the push gate — the read graph rendered");
	return `FILTERED RUN — ${bits.join("; ")}`;
}

/**
 * The reason clause `dirtyWarning` folds into its one line — what made the
 * tree dirty, in priority order.
 *
 * @param {Marker} marker
 * @returns {string}
 */
function dirtyReason(marker) {
	const foreign = marker.foreign || [];
	if (foreign.length > 0)
		return `read ${foreign.length} file(s) another session held`;
	if (marker.startStateUnknown)
		return "began over a tree git could not read, so cleanliness is unknown";
	if (marker.headMovedDuringRun) return "ran while HEAD moved under it";
	return `read ${marker.dirtyCount || "some"} uncommitted tracked file(s)`;
}

/**
 * One line: the verdict, why the tree was dirty, and the command that clears
 * it (mantahostels#2170).
 *
 * @param {string} sha
 * @param {Marker} marker
 * @param {string} [suite]
 */
function dirtyWarning(sha, marker, suite = DEFAULT_SUITE) {
	const { name, gate } = suiteMeta(suite);
	return `⚠  dirty tree: the green ${name.toLowerCase()} run on ${shortSha(sha)} ${dirtyReason(marker)}. Clear: ${gate} on a still tree.\n`;
}

module.exports = {
	STORE,
	EDGES_FILE,
	FAIL_STORE,
	recordFailure,
	KEEP,
	repoRoot,
	storePath,
	record,
	readMarkers,
	countMalformed,
	readFailures,
	lastFullRed,
	markerFrom,
	isFullRun,
	isAdmissibleRun,
	isFullScope,
	holdsAt,
	docsReadBy,
	attestationOf,
	rerunLines,
	namesTests,
	retestCommand,
	RETEST_FLAG,
	attestationReading,
	sessionAttestation,
	FULL_RED_RATIO,
	MAX_LISTED_FILES,
	FULL_REASONS,
	FULL_CAUSES,
	suiteMeta,
	shortSha,
	DEFAULT_SUITE,
	suiteOf,
	formatFilteredRun,
};
