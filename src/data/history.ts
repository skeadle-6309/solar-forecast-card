import type { HomeAssistant } from "../types.js";

interface HistEntry {
  state: string;
  last_changed: string;
}

/**
 * Fetch hourly actual-generation values for today from the HA history API.
 *
 * today_actual_entity is a cumulative energy sensor (kWh or Wh) whose value
 * rises monotonically through the day. Per-hour generation is the difference
 * between the sensor's value at the end and start of each hour boundary.
 *
 * Returns a Map<localHour (0–23), kWh> containing only hours with positive
 * generation (> 0).  Pre-sunrise and future hours are not included so the
 * popup table stays clean — a missing key means "no data / future", not zero.
 *
 * Returns an empty Map (never rejects) if the history API is unavailable,
 * the entity has no recorded history for today, or any other error occurs.
 */
export async function fetchActualHourly(
  hass: HomeAssistant | undefined,
  entityId: string
): Promise<Map<number, number>> {
  if (!hass?.callApi) return new Map();

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  // Detect Wh vs kWh from the live entity state so history values are
  // normalised to kWh consistently with the rest of the card.
  const unit = (
    hass.states[entityId]?.attributes?.unit_of_measurement as string | undefined
  )?.toLowerCase();
  const isWh = unit === "wh";

  try {
    // Build the history/period REST path.
    // significant_changes_only=false: return every recorded state change,
    // not just those that cross a threshold — essential for cumulative sensors.
    const path =
      `history/period/${startOfDay.toISOString()}` +
      `?filter_entity_id=${encodeURIComponent(entityId)}` +
      `&end_time=${encodeURIComponent(now.toISOString())}` +
      `&minimal_response=true&no_attributes=true&significant_changes_only=false`;

    // HA history API returns: Array<Array<{state, last_changed}>>
    // Outer array is per-entity; inner array is chronological state entries.
    const result = await hass.callApi<HistEntry[][]>("GET", path);

    if (!Array.isArray(result) || result.length === 0 || !Array.isArray(result[0])) {
      return new Map();
    }

    // Normalise: keep only entries with finite numeric state, sorted ascending.
    const entries: HistEntry[] = result[0]
      .filter((e) => e && typeof e.last_changed === "string" && isFinite(parseFloat(e.state)))
      .sort((a, b) => (a.last_changed < b.last_changed ? -1 : a.last_changed > b.last_changed ? 1 : 0));

    if (entries.length === 0) return new Map();

    /**
     * Returns the most-recent finite numeric state value recorded at or
     * before the given UTC ISO timestamp.  Entries are sorted ascending so
     * iteration stops as soon as we pass the target timestamp.
     */
    const valueAt = (isoTs: string): number | null => {
      let val: number | null = null;
      for (const e of entries) {
        if (e.last_changed <= isoTs) {
          const v = parseFloat(e.state);
          if (isFinite(v)) val = v;
        } else {
          break;
        }
      }
      return val;
    };

    const map = new Map<number, number>();
    const currentHour = now.getHours();

    for (let h = 0; h <= currentHour; h++) {
      const hourStart = new Date(now);
      hourStart.setHours(h, 0, 0, 0);
      const hourEnd = new Date(now);
      hourEnd.setHours(h + 1, 0, 0, 0);

      const startVal = valueAt(hourStart.toISOString());
      const endVal   = valueAt(hourEnd.toISOString());

      if (startVal === null || endVal === null) continue;

      let delta = endVal - startVal;
      if (delta < 0) continue;     // sensor reset or stale data — skip
      if (isWh) delta /= 1000;     // Wh → kWh

      // Only record hours that actually generated something.
      // This keeps the popup table free of zero rows for pre-sunrise hours.
      if (delta > 0) map.set(h, delta);
    }

    console.debug(
      `[solar-forecast-card] actual history: ${map.size} generating hour(s) found for ${entityId}`
    );
    return map;

  } catch (err) {
    console.debug("[solar-forecast-card] actual history fetch failed:", err);
    return new Map();
  }
}
