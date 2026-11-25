const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { requiredGroup } = require("./regex-group.js");

const CORE_STYLE = "Core voice";

const BUILT_IN_STYLES = [
	"default",
	"Concise",
	"Proactive",
	"Explanatory",
	"Learning",
];

const OPEN_RE = /^---\r?\n/m;
const NAME_LINE_RE =
	/^name:(?:[ \t]*(?=[^ \t\n\r\u2028\u2029])|[ \t]*(?=[ \t]$))((?:[ \t]*[^ \t\n\r\u2028\u2029])+|[ \t])[ \t]*\r?$/m;
const CLOSE_RE = /^---/m;

/** @param {string} text */
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
 * @param {string} name
 * @returns {string|null}
 */
const pluginOf = (name) => {
	const at = name.indexOf(":");
	return at < 0 ? null : name.slice(0, at);
};

/**
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
