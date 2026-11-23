const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INJECTOR_SCRIPT = "inject-tracker-docs.js";

const PROBE_SESSION_ID = "check-context-budget-probe-00000000";

const INJECTOR_ENTRY =
	process.env.WFC_INJECTOR_ENTRY || path.join(__dirname, "..", INJECTOR_SCRIPT);

/** @returns {number} */
function injectorTimeoutMs() {
	const { flattenHooks, pluginHooksFile } = require("./core-hooks.js");
	const { hooks = {} } = JSON.parse(fs.readFileSync(pluginHooksFile(), "utf8"));
	const seconds = flattenHooks(hooks)
		.filter((h) => h.command?.includes(INJECTOR_SCRIPT))
		.map((h) => h.timeout ?? 0);
	if (seconds.length === 0)
		throw new Error(`hooks/hooks.json registers no ${INJECTOR_SCRIPT}`);
	return Math.min(...seconds) * 1000;
}

/**
 * @typedef {{ command: string, chars: number | null, error?: string }} RenderedPayload
 */

/**
 * @param {string[]} commands
 * @param {string} root
 * @returns {RenderedPayload[]}
 */
function renderedPayloads(commands, root) {
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
		const timeout = injectorTimeoutMs();
		return commands.map((command) => render(root, env, command, timeout));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {string} command
 * @param {number} timeout
 * @returns {RenderedPayload}
 */
function render(root, env, command, timeout) {
	const input = JSON.stringify({
		prompt: `/${command} 1`,
		hook_event_name: "UserPromptSubmit",
		session_id: PROBE_SESSION_ID,
		cwd: root,
	});
	const r = spawnSync(process.execPath, [INJECTOR_ENTRY], {
		input,
		env,
		cwd: root,
		encoding: "utf8",
		timeout,
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
		return { command, chars: null, error: "output is not JSON" };
	}
}

module.exports = {
	INJECTOR_ENTRY,
	PROBE_SESSION_ID,
	renderedPayloads,
};
