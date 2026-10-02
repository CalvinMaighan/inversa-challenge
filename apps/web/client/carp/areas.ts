/**
 * Set locations for the carp demo (up to four): the places in Louisiana where Asian carp have been reported most. A click flies the
 * camera there, close enough to see the cluster.
 */
export type Area = { id: string; name: string; lat: number; lon: number; altitudeM: number };

export const CARP_AREAS: readonly Area[] = [
  { id: "delta", name: "Mississippi Delta", lat: 29.75, lon: -90.4, altitudeM: 180_000 },
  { id: "atchafalaya", name: "Atchafalaya Basin", lat: 30.1, lon: -91.6, altitudeM: 170_000 },
  { id: "red-river", name: "Red River", lat: 31.3, lon: -92.4, altitudeM: 190_000 },
  { id: "northeast", name: "Northeast Louisiana", lat: 32.4, lon: -91.2, altitudeM: 190_000 },
];
