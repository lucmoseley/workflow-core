const PERSIST_ENV = "WFC_NOTIFY_PERSIST";

/**
 * @param {string[]} argv
 * @param {{ forbid?: string[] }} [opts]
 */
const persisting = (argv, opts) =>
	process.env[PERSIST_ENV] === "1" &&
	argv.includes("--notify") &&
	!argv.includes("--json") &&
	!(opts?.forbid ?? []).some((flag) => argv.includes(flag));

module.exports = { persisting };
