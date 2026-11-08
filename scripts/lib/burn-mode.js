/*
 * burn-mode.js — the one table burn mode remaps models through, and the one
 * resolver for its marker.
 *
 * Burn mode (`scripts/burn-mode.sh on`) spends allowance on purpose: Sonnet
 * work runs on Opus 5.5, and Opus 5.5 runs at high effort rather than medium.
 * Opus is not moved up to Fable (workflow-core#355; the reason is in
 * `docs/effort-guide.md` §Burn mode). The code reviewer is left alone: its
 * dispatch names `opus` and its agent definition's `effort:` outranks the
 * per-model effort this writes (workflow-core#363).
 * These read this file so the mapping and the plans are written once:
 *
 *   scripts/lib/dispatch-rewrite.js    rewrites an `Agent` call's `model` field
 *   scripts/dispatch-sessions.sh       rewrites a launch's `--model`
 *   scripts/burn-mode.sh               writes Opus 5.5's effort into the plans'
 *                                      settings files, listed by `plans` below
 *   scripts/lib/dispatch-gates.js      reads the marker's path
 *   scripts/refill-loop.js status      readBurnState, for the refill panel
 *
 * The state is one marker file per MACHINE, beside the settings files it is
 * the record for. `on` writes the effort it found into it, so `off` restores
 * what was there rather than assuming the standing default (mantahostels#130).
 *
 * The maps are exact-match on purpose. An `Agent` call takes only the four
 * bare aliases, so a suffix there is impossible; a launch spelling this table
 * does not know passes through unchanged rather than being guessed at.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { machineMarkerPath } = require("./machine-marker.js");
const { readPlanDirs } = require("./plan-dirs.js");
const { scriptPath } = require("./script-path.js");
const { writeFd } = require("./write-fd.js");

/** The marker file's name, under `~/.claude`. */
const MARKER = ".burn-mode";

/**
 * What a Sonnet launch becomes. The full id with the 1M suffix, because the
 * `opus` alias moved under this repo once already (workflow-core#353).
 */
const LAUNCH_OPUS = "claude-opus-5-5[1m]";

/**
 * The effort half: the `modelSettings` key it writes under, because Opus 5.5
 * ignores a top-level `effortLevel` (`docs/effort-guide.md` §Effort), and the
 * level on / off. OFF is the guide's standing default, used only where `on`
 * recorded nothing.
 */
const EFFORT_MODEL = "claude-opus-5-5";
const EFFORT_ON = "high";
const EFFORT_OFF = "medium";

/** `Agent` call aliases: the field takes the bare four and nothing else. */
const DISPATCH = new Map([["sonnet", "opus"]]);

/**
 * Launch spellings `scripts/dispatch-sessions.sh` may be handed. Opus
 * spellings are absent: they stay Opus, and the effort they run at comes from
 * settings.json, which burn mode has already set.
 */
const LAUNCH = new Map([
	["sonnet", LAUNCH_OPUS],
	["sonnet[1m]", LAUNCH_OPUS],
	["claude-sonnet-5", LAUNCH_OPUS],
	["claude-sonnet-5[1m]", LAUNCH_OPUS],
	["claude-sonnet-5-5", LAUNCH_OPUS],
	["claude-sonnet-5-5[1m]", LAUNCH_OPUS],
	["opusplan", LAUNCH_OPUS],
	["opusplan[1m]", LAUNCH_OPUS],
]);

/**
 * Where the marker lives. `WFC_BURN_MARKER` overrides, so a test never
 * touches the machine's real switch; otherwise `~/.claude/.burn-mode`.
 *
 * ONE SWITCH PER MACHINE, not per checkout (workflow-core#127).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 * @throws as lib/machine-marker.js's machineMarkerPath
 */
function markerPath(env = process.env) {
	return env.WFC_BURN_MARKER || machineMarkerPath(MARKER, env);
}

/**
 * @param {string} model an `Agent` call's `model` value
 * @returns {string} the burn-mode model, or the same string where none applies
 */
function remapDispatch(model) {
	return DISPATCH.get(model) ?? model;
}

/**
 * @param {string} model a launch spelling
 * @returns {string}
 */
function remapLaunch(model) {
	return LAUNCH.get(model) ?? model;
}

/**
 * @param {unknown} value
 * @returns {string} the trimmed string, or "" for anything that is not one
 */
function trimmed(value) {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Burn mode's transform over one `Agent` call's input: the call with its model
 * moved, and what the session is told, or null where burn mode has nothing to
 * change — no model named (the session's model is inherited), a fork (which
 * ignores the field), or a model burn mode does not move. Every other field is
 * carried through untouched, `updatedInput` replacing the whole input.
 *
 * lib/dispatch-rewrite.js composes it with the artefact transform into one
 * rewrite, and calls it only while the marker exists.
 *
 * @param {unknown} input the tool_input object
 * @returns {null | {input: Record<string, unknown>, note: string}}
 */
function remapModel(input) {
	if (input === null || typeof input !== "object") return null;
	const call = /** @type {Record<string, unknown>} */ (input);
	if (trimmed(call.subagent_type) === "fork") return null;
	const from = trimmed(call.model);
	if (!from) return null;
	const to = remapDispatch(from);
	if (to === from) return null;
	return {
		input: { ...call, model: to },
		note: `Burn mode moved this dispatch from \`${from}\` to \`${to}\` (scripts/burn-mode.sh; \`${scriptPath("burn-mode.sh")} off\` ends it).`,
	};
}

/**
 * The plans' settings files, one entry per real file (workflow-core#187), as the founder
 * names them, and those present that resolve to nothing, skipped: a dangling
 * or looping symlink, or one that will not read.
 * @param {string} home
 * @returns {{files: Map<string, string>, dangling: string[]}} `files`, real path to name
 */
function readPlanFiles(home) {
	const homeReal = fs.realpathSync(home);
	/** @type {Map<string, string>} */
	const files = new Map();
	/** @type {string[]} */
	const dangling = [];
	for (const dir of readPlanDirs(home)) {
		const file = path.join(dir, "settings.json");
		try {
			const real = fs.realpathSync(file);
			files.set(real, path.relative(homeReal, real));
		} catch {
			if (isPresent(file)) dangling.push(file);
		}
	}
	return { files, dangling };
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
 * Whether one plan's effort disagrees with the switch: on, any effort but the
 * burn one; off, the burn one. A file that will not parse disagrees with both.
 * @param {string} file
 * @param {boolean} on
 */
function isPlanDisagreeing(file, on) {
	let effort;
	try {
		effort = JSON.parse(fs.readFileSync(file, "utf8"))?.modelSettings?.[
			EFFORT_MODEL
		]?.effortLevel;
	} catch {
		// workflow-core#3877: the script's own jq fails on this file too, so it is no plan in step.
		return true;
	}
	return (effort === EFFORT_ON) !== on;
}

/**
 * Burn mode as the script left it, read off the machine so every reader sees a
 * half-flip however long ago it happened. `on` is null, with `error`, where the
 * marker cannot be placed or the plans cannot be listed.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{on: boolean|null, disagreeing: string[], error: string|null}}
 */
function readBurnState(env = process.env) {
	try {
		const on = fs.existsSync(markerPath(env));
		const disagreeing = [...readPlanFiles(env.HOME ?? "").files]
			.filter(([file]) => isPlanDisagreeing(file, on))
			.map(([, name]) => name);
		return { on, disagreeing, error: null };
	} catch (err) {
		return { on: null, disagreeing: [], error: caught(err).message };
	}
}

module.exports = {
	EFFORT_MODEL,
	EFFORT_OFF,
	EFFORT_ON,
	markerPath,
	readBurnState,
	remapModel,
};

/*
 * CLI mode.
 *
 *   launch <model>    prints the launch spelling burn mode substitutes
 *   marker            prints the marker's path; 2 where HOME is unset
 *   plans [--quiet]   prints each plan's settings file, real and NUL-ended,
 *                     warning of each that resolves to nothing unless quiet;
 *                     2 where HOME will not list
 *
 * stdout is always a pipe here, so it is written synchronously before the
 * exit — process.stdout.write can be cut off by process.exit on a pipe.
 */
if (require.main === module) {
	const [mode, arg] = process.argv.slice(2);
	const say = (/** @type {string} */ s) => writeFd(1, `${s}\n`);
	try {
		if (mode === "launch" && arg !== undefined) {
			say(remapLaunch(arg));
			process.exit(0);
		}
		if (mode === "marker") {
			say(markerPath());
			process.exit(0);
		}
		if (mode === "plans") {
			const home = process.env.HOME ?? "";
			let listed;
			try {
				listed = readPlanFiles(home);
			} catch (err) {
				writeFd(
					2,
					`burn-mode: cannot list the plans under ${home}: ${caught(err).message}\n`,
				);
				process.exit(2);
			}
			const { files, dangling } = listed;
			for (const file of arg === "--quiet" ? [] : dangling)
				writeFd(
					2,
					`warning: skipping ${path.relative(home, file)} — it resolves to nothing\n`,
				);
			writeFd(1, [...files.keys()].map((f) => `${f}\0`).join(""));
			process.exit(0);
		}
		process.exit(2);
	} catch {
		process.exit(2);
	}
}
