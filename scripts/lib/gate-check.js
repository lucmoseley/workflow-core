const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { brokenError } = require("./check");
const {
	RUN_BUDGETED,
	TIMEOUT_EXIT,
	KILLED_EXIT,
	isRunnerFailure,
} = require("./run-budgeted.js");
const { caught } = require("./caught.js");
const { docPath, isCoreRepo, scriptPath } = require("./script-path");
const { gateOnOf, parseAddedGateLines } = require("./issue-gate.js");
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

const PRINTING_FIX =
	'`git merge-base --is-ancestor X origin/main && echo "met: on main" || echo "unmet: not on main"`';

const SUBSTITUTED = "\0";
const GIT_WORD = "git";
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

/** @param {string} dir */
const checkoutKey = (dir) =>
	path.posix
		.normalize(
			dir.replace(/["']/g, "").replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, "~"),
		)
		.replace(/\/\.git\/?$|\/$/, "");

/**
 * #5755
 * @param {string} target
 * @param {string|null} base
 * @returns {string|null}
 */
function resolveCheckout(target, base) {
	const bare = target.replace(/["']/g, "");
	if (bare === "" || bare === "-" || bare.includes(SUBSTITUTED)) return null;
	if (/^(?:~|\$HOME|\$\{HOME\}|\/)/.test(bare)) return checkoutKey(bare);
	if (base !== null) return checkoutKey(path.posix.join(base, bare));
	return bare.startsWith("..") ? checkoutKey(bare) : null;
}

/**
 * #5755
 * @param {string[]} words
 * @param {string|null} cwd
 * @param {string|null} envDir
 */
function parseGit(words, cwd, envDir) {
	let base = cwd;
	let gitDir = envDir;
	let i = 0;
	for (let word = words[i]; word?.startsWith("-"); word = words[++i]) {
		const [name = "", inline] = word.split(/[=](.*)/s);
		const value =
			inline ?? (OPTIONS_WITH_VALUE.has(name) ? (words[++i] ?? "") : "");
		if (name === "-C") base = resolveCheckout(value, base);
		else if (CHECKOUT_DIR_OPTIONS.has(name))
			gitDir = resolveCheckout(value, base);
	}
	return { dir: gitDir ?? base, sub: words[i], next: words[i + 1] };
}

/**
 * #5755
 * @typedef {{kind: "word", text: string} | {kind: "end" | "open" | "close"}} ShellToken
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
		return /** @type {LexFrame} */ (this.frames.at(-1));
	}

	/** @param {number} offset */
	peek(offset) {
		return this.command[this.i + offset];
	}

	lex() {
		for (; this.i < this.command.length; this.i++)
			this.step(this.command[this.i] ?? "");
		while (this.frames.length > 1) this.close();
		this.endCommand();
		return this.out;
	}

	/** @param {string} c */
	step(c) {
		const { quote } = this.frame;
		if (quote === "'" || (quote === '"' && c !== "$" && c !== "`"))
			this.quoted(c);
		else if (c === "\\") this.frame.word += c + (this.command[++this.i] ?? "");
		else if (c === "$" && this.peek(1) === "(") {
			this.i++;
			this.open("$)");
		} else if (c === "`") this.backtick();
		else if (quote === '"') this.frame.word += c;
		else this.unquoted(c);
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
	unquoted(c) {
		if (c === "(") {
			this.endWord();
			this.open(")");
		} else if (c === ")" && this.frame.closer.endsWith(")")) this.close();
		else if (/[;&|\n]/.test(c) && !this.isRedirect(c)) this.endCommand();
		else if (/\s/.test(c)) this.endWord();
		else {
			if (c === "'" || c === '"') this.frame.quote = c;
			this.frame.word += c;
		}
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

	endCommand() {
		this.endWord();
		this.out.push({ kind: "end" });
	}

	/** @param {string} closer */
	open(closer) {
		this.frames.push({ word: "", quote: "", closer });
		this.out.push({ kind: "open" });
	}

	close() {
		this.endCommand();
		const { closer } = /** @type {LexFrame} */ (this.frames.pop());
		this.out.push({ kind: "close" });
		if (closer !== ")") this.frame.word += SUBSTITUTED;
	}
}

/**
 * #5755
 * @param {string[]} words
 * @param {string|null} cwd
 */
function commandStart(words, cwd) {
	const at = words.findIndex(
		(w) => !SHELL_KEYWORDS.has(w) && !ASSIGNMENT.test(w),
	);
	/** @type {string|null} */
	let envDir = null;
	for (const word of at < 0 ? words : words.slice(0, at)) {
		const value = GIT_ENV_CHECKOUT.exec(word)?.[1];
		if (value !== undefined) envDir = resolveCheckout(value, cwd);
	}
	return { words: at < 0 ? [] : words.slice(at), envDir };
}

/**
 * #5755
 * @typedef {{cwd: string|null, words: string[]}} ShellScope
 * @param {ShellScope} scope
 * @param {string[]} fetched
 * @returns {string|null}
 */
function runCommand(scope, fetched) {
	const { words, envDir } = commandStart(scope.words.splice(0), scope.cwd);
	if (words[0] === "cd") {
		const target = words.slice(1).find((w) => w === "-" || !w.startsWith("-"));
		scope.cwd =
			target === undefined ? null : resolveCheckout(target, scope.cwd);
		return null;
	}
	const at = words.findIndex((w) => path.posix.basename(w) === GIT_WORD);
	if (at < 0) return null;
	const git = parseGit(words.slice(at + 1), scope.cwd, envDir);
	const { dir } = git;
	if (dir === null) return null;
	if (FETCHES.has(`${git.sub}`) || FETCHES.has(`${git.sub} ${git.next}`))
		fetched.push(dir);
	else if (
		words.some((w) => w.includes("origin/")) &&
		!fetched.some((f) => dir === f || dir.startsWith(`${f}/`))
	)
		return dir;
	return null;
}

/**
 * #5697 #5755
 * @param {string} command
 * @returns {string|null}
 */
function unfetchedCheckout(command) {
	/** @type {string[]} */
	const fetched = [];
	/** @type {ShellScope[]} */
	const scopes = [{ cwd: null, words: [] }];
	for (const token of new ShellLexer(command).lex()) {
		const scope = /** @type {ShellScope} */ (scopes.at(-1));
		if (token.kind === "word") scope.words.push(token.text);
		else if (token.kind === "open") scopes.push({ cwd: scope.cwd, words: [] });
		else if (token.kind === "close") scopes.pop();
		else {
			const dir = runCommand(scope, fetched);
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
 * @param {{run: boolean, repo?: string, timeoutMs?: number}} opts
 * @returns {{refusals: string[], warnings: string[]}}
 */
function addedCheckVerdict(
	before,
	after,
	{ run, repo, timeoutMs = DEFAULT_TIMEOUT_S * 1000 },
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
		if (!run) {
			warnings.push(
				`The \`check:\` \`${u.command}\` was not run here, so nothing says it prints a reading. Run \`node ${scriptPath("check-gates.js")} --issue <n>\` once it is filed; a NO-OUTPUT or DEAD row there is a check to rewrite so that it prints what it saw, for example ${PRINTING_FIX}.`,
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
		judgeRun(u.command, where, timeoutMs, { refusals, warnings });
	}
	return { refusals, warnings };
}

/**
 * @param {string} command
 * @param {{root: string, env?: NodeJS.ProcessEnv}} where
 * @param {number} timeoutMs
 * @param {{refusals: string[], warnings: string[]}} verdict
 */
function judgeRun(command, where, timeoutMs, { refusals, warnings }) {
	let r;
	try {
		r = runCheckCommand(command, timeoutMs, where.root, where.env);
	} catch (e) {
		warnings.push(
			`The \`check:\` \`${command}\` could not be run (${caught(e).message.split("\n")[0]}), so nothing says it prints a reading.`,
		);
		return;
	}
	if (r.state === "NO-OUTPUT" || r.state === "DEAD")
		refusals.push(buildSilentRefusal(command, r.reading, r.state));
	else if (r.state === "OVER-BUDGET")
		warnings.push(
			`The \`check:\` \`${command}\` ran past its ${Math.round(timeoutMs / 1000)} s budget, so the gate sweep will read it as OVER-BUDGET and its judge will run it by hand. Where it is not meant to run that long, make it print what it saw sooner.`,
		);
}

/**
 * @param {string} command
 * @param {string} what
 * @param {string} state
 */
const buildSilentRefusal = (command, what, state) =>
	`the \`check:\` \`${command}\` on the \`**Gated on:**\` line reads as ${state} (${what}), so the gate sweep gets no reading to judge (#3487). Make the command print what it saw, for example ${PRINTING_FIX}. Rule: ${docPath("agents/issue-tracker.md")} §Gating an issue.`;

module.exports = {
	DEFAULT_TIMEOUT_S,
	NOT_STATED,
	PRINTING_FIX,
	REPAIR_STATES,
	addedCheckVerdict,
	runCheckCommand,
	unwrap,
};
