const { literal } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} ApiCall
 * @property {string} method
 * @property {string} endpoint
 * @property {string[]} fields
 * @property {Set<string>} magicFields
 * @property {boolean} opaque
 * @property {boolean} input
 */

const VALUE_FLAGS = [
	"--cache",
	"--header",
	"--hostname",
	"--jq",
	"--preview",
	"--template",
];

/**
 * @param {string[]} argv
 * @param {string[]} spans
 * @returns {ApiCall}
 */
function scanApi(argv, spans) {
	/** @type {ApiCall} */
	const call = {
		method: "",
		endpoint: "",
		fields: [],
		magicFields: new Set(),
		opaque: false,
		input: false,
	};
	for (let i = 0; i < argv.length; ) {
		const { val, step, magic } = readWord(
			call,
			argv[i] ?? "",
			argv[i + 1] ?? "",
		);
		if (val) {
			if (isNameUnread(val, spans)) call.opaque = true;
			call.fields.push(val);
			if (magic) call.magicFields.add(val);
		}
		i += step;
	}
	return call;
}

/**
 * @param {string} val
 * @param {string[]} spans
 */
const isNameUnread = (val, spans) => !literal(val, spans).head.includes("=");

/**
 * @param {string} val
 * @param {string[]} spans
 */
const isBodyField = (val, spans) =>
	literal(val, spans).text.startsWith("body=");

/**
 * @param {ApiCall} call
 * @param {string} tok
 * @param {string} next
 * @returns {{ val: string, step: number, magic?: boolean }}
 */
function readWord(call, tok, next) {
	if (tok.startsWith("--")) return longWord(call, tok, next);
	if (tok.length > 1 && tok.startsWith("-")) {
		const short = shortBundle(tok.slice(1), next);
		if (short.letter === "X") call.method = short.value;
		const field = short.letter === "f" || short.letter === "F";
		return {
			val: field ? short.value : "",
			step: short.step,
			magic: short.letter === "F",
		};
	}
	if (!call.endpoint) call.endpoint = tok;
	return { val: "", step: 1 };
}

/**
 * @param {ApiCall} call
 * @param {string} tok
 * @param {string} next
 * @returns {{ val: string, step: number, magic?: boolean }}
 */
function longWord(call, tok, next) {
	const eq = tok.indexOf("=");
	const name = eq < 0 ? tok : tok.slice(0, eq);
	const value = eq < 0 ? next : tok.slice(eq + 1);
	const step = eq < 0 ? 2 : 1;
	if (name === "--field" || name === "--raw-field")
		return { val: value, step, magic: name === "--field" };
	if (name === "--method") {
		call.method = value;
		return { val: "", step };
	}
	if (name === "--input") {
		call.input = true;
		return { val: "", step };
	}
	return { val: "", step: eq < 0 && VALUE_FLAGS.includes(tok) ? 2 : 1 };
}

/**
 * pflag ends a shorthand bundle at its first value-taking letter, and drops a
 * `=` separator only when something follows it:
 * https://github.com/spf13/pflag/blob/master/flag.go
 * @param {string} rest
 * @param {string} next
 * @returns {{ letter: string, value: string, step: number }}
 */
function shortBundle(rest, next) {
	for (let j = 0; j < rest.length; j++) {
		const ch = rest.charAt(j);
		let after = rest.slice(j + 1);
		if (ch === "i" && !after.startsWith("=")) continue;
		if (after.length > 1 && after.startsWith("=")) after = after.slice(1);
		else if (after === "") return { letter: ch, value: next, step: 2 };
		return { letter: ch, value: after, step: 1 };
	}
	return { letter: "", value: "", step: 1 };
}

/**
 * gh api sends POST once any field or --input is given, else GET:
 * https://cli.github.com/manual/gh_api
 * @param {ApiCall} call
 */
const defaultsToPost = (call) => call.input || call.fields.length > 0;

/** @param {string} e */
function apiPath(e) {
	let p = e;
	for (const host of ["https://api.github.com", "http://api.github.com"])
		if (p.startsWith(host)) {
			p = p.slice(host.length);
			break;
		}
	return p.startsWith("/") ? p.slice(1) : p;
}

/** @param {string} e */
const isIssueEndpoint = (e) =>
	/^repos\/[^/]+\/[^/]+\/issues\/[0-9]+$/.test(apiPath(e));

/** @param {string} e */
const isIssueCollection = (e) =>
	/^repos\/[^/]+\/[^/]+\/issues$/.test(apiPath(e));

/**
 * @param {string} e
 * @returns {string | null}
 */
function endpointRepo(e) {
	let p = apiPath(e);
	if (p.startsWith("repos/")) p = p.slice("repos/".length);
	const slash = p.indexOf("/");
	const owner = slash < 0 ? p : p.slice(0, slash);
	const tail = slash < 0 ? p : p.slice(slash + 1);
	const repo = tail.includes("/") ? tail.slice(0, tail.indexOf("/")) : tail;
	if (/^(\{owner\}|:owner)$/.test(owner) && /^(\{repo\}|:repo)$/.test(repo))
		return "";
	const named = `${owner}/${repo}`;
	if (named.includes("{") || /:(owner|repo)/.test(named)) return null;
	return named;
}

/** @param {string} e */
const isGraphql = (e) => e === "graphql" || e.endsWith("/graphql");

/**
 * @param {string[]} fields
 * @param {string[]} spans
 * @returns {{ query: string, hidden: boolean }}
 */
function scanGraphql(fields, spans) {
	let query = "";
	let hidden = false;
	for (const val of fields) {
		const { text, known } = literal(val, spans);
		const field = trimEndRun(text, "\n");
		// gh api reads a field value of `@file` from a file and `@-` from stdin: https://cli.github.com/manual/gh_api
		if (field.startsWith("query=@")) hidden = true;
		else if (field.startsWith("query=")) {
			query += `${field.slice("query=".length)} `;
			if (!known) hidden = true;
		} else if (!field.includes("=") && !known) hidden = true;
	}
	return { query, hidden };
}

/**
 * @param {string} query
 * @param {string} name
 * @returns {string | null}
 */
function mutationArgs(query, name) {
	const squashed = query.replace(/[ \t\n\v\f\r]/g, "");
	const open = `${name}(`;
	const at = squashed.indexOf(open);
	if (at < 0) return null;
	const args = squashed.slice(at + open.length);
	const close = args.indexOf(")");
	return close < 0 ? args : args.slice(0, close);
}

module.exports = {
	apiPath,
	scanApi,
	isBodyField,
	defaultsToPost,
	isIssueEndpoint,
	isIssueCollection,
	endpointRepo,
	isGraphql,
	scanGraphql,
	mutationArgs,
};
