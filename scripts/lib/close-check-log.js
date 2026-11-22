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
 */

module.exports = {};
