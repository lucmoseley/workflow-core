const { ENVELOPE_FRAME_KEYS } = require("./envelope-frame-keys.js");
const {
	OVER_CAP_TAGS,
	CLOSED_TRIGGER,
	SESSION_SURFACE_PREFIX,
	FRAGMENT_SURFACE_PREFIX,
} = require("./context-budget-tags");

const { REFUSES_COMMIT } = require("./refuses-commit.js");
const { PROFILE_GATES: GATES, SITE_IDENTITY } = require("./precommit-gates.js");

const on =
	(/** @type {string[]} */ ...fields) =>
	(/** @type {any} */ item) =>
		JSON.stringify(fields.map((f) => item?.[f] ?? null));

const failsOnly = (/** @type {any} */ item) => item?.severity === "FAIL";

const message = (/** @type {any} */ item) =>
	typeof item?.message === "string" ? item.message : JSON.stringify(item);

/**
 * @param {(item: unknown) => string} identity
 * @returns {import("./fault-diff").FaultDiffProfile}
 */
const findingsProfile = (identity) => ({
	keys: (key) => key === "findings",
	identity,
	gating: failsOnly,
	label: message,
});

const DOC_MAP_NOT_A_FAULT = new Set([
	...ENVELOPE_FRAME_KEYS,
	"unreached",
	"untracked",
	"untrackedRoutes",
]);

/** @type {Record<string, (envelope: any) => number | undefined>} */
const SURFACE_TOTAL = {
	pool: (envelope) => envelope?.total,
	injection: (envelope) => envelope?.injection?.total,
	"rule-ratchet": (envelope) => envelope?.session?.ratchet?.total,
};

/**
 * @param {unknown} surface
 * @param {any} envelope
 * @returns {number | undefined}
 */
function surfaceTotal(surface, envelope) {
	if (typeof surface !== "string") return;
	const fixed = Object.hasOwn(SURFACE_TOTAL, surface)
		? SURFACE_TOTAL[surface]
		: undefined;
	if (fixed) return fixed(envelope);
	if (surface.startsWith(FRAGMENT_SURFACE_PREFIX)) {
		const byId = envelope?.session?.fragmentBytes;
		const id = surface.slice(FRAGMENT_SURFACE_PREFIX.length);
		return byId && Object.hasOwn(byId, id) ? byId[id] : undefined;
	}
	if (!surface.startsWith(SESSION_SURFACE_PREFIX)) return;
	return envelope?.session?.tools?.[
		surface.slice(SESSION_SURFACE_PREFIX.length)
	]?.bytes;
}

/** @type {Record<string, import("./fault-diff").FaultDiffProfile>} */
const GATE_PROFILES = Object.fromEntries(
	GATES.map((g) => [
		g.id,
		findingsProfile(on(...(g.identity ?? SITE_IDENTITY))),
	]),
);

/**
 * @param {string} id
 * @returns {import("./fault-diff").FaultDiffProfile}
 */
function gateProfile(id) {
	const profile = GATE_PROFILES[id];
	if (!profile) throw new Error(`lib/precommit-gates.js has no ${id} row`);
	return profile;
}

/** @type {Record<string, import("./fault-diff").FaultDiffProfile>} */
const PROFILES = {
	...GATE_PROFILES,
	/* workflow-core#2617 */
	"guard-registry": {
		...gateProfile("guard-registry"),
		gating: (/** @type {unknown} */ item) =>
			failsOnly(item) ||
			(typeof item === "object" &&
				item !== null &&
				Object.hasOwn(item, REFUSES_COMMIT) &&
				/** @type {Record<string, unknown>} */ (item)[REFUSES_COMMIT] === true),
	},
	"context-budget": {
		keys: (key) =>
			key === "findings" || key === "admissibility" || key === "unadmitted",
		gating: (/** @type {any} */ item, key) =>
			key === "unadmitted" ||
			(key === "findings" &&
				(item?.severity === "FAIL" || OVER_CAP_TAGS.has(item?.tag))),
		newOnly: (key) => key === "unadmitted",
		indexOnly: (item, key) =>
			key === "findings" &&
			/** @type {{ tag?: unknown } | undefined} */ (item)?.tag ===
				CLOSED_TRIGGER,
		identity: (/** @type {any} */ item, key) => {
			if (key === "unadmitted") return on("key")(item);
			return key === "findings"
				? on("tag", "surface", "total")(item)
				: on("surface", "bytes")(item);
		},
		family: (/** @type {any} */ item, key) => {
			if (key === "unadmitted") return on("key")(item);
			return key === "findings"
				? on("tag", "surface")(item)
				: on("surface")(item);
		},
		worse: (/** @type {any} */ a, /** @type {any} */ b, key) => {
			if (key === "unadmitted") return false;
			return key === "findings" ? a?.total > b?.total : a?.bytes > b?.bytes;
		},
		unit: "B",
		measure: (/** @type {any} */ item, key, /** @type {any} */ envelope) => {
			if (key === "unadmitted") return;
			return key === "findings"
				? surfaceTotal(item?.surface, envelope)
				: envelope?.admissibility?.find(
						(/** @type {any} */ a) => a?.surface === item?.surface,
					)?.bytes;
		},
		label: (/** @type {any} */ item, key) =>
			key === "findings" ? message(item) : String(item?.message ?? ""),
	},
	"doc-map": {
		keys: (key) => !DOC_MAP_NOT_A_FAULT.has(key),
		identity: (item) => JSON.stringify(item),
	},
};

module.exports = { PROFILES };
