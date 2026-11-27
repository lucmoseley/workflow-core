#!/usr/bin/env node

const { readFdAll } = require("./lib/read-fd.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { writeFd } = require("./lib/write-fd.js");
const { configDir: defaultConfigDir } = require("./lib/config-dir.js");
const { readAllowance, isTrustworthy } = require("./lib/allowance");
const { capOf } = require("./lib/allowance-cap.js");
const { now } = require("./lib/check.js");

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
	const result = readAllowance({
		configDir: args.configDir,
		usageText,
		now: now(),
	});
	const trustworthy = isTrustworthy(result);

	if (args.json) {
		const payload =
			args.cap !== null && trustworthy
				? {
						...result,
						trustworthy,
						cap: capOf(result, {
							members: args.cap,
							thresholds: {
								session: args.sessionThreshold,
								weekly_all: args.weekThreshold,
							},
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
