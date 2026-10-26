import { forecastBasisLabel, buildMetrics } from "./dataTransforms";

describe("forecastBasisLabel", () => {
  test("decision mode shows the D-1 decision time", () => {
    expect(forecastBasisLabel("decision", 24, "09:30")).toBe("Decision 09:30 (D-1)");
  });
  test("decision mode falls back to 09:00", () => {
    expect(forecastBasisLabel("decision", 24, undefined)).toBe("Decision 09:00 (D-1)");
  });
  test("horizon mode shows the lead time", () => {
    expect(forecastBasisLabel("horizon", 12, "09:00")).toBe("12h lead time");
  });
});

describe("buildMetrics (client fallback)", () => {
  test("ignores intervals with a missing forecast", () => {
    const m = buildMetrics([
      { time: "a", actual: 100, forecast: 110 },
      { time: "b", actual: 100, forecast: null },
    ]);
    expect(m.nValid).toBe(1);
    expect(m.nTotal).toBe(2);
    expect(m.bias).toBe(10);
  });
});
