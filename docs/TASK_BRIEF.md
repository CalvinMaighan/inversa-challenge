# Inversa take-home: original task brief

Verbatim from Inversa (pasted 2026-10-01). Evaluate every change against this file. Scope decision: Florida only (see `docs/research.md` section 6).

## Welcome

Congratulations on advancing to the take-home challenge. This exercise is designed to give us a practical view of how you approach an ambitious, open-ended engineering problem.

The task is deliberately open-ended so we can understand how you navigate ambiguity, define the problem, make decisions, and choose where to focus your time.

The scope is intentionally ambitious and would be difficult to complete through line-by-line coding alone. We expect you to use agentic AI tools to accelerate implementation while retaining ownership of the key decisions and final result.

## The task

Build a natural-language-driven interface for exploring a question about the physical and natural world using three or more relevant real-time data feeds. Design the ingestion, storage, and query system behind it, then deliver a single interface for exploring questions in natural language, following evidence to its source, and replaying change over time.

## Technical requirements

- Three or more relevant real-time data feeds organized around a coherent shared question
- Backend infrastructure for collecting, storing, and querying those feeds
- A web interface supporting natural-language queries across real-time and historical data
- An interactive timeline for visualizing and replaying changes over time

## Deliverable requirements

- At least one meaningful part of the solution must use a technology that is new to you.
- The finished demo must be deployed online and accessible through a shared URL rather than requiring us to run it locally.

## What we're looking for

- A well-designed system with clear boundaries, thoughtful data modeling, and sensible architectural decisions.
- A well-designed production agent that can interpret natural-language questions, use the available data and tools effectively, and return reliable, grounded answers.
- A responsive, human-friendly interface that makes the underlying data easy to explore and understand.
- A fast experience in which queries feel interactive and the timeline scrubs smoothly.
- High-quality data handling, including accurate real-time information and clear treatment of stale, missing, or conflicting data.

## What we don't care about here

- You do not need to implement authentication, user accounts, permissions, or other identity-management features.
- We will not evaluate the submission based on test-coverage percentages, strict style-guide compliance, or similar measures of procedural completeness.

## Be prepared to answer questions about

- The question you chose to explore, why it matters, and why you selected the data sources that support it.
- The major product and technical design choices you made, including the alternatives you considered and the tradeoffs involved.
- How you would evolve the system if it needed to support substantially more data, traffic, users, or use cases.

## Sample data source ideas

### Water & Climate

- **USGS Water Data APIs**: real-time streamflow, gage height, and hundreds of other parameters across approximately 13,000 U.S. monitoring locations. `api.waterdata.usgs.gov`
- **ECCC MSC GeoMet**: Canadian government API providing thousands of real-time and archived weather, climate, and water datasets. `api.weather.gc.ca`
- **NOAA NWS API**: official U.S. weather service API offering live observations, forecasts, and severe-weather alerts. `api.weather.gov`
- **Open-Meteo**: free weather API with current conditions, forecasts, and a deep historical archive; no API key required. `open-meteo.com`
- **NOAA Tides & Currents**: coastal water-level observations updated every six minutes, along with tide predictions and decades of historical data. `api.tidesandcurrents.noaa.gov`
- **NDBC**: real-time wind, wave, and sea-temperature readings from offshore buoys. `ndbc.noaa.gov`
- **USGS Earthquakes**: global seismic events published as GeoJSON and updated every minute. `earthquake.usgs.gov`
- **NASA FIRMS**: satellite-detected active fires worldwide, typically available with approximately three hours of latency. `firms.modaps.eosdis.nasa.gov`
- **OpenAQ**: open air-quality measurements aggregated from monitoring stations around the world. `openaq.org`

### Wildlife

- **iNaturalist**: a continuous worldwide stream of citizen-contributed wildlife observations, including photos and locations. `api.inaturalist.org`
- **eBird API 2.0**: recent bird sightings by region from the world's largest birding network. eBird API documentation
- **GBIF**: a global index of species-occurrence records offering deep historical coverage, typically with several days of ingestion lag. GBIF developer documentation
- **Movebank**: GPS tracks from tagged animals, with some studies offering public and near-real-time data. `movebank.org`

### Human Patterns

- **GBFS Bike Share**: live dock and bike availability from BIXI, Citi Bike, and many other city bike-share systems, typically refreshed every 30–60 seconds; historical data is generally unavailable. `gbfs.org`
- **GTFS Realtime Transit**: live vehicle positions and service delays from the STM, MTA, and hundreds of other transit agencies, provided in Protocol Buffers format; historical data is generally unavailable. `gtfs.org/realtime`
- **OpenSky Network**: live air-traffic data collected through a community-operated ADS-B sensor network; historical data is not included in the free tier. `opensky-network.org/api`
- **aisstream.io**: free real-time ship-movement data delivered over WebSocket; historical data is not provided. `aisstream.io`
- **Wikipedia EventStreams**: a live server-sent event stream containing every edit made across Wikimedia projects. `stream.wikimedia.org`
