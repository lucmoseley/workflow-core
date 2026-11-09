#!/usr/bin/env node
/*
 * check-retry-watchdog.js — says so where the in-turn retry watchdog that rides
 * out a dropped connection (#4815) is off: the live user settings' `env` block
 * lacks one of WATCHDOG_ENV's variables at its value, or the installed Claude
 * Code binary no longer holds one of their names. The usage-limit cap's name is
 * undocumented, in 2.1.319's env schema only, so a CLI update can drop it
 * silently, and then a seat at its plan limit waits for days instead of
 * stopping (#4682).
 *
 * Usage: node check-retry-watchdog.js [<settings.json>]
 *   (default ~/.claude/settings.json)
 *
 * A missing settings file or binary is SKIP, neither being the repo's
 * (mantahostels#155 (the checker family's exit-code and severity model)); a
 * settings fault found before the binary is missed still reports.
 *
 * WFC_CLAUDE_BIN injects the binary (§N7).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { binaryOf, readWindowsOf } = require("./lib/binary-read.js");
const { caught } = require("./lib/caught.js");
const { runCheck } = require("./lib/check");
const { claudeBin } = require("./lib/claude-bin.js");

/** The variables and values the live settings' `env` block carries (#4815). */
const WATCHDOG_ENV = {
	CLAUDE_CODE_RETRY_WATCHDOG: "1",
	CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: "1",
};

/**
 * Whether `file` holds `name` as a whole name: CLAUDE_CODE_RETRY_WATCHDOG is
 * a prefix of the others, so the byte after it must end the name.
 * @param {string} file
 * @param {string} name
 */
const holdsName = (file, name) =>
	readWindowsOf(file, name, name.length + 1).some(
		({ text, at }) => !/[A-Z0-9_]/.test(text[at + name.length] ?? ""),
	);

/**
 * The settings file's `env` block, or why it will not read.
 * @param {string} file
 * @returns {Record<string, unknown>|string}
 */
function readEnv(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")).env ?? {};
	} catch (e) {
		return `${file} could not be read: ${caught(e).message}`;
	}
}

runCheck({
	name: "retry-watchdog",
	usage: "node check-retry-watchdog.js [<settings.json>]",
	run(ctx) {
		/** @type {(tag: string, message: string, key: string) => void} */
		const fault = (tag, message, key) => {
			ctx.fail(tag, message, {}, key);
			ctx.say(message);
		};
		const settingsPath =
			ctx.args[0] ?? path.join(os.homedir(), ".claude", "settings.json");
		const env = readEnv(settingsPath);
		if (typeof env === "string") return ctx.skip(env);
		for (const [name, value] of Object.entries(WATCHDOG_ENV))
			if (env[name] !== value)
				fault(
					"SETTINGS-MISSING",
					`${settingsPath}'s env block has ${name}=${JSON.stringify(env[name] ?? null)}, not "${value}"; every session started since rides out no dropped connection in its turn`,
					`settings:${name}`,
				);
		const bin = claudeBin();
		const file = binaryOf(bin);
		if (file === null) {
			if (ctx.findings.length > 0) {
				ctx.say(`No \`${bin}\` binary was found; its names are unchecked.`);
				return { noun: "retry-watchdog fault(s)" };
			}
			return ctx.skip(`no \`${bin}\` binary was found`);
		}
		for (const name of Object.keys(WATCHDOG_ENV)) {
			let held;
			try {
				held = holdsName(file, name);
			} catch (e) {
				return ctx.skip(`${file} could not be read: ${caught(e).message}`);
			}
			if (!held)
				fault(
					"CLI-DROPPED",
					`${file} no longer holds ${name}; the installed Claude Code ignores it`,
					`cli:${name}`,
				);
		}
		return {
			okLine: `${settingsPath} and ${file} both carry ${Object.keys(WATCHDOG_ENV).join(" and ")}`,
			noun: "retry-watchdog fault(s)",
		};
	},
});
