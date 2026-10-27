import { forecastBasisLabel, buildMetrics, getLatestForecastPublishTime } from "./dataTransforms";

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

describe("getLatestForecastPublishTime", () => {
  test("returns the latest non-null publish time from the selected forecast rows", () => {
    const latest = getLatestForecastPublishTime([
      { time: "2026-01-02T00:00:00Z", actual: 100, forecast: 90, publishTime: "2026-01-01T09:00:00Z" },
      { time: "2026-01-02T00:30:00Z", actual: 110, forecast: 95, publishTime: "2026-01-01T12:00:00Z" },
      { time: "2026-01-02T01:00:00Z", actual: 120, forecast: null, publishTime: null },
    ]);

    expect(latest).toBe("2026-01-01T12:00:00Z");
  });

  test("returns null when there is no eligible forecast data", () => {
    expect(getLatestForecastPublishTime([
      { time: "2026-01-02T00:00:00Z", actual: 100, forecast: null, publishTime: null },
    ])).toBeNull();
  });
});
