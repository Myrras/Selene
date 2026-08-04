import { describe, expect, it } from "vitest";

import { formatElapsed } from "./elapsed";

describe("formatElapsed", () => {
  it("shows whole milliseconds below a second", () => {
    expect(formatElapsed(0)).toBe("0 ms");
    expect(formatElapsed(842.6)).toBe("843 ms");
  });

  it("switches to seconds with one decimal from 1s", () => {
    expect(formatElapsed(1000)).toBe("1.0 s");
    expect(formatElapsed(2449)).toBe("2.4 s");
  });

  it("switches to minutes + zero-padded seconds from 1m", () => {
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(65_400)).toBe("1m 05s");
  });
});
