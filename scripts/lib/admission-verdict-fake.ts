/*
 * The `admission.js --json --launch --skip-allowance` verdict
 * refill-loop-run.test.ts's admission stub prints, held to what the real
 * script prints by lib/admission-verdict.contract.test.ts (#3331). Its
 * `satisfies` holds it to every field lib/concurrency.js reads, so dropping
 * one fails typecheck, not the run test's loop; `memory` carries only the
 * rows' recorded figures, so only its presence is held. The stub swaps in its
 * case's `slots`. The live draw is the largest holder, as the run test asserts.
 */

import type { AdmissionJson } from "./admission.js";

export const ADMISSION_VERDICT = {
	ok: true,
	slots: 1,
	availableMb: 4000,
	budgetMb: 2800,
	drawNeedMb: 1500,
	nextNeedMb: 2400,
	reservedMb: 106,
	landerMb: 0,
	floorMb: 794,
	marginMb: 300,
	memorySlots: 1,
	/* What admission.js prints in the contract test's fixture: its 0.5
	 * loadavg (admission-testkit.ts), and no session ceiling set. */
	load: { overloaded: false, load1: 0.5, ceiling: 24 },
	cpu: {
		ceiling: null,
		sessions: 0,
		idleSpares: 0,
		slots: null,
		full: false,
		unknown: null,
	},
	memory: {
		working: { count: 2, mb: 1200 },
		finished: { count: 0, mb: 0 },
		pool: { mb: 106 },
		other: { mb: 1000 },
		unlisted: { count: 0, mb: 0, dirs: [] },
	},
} satisfies Pick<
	AdmissionJson,
	| "ok"
	| "slots"
	| "availableMb"
	| "budgetMb"
	| "drawNeedMb"
	| "nextNeedMb"
	| "reservedMb"
	| "landerMb"
	| "floorMb"
	| "marginMb"
	| "memorySlots"
	| "load"
	| "cpu"
> & { memory: object };
