/*
 * stryker-comments.js — the comments Stryker 10's instrumenter reads in a
 * file, parsed as it parses them, for the mutation hold's disable-comment
 * check (#2366, #2573, #2624); and the host Stryker config, loaded as the
 * hold's wrapper loads it for Stryker.
 *
 *   node scripts/lib/stryker-comments.js < request.json
 *
 * is `readComments` over the request on stdin, `{files}` holding its result
 * as JSON on stdout, or `{error}` where Babel will not load. A child, since the instrumenter
 * parses with `parseAsync`, which alone loads a Babel config holding
 * top-level await, and the host config is loaded by `import()`.
 */

const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { caught } = require("./caught.js");
const { firstLine } = require("./first-line.js");
const { writeFd } = require("./write-fd.js");

const HOST_CONFIG_FAULT = "could not read the host's Stryker config";

/* The parser plugins Stryker 10's instrumenter passes Babel
 * (`parsers/js-parser.js`, and `ts-parser.js` through its presets), each
 * parse a module, as both set or default it. A JS parse takes the host's
 * `mutator.plugins` in their place where set. Residual: a host Stryker at
 * another version than the hold's STRYKER_VERSION may parse with other
 * plugins. */
const JS_PLUGINS = [
	"doExpressions",
	"exportDefaultFrom",
	"functionBind",
	"functionSent",
	"importMeta",
	["pipelineOperator", { proposal: "fsharp" }],
	"throwExpressions",
	"v8intrinsic",
	"partialApplication",
	"decorators",
	"jsx",
];
const TS_PLUGINS = [
	"typescript",
	"decorators-legacy",
	"explicitResourceManagement",
];
/* `ts-parser.js` adds `preset-react`, so JSX, for a TSX parse. */
const TSX_PLUGINS = [...TS_PLUGINS, "jsx"];

/** @typedef {"js"|"ts"|"tsx"} ParseKind */
/** @typedef {{type: string, value: string, loc: {start: {line: number}, end: {line: number}}}} BabelComment */
/** @typedef {{id: string, filename: string, pieces: {code: string, kind: ParseKind}[]}} ParseEntry */

/**
 * The options object a host Stryker config at `file` exports, its default
 * export or a JSON file's whole. Throws HOST_CONFIG_FAULT where it will not.
 * @param {string} file
 * @returns {Promise<object>}
 */
async function loadStrykerConfig(file) {
	let base;
	try {
		base = file.endsWith(".json")
			? JSON.parse(fs.readFileSync(file, "utf8"))
			: (await import(pathToFileURL(path.resolve(file)).href)).default;
	} catch (e) {
		throw new Error(`${HOST_CONFIG_FAULT} ${file}: ${caught(e).message}`, {
			cause: e,
		});
	}
	if (typeof base !== "object" || base === null || Array.isArray(base))
		throw new Error(
			`${HOST_CONFIG_FAULT} ${file}: it exports no options object`,
		);
	return base;
}

/**
 * Babel's core as the host's Stryker install ships it, beside its
 * instrumenter, which parses through it.
 * @param {string} root
 * @returns {{parseAsync: (code: string, opts: object) => Promise<{comments: BabelComment[]} | null>}}
 */
function hostBabel(root) {
	const core = createRequire(
		path.join(root, "node_modules", "@stryker-mutator/core", "package.json"),
	);
	return createRequire(
		core.resolve("@stryker-mutator/instrumenter/package.json"),
	)("@babel/core");
}

/**
 * Every comment Babel reads in each entry's pieces, keyed by its id, or the
 * first line of why it would not: JS under the host's Babel config and
 * `mutator.plugins` (`parsers/js-parser.js` passes `filename` and leaves
 * config loading on), TypeScript under neither (`ts-parser.js` turns it off).
 * @param {{root: string, strykerConfig: string|null, entries: ParseEntry[]}} request
 * @returns {Promise<Record<string, {comments: BabelComment[]} | {error: string}>>}
 */
async function readComments({ root, strykerConfig, entries }) {
	const babel = hostBabel(root);
	/** @type {Promise<unknown[]> | undefined} */
	let jsPlugins;
	const pluginsFor = (/** @type {ParseKind} */ kind) => {
		if (kind === "ts") return TS_PLUGINS;
		if (kind === "tsx") return TSX_PLUGINS;
		jsPlugins ??=
			strykerConfig === null
				? Promise.resolve(JS_PLUGINS)
				: loadStrykerConfig(path.join(root, strykerConfig)).then(
						(c) =>
							/** @type {{mutator?: {plugins?: unknown[] | null}}} */ (c)
								.mutator?.plugins ?? JS_PLUGINS,
					);
		return jsPlugins;
	};
	/** @type {Record<string, {comments: BabelComment[]} | {error: string}>} */
	const out = {};
	for (const { id, filename, pieces } of entries) {
		try {
			/** @type {BabelComment[]} */
			const comments = [];
			for (const { code, kind } of pieces) {
				const ast = await babel.parseAsync(code, {
					cwd: root,
					filename: path.join(root, filename),
					sourceType: "module",
					parserOpts: { plugins: [...(await pluginsFor(kind))] },
					...(kind === "js" ? {} : { configFile: false, babelrc: false }),
				});
				if (ast === null) throw new Error("the host's Babel config ignores it");
				comments.push(...ast.comments);
			}
			out[id] = { comments };
		} catch (e) {
			out[id] = { error: firstLine(caught(e).message) };
		}
	}
	return out;
}

if (require.main === module)
	readComments(JSON.parse(fs.readFileSync(0, "utf8"))).then(
		(files) => writeFd(1, JSON.stringify({ files })),
		(e) => writeFd(1, JSON.stringify({ error: firstLine(caught(e).message) })),
	);

// The hold's wrapper imports loadStrykerConfig from ESM by name, which
// Node finds only while this stays a literal object.
module.exports = { HOST_CONFIG_FAULT, loadStrykerConfig };
