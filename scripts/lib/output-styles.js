/*
 * output-styles.js — the names an `outputStyle` setting can resolve to, read
 * the way the harness reads them (#1944).
 *
 * A style's name is its frontmatter `name:`, else its filename without `.md`.
 * A PLUGIN's style is namespaced `<plugin>:<name>` (Claude Code 2.1.302's
 * plugin output-style loader), so an adopter, which gets the core's style from
 * the plugin, names it `workflow-core:Core voice`; workflow-core itself reads
 * the same file as a project style and names it `Core voice`. A setting
 * matching no name loads no style, silently.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { requiredGroup } = require("./regex-group.js");

const CORE_STYLE = "Core voice";

/** The harness's built-in styles, which no file declares (Claude Code 2.1.302). */
const BUILT_IN_STYLES = [
	"default",
	"Concise",
	"Proactive",
	"Explanatory",
	"Learning",
];

const OPEN_RE = /^---\r?\n/m;
/* A `name:` line's value less its outer blanks; a value of blanks alone is
 * its last blank. Each blank run is read once. */
const NAME_LINE_RE =
	/^name:(?:[ \t]*(?=[^ \t\n\r\u2028\u2029])|[ \t]*(?=[ \t]$))((?:[ \t]*[^ \t\n\r\u2028\u2029])+|[ \t])[ \t]*\r?$/m;
const CLOSE_RE = /^---/m;

/**
 * The frontmatter `name:` value, or "" where there is none. Only the first
 * `---` line can open it and only the first `name:` line after it can name
 * it: a later one has no closing `---` where the first had none.
 * @param {string} text
 */
function frontmatterName(text) {
	const open = OPEN_RE.exec(text);
	if (!open) return "";
	const rest = text.slice(open.index + open[0].length);
	const m = NAME_LINE_RE.exec(rest);
	if (!m) return "";
	return CLOSE_RE.test(rest.slice(m.index + m[0].length))
		? requiredGroup(m, 1, NAME_LINE_RE)
		: "";
}

/**
 * The style names a directory of `.md` files declares.
 * @param {string} dir
 * @returns {string[]}
 */
function readStylesIn(dir) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		throw err;
	}
	return names
		.filter((n) => n.endsWith(".md"))
		.map((n) => {
			const text = fs.readFileSync(path.join(dir, n), "utf8");
			const name = frontmatterName(text);
			return name.replace(/^(["'])(.*)\1$/, "$2") || n.slice(0, -3);
		});
}

/**
 * @param {string} plugin
 * @param {string} style
 */
const namespaced = (plugin, style) => `${plugin}:${style}`;

/**
 * The plugin a namespaced style name belongs to.
 * @param {string} name
 * @returns {string|null}
 */
const pluginOf = (name) => {
	const at = name.indexOf(":");
	return at < 0 ? null : name.slice(0, at);
};

/**
 * The namespaced names of the styles a plugin tree ships.
 * @param {string} pluginRoot
 * @returns {{plugin: string, styles: string[]}}
 */
function readPluginStyles(pluginRoot) {
	const manifest = JSON.parse(
		fs.readFileSync(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			"utf8",
		),
	);
	return {
		plugin: manifest.name,
		styles: readStylesIn(path.join(pluginRoot, ".claude", "output-styles")).map(
			(s) => namespaced(manifest.name, s),
		),
	};
}

module.exports = {
	CORE_STYLE,
	BUILT_IN_STYLES,
	readStylesIn,
	namespaced,
	pluginOf,
	readPluginStyles,
};
