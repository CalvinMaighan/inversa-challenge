/**
 * The picture of each app's species (public/species/<app>.png, 320 px, transparent background): the icon in the species
 * buttons, the app selector, the legend and the first-run gate, and the stand-in on a sighting card that has no photo.
 * Served same-origin so it loads under COEP.
 */
export const SPECIES_IMAGE_URLS: Record<string, string> = {
  carp: "/species/carp.png",
  lionfish: "/species/lionfish.png",
  python: "/species/python.png",
};
