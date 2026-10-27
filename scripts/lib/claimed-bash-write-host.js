/*
 * claimed-bash-write-host.js — the production ports lib/claimed-bash-write.js
 * reads through the dispatcher (#2788): the claim store's locks, its reading
 * of a path, the write and selection ledgers it appends to, and the clock. The
 * store loads on first use, so a Bash call writing nothing pays nothing.
 *
 * THE TWO LEDGER WRITES RUN AS THEIR OWN PROCESS, the reads in process. A write
 * creates the store's directories, and under an unreadable /proc path
 * mkdirSync blocks forever on this kernel rather than raising — a hang only
 * killable from outside (mantahostels#175). Unbounded, it would run the
 * dispatcher into its 10 s entry timeout, whose `block` refuses the Bash
 * call. LEDGER_TIMEOUT_MS, cut to what the entry's budget leaves
 * (lib/hook-deadline.js), bounds each write far above the ~80 ms a real one
 * takes, and the first timeout fails every later write at once, so a
 * command crediting many paths still returns inside the entry's 10 s. A
 * failed write throws, which the core logs and passes.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { budgetMs } = require("./hook-deadline.js");

const STORE = path.join(__dirname, "arbiter-store.js");

const LEDGER_TIMEOUT_MS = 3000;

/** The child: the store's named ledger writer over one path and session. */
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
		relativeToRepo: (p) => store().relativeToRepo(p),
		/** @param {string} rel */
		isGuarded: (rel) => store().isGuarded(rel),
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
