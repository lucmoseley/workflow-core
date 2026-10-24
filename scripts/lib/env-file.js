/*
 * env-file.js — one variable's value from a `.env` file, the gitignored file
 * `scripts/write-secret.js` writes (#2607): `NAME=value` or
 * `export NAME = value`, the value trimmed and one quote stripped from each
 * end.
 *
 * THE RETURN VALUE IS A SECRET: a caller puts it in no log line or message.
 */

const fs = require("node:fs");
const { requiredGroup } = require("./regex-group");

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * The first non-empty value the file assigns `name`, or null where none does.
 * @param {string} file
 * @param {string} name
 * @returns {string|null}
 * @throws where the file cannot be read; ENOENT where it is absent
 */
function envFileValue(file, name) {
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const m = line.match(ENV_LINE);
		if (!m || m[1] !== name) continue;
		const value = requiredGroup(m, 2, ENV_LINE)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (value) return value;
	}
	return null;
}

module.exports = { envFileValue };
