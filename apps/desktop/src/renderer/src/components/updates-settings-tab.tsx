import { useT } from "@multica/views/i18n";
import { SettingsCard, SettingsRow, SettingsTab } from "@multica/views/settings";

export function UpdatesSettingsTab() {
  const { t } = useT("settings");
  return (
    <SettingsTab title={t(($) => $.desktop.updates.title)}>
      <SettingsCard>
        <SettingsRow label={t(($) => $.desktop.updates.current_version)}>
          <span className="font-mono text-caption text-muted-foreground">
            v{window.desktopAPI.appInfo.version}
          </span>
        </SettingsRow>
      </SettingsCard>
    </SettingsTab>
  );
}
