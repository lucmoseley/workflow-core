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
 *   (default the seat's settings.json, lib/config-dir.js)
 *
 * A missing settings file or binary leaves its half unchecked, neither being
 * the repo's (mantahostels#155 (the checker family's exit-code and severity
 * model)): the other half is still judged, and the check SKIPs only where
 * neither could be. A settings file that will not parse is a fault.
 *
 * WFC_CLAUDE_BIN injects the binary (§N7).
 */

const path = require("node:path");
const { binaryOf, readWindowsOf } = require("./lib/binary-read.js");
const { caught } = require("./lib/caught.js");
const { readText } = require("./lib/file-read.js");
const { runCheck } = require("./lib/check");
const { claudeBin } = require("./lib/claude-bin.js");
const { configDir } = require("./lib/config-dir.js");

/* The cap's "1" (ms): a plan-limit 429 asks a longer wait than that, so it
 * fails at once, as with the watchdog off (#4682, read from the 2.1.319
 * bundle). */
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
const hasWholeName = (file, name) =>
	readWindowsOf(file, name, name.length + 1).some(
		({ text, at }) => !/[A-Z0-9_]/.test(text[at + name.length] ?? ""),
	);

/**
 * The settings file's `env` block; `{absent}` where there is no file, `{bad}`
 * where it will not read or parse.
 * @param {string} file
 * @returns {{env: Record<string, unknown>}|{absent: string}|{bad: string}}
 */
function readEnv(file) {
	const read = readText(file);
	if (read.state === "absent") return { absent: `${file} is missing` };
	if (read.state === "unreadable")
		return { bad: `${file} could not be read: ${read.message}` };
	try {
		return { env: JSON.parse(read.data).env ?? {} };
	} catch (e) {
		return { bad: `${file} does not parse: ${caught(e).message}` };
	}
}

/**
 * @typedef {{tag: string, message: string, key: string}} Fault
 */

/**
 * The faults of the settings `read` at `file`: one where it will not read,
 * else one per WATCHDOG_ENV variable its env block lacks at its value.
 * @param {string} file
 * @param {{env: Record<string, unknown>}|{bad: string}} read
 * @returns {Fault[]}
 */
function settingsFaults(file, read) {
	if ("bad" in read)
		return [
			{
				tag: "SETTINGS-UNREAD",
				message: `${read.bad}; fix the file, then add ${Object.keys(WATCHDOG_ENV).join(" and ")} to its env block at "1"`,
				key: "settings:unread",
			},
		];
	return Object.entries(WATCHDOG_ENV).flatMap(([name, value]) =>
		read.env[name] === value
			? []
			: [
					{
						tag: "SETTINGS-MISSING",
						message: `${file}'s env block has ${name}=${JSON.stringify(read.env[name] ?? null)}, not "${value}"; every session started since rides out no dropped connection in its turn: set it to "${value}" there, as docs/claude-user-settings.md's block does`,
						key: `settings:${name}`,
					},
				],
	);
}

/**
 * The faults of the binary `file`: one per WATCHDOG_ENV name it no longer
 * holds. Throws where the file will not read.
 * @param {string} file
 * @returns {Fault[]}
 */
const binaryFaults = (file) =>
	Object.keys(WATCHDOG_ENV).flatMap((name) =>
		hasWholeName(file, name)
			? []
			: [
					{
						tag: "CLI-DROPPED",
						message: `${file} no longer holds ${name}; the installed Claude Code ignores it: find the variable that replaced it in the CLI's changelog, then update WATCHDOG_ENV, the live settings and docs/claude-user-settings.md together`,
						key: `cli:${name}`,
					},
				],
	);

runCheck({
	name: "retry-watchdog",
	usage: "node check-retry-watchdog.js [<settings.json>]",
	run(ctx) {
		/** @param {Fault[]} faults */
		const report = (faults) => {
			for (const { tag, message, key } of faults) {
				ctx.fail(tag, message, {}, key);
				ctx.say(message);
			}
		};
		const settingsPath = ctx.args[0] ?? path.join(configDir(), "settings.json");
		const read = readEnv(settingsPath);
		/** Why each half went unchecked. @type {string[]} */
		const unchecked = [];
		if ("absent" in read) unchecked.push(read.absent);
		else report(settingsFaults(settingsPath, read));
		const bin = claudeBin();
		const file = binaryOf(bin);
		if (file === null) unchecked.push(`no \`${bin}\` binary was found`);
		else {
			try {
				report(binaryFaults(file));
			} catch (e) {
				unchecked.push(`${file} could not be read: ${caught(e).message}`);
			}
		}
		if (unchecked.length === 2) return ctx.skip(unchecked.join("; "));
		for (const why of unchecked) ctx.say(`${why}; that half is unchecked.`);
		return {
			okLine:
				unchecked.length > 0
					? `${unchecked[0]}; the other half carries ${Object.keys(WATCHDOG_ENV).join(" and ")}`
					: `${settingsPath} and ${file} both carry ${Object.keys(WATCHDOG_ENV).join(" and ")}`,
			noun: "retry-watchdog fault(s)",
		};
	},
});
