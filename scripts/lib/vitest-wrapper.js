/*
 * vitest-wrapper.js — the guard-vitest-wrapper core (#2800, #3227): a vitest run
 * that skips scripts/run-vitest.js has no stall watchdog (mantahostels#2002,
 * the follow-on to mantahostels#1910's).
 *
 * THE FAILURE IT POINTS AT. A synchronous call that never returns parks a
 * vitest worker for good. vitest cannot time one out — `testTimeout` is
 * enforced on the event loop that call never yields to — so the parent waits
 * on the worker with no output and no limit.
 *
 * scripts/run-vitest.js kills that run after five minutes of silence and
 * names the file it parked in. `npm run test` and `npm run test:changed` go
 * through it. A direct `vitest` invocation does not, and the single-file form
 * (`node_modules/.bin/vitest run <file>`) is the one sessions reach for most.
 *
 * WARN, never deny (mantahostels#908, mantahostels#987). The command is not
 * unsafe; it is unprotected, and the unprotected form is still the right one
 * for a watcher or a bench.
 *
 * ONCE A SESSION FOR THE RULE, EVERY TIME FOR THE SUGGESTION
 * (mantahostels#2275). The fragment rides as the kit's prelude under the
 * `warn.vitest-wrapper` latch (`latchAfter`), which the kit writes only once
 * the envelope is out — emit, THEN latch (mantahostels#2261): a hook
 * cancelled at its timeout has its stdout discarded, and marking first would
 * leave a session told and never tell it. Once told, `ctx.told` answers yes
 * and the standing line goes out instead. The wrapped command, which is
 * different every time, is never latched.
 *
 * ONE MESSAGE A COMMAND: the first vitest segment the walk meets decides it.
 *
 * SCOPE — a ONE-SHOT vitest invocation the wrapper could have served:
 *
 *   vitest run …                 npx vitest run …
 *   node_modules/.bin/vitest …   ./node_modules/.bin/vitest run …
 *
 * DELIBERATELY OUT OF SCOPE, because run-vitest.js hardcodes `run` and cannot
 * serve them:
 *
 *   --watch / watch    an idle watcher is silent by design, so a silence
 *                      watchdog would kill it between runs. `npm run
 *                      test:watch` is uncovered by the watchdog.
 *   bench, list, related, init, typecheck, dev
 *                      a different subcommand entirely; the wrapper would run
 *                      `vitest run <that>`.
 *
 * BLIND SPOTS. It reads the command word as written, so a runner spelled some
 * other way is invisible: a quoted `"vitest"`, `node
 * node_modules/vitest/vitest.mjs`, a shell function, a script that invokes
 * vitest for you, anything behind `sh -c`, and any launcher but `npx` —
 * `pnpm vitest`, `yarn vitest` and `npm exec vitest` all pass unseen.
 *
 * FAILS OPEN on everything — a throw, an unwritable latch — recorded on the
 * guard-error log (mantahostels#103 §6, mantahostels#147). A rule the store
 * cannot give is sent as a fallback sentence naming the file, logged, never
 * refused.
 */

const { ruleOrFallback } = require("./guard-verdict.js");
const { parseCommand, unmask, walkCommands } = require("./shell-parse.js");

const STANDING_LINE =
	"A vitest run outside `scripts/run-vitest.js` has no stall watchdog (`rule:vitest-wrapper`).";

const HEAP_CAP = "NODE_OPTIONS=--max-old-space-size=2048";

const UNSERVABLE = new Set([
	"watch",
	"bench",
	"list",
	"related",
	"init",
	"typecheck",
	"dev",
]);

const NPX_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);

/**
 * @typedef {import("./kit-context.js").KitContext} WrapperContext
 */

/**
 * Whether `word` names the vitest binary: the bare name on PATH or a path
 * whose LAST segment is exactly `vitest` — so `node_modules/.bin/vitest`
 * matches and `scripts/run-vitest.js`, `vitest-foo` and `my-vitest` do not.
 * @param {string | undefined} word
 */
const isVitestWord = (word) =>
	word !== undefined && (word === "vitest" || word.endsWith("/vitest"));

/** @param {string[]} args */
const isUnservable = (args) =>
	args.some((w) => w === "--watch" || w.startsWith("--watch=")) ||
	args.slice(0, 1).some((w) => UNSERVABLE.has(w));

/** @param {string[]} words */
function npxTarget(words) {
	for (let i = 0; i < words.length; ) {
		const w = words[i];
		if (w === undefined || !w.startsWith("-")) return i;
		i += NPX_VALUE_FLAGS.has(w) ? 2 : 1;
	}
	return -1;
}

/** @param {string[]} words */
function vitestArgs(words) {
	const head = words[0];
	if (isVitestWord(head)) return words.slice(1);
	if (head !== "npx" && !head?.endsWith("/npx")) return null;
	const rest = words.slice(1);
	const at = npxTarget(rest);
	if (at < 0 || !isVitestWord(rest[at])) return null;
	return rest.slice(at + 1);
}

/**
 * @param {string} segment
 * @param {string[]} args
 * @param {WrapperContext} ctx
 */
function body(segment, args, ctx) {
	const forwarded =
		args[0] === "run" || args[0] === "--run" ? args.slice(1) : args;
	let suggestion = `${HEAP_CAP} node ${ctx.scriptPath("run-vitest.js")}`;
	if (forwarded.length > 0) suggestion += ` ${unmask(forwarded.join(" "))}`;
	return `This command: ${unmask(segment)}\nWrapped:      ${suggestion}`;
}

/** @param {WrapperContext} ctx */
const wrapperRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"vitest-wrapper",
		"A vitest run outside `scripts/run-vitest.js` has no stall watchdog",
		() => ctx.log("rule vitest-wrapper unreadable — its fallback sent instead"),
	);

/**
 * @param {string} command
 * @param {WrapperContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	/** @type {{ segment: string, args: string[] }[]} */
	const hits = [];
	walkCommands(
		parseCommand(command),
		({ segment, words }) => {
			const args = vitestArgs(words);
			if (args !== null && !isUnservable(args)) hits.push({ segment, args });
		},
		ctx,
	);
	const [hit] = hits;
	if (hit === undefined) return null;
	const text = body(hit.segment, hit.args, ctx);
	if (ctx.told("vitest-wrapper"))
		return { context: `${STANDING_LINE}\n\n${text}` };
	return {
		injectRules: [],
		prelude: ctx.corePaths(`${wrapperRule(ctx)}\n\n${text}`),
		latchAfter: "vitest-wrapper",
	};
}

module.exports = { field: "command", noun: "command", decide };
