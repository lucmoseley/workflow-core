// @vitest-environment node

import { describe, expect, it } from "vitest";

const { scanSource } = require("./website-copy.js");

const dashed = (src: string) =>
	scanSource(src)
		.filter((h: { tag: string }) => h.tag === "EM-DASH")
		.map((h: { context: string }) => h.context);
const tags = (src: string) =>
	scanSource(src).map((h: { tag: string }) => h.tag);

describe("what counts as copy", () => {
	it("takes a double- and single-quoted string literal", () => {
		expect(dashed('const a = "a sentence — of copy";')).toEqual([
			"a sentence — of copy",
		]);
		expect(dashed("const a = 'a sentence — of copy';")).toEqual([
			"a sentence — of copy",
		]);
	});

	it("takes JSX text between tags", () => {
		expect(dashed("<p>The better way — to find hostels.</p>")).toEqual([
			"The better way — to find hostels.",
		]);
	});

	it("takes both halves of a template literal around an interpolation", () => {
		const D = "$";
		expect(
			dashed(`const t = \`Best hostels — in ${D}{place.name} today — now\`;`),
		).toEqual(["Best hostels — in", "today — now"]);
	});

	it("ignores line and block comments", () => {
		expect(dashed("// a comment — with an em dash\n")).toEqual([]);
		expect(dashed("/* a comment — with an em dash */")).toEqual([]);
	});

	it("does not let an apostrophe in a comment swallow the file", () => {
		expect(
			dashed("// don't panic — it's fine\nconst c = \"clean — copy\";\n"),
		).toEqual(["clean — copy"]);
	});

	it("ignores a JSX block comment between two elements", () => {
		expect(
			dashed("<p>a copy — line</p>{/* a note — with a dash */}<p>b — c</p>"),
		).toEqual(["a copy — line", "b — c"]);
	});

	it("does not read a comment marker inside a string literal", () => {
		expect(
			dashed('const s = "https://x.test"; const c = "real — copy here";'),
		).toEqual(["real — copy here"]);
	});

	it("ignores import and require specifiers", () => {
		expect(
			dashed('import { Manta } from "@/app/_components/Manta — x";'),
		).toEqual([]);
		expect(dashed('const p = require("./showcase — helper");')).toEqual([]);
	});

	it("ignores identifier-carrying attributes", () => {
		expect(
			dashed('<a className="btn — coral" href="/best — hostels">x — y</a>'),
		).toEqual(["x — y"]);
	});

	it("ignores an import specifier that is not token-shaped", () => {
		expect(dashed('import "./brand — notes.css";')).toEqual([]);
	});

	it("keeps a content attribute", () => {
		expect(dashed('<meta content="Find hostels — in Ostria." />')).toEqual([
			"Find hostels — in Ostria.",
		]);
	});

	it("ignores a token-shaped string wherever it sits", () => {
		expect(tags('const slug = "must-visit";')).toEqual([]);
		expect(tags('const c = "a must-visit";')).toEqual(["TRAVEL-CLICHE"]);
	});

	it("does not let a regex literal swallow the string after it", () => {
		expect(dashed('const re = /"/;\nconst c = "Busy — cheap";\n')).toEqual([
			"Busy — cheap",
		]);
	});

	it("does not read a regex body as copy", () => {
		expect(dashed('const re = /"a — b"/;')).toEqual([]);
	});

	it("does not read a JSX closing tag as a regex", () => {
		expect(dashed("<p>a copy — line</p><p>and another — here</p>")).toEqual([
			"a copy — line",
			"and another — here",
		]);
	});

	it("does not let an apostrophe in JSX text swallow the file", () => {
		expect(
			dashed('<p>don\'t miss — it</p>\nconst c = "Busy — cheap";\n'),
		).toEqual(["don't miss — it", "Busy — cheap"]);
	});

	it("keeps an object value whose key shares a JSX attribute name", () => {
		expect(dashed('const p = { name: "Velmora — the hub" };')).toEqual([
			"Velmora — the hub",
		]);
	});

	it("keeps a one-word string containing a curly apostrophe", () => {
		expect(tags("const s = 'don’t';")).toEqual(["CURLY-QUOTE"]);
	});
});

describe("scanSource", () => {
	const copy = (s: string) => `const c = ${JSON.stringify(s)};`;

	it.each([
		["Velmora is a tapestry of surf culture.", "AI-VOCAB"],
		["The interplay of surf and cafes.", "AI-VOCAB"],
		["Velmora serves as Ostria's hub.", "COPULA"],
		["The hostel boasts a pool.", "COPULA"],
		["A pool and a bar, ensuring a good stay.", "ING-TAIL"],
		["It is not just a hostel, it's a home.", "NEG-PARALLEL"],
		["Experts believe Ostria is crowded.", "VAGUE-ATTRIBUTION"],
		["Book now \u{1F30A}", "EMOJI"],
		["Don’t miss it.", "CURLY-QUOTE"],
		["Busy and social — and cheap.", "EM-DASH"],
		["Here's the thing about Velmora.", "FILLER"],
		["It turns out the beach is closer.", "FILLER"],
		["When it comes to price, we are direct.", "FILLER"],
		["In today's market, book direct.", "FILLER"],
		["Direct booking is a game-changer.", "FILLER"],
		["We lean into honest reviews.", "FILLER"],
		["We double down on honest reviews.", "FILLER"],
		["A paradise for beginner surfers.", "TRAVEL-CLICHE"],
		["A hostel nestled above the beach.", "TRAVEL-CLICHE"],
		["A vibrant, bustling street.", "TRAVEL-CLICHE"],
		["A hidden gem in Tavrin.", "TRAVEL-CLICHE"],
		["A must-visit surf break.", "TRAVEL-CLICHE"],
		["In the heart of Velmora.", "TRAVEL-CLICHE"],
	])("flags %j as %s", (line, tag) => {
		expect(tags(copy(line as string))).toContain(tag);
	});

	it.each([
		"Surf, sleep and repeat.",
		"Best hostels →",
		"A long-stay, budget-friendly base.",
		"The hostel features you actually care about.",
		"Navigate to your booking.",
		"Unpack and head straight out.",
		"Just five minutes from the beach.",
		"Guests must visit reception on arrival.",
		"Here's how we rank hostels.",
		"Private doubles down the hall.",
		"Check in today's guests.",
		"Paradise Hostel, Brennick.",
		"The Oasis, South Quellan.",
		"The truth island tour leaves at nine.",
	])("leaves %j alone", (line) => {
		expect(tags(copy(line))).toEqual([]);
	});

	it.each(["© 2026 MantaHostels", "MantaHostels®", "Manta™"])(
		"does not call %j an emoji",
		(line) => {
			expect(tags(copy(line))).toEqual([]);
		},
	);

	it.each([
		["Busy &mdash; and cheap.", "EM-DASH"],
		["Don&rsquo;t miss it.", "CURLY-QUOTE"],
		["Don&#8217;t miss it.", "CURLY-QUOTE"],
		["Don&#x2019;t miss it.", "CURLY-QUOTE"],
	])("flags the entity spelling %j as %s", (line, tag) => {
		expect(tags(copy(line as string))).toContain(tag);
	});

	it.each([
		["Velmora is a tapestry of surf.", "AI-VOCAB"],
		["The hostel boasts a pool.", "COPULA"],
		["A pool, ensuring calm.", "ING-TAIL"],
		["It is not just a hostel, it's a home.", "NEG-PARALLEL"],
		["Experts believe it.", "VAGUE-ATTRIBUTION"],
		["It turns out fine.", "FILLER"],
		["When it comes to price.", "FILLER"],
		["A real game-changer.", "FILLER"],
		["A hostel nestled above.", "TRAVEL-CLICHE"],
		["A surf paradise.", "TRAVEL-CLICHE"],
		["Book now \u{1F30A}", "EMOJI"],
		["Don’t.", "CURLY-QUOTE"],
		["Busy — cheap.", "EM-DASH"],
	])("reports %j said twice as two %s hits, each with a fix", (line, tag) => {
		const hits = scanSource(copy(`${line} ${line}`));
		expect(hits.map((h: { tag: string }) => h.tag)).toEqual([tag, tag]);
		for (const h of hits) expect(h.fix.length).toBeGreaterThan(10);
	});

	it("reports the line the tell sits on, not the line the file starts at", () => {
		const src = `const a = "clean";\nconst b = "clean";\nconst c = "surf — sleep";\n`;
		expect(scanSource(src)).toEqual([
			expect.objectContaining({ tag: "EM-DASH", line: 3 }),
		]);
	});

	it("reports every hit on one line, not just the first", () => {
		expect(
			tags(copy("Reef breaks — Saltreach and Quellan — for the confident.")),
		).toEqual(["EM-DASH", "EM-DASH"]);
	});

	it("carries a fix and enough context to recognise the hit", () => {
		const [hit] = scanSource(copy("Saltreach boasts a clifftop view."));
		expect(hit.fix).toMatch(/is.+has/);
		expect(hit.context).toContain("clifftop");
	});
});
