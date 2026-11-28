const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { brokenError } = require("./check");
const {
	RUN_BUDGETED,
	TIMEOUT_EXIT,
	KILLED_EXIT,
	isRunnerFailure,
} = require("./run-budgeted.js");
const { now: clockNow } = require("./clock.js");
const { parseErrorFirstLine } = require("./first-line.js");
const { docPath, isCoreRepo, scriptPath } = require("./script-path");
const {
	BOUND_DAYS,
	MIN_REFUSE_DAYS,
	judgeBound,
	parseCounts,
	readHistory,
	reachableFloor,
	recordReading,
} = require("./gate-projection.js");
const { basisOf, gateOnOf, parseAddedGateLines } = require("./issue-gate.js");
const { hostRoot } = require("./host-root.js");
const { isSameRepo } = require("./issue-ref.js");
const {
	buildCheckoutEnv,
	homeDir,
	readCheckoutTracking,
	readHostTracker,
} = require("./refill-repos.js");

// guess, #2656
const DEFAULT_TIMEOUT_S = 60;

// guess, #2656
const MAX_BUFFER = 64e6;

// guess, #2855
const KILL_AFTER_MS = 5000;

const NOT_STATED = "NOT-STATED";

const REPAIR_STATES = new Set([
	"NO-OUTPUT",
	"NOT-A-COMMAND",
	"DEAD",
	"OVER-BUDGET",
]);

/**
 * @param {string} raw
 * @returns {{ ok: true, command: string } | { ok: false, why: string }}
 */
function unwrap(raw) {
	const s = raw.trim();
	if (!s.startsWith("`")) return { ok: true, command: s };
	if (!s.endsWith("`") || s.length === 1)
		return {
			ok: false,
			why: "opens with a backtick it never closes — prose wrapped round the command",
		};
	const inner = s.slice(1, -1).trim();
	if (!inner) return { ok: false, why: "an empty pair of backticks" };
	if (inner.includes("`"))
		return {
			ok: false,
			why: "carries a second pair of backticks inside the first — the inner pair would run as shell command substitution",
		};
	return { ok: true, command: inner };
}

/**
 * @typedef {{ state: string, reading: string, detail: string | null }} Reading
 */

/**
 * @param {string} command
 * @param {number} timeoutMs
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Reading}
 */
function runCheckCommand(command, timeoutMs, cwd, env) {
	const startedMs = performance.now();
	const r = spawnSync(
		process.execPath,
		[
			RUN_BUDGETED,
			String(timeoutMs),
			String(KILL_AFTER_MS),
			"sh",
			"-c",
			command,
		],
		{
			cwd,
			env,
			encoding: "utf8",
			maxBuffer: MAX_BUFFER,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const out = (r.stdout || "").trim();
	const err = (r.stderr || "").trim();
	const code = /** @type {{code?: string} | undefined} */ (r.error)?.code;
	if (isRunnerFailure(r))
		throw brokenError(
			`${err.split("\n")[0]}\n        Nothing was read. Run a single check by hand.`,
		);
	if (code === "ENOBUFS")
		return {
			state: "DEAD",
			reading: `printed more than ${MAX_BUFFER / 1e6} MB — raise MAX_BUFFER in scripts/lib/gate-check.js, or narrow the command`,
			detail: null,
		};
	if (r.error)
		return {
			state: "DEAD",
			reading: `could not run: ${r.error.message.split("\n")[0]}`,
			detail: null,
		};
	return classifyExit(r, {
		out,
		err,
		timeoutMs,
		elapsedMs: performance.now() - startedMs,
	});
}

/** @param {string} err */
function parseLastErrLine(err) {
	return err ? err.split("\n").pop() || null : null;
}

/**
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {{ out: string, err: string, timeoutMs: number, elapsedMs: number }} run
 * @returns {Reading}
 */
function classifyExit(r, { out, err, timeoutMs, elapsedMs }) {
	const budgetS = Math.round(timeoutMs / 1000);
	const overBudget =
		elapsedMs >= timeoutMs &&
		(r.status === TIMEOUT_EXIT || r.status === KILLED_EXIT);
	if (overBudget)
		return {
			state: "OVER-BUDGET",
			reading: `killed at ${budgetS}s — run it by hand`,
			detail: out || null,
		};
	if (r.status === null && !out)
		return {
			state: "DEAD",
			reading: `killed by ${r.signal}, nothing on stdout`,
			detail: parseLastErrLine(err),
		};
	if (out)
		return {
			state: "READING",
			reading: out,
			detail: r.status === 0 ? null : `exit ${r.status}`,
		};
	if (r.status !== 0)
		return {
			state: "DEAD",
			reading: `exit ${r.status}, nothing on stdout`,
			detail: parseLastErrLine(err),
		};
	return {
		state: "NO-OUTPUT",
		reading: "exit 0, nothing on stdout",
		detail: parseLastErrLine(err),
	};
}

/** @param {string} reading @returns {"met"|"unmet"|null} */
function parseVerdict(reading) {
	if (/^[ \t]*unmet\b/im.test(reading)) return "unmet";
	if (/^[ \t]*met\b/im.test(reading)) return "met";
	const counts = parseCounts(reading);
	if (counts.length === 0) return null;
	return counts.every(({ a, b }) => a >= b) ? "met" : "unmet";
}

const PRINTING_FIX =
	'`git merge-base --is-ancestor X origin/main && echo "met: on main" || echo "unmet: not on main"`';

const COUNT_FIX = '`echo "$(grep -c . data/log.jsonl) of 25 rows"`';

// guess, #5756
const SHOWN_READING_CHARS = 120;

const SUBSTITUTED = "$(…)";
const GIT_WORD = "git";
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const SHELL_KEYWORDS = new Set(
	"if then else elif fi do done while until ! { } time".split(" "),
);
const ASSIGNMENT = /^\w+=/;
const GIT_ENV_CHECKOUT = /^(?:GIT_DIR|GIT_WORK_TREE)=(.*)$/s;
const CHECKOUT_DIR_OPTIONS = new Set(["--git-dir", "--work-tree"]);
const OPTIONS_WITH_VALUE = new Set([
	"-C",
	...CHECKOUT_DIR_OPTIONS,
	"-c",
	"--namespace",
	"--config-env",
]);
const FETCHES = new Set(["fetch", "pull", "remote update"]);

/**
 * #5755
 * @template T
 * @param {T[]} stack
 * @returns {T}
 */
function topOf(stack) {
	const top = stack.at(-1);
	if (top === undefined) throw new Error("gate-check: empty shell stack");
	return top;
}

/** @param {string} word */
const unquoted = (word) => word.replace(/["']/g, "");

/** @param {string} dir */
const checkoutKey = (dir) =>
	path.posix
		.normalize(unquoted(dir).replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, "~"))
		.replace(/\/\.git\/?$|\/$/, "");

/**
 * #5755
 * @typedef {{key: string, anchor: string}} Checkout
 */

/**
 * #5755
 * @param {string} target
 * @param {Checkout|null} base
 * @returns {Checkout|null|undefined}
 */
function resolveCheckout(target, base) {
	const bare = unquoted(target);
	if (bare === "" || bare === "-" || bare.includes(SUBSTITUTED)) return;
	if (/\$(?!HOME\b|\{HOME\})/.test(bare)) return;
	if (/^(?:~|\$HOME|\$\{HOME\}|\/)/.test(bare)) return named(bare);
	if (base !== null)
		return {
			key: checkoutKey(path.posix.join(base.key, bare)),
			anchor: base.anchor,
		};
	if (/^\.\.(?:\/\.\.)*\/?$/.test(bare)) return null;
	return bare.startsWith("..") ? named(bare) : null;
}

/** @param {string} dir */
const named = (dir) => ({ key: checkoutKey(dir), anchor: checkoutKey(dir) });

/**
 * #5755
 * @param {string} value
 * @param {Checkout|null} base
 */
const gitCheckout = (value, base) => {
	const placed = resolveCheckout(value, base);
	return placed === undefined ? named(value) : placed;
};

/**
 * #5755
 * @param {string[]} words
 * @param {Checkout|null} cwd
 * @param {Checkout|null} envDir
 */
function parseGit(words, cwd, envDir) {
	let base = cwd;
	let gitDir = envDir;
	let i = 0;
	for (let word = words[i]; word?.startsWith("-"); word = words[++i]) {
		const [name = "", inline] = word.split(/[=](.*)/s);
		const value =
			inline ?? (OPTIONS_WITH_VALUE.has(name) ? (words[++i] ?? "") : "");
		if (name === "-C") base = gitCheckout(value, base);
		else if (CHECKOUT_DIR_OPTIONS.has(name)) gitDir = gitCheckout(value, base);
	}
	return { dir: gitDir ?? base, sub: words[i], next: words[i + 1] };
}

/**
 * #5755
 * @typedef {{kind: "word", text: string} | {kind: "end" | "pipe" | "open" | "close"}} ShellToken
 * @typedef {{word: string, quote: string, closer: string}} LexFrame
 */
class ShellLexer {
	/** @param {string} command */
	constructor(command) {
		this.command = command;
		this.i = 0;
		/** @type {LexFrame[]} */
		this.frames = [{ word: "", quote: "", closer: "" }];
		/** @type {ShellToken[]} */
		this.out = [];
	}

	get frame() {
		return topOf(this.frames);
	}

	/** @param {number} offset */
	peek(offset) {
		return this.command.charAt(this.i + offset);
	}

	lex() {
		for (; this.i < this.command.length; this.i++) this.step(this.peek(0));
		while (this.frames.length > 1) this.close();
		this.end("end");
		return this.out;
	}

	/** @param {string} c */
	step(c) {
		const { quote } = this.frame;
		if (quote === "'") this.quoted(c);
		else if (c === "\\") this.frame.word += c + this.command.charAt(++this.i);
		else if (quote === '"' && c !== "$" && c !== "`") this.quoted(c);
		else if (c === "$" && this.peek(1) === "(") {
			this.i++;
			this.open("$)");
		} else if (c === "`") this.backtick();
		else if (quote === '"') this.frame.word += c;
		else this.unquotedChar(c);
	}

	/** @param {string} c */
	quoted(c) {
		if (c === this.frame.quote) this.frame.quote = "";
		this.frame.word += c;
	}

	backtick() {
		if (this.frame.closer === "`") this.close();
		else this.open("`");
	}

	/** @param {string} c */
	unquotedChar(c) {
		if (c === "(") {
			this.endWord();
			this.open(")");
		} else if (c === ")" && this.frame.closer.endsWith(")")) this.close();
		else if (c === "|") this.bar();
		else if (/[;&\n]/.test(c) && !this.isRedirect(c)) this.end("end");
		else if (/\s/.test(c)) this.endWord();
		else {
			if (c === "'" || c === '"') this.frame.quote = c;
			this.frame.word += c;
		}
	}

	bar() {
		const next = this.peek(1);
		if (next === "|" || next === "&") this.i++;
		this.end(next === "|" ? "end" : "pipe");
	}

	/** @param {string} c */
	isRedirect(c) {
		return c === "&" && (this.peek(-1) === ">" || this.peek(1) === ">");
	}

	endWord() {
		if (this.frame.word !== "")
			this.out.push({ kind: "word", text: this.frame.word });
		this.frame.word = "";
	}

	/** @param {"end" | "pipe"} kind */
	end(kind) {
		this.endWord();
		this.out.push({ kind });
	}

	/** @param {string} closer */
	open(closer) {
		this.frames.push({ word: "", quote: "", closer });
		this.out.push({ kind: "open" });
	}

	close() {
		this.end("end");
		const { closer } = this.frame;
		this.frames.pop();
		this.out.push({ kind: "close" });
		if (closer !== ")") this.frame.word += SUBSTITUTED;
	}
}

/**
 * #5755
 * @param {string[]} words
 * @param {Checkout|null} cwd
 */
function commandStart(words, cwd) {
	const at = words.findIndex(
		(w) => !SHELL_KEYWORDS.has(w) && !ASSIGNMENT.test(w),
	);
	/** @type {Checkout|null} */
	let envDir = null;
	for (const word of at < 0 ? words : words.slice(0, at)) {
		const value = GIT_ENV_CHECKOUT.exec(word)?.[1];
		if (value !== undefined) envDir = gitCheckout(value, cwd);
	}
	return { words: at < 0 ? [] : words.slice(at), envDir };
}

/**
 * #5755
 * @param {string[]} words
 * @returns {string|undefined}
 */
function innerScript(words) {
	const strip = (/** @type {string} */ w) => w.replace(/^(["'])(.*)\1$/s, "$2");
	if (words[0] === "eval") return words.slice(1).map(strip).join(" ");
	if (!SHELLS.has(path.posix.basename(words[0] ?? ""))) return;
	const script = words[words.indexOf("-c") + 1];
	return words.includes("-c") && script !== undefined
		? strip(script)
		: undefined;
}

/** @param {string} word */
const isGitWord = (word) => path.posix.basename(word) === GIT_WORD;

/**
 * #5755
 * @typedef {{cwd: Checkout|null, words: string[], piped: boolean}} ShellScope
 * @param {ShellScope} scope
 * @param {Set<string>} fetched
 * @param {boolean} piped
 * @returns {string|null}
 */
function unfetchedReadOf(scope, fetched, piped) {
	const { words, envDir } = commandStart(scope.words.splice(0), scope.cwd);
	if (words[0] === "cd") {
		const target = words.slice(1).find((w) => w === "-" || !w.startsWith("-"));
		if (!piped)
			scope.cwd =
				target === undefined
					? null
					: (resolveCheckout(target, scope.cwd) ?? null);
		return null;
	}
	const inner = innerScript(words);
	if (inner !== undefined) return unfetchedCheckout(inner);
	const at = words.findIndex(
		(w, i) => isGitWord(w) && !isGitWord(words[i + 1] ?? ""),
	);
	if (at < 0) return null;
	const git = parseGit(words.slice(at + 1), scope.cwd, envDir);
	const { dir } = git;
	if (dir === null) return null;
	if (FETCHES.has(`${git.sub}`) || FETCHES.has(`${git.sub} ${git.next}`))
		fetched.add(dir.key);
	else if (
		words.some((w) => w.includes("origin/")) &&
		!fetched.has(dir.key) &&
		!fetched.has(dir.anchor)
	)
		return dir.key;
	return null;
}

/**
 * #5697 #5755
 * @param {string} command
 * @returns {string|null}
 */
function unfetchedCheckout(command) {
	/** @type {Set<string>} */
	const fetched = new Set();
	/** @type {ShellScope[]} */
	const scopes = [{ cwd: null, words: [], piped: false }];
	for (const token of new ShellLexer(command).lex()) {
		const scope = topOf(scopes);
		if (token.kind === "word") scope.words.push(token.text);
		else if (token.kind === "open")
			scopes.push({ cwd: scope.cwd, words: [], piped: false });
		else if (token.kind === "close") scopes.pop();
		else {
			const dir = unfetchedReadOf(
				scope,
				fetched,
				scope.piped || token.kind === "pipe",
			);
			scope.piped = token.kind === "pipe";
			if (dir !== null) return dir;
		}
	}
	return null;
}

/**
 * @param {string} command
 * @param {string} dir
 */
const buildUnfetchedRefusal = (command, dir) => {
	const ghContentsRead = `\`gh api -H "Accept: application/vnd.github.raw+json" repos/<owner/repo>/contents/<path>\``;
	const live = isCoreRepo()
		? `for an adopter's workflow-core pin, \`node ${scriptPath("release-contains.js")} <sha> --pinned-by <owner/repo>\`; for any other file, ${ghContentsRead}`
		: ghContentsRead;
	return `the \`check:\` \`${command}\` on the \`**Gated on:**\` line reads an \`origin/\` ref in ${dir}, which nothing fetches, so its reading never changes and no judge is queued when the condition comes true (#5697). Read GitHub live instead: ${live}. Rule: ${docPath("agents/issue-tracker.md")} §Gating an issue.`;
};

/**
 * @param {string} [repo]
 * @returns {{root: string, env?: NodeJS.ProcessEnv} | {why: string}}
 */
function readCheckTree(repo) {
	const host = hostRoot();
	if (!repo || isSameRepo(readHostTracker(host), repo)) return { root: host };
	const checkout = readCheckoutTracking(repo, homeDir());
	return "why" in checkout
		? checkout
		: { root: checkout.root, env: buildCheckoutEnv(checkout.root) };
}

/**
 * @param {string} before
 * @param {string} after
 * @param {{run: boolean, repo?: string, issue?: number, timeoutMs?: number,
 *   now?: number}} opts
 * @returns {{refusals: string[], warnings: string[]}}
 */
function addedCheckVerdict(
	before,
	after,
	{ run, repo, issue, timeoutMs = DEFAULT_TIMEOUT_S * 1000, now = clockNow() },
) {
	/** @type {string[]} */
	const refusals = [];
	/** @type {string[]} */
	const warnings = [];
	/** @type {ReturnType<typeof readCheckTree> | undefined} */
	let where;
	for (const line of parseAddedGateLines(before, after)) {
		const gateOn = gateOnOf(line);
		if (!gateOn || gateOn.malformed || !gateOn.command) continue;
		const u = unwrap(gateOn.command);
		if (!u.ok) {
			refusals.push(buildSilentRefusal(gateOn.command, u.why, "NOT-A-COMMAND"));
			continue;
		}
		const unfetched = unfetchedCheckout(u.command);
		if (unfetched !== null) {
			refusals.push(buildUnfetchedRefusal(u.command, unfetched));
			continue;
		}
		const gate = buildHistoryGate(line, after, u.command, { repo, issue, now });
		if (!run) {
			projectGate(gate, null, { refusals, warnings });
			warnings.push(
				`The \`check:\` \`${u.command}\` was not run here, so nothing says it prints a reading. Run \`node ${scriptPath("check-gates.js")} --issue <n>\` once it is filed; a NO-OUTPUT or DEAD row there, or a reading with no line opening \`met:\` or \`unmet:\` and no \`<a> of <b>\` count, is a check to rewrite so that it prints what it saw and a verdict, for example ${PRINTING_FIX} or ${COUNT_FIX}.`,
			);
			continue;
		}
		where ??= readCheckTree(repo);
		if ("why" in where) {
			refusals.push(
				`the \`check:\` \`${u.command}\` on the \`**Gated on:**\` line was not run: ${where.why}. Clone ${repo} there with its \`.claude/workflow-core.json\`, or write the line from its checkout.`,
			);
			continue;
		}
		const reading = judgeRun(u.command, where, timeoutMs, {
			refusals,
			warnings,
		});
		if (reading !== null) projectGate(gate, reading, { refusals, warnings });
	}
	return { refusals, warnings };
}

/** @param {number} n */
const roundTo = (n) => Number(n.toFixed(2));

/** @param {number} at */
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

const WAYS_OUT =
	"Re-size or re-measure the gate, or take the longer wait to the founder as a question round and cite it in the `**Gate basis:**` as `#<n> Q<k>`";

const BOUND_CITE = `the ${BOUND_DAYS}-day bound (#5687 Q1: "Nothing should need more than a week")`;

/**
 * @typedef {{repo: string, issue: number|null, command: string, basis: string,
 *   now: number}} HistoryGate
 */

/**
 * @param {string} line
 * @param {string} after
 * @param {string} command
 * @param {{repo?: string, issue?: number, now: number}} opts
 * @returns {HistoryGate}
 */
const buildHistoryGate = (line, after, command, { repo, issue, now }) => ({
	repo: repo ?? readHostTracker(hostRoot()) ?? "",
	issue: issue ?? null,
	command,
	basis: basisOf(after.slice(after.indexOf(line))) ?? "",
	now,
});

/**
 * @param {HistoryGate} gate
 * @param {string|null} reading
 * @returns {{rows: import("./gate-projection.js").HistoryRow[],
 *   counts: {a: number, b: number}[], shown: string}}
 */
function readGateHistory(gate, reading) {
	const rows = readHistory(gate);
	const latest = (rows.at(-1)?.counts ?? []).map(({ a, b }) => ({ a, b }));
	const counts = reading === null ? latest : parseCounts(reading);
	const shown = reading ?? counts.map(({ a, b }) => `${a} of ${b}`).join(", ");
	return { rows, counts, shown };
}

/**
 * @param {HistoryGate} gate
 * @param {string|null} reading
 * @param {{refusals: string[], warnings: string[]}} verdict
 */
function projectGate(gate, reading, { refusals, warnings }) {
	let history;
	try {
		history = readGateHistory(gate, reading);
	} catch (e) {
		warnings.push(
			`The gate history could not be read (${parseErrorFirstLine(e)}), so the count gate \`${gate.command}\` was not projected.`,
		);
		return;
	}
	if (reading !== null) {
		const fault = recordReading({ ...gate, reading, at: gate.now });
		if (fault !== null)
			warnings.push(
				`The reading of \`${gate.command}\` was not added to the gate history (${fault}).`,
			);
	}
	const { rows, counts, shown } = history;
	const bound = judgeBound(rows, counts, gate);
	if (bound.verdict === "unreachable")
		refusals.push(
			buildUnreachableRefusal(gate.command, shown, bound.projection),
		);
	else if (bound.verdict === "unprojected")
		warnings.push(
			`The count gate \`${gate.command}\` has under ${MIN_REFUSE_DAYS} days of reading history and its basis states no expected time, so nothing projects its met date yet; the daily stale-ticket run projects it once it has a day of readings (#5861).`,
		);
	else if (bound.verdict === "stated-past-bound")
		refusals.push(
			`the count gate \`${gate.command}\` on the \`**Gated on:**\` line has a \`**Gate basis:**\` whose pass clause expects ${bound.days} days, past ${BOUND_CITE}. ${WAYS_OUT}. Rule: ${docPath("agents/issue-tracker.md")} §Gating an issue.`,
		);
}

/**
 * @param {string} command
 * @param {string} shown
 * @param {{metAt: number|null, ratePerDay: number, spanDays: number,
 *   remaining: number, a: number}} p
 */
function buildUnreachableRefusal(command, shown, p) {
	const met =
		p.metAt === null ? "never at this rate" : `met on ${dayOf(p.metAt)}`;
	return `the count gate \`${command}\` on the \`**Gated on:**\` line reads \`${shown.replace(/\n[\s\S]*/, "").slice(0, SHOWN_READING_CHARS)}\`; at its measured rate of ${roundTo(p.ratePerDay)} a day over ${roundTo(p.spanDays)} days its ${p.remaining} remaining are ${met}, past ${BOUND_CITE}. At that rate it reaches ${reachableFloor(p.a, p.ratePerDay)} within ${BOUND_DAYS} days. ${WAYS_OUT}. Rule: ${docPath("agents/issue-tracker.md")} §Gating an issue.`;
}

/**
 * @param {string} command
 * @param {{root: string, env?: NodeJS.ProcessEnv}} where
 * @param {number} timeoutMs
 * @param {{refusals: string[], warnings: string[]}} verdict
 * @returns {string|null}
 */
function judgeRun(command, where, timeoutMs, { refusals, warnings }) {
	let r;
	try {
		r = runCheckCommand(command, timeoutMs, where.root, where.env);
	} catch (e) {
		warnings.push(
			`The \`check:\` \`${command}\` could not be run (${parseErrorFirstLine(e)}), so nothing says it prints a reading.`,
		);
		return null;
	}
	if (r.state === "NO-OUTPUT" || r.state === "DEAD")
		refusals.push(buildSilentRefusal(command, r.reading, r.state));
	else if (r.state === "READING" && parseVerdict(r.reading) === null)
		refusals.push(buildNoVerdictRefusal(command, r.reading));
	else if (r.state === "OVER-BUDGET")
		warnings.push(
			`The \`check:\` \`${command}\` ran past its ${Math.round(timeoutMs / 1000)} s budget, so the gate sweep will read it as OVER-BUDGET and its judge will run it by hand. Where it is not meant to run that long, make it print what it saw sooner.`,
		);
	return r.state === "READING" ? r.reading : null;
}

/**
 * @param {string} command
 * @param {string} what
 * @param {string} state
 */
const buildSilentRefusal = (command, what, state) =>
	`the \`check:\` \`${command}\` on the \`**Gated on:**\` line reads as ${state} (${what}), so the gate sweep gets no reading to judge (#3487). Make the command print what it saw, for example ${PRINTING_FIX}. Rule: ${docPath("agents/issue-tracker.md")} §Gating an issue.`;

/**
 * @param {string} command
 * @param {string} reading
 */
const buildNoVerdictRefusal = (command, reading) =>
	`the \`check:\` \`${command}\` on the \`**Gated on:**\` line prints \`${reading.replace(/\n[\s\S]*/, "").slice(0, SHOWN_READING_CHARS)}\`, which carries no verdict (#5756). Open a line with \`met:\` or \`unmet:\`, for example ${PRINTING_FIX}, or print a count against its threshold as \`<a> of <b>\`, for example ${COUNT_FIX}. Rule: ${docPath("agents/issue-tracker.md")} §Gating an issue.`;

module.exports = {
	DEFAULT_TIMEOUT_S,
	NOT_STATED,
	PRINTING_FIX,
	REPAIR_STATES,
	addedCheckVerdict,
	parseVerdict,
	runCheckCommand,
	unwrap,
};
