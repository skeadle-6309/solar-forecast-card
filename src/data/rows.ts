import { readHoursAttr, sumEstimate10 } from "../integrations/index.js";
import type { HomeAssistant, SolarForecastCardConfig } from "../types.js";
import { readArrayActuals, resolveActualKwh, type ArrayActual } from "./entities.js";

const COMPLETE_THRESHOLD = 1.0;

export type Tier = "low" | "average" | "high";

export interface ForecastRow {
  dayIndex: number;
  date: Date;
  isToday: boolean;
  entityId: string;
  forecastKwh: number | null;
  actualKwh: number | null;  // today only
  /** Populated when actual_arrays configured; null otherwise. Heights use flex proportions. */
  actualArrays: ArrayActual[] | null;
  rawHoursAttr: unknown;     // raw "hours" attribute — parsed lazily
  /** Summed pv_estimate10 for the day (kWh). Null when not applicable or unavailable. */
  estimate10Kwh: number | null;
  forecastPct: number;       // 0–100, relative to week max
  actualPct: number;         // 0–100, capped at forecastPct
  dottedPct: number;         // forecastPct - actualPct
  isComplete: boolean;       // actual >= forecast
}

export function buildRows(hass: HomeAssistant, cfg: SolarForecastCardConfig): ForecastRow[] {
  const today = new Date();

  const todayArrays = readArrayActuals(hass, cfg);
  const todayActualKwh = resolveActualKwh(hass, cfg, todayArrays);

  type Raw = Omit<ForecastRow, "forecastPct" | "actualPct" | "dottedPct" | "isComplete">;

  const showEstimate10 =
    cfg.integration_type === "solcast" && cfg.display_estimate10;

  const raw: Raw[] = cfg.forecast_entities.map((entityId, i) => {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const s = entityId ? hass.states[entityId] : undefined;
    const kwhVal = parseFloat(s?.state ?? "");

    return {
      dayIndex: i + 1,
      date,
      isToday: i === 0,
      entityId,
      forecastKwh: isFinite(kwhVal) ? kwhVal : null,
      actualKwh: i === 0 ? todayActualKwh : null,
      actualArrays: i === 0 ? todayArrays : null,
      estimate10Kwh: showEstimate10
        ? sumEstimate10(s?.attributes?.detailedForecast)
        : null,
      rawHoursAttr: readHoursAttr(cfg.integration_type, s),
    };
  });

  const maxKwh = Math.max(...raw.map((r) => r.forecastKwh ?? 0), 0.001);

  return raw.map((r): ForecastRow => {
    const forecastPct = r.forecastKwh !== null
      ? Math.round((r.forecastKwh / maxKwh) * 100) : 0;
    const rawActualPct = r.actualKwh !== null
      ? Math.round((r.actualKwh / maxKwh) * 100) : 0;
    const actualPct = Math.min(rawActualPct, forecastPct);
    const dottedPct = forecastPct - actualPct;
    const isComplete = r.isToday
      && r.forecastKwh !== null && r.forecastKwh > 0
      && r.actualKwh !== null
      && r.actualKwh / r.forecastKwh >= COMPLETE_THRESHOLD;

    return { ...r, forecastPct, actualPct, dottedPct, isComplete };
  });
}

function resolveThreshold(
  hass: HomeAssistant | undefined,
  entityId: string | undefined,
  fallback: number | undefined
): number | undefined {
  if (entityId && entityId.startsWith("sensor.")) {
    const entity = hass?.states[entityId];

    if (entity && entity.state !== "unknown" &&
        entity.state !== "unavailable" &&
        entity.state.trim() !== "") {
      const value = Number(entity.state);

      if (Number.isFinite(value) && value >= 0) {
        const unit = entity.attributes?.unit_of_measurement;
        return unit === "Wh" ? value / 1000 : value;
      }
    }
  }

  return typeof fallback === "number" &&
    Number.isFinite(fallback) && fallback >= 0
    ? fallback
    : undefined;
}

export function forecastTier(
  hass: HomeAssistant | undefined,
  cfg: SolarForecastCardConfig,
  kwh: number | null
): Tier {
  if (kwh === null) return "average";

  const lo = resolveThreshold(hass, cfg.low_threshold_entity, cfg.low_threshold);
  const hi = resolveThreshold(hass, cfg.high_threshold_entity, cfg.high_threshold);

  if (lo !== undefined && kwh < lo) return "low";
  if (hi !== undefined && kwh > hi) return "high";

  return "average";
}
