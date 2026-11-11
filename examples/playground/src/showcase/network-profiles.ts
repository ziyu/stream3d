/** Local HTTP laboratory presets. These are body-byte limits, not device benchmarks. */
export interface NetworkProfile {
  readonly label: string;
  readonly bytesPerSecond: number | null;
  readonly latencyMs: number;
}

export const NETWORK_PROFILES = Object.freeze({
  native: Object.freeze({ label: 'Native connection', bytesPerSecond: null, latencyMs: 0 }),
  fast: Object.freeze({ label: '8 Mbps · 80 ms', bytesPerSecond: 1_000_000, latencyMs: 80 }),
  slow: Object.freeze({ label: '1.6 Mbps · 180 ms', bytesPerSecond: 200_000, latencyMs: 180 }),
}) satisfies Readonly<Record<string, NetworkProfile>>;

export type NetworkProfileId = keyof typeof NETWORK_PROFILES;
