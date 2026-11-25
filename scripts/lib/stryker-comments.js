const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { caught } = require("./caught.js");
const { parseErrorFirstLine } = require("./first-line.js");
const { readFdAll } = require("./read-fd.js");
const { requiredGroup } = require("./regex-group.js");
const { writeFd } = require("./write-fd.js");

const HOST_CONFIG_FAULT = "could not read the host's Stryker config";
/* https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/instrumenter/src/transformers/directive-bookkeeper.ts */
const DIRECTIVE =
	/^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/;
const RESULT_FD = 3;
const NOT_CHILDREN = new Set([
	"leadingComments",
	"trailingComments",
	"innerComments",
	"loc",
	"extra",
]);

// The parser plugins Stryker 10's instrumenter passes Babel: https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/instrumenter/src/parsers/js-parser.ts
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
const TSX_PLUGINS = [...TS_PLUGINS, "jsx"];

/** @typedef {"js"|"ts"|"tsx"} ParseKind */
/**
 * Stryker reads only leading comments, binding a `next-line` directive to the line its node starts on: https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/instrumenter/src/transformers/directive-bookkeeper.ts
 * @typedef {{type: string, value: string, start: number, loc: {start: {line: number}, end: {line: number}}, leads?: number, within?: [number, number][], block: number, blockEnd: number}} BabelComment
 */
/** @typedef {{id: string, filename: string, pieces: {code: string, kind: ParseKind}[]}} ParseEntry */
/** @typedef {Record<string, {comments: BabelComment[]} | {error: string}>} ReadComments */

/** @typedef {{verb: string, scope: string | undefined, mutators: string[], reason: string | undefined}} ParsedDirective */

/**
 * @param {string} text
 * @returns {ParsedDirective | null}
 */
function parseDirective(text) {
	const d = DIRECTIVE.exec(text);
	if (d === null) return null;
	return {
		verb: requiredGroup(d, 1, DIRECTIVE),
		scope: d[2],
		mutators: requiredGroup(d, 3, DIRECTIVE)
			.split(",")
			.map((m) => m.trim().toLowerCase()),
		reason: d[4],
	};
}

/** @param {ParsedDirective} d */
const unreasonedDisable = (d) =>
	d.verb === "disable" && (d.reason === undefined || d.reason.trim() === "");

/**
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

/** @param {unknown} node @param {[number, number][]} within */
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

/** @param {object} node @param {[number, number][]} within */
function markChildren(node, within) {
	for (const [k, v] of Object.entries(node))
		if (!NOT_CHILDREN.has(k)) markLeads(v, within);
}

/**
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
	process.exit();
}

if (require.main === module)
	readComments(JSON.parse(readFdAll(0).toString("utf8"))).then(
		(files) => answerAndExit({ files }),
		(e) => answerAndExit({ error: parseErrorFirstLine(e) }),
	);

// Node finds a CommonJS module's named exports for an ESM import only in a literal `module.exports` object: https://nodejs.org/api/esm.html#commonjs-namespaces
module.exports = {
	HOST_CONFIG_FAULT,
	RESULT_FD,
	loadStrykerConfig,
	parseDirective,
	unreasonedDisable,
};
