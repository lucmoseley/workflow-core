// @vitest-environment node
/*
 * The contract lib/push-review-fake.js keeps with lib/push-review.js (#2785,
 * §G7): each answer the fake serves is the shape and verdict the real adapter
 * gives in the situation the answer names. Only the situation's own values —
 * the files, the start point — differ.
 */

import { describe, expect, it } from "vitest";
import { code, PAST_FLOOR, reviewFixture } from "./push-review-fixture";

const { ANSWERS } = require("./push-review-fake.js") as {
	ANSWERS: Record<string, Record<string, string> | null>;
};

const { f, commitBy, marker, declareRls, owed } = reviewFixture();

/** An answer less the values its situation sets. */
const verdict = (o: Record<string, string> | null) =>
	o && { ...o, files: "<files>", base: "<base>" };

const SITUATIONS: Record<string, () => void> = {
	none: () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		marker(`base=${f.base}\nfindings=3\n`);
	},
	standard: () => commitBy("scripts/mine.ts", code(PAST_FLOOR)),
	escalated: () => {
		declareRls();
		commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
	},
	rejected: () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		marker("base=main\nfindings=3\n");
	},
	rejectedEscalated: () => {
		declareRls();
		commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
		marker(`base=${f.base}\nfindings=3\ntier=standard\n`);
	},
};

describe("the fake answers as the adapter does", () => {
	it("names a situation for every answer it serves", () => {
		expect(Object.keys(SITUATIONS).sort()).toEqual(Object.keys(ANSWERS).sort());
	});

	it.each(Object.keys(SITUATIONS))("%s", (answer) => {
		SITUATIONS[answer]?.();
		expect(verdict(owed())).toEqual(verdict(ANSWERS[answer] ?? null));
	});
});
