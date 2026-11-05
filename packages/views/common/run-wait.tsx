"use client";

import { useEffect, useState } from "react";
import type { RunWaitDiagnostic, RunWaitHistoryEntry } from "@multica/core/types";
import { useLocale, useT } from "../i18n";

const CODES = ["agent_concurrency", "runtime_concurrency", "daemon_capacity", "daemon_updating", "previous_run", "runtime_offline", "runtime_unbound", "runtime_rebound", "wakeup_inactive", "awaiting_claim", "awaiting_daemon", "preparing_session", "local_directory_busy", "worktree_snapshot_busy", "unknown"] as const;
type Code = typeof CODES[number];
function codeKey(code?: string): Code { return CODES.includes(code as Code) ? code as Code : "unknown"; }

export function isRunWaiting(status?: string) {
  return status === "queued" || status === "dispatched" || status === "waiting_local_directory";
}

export function useRunWaitLabel(diagnostic?: RunWaitDiagnostic, status?: string) {
  const { t } = useT("issues");
  const code = codeKey(diagnostic?.code);
  const label = t(($) => $.run_wait.codes[code]);
  if (!isRunWaiting(status)) return undefined;
  return diagnostic?.occupied !== undefined && diagnostic.limit !== undefined
    ? `${label} (${diagnostic.occupied}/${diagnostic.limit})` : label;
}

export function RunWaitFacts({ diagnostic, history }: { diagnostic?: RunWaitDiagnostic; history?: RunWaitHistoryEntry[] }) {
  const { t } = useT("issues");
  const locale = useLocale();
  const [now, setNow] = useState(Date.now);
  const since = diagnostic?.since ? Date.parse(diagnostic.since) : NaN;
  useEffect(() => {
    if (!Number.isFinite(since)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const scopes = ["agent", "runtime", "daemon", "issue_agent", "chat_session", "quick_create_agent", "local_directory", "run"] as const;
  const scope = scopes.find((s) => s === diagnostic?.scope);
  const phases = ["queued", "dispatched", "resource_wait", "preparing"] as const;
  const phase = phases.find((p) => p === diagnostic?.phase);
  return <div className="min-w-0 space-y-2 text-caption text-muted-foreground" data-run-wait-details>
    {(diagnostic || !history?.length) && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
      <dt>{t(($) => $.run_wait.phase)}</dt><dd>{phase ? t(($) => $.run_wait.phases[phase]) : t(($) => $.run_wait.unreported)}</dd>
      <dt>{t(($) => $.run_wait.scope)}</dt><dd>{scope ? t(($) => $.run_wait.scopes[scope]) : t(($) => $.run_wait.unreported)}</dd>
      {diagnostic?.occupied !== undefined && diagnostic.limit !== undefined && <>
        <dt>{t(($) => $.run_wait.capacity)}</dt><dd>{diagnostic.occupied}/{diagnostic.limit}</dd>
      </>}
      {Number.isFinite(since) && <><dt>{t(($) => $.run_wait.duration)}</dt><dd>{t(($) => $.run_wait.seconds, {count:Math.max(0, Math.floor((now - since) / 1000))})}</dd></>}
      <dt>{t(($) => $.run_wait.evaluated)}</dt><dd>{diagnostic?.evaluated_at ? new Date(diagnostic.evaluated_at).toLocaleString(locale) : t(($) => $.run_wait.unreported)}</dd>
      {diagnostic?.blocking_task_id && <><dt>{t(($) => $.run_wait.blocker)}</dt><dd className="select-text break-all font-mono">{diagnostic.blocking_task_id}</dd></>}
      <dt>{t(($) => $.run_wait.reason_code)}</dt><dd className="select-text break-all font-mono">{diagnostic?.code ?? "unknown"}</dd>
    </dl>}
    {history && history.length > 0 && <details>
      <summary className="cursor-pointer rounded-xs focus-visible:ring-2 focus-visible:ring-ring">{t(($) => $.run_wait.history)}</summary>
      <ol className="mt-1 max-h-48 space-y-1 overflow-y-auto">
        {history.map((entry, index) => <li key={`${entry.at}-${index}`}>
          <time>{new Date(entry.at).toLocaleString(locale)}</time>{" · "}
          {entry.diagnostic ? t(($) => $.run_wait.codes[codeKey(entry.diagnostic?.code)]) : t(($) => $.run_wait.cleared)}
        </li>)}
      </ol>
    </details>}
  </div>;
}

export function RunWaitDetails({ diagnostic }: { diagnostic?: RunWaitDiagnostic }) {
  const { t } = useT("issues");
  return <details className="min-w-0 text-caption text-muted-foreground">
    <summary className="cursor-pointer rounded-xs focus-visible:ring-2 focus-visible:ring-ring">{t(($) => $.run_wait.details)}</summary>
    <div className="mt-2"><RunWaitFacts diagnostic={diagnostic} /></div>
  </details>;
}
