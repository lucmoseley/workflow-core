import type { AdmissionJson } from "./admission.js";

export const ADMISSION_VERDICT = {
	ok: true,
	slots: 1,
	availableMb: 4000,
	budgetMb: 2800,
	drawNeedMb: 1500,
	nextNeedMb: 2400,
	reservedMb: 106,
	held: [
		{ field: "landerMb", mb: 0, holding: "the lander's suite", term: "lander" },
		{ field: "gateMb", mb: 0, holding: "the gate seat", term: "gate seat" },
	],
	landerMb: 0,
	gateMb: 0,
	typecheckReserveMb: 0,
	windowsChargeMb: 0,
	windowsCapped: false,
	testsHeld: 0,
	guestFreeMb: 0,
	windows: { state: "absent" },
	floorMb: 794,
	marginMb: 300,
	memorySlots: 1,
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
		live: { count: 2, mb: 1200 },
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
	| "held"
	| "landerMb"
	| "gateMb"
	| "typecheckReserveMb"
	| "windowsChargeMb"
	| "windowsCapped"
	| "testsHeld"
	| "guestFreeMb"
	| "windows"
	| "floorMb"
	| "marginMb"
	| "memorySlots"
	| "load"
	| "cpu"
> & { memory: object };
