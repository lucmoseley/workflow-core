// #5855

const { localRequires } = require("./local-requires.js");

const SIBLING = /^\.\/([^/]+)$/;
const PROGRAM_LIB = /^\.\/lib\/([^/]+)$/;

/** @type {Record<string, string[]>} */
const READ_BY_PATH = {
	"model-table.js": ["model-routing.json"],
};

/**
 * @typedef {{ read: (rel: string) => string, exists: (rel: string) => boolean }} ScriptsDir
 */

/**
 * @param {string} program
 * @param {ScriptsDir} dir
 * @returns {string[]}
 */
function programLibs(program, dir) {
	/** @param {RegExp} pattern @param {string} text */
	const libsNamed = (pattern, text) =>
		localRequires(text)
			.flatMap((req) => {
				const name = pattern.exec(req)?.[1];
				if (name === undefined) return [];
				return [name.endsWith(".js") ? name : `${name}.js`];
			})
			.filter((lib) => dir.exists(`lib/${lib}`));
	const out = new Set();
	const queue = libsNamed(PROGRAM_LIB, dir.read(program));
	for (let lib = queue.shift(); lib !== undefined; lib = queue.shift()) {
		if (out.has(lib)) continue;
		out.add(lib);
		queue.push(...libsNamed(SIBLING, dir.read(`lib/${lib}`)));
	}
	return [...out, ...[...out].flatMap((lib) => READ_BY_PATH[lib] ?? [])];
}

module.exports = { programLibs };
