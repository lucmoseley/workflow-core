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
 * Three surfaces read this file so the mapping is written once:
 *
 *   scripts/guard-dispatch-rewrite.sh  rewrites an `Agent` call's `model` field
 *   scripts/dispatch-sessions.sh       rewrites a launch's `--model`
 *   scripts/burn-mode.sh               writes Opus 5.5's effort into settings.json
 *
 * The state is one marker file per MACHINE, beside the settings files it is
 * the record for. `on` writes the effort it found into it, so `off` restores
 * what was there rather than assuming the standing default (mantahostels#130).
 *
 * The maps are exact-match on purpose. An `Agent` call takes only the four
 * bare aliases, so a suffix there is impossible; a launch spelling this table
 * does not know passes through unchanged rather than being guessed at, which
 * is the safe direction — an unmapped spelling costs what it always cost.
 */

const { machineMarkerPath } = require("./machine-marker.js");
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
 * ONE SWITCH PER MACHINE, not per checkout (workflow-core#127), because the settings.json
 * half it gates is machine-wide and the two must not differ in scope.
 *
 * NO MIGRATION SHIM: no marker existed at the old path anywhere on the
 * machine when this landed, and nothing here reads it now, so a leftover is
 * ignored. `~/.claude/statusline.sh` is the exception until workflow-core#131 lands — it
 * still reads the old path, and would badge `burn: on` off a leftover.
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
 * `scripts/guard-dispatch-rewrite.sh` composes it with the artefact transform
 * into one envelope, and calls it only while the marker exists.
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

module.exports = {
	EFFORT_MODEL,
	EFFORT_OFF,
	EFFORT_ON,
	remapModel,
};

/*
 * CLI mode.
 *
 *   launch <model>    prints the launch spelling burn mode substitutes
 *   marker            prints the marker's path; 2 where HOME is unset
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
		process.exit(2);
	} catch {
		process.exit(2);
	}
}
