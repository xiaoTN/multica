export type OpenLocalDirectoryResult = {
  ok: boolean;
  reason?: "unavailable" | "not_absolute" | "not_found" | "not_a_directory" | "not_readable" | "error";
  error?: string;
};
