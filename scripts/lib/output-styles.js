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

const NAME_RE = /^---\r?\n[\s\S]*?^name:[ \t]*(.+?)[ \t]*\r?$[\s\S]*?^---/m;

/**
 * The style names a directory of `.md` files declares.
 * @param {string} dir
 * @returns {string[]}
 */
function stylesIn(dir) {
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
			const m = NAME_RE.exec(text);
			const name = m ? requiredGroup(m, 1, NAME_RE) : "";
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
function pluginStyles(pluginRoot) {
	const manifest = JSON.parse(
		fs.readFileSync(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			"utf8",
		),
	);
	return {
		plugin: manifest.name,
		styles: stylesIn(path.join(pluginRoot, ".claude", "output-styles")).map(
			(s) => namespaced(manifest.name, s),
		),
	};
}

module.exports = {
	CORE_STYLE,
	BUILT_IN_STYLES,
	stylesIn,
	namespaced,
	pluginOf,
	pluginStyles,
};
