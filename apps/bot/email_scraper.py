"""Email extraction from a small business's own website.

Design principles:

- Extract, never infer. If an address is not literally present on a page
  under the business's website, we do NOT store it. There is no
  `info@` + domain fallback. No pattern-generation. No third-party APIs.

- Cheap path first. Most small-business sites are static enough that a
  plain httpx GET returns the email in the HTML. Only fall back to
  Playwright when the fetched body looks JS-rendered (near-empty text
  content or a known SPA root marker).

- Politeness. One concurrent request per domain, 15s per page, up to
  5 pages total per business, 60s total budget. No retries beyond the
  one per URL httpx does internally.

- Confidence tiers:
    A — mailto: on a contact/about page
    B — mailto: elsewhere, OR plain text on a contact/about page
    C — plain text elsewhere, or de-obfuscated

  On tie: prefer domain-match, then earliest in document order.

- Rejection rules apply BEFORE tiering (see REJECT_DOMAINS,
  PLACEHOLDER_LOCALS, ROLE_LOCALS). Role addresses (privacy@, dpo@ etc.)
  are the special case — rejected UNLESS they're the only hits, in
  which case they land at tier C.

Public entry point: `run_email_scrape(website, budget_seconds=60)`.
Returns a dict shaped to match the emailScrape webhook payload the API
expects.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from html.parser import HTMLParser
from typing import Iterable, Optional
from urllib.parse import urljoin, urlparse

import httpx

logger = logging.getLogger("pinntag-bot.email")

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

PAGE_TIMEOUT_SECONDS = 15
MAX_PAGES_PER_BUSINESS = 5
DEFAULT_TOTAL_BUDGET_SECONDS = 60
CONTACT_LINK_RE = re.compile(r"contact|about|reach|team", re.I)
CONTACT_PATH_RE = re.compile(r"(?:^|/)(contact|about|reach|team)(?:[/?#]|$)", re.I)

# ── Rejection lists ─────────────────────────────────────────────────
# Anything ending on one of these domains is boilerplate captured from
# the site-builder chrome, not the merchant. Reject before tiering so we
# never accidentally promote them.
REJECT_DOMAINS = frozenset({
    "wix.com",
    "squarespace.com",
    "shopify.com",
    "godaddy.com",
    "sentry.io",
    "sentry-cdn.com",
    "wordpress.com",
    "wixpress.com",
    "example.com",
    "example.org",
    "domain.com",
    "email.com",
})

# Placeholder locals we always drop. Case-insensitive comparison.
PLACEHOLDER_LOCALS = frozenset({
    "example",
    "you",
    "your",
    "test",
    "name",
    "user",
    "username",
    "email",
    "sample",
    "someone",
    "no-reply",
    "noreply",
})

# Role addresses. Rejected UNLESS they're the only hits on the whole
# site — in that case they downgrade to tier C.
ROLE_LOCALS = frozenset({
    "privacy",
    "dpo",
    "abuse",
    "postmaster",
    "webmaster",
    "legal",
    "compliance",
    "security",
})

# File extensions that give away that we matched a filename, not an
# email. Never trust addresses that end in one of these.
ASSET_EXTENSIONS = frozenset({
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "css",
    "js",
    "json",
    "html",
    "htm",
    "pdf",
    "zip",
})

EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+-])"
    r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})"
    r"(?![A-Za-z0-9._%+-])"
)

# De-obfuscation. Matches "name [at] domain [dot] com" variants — the
# common ones only; anything more exotic gets skipped rather than
# risking a bad match.
OBFUSCATED_RE = re.compile(
    r"([A-Za-z0-9._%+-]+)"
    r"\s*(?:\[at\]|\(at\))\s*"
    r"([A-Za-z0-9.-]+)"
    r"\s*(?:\[dot\]|\(dot\))\s*"
    r"([A-Za-z]{2,})",
    re.I,
)

SPA_ROOT_MARKERS = (
    'id="root"',
    'id="app"',
    "ng-app",
    "data-reactroot",
    'ng-controller',
    'data-vue-app',
)


# ── HTML utilities ──────────────────────────────────────────────────


class _EmailHTMLParser(HTMLParser):
    """Extracts mailto hrefs and rendered text from an HTML document."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.mailtos: list[tuple[str, int]] = []  # (email, index in doc)
        self.links: list[str] = []
        self._text_chunks: list[str] = []
        self._skip_depth = 0
        # Bytes-in-doc counter for stable "document order" of mailto
        # matches. Not exact byte offsets — good enough to sort ties.
        self._pos = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        if tag in ("script", "style", "noscript"):
            self._skip_depth += 1
            return
        self._pos += 1
        if tag == "a":
            href = ""
            for k, v in attrs:
                if k == "href" and v:
                    href = v
                    break
            if href.lower().startswith("mailto:"):
                # Strip the query string ("?subject=...")
                raw = href[7:].split("?", 1)[0].strip()
                # href may be URL-encoded in odd cases — treat literally
                if raw:
                    self.mailtos.append((raw, self._pos))
            if href:
                self.links.append(href)

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style", "noscript") and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        self._text_chunks.append(data)
        self._pos += len(data)

    def visible_text(self) -> str:
        # Collapse consecutive whitespace so the visible-text regex
        # doesn't split emails across newlines.
        return re.sub(r"\s+", " ", "".join(self._text_chunks)).strip()


def _parse_html(body: str) -> _EmailHTMLParser:
    parser = _EmailHTMLParser()
    try:
        parser.feed(body)
    except Exception as e:
        # Malformed HTML happens; take whatever we got. Never fail the
        # scrape on parser noise.
        logger.debug(f"HTML parse warning: {e}")
    return parser


def _looks_js_rendered(body: str, visible_text: str) -> bool:
    """Rough heuristic: near-empty text on a body that looks like a SPA
    shell. Used to decide whether the Playwright fallback is worth it."""
    if len(visible_text) >= 400:
        return False
    lower = body.lower()
    for marker in SPA_ROOT_MARKERS:
        if marker in lower:
            return True
    return False


def _normalize_website(url: str) -> Optional[str]:
    if not url:
        return None
    url = url.strip()
    if not url:
        return None
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    try:
        parsed = urlparse(url)
        if not parsed.netloc:
            return None
        return url
    except Exception:
        return None


def _site_domain(url: str) -> Optional[str]:
    try:
        host = urlparse(url).hostname or ""
        # Strip a leading www. for domain-match comparisons.
        return host.lower().removeprefix("www.")
    except Exception:
        return None


def _email_domain(email: str) -> str:
    return email.rsplit("@", 1)[-1].lower() if "@" in email else ""


def _is_contact_url(url: str) -> bool:
    return bool(CONTACT_PATH_RE.search(url or ""))


# ── Rejection + tiering ─────────────────────────────────────────────


def _is_rejected(email: str) -> tuple[bool, Optional[str]]:
    """Return (rejected, reason). Reason is for logging only."""
    if "@" not in email:
        return True, "no @"
    local, _, domain = email.partition("@")
    local_l = local.lower().strip()
    domain_l = domain.lower().strip()

    if not local_l or not domain_l:
        return True, "empty local/domain"

    # TLD sanity: at least one dot and a 2+ char TLD.
    if "." not in domain_l:
        return True, "no dot in domain"
    tld = domain_l.rsplit(".", 1)[-1]
    if len(tld) < 2 or not tld.isalpha():
        return True, f"bad tld {tld!r}"

    # Asset-extension trailing on the domain (very rare, but seen when
    # people paste image filenames like "logo@2x.png")
    if tld.lower() in ASSET_EXTENSIONS:
        return True, f"asset extension {tld}"

    if local_l in PLACEHOLDER_LOCALS:
        return True, f"placeholder local {local_l!r}"

    # Reject boilerplate/site-builder domains outright.
    for bad in REJECT_DOMAINS:
        if domain_l == bad or domain_l.endswith("." + bad):
            return True, f"reject domain {bad}"

    return False, None


def _tier(
    email: str,
    source: str,  # 'mailto' | 'text' | 'obfuscated'
    page_is_contact: bool,
) -> Optional[str]:
    """Return 'A' | 'B' | 'C' | None. None means "rejected outright."""
    if source == "mailto":
        return "A" if page_is_contact else "B"
    if source == "text":
        return "B" if page_is_contact else "C"
    if source == "obfuscated":
        return "C"
    return None


# ── Extraction per page ─────────────────────────────────────────────


class _EmailHit:
    __slots__ = ("email", "tier", "source_url", "position", "kind", "role")

    def __init__(
        self,
        email: str,
        tier: str,
        source_url: str,
        position: int,
        kind: str,
        role: bool,
    ) -> None:
        self.email = email
        self.tier = tier
        self.source_url = source_url
        self.position = position
        self.kind = kind  # 'mailto' | 'text' | 'obfuscated'
        self.role = role


def _extract_from_html(
    body: str,
    source_url: str,
    page_is_contact: bool,
) -> tuple[list[_EmailHit], list[str], _EmailHTMLParser]:
    """Extract all candidate emails from a single page's HTML.
    Returns (hits, link_hrefs, parser)."""
    parser = _parse_html(body)
    hits: list[_EmailHit] = []
    seen: set[str] = set()

    def _add(raw_email: str, kind: str, position: int) -> None:
        email = raw_email.strip().rstrip(".,;")
        # De-dupe within a page (case-insensitive). We still keep the
        # first-seen casing.
        key = email.lower()
        if key in seen:
            return
        rejected, reason = _is_rejected(email)
        if rejected:
            logger.debug(f"reject {email} on {source_url}: {reason}")
            return
        tier = _tier(email, kind, page_is_contact)
        if tier is None:
            return
        seen.add(key)
        local = email.split("@", 1)[0].lower()
        hits.append(
            _EmailHit(
                email=email,
                tier=tier,
                source_url=source_url,
                position=position,
                kind=kind,
                role=local in ROLE_LOCALS,
            )
        )

    # 1. mailto: hrefs (highest signal — an owner deliberately linked)
    for raw, pos in parser.mailtos:
        _add(raw, "mailto", pos)

    # 2. plain-text emails in the rendered body
    text = parser.visible_text()
    for m in EMAIL_RE.finditer(text):
        _add(m.group(1), "text", m.start())

    # 3. de-obfuscation, on the visible text
    for m in OBFUSCATED_RE.finditer(text):
        candidate = f"{m.group(1)}@{m.group(2)}.{m.group(3)}"
        _add(candidate, "obfuscated", m.start())

    return hits, parser.links, parser


def _pick_best(
    all_hits: list[_EmailHit],
    site_domain: Optional[str],
) -> tuple[Optional[_EmailHit], list[str]]:
    """Given every candidate hit collected across every page, pick the
    single best per the tie-break rules and return (best, alternates).

    - Highest tier wins (A > B > C).
    - On tie: prefer role=False.
    - On tie: prefer domain-match with the site.
    - On tie: earliest position in document order (across pages
      chronologically visited).
    """
    non_role = [h for h in all_hits if not h.role]
    role_only = [h for h in all_hits if h.role]
    # Role addresses only qualify if they're the ONLY thing we found.
    pool = non_role if non_role else role_only
    if not pool:
        return None, []

    if not non_role and role_only:
        # Downgrade role-only hits to tier C (see doc string).
        for h in pool:
            h.tier = "C"

    tier_rank = {"A": 0, "B": 1, "C": 2}

    def _sort_key(h: _EmailHit) -> tuple:
        domain_match = 0 if (
            site_domain and _email_domain(h.email) == site_domain
        ) else 1
        return (
            tier_rank.get(h.tier, 9),  # A wins
            domain_match,  # matching domain wins
            h.position,  # earlier wins
        )

    pool.sort(key=_sort_key)
    best = pool[0]
    alternates = [h.email for h in pool[1:] if h.email.lower() != best.email.lower()]
    return best, alternates


# ── Contact-page discovery ──────────────────────────────────────────


def _rank_contact_candidates(
    home_url: str,
    hrefs: Iterable[str],
    limit: int = 3,
) -> list[str]:
    """Filter and rank links from the homepage that look like contact
    pages. Same-domain only, deduped, capped at `limit`."""
    home_host = _site_domain(home_url)
    if not home_host:
        return []
    seen: set[str] = set()
    scored: list[tuple[int, str]] = []
    for raw in hrefs:
        if not raw:
            continue
        try:
            joined = urljoin(home_url, raw)
        except Exception:
            continue
        parsed = urlparse(joined)
        if parsed.scheme not in ("http", "https"):
            continue
        host = (parsed.hostname or "").lower().removeprefix("www.")
        if host != home_host:
            continue
        # Score: text/path match with contact-y words, path length as
        # a mild tiebreak (shorter paths tend to be canonical).
        text = f"{parsed.path} {parsed.fragment}"
        if not CONTACT_LINK_RE.search(text):
            continue
        clean = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        key = clean.lower().rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        scored.append((len(parsed.path or "/"), clean))
    scored.sort()
    return [u for _, u in scored[:limit]]


# ── Fetchers ────────────────────────────────────────────────────────


async def _fetch_httpx(
    url: str,
    client: httpx.AsyncClient,
) -> Optional[str]:
    try:
        r = await client.get(
            url,
            timeout=PAGE_TIMEOUT_SECONDS,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        )
    except (httpx.HTTPError, asyncio.TimeoutError) as e:
        logger.warning(f"httpx fetch failed {url}: {e}")
        return None
    if r.status_code >= 400:
        logger.info(f"httpx {r.status_code} for {url}")
        return None
    ct = (r.headers.get("content-type") or "").lower()
    if ct and "text/html" not in ct and "application/xhtml" not in ct:
        # PDFs, JSON APIs, etc. — skip
        return None
    return r.text


async def _fetch_playwright(
    url: str,
    launch_browser,  # callable — reuse main.py's helper
) -> Optional[str]:
    """Playwright fallback for SPA sites. Uses the shared launch_browser
    helper so we honour BOT_BROWSER_CHANNEL / CHROME_PATH the same way
    the rest of the bot does."""
    try:
        from playwright.async_api import async_playwright
    except Exception as e:
        logger.warning(f"Playwright unavailable: {e}")
        return None

    async with async_playwright() as p:
        browser = None
        try:
            browser = await launch_browser(
                p,
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                ],
            )
            context = await browser.new_context(
                viewport={"width": 1280, "height": 900},
                user_agent=USER_AGENT,
            )
            page = await context.new_page()
            await page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=PAGE_TIMEOUT_SECONDS * 1000,
            )
            # Give React/etc a beat to hydrate. Not perfect; if the site
            # is genuinely slow we'll just miss it and move on.
            await page.wait_for_timeout(1500)
            return await page.content()
        except Exception as e:
            logger.warning(f"playwright fetch failed {url}: {e}")
            return None
        finally:
            if browser is not None:
                try:
                    await browser.close()
                except Exception:
                    pass


# ── Public entry point ─────────────────────────────────────────────


async def run_email_scrape(
    website: str,
    launch_browser=None,
    budget_seconds: int = DEFAULT_TOTAL_BUDGET_SECONDS,
) -> dict:
    """Scrape emails from the given website.

    Returns a dict matching the emailScrape webhook shape:
      { email, confidence, sourceUrl, domainMatch, alternates,
        pagesVisited, skipped? }

    - `skipped: 'no_website'` when the input URL is missing/invalid.
    - `email == None` when the site was reachable but no acceptable
      address was found; the API records this as "nothing found" (not
      an error).
    """
    normalized = _normalize_website(website)
    if not normalized:
        return {
            "email": None,
            "confidence": None,
            "sourceUrl": None,
            "domainMatch": False,
            "alternates": [],
            "pagesVisited": 0,
            "skipped": "no_website",
        }

    site_domain = _site_domain(normalized)
    started = time.monotonic()

    def budget_left() -> float:
        return max(0.0, budget_seconds - (time.monotonic() - started))

    all_hits: list[_EmailHit] = []
    pages_visited = 0
    limits = httpx.Limits(max_connections=1, max_keepalive_connections=1)

    async with httpx.AsyncClient(
        limits=limits,
        http2=False,
        timeout=PAGE_TIMEOUT_SECONDS,
    ) as client:
        # 1. Homepage
        homepage_html = await _fetch_httpx(normalized, client)
        pages_visited += 1

        homepage_hits: list[_EmailHit] = []
        contact_candidates: list[str] = []
        homepage_parser: Optional[_EmailHTMLParser] = None

        if homepage_html is not None:
            homepage_hits, hrefs, homepage_parser = _extract_from_html(
                homepage_html, normalized, _is_contact_url(normalized),
            )
            all_hits.extend(homepage_hits)
            contact_candidates = _rank_contact_candidates(normalized, hrefs)

        # 2. Contact-y same-domain links, up to 3.
        for link in contact_candidates:
            if pages_visited >= MAX_PAGES_PER_BUSINESS:
                break
            if budget_left() <= 1.0:
                logger.info(f"[EMAIL] budget exhausted after {pages_visited}p")
                break
            body = await _fetch_httpx(link, client)
            pages_visited += 1
            if body is None:
                continue
            hits, _hrefs, _parser = _extract_from_html(body, link, True)
            all_hits.extend(hits)

        # 3. Playwright fallback — only if we found nothing AND the
        # homepage looks JS-rendered AND we have a launcher AND we have
        # budget for one more page load.
        should_playwright = (
            not all_hits
            and homepage_html is not None
            and homepage_parser is not None
            and launch_browser is not None
            and _looks_js_rendered(homepage_html, homepage_parser.visible_text())
            and pages_visited < MAX_PAGES_PER_BUSINESS
            and budget_left() > 3.0
        )
        if should_playwright:
            logger.info(f"[EMAIL] playwright fallback for {normalized}")
            spa_body = await _fetch_playwright(normalized, launch_browser)
            pages_visited += 1
            if spa_body:
                spa_hits, spa_hrefs, spa_parser = _extract_from_html(
                    spa_body,
                    normalized,
                    _is_contact_url(normalized),
                )
                all_hits.extend(spa_hits)

                # If Playwright surfaced a contact link we missed on the
                # httpx pass, we can try one more page under it. Budget
                # permitting.
                if not any(
                    h for h in all_hits if h.tier in ("A", "B")
                ):
                    for link in _rank_contact_candidates(
                        normalized, spa_hrefs, limit=1,
                    ):
                        if pages_visited >= MAX_PAGES_PER_BUSINESS:
                            break
                        if budget_left() <= 1.0:
                            break
                        body = await _fetch_httpx(link, client)
                        pages_visited += 1
                        if body is None:
                            continue
                        hits, _h, _p = _extract_from_html(body, link, True)
                        all_hits.extend(hits)

    best, alternates = _pick_best(all_hits, site_domain)
    if best is None:
        return {
            "email": None,
            "confidence": None,
            "sourceUrl": None,
            "domainMatch": False,
            "alternates": [],
            "pagesVisited": pages_visited,
        }

    return {
        "email": best.email,
        "confidence": best.tier,
        "sourceUrl": best.source_url,
        "domainMatch": bool(site_domain) and _email_domain(best.email) == site_domain,
        "alternates": alternates,
        "pagesVisited": pages_visited,
    }
