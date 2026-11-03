#!/usr/bin/env node
/*
 * list-noun-readers.js — the JS and TS functions that read a file, a
 * directory or a command's output and carry a noun name: the candidates for
 * base §G5's `readX` (workflow-core#2750).
 *
 * Usage:  node scripts/list-noun-readers.js [<pathspec>…]
 *
 * It reads the tracked `.js`, `.cjs`, `.mjs` and `.ts` files the git
 * pathspecs match in the working directory's repo, all of them where none is
 * given (`'scripts/lib/*' ':!scripts/*.test.ts'` narrows it). It prints
 * `<file>:<line>\t<name>` per candidate, then their count, and exits 0; 1
 * where typescript or git cannot be reached.
 *
 * A CANDIDATE, NOT A VERDICT. A function is listed where its name's first
 * word is not in VERBS and its own body, nested functions aside, calls an fs
 * read, a child-process spawn or a `git`/`gh`/`sh` wrapper, or returns what a
 * `readX` call gave it: the call in a returned expression, or a variable
 * that carries one, transitively (workflow-core#2858). Review decides whether its job is
 * returning what it read; one that only checks or acts on it is no reader.
 * Missed: a reader that reaches its I/O only through a helper outside these
 * sets (another noun-named function, a `loadX`, a `runCli`), a `readX` value
 * carried through an object property, and a class or object method.
 * Over-listed: a function that returns something it computed from what it
 * read.
 *
 * IN NO FAMILY (code-standards §N3, §G4): it gates nothing.
 */

const fs = require("node:fs");
const path = require("node:path");

const { parseOrCode } = require("./lib/cli-args.js");
const { execGit } = require("./lib/git.js");
const { hostPackage } = require("./lib/host-package.js");
const { writeFd } = require("./lib/write-fd.js");

/** @typedef {typeof import("typescript")} Ts */

/* The first words taken as verbs. A noun added here hides its readers, so
 * add only words this repo's names use as verbs alone (`guard`, `start`,
 * `store` and kin lead noun names too, so they stay out). `gh`, `git` and
 * `sh` stand as verbs: a wrapper named for the command it runs is that
 * command's runner, not a reader (workflow-core#2750). */
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
/* Buffer's own `readUInt32LE` and kin read memory, not a file. */
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
 * Whether `pred` holds of `node` or any node under it, not entering nested
 * functions.
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
 * Whether `body` calls an fs read, a spawn or a command wrapper, not counting
 * the bodies of functions nested in it.
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
 * The names `node` fills with a value `hasReadIn` accepts: a declaration or
 * an assignment from one, a method call taking one (`out.push(x)` fills
 * `out`), or a loop over one.
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
 * Whether `body` returns what a `readX` call gave it.
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
		usage: "usage: node scripts/list-noun-readers.js [<pathspec>…]",
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
