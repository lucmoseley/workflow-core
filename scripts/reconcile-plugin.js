#!/usr/bin/env node
/*
 * reconcile-plugin.js — the SessionEnd actor for the adopter-upgrade
 * mechanism (#238, #247). The founder says yes in the chat, stops working,
 * and the next session he opens is running the version his repo says it
 * runs.
 *
 * Usage:
 *   node scripts/reconcile-plugin.js --session-end   the SessionEnd hook shape
 *
 * A PLUGIN-SCOPE `SessionEnd` ENTRY FIRES (#247, which also lists the
 * variables the hook's environment carries). An ABNORMAL exit fires nothing
 * (scripts/proving-session.ts, `killed()`), which this design survives:
 * nothing here records an accept as done, so a killed session costs a
 * deferral rather than a dropped upgrade.
 *
 * WHERE THE FOUNDER READS THE OUTCOME. Where SessionEnd's own stdout lands is
 * not established, so the record that is, is the run persisted through
 * `lib/notify-report.js` and shown by `npm run status`
 * (`replay-notify-reports.js --status`). A session start holds it back, since
 * no starting session acts on a deferral (#2038).
 *
 * THE HOOK'S 400s TIMEOUT (self-plugin/hooks/hooks.json) is three
 * `materialise-plugin.js` `DEFAULT_TIMEOUT_MS` calls (120s each) plus slack.
 * Raising that constant without raising this leaves the harness killing the
 * hook mid-install.
 *
 * THAT BUDGET DOES NOT BOUND EVERYTHING THIS FILE DOES (#249): a
 * successful materialise also runs the migration walk, which
 * `execSync`s each note's own `## Verify` shell command (arbitrary,
 * unbounded) and can call `gh label create` per label over the network —
 * and, on the half-way path, runs the whole walk TWICE (`walk-and-commit.js`'s
 * own header). A harness kill mid-walk leaves the tree dirty with no commit,
 * which then defers every later exit on the clean-tree precondition — with
 * the consent left standing (below). Whether the walk wants its own,
 * separate wall-clock ceiling is undecided; put it to the founder before
 * raising this file's own timeout to cover it.
 *
 * THE ORDER OF THE STOPS, cheapest and most decisive first:
 *   1. no pin, or a directory-sourced adopter  — nothing to reconcile
 *   2. a decline for this repo+tag             — the founder said no
 *   3. no pending consent for this repo+tag    — he was never asked, or the
 *      last materialise already consumed it.
 *   4. any other live Claude session under this config dir — defer. A
 *      mid-session plugin rotation must not silence a neighbour's guards any
 *      more than it may silence the founder's own.
 * Past them, an install already at the pin makes no `claude` call, so the
 * shared supply is not rotated again, and goes straight to the walk (#747).
 *
 * THE PIN IS NEVER WRITTEN. Nothing in this file opens the adopter's
 * `.claude/settings.json` for writing; the committed pin stays the record of
 * a decision somebody took (#238).
 *
 * THE SUPPLY IS NEVER RESTORED afterwards. The install is already extracted
 * to a version-keyed cache copy, so a neighbour's running plugin is
 * untouched; restoring costs a fetch and only moves which adopter reads
 * clean. Contention is REPORTED BY NAME before the rotation and the rotation
 * happens anyway — this adopter asked.
 *
 * A FAILED `update` LEAVES THE CONSENT STANDING even though
 * `materialisePlugin` reports `ok: true` for it. `update` is the one call
 * that re-pulls an already-installed plugin, so a failure there means the
 * rotated ref probably never reached the install — the gap is still open,
 * and the founder should be asked again rather than told it closed.
 *
 * A SUCCESSFUL MATERIALISE ALSO RUNS THE MIGRATION WALK (#249,
 * `lib/walk-and-commit.js`), which — on a clean adopter tree — CAN MAKE ONE
 * COMMIT IN THE FOUNDER'S OWN REPO, on this session's git identity, before he
 * has looked at it. Never pushed, never more than one commit, and skipped
 * (deferred to the next exit) rather than made against a tree that already
 * carries uncommitted work of his own.
 *
 * THE WALKER IS THE NEW RELEASE'S OWN (#682, ruled at #680). Two limits
 * accepted at #680: the first bump onto a release carrying this is still
 * walked by the previous reconciler, and the new walker runs under the OLD
 * install's hook timeout, which the harness read at session start — a
 * release raising that timeout gets it one bump late.
 *
 * IMPLICIT:  on every SessionEnd, where the founder's yes for this exact
 *            repo+tag is pending and no other Claude session is live under
 *            this config dir, runs `claude plugin marketplace add` →
 *            `install` → `update` against the adopter, rotating this
 *            machine's shared marketplace clone, unless the install is
 *            already at the pin — and, once that succeeds on a clean tree,
 *            walks and commits whatever migration notes the new version
 *            owes; whatever it says is also filed as its notify report.
 * JUSTIFIED: convenience — the committed pin is the consent token and the
 *            chat yes is the second half, so every write here only brings
 *            reality to the state the pin already declares (#238); the walk
 *            is the same argument one step further, since a migration note
 *            is itself pinned content the plugin ships (#249). What it buys
 *            is the founder not typing a five-step sequence nobody
 *            remembers, and not landing on a stale, mid-migration repo;
 *            nothing breaks if it never runs.
 * DEFEAT:    decline the tag (`node scripts/adopter-consent.js decline <repo>
 *            <tag>`), or never accept one — with no pending consent no
 *            `claude` runs, and nothing is installed, rotated, walked or
 *            written. (The four-record read still spawns `git` up to twice, to
 *            learn which ref the supply clone sits on.)
 *
 * FAILS OPEN AND QUIET on anything unexpected (#247), naming the error on
 * one line and stopping: a session END broken by this hook is worse than an
 * upgrade missed, and the consent survives either way, so the next exit
 * retries it.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const {
	isDeclined,
	readPendingConsent,
	clearPendingConsent,
} = require("./lib/adopter-consent.js");
const { parseOrCode } = require("./lib/cli-args");
const { scriptPath } = require("./lib/script-path.js");
const { isClaudeArgv0 } = require("./lib/claude-argv0.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { hostRoot } = require("./lib/host-root.js");
const { fixByHand, materialisePlugin } = require("./lib/materialise-plugin.js");
const { writeReport } = require("./lib/notify-report.js");
const {
	findInstallRecord,
	findPin,
	readPluginState,
	resolveConfigDir,
} = require("./lib/plugin-state.js");
const { walkAndCommit } = require("./lib/walk-and-commit.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { caught } = require("./lib/caught.js");
const { readAncestorsOf } = require("./lib/proc-stat.js");
const { readEnvironVar } = require("./lib/proc-environ.js");
const { configDirFrom } = require("./lib/config-dir.js");

const BUNDLED_WALKER = require.resolve("./lib/walk-and-commit.js");

/* Overridable so the live-session count can be tested against a stub `ps` and
 * a fixture /proc tree — WFC_PS here, WFC_PROC in lib/proc-root.js. */
const PS_BIN = () => process.env.WFC_PS || "ps";
/** A `ps -eo pid=,args=` line: the pid, then argv[0]. */
const PS_LINE = /^(\d+)\s+(\S+)/;

/** @param {string} at @returns {any} a raw JSON parse, or null */
function readJsonSafe(at) {
	try {
		return JSON.parse(fs.readFileSync(at, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Every pid whose argv[0] is a Claude process's. `ps -eo pid=,args=` rather
 * than `comm=`, for the reason `lib/claude-argv0.js` states.
 * @returns {string[]}
 */
function readClaudePids() {
	const out = execFileSync(PS_BIN(), ["-eo", "pid=,args="], {
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
	});
	/** @type {string[]} */
	const pids = [];
	for (const line of out.split("\n")) {
		const m = line.trim().match(PS_LINE);
		if (!m) continue;
		if (isClaudeArgv0(requiredGroup(m, 2, PS_LINE)))
			pids.push(requiredGroup(m, 1, PS_LINE));
	}
	return pids;
}

/**
 * The config dir a pid is running under, from its own environ. Null where
 * that cannot be read — another user's process, or one that exited between
 * the `ps` and this read — which the caller counts as a neighbour rather
 * than assuming it is somebody else's: deferring costs one session's delay,
 * and rotating under a live neighbour costs that neighbour its guards.
 * @param {string} pid
 * @returns {string|null}
 */
function readConfigDirOf(pid) {
	const record = readEnvironVar(pid, "CLAUDE_CONFIG_DIR");
	if (!record.ok) return null;
	return configDirFrom(record.value);
}

/**
 * This process and every ancestor of it.
 *
 * A SessionEnd hook is a CHILD of the session that is ending, and that
 * session's own `claude` process is still alive while the hook runs — so
 * without this the actor would count itself as the neighbour that stops it,
 * and no upgrade would ever happen. `CLAUDE_PID` is folded in as well — the
 * ending session's own pid, exported into the hook's environment — so a
 * launcher shape that puts the session outside this process's ancestry is
 * still excluded.
 *
 * RESIDUAL: a session that double-forks away from both is counted as a
 * neighbour, and the actor then defers forever rather than acting wrongly.
 * @param {string} pid
 */
function readOwnPids(pid) {
	const seen = new Set([pid, ...readAncestorsOf(Number(pid)).map(String)]);
	if (process.env.CLAUDE_PID) seen.add(String(process.env.CLAUDE_PID));
	return seen;
}

/**
 * Claude sessions running alongside this one under the same config dir.
 * @param {{configDir: string, selfPid?: string}} at
 * @returns {{count: number, pids: string[]}}
 */
function countLiveNeighbours({ configDir, selfPid = String(process.pid) }) {
	const mine = readOwnPids(selfPid);
	const want = path.resolve(configDir);
	const pids = [];
	for (const pid of readClaudePids()) {
		if (mine.has(pid)) continue;
		const cfg = readConfigDirOf(pid);
		if (cfg !== null && path.resolve(cfg) !== want) continue;
		pids.push(pid);
	}
	return { count: pids.length, pids };
}

/**
 * The migration walker the fresh install ships, loaded in this process (#682).
 * Node's module cache keys on the absolute path, so everything that walker
 * requires — `./upgrade-walk.js` and its siblings — loads from the same install.
 * Falls back to this file's own bundled walker where the install carries
 * none, as a release before #249 does not, or where loading it throws.
 *
 * Residual: a rollback onto a release between #679 and #682 loads that
 * release's walker, which takes `measureCore` rather than `claudeBin`, so
 * the core's context-cost row is not seeded on that walk, and nothing says so.
 * @param {string} installPath
 * @returns {{walk: typeof walkAndCommit, from: string, fallback?: string}}
 */
function loadWalker(installPath) {
	const at = path.join(installPath, "scripts", "lib", "walk-and-commit.js");
	if (!fs.existsSync(at))
		return { walk: walkAndCommit, from: BUNDLED_WALKER, fallback: `no ${at}` };
	try {
		const { walkAndCommit: walk } = require(at);
		if (typeof walk !== "function")
			throw new Error("it exports no walkAndCommit function");
		return { walk, from: at };
	} catch (err) {
		return {
			walk: walkAndCommit,
			from: BUNDLED_WALKER,
			fallback: `loading ${at} threw: ${caught(err).message.split("\n")[0]}`,
		};
	}
}

/**
 * The whole actor; `main` is its one caller, and the tests drive it through
 * `main` (#1369). Every outside reading it makes is steered by the
 * environment — the config dir and the consent store's cross-config-dir scan
 * by CLAUDE_CONFIG_DIR and WFC_CLAUDE_CONFIG_A/B/C, the live count by
 * WFC_PS/WFC_PROC, the `claude` it spawns by WFC_CLAUDE_BIN — so a test points
 * each at a fixture and never touches the real registry (#238 user story 48).
 *
 * `emit` receives each line THE MOMENT IT IS COMPOSED rather than at the
 * return: the contention report is written before the rotation it describes,
 * and a materialise that then hangs to the hook's timeout cannot swallow it.
 *
 * The migration walk (#249) runs only after a materialise that actually
 * succeeds, or with none where the install is already at the pin (#747) —
 * never on a failed or contended one, and never from or against
 * `pluginRoot`, which is this session's OLD running bytes. Both the walker
 * code and the notes it walks come from the install at the pin — re-read
 * through `findInstallRecord` once `materialisePlugin` has returned ok, or the
 * state read's own record where it was already there (#682, `loadWalker`).
 * Against the old bytes `upgrade()` would read the OLD
 * `plugin.json` and note set and hit exit code 3 (pin ahead of installed) on
 * every run; with only the old walker code, a new release's notes would be
 * walked by the previous release's rules. Only plain data crosses that
 * version seam: the walker builds its own helpers, `measureCore` among them.
 * @param {{
 *   root: string,
 *   pluginRoot: string,
 *   emit: (line: string) => void,
 * }} at
 * @returns {{action: string, lines: string[]}}
 */
function reconcile({ root, pluginRoot, emit }) {
	const bin = claudeBin();
	/** @type {string[]} */
	const lines = [];
	/** @param {string} line */
	const say = (line) => {
		lines.push(line);
		emit(line);
	};
	const plugin = readJsonSafe(
		path.join(pluginRoot, ".claude-plugin", "plugin.json"),
	);
	if (!plugin?.name) return { action: "no-plugin", lines };

	const cfg = resolveConfigDir();
	const state = readPluginState({ root, pluginRoot, configDir: cfg });
	if (!state.pin) return { action: "no-pin", lines };
	const tag = state.pin.ref;

	if (isDeclined(root, tag)) return { action: "declined", lines };
	if (!readPendingConsent(root, tag)) return { action: "no-consent", lines };

	const live = countLiveNeighbours({ configDir: cfg });
	if (live.count > 0) {
		say(
			`${plugin.name}: deferring the ${tag} materialise — ${live.count} other Claude session(s) live under ${cfg} (pid ${live.pids.join(", ")}). ` +
				"Rotating now would silence their guards mid-session. The consent stands; this is retried at the next session's exit.",
		);
		return { action: "deferred", lines };
	}

	/* The install already matches the pin, so the supply is not this
	 * adopter's to move: rotating it again only takes it off another
	 * adopter's tag, and the next of those turns it back (#738). */
	if (state.installAtPin && state.installRecord) {
		say(
			`${plugin.name}: already installed at ${tag} — the shared supply is left where it is.`,
		);
		return walkFrom(state.installRecord.installPath);
	}

	/* The pin's url, which `readPluginState` does not carry back. A directory
	 * source never reaches here — `state.pin` is null for one — so the url is
	 * the only spelling to handle, and `#<ref>` is the CLI's own syntax for a
	 * non-default tag on it, the same spelling `init-adopter.js` builds (#75). */
	const { source } = findPin(
		readJsonSafe(path.join(root, ".claude", "settings.json")) ?? {},
		plugin.name,
	);
	if (!source?.url) {
		say(
			`${plugin.name}: the pin for ${tag} names no url, so there is nothing to materialise from. The consent stands.`,
		);
		return { action: "unusable-source", lines };
	}
	const addSource = `${source.url}#${tag}`;
	const pluginId = `${plugin.name}@${state.pin.marketplace}`;

	if (state.contention)
		say(
			`${plugin.name}: the supply at ${state.supply.dir} sits on ${state.contention}, not this repo's pin ${tag} — ` +
				"rotating it moves that ref for every adopter under this config dir. Rotating anyway: this repo asked.",
		);

	const result = materialisePlugin({
		root,
		claudeBin: bin,
		addSource,
		pluginId,
		configDir: cfg,
	});
	if (!result.ok) {
		say(
			`${plugin.name}: materialising ${tag} FAILED — ${result.reason}. The consent stands, so the next session asks again. Finish by hand: ${fixByHand(result)}`,
		);
		return { action: "failed", lines };
	}
	if (result.updateFailed) {
		say(
			`${plugin.name}: ${tag} installed but the update after it FAILED — ${result.updateFailed}. ` +
				`That is the call which re-pulls an already-installed plugin, so the gap is probably still open: the consent stands. Finish by hand: ${result.pluginUpdate.join(" ")}`,
		);
		return { action: "failed", lines };
	}

	say(`${plugin.name}: materialised ${tag} at session end.`);

	/* THE CONSENT IS CLEARED ONLY ONCE THE WALK ALSO LANDS (`walkFrom`) —
	 * never here. Once the gap closes, `check-plugin-gap.js`'s "third
	 * reading" (materialised but not yet live: nothing owed) goes silent, so
	 * a cleared consent is the only signal left that would make a later
	 * SessionEnd retry a walk this one deferred or broke on.
	 *
	 * A PERMANENTLY REFUSING COMMIT (walk-and-commit.js condition 4) retries
	 * EVERY SESSION END: hook refuses -> tree left dirty -> consent stands ->
	 * next exit walks again, hits condition 1 on the still-dirty tree and
	 * defers. It stops only once a human clears the tree by hand; nothing
	 * here throttles the retry. */

	/* The fresh install's own root, never `pluginRoot` — see this function's
	 * JSDoc. `state.pin.marketplace` is this same materialise's own target,
	 * so a miss here (no install record yet, an unexpected cache layout) is
	 * reported and the walk simply skipped this run rather than guessed at. */
	const record = findInstallRecord(
		path.join(cfg, "plugins"),
		plugin.name,
		state.pin.marketplace,
		root,
	);
	if (!record?.installPath) {
		say(
			`${plugin.name}: no fresh install record was found to walk from — the migration walk is skipped this run. The consent stands, so the next exit retries.`,
		);
		return { action: "materialised-walk-broken", lines };
	}
	return walkFrom(record.installPath);

	/**
	 * @param {string} installPath
	 * @returns {{action: string, lines: string[]}}
	 */
	function walkFrom(installPath) {
		const walker = loadWalker(installPath);
		say(
			walker.fallback
				? `${plugin.name}: migration walk by this session's bundled walker, ${walker.from} — the fresh install's could not be used (${walker.fallback}).`
				: `${plugin.name}: migration walk by the install's own walker, ${walker.from}.`,
		);
		const walked = walker.walk({
			root,
			pluginRoot: installPath,
			out: say,
			configDir: cfg,
			claudeBin: bin,
		});
		if (walked.action !== "committed" && walked.action !== "up-to-date") {
			say(
				`${plugin.name}: the consent stands until the migration walk lands, so the next session's exit retries it too.`,
			);
			return {
				action:
					walked.action === "broken"
						? "materialised-walk-broken"
						: "materialised",
				lines,
			};
		}

		clearPendingConsent(root, tag);
		say(`${plugin.name}: the next session in ${root} runs ${tag}.`);
		return { action: "materialised", lines };
	}
}

/** Outcomes that mean the founder is owed a look, not merely informed. */
const WARNING_ACTIONS = new Set([
	"failed",
	"unusable-source",
	"materialised-walk-broken",
]);

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrCode(argv, {
		usage: `usage: node ${scriptPath("reconcile-plugin.js")} --session-end`,
		flags: { "--session-end": "boolean" },
	});
	if (typeof parsed === "number") return parsed;
	const { flags } = parsed;
	/** @type {string[]} */
	const said = [];
	const emit = (/** @type {string} */ line) => {
		said.push(line);
		writeFd(1, `${line}\n`);
	};
	try {
		if (flags["--session-end"] !== true) return 0;
		const root = hostRoot();
		const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? root;
		const { action } = reconcile({ root, pluginRoot, emit });
		if (said.length > 0)
			writeReport("reconcile-plugin", {
				outcome: WARNING_ACTIONS.has(action) ? "WARN" : "OK",
				text: said.join("\n"),
			});
		return 0;
	} catch (err) {
		emit(
			`reconcile-plugin: stopped without materialising — ${caught(err).message}. The consent stands, so the next session's exit retries.`,
		);
		writeReport("reconcile-plugin", {
			outcome: "BROKEN",
			text: said.join("\n"),
		});
		return 0;
	}
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
