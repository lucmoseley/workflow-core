/*
 * close-check-log.js — the format of the durable log of every close-check
 * decision `guard-priced-options.js` makes (#1101, spec #1091), one JSON line
 * per event, so the week-one reading can count all four of #1068's failure
 * lines from one source. `refusal-log.js` writes it, under
 * priced-options-limbs.js's `CLOSE_CHECK_LOG`.
 *
 * Kinds, each written at the Stop that decides it:
 *   refused               a close or low-top question refused on first
 *                         sight (#1061, #2228)
 *   refused-reprice       a refused question re-priced with no tool call (#489)
 *   refused-misshapen     a refused question re-sent with its shape still
 *                         wrong while the shape limb is silent (#1742)
 *   refused-ladder        a refused question re-sent still caught, close or
 *                         low-top, with a rung of the research ladder
 *                         untried (#2006, #2328)
 *   passed-after-refusal  a refused question let through on a later send
 *   passed-at-cap         a close or low-top question never refused, let
 *                         through because the limb's cap of 3 is spent (#1067)
 *   passed-unreadable     a close or low-top question let through because the
 *                         refusal record would not read
 */

/**
 * @typedef {{ letter: string, figure: number, low: number, high: number }} Band
 * @typedef {{ top: Band, runnerUp: Band }} Pair
 * @typedef {"close" | "low-top" | "both"} Trigger
 * @typedef {"refused" | "refused-reprice" | "refused-misshapen" | "refused-ladder" | "passed-after-refusal" | "passed-at-cap" | "passed-unreadable"} Kind
 * @typedef {{
 *   at?: string,
 *   session: string,
 *   round: string,
 *   kind: Kind,
 *   pair: Pair | null,
 *   slot?: number,
 *   toolCalls?: number | null,
 *   refusedPair?: Pair | null,
 *   stillClose?: boolean | null,
 *   rungs?: import("./research-ladder").RungCounts | null,
 *   flipped?: boolean | null,
 *   citesNewFact?: boolean | null,
 *   missing?: import("./research-ladder").Rung[],
 *   trigger?: Trigger,
 * }} CloseCheckEvent
 * `pair` is the top two by headline figure at this send, null under two
 * priced options or for a refused question the passing send left out, having
 * reached the founder on an earlier blocked one; `slot` (1–3) is on the
 * refusals only, and `toolCalls`, `refusedPair` and `stillClose` on
 * `passed-after-refusal` only, `toolCalls` null where the transcript cannot
 * say; `stillClose` is whether either test still catches it, close or
 * low-top (#2328), null on a question the passing send left out. It keeps
 * the close-only name because lines already logged carry it and #2260 ruled
 * that its readers stay unbroken; a line written before #2328 logs a
 * low-top-only re-send false.
 * `missing`, the untried rungs, is on `refused-ladder`, and on a
 * `passed-after-refusal` the ladder's spent cap let through still caught.
 * `trigger`, which test caught the question (`close-rivals.js`'s `caughtBy`),
 * is on `refused`, `passed-at-cap` and `passed-unreadable`; a line written
 * before #2327 carries none and reads as `close`.
 *
 * Also on `passed-after-refusal` only, for reading the ladder's effect
 * (#2010): `rungs`, the qualifying calls per rung since the first refusal,
 * null where the transcript cannot say; `flipped`, whether the top letter
 * differs from the refused send's; `citesNewFact`, whether the option lines
 * carry a URL, issue number or `path:line` the refused send's lacked. Both
 * null on a question the passing send left out, and `citesNewFact` on one
 * refused before #2010. Lines written before #2010 carry none of the three.
 */

/* Types only: this module exports nothing at runtime. The empty export keeps
 * it a CommonJS module for the `import("./close-check-log")` type references. */
module.exports = {};
