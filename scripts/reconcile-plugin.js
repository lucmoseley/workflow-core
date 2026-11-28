#!/usr/bin/env node
// #5865

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
const {
	isDaemon,
	readProcCwd,
	sparePairs,
} = require("./lib/claude-sessions.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { hostRoot } = require("./lib/host-root.js");
const { relativeUnder } = require("./lib/is-under.js");
const { realKey } = require("./lib/deref.js");
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

const PS_BIN = () => process.env.WFC_PS || "ps";
const PS_LINE = /^(\d+)\s+(\S+)((?:\s.*)?)$/;

/**
 * @param {string} at
 * @returns {any}
 */
function readJsonSafe(at) {
	try {
		return JSON.parse(fs.readFileSync(at, "utf8"));
	} catch {
		return null;
	}
}

/** @returns {string[][]} */
function readClaudeSessions() {
	const out = execFileSync(PS_BIN(), ["-eo", "pid=,args="], {
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
	});
	/** @type {{ pid: string, argv0: string, args: string }[]} */
	const procs = [];
	for (const line of out.split("\n")) {
		const m = line.trim().match(PS_LINE);
		if (!m) continue;
		const argv0 = requiredGroup(m, 2, PS_LINE);
		procs.push({
			pid: requiredGroup(m, 1, PS_LINE),
			argv0,
			args: argv0 + requiredGroup(m, 3, PS_LINE),
		});
	}
	const pairs = sparePairs(procs, (pid) => readProcCwd(pid));
	const paired = new Set(pairs.flatMap((p) => p.pids));
	return [
		...pairs.filter((p) => !p.idle).map((p) => p.pids),
		...procs
			.filter(
				({ pid, argv0, args }) =>
					!paired.has(pid) && isClaudeArgv0(argv0) && !isDaemon(args),
			)
			.map(({ pid }) => [pid]),
	];
}

/**
 * @param {string} pid
 * @returns {string|null}
 */
function readConfigDirOf(pid) {
	const record = readEnvironVar(pid, "CLAUDE_CONFIG_DIR");
	if (!record.ok) return null;
	return configDirFrom(record.value);
}

/** @param {string} pid */
function readOwnPids(pid) {
	const seen = new Set([pid, ...readAncestorsOf(Number(pid)).map(String)]);
	if (process.env.CLAUDE_PID) seen.add(String(process.env.CLAUDE_PID));
	return seen;
}

/**
 * @param {(pid: string) => boolean} isApart
 * @param {string} [selfPid]
 * @returns {{count: number, pids: string[]}}
 */
function countNeighbours(isApart, selfPid = String(process.pid)) {
	const mine = readOwnPids(selfPid);
	/** @type {string[]} */
	const pids = [];
	for (const session of readClaudeSessions()) {
		if (session.some((pid) => mine.has(pid))) continue;
		if (!session.every(isApart)) pids.push(session.join("+"));
	}
	return { count: pids.length, pids };
}

/** @param {string} configDir */
function countConfigNeighbours(configDir) {
	const want = path.resolve(configDir);
	return countNeighbours((pid) => {
		const cfg = readConfigDirOf(pid);
		return cfg !== null && path.resolve(cfg) !== want;
	});
}

/** @param {string} root */
function countCheckoutNeighbours(root) {
	const real = realKey(root);
	return countNeighbours((pid) => {
		const cwd = readProcCwd(pid);
		if (cwd === null) return false;
		if (relativeUnder(real, cwd) === null) return true;
		for (let dir = cwd; dir !== real; dir = path.dirname(dir))
			if (fs.existsSync(path.join(dir, ".git"))) return true;
		return false;
	});
}

/**
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

	if (state.installAtPin && state.installRecord) {
		const here = countCheckoutNeighbours(root);
		if (here.count > 0)
			return defer(
				"migration walk",
				here,
				`working in ${root}`,
				"Its commit would land under their edits.",
			);
		say(
			`${plugin.name}: already installed at ${tag} — the shared supply is left where it is.`,
		);
		return walkFrom(state.installRecord.installPath);
	}

	const live = countConfigNeighbours(cfg);
	if (live.count > 0)
		return defer(
			"materialise",
			live,
			`live under ${cfg}`,
			"Rotating now would silence their guards mid-session.",
		);

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
			`${plugin.name}: materialising ${tag} FAILED — ${result.reason}. The consent stands, so the next session's exit retries. Finish by hand: ${fixByHand(result)}`,
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
	 * @param {string} what
	 * @param {{count: number, pids: string[]}} neighbours
	 * @param {string} where
	 * @param {string} why
	 * @returns {{action: string, lines: string[]}}
	 */
	function defer(what, { count, pids }, where, why) {
		say(
			`${plugin.name}: deferring the ${tag} ${what} — ${count} other Claude session(s) ${where} (pid ${pids.join(", ")}). ` +
				`${why} The consent stands; this is retried at the next session's exit.`,
		);
		return { action: "deferred", lines };
	}

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

const WARNING_ACTIONS = new Set([
	"failed",
	"unusable-source",
	"materialised-walk-broken",
]);

/** @type {Map<string, (pluginRoot: string) => string>} */
const QUIET_STOPS = new Map([
	[
		"no-plugin",
		(/** @type {string} */ pluginRoot) =>
			`no .claude-plugin/plugin.json under ${pluginRoot}. Run by hand, set CLAUDE_PLUGIN_ROOT to the installed plugin's root.`,
	],
	["no-pin", () => "this repo pins no git-sourced plugin to reconcile."],
	["declined", () => "this repo declined the pinned tag."],
	["no-consent", () => "no consent is pending for this repo's pinned tag."],
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
		const byHand = process.env.CLAUDE_PLUGIN_ROOT === undefined;
		const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? root;
		const { action } = reconcile({ root, pluginRoot, emit });
		const quiet = QUIET_STOPS.get(action);
		if (byHand && quiet)
			writeFd(2, `reconcile-plugin: stopped — ${quiet(pluginRoot)}\n`);
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
