/*
 * rendered-injection.js — the tracker payload each command really hands a
 * HOST that carries no injector of its own, by running the core's (#1956).
 *
 * check-context-budget.js's INJECTION figure is a parsed union of every string
 * the injector can emit, the core's own ratchet. For an adopter it is the wrong
 * number twice over: no command emits the whole union, and the payload an
 * adopter gets is rendered against its own config, with the core's paths made
 * absolute (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/shared-layer-admission.md Finding 2).
 *
 * EXECUTED, which the union deliberately is not: the union is read off a
 * revision under `--against`, and this runs the core copy on disk. In a plugin
 * install that is the pinned cache; in a checkout it is the working tree, a
 * neighbour's half-saved edit included, and not the adopter's pinned release —
 * so the caller names the script it ran.
 *
 * Measured in UTF-16 units, the harness's and scripts/check-injector-margin.sh's
 * unit, so a figure here compares with that gate's. Its probe is this one's;
 * keep the two in step.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROBE_SESSION_ID = "check-context-budget-probe-00000000";

/* The injector's own hook timeout is 10 s (hooks/hooks.json). */
const RUN_TIMEOUT_MS = 10_000;

/**
 * @typedef {{ command: string, chars: number | null, error?: string }} RenderedPayload
 */

/**
 * Each command's payload, in UTF-16 units, as `script` renders it for `root`.
 * @param {string} script the injector's path
 * @param {string[]} commands its `COMMANDS` array
 * @param {string} root the host it renders for
 * @returns {RenderedPayload[]}
 */
function renderedPayloads(script, commands, root) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-render-"));
	try {
		const gh = path.join(tmp, "gh");
		fs.writeFileSync(gh, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		/** @type {NodeJS.ProcessEnv} */
		const env = {
			...process.env,
			CLAUDE_PROJECT_DIR: root,
			TMPDIR: tmp,
			WFC_GH: gh,
		};
		delete env.CLAUDE_CODE_SESSION_ID;
		return commands.map((command) => render(script, root, env, command));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * @param {string} script
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {string} command
 * @returns {RenderedPayload}
 */
function render(script, root, env, command) {
	const input = JSON.stringify({
		prompt: `/${command} 1`,
		hook_event_name: "UserPromptSubmit",
		session_id: PROBE_SESSION_ID,
		cwd: root,
	});
	const r = spawnSync("bash", [script], {
		input,
		env,
		cwd: root,
		encoding: "utf8",
		timeout: RUN_TIMEOUT_MS,
	});
	if (r.error || r.status !== 0)
		return {
			command,
			chars: null,
			error: r.error ? String(r.error) : `exit ${r.status}`,
		};
	try {
		const context = JSON.parse(r.stdout).hookSpecificOutput?.additionalContext;
		if (typeof context !== "string")
			return { command, chars: null, error: "no additionalContext" };
		return { command, chars: context.length };
	} catch {
		/* Unparseable stdout is reported as this command's error row (#1956). */
		return { command, chars: null, error: "output is not JSON" };
	}
}

module.exports = { renderedPayloads };
