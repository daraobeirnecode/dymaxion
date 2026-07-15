---
title: "California Coordinate Systems: CA Albers, State Plane II and III, VLM"
category: coordinate-systems
topic_tags: [california, state-plane, albers, epsg-3310, vertical-land-motion, sacramento]
status: stub
---

# California Coordinate Systems: CA Albers, State Plane II and III, VLM

California statewide analysis standardizes on NAD83 / California Albers (EPSG:3310, also called Teale Albers after the Teale Data Center), an equal-area conic with standard parallels 34°N and 40.5°N, central meridian −120°, and false northing −4,000,000 m — CAL FIRE FRAP, CDFW, and CNRA data ship in it. The California Coordinate System (CCS83) divides the state into six Lambert Conformal Conic State Plane zones; the Sacramento region straddles Zone II (EPSG:2226, counties including Sacramento, El Dorado, Placer) and Zone III (EPSG:2227, San Joaquin and the Bay Area southward), both in US survey feet — a Zone II/III mix-up shifts data by hundreds of kilometers. US survey foot vs international foot matters: California statute uses the US survey foot (0.3048006096 m), and NGS deprecated the survey foot nationally in 2023, so verify the linear unit in WKT (`Foot_US` vs `Foot`). UTM zone 10N (EPSG:26910) covers most of the state west of −120° including Sacramento; zone 11N (EPSG:26911) covers the eastern desert. Vertical land motion (VLM) is severe: San Joaquin Valley groundwater subsidence exceeds 30 cm/yr in places (tracked by DWR's TRE Altamira InSAR dataset), and Delta island subsidence means published NAVD88 elevations decay in accuracy — record survey epoch with every elevation dataset. NAD83(2011) epoch 2010.0 is the current CORS-based realization used by Caltrans and county surveyors. For levee, floodplain, and Delta work, pair horizontal CCS83 zones with NAVD88 (GEOID18) and note the InSAR-derived VLM correction date.

TODO: expand from authoritative source (California Public Resources Code CCS83 definitions; CA DWR SGMA InSAR VLM data; NOAA NGS state plane documentation).
