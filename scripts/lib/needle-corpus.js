const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { isUnder } = require("./is-under.js");
const { isCollectedTestOrConftest } = require("./test-kind.js");

const CORPUS_DIRS = [
	"scripts",
	".husky",
	path.join(".claude", "skills"),
	path.join("docs", "agents", "rules"),
];

const REGISTRY_REL = path.join("scripts", "guard-fire-needles.json");

/**
 * @typedef {{key: string, id: string, text: string}} NeedleText
 * @typedef {NeedleText & {arriving: boolean}} BrokenNeedle
 * @typedef {{broken: BrokenNeedle[], failOpen: string | null}} Drift
 * @typedef {any} RegistryEntry
 */
/**
 * @template T
 * @typedef {{value: T} | {drift: Drift}} Step
 */

/**
 * @param {string} rel
 * @returns {boolean}
 */
function isTestAtPlatformPath(rel) {
	return isCollectedTestOrConftest(rel.split(path.sep).join("/"));
}

/**
 * @param {string} root
 * @returns {Map<string, string>}
 */
function corpusFiles(root) {
	/** @type {Map<string, string>} */
	const out = new Map();
	for (const d of CORPUS_DIRS) walkCorpus(root, path.join(root, d), out);
	return out;
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {Map<string, string>} out
 */
function walkCorpus(root, dir, out) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		if (caught(e).code === "ENOENT") return;
		throw e;
	}
	for (const e of entries) {
		if (e.name === "node_modules" || e.name === "__pycache__") continue;
		const p = path.join(dir, e.name);
		if (e.isSymbolicLink() && !isLinkedFile(p)) continue;
		if (e.isDirectory()) {
			walkCorpus(root, p, out);
			continue;
		}
		readCorpusFile(root, p, out);
	}
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isLinkedFile(p) {
	try {
		return fs.statSync(p).isFile();
	} catch (e) {
		if (caught(e).code === "ENOENT") return false;
		throw e;
	}
}

/**
 * @param {string} root
 * @param {string} p
 * @param {Map<string, string>} out
 */
function readCorpusFile(root, p, out) {
	const rel = path.relative(root, p);
	if (rel === REGISTRY_REL || isTestAtPlatformPath(rel)) return;
	try {
		out.set(rel, fs.readFileSync(p, "utf8"));
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
	}
}

/**
 * @param {Record<string, any> | null | undefined} registry
 * @returns {NeedleText[]}
 */
function needleTexts(registry) {
	/** @type {NeedleText[]} */
	const out = [];
	for (const section of ["guards", "candidates"]) {
		const entries = registry?.[section];
		if (!entries || typeof entries !== "object") continue;
		for (const [key, entry] of Object.entries(entries))
			out.push(...entryTexts(key, entry));
	}
	return out;
}

/**
 * @param {string} key
 * @param {RegistryEntry} entry
 * @returns {NeedleText[]}
 */
function entryTexts(key, entry) {
	/** @type {NeedleText[]} */
	const out = [];
	for (const n of entry?.needles ?? [])
		for (const t of [
			...(Array.isArray(n.text) ? n.text : [n.text]),
			...(n.unless ?? []),
		])
			if (typeof t === "string" && t) out.push({ key, id: n.id, text: t });
	return out;
}

/**
 * @param {{root: string, landing: string[], readHead: (rel: string) => string | null, readLanding?: ((rel: string) => string | null) | null}} arg
 * @returns {Drift}
 */
function needleDrift({ root, landing, readHead, readLanding = null }) {
	const landsRegistry = landing.includes(REGISTRY_REL);

	const after = readAfterCorpus(root, landing, readLanding);
	if ("drift" in after) return after.drift;
	const headText = readHeadCorpusText(landing, readHead);
	if ("drift" in headText) return headText.drift;

	const afterBytes = landsRegistry
		? readLandingRegistryBytes(root, readLanding)
		: readHeadRegistryBytes(readHead);
	if ("drift" in afterBytes) return afterBytes.drift;
	const registryAfter = readRegistry(() => afterBytes.value);
	if (registryAfter.error)
		return bail(`could not read ${REGISTRY_REL}: ${registryAfter.error}`);

	/** @type {Step<Set<string>>} */
	const added = landsRegistry
		? addedNeedles(readHead, registryAfter.value)
		: { value: new Set() };
	if ("drift" in added) return added.drift;

	const afterText = [...after.value.values()].join("\n");
	return {
		broken: brokenNeedles(
			registryAfter.value,
			afterText,
			headText.value,
			added.value,
		),
		failOpen: null,
	};
}

/**
 * @param {Record<string, RegistryEntry> | null} registry
 * @param {string} afterText
 * @param {string} headText
 * @param {Set<string>} added
 * @returns {BrokenNeedle[]}
 */
function brokenNeedles(registry, afterText, headText, added) {
	/** @type {BrokenNeedle[]} */
	const broken = [];
	for (const n of needleTexts(registry)) {
		if (afterText.includes(n.text)) continue;
		const printedBefore = headText.includes(n.text);
		if (!printedBefore && !added.has(n.text)) continue;
		broken.push({ ...n, arriving: !printedBefore });
	}
	return broken;
}

/**
 * @param {string} why
 * @returns {Drift}
 */
function bail(why) {
	return { broken: [], failOpen: why };
}

/**
 * @param {string} why
 * @returns {{drift: Drift}}
 */
function bailStep(why) {
	return { drift: bail(why) };
}

/**
 * @returns {{drift: Drift}}
 */
function noNeedles() {
	return { drift: { broken: [], failOpen: null } };
}

/**
 * @param {string} root
 * @param {string[]} landing
 * @param {((rel: string) => string | null) | null} readLanding
 * @returns {Step<Map<string, string>>}
 */
function readAfterCorpus(root, landing, readLanding) {
	let after;
	try {
		after = corpusFiles(root);
	} catch (e) {
		return bailStep(
			`could not read the source corpus under ${root}: ${caught(e).message}`,
		);
	}
	if (after.size === 0)
		return bailStep(`the source corpus under ${root} is empty`);

	if (readLanding) return readLandingOverlay(after, landing, readLanding);
	return { value: after };
}

/**
 * @param {Map<string, string>} before
 * @param {string[]} landing
 * @param {(rel: string) => string | null} readLanding
 * @returns {Step<Map<string, string>>}
 */
function readLandingOverlay(before, landing, readLanding) {
	const after = new Map(before);
	for (const rel of landing) {
		if (rel === REGISTRY_REL || !inCorpus(rel)) continue;
		let bytes;
		try {
			bytes = readLanding(rel);
		} catch (e) {
			return bailStep(
				`could not read this commit's ${rel}: ${caught(e).message}`,
			);
		}
		if (bytes === null) after.delete(rel);
		else after.set(rel, bytes);
	}
	return { value: after };
}

/**
 * @param {string[]} landing
 * @param {(rel: string) => string | null} readHead
 * @returns {Step<string>}
 */
function readHeadCorpusText(landing, readHead) {
	const headCopies = [];
	for (const rel of landing) {
		if (rel === REGISTRY_REL || !inCorpus(rel)) continue;
		try {
			const head = readHead(rel);
			if (head !== null) headCopies.push(head);
		} catch (e) {
			return bailStep(`could not read HEAD's ${rel}: ${caught(e).message}`);
		}
	}
	return { value: headCopies.join("\n") };
}

/**
 * @param {(rel: string) => string | null} readHead
 * @returns {Step<string>}
 */
function readHeadRegistryBytes(readHead) {
	let bytes;
	try {
		bytes = readHead(REGISTRY_REL);
	} catch (e) {
		return bailStep(
			`could not read HEAD's ${REGISTRY_REL}: ${caught(e).message}`,
		);
	}
	if (bytes === null) return noNeedles();
	return { value: bytes };
}

/**
 * @param {string} root
 * @param {((rel: string) => string | null) | null} readLanding
 * @returns {Step<string>}
 */
function readLandingRegistryBytes(root, readLanding) {
	let bytes;
	try {
		bytes = readLanding
			? readLanding(REGISTRY_REL)
			: fs.readFileSync(path.join(root, REGISTRY_REL), "utf8");
	} catch (e) {
		return bailStep(
			`could not read this commit's ${REGISTRY_REL}: ${caught(e).message}`,
		);
	}
	if (bytes === null) return noNeedles();
	return { value: bytes };
}

/**
 * @param {(rel: string) => string | null} readHead
 * @param {Record<string, RegistryEntry> | null} registryAfter
 * @returns {Step<Set<string>>}
 */
function addedNeedles(readHead, registryAfter) {
	/** @type {string | null} */
	let headBytes;
	try {
		headBytes = readHead(REGISTRY_REL);
	} catch (e) {
		return bailStep(
			`could not read HEAD's ${REGISTRY_REL}: ${caught(e).message}`,
		);
	}
	if (headBytes === null) return { value: new Set() };
	const bytes = headBytes;
	const registryBefore = readRegistry(() => bytes);
	if (registryBefore.error)
		return bailStep(
			`could not read HEAD's ${REGISTRY_REL}: ${registryBefore.error}`,
		);
	const had = new Set(needleTexts(registryBefore.value).map((n) => n.text));
	return {
		value: new Set(
			needleTexts(registryAfter)
				.map((n) => n.text)
				.filter((t) => !had.has(t)),
		),
	};
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
function inCorpus(rel) {
	if (isTestAtPlatformPath(rel)) return false;
	return isUnder(rel, CORPUS_DIRS, path.sep);
}

/**
 * @param {() => string} read
 * @returns {{value: Record<string, any> | null, error: string | null}}
 */
function readRegistry(read) {
	try {
		return { value: JSON.parse(read()), error: null };
	} catch (e) {
		return { value: null, error: caught(e).message };
	}
}

module.exports = {
	CORPUS_DIRS,
	needleDrift,
};
