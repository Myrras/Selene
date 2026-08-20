import { describe, expect, it } from "vitest";

import { relativePath } from "./path";

describe("relativePath", () => {
  it("strips the containing root", () => {
    expect(relativePath("/work/db/a.sql", ["/work"])).toBe("db/a.sql");
    expect(relativePath("C:\\work\\a.sql", ["C:\\work"])).toBe("a.sql");
  });

  it("prefers the deepest matching root", () => {
    expect(relativePath("/work/db/a.sql", ["/work", "/work/db"])).toBe("a.sql");
  });

  it("keeps the absolute path when no root matches", () => {
    expect(relativePath("/other/a.sql", ["/work"])).toBe("/other/a.sql");
    // A prefix match that is not a path boundary must not count.
    expect(relativePath("/workshop/a.sql", ["/work"])).toBe("/workshop/a.sql");
  });
});
