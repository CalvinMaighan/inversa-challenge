#!/usr/bin/env sh
# Downloads the pinned GOES-19 fixtures from the public NODD bucket into this directory.
# One scene: 2026-09-26 (day 269) 18:01Z, mostly clear over South Florida.
# LSTC, ACMC and FDCC are committed (about 7.8 MB together). SSTF (full disk, ~26 MB) is
# gitignored and only fetched by this script; the goes_fixture_sst test skips when it is absent.
set -eu
cd "$(dirname "$0")"
BUCKET=https://noaa-goes19.s3.amazonaws.com
for key in \
  ABI-L2-LSTC/2026/269/18/OR_ABI-L2-LSTC-M6_G19_s20262691801167_e20262691803541_c20262691805379.nc \
  ABI-L2-ACMC/2026/269/18/OR_ABI-L2-ACMC-M6_G19_s20262691801167_e20262691803541_c20262691804271.nc \
  ABI-L2-FDCC/2026/269/18/OR_ABI-L2-FDCC-M6_G19_s20262691801167_e20262691803541_c20262691804055.nc \
  ABI-L2-SSTF/2026/269/18/OR_ABI-L2-SSTF-M6_G19_s20262691800200_e20262691859508_c20262691902473.nc
do
  name=$(basename "$key")
  if [ -s "$name" ]; then
    echo "have $name"
  else
    echo "get  $name"
    curl -fsS -o "$name.part" "$BUCKET/$key" && mv "$name.part" "$name"
  fi
done
