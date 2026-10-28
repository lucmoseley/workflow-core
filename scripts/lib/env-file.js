/*
 * env-file.js — the secrets file and one variable's value from it.
 *
 * THE SECRETS FILE is `$XDG_CONFIG_HOME/workflow-core/secrets.env`, with
 * `~/.config` where XDG_CONFIG_HOME is unset, empty or relative (the XDG Base
 * Directory spec). `scripts/write-secret.js` writes it owner-only. It sits
 * outside every working tree, so a script that writes a relative `.env` from
 * whatever cwd it lands in cannot reach it (#3202). An absolute
 * WFC_SECRETS_FILE stands in for it, for tests only.
 *
 * A LINE is `NAME=value` or `export NAME = value`, the value trimmed and one
 * quote stripped from each end.
 *
 * THE RETURN VALUE IS A SECRET: a caller puts it in no log line or message.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { requiredGroup } = require("./regex-group");

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** @returns {string} */
function secretsFile() {
	const override = process.env.WFC_SECRETS_FILE;
	if (override && path.isAbsolute(override)) return override;
	const xdg = process.env.XDG_CONFIG_HOME;
	const config =
		xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
	return path.join(config, "workflow-core", "secrets.env");
}

/**
 * The first non-empty value the file assigns `name`, or null where none does.
 * @param {string} file
 * @param {string} name
 * @returns {string|null}
 * @throws where the file cannot be read; ENOENT where it is absent
 */
function readEnvFileValue(file, name) {
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

module.exports = { readEnvFileValue, secretsFile };
