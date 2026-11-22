const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { budgetMs } = require("./hook-deadline.js");

const STORE = path.join(__dirname, "arbiter-store.js");

// guess, #2788
const LEDGER_TIMEOUT_MS = 3000;

const RECORD =
	"require(process.argv[1])[process.argv[2]](process.argv[3], process.argv[4])";

/** @returns {typeof import("./arbiter-store.js")} */
const store = () => require(STORE);

function buildHostPorts() {
	let wedged = false;
	/**
	 * @param {"recordWrite" | "recordSelect"} fn
	 * @param {string} rel
	 * @param {string} session
	 */
	const record = (fn, rel, session) => {
		if (wedged) throw new Error(`${fn} skipped — the claim store hung`);
		const r = spawnSync(
			process.execPath,
			["-e", RECORD, STORE, fn, rel, session],
			{
				stdio: "ignore",
				timeout: budgetMs(LEDGER_TIMEOUT_MS),
				killSignal: "SIGKILL",
			},
		);
		if (
			r.error &&
			/** @type {NodeJS.ErrnoException} */ (r.error).code === "ETIMEDOUT"
		) {
			wedged = true;
			throw new Error(`${fn} timed out on ${rel}`);
		}
		if (r.status !== 0)
			throw new Error(
				`${fn} exited ${r.status ?? r.signal ?? r.error?.message} on ${rel}`,
			);
	};
	return {
		/** @returns {import("./arbiter-store").ListedLock[] | null} */
		listLocks: () => store().listLocks(),
		/** @param {string} p */
		claimKey: (p) => store().claimKey(p),
		/** @param {string} rel */
		isWarned: (rel) => store().isWarned(rel),
		/** @param {string} a @param {string} b */
		subjectsOverlap: (a, b) => store().subjectsOverlap(a, b),
		/** @param {string} rel @param {string} session */
		recordWrite: (rel, session) => record("recordWrite", rel, session),
		/** @param {string} rel @param {string} session */
		recordSelect: (rel, session) => record("recordSelect", rel, session),
		now: () => Date.now(),
	};
}

module.exports = { buildHostPorts };
