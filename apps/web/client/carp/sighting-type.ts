/** One Asian carp sighting as `/api/carp/sightings` returns it (iNaturalist, GBIF or USGS NAS). */
export type CarpSighting = {
  id: string;
  source: "inat" | "gbif" | "nas";
  species: string;
  scientificName: string;
  lat: number;
  lon: number;
  date: string | null;
  url: string;
  photo: string | null;
};
