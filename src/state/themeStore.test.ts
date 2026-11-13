import { describe, expect, it } from "vitest";

import { isDarkTheme, type ThemeMode } from "./themeStore";

describe("isDarkTheme", () => {
  it.each<[ThemeMode, boolean]>([
    ["dark", true],
    ["glass-dark", true],
    ["light", false],
    ["glass-light", false],
    ["retro", false],
  ])("%s -> %s", (mode, dark) => {
    expect(isDarkTheme(mode)).toBe(dark);
  });
});
