/*
 * session-start-roster.js — every persisting SessionStart producer the repo's
 * hooks wire (lib/core-hooks.js's `readRunningHooks`), for replay-notify-reports.js's
 * own roster (mantahostels#2284).
 *
 * THE JOIN IS THE SHARED ONE. `buildCommandLine`/`allRegistrations` in
 * `lib/hook-wiring.ts` is the reader of record for what a hook entry runs
 * (mantahostels#2266), but that module is TypeScript and this is a plain-Node CLI
 * dependency — the same reason `lib/rule-emission.js` carries its own
 * `buildHookCommandLine` rather than requiring it (mantahostels#1932). Routed through THAT
 * function rather than a third hand-rolled join, so an exec-form entry
 * (`"command": "node", "args": ["scripts/x.js", "--notify"]`) is read the
 * same way everywhere in JS-land.
 *
 * THE SCRIPT PATH IS THE SHARED EXTRACTOR TOO. `rule-emission.js`'s
 * `WIRED_SCRIPT_RE` (mantahostels#2266) is already required for the join above; using it
 * here as well, rather than a bespoke pattern, is what keeps a hook wiring a
 * nested path (`scripts/lib/x.js`) or a dotted one (`check-foo.v2.js`) from
 * silently vanishing off the roster.
 */

const path = require("node:path");

const { readRunningHooks } = require("./core-hooks.js");
const { buildHookCommandLine, WIRED_SCRIPT_RE } = require("./rule-emission");
const { requiredGroup } = require("./regex-group.js");

/**
 * The hooks `repoRoot` runs, or null where a hooks file will not read or
 * parse — a registration fault is check-hook-liveness.js's to judge, not this
 * reader's. An absent one passes unsaid in every mode, as that checker's own
 * read of it does: an adopter may carry no settings file (#940, #2462).
 * @param {string} repoRoot
 * @returns {import("./core-hooks.js").Hooks | null}
 */
function readHooksOrNull(repoRoot) {
	try {
		return readRunningHooks(repoRoot, { quiet: true });
	} catch {
		return null;
	}
}

/**
 * Whether the repo's hooks could be read at all — the one thing
 * `readSessionStartRoster` below cannot say, since an unreadable file and a
 * genuinely empty roster both come back as `[]`.
 *
 * A CALLER THAT GATES ON ROSTER MEMBERSHIP HAS TO KNOW THE DIFFERENCE (mantahostels#2679).
 * @param {string} repoRoot
 * @returns {boolean}
 */
function hasReadableHooks(repoRoot) {
	return readHooksOrNull(repoRoot) !== null;
}

/**
 * The basename of a `.js` script under `scripts/` a hook's joined command
 * line wires — nested paths (`scripts/lib/x.js`) included, so one is never
 * silently dropped off the roster for living a directory deeper than today's
 * producers happen to — or `null` where it wires no `.js` under `scripts/`
 * at all (a `.sh` guard, say).
 * @param {string} line
 * @returns {string | null}
 */
function scriptsJsBasename(line) {
	for (const m of line.matchAll(WIRED_SCRIPT_RE)) {
		const rel = requiredGroup(m, 1, WIRED_SCRIPT_RE);
		if (rel.startsWith("scripts/") && rel.endsWith(".js"))
			return path.basename(rel, ".js");
	}
	return null;
}

/**
 * The one producer whose report key is not its script basename with
 * `check-` stripped (`check-cleared-trackers.js:156`). Exported so a second
 * caller of `readSessionStartRoster()` — `check-hook-liveness.js`'s census
 * included (mantahostels#2366) — reads it here rather than hand-copying it, which would
 * let the two silently drift.
 * @type {Record<string, string>}
 */
const KEY_OVERRIDES = { "check-cleared-trackers": "check-cleared-trackers" };

/**
 * Every checker the repo's hooks wire as a persisting SessionStart producer — `WFC_NOTIFY_PERSIST=1` and `--notify` both reachable
 * somewhere on the entry's command line, exec form's `args` included.
 *
 * @param {string} repoRoot
 * @param {{ keyOverrides?: Record<string, string>, self?: string }} [opts]
 *   `keyOverrides` maps a script basename to the key its report is filed
 *   under where that differs from the basename with `check-` stripped
 *   (`check-cleared-trackers.js:156`); `self` is excluded from the roster —
 *   the reader does not name itself as a producer.
 * @returns {Array<{ key: string, script: string }>}
 */
function readSessionStartRoster(
	repoRoot,
	{ keyOverrides = {}, self = "" } = {},
) {
	const matchers = readHooksOrNull(repoRoot)?.SessionStart;
	if (!Array.isArray(matchers)) return [];
	const roster = new Map();
	for (const matcher of matchers)
		for (const hook of matcher?.hooks ?? []) {
			const script = persistingScript(hook);
			if (!script) continue;
			const key = keyOverrides[script] ?? script.replace(/^check-/, "");
			if (key !== self) roster.set(key, `${script}.js`);
		}
	return [...roster].map(([key, script]) => ({ key, script }));
}

/**
 * The basename of the script a hook wires as a persisting producer, or `null`
 * where it wires none.
 * @param {{ command?: string, args?: unknown }} hook
 * @returns {string | null}
 */
function persistingScript(hook) {
	const line = buildHookCommandLine(hook);
	if (!line.includes("WFC_NOTIFY_PERSIST=1") || !line.includes("--notify"))
		return null;
	return scriptsJsBasename(line);
}

module.exports = { readSessionStartRoster, hasReadableHooks, KEY_OVERRIDES };
