/*
 * stryker-comments.js — the comments Stryker 10's instrumenter reads in a
 * file, parsed as it parses them, for the mutation hold's disable-comment
 * check (#2366, #2573, #2624); and the host Stryker config, loaded as the
 * hold's wrapper loads it for Stryker.
 *
 *   node scripts/lib/stryker-comments.js < request.json
 *
 * is `readComments` over the request on stdin, `{files}` holding its result
 * as JSON on fd RESULT_FD, or `{error}` where Babel will not load: not stdout,
 * where a host Babel or Stryker config may print (#2727). A child, since the
 * instrumenter parses with `parseAsync`, which alone loads a Babel config
 * holding top-level await, and the host config is loaded by `import()`.
 */

const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { caught } = require("./caught.js");
const { parseErrorFirstLine } = require("./first-line.js");
const { writeFd } = require("./write-fd.js");

const HOST_CONFIG_FAULT = "could not read the host's Stryker config";
const RESULT_FD = 3;
const NOT_CHILDREN = new Set([
	"leadingComments",
	"trailingComments",
	"innerComments",
	"loc",
	"extra",
]);

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
/**
 * Set here: `leads`, the line the node it is a leading comment of starts on,
 * since Stryker reads only those, binding a `next-line` directive to that line
 * and opening a region there (instrumenter `directive-bookkeeper.js`);
 * `within`, the line spans of that node's ancestors, since Stryker reads no
 * directive under one overlapping none of its `mutate` ranges
 * (`babel-transformer.js` skips its subtree); and `block` and `blockEnd`, the
 * piece it sits in and that piece's last line, since each `<script>` block has
 * a bookkeeper of its own (`html-transformer.js`).
 * @typedef {{type: string, value: string, start: number, loc: {start: {line: number}, end: {line: number}}, leads?: number, within?: [number, number][], block: number, blockEnd: number}} BabelComment
 */
/** @typedef {{id: string, filename: string, pieces: {code: string, kind: ParseKind}[]}} ParseEntry */
/** @typedef {Record<string, {comments: BabelComment[]} | {error: string}>} ReadComments */

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
 * @returns {{parseAsync: (code: string, opts: object) => Promise<{comments: BabelComment[], program: unknown} | null>}}
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
 * Set `leads` and `within` on every leading comment under `node`, the
 * outermost node's where several share one.
 * @param {unknown} node accumulator: its comment objects are written in place
 * @param {[number, number][]} within the spans of `node`'s ancestors
 */
function markLeads(node, within) {
	if (typeof node !== "object" || node === null) return;
	if (Array.isArray(node)) {
		for (const n of node) markLeads(n, within);
		return;
	}
	const n =
		/** @type {{loc?: {start: {line: number}, end: {line: number}}, leadingComments?: BabelComment[]}} */ (
			node
		);
	if (n.loc === undefined) {
		markChildren(n, within);
		return;
	}
	for (const c of n.leadingComments ?? [])
		if (c.leads === undefined) {
			c.leads = n.loc.start.line;
			c.within = within;
		}
	markChildren(n, [
		...within,
		/** @type {[number, number]} */ ([n.loc.start.line, n.loc.end.line]),
	]);
}

/**
 * markLeads over each child of `node`.
 * @param {object} node
 * @param {[number, number][]} within
 */
function markChildren(node, within) {
	for (const [k, v] of Object.entries(node))
		if (!NOT_CHILDREN.has(k)) markLeads(v, within);
}

/**
 * Every comment Babel reads in each entry's pieces, keyed by its id, or the
 * first line of why it would not: JS under the host's Babel config and
 * `mutator.plugins` (`parsers/js-parser.js` passes `filename` and leaves
 * config loading on), TypeScript under neither (`ts-parser.js` turns it off).
 * @param {{root: string, strykerConfig: string|null, entries: ParseEntry[]}} request
 * @returns {Promise<ReadComments>}
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
	/** @type {ReadComments} */
	const out = {};
	for (const { id, filename, pieces } of entries) {
		try {
			/** @type {BabelComment[]} */
			const comments = [];
			for (const [block, { code, kind }] of pieces.entries()) {
				const ast = await babel.parseAsync(code, {
					cwd: root,
					filename: path.join(root, filename),
					sourceType: "module",
					parserOpts: { plugins: [...(await pluginsFor(kind))] },
					...(kind === "js" ? {} : { configFile: false, babelrc: false }),
				});
				if (ast === null) throw new Error("the host's Babel config ignores it");
				markLeads(ast.program, []);
				const blockEnd = code.split("\n").length;
				for (const c of ast.comments) {
					c.block = block;
					c.blockEnd = blockEnd;
				}
				comments.push(...ast.comments);
			}
			out[id] = { comments };
		} catch (e) {
			out[id] = { error: parseErrorFirstLine(e) };
		}
	}
	return out;
}

/** @param {object} result */
function answerAndExit(result) {
	writeFd(RESULT_FD, JSON.stringify(result));
	// A host config's timer or open handle would keep the child past its answer.
	process.exit();
}

if (require.main === module)
	readComments(JSON.parse(fs.readFileSync(0, "utf8"))).then(
		(files) => answerAndExit({ files }),
		(e) => answerAndExit({ error: parseErrorFirstLine(e) }),
	);

// The hold's wrapper imports loadStrykerConfig from ESM by name, which
// Node finds only while this stays a literal object.
module.exports = { HOST_CONFIG_FAULT, RESULT_FD, loadStrykerConfig };
