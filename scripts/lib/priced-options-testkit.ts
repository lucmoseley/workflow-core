/*
 * priced-options-testkit.ts — what the close-rivals, round-check and
 * research-ladder limb tests share (#1781).
 *
 * The wording is restated here, not read from shape-hold.js or
 * research-ladder.js, so a reworded refusal fails the suites rather than
 * passing them by construction.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { markersDir } = require("./marker-root.js");
const {
	isExemptLimb,
	LIMBS,
	SHAPE_PREFIX,
	limbOf,
} = require("./priced-options-limbs.js");

export const SHAPE_TOO = "Its shape is wrong too: ";
export const LADDER = "the research ladder is not climbed";
export const STILL_WRONG =
	"Q1: re-sent since this check refused it, its shape still wrong: ";
/* A refusal mixing its limb's own flag with a shape fault, then a re-send
 * held on shape alone. */
export const SHAPE_HELD_PASS = "passes only once its shape is right";
export const SHAPE_ONLY_PASS =
	"It passes on its next send once its shape is right.";
export const SHAPE_CAP: number = limbOf(SHAPE_PREFIX).cap;
/* The checks the ceiling's notices name, read from their rows (#2062). */
export const EXEMPT_NAMES: string[] = LIMBS.filter(isExemptLimb).map(
	(limb: { name: string }) => limb.name,
);

/**
 * Read and seed one session's guard counters under a test's root, both read
 * at call time since a test sets them in `beforeEach`.
 */
export function sessionCounters(where: () => { dir: string; sid: string }) {
	const at = (prefix: string) => {
		const { dir, sid } = where();
		return path.join(markersDir(dir), `${prefix}${sid}`);
	};
	return {
		/** A counter's value this session, 0 where it is unwritten. */
		counter: (prefix: string) => {
			try {
				return Number(fs.readFileSync(at(prefix), "utf8"));
			} catch {
				return 0;
			}
		},
		seed: (prefix: string, n: number) => {
			fs.mkdirSync(path.dirname(at(prefix)), { recursive: true });
			fs.writeFileSync(at(prefix), `${n}\n`);
		},
	};
}

/**
 * Run `body` with every require of the library `lib` throwing. No temp dir or
 * env var makes a first-party require throw, so the loader is patched; the
 * guard runs in process, its modules purged.
 */
export function withUnloadable(lib: string, body: () => void) {
	const Module = require("node:module");
	const load = Module._load;
	const name = new RegExp(`(^|/)${lib}(\\.js)?$`);
	Module._load = function (request: string, ...rest: unknown[]) {
		if (name.test(request)) throw new Error(`${lib} will not load`);
		return load.call(this, request, ...rest);
	};
	try {
		body();
	} finally {
		Module._load = load;
	}
}
