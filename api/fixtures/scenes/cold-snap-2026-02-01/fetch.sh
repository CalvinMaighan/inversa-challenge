#!/usr/bin/env sh
# Re-records the cold-snap-2026-02-01 scene: the South Florida cold snap of 30 Jan - 3 Feb 2026
# (Miami ~2 °C on the mornings of 1 and 2 Feb, NWS Miami Extreme Cold and Freeze Warnings) and
# the rebound that followed, to 7 Feb.
#
# Window: 2026-01-30T00:00Z to 2026-02-08T00:00Z (nine UTC days). Every payload is the upstream
# response byte for byte; files over ~1 MB are stored gzipped (`gzip -n`) and the loader
# (`inversa-api backfill --scene`) inflates them. The one conversion is NWS text products into
# NWWS-OI stanzas, see the NWS section below. Writes manifest.json last.
#
# Needs curl, jq, awk, gzip. Usage: sh fetch.sh   (from anywhere; writes next to this script)
set -eu
cd "$(dirname "$0")"

SCENE=cold-snap-2026-02-01
FROM_DAY=2026-01-30
TO_DAY=2026-02-07
WINDOW_FROM=2026-01-30T00:00:00Z
WINDOW_TO=2026-02-08T00:00:00Z
UA="inversa-api scene recorder"
RECORDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

rm -rf inat openmeteo usgs nws
mkdir -p inat openmeteo usgs nws/raw nws/iem
: > .manifest.tsv

# source <TAB> file <TAB> url <TAB> content type <TAB> ingest (1) or original only (0)
entry() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >> .manifest.tsv; }
get() { curl -fsS --retry 8 --retry-delay 10 -A "$UA" "$@"; }

# --- iNaturalist: the app's one species (Python bivittatus 238252) observed in the region bbox on
# the window's days. iNat holds no Burmese python observation in the bbox on the cold days
# themselves (30 Jan - 3 Feb, re-checked 2026-10-01); the window runs to 7 Feb so the replay
# shows reports resuming after the rebound (two research-grade records observed on 6 Feb).
INAT="https://api.inaturalist.org/v1/observations?swlat=24.3&swlng=-83.2&nelat=27.5&nelng=-79.8&taxon_id=238252&d1=$FROM_DAY&d2=$TO_DAY&order_by=id&order=asc&per_page=200"
get "$INAT" | gzip -n > inat/focus-p1.json.gz
total=$(gzip -dc inat/focus-p1.json.gz | jq '.total_results')
got=$(gzip -dc inat/focus-p1.json.gz | jq '.results | length')
[ "$total" = "$got" ] || { echo "iNat: $got of $total on page 1; add pages" >&2; exit 1; }
entry inat inat/focus-p1.json.gz "$INAT" application/json 1

# --- Open-Meteo: the live poller's 0.25° grid (182 points, `openmeteo::grid()`), from the
# ERA5-based historical archive (same response shape as the forecast API) and the marine API's
# historical range.
LATS=$(awk 'BEGIN { for (r = 0; r < 13; r++) for (c = 0; c < 14; c++) printf "%s%.3f", (r || c) ? "," : "", 24.425 + 0.25 * r }')
LONS=$(awk 'BEGIN { for (r = 0; r < 13; r++) for (c = 0; c < 14; c++) printf "%s%.3f", (r || c) ? "," : "", -83.075 + 0.25 * c }')
ARCHIVE="https://archive-api.open-meteo.com/v1/archive?latitude=$LATS&longitude=$LONS&hourly=temperature_2m,precipitation,wind_speed_10m&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT&start_date=$FROM_DAY&end_date=$TO_DAY"
MARINE="https://marine-api.open-meteo.com/v1/marine?latitude=$LATS&longitude=$LONS&hourly=wave_height,sea_surface_temperature&timeformat=unixtime&timezone=GMT&start_date=$FROM_DAY&end_date=$TO_DAY&cell_selection=nearest"
get "$ARCHIVE" | gzip -n > openmeteo/archive.json.gz
get "$MARINE" | gzip -n > openmeteo/marine.json.gz
entry openmeteo openmeteo/archive.json.gz "$ARCHIVE" application/json 1
entry openmeteo openmeteo/marine.json.gz "$MARINE" application/json 1

# --- USGS instantaneous values for the Everglades box, by site list as the live poller does
# (`usgs::SITE_URL`, 100 sites per request), with an explicit startDT/endDT range. Ranges older
# than 120 days are served by nwis.waterservices.usgs.gov (waterservices.usgs.gov answers 301).
SITES_URL="https://waterservices.usgs.gov/nwis/site/?format=rdb&bBox=-81.5,25.0,-80.2,26.5&parameterCd=00065,62614,62615,00010&siteStatus=active&hasDataTypeCd=iv"
get "$SITES_URL" > usgs/sites.rdb
entry usgs usgs/sites.rdb "$SITES_URL" text/plain 0
awk -F'\t' '$1 == "USGS" { print $2 }' usgs/sites.rdb | sort -u > .sites
n=0
split -l 100 .sites .sites.chunk.
for chunk in .sites.chunk.*; do
  n=$((n + 1))
  list=$(paste -sd, "$chunk")
  IV="https://nwis.waterservices.usgs.gov/nwis/iv/?format=json&sites=$list&parameterCd=00065,62614,62615,00010&startDT=$WINDOW_FROM&endDT=$WINDOW_TO"
  get "$IV" | gzip -n > "usgs/iv-p$n.json.gz"
  entry usgs "usgs/iv-p$n.json.gz" "$IV" application/json 1
done
rm -f .sites .sites.chunk.*

# --- NWS. api.weather.gov serves only active alerts, so the scene uses the Iowa Environmental
# Mesonet archive: the VTEC event listing per office (kept as the original index), and the raw
# text of every Non-Precipitation Weather product (NPW: freeze, frost, cold weather, extreme
# cold, wind) that NWS Miami (NPWMFL) and Key West (NPWKEY) issued on the window's days, from
# IEM's AFOS archive. The raw text is kept under nws/raw/. Conversion: each product is wrapped
# unchanged (XML-escaped) in the NWWS-OI groupchat stanza the `nwws` push source receives, with
# the `<x>` attributes taken from the IEM product id (issuance time, office, WMO header, AWIPS
# id). `push::nwws::normalize_stanza` then parses the segments, VTEC and UGC exactly as it does
# live, and keys rows the same way the api.weather.gov poller does (`vtec_ext_id`).
for wfo in MFL KEY; do
  VT="https://mesonet.agron.iastate.edu/json/vtec_events_bywfo.py?wfo=$wfo&year=2026"
  get "$VT" | gzip -n > "nws/iem/vtec_events_bywfo-$wfo-2026.json.gz"
  entry nws "nws/iem/vtec_events_bywfo-$wfo-2026.json.gz" "$VT" application/json 0
done
day=$FROM_DAY
while :; do
  for pil in NPWMFL NPWKEY; do
    LIST="https://mesonet.agron.iastate.edu/api/1/nws/afos/list.json?pil=$pil&date=$day"
    for pid in $(get "$LIST" | jq -r '.data[].product_id'); do
      TXT="https://mesonet.agron.iastate.edu/api/1/nwstext/$pid"
      get "$TXT" > "nws/raw/$pid.txt"
      entry nws "nws/raw/$pid.txt" "$TXT" text/plain 0
      # pid = YYYYmmddHHMM-CCCC-TTAAII-AWIPSID
      issue=$(echo "$pid" | awk -F- '{ t = $1; printf "%s-%s-%sT%s:%s:00Z", substr(t,1,4), substr(t,5,2), substr(t,7,2), substr(t,9,2), substr(t,11,2) }')
      cccc=$(echo "$pid" | cut -d- -f2)
      ttaaii=$(echo "$pid" | cut -d- -f3)
      awips=$(echo "$pid" | cut -d- -f4)
      {
        printf '<message xmlns="jabber:client" type="groupchat" from="nwws@conference.nwws-oi.weather.gov/nwws-oi">'
        printf '<body>%s issues %s valid %s</body>' "$cccc" "$(echo "$awips" | cut -c1-3)" "$issue"
        printf '<x xmlns="nwws-oi" cccc="%s" ttaaii="%s" issue="%s" awipsid="%s" id="%s">' "$cccc" "$ttaaii" "$issue" "$awips" "$pid"
        sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' "nws/raw/$pid.txt"
        printf '</x></message>\n'
      } > "nws/$pid.xml"
      entry nwws "nws/$pid.xml" "$TXT" application/xml 1
      sleep 1
    done
  done
  [ "$day" = "$TO_DAY" ] && break
  day=$(date -u -j -v+1d -f %Y-%m-%d "$day" +%Y-%m-%d 2>/dev/null || date -u -d "$day + 1 day" +%Y-%m-%d)
done

# --- manifest.json: ingested payloads in load order, then the originals kept for provenance.
jq -Rn --arg scene "$SCENE" --arg recorded "$RECORDED_AT" --arg from "$WINDOW_FROM" --arg to "$WINDOW_TO" '
  [inputs | split("\t") | {source: .[0], file: .[1], url: .[2], content_type: .[3], ingest: (.[4] == "1")}] as $all
  | {
      scene: $scene,
      title: "South Florida cold snap and rebound, 30 Jan - 7 Feb 2026",
      window: {from: $from, to: $to},
      recorded_at: $recorded,
      replay_at: $to,
      files: [$all[] | select(.ingest) | del(.ingest)],
      originals: [$all[] | select(.ingest | not) | del(.ingest)]
    }' .manifest.tsv > manifest.json
rm -f .manifest.tsv
du -sh . | awk '{ print "scene size: " $1 }'
