"use client";

import { useRef, useState, type FormEvent } from "react";
import type {
  AgentRuntime,
  LocalDirectoryResourceRef,
  LocalDirectoryExecutionMode,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@multica/ui/components/ui/dialog";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@multica/ui/components/ui/select";
import { useT } from "../../i18n";
import { buildRuntimeMachines } from "../../runtimes/components/runtime-machines";
import { LocalDirectoryModeOptions } from "./local-directory-mode-dialog";

export function WebLocalDirectoryDialog({
  runtimes, worktreeSupported, onClose, onCreate,
}: {
  runtimes: AgentRuntime[];
  worktreeSupported: boolean;
  onClose: () => void;
  onCreate: (ref: LocalDirectoryResourceRef) => Promise<unknown>;
}) {
  const { t } = useT("projects");
  const machines = buildRuntimeMachines(runtimes, { now: Date.now() }).filter(
    (machine) => machine.daemonId && machine.mode === "local" && machine.onlineCount > 0,
  );
  const [selectedDaemon, setSelectedDaemon] = useState<string | null>(null);
  const daemonId = selectedDaemon ?? (machines.length === 1 ? machines[0]!.daemonId : null);
  const [path, setPath] = useState("");
  const pathInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<LocalDirectoryExecutionMode>("in_place");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidPathMessage = t(($) => $.resources.local_validate_not_absolute);
  const items = machines.map((machine) => ({ value: machine.daemonId!, label: machine.title }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !daemonId || !path.trim()) return;
    const localPath = path.trim();
    if (!localPath.startsWith("/") && !localPath.startsWith("\\\\") && !/^[a-zA-Z]:[\\/]/.test(localPath)) {
      setError(invalidPathMessage);
      pathInput.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        local_path: localPath,
        daemon_id: daemonId,
        label: localPath.split(/[\\/]/).filter(Boolean).pop() ?? localPath,
        execution_mode: mode,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(($) => $.resources.toast_attach_failed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(($) => $.resources.add_local_directory_button)}</DialogTitle>
        </DialogHeader>
        <form noValidate onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="local-directory-machine">{t(($) => $.resources.web_local_machine)}</Label>
            <Select items={items} value={daemonId} onValueChange={setSelectedDaemon} disabled={saving || machines.length === 0}>
              <SelectTrigger id="local-directory-machine" className="w-full">
                <SelectValue placeholder={t(($) => $.resources.web_local_machine_placeholder)} />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {machines.length === 0 && (
              <p role="status" className="text-caption text-muted-foreground">{t(($) => $.resources.web_local_no_machine)}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="local-directory-path">{t(($) => $.resources.web_local_path)}</Label>
            <Input
              ref={pathInput}
              id="local-directory-path"
              value={path}
              onChange={(event) => { setPath(event.target.value); setError(null); }}
              disabled={saving}
              placeholder={t(($) => $.resources.web_local_path_placeholder)}
              aria-invalid={error === invalidPathMessage}
              aria-describedby={`local-directory-path-help${error ? " local-directory-error" : ""}`}
            />
            <p id="local-directory-path-help" className="text-caption text-muted-foreground">
              {t(($) => $.resources.web_local_path_help)}
            </p>
          </div>
          <fieldset disabled={saving}>
            <LocalDirectoryModeOptions value={mode} onChange={setMode} unavailableReason={worktreeSupported ? undefined : "server_outdated"} />
          </fieldset>
          {error && <p id="local-directory-error" role="alert" className="text-caption text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>{t(($) => $.resources.mode_cancel)}</Button>
            <Button type="submit" disabled={saving || !daemonId || !path.trim()} aria-busy={saving}>{t(($) => $.resources.mode_add)}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
