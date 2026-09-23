/**
 * Security validation for GLPI itemtype names.
 *
 * GLPI itemtypes correspond to internal PHP class names (e.g. "Ticket",
 * "ITILCategory", "Computer", "Document_Item"). They must adhere to strict
 * alphanumeric and underscore naming rules to prevent path traversal,
 * URL injection, and unintended endpoint exposure.
 */

const ITEMTYPE_REGEX = /^[a-zA-Z0-9_]{1,100}$/;

/**
 * Validates that an itemtype contains only safe alphanumeric characters and underscores.
 * Throws an error if any path traversal characters, slashes, or special symbols are present.
 *
 * @param itemtype GLPI object type (e.g. "Ticket", "Computer")
 * @returns Sanitized and trimmed itemtype string
 */
export function validateItemtype(itemtype: string): string {
  if (!itemtype || typeof itemtype !== 'string') {
    throw new Error('Itemtype must be a non-empty string.');
  }

  const trimmed = itemtype.trim();
  if (!ITEMTYPE_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid or disallowed itemtype: "${itemtype}". Itemtypes must contain only alphanumeric characters and underscores.`
    );
  }

  return trimmed;
}
