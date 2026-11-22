/**
 * @param {unknown} v
 * @returns {Record<string, unknown> | null}
 */
const asObject = (v) =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? /** @type {Record<string, unknown>} */ (v)
		: null;

/**
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
 * @param {unknown} v
 * @returns {string[]}
 */
const stringMembers = (v) =>
	Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

module.exports = { asObject, objectsIn, stringMembers };
