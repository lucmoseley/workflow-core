#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");

const { parseOrCode } = require("./lib/cli-args.js");
const { execGit } = require("./lib/git.js");
const { hostPackage } = require("./lib/host-package.js");
const { writeFd } = require("./lib/write-fd.js");

/** @typedef {typeof import("typescript")} Ts */

const VERBS = new Set(
	`add advance append apply archive arm ask assert assign attach attempt
	audit await build bump gh git sh call check claim classify clear clone
	close collect commit compare compose copy count create cut declare delete
	deny derive dispatch drop emit enable ensure exec expand expect extract
	fail fake fetch fill filter find fire flush format gate generate get grep
	init inject install is has judge keep kill land launch list load make mark
	match measure merge mint move mutate normalise open park parse persist
	pick pin poll post prepare price print probe prune push put raise read
	reap recheck reconcile refresh refuse regenerate remove render replace
	replay rerun reset resolve restore retry revert rewrite rotate run save
	scan search send set settle shift show sleep sort spawn split stash stop
	strip summarise swap sweep switch sync take tidy track trim try unset
	update upsert validate verify wait wake walk warn write`.split(/\s+/),
);

const SOURCE = /\.(?:c|m)?js$|\.ts$/;

const FS_READS = new Set([
	"access",
	"accessSync",
	"createReadStream",
	"existsSync",
	"lstat",
	"lstatSync",
	"openSync",
	"opendirSync",
	"readFile",
	"readFileSync",
	"readdir",
	"readdirSync",
	"readSync",
	"readlinkSync",
	"realpathSync",
	"stat",
	"statSync",
]);
const SPAWNS = new Set([
	"execFile",
	"execFileSync",
	"execSync",
	"spawn",
	"spawnSync",
]);
const WRAPPER = /^(?:git|gh|sh)(?:[A-Z]\w*)?$|^(?:exec|spawn)Git\w*$/;
const READER = /^read(?!U?Int|Big|Float|Double)[A-Z]/;

/**
 * @param {Ts} ts
 * @param {import("typescript").CallExpression} call
 */
function calleeName(ts, call) {
	const callee = call.expression;
	if (ts.isIdentifier(callee)) return callee.text;
	if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
	return null;
}

/**
 * @param {Ts} ts
 * @param {import("typescript").Node} node
 * @param {(node: import("typescript").Node) => boolean} pred
 * @returns {boolean}
 */
function someOwn(ts, node, pred) {
	if (ts.isFunctionLike(node)) return false;
	return (
		pred(node) ||
		Boolean(ts.forEachChild(node, (n) => someOwn(ts, n, pred) || undefined))
	);
}

/**
 * @param {Ts} ts
 * @param {import("typescript").Node} body
 */
function hasOwnRead(ts, body) {
	return someOwn(ts, body, (node) => {
		if (!ts.isCallExpression(node)) return false;
		const name = calleeName(ts, node);
		return (
			name !== null &&
			(FS_READS.has(name) || SPAWNS.has(name) || WRAPPER.test(name))
		);
	});
}

/**
 * @param {Ts} ts
 * @param {import("typescript").Node} node
 * @param {(expr: import("typescript").Node) => boolean} hasReadIn
 * @returns {import("typescript").BindingName[]}
 */
function filledNames(ts, node, hasReadIn) {
	if (ts.isVariableDeclaration(node))
		return node.initializer && hasReadIn(node.initializer) ? [node.name] : [];
	if (isAssignment(ts, node))
		return ts.isIdentifier(node.left) && hasReadIn(node.right)
			? [node.left]
			: [];
	if (ts.isCallExpression(node)) {
		const target = node.expression;
		return ts.isPropertyAccessExpression(target) &&
			ts.isIdentifier(target.expression) &&
			node.arguments.some(hasReadIn)
			? [target.expression]
			: [];
	}
	if (ts.isForOfStatement(node) || ts.isForInStatement(node))
		return loopNames(ts, node, hasReadIn);
	return [];
}

/**
 * @param {Ts} ts
 * @param {import("typescript").Node} node
 * @returns {node is import("typescript").BinaryExpression}
 */
function isAssignment(ts, node) {
	return (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
		node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
	);
}

/**
 * @param {Ts} ts
 * @param {import("typescript").ForOfStatement | import("typescript").ForInStatement} loop
 * @param {(expr: import("typescript").Node) => boolean} hasReadIn
 */
function loopNames(ts, loop, hasReadIn) {
	return ts.isVariableDeclarationList(loop.initializer) &&
		hasReadIn(loop.expression)
		? loop.initializer.declarations.map((d) => d.name)
		: [];
}

/**
 * @param {Ts} ts
 * @param {import("typescript").ConciseBody} body
 */
function hasReturnedRead(ts, body) {
	/** @type {Set<string>} */
	const bound = new Set();
	/** @param {import("typescript").Node} expr */
	const hasReadIn = (expr) =>
		someOwn(ts, expr, (node) => {
			if (ts.isIdentifier(node))
				return (
					bound.has(node.text) &&
					!(
						ts.isPropertyAccessExpression(node.parent) &&
						node.parent.name === node
					)
				);
			if (!ts.isCallExpression(node)) return false;
			const name = calleeName(ts, node);
			return name !== null && READER.test(name);
		});
	/** @param {import("typescript").BindingName} name */
	const bind = (name) => {
		if (ts.isIdentifier(name)) bound.add(name.text);
		else
			for (const el of name.elements)
				if (!ts.isOmittedExpression(el)) bind(el.name);
	};
	if (!ts.isBlock(body)) return hasReadIn(body);
	return someOwn(ts, body, (node) => {
		for (const name of filledNames(ts, node, hasReadIn)) bind(name);
		return (
			ts.isReturnStatement(node) &&
			node.expression !== undefined &&
			hasReadIn(node.expression)
		);
	});
}

/** @param {string} name */
function isNounNamed(name) {
	const first = /^[a-z]+/.exec(name);
	return first !== null && name !== "main" && !VERBS.has(first[0]);
}

/**
 * @param {Ts} ts
 * @param {string} file
 * @param {string} text
 * @returns {{line: number, name: string}[]}
 */
function parseNounReaders(ts, file, text) {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	/** @type {{line: number, name: string}[]} */
	const out = [];
	/**
	 * @param {import("typescript").Node} node
	 * @param {string} name
	 * @param {import("typescript").FunctionLikeDeclarationBase} fn
	 */
	const consider = (node, name, fn) => {
		if (
			fn.body &&
			isNounNamed(name) &&
			(hasOwnRead(ts, fn.body) || hasReturnedRead(ts, fn.body))
		)
			out.push({
				line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
				name,
			});
	};
	/** @param {import("typescript").Node} node */
	const visit = (node) => {
		if (ts.isFunctionDeclaration(node) && node.name)
			consider(node, node.name.text, node);
		else if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			(ts.isArrowFunction(node.initializer) ||
				ts.isFunctionExpression(node.initializer))
		)
			consider(node, node.name.text, node.initializer);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return out;
}

function main() {
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("list-noun-readers.js")} [<pathspec>…]`,
		max: Number.POSITIVE_INFINITY,
	});
	if (typeof parsed === "number") return parsed;
	const loaded = hostPackage("typescript", __dirname);
	if (!loaded.ok) {
		writeFd(2, `${loaded.message}\n`);
		return 1;
	}
	/** @type {Ts} */
	const ts = loaded.module;
	let files;
	try {
		files = execGit(["ls-files", "-z", "--", ...parsed.positionals], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})
			.split("\0")
			.filter((f) => SOURCE.test(f) && fs.existsSync(f));
	} catch (e) {
		writeFd(2, `git ls-files failed: ${e instanceof Error ? e.message : e}\n`);
		return 1;
	}
	let count = 0;
	for (const file of files)
		for (const { line, name } of parseNounReaders(
			ts,
			path.basename(file),
			fs.readFileSync(file, "utf8"),
		)) {
			writeFd(1, `${file}:${line}\t${name}\n`);
			count++;
		}
	writeFd(1, `${count} candidate(s)\n`);
	return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
