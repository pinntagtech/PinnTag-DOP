"""
Google Maps Full Review Scraper
================================
Fetches ALL reviews for a place given its Place ID.
Extracts: full text, rating, reviewer details, photos, likes, reply threads,
          tags, price range, service/food/atmosphere scores, dates, and more.

Authentication (required for reviews to load):
    1. Run save_cookies.py once to capture your Google session:
           python save_cookies.py
    2. Then pass the cookies file to this scraper:
           python scraper.py --place_id ChIJN1t_tDeuEmsRUsoyG83frY4 --cookies google_cookies.json

Usage:
    python scraper.py --place_id ChIJN1t_tDeuEmsRUsoyG83frY4 --cookies google_cookies.json
    python scraper.py --place_id ChIJN1t_tDeuEmsRUsoyG83frY4 --cookies google_cookies.json --max_reviews 200
    python scraper.py --place_id ChIJN1t_tDeuEmsRUsoyG83frY4 --cookies google_cookies.json --sort lowest
    python scraper.py --place_id ChIJN1t_tDeuEmsRUsoyG83frY4 --cookies google_cookies.json --output reviews.json
    python scraper.py --place_id ChIJN1t_tDeuEmsRUsoyG83frY4 --cookies google_cookies.json --no-headless
"""

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


# ─────────────────────────────────────────────
#  Logger  (timestamped, levelled, coloured)
# ─────────────────────────────────────────────

class Log:
    RESET  = "\033[0m"
    BOLD   = "\033[1m"
    GREEN  = "\033[92m"
    YELLOW = "\033[93m"
    RED    = "\033[91m"
    CYAN   = "\033[96m"
    DIM    = "\033[2m"
    BLUE   = "\033[94m"

    @staticmethod
    def _ts() -> str:
        return datetime.now().strftime("%H:%M:%S")

    @classmethod
    def info(cls, msg: str):
        print(f"{cls.DIM}[{cls._ts()}]{cls.RESET} {cls.CYAN}[INFO]{cls.RESET}  {msg}")

    @classmethod
    def ok(cls, msg: str):
        print(f"{cls.DIM}[{cls._ts()}]{cls.RESET} {cls.GREEN}[ OK ]{cls.RESET}  {msg}")

    @classmethod
    def warn(cls, msg: str):
        print(f"{cls.DIM}[{cls._ts()}]{cls.RESET} {cls.YELLOW}[WARN]{cls.RESET}  {msg}")

    @classmethod
    def err(cls, msg: str):
        print(f"{cls.DIM}[{cls._ts()}]{cls.RESET} {cls.RED}[ERR ]{cls.RESET}  {msg}")

    @classmethod
    def step(cls, msg: str):
        print(f"\n{cls.BOLD}{cls.BLUE}{'─'*60}{cls.RESET}")
        print(f"{cls.BOLD}{cls.BLUE}  {msg}{cls.RESET}")
        print(f"{cls.BOLD}{cls.BLUE}{'─'*60}{cls.RESET}")

    @classmethod
    def progress(cls, current: int, total: int, label: str = ""):
        pct = int((current / max(total, 1)) * 30)
        bar = "█" * pct + "░" * (30 - pct)
        extra = f"  {label}" if label else ""
        print(
            f"\r{cls.DIM}[{cls._ts()}]{cls.RESET} "
            f"{cls.GREEN}[{bar}]{cls.RESET} "
            f"{cls.BOLD}{current}/{total}{cls.RESET}{extra}",
            end="",
            flush=True,
        )

    @classmethod
    def progress_end(cls):
        print()


# ─────────────────────────────────────────────
#  Cookie utilities
# ─────────────────────────────────────────────

def load_cookies(path: str) -> list:
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Cookie file not found: {path}\n"
            "Run `python save_cookies.py` first to capture your Google session."
        )
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"Cookie file {path} is empty or not a list.")

    normalized = []
    for c in raw:
        cookie = {
            "name":   c.get("name", ""),
            "value":  c.get("value", ""),
            "domain": c.get("domain", ".google.com"),
            "path":   c.get("path", "/"),
        }
        if c.get("secure") is not None:
            cookie["secure"] = bool(c["secure"])
        if c.get("httpOnly") is not None:
            cookie["httpOnly"] = bool(c["httpOnly"])
        if c.get("sameSite") in ("Strict", "Lax", "None"):
            cookie["sameSite"] = c["sameSite"]
        expiry = c.get("expires") or c.get("expirationDate")
        if expiry and isinstance(expiry, (int, float)) and expiry > 0:
            cookie["expires"] = int(expiry)
        if cookie["name"] and cookie["value"]:
            normalized.append(cookie)

    Log.ok(f"Loaded {len(normalized)} cookies from {path}")
    return normalized


def check_login_state(page) -> bool:
    try:
        return page.locator(
            'a[href*="myaccount.google.com"], img[alt*="Google Account"], '
            'div[aria-label*="Google Account"], button[aria-label*="Google Account"]'
        ).count() > 0
    except Exception:
        return False


# ─────────────────────────────────────────────
#  Visual highlight (no-op in headless mode)
# ─────────────────────────────────────────────

HIGHLIGHT_INIT_JS = """
window.__hl = function(el, color, label) {
    if (!el) return;
    el.style.outline        = '3px solid ' + color;
    el.style.outlineOffset  = '3px';
    el.style.backgroundColor = color + '22';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var old = document.getElementById('__hl_label');
    if (old) old.remove();
    if (label) {
        var t = document.createElement('div');
        t.id = '__hl_label';
        t.textContent = label;
        t.style.cssText = 'position:fixed;top:10px;right:10px;z-index:9999999;' +
            'background:' + color + ';color:#000;font:bold 13px monospace;' +
            'padding:6px 14px;border-radius:8px;box-shadow:0 2px 10px #0007;pointer-events:none;';
        document.body.appendChild(t);
        setTimeout(function(){ t.remove(); }, 2200);
    }
    setTimeout(function(){
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.style.backgroundColor = '';
    }, 2200);
};
"""

def hl(page, selector: str, color: str = "#00e5ff", label: str = "", headless: bool = True):
    if headless:
        return
    try:
        page.evaluate(
            "(function(sel, c, l){ window.__hl(document.querySelector(sel), c, l); })"
            f"({json.dumps(selector)}, {json.dumps(color)}, {json.dumps(label)})"
        )
    except Exception:
        pass

def hl_el(page, element, color: str = "#00e5ff", label: str = "", headless: bool = True):
    if headless:
        return
    try:
        element.evaluate(
            f"(function(el){{ window.__hl(el, {json.dumps(color)}, {json.dumps(label)}); }})"
        )
    except Exception:
        pass


# ─────────────────────────────────────────────
#  Data models
# ─────────────────────────────────────────────

@dataclass
class ReviewerProfile:
    name: str
    profile_url: Optional[str] = None
    avatar_url: Optional[str] = None
    local_guide: bool = False
    review_count: Optional[int] = None
    photo_count: Optional[int] = None


@dataclass
class OwnerReply:
    text: str
    date: Optional[str] = None
    owner_name: Optional[str] = None


@dataclass
class Review:
    review_id: Optional[str] = None
    reviewer: Optional[ReviewerProfile] = None
    rating: Optional[int] = None
    date: Optional[str] = None           # raw relative string e.g. "5 days ago"
    reviewed_at: Optional[str] = None    # ISO-8601 UTC e.g. "2026-03-15T00:00:00"
    text: Optional[str] = None
    photo_urls: list = field(default_factory=list)
    likes: Optional[int] = None
    tags: dict = field(default_factory=dict)
    price_range: Optional[str] = None
    owner_reply: Optional[OwnerReply] = None
    language: Optional[str] = None


# ─────────────────────────────────────────────
#  Selectors
# ─────────────────────────────────────────────

SEL = {
    "review_block":      'div[data-review-id]',
    "more_button":       'button.w8nwRe',
    "review_text":       'span.wiI7pd',
    "star_img":          'span[aria-label*="star"]',
    "date":              'span.rsqaWe',
    "reviewer_name":     'div.d4r55',
    "reviewer_link":     'a.WNxzHc',
    "reviewer_avatar":   'img.NBa7we',
    "local_guide":       'div.RfnDt span',
    "likes":             'span.pkWtMe',
    "photo_buttons":     'button.Tya61d',
    "owner_reply_block": 'div.CDe7pd',
    "owner_reply_text":  'div.wiI7pd',
    "owner_reply_date":  'span.DZSIDd',
    "tag_blocks":        'div.PBK6be',
}

# Ordered from most specific → most generic
SCROLL_CANDIDATES = [
    'div.m6QErb[aria-label*="Reviews"]',
    'div.m6QErb[aria-label*="review"]',
    'div.m6QErb.DxyBCb',
    'div.m6QErb.WNBkOb',
    'div.m6QErb',
    'div[role="feed"]',
]

SORT_MAP = {"relevant": 0, "newest": 1, "highest": 2, "lowest": 3}


# ─────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────

def build_maps_url(place_id: str) -> str:
    return f"https://www.google.com/maps/place/?q=place_id:{place_id}"

def safe_int(text) -> Optional[int]:
    if not text:
        return None
    digits = re.sub(r"[^\d]", "", str(text))
    return int(digits) if digits else None

def parse_stars(el) -> Optional[int]:
    label = el.get_attribute("aria-label") or ""
    m = re.search(r"(\d)", label)
    return int(m.group(1)) if m else None


# ── Fix 3: Relative date → ISO timestamp ──────────────────────────────────────
# Converts Google's human strings ("5 days ago", "a week ago", "3 months ago")
# to an approximate UTC ISO-8601 string so MongoDB stores a real Date.

def parse_relative_date(raw: Optional[str]) -> Optional[str]:
    """
    "5 days ago"   → "2026-03-15T00:00:00"
    "a week ago"   → "2026-03-13T00:00:00"
    "3 months ago" → "2025-12-20T00:00:00"
    "2 years ago"  → "2024-03-20T00:00:00"
    Returns None if input is empty or unrecognised.
    """
    from datetime import timedelta
    if not raw:
        return None
    s = raw.strip().lower()
    now = datetime.utcnow()

    if s in ("just now", "moments ago", "a moment ago"):
        return now.strftime("%Y-%m-%dT%H:%M:%S")

    # "a week ago" → "1 week ago"
    s = re.sub(r"^an?\s+", "1 ", s)

    for pattern, unit in [
        (r"(\d+)\s+second", "seconds"),
        (r"(\d+)\s+minute", "minutes"),
        (r"(\d+)\s+hour",   "hours"),
        (r"(\d+)\s+day",    "days"),
        (r"(\d+)\s+week",   "weeks"),
        (r"(\d+)\s+month",  "months"),
        (r"(\d+)\s+year",   "years"),
    ]:
        m = re.search(pattern, s)
        if m:
            n = int(m.group(1))
            deltas = {
                "seconds": timedelta(seconds=n),
                "minutes": timedelta(minutes=n),
                "hours":   timedelta(hours=n),
                "days":    timedelta(days=n),
                "weeks":   timedelta(weeks=n),
                "months":  timedelta(days=n * 30),
                "years":   timedelta(days=n * 365),
            }
            return (now - deltas[unit]).strftime("%Y-%m-%dT%H:%M:%S")

    return None  # unrecognised — caller keeps raw string


# ─────────────────────────────────────────────
#  Scraper
# ─────────────────────────────────────────────

class GoogleMapsReviewScraper:

    def __init__(
        self,
        place_id: str,
        max_reviews: int = 100,
        sort: str = "newest",
        headless: bool = True,
        cookies_path: Optional[str] = None,
    ):
        self.place_id     = place_id
        self.max_reviews  = max_reviews
        self.sort         = sort
        self.headless     = headless
        self.cookies_path = cookies_path
        self.reviews: list = []

    # ── browser ───────────────────────────────────────

    def _launch(self, playwright):
        Log.info(f"Launching {'headless' if self.headless else 'visible'} Chromium …")
        return playwright.chromium.launch(
            headless=self.headless,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--window-size=1280,900",
            ],
        )

    def _new_context(self, browser):
        return browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )

    def _inject_cookies(self, context):
        if not self.cookies_path:
            Log.warn("No --cookies file provided. Reviews may not load without login.")
            return
        try:
            cookies = load_cookies(self.cookies_path)
            context.add_cookies(cookies)
            Log.ok(f"Injected {len(cookies)} cookies into browser context")
        except FileNotFoundError as e:
            Log.err(str(e))
            sys.exit(1)
        except Exception as e:
            Log.err(f"Cookie injection failed: {e}")

    # ── stage 1: navigate ─────────────────────────────

    def _navigate(self, page):
        Log.step("STAGE 1 / 5  —  Navigate & Login Check")
        url = build_maps_url(self.place_id)
        Log.info(f"Opening: {url}")
        page.goto(url, wait_until="domcontentloaded", timeout=40_000)

        if not self.headless:
            page.evaluate(HIGHLIGHT_INIT_JS)

        # Dismiss consent banner
        for sel in [
            'button[aria-label*="Accept all"]',
            'button[aria-label*="Accept"]',
            'button[aria-label*="Agree"]',
            'form[action*="consent"] button',
        ]:
            try:
                btn = page.locator(sel).first
                if btn.is_visible(timeout=2000):
                    Log.info("Dismissing consent banner …")
                    hl(page, sel, "#ff9800", "Dismissing banner", self.headless)
                    btn.click()
                    page.wait_for_timeout(800)
                    break
            except Exception:
                pass

        page.wait_for_timeout(2000)

        if self.cookies_path:
            if check_login_state(page):
                Log.ok("Confirmed: logged in as Google user ✓")
            else:
                Log.warn("Could not confirm login — cookies may have expired.")
                Log.warn("Re-run: python save_cookies.py  to refresh session")

        # Click Reviews tab
        Log.info("Clicking Reviews tab …")
        for sel in [
            'button[aria-label*="Reviews"]',
            'button[aria-label*="review"]',
            'button[data-tab-index="1"]',
        ]:
            try:
                btn = page.locator(sel).first
                if btn.is_visible(timeout=4000):
                    hl(page, sel, "#4caf50", "Reviews tab", self.headless)
                    btn.click(timeout=5000)
                    page.wait_for_timeout(2500)
                    Log.ok("Reviews tab clicked — waiting for panel to settle …")
                    break
            except Exception:
                pass

    # ── stage 2: sort ─────────────────────────────────

    def _apply_sort(self, page):
        Log.step("STAGE 2 / 5  —  Apply Sort Order")
        sort_idx = SORT_MAP.get(self.sort, 1)
        if sort_idx == 0:
            Log.info("Sort: default (most relevant) — skipping")
            return
        Log.info(f"Applying sort: {self.sort} …")
        for sel in [
            'button[aria-label*="Sort reviews"]',
            'button[jsaction*="sortReviews"]',
            'button[aria-label*="Sort"]',
        ]:
            try:
                btn = page.locator(sel).first
                if btn.is_visible(timeout=5000):
                    hl(page, sel, "#9c27b0", "Sort button", self.headless)
                    btn.click(timeout=5000)
                    page.wait_for_timeout(1000)
                    items = page.locator(
                        'li[role="menuitemradio"], div[role="menuitemradio"]'
                    ).all()
                    Log.info(f"Sort menu: {len(items)} options found")
                    if len(items) > sort_idx:
                        hl_el(page, items[sort_idx], "#9c27b0", f"Sort: {self.sort}", self.headless)
                        items[sort_idx].click()
                        page.wait_for_timeout(2500)
                        Log.ok(f"Sort applied: {self.sort}")
                    else:
                        Log.warn(f"Sort menu has only {len(items)} items")
                    return
            except Exception:
                pass
        Log.warn("Could not find sort button — using default order")

    # ── stage 3: scroll ───────────────────────────────

    def _find_scroll_container(self, page):
        """
        Find the scrollable reviews panel by trying all known selectors and
        scoring each candidate by (reviews inside × 1000) + scrollHeight.
        The highest-scoring element wins.
        """
        Log.info("Detecting scroll container …")
        best_el    = None
        best_score = -1

        for sel in SCROLL_CANDIDATES:
            try:
                els = page.locator(sel).all()
                for el in els:
                    try:
                        score = el.evaluate("""el => {
                            const r  = el.querySelectorAll('[data-review-id]').length;
                            const sh = el.scrollHeight || 0;
                            return r * 1000 + sh;
                        }""")
                        if score > best_score:
                            best_score = score
                            best_el    = el
                            tag = el.evaluate(
                                "el => el.tagName + '.' + el.className.trim().split(/\\s+/).slice(0,3).join('.')"
                            )
                            Log.info(f"  Candidate <{tag}> — score {score}")
                    except Exception:
                        pass
            except Exception:
                pass

        if best_el:
            Log.ok(f"Using scroll container with score {best_score}")
            hl_el(page, best_el, "#00bcd4", "Scroll container", self.headless)
        else:
            Log.warn("No scroll container found — keyboard fallback will be used")

        return best_el

    def _scroll_to_load(self, page, target: int):
        Log.step("STAGE 3 / 5  —  Scroll to Load Reviews")

        container   = self._find_scroll_container(page)
        last_count  = 0
        stale_ticks = 0
        MAX_STALE   = 10     # ticks with no change before giving up
        BASE_WAIT   = 2200   # ms between scrolls (was 1200 — increased)
        scroll_num  = 0

        Log.info(f"Target: {target}  |  Stale limit: {MAX_STALE} × {BASE_WAIT}ms")

        while True:
            current = page.locator(SEL["review_block"]).count()
            Log.progress(current, target, f"scroll #{scroll_num}  stale={stale_ticks}/{MAX_STALE}")

            if current >= target:
                Log.progress_end()
                Log.ok(f"Target reached: {current} reviews in DOM")
                break

            if current == last_count:
                stale_ticks += 1
                if stale_ticks >= MAX_STALE:
                    Log.progress_end()
                    Log.warn(
                        f"Stale for {MAX_STALE} consecutive scrolls. "
                        f"{current} reviews loaded — likely the full available set."
                    )
                    break
                # Back-off: wait longer when stale
                extra_wait = stale_ticks * 400
                Log.progress_end()
                Log.info(f"  No change (tick {stale_ticks}/{MAX_STALE}) — waiting {BASE_WAIT + extra_wait}ms …")
                page.wait_for_timeout(BASE_WAIT + extra_wait)
            else:
                stale_ticks = 0
                last_count  = current

            # Scroll the panel
            scrolled = False
            if container:
                try:
                    container.evaluate("""el => {
                        el.scrollTop = el.scrollHeight;
                        el.dispatchEvent(new Event('scroll', { bubbles: true }));
                    }""")
                    scrolled = True
                except Exception:
                    Log.warn("Container scroll failed — re-detecting …")
                    container = self._find_scroll_container(page)

            if not scrolled:
                page.keyboard.press("End")

            scroll_num += 1
            page.wait_for_timeout(BASE_WAIT)

        final = page.locator(SEL["review_block"]).count()
        Log.ok(f"Scroll finished — {final} review blocks in DOM")
        return final

    # ── stage 4: expand ───────────────────────────────

    def _expand_all(self, page):
        Log.step("STAGE 4 / 5  —  Expand Truncated Reviews")
        round_n       = 0
        total_clicked = 0

        while True:
            btns = page.locator(f'{SEL["more_button"]}[aria-expanded="false"]').all()
            if not btns:
                break

            Log.info(f"Round {round_n + 1}: {len(btns)} unexpanded 'More' button(s) found …")
            clicked = 0

            for i, btn in enumerate(btns):
                try:
                    btn.scroll_into_view_if_needed(timeout=2000)
                    hl_el(page, btn, "#ff5722", f"Expanding #{total_clicked + i + 1}", self.headless)
                    btn.click(timeout=3000)
                    page.wait_for_timeout(130)
                    clicked += 1
                except Exception as e:
                    Log.warn(f"  Could not click btn #{i+1}: {e}")

            total_clicked += clicked
            Log.info(f"  Clicked {clicked}/{len(btns)} this round  ({total_clicked} total)")
            round_n += 1
            page.wait_for_timeout(700)

        Log.ok(f"Expansion complete — {total_clicked} click(s) across {round_n} round(s)")

    # ── stage 5: parse one block ──────────────────────

    def _parse_review(self, block) -> Review:
        review = Review()
        review.review_id = block.get_attribute("data-review-id")

        # ── Fix 2: language lives on the PARENT div.MyEned, not on div[data-review-id]
        # Walk up to find the nearest ancestor that has a lang attribute.
        try:
            lang = block.evaluate("""el => {
                let node = el;
                while (node && node !== document.body) {
                    const l = node.getAttribute('lang');
                    if (l) return l;
                    node = node.parentElement;
                }
                return null;
            }""")
            review.language = lang or None
        except Exception:
            pass

        # Reviewer
        name = "Unknown"
        try:
            name = block.locator(SEL["reviewer_name"]).first.inner_text(timeout=1000).strip()
        except Exception:
            pass

        link_href = rev_count = photo_count = None
        try:
            link_el   = block.locator(SEL["reviewer_link"]).first
            link_href = link_el.get_attribute("href")
            label     = link_el.get_attribute("aria-label") or ""
            rc = re.search(r"(\d+)\s+review", label, re.I)
            pc = re.search(r"(\d+)\s+photo",  label, re.I)
            if rc: rev_count   = int(rc.group(1))
            if pc: photo_count = int(pc.group(1))
        except Exception:
            pass

        avatar_url = None
        try:
            avatar_url = block.locator(SEL["reviewer_avatar"]).first.get_attribute("src")
        except Exception:
            pass

        local_guide = False
        try:
            guide_text  = block.locator(SEL["local_guide"]).first.inner_text(timeout=500)
            local_guide = "local guide" in guide_text.lower()
            rc = re.search(r"(\d+)\s+review", guide_text, re.I)
            pc = re.search(r"(\d+)\s+photo",  guide_text, re.I)
            if rc: rev_count   = int(rc.group(1))
            if pc: photo_count = int(pc.group(1))
        except Exception:
            pass

        review.reviewer = ReviewerProfile(
            name         = name,
            profile_url  = link_href,
            avatar_url   = avatar_url,
            local_guide  = local_guide,
            review_count = rev_count,
            photo_count  = photo_count,
        )

        # Rating
        try:
            review.rating = parse_stars(block.locator(SEL["star_img"]).first)
        except Exception:
            pass

        # Date — keep raw string AND parse to ISO timestamp
        try:
            raw_date = block.locator(SEL["date"]).first.inner_text(timeout=1000).strip()
            review.date        = raw_date
            review.reviewed_at = parse_relative_date(raw_date)
        except Exception:
            pass

        # Full text
        try:
            review.text = block.locator(SEL["review_text"]).first.inner_text(timeout=1000).strip()
        except Exception:
            pass

        # Photos (thumbnail → full-size URL)
        try:
            for pb in block.locator(SEL["photo_buttons"]).all():
                style = pb.get_attribute("style") or ""
                m = re.search(r'url\("?([^")]+)"?\)', style)
                if m:
                    url = re.sub(r'=w\d+-h\d+.*$', '=s0', m.group(1))
                    review.photo_urls.append(url)
        except Exception:
            pass

        # Likes
        try:
            review.likes = safe_int(
                block.locator(SEL["likes"]).first.inner_text(timeout=500)
            )
        except Exception:
            review.likes = 0

        # Tags
        try:
            for tb in block.locator(SEL["tag_blocks"]).all():
                text = tb.inner_text(timeout=500).strip()
                if ":" in text:
                    k, _, v = text.partition(":")
                    review.tags[k.strip()] = v.strip()
                elif "Price per person" in text:
                    lines = text.split("\n")
                    if len(lines) >= 2:
                        review.price_range = lines[-1].strip()
        except Exception:
            pass
        if "Price per person" in review.tags:
            review.price_range = review.tags.pop("Price per person")

        # Owner reply
        try:
            rb = block.locator(SEL["owner_reply_block"]).first
            if rb.count():
                rtext = rb.locator(SEL["owner_reply_text"]).first.inner_text(timeout=1000).strip()
                rdate = None
                try:
                    rdate = rb.locator(SEL["owner_reply_date"]).first.inner_text(timeout=500).strip()
                except Exception:
                    pass
                review.owner_reply = OwnerReply(text=rtext, date=rdate)
        except Exception:
            pass

        return review

    # ── main ─────────────────────────────────────────

    def scrape(self) -> list:
        Log.step("GOOGLE MAPS REVIEW SCRAPER")
        Log.info(f"Place ID    : {self.place_id}")
        Log.info(f"Max reviews : {self.max_reviews}")
        Log.info(f"Sort        : {self.sort}")
        Log.info(f"Headless    : {self.headless}")
        Log.info(f"Cookies     : {self.cookies_path or 'none'}")

        t0 = time.time()

        with sync_playwright() as p:
            browser = self._launch(p)
            context = self._new_context(browser)
            self._inject_cookies(context)
            page = context.new_page()

            try:
                self._navigate(page)
                self._apply_sort(page)
                self._scroll_to_load(page, self.max_reviews)
                self._expand_all(page)

                Log.step("STAGE 5 / 5  —  Parse Reviews")
                blocks   = page.locator(SEL["review_block"]).all()
                to_parse = blocks[: self.max_reviews]
                Log.info(f"Parsing {len(to_parse)} block(s) …\n")

                # ── Fix 1: deduplicate by review_id ──────────────────────────
                seen_ids: set = set()
                errors = 0
                for i, block in enumerate(to_parse):
                    try:
                        hl_el(page, block, "#4caf50", f"Parsing #{i+1}/{len(to_parse)}", self.headless)
                        review = self._parse_review(block)

                        # ── Fix 1: skip duplicates ────────────────────────────
                        if review.review_id and review.review_id in seen_ids:
                            Log.warn(f"  Duplicate skipped: #{i+1} review_id={review.review_id[:24]}…")
                            continue
                        if review.review_id:
                            seen_ids.add(review.review_id)

                        self.reviews.append(review)

                        # Per-review summary on progress bar
                        rname = review.reviewer.name if review.reviewer else "?"
                        stars = ("★" * (review.rating or 0)) + ("☆" * (5 - (review.rating or 0)))
                        flags = (
                            ("📝" if review.text        else "  ") +
                            (f" 🖼×{len(review.photo_urls)}" if review.photo_urls else "     ") +
                            (" 💬" if review.owner_reply else "  ") +
                            (f" 🏷×{len(review.tags)}"  if review.tags        else "    ")
                        )
                        Log.progress(
                            i + 1, len(to_parse),
                            f"  #{i+1:>4}  {stars}  {flags}  {rname[:26]}"
                        )
                    except Exception as e:
                        errors += 1
                        Log.progress_end()
                        Log.warn(f"Error on block #{i+1}: {e}")

                Log.progress_end()

            finally:
                elapsed = time.time() - t0
                browser.close()

        # Summary
        Log.step("COMPLETE")
        rated = [r for r in self.reviews if r.rating]
        Log.ok(f"Reviews scraped : {len(self.reviews)}")
        Log.info(f"Parse errors    : {errors}")
        Log.info(f"Time elapsed    : {elapsed:.1f}s")
        Log.info(f"With text       : {sum(1 for r in self.reviews if r.text)}")
        Log.info(f"With photos     : {sum(1 for r in self.reviews if r.photo_urls)}")
        Log.info(f"With owner reply: {sum(1 for r in self.reviews if r.owner_reply)}")
        Log.info(f"With tags       : {sum(1 for r in self.reviews if r.tags)}")
        if rated:
            avg = sum(r.rating for r in rated) / len(rated)
            Log.info(f"Average rating  : {avg:.2f} ★")

        return [asdict(r) for r in self.reviews]


# ─────────────────────────────────────────────
#  CLI
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Google Maps Review Scraper")
    parser.add_argument("--place_id",    required=True)
    parser.add_argument("--cookies",     default=None,
                        help="Path to google_cookies.json (from save_cookies.py)")
    parser.add_argument("--max_reviews", type=int, default=100)
    parser.add_argument("--sort",        default="newest",
                        choices=["relevant", "newest", "highest", "lowest"])
    parser.add_argument("--output",      default="reviews.json")
    parser.add_argument("--no-headless", action="store_true",
                        help="Show browser + visual highlights on every action")
    args = parser.parse_args()

    scraper = GoogleMapsReviewScraper(
        place_id     = args.place_id,
        max_reviews  = args.max_reviews,
        sort         = args.sort,
        headless     = not args.no_headless,
        cookies_path = args.cookies,
    )

    reviews = scraper.scrape()

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(reviews, f, ensure_ascii=False, indent=2)

    Log.ok(f"Saved {len(reviews)} reviews → {args.output}")


if __name__ == "__main__":
    main()
