#!/usr/bin/env node
/*
 * allowance.js — the thin CLI over `lib/allowance.js`, for `dispatch-sessions.sh`
 * (a bash caller) to shell out to; `admission.js` (Node) `require`s the lib
 * in-process instead (#293).
 *
 * Usage: node allowance.js [--json] [--config-dir <dir>]
 *          [--cap <members> --session-threshold <pct> --week-threshold <pct>]
 *
 * The printed `claude -p "/usage"` transcript, where the caller has one, is
 * read from STDIN — piped, never a flag, because it can be arbitrarily long
 * and a bash caller already has it in a variable.
 *
 * Exit codes:
 *   0  the reading is trustworthy (`lib/allowance.js#isTrustworthy`): each bar
 *      fresh or one the account does not report, at least one fresh (#3758)
 *   1  it is not — the caller's ceiling refusal is its own to
 *      write; this exit code is trust, never a ceiling verdict (#293 ruling 2)
 *   2  an unknown flag or a value flag with no value (lib/cli-args.js)
 *
 * `--json`'s payload carries `trustworthy`, the exit code's verdict, for a
 * caller that discards the code. `--cap` adds a `cap` key to `--json`'s
 * payload, lib/allowance-cap.js's capOf for `<members>`: `cap.floored` whether
 * that launch is the floor's one member alone, and `cap.error` set, with
 * `cap.launch` 0, where it cannot be sized. Never changes the exit code.
 */

const { readFdAll } = require("./lib/read-fd.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { writeFd } = require("./lib/write-fd.js");
const { configDir: defaultConfigDir } = require("./lib/config-dir.js");
const { readAllowance, isTrustworthy } = require("./lib/allowance");
const { capOf } = require("./lib/allowance-cap.js");

const CLI = {
	usage:
		"usage: node allowance.js [--json] [--config-dir <dir>] [--cap <members> --session-threshold <pct> --week-threshold <pct>]",
	flags: {
		"--json": /** @type {const} */ ("boolean"),
		"--config-dir": /** @type {const} */ ("value"),
		"--cap": /** @type {const} */ ("value"),
		"--session-threshold": /** @type {const} */ ("value"),
		"--week-threshold": /** @type {const} */ ("value"),
	},
};

/** @param {string[]} argv */
function parseArgs(argv) {
	const { flags } = parseOrExit(argv, CLI);
	const num = (/** @type {string} */ flag) => {
		const v = flagValue(flags, flag);
		return v === undefined ? null : Number(v);
	};
	return {
		json: flags["--json"] === true,
		configDir: flagValue(flags, "--config-dir"),
		cap: num("--cap"),
		sessionThreshold: num("--session-threshold"),
		weekThreshold: num("--week-threshold"),
	};
}

function readStdin() {
	try {
		return readFdAll(0).toString("utf8");
	} catch {
		return "";
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const usageText = readStdin();
	const result = readAllowance({ configDir: args.configDir, usageText });
	const trustworthy = isTrustworthy(result);

	if (args.json) {
		const payload =
			args.cap !== null && trustworthy
				? {
						...result,
						trustworthy,
						cap: capOf(result, {
							members: args.cap,
							sessionThreshold: args.sessionThreshold,
							weekThreshold: args.weekThreshold,
							configDir: args.configDir || defaultConfigDir(),
						}),
					}
				: { ...result, trustworthy };
		writeFd(1, `${JSON.stringify(payload)}\n`);
		return trustworthy ? 0 : 1;
	}

	/** @param {import("./lib/allowance").Bar} bar */
	const figure = (bar) => {
		if (bar.trust === "unreported") return "not reported";
		return bar.percent === null ? "unreadable" : `${bar.percent}%`;
	};
	const line = (
		/** @type {string} */ label,
		/** @type {import("./lib/allowance").Bar} */ bar,
	) =>
		`${label}  ${figure(bar)} (${bar.trust})${bar.resetsAt ? `, resets ${bar.resetsAt}` : ""}`;
	writeFd(
		1,
		`${line("session    ", result.session)}\n${line("weekly_all ", result.weekly_all)}\n`,
	);
	return trustworthy ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { main };
