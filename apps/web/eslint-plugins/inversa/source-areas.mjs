/**
 * @file Path helpers shared by the inversa rules. Ported from big-value's `import-boundaries.mjs`.
 *
 * Paths are relative to the lint `cwd`, which is `apps/web` (`bun run --cwd apps/web lint`), so `client/…`,
 * `shared/…`, `server/…` and `app/…` mean the same thing here as in tsconfig's `paths`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Roots with a runtime role. `tests`, `eval`, `e2e` and `eslint-plugins` are unrestricted. */
export const MANAGED_ROOTS = ["app", "client", "server", "shared"];

/** tsconfig `paths` aliases that map straight onto a root. */
const ALIAS_ROOTS = ["client", "server", "shared"];

/** Absolute filesystem path for a linted filename (ESLint may hand back a `file:` URL). */
export function physicalFilename(filename) {
  if (!filename) return "";
  return filename.startsWith("file:") ? fileURLToPath(filename) : filename;
}

function normalize(value) {
  return value.replace(/\\/g, "/");
}

/** `to` relative to `from`, or null when `to` is outside `from`. */
function relativePosix(from, to) {
  const rel = path.posix.relative(normalize(from), normalize(to));
  if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) return null;
  return rel;
}

/**
 * App-relative path for a linted filename, or null when it is outside `cwd` (or has no name at all).
 * @param {string} filename
 * @param {string} [cwd]
 */
export function repoRelative(filename, cwd = process.cwd()) {
  const absolute = physicalFilename(filename);
  if (!absolute) return null;
  return relativePosix(cwd, absolute);
}

/**
 * Which source area a linted file belongs to, or null when it is outside the managed roots.
 * `app/api/**` is its own area: the route handlers are server code even though they live under app/.
 * @returns {{ root: string, area: string } | null}
 */
export function sourceAreaForFilename(filename, cwd = process.cwd()) {
  const relative = repoRelative(filename, cwd);
  if (!relative) return null;
  const segments = relative.split("/");
  const root = segments[0];
  if (!root || !MANAGED_ROOTS.includes(root)) return null;
  return { root, area: root === "app" && segments[1] === "api" ? "app-api" : root };
}

/**
 * App-relative target a module specifier points at, or null for bare packages and anything outside the app.
 * Understands `@/*` and the `client`, `server/*`, `shared/*` aliases from tsconfig.json.
 * @param {string} source
 * @param {string} fileDir absolute directory of the importing file
 * @param {string} cwd
 */
export function importedTarget(source, fileDir, cwd = process.cwd()) {
  if (typeof source !== "string" || !source) return null;
  if (source === "@" || source.startsWith("@/")) return source.slice(2) || null;
  if (ALIAS_ROOTS.some((root) => source === root || source.startsWith(`${root}/`))) return source;
  if (!source.startsWith(".")) return null;
  return relativePosix(cwd, path.resolve(fileDir, source));
}
