import { resolve, basename, extname, isAbsolute, sep } from 'node:path';
import { stat, realpath } from 'node:fs/promises';

/** MIME types allowed for glpi_upload_document, keyed by lowercase file extension. */
export const ALLOWED_UPLOAD_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

/** Blocked sensitive file names and patterns (case-insensitive). */
const SENSITIVE_FILENAME_PATTERNS = [
  /^\..+/, // Any hidden file (e.g. .env, .git, .ssh)
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^known_hosts$/i,
  /^authorized_keys$/i,
  /^credentials$/i,
  /\.env(\..+)?$/i,
  /\.(pem|key|pfx|p12|crt)$/i,
  /\.(exe|bat|cmd|ps1|sh|bash|vbs|msi)$/i,
];

export interface SafePathResult {
  resolvedPath: string;
  filename: string;
  mimeType: string;
}

/**
 * Validates and resolves a file path safely, preventing directory traversal,
 * symlink escapes, sensitive file leakage, and unauthorized extensions.
 *
 * @param inputPath Path provided by the caller (relative or absolute).
 * @param allowedBaseDir Optional base directory constraint (defaults to GLPI_ALLOWED_UPLOAD_DIR or process.cwd()).
 */
export async function resolveSafePath(
  inputPath: string,
  allowedBaseDir?: string
): Promise<SafePathResult> {
  if (!inputPath || typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new Error('A non-empty file path must be provided.');
  }

  // Prevent null-byte injection
  if (inputPath.includes('\0')) {
    throw new Error('Invalid file path: contains null byte.');
  }

  const baseDir = resolve(
    allowedBaseDir ?? process.env.GLPI_ALLOWED_UPLOAD_DIR ?? process.cwd()
  );

  const candidatePath = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(baseDir, inputPath);

  // Check physical existence and resolve canonical path (resolves symlinks)
  let realTarget: string;
  try {
    realTarget = await realpath(candidatePath);
  } catch (err) {
    throw new Error(
      `File not found or inaccessible: "${inputPath}" (${err instanceof Error ? err.message : String(err)})`
    );
  }

  let realBase: string;
  try {
    realBase = await realpath(baseDir);
  } catch {
    realBase = baseDir;
  }

  // Ensure realTarget is strictly within realBase
  const normalizedBase = realBase.endsWith(sep) ? realBase : realBase + sep;
  if (!realTarget.startsWith(normalizedBase)) {
    throw new Error(
      `Access denied: File "${inputPath}" is outside the allowed directory "${realBase}".`
    );
  }

  // Verify that it is a regular file (not directory, socket, pipe, etc.)
  const fileStat = await stat(realTarget);
  if (!fileStat.isFile()) {
    throw new Error(`Target is not a regular file: "${inputPath}".`);
  }

  const filename = basename(realTarget);

  // Check against sensitive filename patterns
  for (const pattern of SENSITIVE_FILENAME_PATTERNS) {
    if (pattern.test(filename)) {
      throw new Error(`Access denied: File "${filename}" is restricted for security.`);
    }
  }

  // Check path segments for hidden directories (e.g. /home/user/.ssh/...)
  const relativeFromBase = realTarget.slice(normalizedBase.length);
  const segments = relativeFromBase.split(/[/\\]/);
  for (const segment of segments) {
    if (segment.startsWith('.') && segment !== '.' && segment !== '..') {
      throw new Error(`Access denied: Path includes hidden segment "${segment}".`);
    }
  }

  // Validate extension and map to MIME type
  const ext = extname(filename).toLowerCase();
  const mimeType = ALLOWED_UPLOAD_MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(
      `Unsupported or disallowed file extension "${ext}". Allowed extensions: ${Object.keys(
        ALLOWED_UPLOAD_MIME_TYPES
      ).join(', ')}`
    );
  }

  return {
    resolvedPath: realTarget,
    filename,
    mimeType,
  };
}
