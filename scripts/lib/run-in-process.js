/*
 * Usage:
 *   const { runInProcess } = require("./lib/run-in-process.js");
 *   const { status, stdout, stderr } = runInProcess(script, args, options);
 *
 * Runs a node CLI script inside the current process, in place of
 * `spawnSync("node", [script, ...args])`.
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
 *   stdin    `options.stdin` is what fd 0 holds, read by `fs.readFileSync(0)`,
 *            or by `fs.readSync(0, …)` calls, which is how lib/read-fd.js takes
 *            a hook's JSON payload. It is spawnSync's `input` under
 *            another name, so with none given fd 0 reads empty, as a spawn's
 *            closed pipe does. Only fd 0 and only those
 *            two: a script that reads stdin as a stream still wants a spawn.
 *   uptime   `process.uptime()` counts from the call's start, as a fresh
 *            node's does, so a clock started at the process's start
 *            (lib/hook-deadline.js) starts at the call.
 *   module   the script's own `module` object is the entry module, so a
 *            `require.main === module` guard fires as it does under node —
 *            true throughout for `runInProcess`. `runInProcessAsync`
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
 *      claim under `staleMs`; an `it.concurrent` call that
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
 *   5. A TIMER-FREE EXIT. `process.exit` abandons pending async work; here it
 *      only unwinds the stack. A call that ends with no `process.exit`, and
 *      no throw node would have died of, and leaves a ref'd resource of its
 *      own open is refused, naming its type — that resource is what would
 *      keep a real process from exiting. The async form first gives its own
 *      resources SETTLE_MS, then SETTLE_TURNS loop turns, to close. One that does end so still leaks what it
 *      left into the test process.
 *   6. A REAL FD FOR A GRANDCHILD. A script that spawns its own child with
 *      `stdio: "inherit"` on fd 1/2 (lib/check.js's `reread`, for one) hands
 *      that grandchild the real OS fd, which writes straight past the patches
 *      below — `state.stdout`/`state.stderr` never see it.
 */
const asyncHooks = require("node:async_hooks");
const { Console } = require("node:console");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { Writable } = require("node:stream");
const { TEST_TIMEOUT_MS } = require("./test-ceiling");
const { caught } = require("./caught.js");
const { replaceEnv, takeWrites, toText } = require("./process-globals.js");

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

class ExitSignal extends Error {
	/** @param {number} code */
	constructor(code) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

const CLAIM = Symbol.for("wfc.run-in-process.claim");

/** @typedef {{ startedAt: number, restore: () => string[] }} Claim */

const slot = /** @type {{ [CLAIM]?: Claim | null }} */ (globalThis);

// guess, lucmoseley/mantahostels#2267
const MARGIN_MS = 5000;

// lucmoseley/mantahostels#2267
const DEFAULT_STALE_MS = TEST_TIMEOUT_MS + MARGIN_MS;

const REENTRANT_MESSAGE =
	"runInProcess/runInProcessAsync is not re-entrant: it patches process " +
	"globals, so a second concurrent call would capture the first call's " +
	"output. Run the " +
	"cases sequentially.";

/** @param {number} staleMs @returns {string[]} */
function takeOverStaleClaim(staleMs) {
	const existing = slot[CLAIM];
	if (!existing) return [];
	if (Date.now() - existing.startedAt < staleMs)
		throw new Error(REENTRANT_MESSAGE);
	slot[CLAIM] = null;
	return existing.restore();
}

/** @returns {Claim} */
function installClaim() {
	/** @type {Claim} */
	const claim = { startedAt: Date.now(), restore: () => [] };
	slot[CLAIM] = claim;
	return claim;
}

/** @param {Claim} claim */
const isHolder = (claim) => slot[CLAIM] === claim;

/** @param {Claim} claim @param {() => string[]} restore @returns {string[]} */
function releaseClaim(claim, restore) {
	if (!isHolder(claim)) return [];
	slot[CLAIM] = null;
	return restore();
}

function purgeCallerModules() {
	for (const key of Object.keys(require.cache)) {
		if (key === __filename) continue;
		if (!key.includes(NODE_MODULES)) delete require.cache[key];
	}
}

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

// guess, #2782
const SETTLE_MS = 200;

// measured 2nd loop turn on Node 24.18, #4108
const SETTLE_TURNS = 2;

function trackResources() {
	/** @type {Set<number>} */
	const owned = new Set();
	/** @type {Map<number, { type: string, resource: { hasRef?: () => boolean } }>} */
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

	const held = () =>
		[...live.values()].filter(
			({ resource }) =>
				typeof resource?.hasRef !== "function" || resource.hasRef(),
		);

	return {
		flags,
		async settle() {
			flags.attributing = false;
			const deadline = Date.now() + SETTLE_MS;
			let lateTurns = SETTLE_TURNS;
			while (held().length > 0 && (Date.now() < deadline || lateTurns-- > 0))
				await new Promise((resolve) => setImmediate(resolve));
		},
		/** @returns {string[]} */
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

/** @param {string} script @param {string[]} leaked */
function refuseLeaks(script, leaked) {
	if (leaked.length > 0)
		throw new Error(
			`runInProcess: ${script} returned without ending the process and left ref'd ` +
				`resources of its own open, which a real process would wait on: ${leaked.join(", ")}. ` +
				"Close, clear or unref them, await them, or end on process.exit.",
		);
}

/** @param {(text: string) => void} append */
const sink = (append) =>
	new Writable({
		write(chunk, enc, cb) {
			append(toText(chunk, enc));
			cb();
		},
	});

/** @type {(code: unknown) => number} */
const exitCodeOf = (code) => (((Number(code ?? 0) | 0) % 256) + 256) % 256;

/** @param {() => void} step @param {string[]} failures */
const attempt = (step, failures) => {
	try {
		step();
	} catch (e) {
		failures.push(caught(e).message || String(e));
	}
};

/**
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
 * @param {unknown} e
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
		write(`${(e instanceof Error && e.stack) || String(e)}\n`);
		end(1);
		return 1;
	}
	try {
		for (const fn of added) fn(e, "uncaughtException");
		return exitCodeOf(process.exitCode);
	} catch (inner) {
		if (inner instanceof ExitSignal) return inner.code;
		write(
			`${(inner instanceof Error && inner.stack) || caught(inner).message}\n`,
		);
		end(7);
		return 7;
	}
}

/**
 * @param {unknown} e
 * @param {CaptureState} state
 * @param {Map<string | symbol, Set<Function>>} listeners
 * @returns {number | null}
 */
function statusOfEscape(e, state, listeners) {
	if (e instanceof ExitSignal) return e.code;
	if (state.exited !== null) {
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
 * @property {string}   [cwd]
 * @property {Record<string, string | undefined>} [env]
 * @property {string | Buffer} [stdin]
 * @property {number} [staleMs]
 * @typedef {object} RunResult
 * @property {number} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {string[]} restoreFailures
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
 * @property {typeof fs.readSync} readSync
 * @property {typeof process.stdout.write} stdout
 * @property {typeof process.stderr.write} stderr
 * @property {Console} console
 * @property {NodeJS.ProcessEnv} env
 */

/**
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
		readSync: fs.readSync,
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
		process.argv = saved.argv;
		process.exit = saved.exit;
		process.uptime = saved.uptime;
		process.exitCode = saved.exitCode;
		process.mainModule = saved.mainModule;
		/** @type {any} */ (fs).writeSync = saved.writeSync;
		/** @type {any} */ (fs).readFileSync = saved.readFileSync;
		/** @type {any} */ (fs).readSync = saved.readSync;
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
 * @param {{ saved: Saved }} snapshot
 * @param {{ script: string, args: string[], options: RunOptions }} run
 * @param {CaptureState} state
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
			if (state.exited === null)
				state.exited = exitCodeOf(code ?? process.exitCode);
			throw new ExitSignal(state.exited);
		}
	);
	takeWrites((fd, text) => {
		if (state.exited !== null) return;
		if (fd === 1) state.stdout += text;
		else state.stderr += text;
	});

	const stdin = Buffer.from(options.stdin ?? "");
	/** @type {any} */ (fs).readFileSync = (
		/** @type {fs.PathOrFileDescriptor} */ target,
		/** @type {any} */ opts,
	) => {
		if (target !== 0) return saved.readFileSync(target, opts);
		const encoding = typeof opts === "string" ? opts : opts?.encoding;
		return encoding ? stdin.toString(encoding) : Buffer.from(stdin);
	};
	let consumed = 0;
	/** @type {any} */ (fs).readSync = (
		/** @type {number} */ target,
		/** @type {Buffer} */ buffer,
		/** @type {any[]} */ ...rest
	) => {
		if (target !== 0) return saved.readSync(target, buffer, ...rest);
		const [offset = 0, length = buffer.length - offset] =
			typeof rest[0] === "object" && rest[0] !== null
				? [rest[0].offset, rest[0].length]
				: rest;
		const n = stdin.copy(buffer, offset, consumed, consumed + length);
		consumed += n;
		return n;
	};

	globalThis.console = new Console({
		stdout: sink((text) => {
			if (state.exited === null) state.stdout += text;
		}),
		stderr: sink((text) => {
			if (state.exited === null) state.stderr += text;
		}),
	});
}

/** @param {string} script */
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
 * @property {any} entry
 * @property {Claim} claim
 * @property {ReturnType<typeof trackResources>} resources
 * @property {string[]} takeoverFailures
 */

/**
 * @param {string} script
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

/** @param {Call} call @returns {RunResult} */
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

/** @param {Call} call @param {unknown} e */
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
 * The async counterpart (mantahostels#1944): `lib/pick-next-testkit.ts` is the one file the sync
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

	if (!fs.readFileSync(script, "utf8").includes("require.main"))
		throw new Error(
			`runInProcessAsync: ${script} carries no "require.main" guard, so its ` +
				"entry point runs unconditionally at load — this seam cannot load " +
				"it safely. It needs the shape module.exports = { ..., main }; " +
				"if (require.main === module) { main().catch(...) }.",
		);

	const call = beginCall(script, args, options);
	try {
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
