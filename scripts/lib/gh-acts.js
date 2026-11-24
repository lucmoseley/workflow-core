const {
	apiPath,
	defaultsToPost,
	endpointRepo,
	scanApi,
} = require("./gh-api-call.js");
const { bodyFileWord, bodyWord, newBody } = require("./gh-body.js");
const {
	ISSUE_VALUE_FLAGS,
	isGh,
	issueWord,
	repoOf,
	sessionOf,
} = require("./gh-issue-ref.js");
const { buildAct } = require("./act-line.js");
const { hasRoundMarker } = require("./round-marker.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { literal, scanFlags } = require("./shell-words.js");

/**
 * @typedef {object} ActsPorts
 * @property {Record<string, unknown>} payload
 * @property {string} envSession
 * @property {string} home
 * @property {(dir: string) => string} originUrl
 * @property {(path: string) => string | undefined} readFile
 * @property {(act: string, sessionId: string) => void} recordAct
 * @typedef {import("./kit-context.js").KitContext & ActsPorts} ActsContext
 */

const NO_POST = new Set([
	"--edit-last",
	"--delete-last",
	"-e",
	"--editor",
	"-w",
	"--web",
]);

const BLOCKED_BY =
	/^repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/dependencies\/blocked_by$/;

/**
 * @typedef {object} IssueCall
 * @property {string} repo
 * @property {string[]} issues
 * @property {string[]} takes
 * @property {boolean} blocked
 * @property {boolean} noPost
 * @property {import("./gh-body.js").Body} body
 */

/**
 * @param {IssueCall & { flagRepo: string, sub: string }} call
 * @param {string} name
 * @param {string} value
 * @param {import("./gh-body.js").BodyEnv} env
 */
function readOpt(call, name, value, env) {
	const lit = literal(value, env.spans);
	if (name === "-R" || name === "--repo") {
		if (lit.known) call.flagRepo = repoOf(lit.text);
	} else if (name === "--add-label") {
		if (lit.known)
			call.takes.push(...lit.text.split(",").filter((p) => /^takes:./.test(p)));
	} else if (name === "--add-blocked-by") call.blocked = true;
	else if (call.sub === "comment" && (name === "-b" || name === "--body"))
		bodyWord(call.body, value, env.spans);
	else if (call.sub === "comment" && (name === "-F" || name === "--body-file"))
		bodyFileWord(call.body, value, env);
}

const COMMENT_SPELLING = {
	subcmd: "issue[ \\t\\n\\v\\f\\r]+comment",
	what: "gh issue comment",
};

/**
 * @param {"close" | "comment" | "edit"} sub
 * @param {string[]} args
 * @param {import("./gh-body.js").BodyEnv} env
 * @returns {IssueCall}
 */
function readIssueCall(sub, args, env) {
	let urlRepo = "";
	const call = {
		repo: "",
		flagRepo: "",
		sub,
		/** @type {string[]} */
		issues: [],
		/** @type {string[]} */
		takes: [],
		blocked: false,
		noPost: false,
		body: newBody(),
	};
	scanFlags(ISSUE_VALUE_FLAGS[sub], args, (kind, name, value) => {
		if (kind === "opt") readOpt(call, name, value, env);
		else if (kind === "flag" && NO_POST.has(name)) call.noPost = true;
		else if (kind === "arg") {
			const ref = issueWord(value, env.spans);
			if (!ref) return;
			if (ref.repo) urlRepo = ref.repo;
			call.issues.push(ref.number);
		}
	});
	call.repo = call.flagRepo || urlRepo;
	return call;
}

/**
 * @param {string[]} args
 * @param {string[]} spans
 * @param {() => string} cwdRepo
 */
function blockedByPost(args, spans, cwdRepo) {
	const call = scanApi(args, spans);
	const method = literal(call.method, spans);
	if (!method.known) return null;
	if (
		method.text === ""
			? !defaultsToPost(call)
			: method.text.toUpperCase() !== "POST"
	)
		return null;
	const endpoint = literal(call.endpoint, spans);
	if (!endpoint.known) return null;
	const n = BLOCKED_BY.exec(apiPath(endpoint.text))?.[3];
	if (n === undefined) return null;
	const repo = endpointRepo(endpoint.text);
	if (repo === null) return null;
	const named = repo || cwdRepo();
	return named ? { repo: named, n } : null;
}

/**
 * @param {string} output
 * @param {string} named
 */
function isAlreadyClosed(output, named) {
	const at = output.indexOf(named);
	return (
		at >= 0 && output.slice(at + named.length).includes("is already closed")
	);
}

/**
 * @param {"close" | "comment" | "edit"} sub
 * @param {IssueCall} call
 * @param {string} output
 * @returns {{ act: string, body?: string }[]}
 */
function issueActs(sub, call, output) {
	const { repo, issues, body } = call;
	if (sub === "close")
		return issues
			.filter((n) => !isAlreadyClosed(output, `${repo}#${n} `))
			.map((n) => ({ act: buildAct("close", repo, n) }));
	if (sub === "comment")
		return call.noPost || body.hidden || !body.given
			? []
			: issues.map((n) => ({
					act: buildAct("round", repo, n),
					body: body.text,
				}));
	return issues.flatMap((n) => [
		...call.takes.map((t) => ({ act: buildAct("relabel", repo, n, t) })),
		...(call.blocked ? [{ act: buildAct("block", repo, n) }] : []),
	]);
}

/**
 * @param {import("./shell-parse.js").Command} cmd
 * @param {{ subject: string, spans: string[], output: string, ctx: ActsContext }} at
 * @returns {{ act: string, body?: string }[]}
 */
function commandActs({ words, cwd }, { subject, spans, output, ctx }) {
	if (!isGh(words)) return [];
	const cwdRepo = () => repoOf(ctx.originUrl(cwd || ctx.fallbackCwd));
	if (words[1] === "api") {
		const edge = blockedByPost(words.slice(2), spans, cwdRepo);
		return edge ? [{ act: buildAct("block", edge.repo, edge.n) }] : [];
	}
	const sub = words[2];
	if (
		words[1] !== "issue" ||
		(sub !== "close" && sub !== "comment" && sub !== "edit")
	)
		return [];
	const call = readIssueCall(sub, words.slice(3), {
		spans,
		subject,
		...COMMENT_SPELLING,
		cwd,
		home: ctx.home,
		readFile: ctx.readFile,
	});
	if (call.body.fault) ctx.log(`${call.body.fault} — no round recorded`);
	call.repo ||= cwdRepo();
	return call.repo ? issueActs(sub, call, output) : [];
}

/** @param {Record<string, unknown>} payload */
function callOutput(payload) {
	const r = /** @type {{ stdout?: unknown, stderr?: unknown }} */ (
		payload.tool_response ?? {}
	);
	const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
	return `${text(r.stdout)}\n${text(r.stderr)}`;
}

/**
 * @param {string} subject
 * @param {ActsContext} ctx
 * @returns {null}
 */
function decide(subject, ctx) {
	if ((ctx.tool ?? "Bash") !== "Bash") return null;
	const sessionId = sessionOf(ctx);
	if (!sessionId) return null;
	const output = callOutput(ctx.payload);
	const parsed = parseCommand(subject);
	walkCommands(
		parsed,
		(cmd) => {
			const at = { subject, spans: parsed.spans, output, ctx };
			for (const { act, body } of commandActs(cmd, at))
				if (body === undefined || hasRoundMarker(body))
					ctx.recordAct(act, sessionId);
		},
		ctx,
	);
	return null;
}

module.exports = { COMMENT_SPELLING, decide, readIssueCall };
