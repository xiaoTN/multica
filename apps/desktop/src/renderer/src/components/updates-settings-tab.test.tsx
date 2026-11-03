import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
const translations = { desktop: { updates: { title: "更新", current_version: "当前版本" } } };
vi.mock("@multica/views/i18n", () => ({ useT: () => ({ t: (select: (value: typeof translations) => string) => select(translations) }) }));
import { UpdatesSettingsTab } from "./updates-settings-tab";

it("只显示本机版本，不提供联网更新操作", () => {
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { appInfo: { version: "1.2.3" } } });
  render(<UpdatesSettingsTab />);
  expect(screen.getByText("v1.2.3")).toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
