// Thin wrapper around Google Places API v1 :searchText. Used to resolve
// an Overture candidate (name + address + coord) into an authoritative
// Google placeId. NOT via the existing pinntagApiToken proxy in
// enrichment.engine.ts — Phase 2 uses the direct GOOGLE_MAPS_API_KEY as
// the spec calls for.
//
// searchText is preferred over :autocomplete for this pipeline: given a
// (name, coord) pair we want the top matching place, not a prefix-match
// suggestion list.
//
// Spatial scoping uses `locationRestriction.rectangle` (a hard bound)
// rather than `locationBias.circle` (a hint). The circle was letting
// Google fall back to name-search when nothing matched inside the bias
// radius — see the Chesley Brown 19km false-match in the Phase 2 pilot.
// Rectangle trades that off for the possibility of a legit-but-slightly-
// outside-box place returning zero results; we surface that as a caller-
// visible null rather than a silent miss.

import axios from 'axios';
import { Logger } from '@nestjs/common';
import { metersToLatDeg, metersToLngDeg } from './dedup-helpers';

const log = new Logger('PlacesClient');

const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location';

export interface PlacesResolveInput {
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  // Half-width of the search rectangle in meters. Default 250 → ~500m
  // square around the candidate coord.
  boxHalfSideMeters?: number;
}

export interface PlacesResolveResult {
  placeId: string;
  name: string;
  formattedAddress: string;
  lat: number;
  lng: number;
}

export async function resolvePlaceIdBySearchText(
  input: PlacesResolveInput,
  apiKey: string,
): Promise<PlacesResolveResult | null> {
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not set');
  const query = input.address
    ? `${input.name}, ${input.address}`
    : input.name;
  const halfSide = input.boxHalfSideMeters ?? 250;
  const dLat = metersToLatDeg(halfSide);
  const dLng = metersToLngDeg(halfSide, input.lat);
  const body = {
    textQuery: query,
    locationRestriction: {
      rectangle: {
        low: {
          latitude: input.lat - dLat,
          longitude: input.lng - dLng,
        },
        high: {
          latitude: input.lat + dLat,
          longitude: input.lng + dLng,
        },
      },
    },
    maxResultCount: 1,
  };
  try {
    const res = await axios.post(SEARCH_TEXT_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      timeout: 8000,
    });
    const places = res?.data?.places;
    if (!places || !places.length) return null;
    const p = places[0];
    if (!p?.id || !p?.location) return null;
    return {
      placeId: String(p.id),
      name: String(p.displayName?.text ?? ''),
      formattedAddress: String(p.formattedAddress ?? ''),
      lat: Number(p.location.latitude),
      lng: Number(p.location.longitude),
    };
  } catch (e) {
    const msg =
      (e as any)?.response?.data?.error?.message ?? (e as Error).message;
    log.warn(`searchText failed for "${query}": ${msg}`);
    return null;
  }
}
