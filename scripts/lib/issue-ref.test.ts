// @vitest-environment node
/*
 * scanIssueRefs against the three regexes it replaced (#3477).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HANG_TIMEOUT_MS } from "./stop-guard-testkit";

interface ScannedRef {
	text: string;
	index: number;
	owner: string | null;
	name: string | null;
	number: number;
}
const { REF_FORMS, SECTION, scanIssueRefs } = require("./issue-ref.js") as {
	REF_FORMS: Record<"identifier" | "citation" | "blocker", object>;
	SECTION: RegExp;
	scanIssueRefs: (text: string, form: object) => ScannedRef[];
};

/* Each caller's regex as #3383 left it. */
const ARM_SECONDARY =
	/(?:(?<![\w.&/-])|(?<=[&/]\w*[.-])|(?<=#\d+[.-])|(?<=§[A-Z]?\d+(?:\.\d+)*(?:-|\.(?!\d)|[A-Za-z_]\w*[.-])))(?:[\w.-]+)?#\d+\b|§[A-Z]?\d+(?:\.\d+)*/g;
const CLOSE_RIVALS =
	/(?:(?:(?<![\w.&{$-])|(?<=[&{$]\w*[.-])|(?<=#\d+[.-]))[\w.-]+\/[\w.-]+|(?:(?<![\w&{$-])|(?<=[&{$]\w*-)|(?<=#\d+-))[\w-]+|(?<![\w&{$]))#\d+(?!\w)/g;
const PROSE_BLOCKERS =
	/(?:(?:(?<![\w.-])|(?!\d)(?<=#\d+))([\w.-]+\/[\w.-]+))?#(\d+)/g;

/** arm-secondary's identifiers: issue refs and sections, in text order. */
const armIdentifiers = (text: string) =>
	[
		...scanIssueRefs(text, REF_FORMS.identifier),
		...[...text.matchAll(SECTION)].map((m) => ({ text: m[0], index: m.index })),
	]
		.sort((a, b) => a.index - b.index)
		.map(({ text: t, index }) => ({ text: t, index }));

/** What a `#n` regex finds, in the scanner's shape. */
const citeRefs = (text: string, re: RegExp) =>
	[...text.matchAll(re)].map((m) => {
		const hash = m[0].lastIndexOf("#");
		const prefix = m[0].slice(0, hash);
		const slash = prefix.indexOf("/");
		return {
			text: m[0],
			index: m.index,
			owner: slash === -1 ? null : prefix.slice(0, slash),
			name: prefix === "" ? null : prefix.slice(slash + 1),
			number: Number(m[0].slice(hash + 1)),
		};
	});

const CASES = {
	"arm-secondary.js": {
		scan: armIdentifiers,
		oracle: (text: string) =>
			[...text.matchAll(ARM_SECONDARY)].map((m) => ({
				text: m[0],
				index: m.index,
			})),
	},
	"close-rivals.js": {
		scan: (text: string) => scanIssueRefs(text, REF_FORMS.citation),
		oracle: (text: string) => citeRefs(text, CLOSE_RIVALS),
	},
	"prose-blockers.js": {
		scan: (text: string) =>
			scanIssueRefs(text, REF_FORMS.blocker).map((r) => ({
				repo: r.owner === null ? null : `${r.owner}/${r.name}`,
				number: r.number,
				index: r.index,
			})),
		oracle: (text: string) =>
			[...text.matchAll(PROSE_BLOCKERS)].map((m) => ({
				repo: m[1] ?? null,
				number: Number(m[2]),
				index: m.index,
			})),
	},
};

const STRUCTURED = [
	"#12",
	"see #12, #13 and other#14.",
	"acme/core#9 acme/core.js#10 a/b/c#11",
	"&abc#1 /x#2 {y#3 $z#4 a.b#5 a-b#6 .c#7 -d#8",
	"#12a #12_ #12. #12-x#13 #1#2#3",
	"§1.2#3 §A1-b#2 §N2 §6.x#4 §1.2.3-y#5",
	"x.y/z/w#1 a/#2 /b#3 a/b/#4 ##5 #",
	"`#12` (#13) [x#14] owner.name/repo-name#15",
];

/* A seeded generator, so a failing input reruns. */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
		return s / 2 ** 32;
	};
}

/* Every character class the forms branch on, plus space and newline. Strings
 * of up to 40 reach three-part prefixes (`a.b/c-d#1`) often; 20,000 of them
 * hit every branch the structured cases name many times over. */
const ALPHABET = "ab9_.-/#&{$§N1 \n`";
const RANDOM = (() => {
	const next = rng(3477);
	return Array.from({ length: 20_000 }, () =>
		Array.from(
			{ length: 1 + Math.floor(next() * 40) },
			() => ALPHABET[Math.floor(next() * ALPHABET.length)],
		).join(""),
	);
})();

describe("scanIssueRefs finds what each caller's regex found", () => {
	for (const [caller, { scan, oracle }] of Object.entries(CASES)) {
		it(`${caller}: the same text, index and groups as its regex on each structured case`, () => {
			for (const text of STRUCTURED)
				expect(scan(text), text).toEqual(oracle(text));
		});

		it(`${caller}: the same text, index and groups as its regex on random strings`, () => {
			for (const text of RANDOM)
				expect(scan(text), JSON.stringify(text)).toEqual(oracle(text));
		});
	}
});

/* Crosses the real clock on purpose: a quadratic read of 40,000 characters
 * takes 12 s or more (HANG_TIMEOUT_MS's measurement). */
describe("scanIssueRefs stays linear", () => {
	it("scans 50,000-character prefix runs in every form before the hang timeout kills it", () => {
		const child = `
const { REF_FORMS, scanIssueRefs } = require(${JSON.stringify(path.join(__dirname, "issue-ref.js"))});
const runs = ["a.", "a/", "a-", "#1.", "§1-", "&a."].map((r) => r.repeat(50000 / r.length));
for (const form of Object.values(REF_FORMS))
	for (const run of runs) scanIssueRefs(run, form);
`;
		const out = spawnSync(process.execPath, ["-e", child], {
			encoding: "utf8",
			timeout: HANG_TIMEOUT_MS,
		});
		expect(out.signal, "the scan ran past HANG_TIMEOUT_MS").toBeNull();
		expect(out.status, out.stderr).toBe(0);
	});
});
