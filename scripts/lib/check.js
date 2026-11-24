/*
 * Usage:
 *   const { runCheck } = require("./lib/check.js");
 *   runCheck(SPEC);
 *
 * The reporting tail every check-*.js shares: argv, severity, streams, the
 * summary line, annotations and the exit code. Five outcomes over three exit
 * codes:
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
 * WORKING TREE. A checker that direction-gates declares
 * `against` in its spec; runCheck then does the whole job for it:
 *
 *   1. materialise the INDEX as a tree and re-exec ITSELF over it
 *      (`node <argv[1]> --root <dir> --json`);
 *   2. only if that reading holds gating faults, do the same for <rev>;
 *   3. report the faults the index side has and <rev> does not, through
 *      scripts/lib/fault-profiles.js's profile table.
 *
 * BOTH SIDES ARE COMMIT BYTES. The parent does no checking of its own: reading
 * a file in place judges its working copy rather than this commit's.
 *
 * `--head <rev>` beside `--against <rev>` names a commit as the judged side in
 * place of the index.
 *
 * --index. The same materialised index and re-exec as step 1, with no <rev>:
 * every finding the index side holds is this commit's, inherited or not. For a
 * whole-tree gate, which refuses every breach the tree holds but must judge
 * this commit's bytes rather than an untracked or unstaged file
 *. Legal wherever `against` is declared.
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
 * is where a profile says what getting worse means, and its `measure`
 * is where it says what the number IS, so the refusal can carry the baseline
 * and the delta rather than the total alone — measuredDelta().
 *
 * WHOSE CODE READS THE BASELINE. By default both sides run the checker this
 * process runs. `baselineCode: "rev"` runs each baseline rev's own copy
 * instead, where that tree carries one at this checker's path: a checker whose
 * findings hash its own definition (check-guard-registry.js's digests) would
 * otherwise read a change to that definition as faulting both sides alike, and
 * pass the commit that made them; one that reads its revision's code
 * (check-context-budget.js's text module) would read a baseline in the old
 * shape as BROKEN, so a commit changing the code and its reader together could
 * not land as one merge.
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
const { persisting } = require("./persist-mode.js");
const { reportOwner } = require("./session-id.js");
const { ENVELOPE_FRAME_KEYS } = require("./envelope-frame-keys.js");
const { isUnder } = require("./is-under.js");
const { readCommitOrBroken } = require("./commit-sha.js");
const { SIDE_ENV, SIDE_REV_ENV } = require("./check-side.js");
const { GIT_MODE } = require("./git-mode.js");
const {
	brokenError,
	isOutcomeError,
	outcomeOf,
	skipError,
} = require("./outcome-error.js");
const { readObjectBatch, listTree } = require("./git-objects.js");

// workflow-core#464
const NOTIFY_REPORT = path.join(__dirname, "notify-report.js");
/** @returns {typeof import("./notify-report.js")} */
const loadNotify = () => require(NOTIFY_REPORT);

const AGAINST = "--against";
const HEAD_FLAG = "--head";
const INDEX_FLAG = "--index";

const LIBRARY_FLAGS = [
	"--warn",
	"--json",
	"--json-text",
	"--notify",
	"--help",
	AGAINST,
	HEAD_FLAG,
	INDEX_FLAG,
];

const AGAINST_FLAGS = ["--root"];

const SAY_FD_ENV = "WFC_CHECK_SAY_FD";

/** @returns {number | null} */
function sayFdFromEnv() {
	const fd = Number(process.env[SAY_FD_ENV]);
	return Number.isInteger(fd) && fd > 0 ? fd : null;
}

/**
 * @returns {"index" | "baseline" | undefined}
 */
function sideFromEnv() {
	const side = process.env[SIDE_ENV];
	return side === "index" || side === "baseline" ? side : undefined;
}

/** @typedef {"spawn" | "in-process"} SideRun */

/** @type {string | null} */
let openedKey = null;

let finished = false;

/** @param {number} code @returns {never} */
function exitFinished(code) {
	finished = true;
	process.exit(code);
}

const { CHILD_MAX_BUFFER: MAX_BUFFER } = require("./child-buffer.js");
const { caught } = require("./caught.js");
const { noop } = require("./noop.js");
const { writeFd } = require("./write-fd.js");
const { envelope: hookEnvelope } = require("./hook-envelope.js");

const { FD_SINK, BufferSink } = require("./check-sink.js");
/** @typedef {import("./check-sink.js").Sink} Sink */

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
 * @typedef {{ okLine?: string, noun?: string, count?: number, data?: object,
 *   stamp?: string, stamps?: Record<string, string>,
 *   maxAgeMs?: number, afterReport?: () => void }} CheckResult
 * @typedef {{
 *   profile: string,
 *   materialise: "tree" | "blobs",
 *   pathspecs?: (ctx: CheckContext, rev: string) => string[],
 *   baseline?: "lazy" | "always",
 *   baselineCode?: "rev",
 *   refuse?: (ctx: CheckContext) => void,
 *   settle?: (ctx: CheckContext, added: FaultItem[], sides: Sides) => { refuse: FaultItem[], remedy: string[], data?: object },
 * }} AgainstSpec
 * @typedef {{
 *   baseline: Record<string, unknown> | undefined,
 *   read: (rev: string) => { outcome: Outcome, summary: string, envelope: Record<string, unknown> },
 * }} Sides
 * @typedef {{
 *   name: string,
 *   usage: string,
 *   valueFlags?: string[],
 *   flags?: string[],
 *   module?: import("./workflow-core-config.js").ModuleGate,
 *   against?: AgainstSpec,
 *   screenNotices?: boolean,
 *   run: (ctx: CheckContext) => CheckResult | void | Promise<CheckResult | void>,
 * }} CheckSpec
 * @typedef {{ lines: string[], notify: typeof import("./notify-report.js"),
 *   startedAtMono: number }} Persist
 */

/** @param {import("./workflow-core-config.js").ModuleGate} modules */
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
	 *   screen?: string[], persisting?: boolean, sink?: Sink,
	 *   script?: string, spec?: CheckSpec, sides?: SideRun,
	 *   side?: "index" | "baseline", sayFd?: number | null }} opts
	 */
	constructor(argv, opts) {
		this.argv = argv;
		this.sink = opts.sink ?? FD_SINK;
		this.script = opts.script;
		this._spec = opts.spec;
		/** @type {SideRun} */
		this.sides = opts.sides ?? "spawn";
		this.side = opts.side ?? sideFromEnv();
		/** @type {string | undefined} */
		this.sideRev =
			opts.side === undefined && this.side
				? process.env[SIDE_REV_ENV] || undefined
				: undefined;
		this.warnOnly = argv.includes("--warn");
		this.asJson = argv.includes("--json");
		this.jsonText = argv.includes("--json-text");
		this.notify = argv.includes("--notify");
		this.persisting = Boolean(opts.persisting);
		this.inActions = process.env.GITHUB_ACTIONS === "true";
		/** @type {Finding[]} */
		this.findings = [];
		/** @type {string[]} */
		this.dirtyNotes = [];
		this._usage = opts.usage;
		this._capture = opts.capture || null;
		this._screen = opts.screen ?? null;
		this._jsonLines = /** @type {string[]} */ ([]);
		this._sayFd = opts.sayFd === undefined ? sayFdFromEnv() : opts.sayFd;
		this.args = positionals(argv, opts.valueFlags || []);
	}

	/** @returns {boolean} */
	isBaselineSide() {
		return this.side === "baseline";
	}

	/** @param {string} flag */
	has(flag) {
		return this.argv.includes(flag);
	}

	/**
	 * @overload
	 * @param {string} flag
	 * @returns {string | null}
	 * @overload
	 * @param {string} flag
	 * @param {string} fallback
	 * @returns {string}
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
	 * @param {string} message
	 * @returns {never}
	 */
	usageError(message) {
		throw brokenError(`${message}\nusage: ${this._usage}`);
	}

	/**
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

	/** @param {string} message */
	say(message = "") {
		if (this._capture) {
			this._capture.push(message);
			return;
		}
		if (this._sayFd !== null) {
			this.sink.write(this._sayFd, `${message}\n`);
			return;
		}
		if (this.asJson) {
			if (this.jsonText) this._jsonLines.push(message);
			return;
		}
		this.sink.write(this.notify ? 1 : 2, `${message}\n`);
	}

	/** @param {string} message */
	sayNotice(message) {
		this.say(message);
		this._screen?.push(message);
	}

	flushBuffered() {
		if (!this._screen) return;
		const context = (this._capture ?? []).join("\n");
		const screen = this._screen.join("\n");
		if (!context) return;
		this.sink.write(
			1,
			screen
				? JSON.stringify({
						systemMessage: screen,
						...hookEnvelope("SessionStart", { additionalContext: context }),
					})
				: `${context}\n`,
		);
	}

	/**
	 * @param {string} tag
	 * @param {string} message
	 * @param {object} [data]
	 * @param {string} [key]
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
	 * @param {string} tag
	 * @param {string} message
	 * @param {object} [data]
	 * @param {string} [key]
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
	 * @param {string} message
	 * @returns {never}
	 */
	skip(message) {
		throw skipError(message);
	}

	/**
	 * @param {string} message
	 * @returns {never}
	 */
	broken(message) {
		throw brokenError(message);
	}

	/** @param {string} message */
	dirtied(message) {
		this.dirtyNotes.push(message);
	}
}

/**
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
 * @param {string[]} ownArgs
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

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function unborn() {
	const r = spawnGitSync(["rev-list", "--all", "--count"], {
		encoding: "utf8",
	});
	return r.status === 0 && r.stdout.trim() === "0";
}

/** @param {string} rev */
function baselineOf(rev) {
	if (rev !== "HEAD") return rev;
	return readCommitOrBroken(rev) === null && unborn() ? EMPTY_TREE : rev;
}

/**
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
 * @param {string} privateIndex
 * @returns {string}
 */
function indexTree(privateIndex) {
	const live = git(
		["rev-parse", "--git-path", "index"],
		"locating the index",
	).trim();
	if (fs.existsSync(live)) fs.copyFileSync(live, privateIndex);
	return git(["write-tree"], "reading the index", {
		...process.env,
		GIT_INDEX_FILE: privateIndex,
	}).trim();
}

/**
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
 * @type {Record<string, (rev: string, dir: string, pathspecs: string[]) => void>}
 */
const MATERIALISERS = {
	tree: extractTree,

	blobs(rev, dir, pathspecs) {
		if (pathspecs.length === 0)
			throw brokenError(
				`a blob fetch at ${rev} was asked for and the spec named no pathspec.`,
			);
		writeBlobs(rev, dir, pathspecs);
	},
};

/**
 * @param {string} rev
 * @param {string} dir
 * @param {string[]} pathspecs
 */
function writeBlobs(rev, dir, pathspecs) {
	const entries = listTree(rev, pathspecs).filter(
		(e) => e.mode !== GIT_MODE.gitlink && !isPresent(path.join(dir, e.path)),
	);

	if (entries.length === 0) return;

	const bodies = readObjectBatch(
		entries.map((e) => e.sha),
		`${rev}'s blobs`,
	);

	for (const [i, e] of entries.entries()) {
		const body = bodies[i]?.body;
		if (!body)
			throw brokenError(
				`git cat-file would not return ${rev}'s blob for ${e.path}, ` +
					"which ls-tree had listed.",
			);
		writeEntry(e, body, { rev, dir });
	}
}

/** @param {string} file */
function isPresent(file) {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {{ mode: string, path: string }} e
 * @param {Buffer} body
 * @param {{ rev: string, dir: string }} at
 */
function writeEntry(e, body, { rev, dir }) {
	const dest = path.join(dir, e.path);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	if (e.mode === GIT_MODE.symlink) {
		const target = body.toString("utf8");
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
 * @param {string} dir
 * @param {string} label
 * @param {{ stream: boolean, side: "index" | "baseline", code?: string,
 *   sink: Sink, env?: NodeJS.ProcessEnv }} opts
 * @param {string[]} args
 * @returns {{ outcome: Outcome, summary: string, envelope: Record<string, unknown> }}
 */
function reread(dir, label, { stream, side, code, sink, env }, args) {
	const self = code;
	if (self === undefined)
		throw brokenError(`no checker script is named to re-run over ${label}.`);
	const live = sink === FD_SINK;
	const r = spawnSync(
		process.execPath,
		[self, "--root", dir, "--json", ...args],
		{
			encoding: "utf8",
			maxBuffer: MAX_BUFFER,
			stdio: ["ignore", "pipe", sideStderr(stream, live)],
			env: {
				...process.env,
				...env,
				[SIDE_ENV]: side,
				[SIDE_REV_ENV]: undefined,
				...(stream && { [SAY_FD_ENV]: "2" }),
			},
		},
	);
	if (stream && !live && r.stderr) sink.write(2, r.stderr);
	if (r.error)
		throw brokenError(
			`could not re-run this check over ${label}: ${r.error.message}`,
		);
	return envelopeOf(r.stdout, label, r.status);
}

/**
 * @param {string} stdout
 * @param {string} label
 * @param {number | null} exit
 * @returns {{ outcome: Outcome, summary: string, envelope: Record<string, unknown> }}
 */
function envelopeOf(stdout, label, exit) {
	let envelope;
	try {
		envelope = JSON.parse(stdout);
	} catch (e) {
		throw brokenError(
			`this check produced no readable --json envelope over ${label} (exit ${exit}).`,
			{ cause: e },
		);
	}
	const outcome = /** @type {Outcome} */ (envelope?.outcome);
	if (!OUTCOMES[outcome])
		throw brokenError(`this check's envelope over ${label} names no outcome.`);
	return { outcome, summary: String(envelope.summary ?? ""), envelope };
}

/**
 * @param {boolean} stream
 * @param {boolean} live
 * @returns {"ignore" | "inherit" | "pipe"}
 */
function sideStderr(stream, live) {
	if (!stream) return "ignore";
	return live ? "inherit" : "pipe";
}

/**
 * @param {import("./fault-diff.js").FaultDiffProfile} profile
 * @param {{ key: string, item: unknown }} fault
 * @param {{ staged: Record<string, unknown>, baseline: Record<string, unknown> | undefined, rev: string }} envelopes
 * @returns {{ base: number, delta: number, line: string } | undefined}
 */
function measuredDelta(profile, fault, { staged, baseline, rev }) {
	if (!profile.measure || !baseline) return;
	const now = profile.measure(fault.item, fault.key, staged);
	const base = profile.measure(fault.item, fault.key, baseline);
	if (typeof now !== "number" || typeof base !== "number") return;
	const delta = now - base;
	if (delta <= 0) return;
	const u = ` ${profile.unit}`;
	const line = `  ${rev} had ${base}${u}, so this commit adds ${delta}${u}.`;
	return { base, delta, line };
}

/**
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @returns {CheckResult}
 */
function runAgainst(spec, ctx) {
	const { against, rev, head } = readAgainst(spec, ctx);

	const { PROFILES } = require("./fault-profiles.js");
	const profile = PROFILES[against.profile];
	if (!profile)
		ctx.broken(
			`lib/fault-profiles.js carries no ${against.profile} profile, so there is ` +
				"no rule for what makes two of this check's faults the same fault.",
		);

	const materialise = materialiserOf(against, ctx);

	const baseRev = baselineOf(rev);

	git(["rev-parse", "--verify", `${baseRev}^{tree}`], `resolving ${baseRev}`);
	const headTree =
		head &&
		git(
			["rev-parse", "--verify", `${head}^{tree}`],
			`resolving ${head}`,
		).trim();
	const others = otherParents(ctx, rev, head);

	const sides = compareSides(spec, ctx, {
		against,
		profile,
		materialise,
		revs: { rev, baseRev, head, headTree, others },
	});
	const { added, inherited, notes, commit, baselineSummary } = sides;

	const measured = (/** @type {FaultItem} */ f) =>
		[
			{ baseline: sides.baselineEnvelope, rev },
			...sides.otherEnvelopes.map((o) => ({
				baseline: o.envelope,
				rev: o.rev,
			})),
		]
			.map((b) => measuredDelta(profile, f, { staged: commit.envelope, ...b }))
			.reduce(
				(near, d) => (d && (!near || d.delta < near.delta) ? d : near),
				undefined,
			);

	const {
		refuse,
		remedy,
		data: settled,
	} = against.settle?.(ctx, added, {
		baseline: sides.baselineEnvelope,
		read: (rev_) => readRev(spec, ctx, { against, materialise }, rev_),
	}) ?? {
		refuse: added,
		remedy: [],
	};

	const judged = head ?? "this commit";
	reportAgainst(
		ctx,
		{
			added: refuse,
			inherited,
			notes,
			rev,
			base: [rev, ...others].join(" or "),
			judged,
		},
		measured,
	);
	for (const line of refuse.length > 0 ? remedy : []) ctx.say(line);

	return {
		okLine: `no gating fault in ${head ?? "the index"} that ${[rev, ...others].join(" or ")} does not already carry.`,
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

/**
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @returns {CheckResult}
 */
function runIndex(spec, ctx) {
	const against = materialisedSpec(
		spec,
		ctx,
		INDEX_FLAG,
		"declares no materialisation",
	);
	if (ctx.has(AGAINST))
		ctx.usageError(
			`${INDEX_FLAG} judges the index alone, so it cannot be combined with ${AGAINST}.`,
		);
	if (against.refuse) against.refuse(ctx);
	const materialise = materialiserOf(against, ctx);
	const work = fs.mkdtempSync(
		path.join(os.tmpdir(), `check-index-${spec.name}-`),
	);
	try {
		const tree = indexTree(path.join(work, "index-copy"));
		const index = readSide(ctx, { against, materialise, work }, tree, {
			label: "the index",
			which: "index",
		});
		carryUnfinished(ctx, index);
		const { envelope } = index;
		ctx.findings.push(
			.../** @type {Finding[]} */ (
				Array.isArray(envelope.findings) ? envelope.findings : []
			),
		);
		return {
			okLine: index.summary.replace(/^OK: /, ""),
			noun: String(envelope.noun ?? "finding(s)"),
			count: Number(envelope.count ?? ctx.findings.length),
			data: { indexSummary: index.summary },
		};
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @param {string} flag
 * @param {string} absent
 * @returns {AgainstSpec}
 */
function materialisedSpec(spec, ctx, flag, absent) {
	const against = spec.against;
	if (!against)
		ctx.usageError(`${spec.name} ${absent}, so it takes no ${flag}.`);
	if (ctx.has("--root"))
		ctx.usageError(
			`${flag} materialises its own trees, so it cannot be combined with --root.`,
		);
	return against;
}

/**
 * @param {CheckContext} ctx
 * @param {{ against: AgainstSpec,
 *   materialise: (rev: string, dir: string, pathspecs: string[]) => void,
 *   work: string }} at
 * @param {string} rev
 * @param {{ label: string, which: "index" | "baseline" }} side
 */
function readSide(ctx, { against, materialise, work }, rev, { label, which }) {
	const dir = fs.mkdtempSync(path.join(work, "tree-"));
	materialise(rev, dir, against.pathspecs?.(ctx, rev) ?? []);
	const revCode = which === "baseline" && against.baselineCode === "rev";
	const stream = which === "index" && !ctx.asJson;
	if (ctx.sides === "in-process" && !revCode && ctx._spec)
		return readInProcess(ctx, ctx._spec, dir, { label, which, stream });
	const checker = revCode
		? baselineChecker(rev, dir, against, ctx.script)
		: undefined;
	return reread(
		dir,
		label,
		{ stream, side: which, code: ctx.script, sink: ctx.sink, ...checker },
		ctx.args,
	);
}

/**
 * @param {CheckContext} ctx
 * @param {CheckSpec} spec
 * @param {string} dir
 * @param {{ label: string, which: "index" | "baseline", stream: boolean }} side
 * @returns {{ outcome: Outcome, summary: string, envelope: Record<string, unknown> }}
 */
function readInProcess(ctx, spec, dir, { label, which, stream }) {
	let stdout = "";
	/** @type {Sink} */
	const sink = {
		write(fd, text) {
			if (fd === 1) stdout += text;
			else if (stream) ctx.sink.write(2, text);
		},
	};
	const started = startRun(spec, ["--root", dir, "--json", ...ctx.args], {
		sink,
		script: ctx.script,
		persist: null,
		sides: "in-process",
		side: which,
		sayFd: stream ? 2 : null,
	});
	if (started.help || isThenable(started.run))
		throw brokenError(`this check ran no side over ${label}.`);
	const exit = finish(started.ctx, spec, started.run, null);
	return envelopeOf(stdout, label, exit);
}

/**
 * @param {string} rev
 * @param {string} dir
 * @param {AgainstSpec} against
 * @param {string | undefined} script
 * @returns {{ code: string, env?: NodeJS.ProcessEnv } | undefined}
 */
function baselineChecker(rev, dir, against, script) {
	const self = checkerPath(script);
	if (!self) return;
	const blobs = against.materialise === "blobs";
	if (blobs) fetchRunReach(rev, dir, self);
	const code = path.join(dir, self.rel);
	if (!isPresent(code)) return;
	return blobs ? { code, env: { WFC_SCRIPT_ROOT: self.root } } : { code };
}

/**
 * @param {string | undefined} script
 * @returns {{ rel: string, root: string } | undefined}
 */
function checkerPath(script) {
	if (script === undefined) return;
	const abs = path.resolve(script);
	const root = path.dirname(path.dirname(abs));
	return { rel: path.relative(root, abs).split(path.sep).join("/"), root };
}

/**
 * @param {string} rev
 * @param {string} dir
 * @param {{ rel: string, root: string }} self
 */
function fetchRunReach(rev, dir, self) {
	if (listTree(rev, [self.rel]).length === 0) return;
	const { readRunReach } = require("./code-edges.js");
	/** @type {Set<string>} */
	const asked = new Set();
	let want = readRunReach(self.root)(self.rel).files;
	for (;;) {
		const todo = want.filter((p) => !asked.has(p));
		if (todo.length === 0) return;
		for (const p of todo) asked.add(p);
		writeBlobs(rev, dir, todo);
		want = readRunReach(dir)(self.rel).missing.map((m) => m.file);
	}
}

/**
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @param {{ against: AgainstSpec,
 *   materialise: (rev: string, dir: string, pathspecs: string[]) => void }} at
 * @param {string} rev
 */
function readRev(spec, ctx, { against, materialise }, rev) {
	const work = fs.mkdtempSync(
		path.join(os.tmpdir(), `check-against-${spec.name}-`),
	);
	try {
		return readSide(ctx, { against, materialise, work }, rev, {
			label: rev,
			which: "baseline",
		});
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * @param {AgainstSpec} against
 * @param {CheckContext} ctx
 */
function materialiserOf(against, ctx) {
	const materialise = MATERIALISERS[against.materialise];
	if (!materialise)
		ctx.broken(
			`no ${against.materialise} materialisation — expected one of ${Object.keys(MATERIALISERS).join(", ")}.`,
		);
	return materialise;
}

/**
 * @param {CheckContext} ctx
 * @param {{ outcome: Outcome, summary: string }} side
 */
function carryUnfinished(ctx, { outcome, summary }) {
	const carried = summary.replace(/^\w+: /, "");
	if (outcome === "BROKEN") ctx.broken(carried);
	if (outcome === "SKIP") ctx.skip(carried);
}

/** @typedef {{ key: string, item: unknown, line: string }} FaultItem */

/**
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
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @returns {{ against: AgainstSpec, rev: string, head: string | undefined }}
 */
function readAgainst(spec, ctx) {
	const against = materialisedSpec(
		spec,
		ctx,
		AGAINST,
		"does not direction-gate",
	);

	const rev = ctx.value(AGAINST, "");
	if (!rev) ctx.usageError(`${AGAINST} needs a rev.`);

	// lucmoseley/mantahostels#1940
	if (against.refuse) against.refuse(ctx);
	const head = ctx.has(HEAD_FLAG) ? ctx.value(HEAD_FLAG, "") : undefined;
	if (head === "") ctx.usageError(`${HEAD_FLAG} needs a rev.`);
	return { against, rev, head };
}

const LANDED_REFS = ["refs/remotes/origin/main", "refs/heads/main"];

/**
 * @param {CheckContext} ctx
 * @param {string} rev
 * @param {string | undefined} head
 * @returns {string[]}
 */
function otherParents(ctx, rev, head) {
	if (head || rev !== "HEAD") return [];
	const { readMergingHeads } = require("./merge-heads.js");
	const heads = readMergingHeads();
	if (heads.length === 0) return [];
	const ours = readCommitOrBroken("HEAD");
	const shas = heads.map((h) => {
		const sha = readCommitOrBroken(h);
		if (sha === null)
			throw brokenError(`resolving the merged-in ${h}: it names no commit.`);
		return sha;
	});
	const landed = LANDED_REFS.filter((ref) => readCommitOrBroken(ref) !== null);
	return [...new Set(shas)].filter((sha) => {
		if (sha === ours) return false;
		if (landed.some((ref) => isAncestor(sha, ref))) return true;
		ctx.say(
			`judged against HEAD alone for ${sha}: it is on no landed ref (${LANDED_REFS.join(", ")}).`,
		);
		return false;
	});
}

/**
 * @param {string} sha
 * @param {string} ref
 */
function isAncestor(sha, ref) {
	const r = spawnGitSync(["merge-base", "--is-ancestor", sha, ref], {
		encoding: "utf8",
	});
	if (r.status === 0) return true;
	if (r.status === 1) return false;
	throw brokenError(
		`git merge-base --is-ancestor ${sha} ${ref} failed: ${(r.stderr || "").trim() || r.error?.message || `exit ${r.status}`}`,
	);
}

/**
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @param {{ against: AgainstSpec,
 *   profile: import("./fault-diff.js").FaultDiffProfile,
 *   materialise: (rev: string, dir: string, pathspecs: string[]) => void,
 *   revs: { rev: string, baseRev: string, head?: string, headTree?: string, others: string[] } }} at
 */
function compareSides(spec, ctx, { against, profile, materialise, revs }) {
	const { newFaultItems } = require("./fault-diff.js");
	const { rev, baseRev, head, headTree, others } = revs;
	const gate = profile.gating ?? (() => true);
	const work = fs.mkdtempSync(
		path.join(os.tmpdir(), `check-against-${spec.name}-`),
	);
	const read = (
		/** @type {string} */ rev_,
		/** @type {string} */ label,
		/** @type {"index" | "baseline"} */ which,
	) => readSide(ctx, { against, materialise, work }, rev_, { label, which });

	let added = /** @type {FaultItem[]} */ ([]);
	let inherited = /** @type {string[]} */ ([]);
	let notes = /** @type {FaultItem[]} */ ([]);
	let baselineEnvelope = /** @type {Record<string, unknown> | undefined} */ (
		undefined
	);
	let baselineSummary =
		"unread — the index carries no gating fault to attribute";
	/** @type {{ rev: string, envelope: Record<string, unknown> }[]} */
	const otherEnvelopes = [];
	try {
		const commitSide = headTree ?? indexTree(path.join(work, "index-copy"));
		const commit = read(commitSide, head ?? "the index", "index");

		carryUnfinished(ctx, commit);

		const gating = newFaultItems(commit.envelope, {}, profile);
		if (gating.length > 0 || against.baseline === "always") {
			const baseline = read(baseRev, rev, "baseline");
			baselineSummary = baseline.summary;
			baselineEnvelope = baseline.envelope;
			if (baseline.outcome === "BROKEN" || baseline.outcome === "SKIP")
				ctx.broken(
					`no readable ${rev} baseline to compare against — ${baseline.summary}`,
				);
			const notGating = {
				...profile,
				gating: (/** @type {unknown} */ item, /** @type {string} */ key) =>
					!gate(item, key),
			};
			added = newFaultItems(commit.envelope, baseline.envelope, profile);
			notes = newFaultItems(commit.envelope, baseline.envelope, notGating);
			({ added, notes } = narrowToOthers(ctx, {
				others,
				read: (other) => read(other, other, "baseline"),
				staged: commit.envelope,
				profiles: { gating: profile, notes: notGating },
				found: { added, notes },
				envelopes: otherEnvelopes,
			}));
			const addedLines = added.map((f) => f.line);
			inherited = gating
				.filter((f) => !profile.newOnly?.(f.key))
				.map((f) => f.line)
				.filter((line) => !addedLines.includes(line));
		}
		return {
			added,
			inherited,
			notes,
			commit,
			baselineEnvelope,
			otherEnvelopes,
			baselineSummary,
		};
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * @param {CheckContext} ctx
 * @param {{ others: string[],
 *   read: (rev: string) => { outcome: Outcome, summary: string, envelope: Record<string, unknown> },
 *   staged: Record<string, unknown>,
 *   profiles: { gating: import("./fault-diff.js").FaultDiffProfile, notes: import("./fault-diff.js").FaultDiffProfile },
 *   found: { added: FaultItem[], notes: FaultItem[] },
 *   envelopes: { rev: string, envelope: Record<string, unknown> }[] }} at
 * @returns {{ added: FaultItem[], notes: FaultItem[] }}
 */
function narrowToOthers(
	ctx,
	{ others, read, staged, profiles, found, envelopes },
) {
	const { newFaultItems } = require("./fault-diff.js");
	let { added, notes } = found;
	for (const other of others) {
		if (added.length === 0 && notes.length === 0) break;
		const side = read(other);
		if (side.outcome === "BROKEN" || side.outcome === "SKIP")
			ctx.broken(
				`no readable baseline at ${other}, the merge's other parent — ${side.summary}`,
			);
		envelopes.push({ rev: other, envelope: side.envelope });
		const newAt = (
			/** @type {import("./fault-diff.js").FaultDiffProfile} */ p,
		) => new Set(newFaultItems(staged, side.envelope, p).map((f) => f.item));
		const gatingNew = newAt(profiles.gating);
		const notesNew = newAt(profiles.notes);
		added = added.filter((f) => gatingNew.has(f.item));
		notes = notes.filter((f) => notesNew.has(f.item));
	}
	return { added, notes };
}

/**
 * @param {CheckContext} ctx
 * @param {{ added: FaultItem[], inherited: string[], notes: FaultItem[],
 *   rev: string, base: string, judged: string }} found
 * @param {(f: FaultItem) => { base: number, delta: number, line: string } | undefined} measured
 */
function reportAgainst(
	ctx,
	{ added, inherited, notes, rev, base, judged },
	measured,
) {
	if (added.length > 0) {
		ctx.say(`The fault(s) below are NOT in ${base} — ${judged} adds them:`);
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
			ctx.warn("INHERITED-FAULT", line, { against: base });
		ctx.say(
			`Every gating fault reported above is already in ${base}, so ${judged} did not cause one — passing (mantahostels#1753).`,
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
 * @param {string} name
 * @param {string} summary
 */
function persistCrash(name, summary) {
	try {
		const notify = loadNotify();
		const key = openedKey || name.replace(/\.js$/, "").replace(/^check-/, "");
		const wrote = notify.writeReport(key, {
			outcome: "BROKEN",
			text: `${summary}\n`,
			owner: reportOwner(),
		});
		// lucmoseley/mantahostels#1899
		if (wrote) notify.closeRun(key);
		return wrote;
	} catch {
		return false;
	}
}

/**
 * @param {unknown} e
 * @returns {never}
 */
function reportCrash(e) {
	const argv = process.argv.slice(2);
	const notify = argv.includes("--notify");
	const name = path.basename(process.argv[1] || "a checker");
	const said = (e instanceof Error && e.stack) || errMessage(e);
	const summary = `BROKEN: ${name} threw before it could check anything: ${said}`;
	if (persisting(argv) && persistCrash(name, summary)) process.exit(0);
	if (argv.includes("--json"))
		writeFd(
			1,
			`${JSON.stringify({ checker: name, outcome: "BROKEN", exit: notify ? 0 : 2, summary })}\n`,
		);
	else writeFd(notify ? 1 : 2, `${summary}\n`);
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
 *               before any work (workflow-core#938)
 *   against     present on a direction-gating or index-judged checker alone,
 *               and what makes `--against <rev>` and `--index` legal at all —
 *               see the header. Names the
 *               lib/fault-profiles.js profile that decides what makes two of
 *               its faults the same fault, the materialisation its scan scope
 *               needs, and optionally a refuse() for any argument it cannot
 *               honour — a flag pair, or a positional run() would have judged,
 *               and a settle() that, given the faults the commit adds, returns
 *               those that refuse it and the remedy lines printed after them.
 *               A spec with an async run() is refused as BROKEN: no
 *               direction-gating checker is async yet, so that path is unbuilt
 *               (workflow-core#1586)
 *   run(ctx)    the checker's own logic. Returns, or resolves a Promise to —
 *               runCheck awaits it, and a rejection is classified as a throw:
 *                 okLine the OK line, used when nothing was found
 *                 noun   what the summary counts ("stranded artefacts")
 *                 count  overrides the finding count where the checker counts
 *                        something finer than its own findings (citations are
 *                        counted per citation, not per issue)
 *                 data   checker-specific payload for the --json envelope
 *
 * For an async run() it returns the Promise of that tail, for a script's
 * exported `main` to hand runInProcessAsync (workflow-core#3616). A real process exits
 * inside the tail, so there it never settles.
 *
 * The process shell over startRun(): it reads `process.argv`, writes the real
 * fds and exits.
 *
 * @param {CheckSpec} spec
 * @returns {Promise<never> | undefined}
 */
function runCheck(spec) {
	const argv = process.argv.slice(2);
	const persist =
		persisting(argv) && !helpAsked(argv)
			? {
					lines: /** @type {string[]} */ ([]),
					notify: loadNotify(),
					startedAtMono: performance.now(),
				}
			: null;
	if (persist) openedKey = spec.name;
	const started = startRun(spec, argv, {
		sink: FD_SINK,
		script: process.argv[1],
		persist,
	});
	if (started.help) return exitFinished(0);
	const { ctx, run } = started;
	if (run instanceof Promise) return finishWhenSettled(ctx, spec, run, persist);
	exitFinished(finish(ctx, spec, run, persist));
}

/**
 * @param {CheckSpec} spec
 * @param {string[]} argv
 * @param {{ script: string, sides?: SideRun }} opts
 * @returns {Promise<{ exit: number, stdout: string, stderr: string }>}
 */
async function checkInProcess(spec, argv, { script, sides = "in-process" }) {
	const sink = new BufferSink();
	const started = startRun(spec, argv, {
		sink,
		script,
		persist: null,
		sides,
	});
	const exit = started.help
		? 0
		: finish(started.ctx, spec, await started.run, null);
	return { exit, stdout: sink.stdout, stderr: sink.stderr };
}

/** @param {string[]} argv */
const ownArgsOf = (argv) =>
	argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;

/** @param {string[]} argv */
const helpAsked = (argv) => {
	const own = ownArgsOf(argv);
	return own.includes("--help") || own.includes("-h");
};

/**
 * @param {CheckSpec} spec
 * @param {string[]} argv
 * @param {{ sink: Sink, script: string | undefined, persist: Persist | null,
 *   sides?: SideRun, side?: "index" | "baseline", sayFd?: number | null }} opts
 * @returns {{ help: true } | { help: false, ctx: CheckContext, run: Ran | Promise<Ran> }}
 */
function startRun(spec, argv, { sink, script, persist, sides, side, sayFd }) {
	if (helpAsked(argv)) {
		sink.write(1, `usage: ${spec.usage}\n`);
		return { help: true };
	}
	const ownArgs = ownArgsOf(argv);
	const buffering =
		spec.screenNotices &&
		argv.includes("--notify") &&
		!argv.includes("--json") &&
		!persist;
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
		capture: persist?.lines ?? (buffering ? [] : undefined),
		screen: buffering ? [] : undefined,
		persisting: Boolean(persist),
		sink,
		script,
		spec,
		sides,
		side,
		sayFd,
	});
	if (persist) persist.notify.openRun(spec.name);
	const run = runBody(spec, ctx, () =>
		flagRefusal(ownArgs, valueFlags, accepted),
	);
	return { help: false, ctx, run };
}

/**
 * @param {CheckContext} ctx
 * @param {CheckSpec} spec
 * @param {Promise<Ran>} run
 * @param {Persist | null} persist
 * @returns {Promise<never>}
 */
function finishWhenSettled(ctx, spec, run, persist) {
	process.prependOnceListener("unhandledRejection", (e) =>
		exitFinished(finish(ctx, spec, fromThrow(spec, e), persist)),
	);
	process.once("beforeExit", () =>
		exitFinished(
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
		),
	);
	return run
		.then((ran) => exitFinished(finish(ctx, spec, ran, persist)))
		.catch((e) => {
			if (finished) throw e;
			return reportCrash(e);
		});
}

/**
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
		if (spec.against && require("node:util").types.isAsyncFunction(spec.run))
			throw brokenError(asyncAgainstRefusal(spec));
		if (ctx.has(HEAD_FLAG) && !ctx.has(AGAINST))
			ctx.usageError(
				`${HEAD_FLAG} names the judged side of ${AGAINST}, so it needs one.`,
			);
		let returned;
		if (ctx.has(INDEX_FLAG)) returned = runIndex(spec, ctx);
		else if (ctx.has(AGAINST)) returned = runAgainst(spec, ctx);
		else returned = spec.run(ctx);
		if (!isThenable(returned)) return fromReturn(ctx, returned);
		if (spec.against) {
			returned.then(undefined, noop);
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
		"has no async path yet (workflow-core#1586) — make run() synchronous, or build that path."
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
	if (ctx.warnOnly && outcome === "FAIL") outcome = "WARN";
	return { outcome, result: returned || {}, message: "" };
}

/**
 * @param {CheckSpec} spec
 * @param {unknown} e
 * @returns {Ran}
 */
function fromThrow(spec, e) {
	if (e instanceof Error) {
		const thrown = outcomeOf(e);
		if (thrown) return { outcome: thrown, result: {}, message: e.message };
	}
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
 * @param {Persist | null} persist
 * @returns {number}
 */
function finish(ctx, spec, { outcome, result, message }, persist) {
	const gating = ctx.findings.filter((f) => f.severity === "FAIL");
	const warned = ctx.findings.filter((f) => f.severity === "WARN");
	const incomplete = outcome === "SKIP" || outcome === "BROKEN";
	const count = incomplete ? 0 : findingCount(result, gating, warned);
	const noun = result.noun || "finding(s)";
	const keys = incomplete
		? []
		: [
				...new Set(ctx.findings.map((f) => f.key ?? `${f.tag}\t${f.message}`)),
			].sort();

	const summary = buildSummaryLine(outcome, { result, message, count, noun });

	if (ctx.asJson) {
		writeEnvelope(ctx, spec, { outcome, result, count, keys, noun, summary });
		return exitFor(ctx, outcome);
	}

	annotate(ctx, outcome, message);

	if (!(ctx.notify && (outcome === "OK" || outcome === "SKIP")))
		ctx.say(summary);
	if (!ctx.notify) for (const note of ctx.dirtyNotes) ctx.say(note);
	if (persist) persistReport(spec, outcome, result, persist);
	ctx.flushBuffered();
	try {
		result.afterReport?.();
	} catch (e) {
		ctx.sink.write(
			2,
			`${spec.name}: afterReport failed: ${caught(e).message}\n`,
		);
	}
	return exitFor(ctx, outcome);
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
	const frame = {
		checker: spec.name,
		outcome,
		exit: exitFor(ctx, outcome),
		count,
		keys,
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
	ctx.sink.write(
		1,
		`${JSON.stringify(
			{
				...(result.data || {}),
				...frame,
			},
			null,
			2,
		)}\n`,
	);
}

/**
 * @param {CheckContext} ctx
 * @param {Outcome} outcome
 * @param {string} message
 */
function annotate(ctx, outcome, message) {
	if (!ctx.inActions) return;
	if (outcome === "BROKEN") {
		ctx.sink.write(1, `::error::${toOneLine(message)}\n`);
		return;
	}
	if (outcome !== "FAIL" && outcome !== "WARN") return;
	for (const f of ctx.findings) {
		const level = f.severity === "FAIL" && !ctx.warnOnly ? "error" : "warning";
		ctx.sink.write(1, `::${level}::${toOneLine(f.message)}\n`);
	}
}

// workflow-core#5529
/**
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
		stamp: result.stamp,
		stamps: result.stamps,
		maxAgeMs: result.maxAgeMs,
		durationMs: performance.now() - persist.startedAtMono,
		owner: reportOwner(),
	});
	if (wrote) persist.notify.closeRun(spec.name);
	if (!wrote && text) writeFd(1, text);
}

/** @type {(ctx: CheckContext, outcome: Outcome) => number} */
const exitFor = (ctx, outcome) => (ctx.notify ? 0 : OUTCOMES[outcome].exit);

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

/** @param {unknown} e */
function failureReason(e) {
	const stderr =
		e && typeof e === "object" && "stderr" in e ? String(e.stderr).trim() : "";
	return stderr || errMessage(e);
}

const { now } = require("./clock.js");

/** @typedef {CheckContext} Ctx */

module.exports = {
	runCheck,
	checkInProcess,
	now,
	skipError,
	brokenError,
	isOutcomeError,
	errMessage,
	failureReason,
	CheckContext,
	MAX_BUFFER,
	git,
	indexTree,
	extractTree,
	baselineOf,
	againstRevs,
};
