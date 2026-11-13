import { afterEach, describe, expect, it, vi } from "vitest";

import { glassEditorExtensions } from "../lib/glassEditorTheme";
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

describe("theme persistence", () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  async function freshStore() {
    vi.resetModules();
    return (await import("./themeStore")).useThemeStore;
  }

  it("restores a stored glass theme and applies data-theme", async () => {
    localStorage.setItem("selene.theme", "glass-dark");
    const store = await freshStore();
    expect(store.getState().mode).toBe("glass-dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "glass-dark",
    );
  });

  it.each<[string | null]>([["bogus"], [null]])(
    "falls back to dark for %s",
    async (stored) => {
      if (stored !== null) localStorage.setItem("selene.theme", stored);
      const store = await freshStore();
      expect(store.getState().mode).toBe("dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    },
  );
});

describe("glassEditorExtensions", () => {
  it("is empty outside glass", () => {
    expect(glassEditorExtensions("dark")).toEqual([]);
  });

  it.each<ThemeMode>(["glass-dark", "glass-light"])("%s is non-empty", (m) => {
    expect(glassEditorExtensions(m).length).toBeGreaterThan(0);
  });
});
