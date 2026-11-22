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
export const SHAPE_HELD_PASS = "passes only once its shape is right";
export const SHAPE_ONLY_PASS =
	"It passes on its next send once its shape is right.";
export const SHAPE_CAP: number = limbOf(SHAPE_PREFIX).cap;
export const EXEMPT_NAMES: string[] = LIMBS.filter(isExemptLimb).map(
	(limb: { name: string }) => limb.name,
);

export function sessionCounters(where: () => { dir: string; sid: string }) {
	const at = (prefix: string) => {
		const { dir, sid } = where();
		return path.join(markersDir(dir), `${prefix}${sid}`);
	};
	return {
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
