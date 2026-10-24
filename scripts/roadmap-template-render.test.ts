// @vitest-environment node
/*
 * docs/reference-roadmap.html's <script> is a hand copy of the adopter
 * template's, and init-adopter only copies the template (#2294). Masked of
 * the data each repo writes for itself — AREAS, PHASES, ITEMS, CURRENT_PHASE
 * and the template's {{…}} placeholders — the two must be equal byte for
 * byte, so a fix made in one copy alone fails here instead of leaving
 * adopters a render the core no longer runs.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CORE = fs.readFileSync(
	path.resolve(__dirname, "../docs/reference-roadmap.html"),
	"utf8",
);
const TEMPLATE = fs.readFileSync(
	path.resolve(__dirname, "templates/adopter/reference-roadmap.html"),
	"utf8",
);

const DATA_NAMES = ["AREAS", "PHASES", "ITEMS"];
const CURRENT_PHASE_LINE = /^const CURRENT_PHASE = \d+;$/m;
const PLACEHOLDER = /\{\{\w+\}\}/g;

/* Each data block runs from its `const NAME = [` line to the first bare `];`
 * or `};`, and a block that is missing, or whose body holds a top-level
 * `const`, throws naming it, so render code is never masked away or compared
 * unmasked. */
const maskedRenderCode = (html: string) => {
	let code = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
	for (const name of DATA_NAMES) {
		const block = new RegExp(
			`^(const ${name} = [[{])$([\\s\\S]*?)^([\\]}];)$`,
			"m",
		);
		const body = block.exec(code)?.[2];
		if (body === undefined || /^const /m.test(body))
			throw new Error(`no data block for ${name}`);
		code = code.replace(block, "$1\n/* data */\n$3");
	}
	if (!CURRENT_PHASE_LINE.test(code)) throw new Error("no CURRENT_PHASE line");
	return code
		.replace(CURRENT_PHASE_LINE, "const CURRENT_PHASE = 0;")
		.replace(PLACEHOLDER, "{{…}}");
};

describe("the roadmap's render code against its adopter template (#2294)", () => {
	it("differs on no line outside the data blocks and placeholders, a change made to one copy alone failing here", () => {
		expect(maskedRenderCode(CORE)).toBe(maskedRenderCode(TEMPLATE));
	});

	it("tells apart a copy whose render code changed", () => {
		const drifted = TEMPLATE.replace("const KIND_LABEL=", "const KIND_LABELS=");
		expect(drifted).not.toBe(TEMPLATE);
		expect(maskedRenderCode(drifted)).not.toBe(maskedRenderCode(TEMPLATE));
	});

	it("ignores a copy whose ITEMS, PHASES and CURRENT_PHASE alone changed", () => {
		const reData = TEMPLATE.replace('t:"Take the first payment"', 't:"x"')
			.replace('title:"Foundations"', 'title:"x"')
			.replace("const CURRENT_PHASE = 0;", "const CURRENT_PHASE = 2;");
		expect(reData).not.toBe(TEMPLATE);
		expect(maskedRenderCode(reData)).toBe(maskedRenderCode(TEMPLATE));
	});

	it("throws naming a data block it cannot find, or whose close runs into render code", () => {
		expect(() =>
			maskedRenderCode(TEMPLATE.replace("const ITEMS = [", "const CARDS = [")),
		).toThrow("no data block for ITEMS");
		expect(() =>
			maskedRenderCode(TEMPLATE.replace(/^\];$/m, "]; // closed")),
		).toThrow(/no data block for (AREAS|PHASES|ITEMS)/);
	});
});
