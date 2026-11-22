const fs = require("node:fs");
const path = require("node:path");

const LITERAL_DENY = /\bpermissionDecision\\?"?\s*:\s*\\?"deny\\?"/;

const DENIES_THROUGH_BODY = String.raw`DENIES-THROUGH:[ \t]*((?:lib\/)?[\w.-]+)`;
const MARKER_LEAD = String.raw`^[ \t]*(?:#|\*|\/\/)[ \t]*`;

const DENIES_THROUGH_MARKER = new RegExp(
	MARKER_LEAD + DENIES_THROUGH_BODY,
	"m",
);

const REFUSE_EXIT_SET = /^[ \t]*(?:readonly[ \t]+)?REFUSE_EXIT=2\b/m;
const REFUSE_EXIT_TAKEN = /\bexit[ \t]+"?\$\{?REFUSE_EXIT\}?"?(?![\w])/;
const SHELL_COMMENT_LINE = /^[ \t]*#.*$/gm;

const CORE_DENY =
	/\bdeny\s*:|(?:^|\})[^{}]*\{(?=[^}]*\bdeny(?:Text)?\b)[^}]*\}\s*=\s*require\(\s*["']\.\/guard-verdict\.js["']/;

const HEADER_LINE = /^[ \t]*(?:$|#|\/\*|\*|\/\/)/;

/**
 * @param {string} text
 * @returns {string}
 */
function headerOf(text) {
	const lines = text.split("\n");
	const end = lines.findIndex((l) => !HEADER_LINE.test(l));
	return (end === -1 ? lines : lines.slice(0, end)).join("\n");
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function deniesThrough(text) {
	return DENIES_THROUGH_MARKER.exec(headerOf(text))?.[1] ?? null;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasExitDeny(text) {
	const code = text.replace(SHELL_COMMENT_LINE, "");
	return REFUSE_EXIT_SET.test(code) && REFUSE_EXIT_TAKEN.test(code);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function writesVerdict(text) {
	return LITERAL_DENY.test(text);
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readOrNull(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * @param {string} core
 * @param {string} host
 * @returns {string[]}
 */
function guardDirs(core, host) {
	return [...new Set([path.join(core, "scripts"), path.join(host, "scripts")])];
}

/**
 * @param {string} name
 * @param {string[]} dirs
 * @returns {string | null}
 */
function guardPath(name, dirs) {
	if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") return null;
	for (const dir of dirs) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) return file;
	}
	return null;
}

/**
 * @param {string} name
 * @param {string[]} dirs
 * @returns {boolean}
 */
function isDenyCapable(name, dirs) {
	const file = guardPath(name, dirs);
	const text = file && readOrNull(file);
	if (!file || !text) return false;
	if (writesVerdict(text) || hasExitDeny(text)) return true;
	const delegate = deniesThrough(text);
	const [sub, base] = delegate?.startsWith("lib/")
		? ["lib", delegate.slice(4)]
		: ["", delegate];
	const relayed = base && guardPath(base, [path.join(path.dirname(file), sub)]);
	const relayedText = relayed && readOrNull(relayed);
	return Boolean(relayedText && writesVerdict(relayedText));
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isDenyingCore(file) {
	const text = readOrNull(file);
	if (!text) return true;
	const code = text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
	return CORE_DENY.test(code);
}

/**
 * @param {string[]} dirs
 * @returns {(name: string) => boolean}
 */
function isDenyCapableIn(dirs) {
	/** @type {Map<string, boolean>} */
	const memo = new Map();
	return (name) => {
		let capable = memo.get(name);
		if (capable === undefined) {
			capable = isDenyCapable(name, dirs);
			memo.set(name, capable);
		}
		return capable;
	};
}

module.exports = {
	DENIES_THROUGH_BODY,
	isDenyingCore,
	guardDirs,
	guardPath,
	isDenyCapableIn,
};
