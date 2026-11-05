import type {
  LocalDirectoryResourceRef,
  ProjectResource,
} from "@multica/core/types";

/**
 * Display name for a local_directory row.
 *
 * A row's name can live in two places: the top-level `label` column (what a
 * label update through the API or CLI writes; the panel itself no longer
 * offers a rename) and the legacy copy inside the ref (the only home desktop
 * builds up to v0.4.28 knew). Current servers keep the two converged on every
 * write, but rows last written by an older server can still disagree, and
 * rows created by older clients carry only the ref copy. The column outranks
 * the ref copy because it is the one current writes land in. Unnamed folders
 * use their final path component; the row's tooltip retains the full path.
 */
export function localDirectoryLabel(
  resource: Pick<ProjectResource, "label"> & {
    resource_ref: LocalDirectoryResourceRef;
  },
): string {
  const ref = resource.resource_ref;
  const label = resource.label?.trim() || ref.label?.trim();
  if (label) return label;

  // POSIX permits backslashes in names. Treat them as separators only for
  // drive-qualified and UNC paths, including resources on another machine.
  const windows = /^[a-zA-Z]:[\\/]/.test(ref.local_path) || ref.local_path.startsWith("\\\\");
  const path = ref.local_path.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  if (!path || (windows && /^[a-zA-Z]:$/.test(path))) return ref.local_path;
  return path.split(windows ? /[\\/]/ : /\//).pop() || ref.local_path;
}
