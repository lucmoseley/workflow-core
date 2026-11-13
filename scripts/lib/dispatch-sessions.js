/*
 * dispatch-sessions.js — the dispatcher's core (#5145): launch a /pick-next
 * dispatch set, each session on the model its kind calls for, and only as many
 * as allowance remains for (#369).
 *
 * A CORE (base §T7, §X11): it reads nothing of its own process — the
 * environment, the working directory and every child come in through
 * `dispatch`'s arguments — and returns the exit code with the complete text
 * it wrote. Its one direct I/O is the filesystem, which has no fake (#5135):
 * the scratch files it hands a helper and reads back, the launch's debug log,
 * and the roster files a remedy names. The ports:
 *
 *   node(script, args, {env, cwd, stdin?})  one of this repo's Node programs,
 *            `script` relative to scripts/, as {status, stdout, stderr}
 *   interop(env)    the WSL interop probe (lib/interop-probe.sh), as
 *            {wedged, recovery}; it fails open, reading healthy on anything
 *            unexpected (mantahostels#3111)
 *   launch(argv, {cwd, env, timeoutS})  one session's launch under its
 *            ceiling, as {status, timedOut, output}, stdout and stderr merged
 *   sleep(seconds)  the stagger between two launches
 *   write(fd, text) optional, where the text also goes as it is written
 *
 * Three facts this rests on, on Claude Code 2.1.241:
 *   - `claude --bg --model <alias> "<prompt>"` starts one background
 *     agents-view session on that model and returns immediately. It is
 *     per-session; `claude agents --model` by contrast sets a view-wide
 *     default and would move every launch made from that view (mantahostels#1153).
 *   - `--advisor <alias>` is a real flag, undocumented in `--help`. Why this
 *     rather than the `advisorModel` setting or `/advisor`: mantahostels#1102, and
 *     `docs/effort-guide.md` §Claude Code specifics.
 *   - `claude -p "/usage"` refreshes `cachedUsageUtilization` in
 *     `$CLAUDE_CONFIG_DIR/.claude.json` — the allowance gate's primary source
 *     (#280, #294) — and also prints both rate-limit bars, read as a fallback
 *     when that JSON reading is not fresh. It is a local command, so it spends
 *     no model tokens and reads no credentials. Adding `--debug --debug-file`
 *     to that same call reports whether the advisor is live here, at no extra
 *     cost (mantahostels#1102). `scripts/usage-probe.js` makes the call, and
 *     skips it while the cache is fresh (#2306).
 *
 * AN OVERFLOW SEAT (#2570) bills its key's API credits, not the plan's bars.
 * Under one, the `/usage` probe, the advisor check and the allowance cap are
 * skipped; the key's budget gate (lib/overflow-budget.js) sizes the set
 * instead. Each member launches headless, a `claude -p` through
 * lib/headless-sessions.js, since the key's credits cover `claude -p` and not
 * a `--bg` job (#4578): under its plan seat's config dir, handed the key
 * through an `apiKeyHelper` in `--settings` (lib/overflow-key.js), named
 * after its prompt with the overflow prefix, capped at the key's headroom, and
 * with no key or caller's session id in its environment (#3701, #4580). Its
 * ledger row records the key, its allowance, the headroom at launch, which the
 * refill tick stops it at (#3698), and the session id the launcher printed.
 * Only Opus launches there (#1920). WFC_SEAT_KEY, the seat's key variable, is
 * what asks for one: a dispatch without it is on the plan seat (#3693).
 *
 * Usage:
 *   scripts/dispatch-sessions.js [--dry-run] [--force] [--force-memory] \
 *       [--no-advisor] [--into <worktree>] <model> <prompt> [...]
 *
 * --force skips the duplicate drop and the allowance cap, but never the
 * overflow budget gate (#2570); --force-memory skips the per-member memory
 * re-read, and nothing else; pass both to skip all three. Split at #281: an
 * allowance override must not disarm the memory gate, whose breach freezes the
 * machine. Neither disarms the CPU load ceiling (#830, #834): --force-memory
 * still re-reads the load before each spawn, and only WFC_LOAD_CEILING=0 or a
 * 0 in ~/.claude/load-ceiling turns it off.
 *
 * A prompt may be neither empty nor multi-line: the per-member drop list is
 * indexed by line, so either one shifts every index after it and drops the
 * wrong session.
 *
 * A set is recorded to `.pick-next/dispatched.jsonl` as it launches. A MEMBER
 * whose issues are already running, or were launched moments ago, is dropped
 * and named; the rest still launch (mantahostels#1337).
 *
 * The allowance CAP (#371) drops the set's tail, once, before any spawn: at or
 * past 90% of the 5-hour bar or 99% of the week, only the prefix projected to
 * just reach 100% of that bar launches — at least one while the bar reads
 * under 100% — and each cut member is named.
 *
 * A THIRD MEMBER-LEVEL DROP (mantahostels#2553): `admission.js` re-reads
 * memory immediately before EACH spawn — the allowance gate reads it once,
 * before the whole set, and cannot see what an earlier member in the SAME set
 * has just warmed. A member the re-read refuses is named on stderr and
 * skipped, same as a duplicate; the rest still launch. Staggered by
 * WFC_DISPATCH_STAGGER_SECONDS between launches (default 2; mantahostels#2588)
 * so the next member's re-read sees the previous one's bg-spare.
 *
 * EACH SESSION STARTS IN A DIRECTORY OF ITS OWN (#4229): a worktree cut from
 * `origin/main` by `scripts/session-checkout.js launch-dir`, or this checkout
 * where the repo has no `landing` module. A member that gets no directory is
 * named on stderr and skipped, as a re-read refusal is. With
 * WFC_DISPATCH_NO_BUILD=1, which the refill loop sets (#4318), a cut finding
 * no dependency store for its lockfile is such a member: the loop's warm pass
 * builds the store, so no `npm ci` runs inside its timeout for this call.
 * `--into <worktree>` starts a one-member set in that existing session
 * worktree instead, a dead session's, so its successor finishes the orphaned
 * edits there (#4385); a worktree a live process still works in is refused as
 * a member with no directory is.
 *
 * Exit codes: 0 launched (or dry-run; a member dropped by any drop above
 *             still exits 0, as does a set the allowance cap cut short),
 *             2 usage error, a seat file that refuses, or a non-Opus member
 *               on an overflow seat, 3 refused on allowance — a warned bar
 *               reads 100%, the cap cannot be sized, no trustworthy reading,
 *               or an overflow budget that fits none or cannot be read,
 *             4 refused as dispatched — either because EVERY member was, or
 *               because the drop list could not be read,
 *             5 refused on a wedged WSL interop bridge (mantahostels#3111), an
 *               RCU stall this boot (#867) or a frozen scheduler clock
 *               (#2779). A --dry-run can exit 5 too: both checks run before
 *               the gates.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { bgLaunchId } = require("./bg-launch-id.js");
const { claudeBin } = require("./claude-bin.js");
const { readText } = require("./file-read.js");
const { docPath, scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");
const { trimEndRun, trimStartRun } = require("./trim-run.js");

/* The per-member lines lib/refill-batch.js's refusal parser keys on: one
 * copy, which the parser imports. */
const MEMBER_REFUSED_TAIL = "— not launching this member.";
const memberRefused = (/** @type {string} */ prompt) =>
	`REFUSED: ${prompt} ${MEMBER_REFUSED_TAIL}`;
const memberDropped = (/** @type {string} */ prompt) => `dropped: ${prompt}`;

/** @typedef {{model: string, prompt: string}} Member one of the set's sessions */

/**
 * The model-prompt words, two to a member.
 * @param {string[]} words an even count
 */
function membersOf(words) {
	/** @type {Member[]} */
	const members = [];
	/** @type {string | undefined} */
	let model;
	for (const w of words) {
		if (model === undefined) model = w;
		else {
			members.push({ model, prompt: w });
			model = undefined;
		}
	}
	return members;
}

/** scripts/, which every program the core names sits under. */
const SCRIPTS = path.resolve(__dirname, "..");

/*
 * The cap's thresholds (#369, #371): at or above these percentages the set is
 * CAPPED rather than launched whole — only as many members launch as are
 * projected to just reach 100% of the warned bar, counting what the sessions
 * already running are expected to spend yet. WFC_DISPATCH_WEEK_CEILING and
 * WFC_DISPATCH_SESSION_CEILING override them per run; the per-session figures
 * live in `scripts/lib/allowance.js`. The week holds nothing back below 99%:
 * the founder's ruling (#4941). lib/seat-reading.js sizes the refill loop's
 * cap on these too.
 */
const DEFAULT_CEILINGS = { week: 99, session: 90 };

/*
 * Seconds between one launch and the next (mantahostels#2553). The allowance
 * gate reads memory ONCE, before the set launches, and cannot see the ~400 MB
 * bg-spare the daemon warms per member AFTER admission has spoken. The
 * per-member re-read fixes the "once for the set" half of that gap; this
 * interval gives each spare time to become resident before the NEXT member's
 * re-read counts it.
 *
 * MEASURED (mantahostels#2588): 2 is a 0.68 s plateau with a 3x margin, and
 * the margin is what the reading does not cover — ONE probe, on a warm page
 * cache, on this machine. A cold start is the way it could be short.
 *
 * Being short is bounded rather than fatal: `--launch` charges for the pair
 * whether or not it is resident yet, so a member that arrives before the
 * previous one's spare lands is charged twice, never zero.
 *
 * Re-measure with `node scripts/measure-spare-warm.js --probe --json` — a real
 * background-session allowance, so a founder call, not this program's to make
 * unasked. Several readings, not one. lib/refill-batch.js budgets the refill
 * loop's dispatcher call on this default.
 */
const DEFAULT_STAGGER_SECONDS = 2;

/*
 * Ceiling on a single launch (mantahostels#3111). A launch returns in well
 * under a second, so 120 is margin rather than a budget; what it buys is that
 * a launch which has not returned is killed and reported instead of awaited
 * indefinitely. Tempted to drop it: its mutant HANGS the test rather than
 * failing it, which is the fault itself.
 */
const DEFAULT_LAUNCH_TIMEOUT_SECONDS = 120;

/* Every throw that ends the run with its code, from wherever the dispatch
 * stands. */
const EXITS = new WeakSet();

/**
 * @param {number} code
 * @returns {Error & {exitCode: number}}
 */
function exitAt(code) {
	const e = Object.assign(new Error(`exit ${code}`), { exitCode: code });
	EXITS.add(e);
	return e;
}

/**
 * @typedef {{status: number, stdout: string, stderr: string}} NodeResult
 * @typedef {{
 *   node: (script: string, args: string[], opts: {env: NodeJS.ProcessEnv, cwd: string, stdin?: string}) => NodeResult | Promise<NodeResult>,
 *   interop: (env: NodeJS.ProcessEnv) => {wedged: boolean, recovery: string} | Promise<{wedged: boolean, recovery: string}>,
 *   launch: (argv: string[], opts: {cwd: string, env: NodeJS.ProcessEnv, timeoutS: number}) => Promise<{status: number, timedOut: boolean, output: string}>,
 *   sleep: (seconds: string) => void | Promise<void>,
 *   write?: (fd: 1 | 2, text: string) => void,
 * }} DispatchPorts
 */

/** `text` with its trailing newlines gone. */
const chomp = (/** @type {string} */ text) => trimEndRun(text, "\n");

/** Each line of `text` behind `prefix`. */
function prefixLines(/** @type {string} */ text, /** @type {string} */ prefix) {
	if (text === "") return "";
	const ends = text.endsWith("\n");
	const lines = (ends ? text.slice(0, -1) : text).split("\n");
	return lines.map((l) => `${prefix}${l}`).join("\n") + (ends ? "\n" : "");
}

/** `printf '%.2f'` of a number read off a budget field. */
function money(/** @type {string} */ field) {
	const n = Number(field);
	return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

/**
 * A budget field as jq's `@tsv` and string interpolation print it.
 * @param {unknown} v
 * @param {boolean} interpolated `"\(.x)"`, which prints null as `null`
 */
function jqText(v, interpolated = false) {
	if (v === null || v === undefined) return interpolated ? "null" : "";
	if (typeof v === "string") return v;
	return JSON.stringify(v);
}

/**
 * The first `n` whitespace-separated fields of `line`, the last taking the
 * rest, as `read -r a b` splits a line.
 * @param {string} line
 * @param {number} n
 * @returns {string[]}
 */
function readFields(line, n) {
	/** @type {string[]} */
	const out = [];
	let rest = trimStartRun(line, " \t");
	for (let i = 0; i < n - 1; i++) {
		const cut = rest.search(/[ \t]/);
		out.push(cut === -1 ? rest : rest.slice(0, cut));
		rest = cut === -1 ? "" : trimStartRun(rest.slice(cut), " \t");
	}
	out.push(trimEndRun(rest, " \t"));
	return out;
}

/**
 * Create an empty temp file under the run's TMPDIR.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} prefix
 * @returns {string} its path, or "" where none could be made
 */
function makeTemp(env, prefix) {
	const dir = env.TMPDIR || "/tmp";
	const at = path.join(
		dir,
		`${prefix}.${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
	);
	try {
		fs.closeSync(fs.openSync(at, "wx", 0o600));
		return at;
	} catch {
		return "";
	}
}

/** The file's text, or "" where it cannot be read. */
function readOrEmpty(/** @type {string} */ file) {
	if (!file) return "";
	const got = readText(file);
	return got.state === "read" ? got.data : "";
}

/** The flags that only switch a setting on or off. */
const SWITCHES = /** @type {const} */ ({
	"--dry-run": ["dryRun", true],
	"--force": ["force", true],
	"--force-memory": ["forceMemory", true],
	"--no-advisor": ["advisor", false],
});

/* Every member's model goes through lib/model-table.js's table before any
 * gate reads it (#4919): the current mode's row in lib/model-routing.json
 * names the model each spelling launches on. An overflow seat never runs burn
 * mode, so it takes the standard rows alone. The effort each runs at is
 * settings.json's per-model `modelSettings`. The per-member line names each
 * remap; a spelling the routing file does not know launches as written. The
 * advisor is judged on the remapped spelling's alias, the routing file's to
 * name. */
const MODEL_TABLE = "lib/model-table.js";

/**
 * Run one dispatch.
 * @param {string[]} argv the command line after the program
 * @param {DispatchPorts} ports
 * @param {{env: NodeJS.ProcessEnv, cwd: string}} run the environment and
 *   working directory the dispatch was started under; never modified
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function dispatch(argv, ports, run) {
	const d = new Dispatch(ports, run);
	try {
		await d.main(argv);
		return { code: 0, stdout: d.stdout, stderr: d.stderr };
	} catch (e) {
		if (EXITS.has(/** @type {object} */ (e)))
			return {
				code: /** @type {{exitCode: number}} */ (e).exitCode,
				stdout: d.stdout,
				stderr: d.stderr,
			};
		throw e;
	} finally {
		for (const f of d.temps) fs.rmSync(f, { force: true });
	}
}

/**
 * @typedef {{fit: string, headroom: string, qUsd: string, running: string,
 *   reserved: string, exhausted: string, until: string, resets: string}} Budget
 */

/** One dispatch's state, each gate a method. */
class Dispatch {
	/**
	 * @param {DispatchPorts} ports
	 * @param {{env: NodeJS.ProcessEnv, cwd: string}} run
	 */
	constructor(ports, run) {
		this.ports = ports;
		this.cwd = run.cwd;
		/*
		 * The `claude` binary, injected at one named point rather than resolved
		 * off PATH (docs/code-standards-base.md §N7). WFC_CLAUDE_BIN is the var
		 * `scripts/lib/agent-liveness.js` already reads, not a name of this
		 * program's own. Every child gets it, so each reaches the same binary
		 * this does, the ledger check included. A test that cannot point it at a
		 * stub launches real background sessions (mantahostels#1374). The
		 * duplicate gate's live limb reads every Claude plan's sessions through
		 * agent-liveness.js, whichever plan this runs under (#3512).
		 */
		this.claudeBin = claudeBin(run.env);
		/** @type {NodeJS.ProcessEnv} */
		this.env = { ...run.env, WFC_CLAUDE_BIN: this.claudeBin };
		const e = this.env;
		this.weekCeiling =
			e.WFC_DISPATCH_WEEK_CEILING || `${DEFAULT_CEILINGS.week}`;
		this.sessionCeiling =
			e.WFC_DISPATCH_SESSION_CEILING || `${DEFAULT_CEILINGS.session}`;
		this.staggerSeconds =
			e.WFC_DISPATCH_STAGGER_SECONDS || `${DEFAULT_STAGGER_SECONDS}`;
		this.launchTimeoutSeconds =
			e.WFC_DISPATCH_LAUNCH_TIMEOUT || `${DEFAULT_LAUNCH_TIMEOUT_SECONDS}`;
		/* The advisor a Haiku session gets — the escalation path that makes the
		 * cheap arm acceptable between checks (mantahostels#1093, #4919). */
		this.advisorModel = e.WFC_DISPATCH_ADVISOR || "opus";
		/*
		 * Why the launches go on this seat, for the ledger: the refill loop names
		 * its pick (lib/refill-batch.js); a direct run takes its caller's own
		 * seat (#3732). Out of every child's environment, so a launched session's
		 * own dispatch never inherits the loop's; so are the overflow seat the
		 * loop asked for and whether a cut may build its store (#4318).
		 */
		this.seatReason = e.WFC_SEAT_REASON || "own seat";
		this.seatKey = e.WFC_SEAT_KEY || "";
		this.noBuild = e.WFC_DISPATCH_NO_BUILD || "";
		delete e.WFC_SEAT_REASON;
		delete e.WFC_SEAT_KEY;
		delete e.WFC_DISPATCH_NO_BUILD;
		this.seatDir = e.CLAUDE_CONFIG_DIR || `${e.HOME || ""}/.claude`;
		this.seatLabel = "";
		this.overflow = false;
		this.burn = false;
		/** @type {string[]} */
		this.launchEnv = ["env"];

		this.dryRun = false;
		this.force = false;
		this.forceMemory = false;
		this.advisor = true;
		this.into = "";

		this.stdout = "";
		this.stderr = "";
		/** @type {string[]} temp files, removed when the dispatch ends */
		this.temps = [];
		/** @type {string[]} every member launched so far, for a whole-call
		 * refusal to name */
		this.launchedPrompts = [];
		this.remedyPrinted = false;
		this.debugLog = "";
		this.usage = "";
		this.probeRan = false;
	}

	/** @param {string} text */
	out(text) {
		this.stdout += text;
		this.ports.write?.(1, text);
	}

	/** @param {string} text */
	err(text) {
		this.stderr += text;
		this.ports.write?.(2, text);
	}

	/**
	 * One of this repo's Node programs, its stdout and stderr captured.
	 * @param {string} script
	 * @param {string[]} args
	 * @param {string} [stdin]
	 */
	async run(script, args, stdin) {
		const opts = { env: this.env, cwd: this.cwd };
		return this.ports.node(
			script,
			args,
			stdin === undefined ? opts : { ...opts, stdin },
		);
	}

	/** A program whose output the dispatch relays as it stands.
	 * @param {string} script @param {string[]} args */
	async relayed(script, args) {
		const r = await this.run(script, args);
		this.out(r.stdout);
		this.err(r.stderr);
		return r.status;
	}

	/** A program read for its stdout, its stderr relayed.
	 * @param {string} script @param {string[]} args */
	async captured(script, args) {
		const r = await this.run(script, args);
		this.err(r.stderr);
		return { status: r.status, text: chomp(r.stdout) };
	}

	/** @param {string[]} argv */
	async main(argv) {
		let members = this.parseArgs(argv);
		/* BEFORE both gates, not just before the launches (mantahostels#3111):
		 * each of them shells out to `claude` too — the duplicate gate for its
		 * live oracle, the allowance gate under a 120s ceiling — so a wedge
		 * caught only in the launch loop would be reported minutes late, or not
		 * at all. */
		await this.refuseIfInteropWedged();
		await this.refuseIfKernelUnhealthy();
		await this.readSeat();
		members = await this.remap(members);
		if (this.overflow) await this.admitOverflowModels(members);
		if (!this.force) members = await this.duplicateGate(members);
		let wantsAdvisor = await this.warnUnknownModels(members);
		await this.probeUsage();
		if (this.overflow) members = await this.overflowBudgetGate(members);
		if (!this.overflow && !this.force) {
			const capped = await this.allowanceGate(members);
			// The advisor line below describes the members that launch, not the cut.
			if (capped.length !== members.length)
				wantsAdvisor = await this.anyWantsAdvisor(capped);
			members = capped;
		}
		if (wantsAdvisor) this.reportAdvisor();
		/*
		 * The launches. `admission.js` re-reads memory (and, through
		 * `poolReserve`, the bg-spare pool) immediately before EACH spawn
		 * (mantahostels#2553).
		 */
		for (const [i, { model, prompt }] of members.entries())
			await this.launchMember(model, prompt, i < members.length - 1);
	}

	/**
	 * The flags, then the members' model-prompt pairs.
	 * @param {string[]} argv
	 */
	parseArgs(argv) {
		let args = [...argv];
		for (;;) {
			const [a, operand] = args;
			if (a === undefined) break;
			if (Object.hasOwn(SWITCHES, a))
				this.setSwitch(SWITCHES[/** @type {keyof typeof SWITCHES} */ (a)]);
			else if (a === "--into") {
				this.into = this.intoOperand(operand);
				args = args.slice(1);
			} else if (a === "--") {
				args = args.slice(1);
				break;
			} else if (a.startsWith("-")) this.exitWith(2, `unknown option: ${a}\n`);
			else break;
			args = args.slice(1);
		}
		return this.membersOrUsage(args);
	}

	/** The members `words` name, or exit 2 on an odd count, or on a set
	 * `--into` cannot take. @param {string[]} words */
	membersOrUsage(words) {
		if (words.length === 0 || words.length % 2 !== 0)
			this.exitWith(
				2,
				`usage: ${scriptPath("dispatch-sessions.js", this.env)} [--dry-run] [--force] [--force-memory] [--no-advisor] [--into <worktree>] <model> <prompt> [<model> <prompt> ...]\n`,
			);
		const members = membersOf(words);
		if (this.into !== "" && members.length !== 1)
			this.exitWith(
				2,
				`--into starts one session in one worktree; this set has ${members.length} members\n`,
			);
		return members;
	}

	/** @param {readonly [string, boolean]} sw a SWITCHES entry */
	setSwitch([name, on]) {
		if (name === "advisor") this.advisor = on;
		else if (name === "dryRun") this.dryRun = on;
		else if (name === "force") this.force = on;
		else this.forceMemory = on;
	}

	/** @param {string | undefined} operand the word after `--into` */
	intoOperand(operand) {
		if (operand === undefined) this.exitWith(2, "--into names no worktree\n");
		return operand;
	}

	/**
	 * @param {number} code
	 * @param {string} message
	 * @returns {never}
	 */
	exitWith(code, message) {
		this.err(message);
		throw exitAt(code);
	}

	/**
	 * Name what was dispatched, then exit 5.
	 * @param {string[]} remedy for the members that did launch, one line each
	 * @returns {never}
	 */
	exitRefusedNamingLaunched(remedy) {
		if (this.launchedPrompts.length === 0) {
			this.err(
				"  Nothing was recorded as dispatched. Re-run this command after the shutdown.\n",
			);
			throw exitAt(5);
		}
		this.err(
			`  ${this.launchedPrompts.length} member(s) HAD already launched and are recorded as dispatched:\n`,
		);
		for (const p of this.launchedPrompts) this.err(`    ${p}\n`);
		for (const l of remedy) this.err(`  ${l}\n`);
		throw exitAt(5);
	}

	/*
	 * THE INTEROP PROBE (mantahostels#3111). A wedged WSL bridge makes the
	 * launch never return. It refuses the WHOLE call: every member after this
	 * one would hang the same way, and a ledger entry for a session that never
	 * started refuses its real dispatch later. It fails OPEN, unlike every
	 * other gate here: a missing library, a missing reg.exe or a non-WSL
	 * machine all launch as before.
	 */
	async refuseIfInteropWedged() {
		const probe = await this.ports.interop(this.env);
		if (!probe.wedged) return;
		this.err(
			"REFUSED: the WSL interop bridge is wedged, so `claude` would hang rather than launch.\n",
		);
		this.err(probe.recovery);
		this.exitRefusedNamingLaunched([
			"Re-run with the remaining members only, or --force: re-running the whole",
			"command is refused by the duplicate gate on the ones above.",
		]);
	}

	/* Refuses the WHOLE call on an RCU stall this boot (#867) or a frozen
	 * scheduler clock (#2779). The checker exits 1 on one of those alone; any
	 * other failure launches. */
	async refuseIfKernelUnhealthy() {
		const r = await this.run("check-kernel-stall.js", []);
		if (r.status === 0) return;
		if (r.status !== 1) {
			this.err(
				`note: the kernel-stall check could not run (exit ${r.status}), so this launch is unchecked for one.\n`,
			);
			return;
		}
		this.err(
			"REFUSED: the WSL VM is unhealthy; the kernel check names the signal that fired.\n",
		);
		this.err(`${chomp(r.stderr)}\n`);
		this.exitRefusedNamingLaunched([
			"The shutdown ends them too, so re-run with --force: the duplicate gate",
			"refuses the ones above otherwise.",
		]);
	}

	/*
	 * Seat kind, overflow key, launch auth and burn mode: one node start for
	 * four gates (lib/dispatch-gates.js, #4321) — the seat this runs under,
	 * from the one reader of `~/.claude/refill-seats`; an overflow seat's key,
	 * readable; that the launch bills its seat — the subscription, or an
	 * overflow seat's declared key's helper alone (#2236) — judged in the
	 * environment the launch hands its child; and whether burn mode's marker
	 * is set. It also prints the seat's label, its dir and an overflow seat's
	 * key, which the lines below name it by (#4196).
	 */
	async readSeat() {
		const gates = await this.captured("lib/dispatch-gates.js", [
			"--",
			this.seatDir,
			...(this.seatKey ? [this.seatKey] : []),
		]);
		if (gates.status !== 0) throw exitAt(2);
		const [kindLine = "", unsetLine = "", labelLine = ""] =
			gates.text.split("\n");
		const [seatKind = "", burnState = ""] = readFields(kindLine, 2);
		[this.seatLabel = ""] = readFields(labelLine, 1);
		this.overflow = seatKind === "overflow";
		if (!this.overflow && seatKind !== "plan")
			this.exitWith(
				2,
				`REFUSED: the seat ${this.seatDir} read as ${shellQuote(seatKind)}, neither plan nor overflow.\n`,
			);
		// Burn mode never reaches an overflow seat (#4919).
		this.burn = burnState === "on" && !this.overflow;
		/* Every launch runs without the variables the gates name: this
		 * checkout's root, which a daemon the launch starts would hand every
		 * later job in any repository (#4595), and on an overflow seat any key. */
		const unset = unsetLine.split(/[ \t]+/).filter(Boolean);
		this.launchEnv = ["env", ...unset.flatMap((v) => ["-u", v])];
	}

	/** Each member's model as the table launches it.
	 * @param {Member[]} members */
	async remap(members) {
		/** @type {Member[]} */
		const remapped = [];
		for (const { model, prompt } of members)
			remapped.push({ model: await this.launchModel(model), prompt });
		return remapped;
	}

	/** A move is burn mode's only where its row differs from the standard
	 * one (#5006). @param {string} m */
	async launchModel(m) {
		const standing = await this.tableLaunch(["launch", m]);
		const to = this.burn
			? await this.tableLaunch(["launch", m, "--burn"])
			: standing;
		if (to !== m)
			this.err(
				`${to === standing ? "model table" : "burn mode"}: ${m} -> ${to}\n`,
			);
		return to;
	}

	/** @param {string[]} args */
	async tableLaunch(args) {
		const r = await this.captured(MODEL_TABLE, args);
		if (r.status !== 0)
			this.exitWith(
				2,
				"REFUSED: the model table cannot read the routing file, so no launch model is known.\n",
			);
		return r.text;
	}

	/** Only the overflow alias's current-model spellings are admitted on an
	 * overflow seat (lib/model-table.js's `admits`).
	 * @param {Member[]} members */
	async admitOverflowModels(members) {
		for (const { model: m } of members) {
			if ((await this.relayed(MODEL_TABLE, ["admits", m])) !== 0)
				this.exitWith(
					2,
					`REFUSED: ${this.seatLabel} is an overflow seat, which launches Opus alone (#1920); ${shellQuote(m)} is not.\n`,
				);
		}
	}

	/*
	 * The route that actually retires a job stuck in "working"
	 * (mantahostels#2588). Both refusals that print it have the same likeliest
	 * cause — a slot, or a ledger entry, held by a session that will never
	 * finish.
	 *
	 * HUNG-JOB (alive, listed, silent) is named INLINE, off `admission.js`'s
	 * own `claude agents --json` read (mantahostels#2598): the per-member call
	 * site already holds admission.js's text output and passes it in, so
	 * naming the job spawns nothing more there. GHOST-JOB (no live process at
	 * all) is a different test `admission.js` does not run, so that one case
	 * alone still points at a second command.
	 *
	 * Once per run: two refused members in one set describe the same machine.
	 */
	/** @param {string} [admissionText] admission.js's text output, already
	 *   relayed by the caller; absent, one bare run supplies it */
	async rosterRemedy(admissionText = "") {
		if (this.remedyPrinted) return;
		this.remedyPrinted = true;
		const shown = admissionText !== "";
		const text = shown ? admissionText : await this.bareAdmission();
		const lines = text.split("\n");
		const from = lines.findIndex((l) => l.startsWith("hung job(s)"));
		if (from === -1) this.ghostRemedy();
		else if (!shown) this.hungRemedy(chomp(lines.slice(from).join("\n")));
		this.err(
			'  Retire one at its roster: workers["<short-id>"] carries pid (the\n',
		);
		this.err(
			"  bg-pty-host) and replPid (the bg-spare). Confirm each against\n",
		);
		this.err(
			"  /proc/<pid>/stat field 22 (procStart/replProcStart) to rule out pid\n",
		);
		this.err("  reuse, then SIGTERM both — the entry leaves the roster and\n");
		// claude-route-exempt: only text
		this.err(
			"  `claude agents --json` within seconds, with no daemon restart.\n",
		);
		await this.rosterPaths();
	}

	async bareAdmission() {
		const r = await this.run("admission.js", []);
		return chomp(r.stdout + r.stderr);
	}

	/** @param {string} hung admission.js's hung-job lines */
	hungRemedy(hung) {
		this.err(
			"  A slot or a ledger entry may be held by a job that is alive, listed, and\n",
		);
		this.err("  silent — seen on this machine right now:\n");
		this.err(prefixLines(`${hung}\n`, "  "));
	}

	ghostRemedy() {
		this.err(
			"  No job currently reads as hung (alive, listed, and silent). A slot or\n",
		);
		this.err(
			'  ledger entry may instead be held by a GHOST-JOB — "working" with nothing\n',
		);
		this.err("  behind it, or hung before its first turn. Name one:\n");
		this.err(`    node ${scriptPath("check-ghost-jobs.js", this.env)}\n`);
	}

	/* The plan dirs come from lib/plan-dirs.js, the one definition of them
	 * (#2580). Named rather than silent where none is found: an empty list here
	 * is a machine whose daemon keeps its roster somewhere else, not a machine
	 * with no roster. */
	async rosterPaths() {
		const home = this.env.HOME || "";
		const r = home === "" ? null : await this.run("lib/plan-dirs.js", [home]);
		if (r?.status !== 0) {
			this.err(
				"    roster: HOME unset or unreadable, so no plan dir was scanned — check:ghost-jobs prints the real path per ghost.\n",
			);
			return;
		}
		const rosters = r.stdout
			.split("\0")
			.filter(Boolean)
			.filter((d) => isFile(path.join(d, "daemon", "roster.json")));
		for (const d of rosters) this.err(`    roster: ${d}/daemon/roster.json\n`);
		if (rosters.length === 0)
			this.err(
				`    roster: none under the plan dirs in ${home} — check:ghost-jobs prints the real path per ghost.\n`,
			);
	}

	/** Refuse the whole dispatch as already-launched: exit 4, unless
	 * --dry-run, which reports and carries on. @param {string} why */
	refuseDispatched(why) {
		this.err(`REFUSED: ${why}\n`);
		if (!this.dryRun) throw exitAt(4);
		this.err(
			"  (--dry-run: reporting only, a real run would have exited 4 here.)\n",
		);
	}

	/**
	 * The first `n` members of `set`, naming each one cut. Both caps cut the
	 * set's tail this way, with no skip-ahead.
	 * @param {number} n
	 * @param {Member[]} set
	 */
	keepFirst(n, set) {
		for (const { prompt } of set.slice(n))
			this.err(`  ${memberDropped(prompt)}\n`);
		return set.slice(0, n);
	}

	/*
	 * The duplicate gate, BEFORE the allowance gate on cost: the allowance
	 * read spends up to 120 seconds in `claude -p "/usage"`, and a set that is
	 * already running should not pay it. Fails OPEN — see
	 * check-duplicate-dispatch.js's header for why this gate and the allowance
	 * gate fail in opposite directions. --dry-run still RUNS the gate and
	 * still reports, but never exits on it. The check itself writes nothing.
	 * Refusal is per MEMBER, not per set.
	 */
	/** @param {Member[]} members */
	async duplicateGate(members) {
		const prompts = this.checkedPrompts(members);
		const dropFile = this.temp("dispatch-drop");
		const status = await this.relayed("check-duplicate-dispatch.js", [
			"--issues",
			prompts,
			"--drop-index-out",
			dropFile,
		]);
		if (status === 0) return members;
		/* Fail CLOSED on an unreadable drop file, unlike the check itself:
		 * without it there is no way to tell which member offended. */
		const dropText = readOrEmpty(dropFile);
		if (dropText === "") {
			this.refuseDispatched(
				"the whole set, because the per-member drop list is unreadable.",
			);
			return members;
		}
		return this.dropMembers(members, dropText);
	}

	/**
	 * The prompts, one a line, each refused where it would shift the drop
	 * list's indices.
	 * @param {Member[]} members
	 */
	checkedPrompts(members) {
		let prompts = "";
		for (const { prompt: p } of members) {
			if (p.replace(/\s/g, "") === "")
				this.exitWith(2, "usage: a launch prompt may not be empty.\n");
			if (p.includes("\n"))
				this.exitWith(
					2,
					`usage: a launch prompt may not contain a newline: ${shellQuote(p)}\n`,
				);
			prompts += `${p}\n`;
		}
		return prompts;
	}

	/**
	 * @param {Member[]} members
	 * @param {string} dropText the drop list, one 0-based member index a line;
	 *   a line counts only where its newline ends it
	 */
	async dropMembers(members, dropText) {
		const drop = new Set(
			dropText
				.split("\n")
				.slice(0, -1)
				.map((l) => l.trim()),
		);
		/** @type {Member[]} */
		const keep = [];
		for (const [i, member] of members.entries()) {
			if (drop.has(`${i}`)) this.err(`  ${memberDropped(member.prompt)}\n`);
			else keep.push(member);
		}
		if (keep.length > 0) {
			this.out(
				`Launching ${keep.length} of ${members.length} set(s); the rest are already dispatched.\n`,
			);
			return keep;
		}
		/* The remedy belongs HERE and not in refuseDispatched itself: a job
		 * stuck in "working" holds its ledger entry, so its issues read as
		 * already running. The other caller — an unreadable drop list — has
		 * nothing to do with a stuck job, and the recipe there is misdirection. */
		await this.rosterRemedy();
		this.refuseDispatched("every member of this set is already dispatched.");
		return members;
	}

	/**
	 * makeTemp's file, removed when the dispatch ends; "" where none could be
	 * made.
	 * @param {string} prefix
	 */
	temp(prefix) {
		const at = makeTemp(this.env, prefix);
		if (at) this.temps.push(at);
		return at;
	}

	/** `none` for a spelling known to run as Opus or Fable, `advisor` for one
	 * known as Haiku, `unknown` for any other. Deny-list, not allow-list
	 * (mantahostels#1199): an unknown spelling gets an advisor, with a warning.
	 * @param {string} model */
	async advisorClass(model) {
		const alias = (await this.captured(MODEL_TABLE, ["alias", model])).text;
		if (alias === "opus" || alias === "fable") return "none";
		return alias === "haiku" ? "advisor" : "unknown";
	}

	/** @param {string} model */
	async wantsAdvisor(model) {
		return this.advisor && (await this.advisorClass(model)) !== "none";
	}

	/** @param {Member[]} members */
	async anyWantsAdvisor(members) {
		let wants = false;
		for (const { model } of members)
			if (await this.wantsAdvisor(model)) wants = true;
		return wants;
	}

	/*
	 * Computed AFTER the duplicate gate has dropped its members, so the
	 * advisor warning describes the sessions that will ACTUALLY launch, and
	 * printed before the allowance gate so a REFUSED run still reports an
	 * unrecognised spelling (mantahostels#1199, the ticket that added this
	 * warning). Whether any member wants the advisor.
	 */
	/** @param {Member[]} members */
	async warnUnknownModels(members) {
		if (!this.advisor) return false;
		/** @type {string[]} */
		const unknown = [];
		let wants = false;
		for (const { model: m } of members) {
			const cls = await this.advisorClass(m);
			if (cls !== "none") wants = true;
			if (cls === "unknown") unknown.push(m);
		}
		if (unknown.length === 0) return wants;
		this.err(`WARNING: unrecognised model spelling(s): ${unknown.join(" ")}\n`);
		this.err(
			"  Treating as Haiku-equivalent and attaching an advisor. If it names a\n",
		);
		this.err(
			`  known model, add it to that alias's \`also\` list in ${SCRIPTS}/lib/model-routing.json.\n`,
		);
		this.err("  The advisor already attaches either way.\n");
		return wants;
	}

	/*
	 * The allowance gate, and the advisor check riding along with it. Fails
	 * CLOSED on allowance: an unparseable reading refuses the launch rather
	 * than assuming headroom, because the cost of a wrong "plenty left" is a
	 * set of half-finished sessions, and the cost of a wrong refusal is one
	 * --force. The advisor check only ever WARNS — a Haiku session with no
	 * advisor still runs, just with no escalation path, and that is the
	 * founder's call to make. So --force silences the REFUSALS and not the
	 * advisor line: --force is how you get past a near-full bar, and it would
	 * otherwise take the one report that the advisor is live with it.
	 *
	 * The JSON read is attempted regardless of whether the probe ran — a
	 * debug log that could not be made must not turn into an allowance
	 * refusal unrelated to allowance itself (#294 "also in scope"). Exit 3 is
	 * the probe's "none ran, the cache being fresh", which the advisor check
	 * reads.
	 */
	async probeUsage() {
		this.debugLog = this.temp("dispatch-sessions-debug");
		if (this.overflow || !this.debugLog) return;
		const r = await this.run("usage-probe.js", [
			"--",
			"--model",
			"haiku",
			"--advisor",
			this.advisorModel,
			"--debug",
			"--debug-file",
			this.debugLog,
		]);
		this.usage = chomp(r.stdout);
		this.probeRan = r.status !== 3;
	}

	/**
	 * The seat's budget, or null after a REFUSED line naming why not, the
	 * reason indented under it. The last two fields say when the key is free
	 * again, as the budget's `freeAgain` words it (lib/overflow-budget-core.js).
	 * @param {string} subject the REFUSED line's
	 * @returns {Promise<Budget | null>}
	 */
	async readBudget(subject) {
		const r = await this.run("lib/overflow-budget.js", [
			"--json",
			this.seatKey,
		]);
		const text = chomp(r.stdout + r.stderr);
		const json = parseJson(text);
		if (r.status !== 0 || typeof json?.fit !== "number") {
			this.err(
				`REFUSED: ${subject}: the overflow budget of ${this.seatLabel} cannot be read:\n`,
			);
			this.err(prefixLines(`${text || "no output"}\n`, "  "));
			return null;
		}
		return {
			fit: jqText(json.fit),
			headroom: jqText(json.headroomUsd),
			qUsd: jqText(json.qUsd),
			running: jqText(json.running),
			reserved: jqText(json.reservedUsd),
			exhausted: jqText(json.exhausted),
			until: `until ${jqText(json.freeAgain, true)}`,
			resets: `resets at ${jqText(json.freeAgain, true)}`,
		};
	}

	/** Why the seat fits no session. @param {Budget} b */
	noFitLine(b) {
		return `overflow seat ${this.seatLabel} fits no session: headroom $${money(b.headroom)} against $${money(b.qUsd)} a session ($${money(b.reserved)} held by ${b.running} running).`;
	}

	/*
	 * The overflow budget gate: an overflow seat's set is sized by its key's
	 * budget (#2609), `fit` being how many more sessions its headroom holds at
	 * one mean session each. Fails CLOSED like the allowance gate.
	 */
	/** @param {Member[]} members */
	async overflowBudgetGate(members) {
		const budget = await this.readBudget("the whole set");
		if (!budget) throw exitAt(3);
		const fit = Number(budget.fit);
		if (fit === 0) this.refuseNoFit(budget);
		if (fit < members.length) {
			this.err(
				`CAPPED: launching ${budget.fit} of ${members.length} on the overflow budget of ${this.seatLabel} (headroom $${money(budget.headroom)}, $${money(budget.qUsd)} a session).\n`,
			);
			return this.keepFirst(fit, members);
		}
		this.out(
			`Budget OK: ${this.seatLabel} fits ${budget.fit}; headroom $${money(budget.headroom)}.\n`,
		);
		return members;
	}

	/** @param {Budget} budget @returns {never} */
	refuseNoFit(budget) {
		if (budget.exhausted === "true")
			this.err(
				`REFUSED: overflow seat ${this.seatLabel}: its key is exhausted ${budget.until}, Anthropic having refused it for credit.\n`,
			);
		else this.err(`REFUSED: ${this.noFitLine(budget)}\n`);
		this.exitWith(
			3,
			`  --force does not lift the budget gate; the budget ${budget.resets}.\n`,
		);
	}

	/**
	 * The plan seat's allowance gate: the members it leaves.
	 * @param {Member[]} members
	 */
	async allowanceGate(members) {
		/* stderr discarded on purpose: a crash here collapses to the same
		 * "absent" both bars read on a clean but untrustworthy run, and the
		 * refusal below already says that is likely transient — the cases are
		 * not worth telling apart in the message the founder sees. */
		const r = await this.run(
			"allowance.js",
			[
				"--json",
				"--cap",
				`${members.length}`,
				"--session-threshold",
				this.sessionCeiling,
				"--week-threshold",
				this.weekCeiling,
			],
			this.usage,
		);
		const a = readAllowance(chomp(r.stdout));
		this.refuseUntrustworthy(a);
		this.refuseUnsized(a);
		/* THE CAP (#371). The tail of /pick-next §4's order goes, with no
		 * skip-ahead. A cut member is not a freed slot: §7's top-up never
		 * refills it. A second call counts the members launched here as
		 * running at once (#372 measured <=1 s), but still launches one while
		 * the bar reads under 100% — the floor applies per call (#371). */
		const capLaunch = Number(a.capLaunch);
		if (Number.isNaN(capLaunch) || capLaunch >= members.length) {
			const shown = (/** @type {string} */ trust, /** @type {string} */ pct) =>
				trust === "unreported" ? "not reported" : `${pct}%`;
			this.out(
				`Allowance OK: week ${shown(a.weekTrust, a.weekPct)}, session ${shown(a.sessionTrust, a.sessionPct)}.\n`,
			);
			return members;
		}
		if (capLaunch === 0) this.refuseFullBar(a);
		this.err(
			`CAPPED: launching ${a.capLaunch} of ${members.length} on the ${a.capBar} bar (${a.capReading}% used, ${a.capNRunning} running session(s)\n`,
		);
		this.err(
			`  projected at ${a.capRunning} more points, ~${a.capFigure} a new session).\n`,
		);
		return this.keepFirst(capLaunch, members);
	}

	/** No trustworthy reading from either source (JSON cache or the printed
	 * bars): still refuse, but say the absence is transient rather than
	 * implying a real limit — the cache is already the second chance, and no
	 * automatic retry follows (#280 ruling 4). The verdict is
	 * `lib/allowance.js#isTrustworthy`'s, which passes over a bar the account
	 * does not report (#3758).
	 * @param {Allowance} a */
	refuseUntrustworthy(a) {
		if (a.trustworthy === "true") return;
		this.err(
			"REFUSED: no trustworthy allowance reading (the usage cache is stale or\n",
		);
		this.err(
			// claude-route-exempt: only text
			'  absent, and the printed bars from `claude -p "/usage"` were unparseable).\n',
		);
		this.exitWith(3, "  This is likely transient — re-run, or --force.\n");
	}

	/** @param {Allowance} a */
	refuseUnsized(a) {
		const capError =
			a.capError ||
			(a.capLaunch === "" ? "the allowance reader returned no cap" : "");
		if (capError === "") return;
		this.err(
			`REFUSED: the allowance cap cannot be sized (week ${a.weekPct}%, threshold ${this.weekCeiling}%;\n`,
		);
		this.exitWith(
			3,
			`  session ${a.sessionPct}%, threshold ${this.sessionCeiling}%): ${capError}. --force to override.\n`,
		);
	}

	/** @param {Allowance} a @returns {never} */
	refuseFullBar(a) {
		const reset = a.capBar === "session" ? a.sessionReset : a.weekReset;
		this.err(
			`REFUSED: ${a.capBar} allowance ${a.capReading}% used (threshold ${a.capThreshold}%), resets ${reset || "unknown"} — the bar is full.\n`,
		);
		this.exitWith(3, "  --force to override.\n");
	}

	/* The advisor is behind an experimental feature flag, and off it reports
	 * nothing at all. What the probe proves is that the flag is live on THIS
	 * machine, not that any particular session got an advisor — a launched
	 * session reports its own advisor nowhere, so this is the closest reading
	 * available. Where no probe ran, as on a fresh cache, there is no debug
	 * log to read; the next launch on a stale cache checks again (#2306). */
	reportAdvisor() {
		const log = readOrEmpty(this.debugLog);
		const lines = (log.endsWith("\n") ? log.slice(0, -1) : log).split("\n");
		if (lines.some((l) => l.includes("[AdvisorTool] Advisor model:"))) {
			this.out(
				`Advisor available: ${this.advisorModel} is live on this machine.\n`,
			);
			return;
		}
		if (!this.probeRan) {
			this.out("Advisor not checked: no /usage probe ran to report it.\n");
			return;
		}
		this.err(
			"WARNING: the advisor is not live here — the sessions below expecting one run\n",
		);
		this.err(
			"  bare, with no escalation path, and nothing in them will say so. Reason, if\n",
		);
		this.err("  the CLI gave one:\n");
		for (const l of lines.filter((x) => x.includes("[AdvisorTool]")))
			this.err(`    ${l}\n`);
		this.err(
			"  Launching anyway. --no-advisor to silence this, or launch opus instead.\n",
		);
	}

	/**
	 * One member, from its re-read to its ledger row.
	 * @param {string} model
	 * @param {string} prompt
	 * @param {boolean} more another member follows
	 */
	async launchMember(model, prompt, more) {
		if (!this.dryRun && !(await this.admitMember(prompt))) return;
		const budget = this.overflow ? await this.memberBudget(prompt) : null;
		if (this.overflow && !budget) return;
		const { launcher, cmd } = await this.launchCommand(model, prompt, budget);
		if (this.dryRun) {
			this.out(`would launch: ${cmd.map((w) => shellQuote(w)).join(" ")}\n`);
			return;
		}
		/* Re-probed per member (mantahostels#3111, #867, #2779): the bridge
		 * can wedge, the kernel stall or the scheduler clock freeze between one
		 * launch and the next, so both checks precede every spawn. */
		await this.refuseIfInteropWedged();
		await this.refuseIfKernelUnhealthy();
		const dir = await this.launchDir(prompt);
		if (dir === null) return;
		const launched = await this.launchAndRecord(model, prompt, {
			launcher,
			cmd,
			dir,
			budget,
		});
		/* AFTER this launch, before the NEXT member's re-read — not before
		 * this spawn, which would leave the very next re-read running
		 * back-to-back with this launch and seeing none of its bg-spare
		 * (mantahostels#2553 review). Only where another member remains, and
		 * never a launch this member's own admission gate refused. */
		if (launched && more) await this.ports.sleep(this.staggerSeconds);
	}

	/*
	 * `admission.js` FAILS CLOSED on memory and on a fresh allowance reading
	 * at 100% — a backstop, the thresholds being the cap's alone (#371 item
	 * 5) — but only WARNS on a stale or absent allowance reading (#293 ruling
	 * 3): the only refresh is the 11-25s `/usage` call, which this per-spawn
	 * path cannot afford, so refusing here on an untrustworthy reading would
	 * strand every remaining member with no path to a better one. `--force`
	 * passes `--skip-allowance`, dropping the allowance limb alone (#299).
	 *
	 * `--launch` prices the pair THIS member is about to make the daemon warm
	 * (mantahostels#2588). Without it the re-read sees only what is already
	 * resident, so the first member of a set is admitted against a pool one
	 * pair smaller than the one it leaves behind. The refill loop counts its
	 * free slots with it too, so the two agree on a slot (#2500).
	 */
	/** Whether the re-read admits the member. @param {string} prompt */
	async admitMember(prompt) {
		const admissionArgs = this.forceMemory
			? ["--load-only"]
			: [
					"--launch",
					...(this.force || this.overflow ? ["--skip-allowance"] : []),
				];
		const r = await this.run("admission.js", admissionArgs);
		const text = chomp(r.stdout + r.stderr);
		const lines = text.split("\n");
		if (r.status !== 0) {
			await this.refuseMember(prompt, text, lines);
			return false;
		}
		/* admission.js WARNS rather than refuses on a stale/absent allowance
		 * reading (#293 ruling 3), and on an unreadable load or session count
		 * under --load-only (#834, #2141) — surfaced here, the only place its
		 * output is read on the ADMIT path. */
		const warned = lines.filter((l) =>
			/^(allowance |cpu (load|sessions) +unknown)/.test(l),
		);
		if (warned.length > 0) {
			this.err(`WARNING: ${prompt}\n`);
			for (const l of warned) this.err(`  ${l}\n`);
		}
		return true;
	}

	/**
	 * @param {string} prompt
	 * @param {string} text admission.js's output
	 * @param {string[]} lines its lines
	 */
	async refuseMember(prompt, text, lines) {
		this.err(`${memberRefused(prompt)}\n`);
		this.err(prefixLines(`${text}\n`, "  "));
		this.err("  Re-read immediately before this spawn (mantahostels#2553).\n");
		/* admission.js names a CPU hold on a `cpu load` or `cpu sessions` line,
		 * the last ending `the only hold` where memory and allowance would admit
		 * (#834, #2141). */
		if (lines.some((l) => l.startsWith("cpu load "))) this.loadRemedy();
		// `so 0 slot` keeps the unread-count warning line out of this remedy.
		if (lines.some((l) => /^cpu sessions .*so 0 slot/.test(l)))
			this.sessionRemedy();
		if (lines.some((l) => /^cpu (load|sessions) .* the only hold$/.test(l)))
			return;
		if (this.force) {
			this.err(
				"  --force does not cover memory; --force-memory overrides it, at the risk\n",
			);
			this.err("  of freezing the machine.\n");
		} else
			this.err(
				"  --force overrides an allowance refusal; --force-memory overrides a memory one.\n",
			);
		await this.rosterRemedy(text);
	}

	loadRemedy() {
		this.err(
			"  A CPU load hold: wait for load1 to fall under the ceiling, then re-run\n",
		);
		this.err(
			"  this member — `cat /proc/loadavg` reads it. Neither --force nor\n",
		);
		this.err(
			"  --force-memory lifts it; WFC_LOAD_CEILING=0 or a 0 in ~/.claude/load-ceiling does, at the risk of\n",
		);
		this.err("  freezing WSL (#830).\n");
	}

	sessionRemedy() {
		this.err(
			"  A CPU session hold: wait for a live session to finish, then re-run this\n",
		);
		this.err("  member. Neither --force nor --force-memory lifts it;\n");
		this.err(
			"  WFC_SESSION_CEILING=0 does, at the cost of every session slowing (#2141).\n",
		);
	}

	/*
	 * Re-read per member: each launch reserves its share of the headroom, so
	 * the next one's cap is what the earlier ones left. Residual: the cap is
	 * the whole headroom, as #2570 rules, not one session's share, so a
	 * runaway member can spend what a later member's fit was sized on; the
	 * later member's own re-read then refuses or caps it lower.
	 */
	/** @param {string} prompt */
	async memberBudget(prompt) {
		const budget = await this.readBudget(
			`${prompt} — not launching this member`,
		);
		if (!budget || Number(budget.fit) !== 0) return budget;
		this.err(`${memberRefused(prompt)}\n`);
		this.err(`  ${this.noFitLine(budget)}\n`);
		return null;
	}

	/**
	 * @param {string} model
	 * @param {string} prompt
	 * @param {Budget | null} budget an overflow member's
	 */
	async launchCommand(model, prompt, budget) {
		/* The launcher builds the key's `--settings` and prefixes the name; its
		 * `--cwd` is the launch dir the launch runs in. */
		if (budget)
			return {
				launcher: "the headless launcher",
				cmd: [
					...this.launchEnv,
					"node",
					`${SCRIPTS}/lib/headless-sessions.js`,
					"launch",
					"--key",
					this.seatKey,
					"--cwd",
					".",
					"--budget",
					budget.headroom,
					`--name=${prompt}`,
					"--",
					prompt,
				],
			};
		/* A bare `opus` passes NO --model flag on purpose (mantahostels#1093,
		 * "everything else is launched with no model flag"): the configured
		 * default is the plans' settings `model`, the standard session model's
		 * full id with `[1m]` (lib/model-routing.json), and `--model opus` would
		 * silently drop the session to the 200k context window. Residual: on a
		 * machine whose default is something else, that is what the session
		 * gets. Any other spelling, `opus[1m]` included, passes verbatim. */
		const flags = ["--bg"];
		if (model !== "opus") flags.push("--model", model);
		if (await this.wantsAdvisor(model))
			flags.push("--advisor", this.advisorModel);
		/* `--` ends the options: without it claude 2.1.322 drops a prompt
		 * opening with `-` and starts the job idle, exit 0 (#4820). */
		return {
			launcher: "claude",
			cmd: [...this.launchEnv, this.claudeBin, ...flags, "--", prompt],
		};
	}

	/*
	 * The session's directory (the header's), or null after its refusal. A
	 * launch that fails after the cut leaves its worktree for the reaper
	 * (#4247): clean at `origin/main`, unless it timed out after the session
	 * started there. A refusal's reason, a store build's output or the refusal
	 * itself, sits first under its REFUSED line, where lib/refill-batch.js
	 * reads it. `--` before the prompt: lib/cli-args.js refuses a prompt
	 * opening `-<letter>` as an unknown flag (#4820).
	 */
	/** @param {string} prompt */
	async launchDir(prompt) {
		const r = await this.run("session-checkout.js", [
			"launch-dir",
			...(this.noBuild === "1" ? ["--no-build"] : []),
			...(this.into === "" ? [] : ["--into", this.into]),
			"--",
			prompt,
		]);
		if (r.status === 0) return chomp(r.stdout);
		this.err(`${memberRefused(prompt)}\n`);
		this.err(prefixLines(r.stderr, "  "));
		return null;
	}

	/**
	 * Launch the member and record it; whether it launched.
	 * @param {string} model
	 * @param {string} prompt
	 * @param {{launcher: string, cmd: string[], dir: string, budget: Budget | null}} at
	 */
	async launchAndRecord(model, prompt, { launcher, cmd, dir, budget }) {
		this.out(`${model}  `);
		/* SECOND LINE OF DEFENCE (mantahostels#3111): the probe reads the
		 * registry route alone, so a launch that blocks for some other reason
		 * would still sit here forever. Its whole first line, the job id the
		 * launch prints (`claude --help`'s own words), is what reaches the
		 * terminal. */
		const launched = await this.ports.launch(cmd, {
			cwd: dir,
			env: this.env,
			timeoutS: Number(this.launchTimeoutSeconds),
		});
		const firstLine = launched.output.match(/^[^\n]*\n?/)?.[0] ?? "";
		this.out(firstLine);
		if (launched.timedOut) {
			this.err(
				`\n  REFUSED: ${launcher} did not return within ${this.launchTimeoutSeconds}s. Killed, and NOT recorded as\n`,
			);
			this.exitWith(
				5,
				`  launched. ${docPath("environment.md", this.env)} §9 has the recovery.\n`,
			);
		}
		/* Recorded only where the launch itself exited 0, so a launch that
		 * never started is not logged as though it had. */
		if (launched.status !== 0) {
			this.err(
				`  (${launcher} exited ${launched.status}; not recorded as launched.)\n`,
			);
			return false;
		}
		await this.record(model, prompt, bgLaunchId(firstLine), {
			budget,
			output: launched.output,
		});
		this.launchedPrompts.push(prompt);
		return true;
	}

	/**
	 * The member's ledger row. The job id is the one the launch printed as its
	 * first line, or empty where it printed none — the ledger then records
	 * `jobId: null`, the same "unknown" a pre-mantahostels#3488 entry reads as
	 * downstream. An overflow member's row marks it overflow (#3694): its key,
	 * the headroom it launched at, and the session id the launcher printed, so
	 * a run that ends before any listing shows it still has its acts read.
	 * Residual: a `#<n>` in the prompt's prose records that issue too, and
	 * refuses a dispatch of it under the same command for the ledger window
	 * (#752, #4985). `--force` is the way out.
	 * @param {string} model
	 * @param {string} prompt
	 * @param {string} jobId
	 * @param {{budget: Budget | null, output: string}} launch
	 */
	async record(model, prompt, jobId, { budget, output }) {
		const overflowRecord = budget
			? [
					"--overflow-key",
					this.seatKey,
					"--allowance-usd",
					budget.headroom,
					"--session-id",
					output
						.split("\n")
						.filter((l) => l.startsWith("session "))
						.map((l) => l.slice("session ".length))
						.join("\n"),
				]
			: [];
		await this.relayed("check-duplicate-dispatch.js", [
			"--record",
			"--issues",
			prompt,
			"--model",
			model,
			"--prompt",
			prompt,
			"--job-id",
			jobId,
			"--seat-reason",
			this.seatReason,
			...overflowRecord,
		]);
	}
}

/** @param {string} file */
function isFile(file) {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null} the JSON object `text` holds, or
 * null for anything else
 */
function parseJson(text) {
	try {
		const v = JSON.parse(text);
		return v !== null && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
}

/**
 * @typedef {Record<"trustworthy" | "weekPct" | "weekTrust" | "weekReset" |
 *   "sessionPct" | "sessionTrust" | "sessionReset" | "capError" | "capLaunch" |
 *   "capBar" | "capReading" | "capThreshold" | "capRunning" | "capFigure" |
 *   "capNRunning", string>} Allowance
 */

/* Each field the trust check and the cap name, as a path into allowance.js's
 * JSON. `or`, jq's `//`: null or false reads empty. */
const ALLOWANCE_FIELDS = /** @type {const} */ ({
	weekPct: [["weekly_all", "percent"], "or"],
	weekTrust: [["weekly_all", "trust"], "value"],
	weekReset: [["weekly_all", "resetsAt"], "or"],
	sessionPct: [["session", "percent"], "or"],
	sessionTrust: [["session", "trust"], "value"],
	sessionReset: [["session", "resetsAt"], "or"],
	capError: [["cap", "error"], "or"],
	capLaunch: [["cap", "launch"], "or"],
	capReading: [["cap", "binding", "reading"], "value"],
	capThreshold: [["cap", "binding", "threshold"], "value"],
});

/**
 * Every field the trust check and the cap name, off allowance.js's JSON; each
 * read on its own, so one malformed field reads empty and leaves the rest
 * (#2876). Absent JSON reads as two absent bars.
 * @param {string} json
 * @returns {Allowance}
 */
function readAllowance(json) {
	const j = parseJson(json);
	if (j === null) {
		return /** @type {Allowance} */ ({
			...Object.fromEntries(Object.keys(ALLOWANCE_FIELDS).map((k) => [k, ""])),
			trustworthy: "false",
			weekTrust: "absent",
			sessionTrust: "absent",
			capBar: "",
			capRunning: "",
			capFigure: "",
			capNRunning: "",
		});
	}
	const binding = (/** @type {string} */ key) =>
		readAt(j, ["cap", "binding", key], false);
	return /** @type {Allowance} */ ({
		...Object.fromEntries(
			Object.entries(ALLOWANCE_FIELDS).map(([k, [at, kind]]) => [
				k,
				jqString(readAt(j, at, kind === "or")),
			]),
		),
		trustworthy: jqString(j.trustworthy === true),
		capBar: binding("bar") === "session" ? "session" : "weekly",
		capRunning: rounded(binding("runningPoints"), 10),
		capFigure: rounded(binding("perSessionPoints"), 100),
		capNRunning: jqLength(readAt(j, ["cap", "running"], false)),
	});
}

/**
 * The value at `at` in `j`, null where any step is missing.
 * @param {unknown} j
 * @param {readonly string[]} at
 * @param {boolean} or jq's `//`: null or false reads empty
 * @returns {unknown}
 */
function readAt(j, at, or) {
	let v = j;
	for (const k of at) {
		const here = v;
		v =
			here !== null && typeof here === "object"
				? (Object.entries(here).find(([key]) => key === k)?.[1] ?? null)
				: null;
	}
	return or && (v === null || v === false) ? "" : v;
}

/** jq's `x * k | round / k`, "" where `x` is no number.
 * @param {unknown} x @param {number} k */
function rounded(x, k) {
	return typeof x === "number" ? jqString(Math.round(x * k) / k) : "";
}

/** jq's `length`, null reading 0; "" where it has none. @param {unknown} v */
function jqLength(v) {
	if (v === null || v === undefined) return "0";
	if (typeof v === "string" || Array.isArray(v)) return `${v.length}`;
	return typeof v === "object" ? `${Object.keys(v).length}` : "";
}

/** jq's `tostring`: a string as it stands, anything else as JSON.
 * @param {unknown} v */
function jqString(v) {
	if (typeof v === "string") return v;
	return v === undefined ? "null" : JSON.stringify(v);
}

module.exports = {
	MEMBER_REFUSED_TAIL,
	memberDropped,
	memberRefused,
	DEFAULT_CEILINGS,
	DEFAULT_STAGGER_SECONDS,
	dispatch,
};
