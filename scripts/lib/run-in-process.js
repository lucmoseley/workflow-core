/*
 * runInProcess — run one of this repo's node CLI scripts inside the current
 * process, in place of `spawnSync("node", [script, ...args])`.
 *
 * WHY: the suite's largest single term was `node` startup (mantahostels#1907). Loading the
 * script into this process instead pays parse-and-run only.
 *
 * FOR TESTS ONLY. Nothing under scripts/ that runs in a hook, a gate or CI
 * should require this: a real invocation wants the process boundary.
 *
 * WHAT IT REPRODUCES, because the tests assert on all of it:
 *
 *   status   `process.exit(n)`, a bare `process.exitCode = n`, and a throw
 *            escaping the script (node prints the stack and exits 1).
 *   stdout   both routes this repo writes by — `fs.writeSync` on fd 1, which
 *            lib/write-fd.js uses so a piped hook cannot drop buffered
 *            output, and `process.stdout.write`, which console.log goes
 *            through. Same for stderr on fd 2.
 *   cwd      the script sees `options.cwd` as its working directory, and the
 *            git subprocesses it spawns inherit it.
 *   env      `options.env` REPLACES the environment for the call, exactly as
 *            spawnSync's `env` does, and is restored after.
 *   stdin    `options.stdin` is what `fs.readFileSync(0)` returns, which is how
 *            lib/hook-message.js takes a hook's JSON payload. It is spawnSync's
 *            `input` under another name. Only fd 0 and only readFileSync: a
 *            script that reads stdin as a stream still wants a spawn.
 *   uptime   `process.uptime()` counts from the call's start, as a fresh
 *            node's does, so a clock started at the process's start
 *            (lib/hook-deadline.js) starts at the call.
 *   module   the script's own `module` object is the entry module, so a
 *            `require.main === module` guard fires as it does under node —
 *            true throughout for `runInProcess`. `runInProcessAsync` (mantahostels#1944)
 *            is the one exception: see its own header for why that guard
 *            reads false for the whole call, load included.
 *
 * WHAT A SPAWN GAVE FREE AND THIS DOES NOT:
 *
 *   1. A CLEAN MODULE REGISTRY. Re-created here by purging every cached repo
 *      module before each call, so module-level state (a memoised read, a lazy
 *      singleton) starts empty. node_modules is left cached — that is where
 *      the time saved lives.
 *   2. A CLEAN PROCESS. Everything patched here is global for the duration, so
 *      the call must be the only thing running: no `describe.concurrent`, no
 *      `it.concurrent`, no overlapping async work in the same file. Enforced
 *      by the re-entrancy throw below rather than left to the reader — for a
 *      claim under `staleMs` (mantahostels#2254 below); an `it.concurrent` call that
 *      arrives once the first has been running longer than that reads as
 *      abandoned rather than as the misuse it is, and is taken over instead
 *      of refused.
 *   3. AN EXIT THAT NOTHING CAN CATCH. A real `process.exit` ends the process
 *      where it is called; here it can only throw, and a catch-all between the
 *      call and this function will catch it — runCheck's does, which is the
 *      path `check-guard-registry.js --review` takes. So the exit is recorded
 *      as well as thrown: the recorded code wins whatever the script does
 *      next, and everything written after it is discarded, because a real
 *      process was not there to write it. What still differs is that the
 *      catch-all RUNS, so a `finally` fires that a real exit would have
 *      skipped.
 *   4. A PROCESS THE SCRIPT CANNOT OUTLIVE. Anything it registers on `process`
 *      would stay registered on the vitest worker — lib/check.js adds a crash
 *      reporter per require, and the purge makes every call a fresh require.
 *      Every listener added during a call is taken off again after it, with
 *      two limits: a removal that throws is recorded on `restoreFailures`
 *      rather than retried, and a listener the SCRIPT removed from the
 *      worker's own set is not put back.
 *   5. A CLOSED STDIN. With no `stdin` given, a read of fd 0 reaches the
 *      worker's real one rather than the empty pipe a spawn supplied.
 *   6. A TIMER-FREE EXIT. `process.exit` abandons pending async work; here it
 *      only unwinds the stack. A call that ends with no `process.exit`, and
 *      no throw node would have died of, and leaves a ref'd resource of its
 *      own open is refused, naming its type — that resource is what would
 *      keep a real process from exiting. The async form first gives its own
 *      resources SETTLE_MS to close. One that does end so still leaks what it
 *      left into the test process.
 *   7. A REAL FD FOR A GRANDCHILD. A script that spawns its own child with
 *      `stdio: "inherit"` on fd 1/2 (lib/check.js's `reread`, for one) hands
 *      that grandchild the real OS fd, which writes straight past the patches
 *      below — `state.stdout`/`state.stderr` never see it (mantahostels#1945).
 */

const asyncHooks = require("node:async_hooks");
const { Console } = require("node:console");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { Writable } = require("node:stream");
const { TEST_TIMEOUT_MS } = require("./test-ceiling");
const { caught } = require("./caught.js");

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/* Thrown by the patched process.exit so the stack unwinds to us rather than
 * ending the vitest worker. */
class ExitSignal extends Error {
	/** @param {number} code */
	constructor(code) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

/* Guards the shared-process constraint above: two live calls would interleave
 * their captured output and restore each other's globals.
 *
 * Kept on globalThis, not in a module-level `let`. The constraint is on the
 * PROCESS, and this file is loaded twice in a vitest worker — once as CJS by a
 * script under test, once through vite's transform by the test importing it —
 * so a module-level flag guards only the copy that set it.
 *
 * Holds a claim object, `{ startedAt, restore }`, not a bare boolean. A call
 * whose own `await` never settles within its caller's timeout (vitest's own
 * test timeout does not cancel the promise — `await main()` keeps running
 * after the test that started it has already been marked failed) would
 * otherwise hold this true forever, throwing REENTRANT_MESSAGE at every case
 * after it rather than only at a genuinely concurrent one (mantahostels#2254). A claim
 * older than `staleMs` is instead taken over: the incoming call runs the
 * stale claim's own `restore` itself, synchronously, immediately before
 * installing its own — so the real `process.exit` (`pick-next.js` calls it
 * inside `main()`, not only in its require.main tail) is live for only the
 * instant between, with no `await` in between for an abandoned call's own
 * late call to reach.
 *
 * NOT closed by this, while the abandoned call is still running:
 *
 *   - Its own writes and its own `process.exit` reach whatever patches are
 *     CURRENTLY installed — the call that took it over, if one has — so its
 *     output can land in the new holder's captured stdout/stderr, and an
 *     abandoned `process.exit` can overwrite the new holder's reported exit
 *     status and cut off its later writes (`mutatePatches`' `state.exited`
 *     check, shared by both).
 *   - If it outlives the call that took it over from it too, once that
 *     second call finishes and restores, the abandoned script is left
 *     running against unpatched globals — a real `process.exit` from then on
 *     ends the vitest worker. */
const CLAIM = Symbol.for("wfc.run-in-process.claim");

/* Clearance added on top of TEST_TIMEOUT_MS below, against vitest's own
 * timeout-enforcement latency — unmeasured. */
const MARGIN_MS = 5000;

/* How stale an abandoned claim must be before a new call may take it over.
 * Measured the same way on both sides of the comparison: how long the
 * EXISTING claim has been held, read at the moment the incoming call checks
 * it — not how long the incoming call waited to arrive, which is the same
 * figure only where the incoming call starts checking immediately (this
 * file's own "refuses a re-entrant call" case, and a real `it.concurrent`
 * misuse that arrives promptly).
 *
 * A claim can only be genuinely abandoned — its holder's `await` left
 * pending forever rather than merely slow — once vitest itself has given up
 * on the enclosing test, at `TEST_TIMEOUT_MS` (scripts/lib/test-ceiling.js,
 * currently 90_000ms) after that test began. A call cannot start any EARLIER
 * than the test's own first tick — it runs inside that test — so if
 * `staleMs >= TEST_TIMEOUT_MS`, `Date.now() - claim.startedAt` cannot reach
 * `staleMs` before vitest has already marked the test failed: the test's own
 * deadline (its start plus `TEST_TIMEOUT_MS`) falls no later than the
 * claim's. mantahostels#2267 re-derives DEFAULT_STALE_MS on this basis.
 *
 * `TEST_TIMEOUT_MS` also feeds `hookTimeout`, but this derivation reasons
 * about a TEST's own deadline only — every call site installs a claim from
 * inside a test body, never a hook, so that is the deadline that governs.
 * Safe only as long as the two knobs share one value, as they do today.
 *
 * THE TRADE: a takeover before the ceiling has passed risks silently
 * absorbing a still-live call's writes and its real `process.exit` into
 * whoever takes it over (`CLAIM`'s NOT-closed list) — corruption with no
 * error at all. Waiting until the ceiling has passed instead means every
 * runInProcess/runInProcessAsync call in the same worker throws
 * REENTRANT_MESSAGE — loudly, immediately, not a hang — for up to
 * `MARGIN_MS` after a genuine abandonment (the claim was already at least
 * `TEST_TIMEOUT_MS` old the instant the test died), cascading through
 * however many later tests share that worker until the claim goes stale.
 *
 * Overridable per call (RunOptions.staleMs) so a test can
 * shrink it and run fast rather than waiting seconds. */
const DEFAULT_STALE_MS = TEST_TIMEOUT_MS + MARGIN_MS;

const REENTRANT_MESSAGE =
	"runInProcess/runInProcessAsync is not re-entrant: it patches process " +
	"globals, so a second concurrent call would capture the first call's " +
	"output. Run the " +
	"cases sequentially.";

/**
 * Throws REENTRANT_MESSAGE for a claim younger than `staleMs`. Takes over
 * and clears an older one, returning whatever its own `restore` could not
 * put back — the caller folds this into its own `restoreFailures`, so a
 * taken-over claim's unrestored globals are not silently dropped. `[]`
 * where nothing is claimed.
 *
 * Clears the slot BEFORE running the stale claim's `restore`, not after: a
 * throw out of a direct-assignment restore step (unguarded — see
 * `snapshotPatches`' own restore) must not leave the stale claim standing
 * forever, refusing every call after it exactly as the bug this fixes did.
 *
 * @param {number} staleMs
 * @returns {string[]}
 */
function takeOverStaleClaim(staleMs) {
	const existing = /** @type {any} */ (globalThis)[CLAIM];
	if (!existing) return [];
	if (Date.now() - existing.startedAt < staleMs)
		throw new Error(REENTRANT_MESSAGE);
	/** @type {any} */ (globalThis)[CLAIM] = null;
	return existing.restore();
}

/**
 * Installs a fresh claim, its `restore` to be filled in once the caller has
 * one to give it.
 *
 * @returns {{ startedAt: number, restore: () => string[] }}
 */
function installClaim() {
	/** @type {{ startedAt: number, restore: () => string[] }} */
	const claim = { startedAt: Date.now(), restore: () => [] };
	/** @type {any} */ (globalThis)[CLAIM] = claim;
	return claim;
}

/**
 * Whether `claim` is still the live holder, not taken over as stale.
 *
 * @param {{ startedAt: number, restore: () => string[] }} claim
 */
const isHolder = (claim) => /** @type {any} */ (globalThis)[CLAIM] === claim;

/**
 * Releases `claim`, but only where it is still the live holder — a claim a
 * later call has already taken over as stale must not restore or clear on
 * its own late settle, which would revert the new holder's patches out from
 * under it while it is still running.
 *
 * @param {{ startedAt: number, restore: () => string[] }} claim
 * @param {() => string[]} restore
 * @returns {string[]}
 */
function releaseClaim(claim, restore) {
	if (!isHolder(claim)) return [];
	/** @type {any} */ (globalThis)[CLAIM] = null;
	return restore();
}

/**
 * Drops every cached first-party module, so the next require re-executes it and
 * module-level state starts empty.
 *
 * Not "everything under this repo": several suites run a checker out of a
 * fixture COPY of the tree in a temp directory, and leaving that copy's
 * libraries cached would carry one case's state into the next.
 */
function purgeCallerModules() {
	for (const key of Object.keys(require.cache)) {
		if (key === __filename) continue;
		if (!key.includes(NODE_MODULES)) delete require.cache[key];
	}
}

/* The async_hooks types that keep a process alive until they close, and
 * report closing through `destroy`: libuv handles, timers, and fs requests.
 * Others — a crypto job, a stream's end-of-stream listener — report `destroy`
 * only on garbage collection, so would read as open long after they finished.
 * A PROMISE is never counted, only followed to attribute what it creates. */
const KEEPS_ALIVE = new Set([
	"Timeout",
	"Immediate",
	"FSREQCALLBACK",
	"FSEVENTWRAP",
	"STATWATCHER",
	"PROCESSWRAP",
	"PIPEWRAP",
	"PIPESERVERWRAP",
	"TCPWRAP",
	"TCPSERVERWRAP",
	"UDPWRAP",
	"TTYWRAP",
	"SIGNALWRAP",
]);

/* Unmeasured guess: how long an async call's own handles get to close once
 * main() has settled — a child process's handle closes a few ticks after its
 * exit callback. A resource still open after it is refused. */
const SETTLE_MS = 200;

/**
 * Tracks the async resources a call creates (#2782), through `async_hooks`.
 * A resource is the call's where it was created while the call's own code
 * ran synchronously, or by, or inside, a resource that is already the call's.
 * So a socket the vitest worker's own server accepts during an `await` is
 * not, and a promise continuation inside `main()` is.
 *
 * `attributing` is turned off once the call's own code is no longer on the
 * stack (the async form's await) and again once the call has settled, so the
 * harness's own continuation is not counted as the script's.
 */
function trackResources() {
	/** @type {Set<number>} */
	const owned = new Set();
	/** @type {Map<number, { type: string, resource: any }>} */
	const live = new Map();
	const flags = { inSync: true, attributing: true };
	const hook = asyncHooks
		.createHook({
			init(id, type, trigger, resource) {
				if (!flags.attributing) return;
				if (
					!flags.inSync &&
					!owned.has(trigger) &&
					!owned.has(asyncHooks.executionAsyncId())
				)
					return;
				owned.add(id);
				if (KEEPS_ALIVE.has(type)) live.set(id, { type, resource });
			},
			destroy(id) {
				live.delete(id);
			},
		})
		.enable();

	/** What the call created that is still open and would hold a real process. */
	const held = () =>
		[...live.values()].filter(
			({ resource }) =>
				typeof resource?.hasRef !== "function" || resource.hasRef(),
		);

	return {
		flags,
		/** Waits, up to SETTLE_MS, for the call's own resources to close. */
		async settle() {
			flags.attributing = false;
			const deadline = Date.now() + SETTLE_MS;
			while (held().length > 0 && Date.now() < deadline)
				await new Promise((resolve) => setImmediate(resolve));
		},
		/** @returns {string[]} `<type> x<n>` per type still held */
		leaked() {
			const counts = new Map();
			for (const { type } of held())
				counts.set(type, (counts.get(type) ?? 0) + 1);
			return [...counts].map(([type, n]) => `${type} x${n}`);
		},
		disable() {
			hook.disable();
		},
	};
}

/**
 * Refuses a call that did not end the process (`state.exited` null) and left
 * ref'd resources of its own open (header item 6).
 *
 * @param {string} script
 * @param {string[]} leaked
 */
function refuseLeaks(script, leaked) {
	if (leaked.length > 0)
		throw new Error(
			`runInProcess: ${script} returned without ending the process and left ref'd ` +
				`resources of its own open, which a real process would wait on: ${leaked.join(", ")}. ` +
				"Close, clear or unref them, await them, or end on process.exit.",
		);
}

/* Buffer.isEncoding, not `typeof enc === "string"`: a Writable hands its _write
 * the chunk as a Buffer under the encoding "buffer", which is a string and is
 * not an encoding Buffer.toString will take. */
/** @type {(chunk: unknown, enc?: unknown) => string} */
const toText = (chunk, enc) =>
	typeof chunk === "string"
		? chunk
		: Buffer.from(/** @type {any} */ (chunk)).toString(
				typeof enc === "string" && Buffer.isEncoding(enc)
					? /** @type {BufferEncoding} */ (enc)
					: "utf8",
			);

/**
 * Replaces process.env in place. Mutation, not reassignment: a plain object
 * assigned over process.env stops child processes inheriting it natively, and
 * the scripts under test spawn git constantly.
 *
 * @param {Record<string, string | undefined>} env
 */
function replaceEnv(env) {
	for (const key of Object.keys(process.env))
		if (!(key in env)) delete process.env[key];
	for (const [key, value] of Object.entries(env))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
}

/**
 * A stream that appends to the capture buffer instead of reaching a fd. Its
 * write callback fires synchronously, so console output keeps its position
 * relative to the fd writes around it.
 *
 * @param {(text: string) => void} append
 */
const sink = (append) =>
	new Writable({
		write(chunk, enc, cb) {
			append(toText(chunk, enc));
			cb();
		},
	});

/* An exit status is 8 bits on the way out of a real process. Nothing in this
 * repo exits above 2; the mask is here so the first script that does is not
 * reported a code no shell could have seen. The double modulo is for the
 * negative case, where JS's own % answers -1 rather than 255. */
/** @type {(code: unknown) => number} */
const exitCodeOf = (code) => (((Number(code ?? 0) | 0) % 256) + 256) % 256;

/*
 * Runs a restore step, never letting its failure skip the ones after it, and
 * never swallowing it either: what went wrong comes back on the result's
 * `restoreFailures`, so a caller is not left guessing why a later call in the
 * same worker behaves oddly.
 */
/**
 * @param {() => void} step
 * @param {string[]} failures accumulator: the step's failure is pushed here
 */
const attempt = (step, failures) => {
	try {
		step();
	} catch (e) {
		failures.push(caught(e).message || String(e));
	}
};

/**
 * Removes every process listener registered since the snapshot. Only the ones
 * the call added: a listener the vitest worker had before is left alone. Each
 * removal is guarded on its own, so one throwing store cannot leave the rest of
 * the sweep unrun.
 *
 * `Function` here, and `any` at the removal, hold whatever the runtime handed
 * back from `process.rawListeners` — per-event, and unknowable from here.
 *
 * @param {Map<string | symbol, Set<Function>>} saved
 * @param {string[]} failures
 */
function dropAddedListeners(saved, failures) {
	for (const name of process.eventNames()) {
		const before = saved.get(name);
		for (const fn of process.rawListeners(name))
			if (!before?.has(fn))
				attempt(
					() => process.removeListener(name, /** @type {any} */ (fn)),
					failures,
				);
	}
}

/**
 * What node does with an uncaught throw out of the entry point: hand it to the
 * process's uncaughtException listeners, and only print the stack and exit 1
 * where there are none. Every checker
 * requires lib/check.js, whose listener reports the crash as BROKEN and exits
 * 2, so swallowing this would report a checker's own crash as a plain failure.
 *
 * Only the listeners this call registered are called. Reaching the ones the
 * vitest worker installed for itself would report the script's crash as the
 * test process crashing.
 *
 * `end` hears the two outcomes where node ends the process — no listener, and
 * a listener that throws — and not a listener that returns, after which a
 * real process runs on.
 *
 * @param {any} e
 * @param {Map<string | symbol, Set<Function>>} saved
 * @param {(text: string) => void} write
 * @param {(code: number) => void} end
 * @returns {number}
 */
function crash(e, saved, write, end) {
	const before = saved.get("uncaughtException");
	const added = process
		.rawListeners("uncaughtException")
		.filter((fn) => !before?.has(fn));
	if (added.length === 0) {
		write(`${e?.stack || String(e)}\n`);
		end(1);
		return 1;
	}
	try {
		for (const fn of added) fn(e, "uncaughtException");
		return exitCodeOf(process.exitCode);
	} catch (inner) {
		if (inner instanceof ExitSignal) return inner.code;
		/* Node calls no later listener and exits 7 — "Internal Exception Handler
		 * Run-Time Failure" — where the handler itself throws. */
		write(
			`${(inner instanceof Error && inner.stack) || caught(inner).message}\n`,
		);
		end(7);
		return 7;
	}
}

/**
 * What an entry point's own catch does with whatever escaped `entry.load` or
 * the call it made into the script: an `ExitSignal` wins outright, a swallowed
 * exit is left as it was (a real process was already gone by the time the
 * script's own catch ran), and anything else goes to node's own uncaught-throw
 * handling via `crash`. Shared so `runInProcess`'s one call site and
 * `runInProcessAsync`'s two — load and `main()` — treat an escape identically.
 *
 * @param {any} e
 * @param {CaptureState} state accumulator: a crash's report is appended to `stderr`; `exited` is read, and set where the crash ends the process
 * @param {Map<string | symbol, Set<Function>>} listeners
 * @returns {number | null} the status to record, or null to leave `state.status` as it was
 */
function statusOfEscape(e, state, listeners) {
	if (e instanceof ExitSignal) return e.code;
	if (state.exited !== null) {
		/* The script caught its own exit and threw something else. A real
		 * process was already gone by then. */
		return null;
	}
	return crash(
		e,
		listeners,
		(text) => {
			state.stderr += text;
		},
		(code) => {
			state.exited = code;
		},
	);
}

/**
 * @typedef {object} RunOptions
 * @property {string}   [cwd]  working directory for the call (default: unchanged)
 * @property {Record<string, string | undefined>} [env] full environment,
 *           replacing this one
 * @property {string} [stdin] what the script reads off fd 0
 * @property {number} [staleMs] how long another call's claim must have been
 *           held before this call takes it over instead of refusing as
 *           re-entrant (default: DEFAULT_STALE_MS, `TEST_TIMEOUT_MS + MARGIN_MS`)
 *
 * @typedef {object} RunResult
 * @property {number} status  the exit code the script would have exited with
 * @property {string} stdout  everything written to fd 1
 * @property {string} stderr  everything written to fd 2
 * @property {string[]} restoreFailures  what could not be put back afterwards;
 *           empty on every ordinary run
 *
 * `exited` is the code the process ended on — by `process.exit`, or by a
 * throw node dies of — and null while a real process would still be running.
 *
 * @typedef {{ stdout: string, stderr: string, status: number, exited: number | null }} CaptureState
 */

/**
 * @typedef {object} Saved
 * @property {string} cwd
 * @property {string[]} argv
 * @property {typeof process.exit} exit
 * @property {typeof process.uptime} uptime
 * @property {string | number | undefined} exitCode
 * @property {NodeJS.Module | undefined} mainModule
 * @property {typeof fs.writeSync} writeSync
 * @property {typeof fs.readFileSync} readFileSync
 * @property {typeof process.stdout.write} stdout
 * @property {typeof process.stderr.write} stderr
 * @property {Console} console
 * @property {NodeJS.ProcessEnv} env
 */

/**
 * Captures every process-global both entry points patch, and builds how to put
 * them back — before either entry point mutates anything, so the restore it
 * returns is good even where `mutatePatches` below throws partway through
 * (`process.chdir` on a directory a caller's test has already removed, say).
 *
 * @returns {{ saved: Saved, listeners: Map<string | symbol, Set<Function>>, restore: () => string[] }}
 */
function snapshotPatches() {
	const saved = {
		cwd: process.cwd(),
		argv: process.argv,
		exit: process.exit,
		uptime: process.uptime,
		exitCode: process.exitCode,
		mainModule: process.mainModule,
		writeSync: fs.writeSync,
		readFileSync: fs.readFileSync,
		stdout: process.stdout.write,
		stderr: process.stderr.write,
		console: globalThis.console,
		env: { ...process.env },
	};
	const listeners = new Map(
		process
			.eventNames()
			.map((name) => [name, new Set(process.rawListeners(name))]),
	);

	const restore = () => {
		/** @type {string[]} */
		const restoreFailures = [];
		/* Each restore stands alone. chdir throws where the test has already
		 * removed its temp directory, and replaceEnv is the caller's data — either
		 * one thrown from a bare sequence would leave process.exit and console
		 * patched for the rest of the worker's life. */
		process.argv = saved.argv;
		process.exit = saved.exit;
		process.uptime = saved.uptime;
		process.exitCode = saved.exitCode;
		process.mainModule = saved.mainModule;
		/** @type {any} */ (fs).writeSync = saved.writeSync;
		/** @type {any} */ (fs).readFileSync = saved.readFileSync;
		process.stdout.write = saved.stdout;
		process.stderr.write = saved.stderr;
		globalThis.console = saved.console;
		attempt(() => process.chdir(saved.cwd), restoreFailures);
		attempt(() => replaceEnv(saved.env), restoreFailures);
		attempt(
			() => dropAddedListeners(listeners, restoreFailures),
			restoreFailures,
		);
		return restoreFailures;
	};

	return { saved, listeners, restore };
}

/**
 * Applies the patches both entry points capture output and exit through, onto
 * a snapshot `snapshotPatches` already took. Shared so the sync and async
 * paths capture identically — only how each drives the entry module's code
 * differs, which lives in their own functions below.
 *
 * Does not touch `process.mainModule`: that is set once the caller has built
 * the entry module, and the two entry points set it at different points in
 * the sequence (see `runInProcessAsync`'s header), so it stays theirs to set.
 *
 * @param {{ saved: Saved }} snapshot
 * @param {{ script: string, args: string[], options: RunOptions }} run
 * @param {CaptureState} state accumulator: `stdout`/`stderr`/`exited` are
 *   written by the patches below as the script runs; `status` is the caller's
 *   to set, once the load or the call it makes has returned
 */
function mutatePatches({ saved }, { script, args, options }, state) {
	if (options.env) replaceEnv(options.env);
	if (options.cwd) process.chdir(path.resolve(options.cwd));
	process.argv = [process.execPath, script, ...args];
	process.exitCode = undefined;
	const startedAt = saved.uptime();
	process.uptime = () => saved.uptime() - startedAt;
	process.exit = /** @type {any} */ (
		(/** @type {number} */ code) => {
			/* The FIRST call wins. A catch-all that swallows this throw and then
			 * exits itself — runCheck's does — would otherwise overwrite the code
			 * the script had already ended on. */
			if (state.exited === null)
				state.exited = exitCodeOf(code ?? process.exitCode);
			throw new ExitSignal(state.exited);
		}
	);
	/** @type {any} */ (fs).writeSync = (
		/** @type {number} */ fd,
		/** @type {any} */ data,
		/** @type {any[]} */ ...rest
	) => {
		if (fd !== 1 && fd !== 2) return saved.writeSync(fd, data, ...rest);
		const text = toText(data);
		if (state.exited !== null) return Buffer.byteLength(text);
		if (fd === 1) state.stdout += text;
		else state.stderr += text;
		return Buffer.byteLength(text);
	};
	/* The callback forms are honoured because a script that passes one and
	 * never sees it called can wait forever. */
	process.stdout.write = /** @type {any} */ (
		(/** @type {any} */ c, /** @type {any} */ e, /** @type {any} */ cb) => {
			if (state.exited === null) state.stdout += toText(c, e);
			const done = typeof e === "function" ? e : cb;
			if (done) done();
			return true;
		}
	);
	process.stderr.write = /** @type {any} */ (
		(/** @type {any} */ c, /** @type {any} */ e, /** @type {any} */ cb) => {
			if (state.exited === null) state.stderr += toText(c, e);
			const done = typeof e === "function" ? e : cb;
			if (done) done();
			return true;
		}
	);

	/* Only fd 0, and only when the caller supplied one: everything else has to
	 * keep reading the real filesystem, the script's own fixture included. */
	if (options.stdin !== undefined) {
		const stdin = options.stdin;
		/** @type {any} */ (fs).readFileSync = (
			/** @type {any} */ target,
			/** @type {any} */ opts,
		) => {
			if (target !== 0) return saved.readFileSync(target, opts);
			const encoding = typeof opts === "string" ? opts : opts?.encoding;
			return encoding ? stdin : Buffer.from(stdin);
		};
	}

	/* console is patched as well as the stream beneath it because the vitest
	 * worker swaps in a console of its own that reports to the runner rather
	 * than writing through process.stdout — so patching the stream alone
	 * loses every console.log the script makes. */
	globalThis.console = new Console({
		stdout: sink((text) => {
			if (state.exited === null) state.stdout += text;
		}),
		stderr: sink((text) => {
			if (state.exited === null) state.stderr += text;
		}),
	});
}

/**
 * Builds the module object a script loads into as its own `module` —
 * identity, not a copy, so a `require.main === module` guard inside the
 * script can compare against it.
 * @param {string} script
 */
function buildEntry(script) {
	const entry = /** @type {any} */ (new Module(script, undefined));
	entry.filename = script;
	entry.paths = /** @type {any} */ (Module)._nodeModulePaths(
		path.dirname(script),
	);
	return entry;
}

/**
 * @typedef {object} Call
 * @property {string} script
 * @property {CaptureState} state
 * @property {Map<string | symbol, Set<Function>>} listeners
 * @property {any} entry  the module `buildEntry` made, already patched in
 * @property {{ startedAt: number, restore: () => string[] }} claim
 * @property {ReturnType<typeof trackResources>} resources  what the call has created
 * @property {string[]} takeoverFailures
 */

/**
 * Everything both entry points do before they drive the script. A throw
 * partway through releases the claim before it escapes, so nothing is left
 * patched.
 *
 * @param {string} script  already resolved
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {Call}
 */
function beginCall(script, args, options) {
	const takeoverFailures = takeOverStaleClaim(
		options.staleMs ?? DEFAULT_STALE_MS,
	);
	/** @type {CaptureState} */
	const state = { stdout: "", stderr: "", status: 0, exited: null };
	const claim = installClaim();
	/* After the snapshot: its first read of process.stdout makes the stream's
	 * handle in a plain node host, which is the host's, not the script's. */
	const snapshot = snapshotPatches();
	const resources = trackResources();
	claim.restore = snapshot.restore;
	try {
		mutatePatches(snapshot, { script, args, options }, state);
		purgeCallerModules();
		const entry = buildEntry(script);
		require.cache[script] = entry;
		return {
			script,
			state,
			listeners: snapshot.listeners,
			entry,
			claim,
			resources,
			takeoverFailures,
		};
	} catch (e) {
		resources.disable();
		releaseClaim(claim, snapshot.restore);
		throw e;
	}
}

/**
 * The leak
 * check (#2782) runs only where the call still held the claim — one taken
 * over shared the process with the call that took it, so what it sees change
 * is not its own — and did not end the process.
 *
 * @param {Call} call
 * @returns {RunResult}
 */
function releaseAndReport(call) {
	const { script, state, claim, resources, takeoverFailures } = call;
	if (state.exited !== null) state.status = state.exited;
	const held = isHolder(claim);
	const restoreFailures = [
		...takeoverFailures,
		...releaseClaim(claim, claim.restore),
	];
	resources.disable();
	if (held && state.exited === null) refuseLeaks(script, resources.leaked());
	return {
		status: state.status,
		stdout: state.stdout,
		stderr: state.stderr,
		restoreFailures,
	};
}

/**
 * Records what escaped the script — a load, or the call made into it — as
 * its status.
 *
 * @param {Call} call
 * @param {any} e
 */
function recordEscape(call, e) {
	const status = statusOfEscape(e, call.state, call.listeners);
	if (status !== null) call.state.status = status;
}

/**
 * @param {string} scriptPath  path to the CLI script, resolved against cwd
 * @param {string[]} [args]    argv beyond the script name
 * @param {RunOptions} [options]
 * @returns {RunResult}
 */
function runInProcess(scriptPath, args = [], options = {}) {
	const call = beginCall(path.resolve(scriptPath), args, options);
	try {
		process.mainModule = call.entry;
		call.entry.load(call.script);
		call.state.status = exitCodeOf(process.exitCode);
	} catch (e) {
		recordEscape(call, e);
	}
	return releaseAndReport(call);
}

/**
 * The async counterpart (mantahostels#1944): `pick-next.test.ts` is the one file the sync
 * seam above cannot take, because its script's entry point is
 * `async function main()` and `runInProcess` returns as soon as `entry.load`
 * does — before an async `main()` has done anything, since loading only runs
 * the script's synchronous top level.
 *
 * THE GUARD RUNS DIFFERENTLY HERE, DELIBERATELY, ON THE SHAPE THIS FUNCTION
 * REQUIRES. A script that calls its `main` unconditionally at load, with no
 * `require.main` guard, is dangerous here — see the pre-load check below.
 * The shape this function needs is:
 *
 *     module.exports = { ..., main };
 *     if (require.main === module) {
 *       main(process.argv.slice(2)).then(
 *         (code) => { process.exitCode = code; },
 *         (e) => { console.error(...); process.exitCode = 1; },
 *       );
 *     }
 *
 * This function stands in for that tail: it calls `main` with the argv
 * beyond the script name, and a number `main` resolves to is the status,
 * ahead of `process.exitCode` (#3485). A tail that ignores a returned number
 * would read wrong here.
 *
 * `runInProcess` sets `process.mainModule = entry` BEFORE `entry.load`, so
 * that guard is true and the auto-invoked `main()` is what runs. This
 * function cannot use that: the auto-invoked call's promise is swallowed by
 * its own `.catch`, so nothing here could ever await it, and awaiting a
 * SECOND `main()` call alongside the auto-invoked first would run the script
 * twice — duplicate output, duplicate side effects, and an auto-invoked
 * rejection racing this function's restore as an unhandled promise rejection
 * in the vitest worker once `entry.load` has already returned.
 *
 * So `process.mainModule` is left un-set to `entry` for `entry.load` itself —
 * the guard reads false, the auto-invoke never fires, and only the exports
 * are populated. This function then calls the exported `main` itself and
 * awaits it.
 *
 * A SECOND DIVERGENCE (mantahostels#1996, pinned by run-in-process.test.ts's
 * "hands a rejection to a script's own uncaughtException listener" case):
 * `entry.load` never runs the script's own `if (require.main === module)
 * { main().catch(...) }` tail — that guard
 * reads false throughout, by design, above — so a rejection out of `main()`
 * here never reaches the script's own `.catch` formatting or exit code. It
 * goes through `statusOfEscape`/`crash` instead, exactly as an escape from
 * `entry.load` itself would: NO listener means a raw stack on stderr and exit
 * 1; a script that requires lib/check.js (as pick-next.js does, transitively,
 * via lib/gh.js) has that module's own `uncaughtException` listener installed
 * by the time `main()` runs, and reaches it instead — `BROKEN: … / exit 2`,
 * not the tail's own `FAILED: … / exit 1`.
 *
 * ONE FIDELITY GAP THIS CANNOT CLOSE: `require.main` is fixed on a module's
 * own `require` function when node COMPILES it, not read live off
 * `process.mainModule` on every access — reassigning `process.mainModule`
 * once `entry.load` has already compiled the script changes nothing that
 * script sees. So a script's own `require.main === module` check reads FALSE
 * throughout `main()` here, unlike under `runInProcess` (sync scripts) or a
 * real invocation, where it is true. `process.mainModule = entry` is set
 * before calling `main` anyway, for whatever inside it reads
 * `process.mainModule` directly rather than through `require.main` — the
 * one channel this residual does not touch.
 *
 * A script with no exported `main` is a harness misuse, not a script failure,
 * so it throws past this function's own error handling rather than being
 * reported as the script's exit status. Where the script carries no
 * `require.main` guard at all, that check
 * comes too late: `entry.load` would already have run the script's
 * unconditional top-level call for real, unawaited, before this function ever
 * looks for an export. So the source is checked for the substring
 * `require.main` BEFORE `entry.load` runs at all, and a script without it is
 * refused outright rather than half-executed. THIS CHECK IS TEXTUAL, NOT
 * STRUCTURAL: it passes a script that merely mentions `require.main` in a
 * comment or a string without ever gating on it — this repo's own
 * `in-process-unguarded-probe.js` fixture has to avoid spelling that
 * identifier out in its own header for exactly this reason.
 *
 * @param {string} scriptPath
 * @param {string[]} [args]
 * @param {RunOptions} [options]
 * @returns {Promise<RunResult>}
 */
async function runInProcessAsync(scriptPath, args = [], options = {}) {
	const script = path.resolve(scriptPath);

	/* Before anything is claimed, patched or loaded — see this function's own
	 * header for why. */
	if (!fs.readFileSync(script, "utf8").includes("require.main"))
		throw new Error(
			`runInProcessAsync: ${script} carries no "require.main" guard, so its ` +
				"entry point runs unconditionally at load — this seam cannot load " +
				"it safely. It needs the shape module.exports = { ..., main }; " +
				"if (require.main === module) { main().catch(...) }.",
		);

	const call = beginCall(script, args, options);
	try {
		/* process.mainModule is deliberately NOT entry yet — see header. A throw
		 * here (a syntax error, or a top-level statement outside the
		 * require.main guard) gets the same treatment `runInProcess` gives it. */
		try {
			call.entry.load(script);
		} catch (e) {
			recordEscape(call, e);
			return releaseAndReport(call);
		}

		const main = call.entry.exports?.main;
		if (typeof main !== "function")
			throw new Error(
				`runInProcessAsync: ${script} exports no "main" function. It must, ` +
					"since this seam calls it directly rather than relying on the " +
					"script's own require.main-gated auto-invoke.",
			);

		process.mainModule = call.entry;
		try {
			const pending = main(args);
			call.resources.flags.inSync = false;
			const returned = await pending;
			call.state.status = exitCodeOf(
				typeof returned === "number" ? returned : process.exitCode,
			);
		} catch (e) {
			recordEscape(call, e);
		}
		await call.resources.settle();
		return releaseAndReport(call);
	} finally {
		call.resources.disable();
		releaseClaim(call.claim, call.claim.restore);
	}
}

module.exports = {
	runInProcess,
	runInProcessAsync,
};
