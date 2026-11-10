/*
 * json-shape.js — narrowing a parsed JSON value whose shape a reader cannot
 * trust, such as a run-record line, to the object, objects or strings it
 * holds, so the measure-* reviews narrow one way (#4796).
 */

/**
 * @param {unknown} v
 * @returns {Record<string, unknown> | null}
 */
const asObject = (v) =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? /** @type {Record<string, unknown>} */ (v)
		: null;

/**
 * An array's object members; none where it is no array.
 * @param {unknown} v
 * @returns {Record<string, unknown>[]}
 */
const objectsIn = (v) =>
	Array.isArray(v)
		? v.flatMap((x) => {
				const o = asObject(x);
				return o ? [o] : [];
			})
		: [];

/**
 * An array's string members; none where it is no array.
 * @param {unknown} v
 * @returns {string[]}
 */
const stringMembers = (v) =>
	Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

module.exports = { asObject, objectsIn, stringMembers };
