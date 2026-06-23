"""PinnTag DOP — address-parser microservice.

Lives separately from the API so we keep the libpostal system-level C
dependency OFF the API box. The API talks to this service over HTTP via
the standard config.address_parser_url and consumes the canonical
component dict below.

Single endpoint:
    POST /parse  { address: str }
                 → { road, house, city, state, postcode, country }

If any component is missing in the parse, its value is None (or '').
The caller (API address-parse batch) decides what to do with absent
country / postcode / city per its country-fallback rules.

The component-name mapping below normalises libpostal's many labels
(libpostal uses 'state_district', 'suburb', 'country_region', etc.) to
the fixed five keys our API expects. We KEEP the raw libpostal output
on the response under .raw so future operator tooling can introspect
what libpostal actually decided without us having to redeploy the
microservice.
"""
from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("pinntag-address-parser")

# Resolve pypostal lazily so the service can boot to /health even when
# libpostal is missing on the host — useful for staging diagnosis.
_PARSE_FN: Any | None = None
_IMPORT_ERROR: str | None = None


def _load_parser() -> None:
    global _PARSE_FN, _IMPORT_ERROR
    if _PARSE_FN is not None or _IMPORT_ERROR is not None:
        return
    try:
        from postal.parser import parse_address  # type: ignore[import-not-found]
        _PARSE_FN = parse_address
        logger.info("libpostal loaded; parser is live")
    except Exception as e:  # pragma: no cover — system-dep guard
        _IMPORT_ERROR = f"{type(e).__name__}: {e}"
        logger.warning(
            "libpostal NOT available — /parse will return 503 until "
            "the libpostal C library + data are installed and pypostal "
            "is on the import path. Reason: %s",
            _IMPORT_ERROR,
        )


@asynccontextmanager
async def lifespan(_: FastAPI):
    _load_parser()
    yield


app = FastAPI(
    title="pinntag-address-parser",
    lifespan=lifespan,
)


class ParseRequest(BaseModel):
    address: str


class ParseResponse(BaseModel):
    road: str | None = None
    house: str | None = None
    city: str | None = None
    state: str | None = None
    postcode: str | None = None
    country: str | None = None
    # Raw libpostal output, label-by-label, in the order libpostal
    # emitted it. Useful for the operator UI when our normalised mapping
    # decides "city = None" but libpostal actually classified that token
    # under .suburb / .city_district / similar.
    raw: list[dict[str, str]] = []


# Map libpostal labels into our five non-city canonical keys. City has
# its own resolution chain (see CITY_LABEL_PRIORITY below) because
# libpostal picks ONE locality label per address and the choice varies
# by country/region. Labels not surfaced anywhere here are dropped from
# the canonical response (still appear in .raw).
# Source: github.com/openvenues/libpostal#parser-labels.
LABEL_MAP: dict[str, str] = {
    # road / street
    "road": "road",
    # house / building
    "house_number": "house",
    "house": "house",
    # state — libpostal returns "state" for full names or abbrevs.
    # "state_district" is one level below state and is intentionally
    # NOT mapped — it would shadow the real state.
    "state": "state",
    # postcode — labelled "postcode" by libpostal regardless of country.
    "postcode": "postcode",
    # country — libpostal uses "country" for the full country name
    # token. India formats often omit this entirely; we never invent
    # one here, the API layer infers from lat/lng instead.
    "country": "country",
}

# ── Output normalisation ───────────────────────────────────────────
#
# libpostal lowercases + abbreviates everything it emits. Consumers
# (the DOP API, the Data Repair "Fix address" tab, downstream display)
# expect proper-cased values: "Brooklyn", "United States", and full
# US state names ("New York", not "ny"). We normalise once here so
# every consumer gets clean values without having to title-case again.

# Lowercase these when they appear in the middle of a multi-word
# value ("Falls of Neuse Rd", "United States of America"). First/last
# word always capitalises regardless.
SMALL_WORDS: frozenset[str] = frozenset(
    {
        "a", "an", "the",
        "and", "or", "nor", "but", "for", "so", "yet",
        "as", "at", "by", "in", "of", "on", "to", "up", "via",
    }
)

# 2-letter US state abbrev → full name. libpostal emits abbreviations
# in lowercase ("ny"), so keys are lowercase too. Coverage: 50 states +
# DC. Anything not in this map is treated as a non-US value and just
# title-cased — which gives "Uttar Pradesh" for the India case
# correctly without us having to enumerate every Indian state.
US_STATE_MAP: dict[str, str] = {
    "al": "Alabama", "ak": "Alaska", "az": "Arizona", "ar": "Arkansas",
    "ca": "California", "co": "Colorado", "ct": "Connecticut",
    "de": "Delaware", "dc": "District of Columbia",
    "fl": "Florida", "ga": "Georgia", "hi": "Hawaii", "id": "Idaho",
    "il": "Illinois", "in": "Indiana", "ia": "Iowa", "ks": "Kansas",
    "ky": "Kentucky", "la": "Louisiana", "me": "Maine",
    "md": "Maryland", "ma": "Massachusetts", "mi": "Michigan",
    "mn": "Minnesota", "ms": "Mississippi", "mo": "Missouri",
    "mt": "Montana", "ne": "Nebraska", "nv": "Nevada",
    "nh": "New Hampshire", "nj": "New Jersey", "nm": "New Mexico",
    "ny": "New York", "nc": "North Carolina", "nd": "North Dakota",
    "oh": "Ohio", "ok": "Oklahoma", "or": "Oregon",
    "pa": "Pennsylvania", "ri": "Rhode Island",
    "sc": "South Carolina", "sd": "South Dakota", "tn": "Tennessee",
    "tx": "Texas", "ut": "Utah", "vt": "Vermont", "va": "Virginia",
    "wa": "Washington", "wv": "West Virginia", "wi": "Wisconsin",
    "wy": "Wyoming",
}

# Common country variants → canonical name. Anything outside this map
# falls back to plain title-case ("germany" → "Germany"). Keep the
# list small — extending it for every long-tail variant invites drift.
COUNTRY_NORMALIZE: dict[str, str] = {
    "usa": "United States",
    "us": "United States",
    "u.s.": "United States",
    "u.s.a.": "United States",
    "united states": "United States",
    "united states of america": "United States",
    "uk": "United Kingdom",
    "u.k.": "United Kingdom",
    "great britain": "United Kingdom",
    "uae": "United Arab Emirates",
}


def _cap_simple(word: str) -> str:
    return word[:1].upper() + word[1:].lower() if word else word


def _cap_word(word: str) -> str:
    # Hyphenated tokens: capitalise each part ("stratford-on-avon" →
    # "Stratford-On-Avon"). We don't apply the small-word rule inside
    # a hyphenated group — it's nearly always a compound proper noun.
    if "-" in word:
        return "-".join(_cap_simple(p) for p in word.split("-"))
    return _cap_simple(word)


def smart_title_case(value: str | None) -> str | None:
    """Title-case a multi-word string while keeping SMALL_WORDS
    lowercase when they're between (not at) the ends. Single-word
    inputs always capitalise.
    """
    if not value:
        return value
    words = value.split()
    n = len(words)
    out: list[str] = []
    for i, w in enumerate(words):
        if 0 < i < n - 1 and w.lower() in SMALL_WORDS:
            out.append(w.lower())
        else:
            out.append(_cap_word(w))
    return " ".join(out)


def format_state(value: str | None) -> str | None:
    """Expand US 2-letter abbreviations via US_STATE_MAP; otherwise
    title-case as-is. Detection is case-insensitive on the .lower()
    key — handles "NY", "ny", "Ny" uniformly. Full names not in the
    map ("uttar pradesh") fall through to title-case → "Uttar Pradesh".
    """
    if not value:
        return value
    trimmed = value.strip()
    if not trimmed:
        return trimmed
    mapped = US_STATE_MAP.get(trimmed.lower())
    if mapped:
        return mapped
    return smart_title_case(trimmed)


def format_country(value: str | None) -> str | None:
    """Normalise common country variants via COUNTRY_NORMALIZE first;
    everything else title-cases. Caller is responsible for handling
    None (India case where libpostal omits the country — the API layer
    runs the lat/lng bbox fallback separately)."""
    if not value:
        return value
    trimmed = value.strip()
    if not trimmed:
        return trimmed
    normalised = COUNTRY_NORMALIZE.get(trimmed.lower())
    if normalised:
        return normalised
    return smart_title_case(trimmed)


# City resolution chain — libpostal picks ONE of these labels per
# address and which one it picks varies by country / region density:
#   - "city" — the normal case (e.g. Noida from the India sample,
#     standalone US cities like Raleigh).
#   - "city_district" — NYC boroughs (Brooklyn / Queens / Manhattan):
#     libpostal models them as subdivisions of New York City rather
#     than cities themselves. Before this fix the borough was dropped,
#     leaving city=null.
#   - "suburb" — dense neighbourhoods libpostal under-classifies
#     (the original India-case fallback).
#   - "town" / "village" — small US/EU localities.
# First non-empty value wins. The first label libpostal emitted under
# each tier is what we keep (first-write-wins per tier — important so
# we don't shadow a real "city" with a later "town" token).
CITY_LABEL_PRIORITY: tuple[str, ...] = (
    "city",
    "city_district",
    "suburb",
    "town",
    "village",
)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok" if _PARSE_FN is not None else "degraded",
        "service": "pinntag-address-parser",
        "libpostal_loaded": _PARSE_FN is not None,
        "import_error": _IMPORT_ERROR,
    }


@app.post("/parse", response_model=ParseResponse)
def parse(req: ParseRequest) -> ParseResponse:
    if _PARSE_FN is None:
        # System dependency missing — fail loud-but-soft so the API
        # batch can log + skip without retrying tight.
        raise HTTPException(
            status_code=503,
            detail=f"libpostal_unavailable: {_IMPORT_ERROR}",
        )

    raw_input = (req.address or "").strip()
    if not raw_input:
        raise HTTPException(status_code=400, detail="address_empty")

    # libpostal accepts the whole single-line string; it tokenises +
    # labels internally. We pass it through verbatim.
    parsed = _PARSE_FN(raw_input)  # list[(value, label)]

    canonical: dict[str, str | None] = {
        "road": None,
        "house": None,
        "city": None,
        "state": None,
        "postcode": None,
        "country": None,
    }
    raw_list: list[dict[str, str]] = []

    # City candidates collected by libpostal label — resolved via the
    # CITY_LABEL_PRIORITY chain after the loop so we never shadow a
    # real "city" with a later "city_district" / "suburb" token.
    city_candidates: dict[str, str] = {}

    for value, label in parsed:
        label_s = str(label)
        value_s = str(value).strip()
        raw_list.append({"label": label_s, "value": value_s})

        if label_s in CITY_LABEL_PRIORITY:
            # First-write-wins per label tier.
            if label_s not in city_candidates and value_s:
                city_candidates[label_s] = value_s
            continue

        key = LABEL_MAP.get(label_s)
        if key is not None:
            # First-write-wins: libpostal may emit two of the same
            # label (e.g. two "road" tokens for compound names) — we
            # keep the first.
            if canonical.get(key) is None:
                canonical[key] = value_s

    # City: pick the first non-empty candidate in priority order.
    for label_s in CITY_LABEL_PRIORITY:
        cand = city_candidates.get(label_s)
        if cand:
            canonical["city"] = cand
            break

    # ── Normalise for display ─────────────────────────────────────
    # libpostal returns lowercased + abbreviated values. The DOP
    # consumer expects display-ready forms (operator UI, eventual
    # writes back to the business doc). postcode + house stay raw —
    # numbers don't title-case, and zip/PIN formats are authoritative
    # as libpostal returned them.
    canonical["city"] = smart_title_case(canonical["city"])
    canonical["road"] = smart_title_case(canonical["road"])
    canonical["state"] = format_state(canonical["state"])
    canonical["country"] = format_country(canonical["country"])

    return ParseResponse(**canonical, raw=raw_list)
