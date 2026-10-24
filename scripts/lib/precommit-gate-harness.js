/*
 * precommit-gate-harness.js — the machinery the .husky/pre-commit gate suites share.
 *
 * The one gate cutter, `cutGateFragment` (mantahostels#953), and the one reader
 * of a gate's head and arming pattern (#1597).
 *
 * ON THE HELPER SURFACE (#462): plain JavaScript with JSDoc types, because the
 * release ships no TypeScript, and requiring no npm package, because the
 * plugin cache has no node_modules — hence `registerTempCleanup` takes vitest's
 * `afterEach` from its caller or the globals rather than importing it.
 * The helper-surface manifest lists the names an adopter may import.
 * `ROOT`, `HOOK` and `LIB` are this checkout's, never the adopter's: they stay
 * file-local, as the cutters' defaults, and an adopter passes its own hook
 * text to every cutter. A core suite reading them, or writing checker
 * delegates, takes them from precommit-gate-testkit.ts (#1417).
 *
 * Left per-file deliberately (mantahostels#477):
 *
 * - `runGate()`. The four diverge in shell flags, no-op placement, argument
 *   shape and stderr merging, in ways each suite's cases depend on. Behind one
 *   signature those become three flags, which is not clearer than four call
 *   sites.
 * - `mutate()`. Three of the four have one, each with a different signature.
 * - `parityGap()`. Two suites have one, comparing different things. They share
 *   no logic to merge.
 *
 * scripts/precommit-staged-gate.test.ts is deliberately not a client: it uses
 * none of this (mantahostels#953).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { requiredGroup } = require("./regex-group.js");

const ROOT = path.join(__dirname, "..", "..");

/** The live `.husky/pre-commit`. */
const HOOK = fs.readFileSync(path.join(ROOT, ".husky", "pre-commit"), "utf8");

/**
 * A gate's opening line: `if armed …` (#1504), the shell gate's
 * `if armed_shell` (#1828), or the raw `if git diff --cached …` an adopter's
 * own gate may still spell.
 */
const GATE_HEAD = /^if (armed |armed_shell;|git diff --cached)/;

/**
 * The `if armed … fi` block containing `anchor`, verbatim.
 *
 * Anchored on the line that CALLS the checker — comment lines naming it are
 * skipped — then walked back to its `if`, because the hook holds several such
 * blocks, and matching the first would silently return whichever sits highest.
 * The closing `fi` is the next one at column zero, so a gate nesting its own
 * `if … fi` is not ended early by the inner one.
 *
 * `anchor` is an arbitrary substring, not a script path: the superseded gate is
 * identified by its `--broken-only` flag. `hook` defaults to the live file, and
 * is overridden to exercise the two throws a well-formed hook cannot reach.
 * @param {string} anchor
 * @param {string} [hook] an adopter's own hook text; left out, this
 *   checkout's `.husky/pre-commit`
 * @returns {string}
 */
function cutGateFragment(anchor, hook = HOOK) {
	const lines = hook.split("\n");
	const body = lines.findIndex(
		(l) => l.includes(anchor) && !l.trimStart().startsWith("#"),
	);
	if (body === -1)
		throw new Error(`no ${anchor} gate found in .husky/pre-commit`);
	const start = lines
		.slice(0, body + 1)
		.findLastIndex((l) => GATE_HEAD.test(l));
	if (start < 0)
		throw new Error(`the ${anchor} gate in .husky/pre-commit has no \`if\``);
	const end = lines.findIndex((l, i) => i > start && l === "fi");
	if (end === -1)
		throw new Error(`the ${anchor} gate in .husky/pre-commit is unclosed`);
	return lines.slice(start, end + 1).join("\n");
}

/**
 * A gate's head: its `if` line through the `then` opening its body, newline
 * included, so a suite swapping it for `if true; then\n` drops the path filter
 * whole. Spans lines where a head joins a second condition with `&&` or `||`.
 * @param {string} anchor as `cutGateFragment`'s
 * @param {string} [hook] as `cutGateFragment`'s
 * @returns {string}
 */
function gateHead(anchor, hook = HOOK) {
	const head = /^[\s\S]*?\bthen[ \t]*(?:#[^\n]*)?\n/.exec(
		cutGateFragment(anchor, hook),
	);
	if (!head)
		throw new Error(
			`the ${anchor} gate in .husky/pre-commit has no \`then\` closing its head`,
		);
	return head[0];
}

/**
 * The ERE a gate's head passes to `armed`, unquoted. Where a head arms twice,
 * the single-quoted one: the context-budget gate's second, `armed -F`, takes a
 * computed path list rather than an ERE.
 * @param {string} anchor as `cutGateFragment`'s
 * @param {string} [hook] as `cutGateFragment`'s
 * @returns {string}
 */
function armingPattern(anchor, hook = HOOK) {
	const re = /\barmed '([^']*)'/;
	const m = re.exec(gateHead(anchor, hook));
	if (!m)
		throw new Error(
			`the ${anchor} gate in .husky/pre-commit passes \`armed\` no single-quoted pattern`,
		);
	return requiredGroup(m, 1, re);
}

/** `scripts/lib/precommit-gate.sh`, which the hook sources (mantahostels#1793). */
const LIB = fs.readFileSync(
	path.join(ROOT, "scripts", "lib", "precommit-gate.sh"),
	"utf8",
);

/**
 * A gate as a RUNNABLE script: the shared library, then the `if armed … fi`
 * block (mantahostels#1793).
 *
 * The hook sources the library by path, which a case cannot: the fragment runs
 * with a throwaway repo as its cwd, where scripts/lib does not exist. Inlining
 * the real bytes runs the real functions, and a fragment WITHOUT them aborts on
 * an undefined command — which under `sh -e` is indistinguishable from the gate
 * refusing, so every case asserting a refusal would pass for the wrong reason.
 *
 * cutGateFragment stays the pure cut, for a case reading the block's own text.
 * @param {string} anchor
 * @param {string} [hook] as `cutGateFragment`'s
 * @returns {string}
 */
function cutGateScript(anchor, hook = HOOK) {
	return `${LIB}\n\n${cutGateFragment(anchor, hook)}`;
}

/**
 * Registers an `afterEach` removing every directory pushed onto the array it
 * returns. Called once at a suite's top level, so one suite never removes
 * another's directories.
 *
 * `afterEach` defaults to vitest's global, set under `globals: true`; a suite
 * without globals passes the one it imports.
 * @param {(fn: () => void) => void} [afterEach]
 * @returns {string[]}
 */
function registerTempCleanup(
	// `any`: globalThis declares no `afterEach`; the typeof check below narrows.
	afterEach = /** @type {any} */ (globalThis).afterEach,
) {
	if (typeof afterEach !== "function")
		throw new Error(
			"registerTempCleanup needs vitest's afterEach: pass it, or enable `globals`",
		);
	/** @type {string[]} */
	const temps = [];
	afterEach(() => {
		for (const t of temps.splice(0))
			fs.rmSync(t, { recursive: true, force: true });
	});
	return temps;
}

/**
 * @typedef {object} TempRepo
 * @property {string} root
 * @property {(...args: string[]) => Buffer} git `git`, bound to `root`. Throws
 *   on a non-zero exit, as execFileSync does.
 */

/**
 * The repo scripts `fragment` invokes as a runnable — matched on command
 * prefix (`node scripts/x.js`, `bash scripts/x.sh`, `sh scripts/x.sh`), the path
 * spelled bare or through `"${WFC_PLUGIN_ROOT:-.}"/` as the hooks spell it, never
 * a bare `scripts/…` path, so one quoted inside a message string is never
 * reported. Comment lines are stripped first, so a comment naming a script by
 * path is not mistaken for a call.
 *
 * Residual, unverified against any gate today: a call spelled `./scripts/x.sh`,
 * wrapped in double quotes, or run through `npm run` reports as no
 * invocation. None of the live gates use those forms; a future one that does
 * needs this regex widened.
 * @param {string} fragment
 * @returns {string[]}
 */
function scriptsInvokedBy(fragment) {
	const stripped = fragment
		.split("\n")
		.filter((l) => !l.trimStart().startsWith("#"))
		.join("\n");
	const re =
		/\b(?:node|bash|sh)\s+(?:"\$\{WFC_PLUGIN_ROOT:-\.\}"\/)?(scripts\/[\w./-]+)/g;
	const found = new Set(
		[...stripped.matchAll(re)].map((m) => requiredGroup(m, 1, re)),
	);
	return [...found].sort();
}

/**
 * Asserts that the gate anchored on `anchor` invokes exactly `supplied` —
 * set equality, not subset. The failure names the gate, each script the
 * fixture is missing and each it supplies that the gate never invokes
 * (mantahostels#2071).
 *
 * Reads `cutGateScript`, not `cutGateFragment`: a fixture RUNS the fragment
 * with `LIB` inlined ahead of it, so a script
 * `precommit-gate.sh` itself came to call would otherwise be invisible here
 * while still executing in every fixture.
 * @param {string} anchor
 * @param {string[]} supplied
 * @param {string} [hook] as `cutGateFragment`'s
 * @returns {void}
 */
function expectFixtureSupplies(anchor, supplied, hook = HOOK) {
	const invoked = scriptsInvokedBy(cutGateScript(anchor, hook));
	const want = [...supplied].sort();
	const notSupplied = invoked.filter((s) => !want.includes(s));
	const notInvoked = want.filter((s) => !invoked.includes(s));
	if (notSupplied.length > 0 || notInvoked.length > 0) {
		throw new Error(
			`the ${anchor} gate invokes [${invoked.join(", ")}], but the fixture supplies [${want.join(", ")}]` +
				(notSupplied.length > 0
					? ` — missing from the fixture: ${notSupplied.join(", ")}`
					: "") +
				(notInvoked.length > 0
					? ` — supplied but never invoked: ${notInvoked.join(", ")}`
					: ""),
		);
	}
}

/**
 * An empty throwaway repo under `prefix`, registered in `temps` for cleanup,
 * plus a `git` bound to it.
 *
 * Throwaway repos throughout — the shared tree's index is repo-global (mantahostels#63) and
 * must never be staged into by a test.
 * @param {string} prefix
 * @param {string[]} temps accumulator: the repo's root is pushed here for cleanup
 * @returns {TempRepo}
 */
function newRepo(prefix, temps) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(root);
	/** @param {string[]} args */
	const git = (...args) => execFileSync("git", args, { cwd: root });
	git("init", "-q", ".");
	// A repo-local identity: a machine with no global `user.email` cannot commit
	// at all (mantahostels#953).
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	return { root, git };
}

/**
 * Writes each of `files` under `root`, parent directories made. Nothing is
 * staged: a suite calls it after `stagedRepo` for a tree that disagrees with
 * the index.
 * @param {string} root
 * @param {Record<string, string>} files relative path to body
 * @returns {void}
 */
function writeFiles(root, files) {
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), body);
	}
}

/**
 * A `newRepo` holding `seed.txt` and `committed` at HEAD and `staged` in the
 * index, each path written and `git add`ed, parent directories made.
 *
 * The seed makes HEAD exist when `committed` is empty, so a gate diffing the
 * index against HEAD reads every `staged` path as added.
 * @param {string} prefix as `newRepo`'s
 * @param {string[]} temps as `newRepo`'s
 * @param {Record<string, string>} committed relative path to body
 * @param {Record<string, string>} staged relative path to body
 * @returns {TempRepo}
 */
function stagedRepo(prefix, temps, committed, staged) {
	const repo = newRepo(prefix, temps);
	/** @param {Record<string, string>} files */
	const put = (files) => {
		writeFiles(repo.root, files);
		for (const rel of Object.keys(files)) repo.git("add", "--", rel);
	};
	put({ "seed.txt": "seed\n", ...committed });
	repo.git("commit", "-qm", "seed");
	put(staged);
	return repo;
}

module.exports = {
	armingPattern,
	cutGateFragment,
	cutGateScript,
	expectFixtureSupplies,
	gateHead,
	newRepo,
	registerTempCleanup,
	stagedRepo,
	writeFiles,
};
