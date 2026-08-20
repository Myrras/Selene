/**
 * Tiny path helpers for the webview (no Node `path` here). Paths may use either
 * separator since they originate from canonicalized OS paths across platforms.
 */

/** Final path component (file or directory name). */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Parent directory of a path; returns the path unchanged if it has no parent. */
export function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : path;
}

/**
 * `path` relative to whichever of `roots` contains it (longest root wins, so a
 * nested open folder beats its parent). Falls back to the absolute path when no
 * root matches — same as VS Code's "Copy Relative Path" outside a workspace.
 */
export function relativePath(path: string, roots: string[]): string {
  const root = roots
    .filter((r) => path.startsWith(r) && /^[\\/]/.test(path.slice(r.length)))
    .sort((a, b) => b.length - a.length)[0];
  return root ? path.slice(root.length + 1) : path;
}
