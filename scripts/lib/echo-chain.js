/*
 * echo-chain.js — the echo-chain rules (mantahostels#2570): what signs a
 * call, what hashes its answer, which calls are a neighbour's, where an
 * agent's chain lives and the record the store holds. lib/echo-record.js, the
 * PostToolUse core, writes the chain after every Bash and Read call (#2787);
 * lib/echo-call.js, the PreToolUse core, reads it and refuses on it (#2791).
 * Both sign through `callSignature` here, so a call is filed where it is
 * looked up. Pure: the stat, the store and the clock are lib/echo-record-host.js's.
 *
 * WHAT A CHAIN IS. One record per (tool, tool_input) signature — and, for a
 * Read, the file's on-disk state (#1058):
 *
 *   <signature>\t<response hash>\t<run length>\t<unix seconds>\t<denies>
 *
 * `run` is how many times IN A ROW that signature has returned that response
 * hash. A differing response resets it to 1, except a Read's `file_unchanged`
 * short circuit, which extends it (lib/echo-record.js). The guard refuses at
 * run >= 2 — the third call of a command that answered identically twice.
 *
 * NO FIELD IS EVER EMPTY, and `EC_CLEARED` is why: `parseRecords` reads
 * adjacent tabs as one delimiter, so a cleared chain written with an empty
 * hash would read back with the run count in the hash column.
 *
 * WHY THE RESPONSE AND NOT THE INPUT ALONE. Refusing on a repeated INPUT
 * refuses the legitimate repeats — a timed `sleep`/check beat, a re-read after
 * an edit, `free -m` — because they have exactly that shape. Requiring two
 * identical RESPONSES first removes most of those wrong refusals. Requiring
 * three is more accurate still but gives up far more true refusals than the
 * wrong ones it avoids, which is the worse trade.
 *
 * NO PROXIMITY REQUIREMENT. A 5-turn window scores the same accuracy on fewer
 * refusals — it discards true ones without buying accuracy, because the
 * discriminator is response identity and not how recently the call ran. The
 * age bound is state hygiene, not part of the rule (mantahostels#2616).
 *
 * The measured rows, and the population they were measured over, are on
 * mantahostels#2616. `node scripts/measure-echo-chain.js` re-derives them and
 * states its own departures from the deployed guard.
 */

const crypto = require("node:crypto");
const { NOOP, SLEEP } = require("./agent-poll.js");

/* A record older than MAX_AGE_S is dropped, not judged: an hour, a guess
 * never measured, long enough that a repeat within one stretch of work is
 * still judged. MAX_LINES keeps each rewrite of the store near 10 KB (a
 * record is about 50 bytes), a guess never measured. */
const MAX_AGE_S = 3600;
const MAX_LINES = 200;

/** The hash column of a chain the guard has refused on and reset. No real
 * hash collides with it: a sha1 is hex. */
const EC_CLEARED = "-";

/* A volatile key in the response: a duration or a timestamp would differ on
 * every call, every chain would reset at length 1, and the guard would never
 * fire. Dropped by name pattern, not by naming the fields: the payload shape
 * is the harness's, and a field added upstream would disarm it quietly. */
const VOLATILE = /duration|elapsed|timestamp|startTime|endTime|_ms$|Millis/i;

/**
 * True where this call belongs to a NEIGHBOURING guard. lib/agent-poll.js
 * owns two shapes on cadence: a command opening `sleep <n>` (the timed
 * artefact check and the timed job beat) and a command that is nothing but a
 * no-op. Both are byte-identical on every beat by construction, so judging
 * them on repetition would refuse the practice the repo asks for, and a chain
 * nothing reads is work for nothing on every beat.
 * @param {string | undefined} tool
 * @param {string} command
 */
const isNeighbours = (tool, command) =>
	tool === "Bash" && (SLEEP.test(command) || NOOP.test(command));

/** @param {string} text */
const hash24 = (text) =>
	crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 24);

/**
 * A value's compact JSON, keys sorted by their UTF-8 bytes or kept in their
 * order. Sorted, field order is no difference.
 * @param {unknown} value
 * @param {boolean} sortKeys
 * @returns {string}
 */
function canonical(value, sortKeys) {
	/** @type {(v: unknown) => unknown} */
	const order = (v) => {
		if (Array.isArray(v)) return v.map(order);
		if (!v || typeof v !== "object") return v;
		const keys = Object.keys(v);
		if (sortKeys)
			keys.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const k of keys)
			out[k] = order(/** @type {Record<string, unknown>} */ (v)[k]);
		return out;
	};
	return JSON.stringify(order(value));
}

/**
 * The call's signature: the tool, a unit separator and the input — and, for
 * a Read, a second separator and its file's on-disk state (#1058),
 * `inode:size:mtime:ctime` to the nanosecond, or null where the file is
 * missing or unreadable, which signs on the input alone. The separator keeps
 * a Bash command from colliding with a Read of the same bytes.
 * @param {string} tool
 * @param {unknown} input the payload's tool_input
 * @param {string | null} fileState
 */
function signature(tool, input, fileState) {
	const signed = canonical(
		input === null || input === undefined || input === false ? {} : input,
		true,
	);
	return hash24(
		`${tool}\x1f${signed}${fileState === null ? "" : `\x1f${fileState}`}`,
	);
}

/**
 * The call's signature as both cores take it, a Read's file stated through
 * the `fileState` port.
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {(file: string) => string | null} fileState
 */
function callSignature(tool, input, fileState) {
	const file = input.file_path;
	return signature(
		tool,
		input,
		tool === "Read" && typeof file === "string" ? fileState(file) : null,
	);
}

/**
 * The answer's hash, or null where the payload carried
 * none. A missing response is not an empty one: hashing an absent field would
 * give every such call the same hash and arm a refusal on no evidence.
 * @param {unknown} r the payload's tool_response
 */
function responseHash(r) {
	if (r === undefined || r === null) return null;
	const projected =
		r && typeof r === "object" && !Array.isArray(r)
			? Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.test(k)))
			: r;
	return hash24(canonical(projected, false));
}

/**
 * The chain's store name for one agent, `<session>.<agent>`: PER AGENT, NOT
 * PER SESSION (#1004), since a subagent's payload carries its parent's
 * session_id. Both halves are lib/guard-entry.js's agentKey, already path
 * segments, so the dot joining them cannot collide two pairs into one file.
 * @param {{ agent: string, sid: string }} key
 */
const chainName = (key) => `${key.sid}.${key.agent}`;

/**
 * @typedef {{ sig: string, hash: string, run: number, at: number,
 *   denies: number }} ChainRecord one line of the store:
 *   `<sig>\t<hash>\t<run>\t<unix seconds>\t<denies>`
 */

/**
 * The store's records, a malformed or expired one dropped.
 * @param {string} text
 * @param {number} now unix seconds
 * @returns {ChainRecord[]}
 */
function parseRecords(text, now) {
	/** @type {ChainRecord[]} */
	const out = [];
	for (const line of text.split("\n")) {
		const [sig = "", hash = "", run = "", at = "", denies = ""] =
			line.split(/\t+/);
		if (!/^\d+$/.test(run) || !/^\d+$/.test(at) || !/^\d+$/.test(denies))
			continue;
		if (now - Number(at) >= MAX_AGE_S) continue;
		out.push({
			sig,
			hash,
			run: Number(run),
			at: Number(at),
			denies: Number(denies),
		});
	}
	return out;
}

/**
 * The signature's live record in the store's text, or null.
 * @param {string} text
 * @param {string} sig
 * @param {number} now unix seconds
 */
const lookup = (text, sig, now) =>
	parseRecords(text, now).find((r) => r.sig === sig) ?? null;

/**
 * The store with `next` in place of its signature's record, the newest
 * MAX_LINES kept.
 * @param {ChainRecord[]} records
 * @param {ChainRecord} next
 */
function storeText(records, next) {
	const kept = [...records.filter((r) => r.sig !== next.sig), next].slice(
		-MAX_LINES,
	);
	return kept
		.map((r) => `${r.sig}\t${r.hash}\t${r.run}\t${r.at}\t${r.denies}\n`)
		.join("");
}

module.exports = {
	EC_CLEARED,
	MAX_AGE_S,
	MAX_LINES,
	callSignature,
	chainName,
	isNeighbours,
	lookup,
	parseRecords,
	responseHash,
	signature,
	storeText,
};
