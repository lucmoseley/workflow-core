/*
 * gh-api-call.js — reading a `gh api` invocation (mantahostels#511, #2796).
 *
 * A CORE: it reads nothing but its arguments. Words arrive masked, as
 * lib/shell-parse.js hands them over, and a caller reads one back through
 * shell-words.js's literal.
 */

const { QUOTED, literal } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} ApiCall raw words, quoted spans still masked
 * @property {string} method the --method/-X value, "" where none was given
 * @property {string} endpoint the first bare word
 * @property {string[]} fields every -f/-F/--field/--raw-field value, in order
 * @property {boolean} opaque a field's own NAME is masked, so which field it
 *   is cannot be read off the word. Only the name decides: a masked VALUE —
 *   `-f title="New"` — is still visibly not the field a caller looks for
 * @property {boolean} input the payload arrives whole through --input, so
 *   there are no field words to read at all
 */

/* Every other gh api flag whose value is a SEPARATE WORD. Without these the
 * value is read as the endpoint, the caller's endpoint test then answers no,
 * and the write is allowed through in silence. */
const VALUE_FLAGS = [
	"--cache",
	"--header",
	"--hostname",
	"--jq",
	"--preview",
	"--template",
];

/**
 * @param {string[]} argv the invocation's words, `api` itself dropped
 * @returns {ApiCall}
 */
function scanApi(argv) {
	/** @type {ApiCall} */
	const call = {
		method: "",
		endpoint: "",
		fields: [],
		opaque: false,
		input: false,
	};
	for (let i = 0; i < argv.length; ) {
		const { val, step } = readWord(call, argv[i] ?? "", argv[i + 1] ?? "");
		if (val) {
			const eq = val.indexOf("=");
			if (eq < 0 || val.slice(0, eq).includes(QUOTED)) call.opaque = true;
			call.fields.push(val);
		}
		i += step;
	}
	return call;
}

/**
 * @param {ApiCall} call
 * @param {string} tok
 * @param {string} next
 * @returns {{ val: string, step: number }}
 */
function readWord(call, tok, next) {
	if (tok.startsWith("--")) return longWord(call, tok, next);
	if (tok.length > 1 && tok.startsWith("-")) {
		const short = shortBundle(tok.slice(1), next);
		if (short.letter === "X") call.method = short.value;
		const field = short.letter === "f" || short.letter === "F";
		return { val: field ? short.value : "", step: short.step };
	}
	if (!call.endpoint) call.endpoint = tok;
	return { val: "", step: 1 };
}

/**
 * @param {ApiCall} call
 * @param {string} tok
 * @param {string} next
 * @returns {{ val: string, step: number }}
 */
function longWord(call, tok, next) {
	const eq = tok.indexOf("=");
	const name = eq < 0 ? tok : tok.slice(0, eq);
	const value = eq < 0 ? next : tok.slice(eq + 1);
	const step = eq < 0 ? 2 : 1;
	if (name === "--field" || name === "--raw-field") return { val: value, step };
	if (name === "--method") {
		call.method = value;
		return { val: "", step };
	}
	if (name === "--input") {
		/* The payload comes from a file or stdin: its fields are unreadable. */
		call.input = true;
		return { val: "", step };
	}
	return { val: "", step: eq < 0 && VALUE_FLAGS.includes(tok) ? 2 : 1 };
}

/**
 * A SHORTHAND BUNDLE, read exactly as pflag reads one (mantahostels#2580).
 * pflag walks the letters and the first VALUE-TAKING one ends the walk: what
 * follows it in the bundle is that letter's value, or, where nothing follows,
 * the next word. `-i` is gh api's only boolean shorthand and so the only
 * letter the walk continues past.
 *
 * `-X=PATCH` reaches gh as PATCH, `-X==PATCH` as `=PATCH`, and a lone trailing
 * `-X=` as `=`: pflag drops the separator only when something follows it.
 * @param {string} rest the bundle, its `-` off
 * @param {string} next the word after it
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
 * Did the call give gh a body to send? gh's own default: POST where any field
 * or --input was passed, GET otherwise.
 * @param {ApiCall} call
 */
const defaultsToPost = (call) => call.input || call.fields.length > 0;

/**
 * An endpoint reduced to its path, so the three spellings gh accepts — bare,
 * leading-slash and full URL — compare equal.
 * @param {string} e
 */
function apiPath(e) {
	let p = e;
	for (const host of ["https://api.github.com", "http://api.github.com"])
		if (p.startsWith(host)) {
			p = p.slice(host.length);
			break;
		}
	return p.startsWith("/") ? p.slice(1) : p;
}

/**
 * Is this endpoint one issue — not a comment, a label set or any other
 * sub-resource, whose bodies are a different thing?
 * @param {string} e
 */
const isIssueEndpoint = (e) =>
	/^repos\/[^/]+\/[^/]+\/issues\/[0-9]+$/.test(apiPath(e));

/**
 * Is this endpoint the issue COLLECTION, which is what a creation POSTs to?
 * @param {string} e
 */
const isIssueCollection = (e) =>
	/^repos\/[^/]+\/[^/]+\/issues$/.test(apiPath(e));

/**
 * The owner/repo a `repos/<owner>/<repo>/…` endpoint names. "" where both are
 * gh's placeholders (`{owner}`, `:owner`), which gh fills from the cwd's repo;
 * null where only one is, a repo the caller cannot know.
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

/**
 * Is this the GraphQL endpoint? The URL form is what a copied curl example
 * carries.
 * @param {string} e
 */
const isGraphql = (e) => e === "graphql" || e.endsWith("/graphql");

/**
 * GraphQL names what it writes in the query TEXT rather than in a field name
 * or an endpoint, so a guard has to read that text back out of the span the
 * parser blanked: every `query=` field's text, concatenated, and whether some
 * of it could not be read.
 *
 * Only a field NAMED query is read (mantahostels#284): a value elsewhere in
 * the call that cannot be read is a variable the query already names, and
 * treating it as hidden would fire on a fully visible read query.
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
		/* `@file` and `@-` are gh's own file and stdin spellings. */
		if (field.startsWith("query=@")) hidden = true;
		else if (field.startsWith("query=")) {
			query += `${field.slice("query=".length)} `;
			if (!known) hidden = true;
		} else if (!field.includes("=") && !known) hidden = true;
	}
	return { query, hidden };
}

/**
 * The named mutation's OWN arguments, read out of `query`: the text from its
 * opening bracket to the first close. Null where the query names no such
 * mutation.
 *
 * Whitespace goes first, GraphQL ignoring it. Scoping to the arguments is
 * what separates a write from a read: the same token after that bracket
 * closes is a selection on the result, not an input field.
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
	defaultsToPost,
	isIssueEndpoint,
	isIssueCollection,
	endpointRepo,
	isGraphql,
	scanGraphql,
	mutationArgs,
};
