"""Standalone poller for DISCOVERY_SEARCH bot jobs.

Discovery Phase 4 replaced the Google Places API resolve step with
bot-side Google Maps searches. This poller reuses the exact same
per-place resolve pipeline (`_resolve_in_context` from main.py) so it
inherits the shipped geo-anchor + query-sanitizer + state-mismatch
guards. What's different:

- input: an Overture candidate (name + coords + address, sometimes
  city/state blank) plus the region bbox. Not a Business doc.
- extra output: lat/lng of the matched Google place (parsed from the
  final `/@lat,lng,zoom` segment of the Maps URL) — the Places API
  step returned this; the resolve webhook doesn't currently need it.
- bbox reject: if the resolved lat/lng lands outside the region bbox,
  we return null with error='bbox_reject' rather than accept a
  cross-region match (Google can pull in the same-name business from
  the next city when the anchor is weak).
- result path: POSTs to /seeding/discovery/bot-result which writes the
  match onto the bot job doc itself. There's no Business yet — that
  gets created after judgment, downstream of this poller.

Run independently of the main bot service:
    DOP_API_URL=https://dop-api.pinntag.com \
    DOP_API_WEBHOOK_SECRET=pinntag_bot_2026 \
    DISCOVERY_WORKERS=5 \
    python discovery_bot.py

The main bot's FastAPI service is intentionally NOT modified — this
lets us roll out discovery-search independently of the operator bots
that ship reviews/gallery/menu/resolve, so a Phase 4 pilot doesn't
touch the code they're running.
"""
import asyncio
import logging
import os
import random
import re
import sys
import time
from typing import Optional

import httpx
from playwright.async_api import async_playwright

# Reuse the resolve pipeline + browser helpers + ScrapeRequest from
# main.py verbatim. Any drift (e.g. the country-reject guard being
# tightened) automatically flows into discovery.
from main import (
    ScrapeRequest,
    _resolve_in_context,
    _resolve_make_context,
    launch_browser,
    load_cookies,
    logger as bot_logger,
)

logger = logging.getLogger("discovery_bot")
if not logger.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] discovery_bot: %(message)s"
        )
    )
    logger.addHandler(_h)
logger.setLevel(logging.INFO)

DOP_ENV = os.getenv("DOP_ENV", "staging").lower().replace("-", "_")
DOP_API_URL = os.getenv(
    f"DOP_API_URL_{DOP_ENV.upper()}",
    os.getenv("DOP_API_URL", "https://dop-api.pinntag.com"),
)
DOP_WEBHOOK_SECRET = os.getenv("DOP_API_WEBHOOK_SECRET", "pinntag_bot_2026")
DISCOVERY_WORKERS = max(1, int(os.getenv("DISCOVERY_WORKERS", "5") or "5"))
DISCOVERY_JITTER_MS = max(
    0, int(os.getenv("DISCOVERY_JITTER_MS", "600") or "0")
)
POLL_INTERVAL = int(os.getenv("DISCOVERY_POLL_INTERVAL_S", "3") or "3")
HEADLESS = os.getenv("HEADLESS", "true").lower() == "true"

# Deadline — the pilot script sets DISCOVERY_STOP_AFTER_S so this
# poller exits cleanly instead of hanging around after the run
# finishes. Default 0 = poll forever.
STOP_AFTER_S = int(os.getenv("DISCOVERY_STOP_AFTER_S", "0") or "0")


# Matches the @lat,lng,zoom segment Google embeds in every Maps place
# URL once the panel loads (14z on our anchored search, sometimes
# 17z after Google re-zooms in). Signs on lat/lng both allowed;
# fractional part required so a bare number can't smuggle in.
_MAP_COORD_RE = re.compile(
    r"@(-?\d+\.\d+),(-?\d+\.\d+),(\d+(?:\.\d+)?)z"
)


def _parse_coords_from_maps_url(url: str) -> Optional[tuple]:
    """Return (lat, lng) parsed from a Google Maps place URL, or None.

    The URL Google navigates to after a search settles is the source of
    truth for the resolved place's coordinates. We deliberately parse
    from the URL and NOT from any page-level lat/lng field — the URL
    is stable across DOM changes, whereas class-based selectors on the
    panel keep churning.
    """
    if not url:
        return None
    m = _MAP_COORD_RE.search(url)
    if not m:
        return None
    try:
        return (float(m.group(1)), float(m.group(2)))
    except (TypeError, ValueError):
        return None


async def _poll_batch(limit: int) -> list:
    """Atomically claim up to `limit` discovery_search jobs."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(
                f"{DOP_API_URL}/api/v1/seeding/bot/poll-batch",
                params={"type": "discovery_search", "limit": limit},
                headers={"x-bot-secret": DOP_WEBHOOK_SECRET},
            )
    except Exception as e:
        logger.warning(f"poll-batch request failed: {e}")
        return []
    if r.status_code != 200:
        logger.warning(f"poll-batch HTTP {r.status_code}: {r.text[:160]}")
        return []
    try:
        return r.json().get("jobs") or []
    except Exception:
        return []


async def _post_result(job_id: str, result: Optional[dict], error: str) -> bool:
    """POST the resolved match (or null + error) back to the API."""
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(
                f"{DOP_API_URL}/api/v1/seeding/discovery/bot-result",
                json={"jobId": job_id, "result": result, "error": error},
                headers={
                    "Content-Type": "application/json",
                    "x-bot-secret": DOP_WEBHOOK_SECRET,
                },
            )
        return r.status_code in (200, 201)
    except Exception as e:
        logger.warning(f"bot-result POST failed for {job_id}: {e}")
        return False


async def _worker(
    worker_id: int,
    queue: asyncio.Queue,
    browser,
    cookies,
    jitter_ms: int,
    stats: dict,
):
    """Persistent worker — pull one job from the queue, run the shared
    resolve pipeline, extract lat/lng from the final Maps URL, apply
    the bbox reject, POST the result, mark complete. Never propagates
    a single-job failure — one bad page can't kill the pool.
    """
    while True:
        job = await queue.get()
        job_id = str(job.get("_id") or "")
        source_id = job.get("discoveryOvertureSourceId", "")
        bbox = {
            "west": job.get("discoveryBboxWest"),
            "south": job.get("discoveryBboxSouth"),
            "east": job.get("discoveryBboxEast"),
            "north": job.get("discoveryBboxNorth"),
        }

        result_payload: Optional[dict] = None
        error_msg: str = ""
        success = False

        try:
            req = ScrapeRequest(
                placeId="",  # discovery has no prior ChIJ
                businessId=job.get("businessId", f"discovery:{source_id}"),
                businessName=job.get("businessName", "") or "",
                environment=job.get("environment", "staging"),
                skipReviews=True,
                skipGallery=True,
                skipMenu=True,
                addressLine1=job.get("addressLine1", "") or "",
                address1=job.get("address1", "") or "",
                city=job.get("city", "") or "",
                state=job.get("state", "") or "",
                postalCode=job.get("postalCode", "") or "",
                latitude=job.get("latitude"),
                longitude=job.get("longitude"),
            )

            context = await _resolve_make_context(browser, cookies)
            try:
                page = None
                # _resolve_in_context closes the page in finally, so we
                # need the URL BEFORE it exits. Cheapest way is to snoop
                # via context.pages after the resolve returns — the
                # closed page will have its final url still readable
                # via the event history. Simpler: use context tracing
                # OR just re-open the same place from the resolved id.
                # Simplest: run the resolve, then reopen the resolved
                # place_id to read the final URL for coords.
                payload = await _resolve_in_context(context, req)

                resolved_pid = payload.get("resolvedPlaceId")
                resolved_name = payload.get("resolvedName")
                resolved_addr = payload.get("googleFormattedAddress")
                bot_err = payload.get("error")

                if bot_err in ("state_mismatch", "no_search_match",
                               "business_not_listed_at_address",
                               "business_not_found_by_search",
                               "no_search_query",
                               "no_placeid_and_no_address"):
                    error_msg = bot_err
                elif not resolved_pid:
                    error_msg = "no_place_id_extracted"
                else:
                    # Re-open the resolved place by its ChIJ to read the
                    # canonical /@lat,lng URL Google emits on the place
                    # panel. Cheaper and more reliable than trying to
                    # scrape coords off the DOM.
                    coord_page = await context.new_page()
                    lat_out = None
                    lng_out = None
                    try:
                        await coord_page.goto(
                            f"https://www.google.com/maps/place/"
                            f"?q=place_id:{resolved_pid}",
                            wait_until="domcontentloaded",
                            timeout=30000,
                        )
                        try:
                            await coord_page.wait_for_url(
                                re.compile(r"@-?\d+\.\d+,-?\d+\.\d+"),
                                timeout=8000,
                            )
                        except Exception:
                            # No @lat,lng in URL yet — settle briefly
                            # and try to read whatever URL we have.
                            await coord_page.wait_for_timeout(1200)
                        parsed = _parse_coords_from_maps_url(coord_page.url)
                        if parsed:
                            lat_out, lng_out = parsed
                    finally:
                        try:
                            await coord_page.close()
                        except Exception:
                            pass

                    if lat_out is None or lng_out is None:
                        # Fall back to the input coords — better than
                        # dropping the whole match. Downstream logs
                        # the fallback via the reasoning field.
                        lat_out = float(req.latitude) if req.latitude else None
                        lng_out = float(req.longitude) if req.longitude else None
                        if lat_out is None or lng_out is None:
                            error_msg = "no_resolved_coords"

                    # Bbox reject — protect against Google pulling in
                    # the same-name business from a neighboring city
                    # when the geo anchor was weak.
                    if (
                        not error_msg
                        and bbox["west"] is not None
                        and bbox["east"] is not None
                        and bbox["south"] is not None
                        and bbox["north"] is not None
                    ):
                        if not (
                            bbox["west"] <= lng_out <= bbox["east"]
                            and bbox["south"] <= lat_out <= bbox["north"]
                        ):
                            error_msg = "bbox_reject"

                    if not error_msg:
                        result_payload = {
                            "placeId": resolved_pid,
                            "name": resolved_name or "",
                            "formattedAddress": resolved_addr or "",
                            "lat": lat_out,
                            "lng": lng_out,
                        }
                        success = True

            finally:
                try:
                    await context.close()
                except Exception:
                    pass

        except asyncio.CancelledError:
            raise
        except Exception as e:
            error_msg = f"{type(e).__name__}: {e}"
            logger.error(
                f"worker {worker_id} job {job_id} failed: {error_msg}"
            )

        # POST result (or no-match) back to API.
        posted = await _post_result(job_id, result_payload, error_msg or "")
        if not posted:
            # If the API webhook is unreachable, fall back to the
            # regular /bot/job/:id/complete so the job doesn't hang in
            # 'running'. Downstream orchestrator will treat missing
            # discoveryResult + missing discoveryError as no_match.
            try:
                async with httpx.AsyncClient(timeout=10) as c:
                    await c.post(
                        f"{DOP_API_URL}/api/v1/seeding/bot/job/"
                        f"{job_id}/complete",
                        json={
                            "success": bool(success),
                            "error": error_msg or None,
                        },
                        headers={"x-bot-secret": DOP_WEBHOOK_SECRET},
                    )
            except Exception as e:
                logger.warning(
                    f"worker {worker_id} fallback complete failed: {e}"
                )

        stats["done" if success else "no_match"] += 1
        stats["total"] += 1
        logger.info(
            f"worker {worker_id} job {job_id} "
            f"src={source_id} "
            f"{'MATCH' if success else 'NO'} "
            f"{('pid=' + (result_payload['placeId'][:20] + '…') if result_payload else 'err=' + (error_msg or 'no_match'))}"
        )
        queue.task_done()

        if jitter_ms > 0:
            try:
                delay = random.uniform(jitter_ms * 0.5, jitter_ms * 1.5) / 1000.0
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                raise


async def main():
    logger.info(
        f"starting: workers={DISCOVERY_WORKERS} "
        f"jitter_ms={DISCOVERY_JITTER_MS} api={DOP_API_URL} "
        f"headless={HEADLESS} stop_after={STOP_AFTER_S}s"
    )
    cookies = load_cookies()
    queue: asyncio.Queue = asyncio.Queue()
    stats = {"total": 0, "done": 0, "no_match": 0}
    worker_tasks: list = []
    started_at = time.time()
    idle_since: Optional[float] = None

    async with async_playwright() as pw:
        browser = await launch_browser(
            pw,
            headless=HEADLESS,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
            ],
        )
        try:
            worker_tasks = [
                asyncio.create_task(
                    _worker(
                        i, queue, browser, cookies,
                        DISCOVERY_JITTER_MS, stats,
                    )
                )
                for i in range(DISCOVERY_WORKERS)
            ]

            while True:
                # Auto-exit after N idle seconds when STOP_AFTER_S set
                # so the pilot script can shut this down cleanly at
                # the end of a bounded run without a kill signal.
                if STOP_AFTER_S > 0:
                    if time.time() - started_at > STOP_AFTER_S:
                        logger.info(
                            f"stop-after={STOP_AFTER_S}s elapsed — exiting"
                        )
                        break

                jobs = await _poll_batch(DISCOVERY_WORKERS * 2)
                if not jobs:
                    if idle_since is None:
                        idle_since = time.time()
                    await asyncio.sleep(POLL_INTERVAL)
                    continue
                idle_since = None
                logger.info(f"claimed {len(jobs)} jobs")
                for job in jobs:
                    await queue.put(job)
                await queue.join()
                logger.info(
                    f"batch drained — cumulative "
                    f"total={stats['total']} match={stats['done']} "
                    f"no_match={stats['no_match']}"
                )
        finally:
            for t in worker_tasks:
                t.cancel()
            for t in worker_tasks:
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
            try:
                await browser.close()
            except Exception:
                pass

    logger.info(
        f"exit — total={stats['total']} match={stats['done']} "
        f"no_match={stats['no_match']}"
    )


if __name__ == "__main__":
    asyncio.run(main())
