// Parse Google Maps hours strings → the regularTiming schema used by
// PinnTag's main backend:
//
//   { sunday..saturday: { duration: { startHour, startMinute, endHour, endMinute } } }
//
// AUTHENTIC-DATA RULE (from the brief): parse or LEAVE-AS-IS. Never
// fabricate. A day we can map to a single Closed / 24-hour / single
// time-range case is written authoritatively. A day we cannot map is
// SKIPPED — the caller keeps its prior stored value for that day, rather
// than overwriting with a guessed Closed. The whole business is no
// longer flagged just because one day didn't parse.

// DaySchedule shape mirrors the real PinnTag main-backend Schema:
//   open:   { duration: {startHour,...,endMinute},    isClosed: false }
//   closed: { duration: null,                         isClosed: true  }
// The consumer stores ONE duration per day — no multi-slot/array support.
// Split-shift days (lunch close + dinner reopen) are therefore collapsed
// into a single envelope spanning the earliest start to the latest end:
// "11:30 am–3 pm 5–10 pm" → 11:30–22:00. The midday close is lost, but
// the alternative (skip the row) leaves the placeholder default in place,
// which is worse for the operator UI. The legacy DOP shape (zero-duration
// object for closed) is wrong — the app treats closed-vs-open by reading
// isClosed, not by checking whether every Hour/Minute is zero.
export type Duration = {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
};

export type ParsedDay = {
  duration: Duration | null;
  isClosed: boolean;
};

export type ParsedWeek = {
  sunday: ParsedDay;
  monday: ParsedDay;
  tuesday: ParsedDay;
  wednesday: ParsedDay;
  thursday: ParsedDay;
  friday: ParsedDay;
  saturday: ParsedDay;
};

// Per-day result shape. The caller merges parsedDays onto the existing
// regularTiming and reports unparsedDays via resolveStatus for visibility.
export interface HoursParseResult {
  ok: boolean;
  // 'empty'       — hoursRaw was [] (caller marks hours for re-resolve).
  // 'shape'       — hoursRaw wasn't an array, or held non-string entries.
  // 'parsed'      — at least one day parsed; caller overlays parsedDays.
  // 'none_parsed' — lines present but none reduced to a writable day.
  kind: 'empty' | 'shape' | 'parsed' | 'none_parsed';
  parsedDays: Partial<ParsedWeek>;
  // Recognised-but-unparseable day keys (lowercased) so the operator UI
  // can show "Friday couldn't be parsed" without sending the whole
  // business to review.
  unparsedDays: string[];
  // Short per-reject audit (logged, not surfaced to operator).
  rejectDetails: { day?: string; raw: string; reason: string }[];
  shapeError?: string;
}

const DAY_KEYS: (keyof ParsedWeek)[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

const DAY_ALIASES: Record<string, keyof ParsedWeek> = {
  sun: 'sunday', sunday: 'sunday',
  mon: 'monday', monday: 'monday',
  tue: 'tuesday', tues: 'tuesday', tuesday: 'tuesday',
  wed: 'wednesday', weds: 'wednesday', wednesday: 'wednesday',
  thu: 'thursday', thur: 'thursday', thurs: 'thursday', thursday: 'thursday',
  fri: 'friday', friday: 'friday',
  sat: 'saturday', saturday: 'saturday',
};

const CLOSED_DAY: ParsedDay = {
  duration: null,
  isClosed: true,
};
const OPEN_24H_DAY: ParsedDay = {
  duration: { startHour: 0, startMinute: 0, endHour: 24, endMinute: 0 },
  isClosed: false,
};

// All dash variants Google emits: hyphen-minus, en/em dash, figure dash,
// minus sign. Pre-normalise to ASCII '-' before parsing.
const DASH_VARIANTS = /[–—‒−]/g;
// Thin/no-break/regular whitespace, normalised to single spaces.
const SPACE_VARIANTS = /[   ]/g;

export function normalizeHoursLine(value: string): string {
  return value
    .replace(DASH_VARIANTS, '-')
    .replace(SPACE_VARIANTS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Match a single time token: "9 AM", "9:30 AM", "9", "noon", "midnight".
const TIME_TOKEN = /^(noon|midnight|(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)$/i;

// Returns the raw 12-hour clock hour when meridiem is omitted; the caller
// is responsible for deciding whether (and how) to fill in the meridiem.
// When meridiem is present the hour is normalised to 24-hour form.
function parseTimeToken(
  raw: string,
): { hour: number; minute: number; meridiem: 'am' | 'pm' | null } | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;

  if (t === 'noon') return { hour: 12, minute: 0, meridiem: 'pm' };
  if (t === 'midnight') return { hour: 0, minute: 0, meridiem: 'am' };

  const m = t.match(TIME_TOKEN);
  if (!m) return null;
  let hour = parseInt(m[2] ?? '', 10);
  const minute = m[3] ? parseInt(m[3], 10) : 0;
  const ap = m[4]?.toLowerCase() as 'am' | 'pm' | undefined;

  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;

  if (ap === 'pm' && hour < 12) hour += 12;
  else if (ap === 'am' && hour === 12) hour = 0;

  return { hour, minute, meridiem: ap ?? null };
}

// Apply a meridiem to a raw 12-hour clock hour. Used when the start token
// of a range omitted am/pm and we are inheriting from the end token.
function applyMeridiem(rawHour: number, meridiem: 'am' | 'pm'): number {
  if (meridiem === 'pm' && rawHour < 12) return rawHour + 12;
  if (meridiem === 'am' && rawHour === 12) return 0;
  return rawHour;
}

// Strip Google's live-status badges that the bot now picks up alongside
// the time range when reading the highlighted current-day row (cell may
// contain "Open now\n10 AM-7 PM" or similar). These are decoration, the
// time range is authoritative. Safe to strip whole tokens because they
// never overlap with a dash-separated range syntactically.
function stripStatusBadges(input: string): string {
  return input
    .replace(/\bopen(?:s)?\s+now\b/gi, ' ')
    .replace(/\bclos(?:ed|es|ing)\s+now\b/gi, ' ')
    .replace(/\bclos(?:es|ing)\s+soon\b/gi, ' ')
    .replace(/\bopen(?:s|ing)?\s+soon\b/gi, ' ')
    .replace(/\bopens?\s+(?:in|at)\s+\S+(?:\s*(?:am|pm))?/gi, ' ')
    .replace(/\bclos(?:es|ing)\s+(?:in|at)\s+\S+(?:\s*(?:am|pm))?/gi, ' ')
    .replace(/\breopens?\s+(?:in|at)\s+\S+(?:\s*(?:am|pm))?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip "Copy open hours" copy-affordance UI text wherever it appears in
// the line. Handles bare, leading-comma, trailing-comma, and both-ends
// forms case-insensitively (La Stella case: "Saturday: 4-10 pm, Copy
// open hours"; also bare-leading variants emitted by some Google grid
// layouts). Eats the adjacent comma so the result doesn't subsequently
// fail the no-split-shift comma check downstream.
function stripCopyOpenHours(input: string): string {
  return input
    .replace(/\s*,?\s*\bcopy open hours\b\s*,?\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}

// One range's worth of TIME-TIME → 24h Duration, applying meridiem
// inheritance from the end token onto the start when Google omitted it.
// Returns null if either token is unparseable, the end has no meridiem,
// or the resulting duration is zero (ambiguous).
function parseRange(rawStart: string, rawEnd: string): Duration | null {
  const start = parseTimeToken(rawStart);
  const end = parseTimeToken(rawEnd);
  if (!start || !end) return null;

  // The end token must carry an explicit meridiem (or be noon/midnight).
  // We never guess the end's period — that's the anchor we inherit from.
  if (!end.meridiem) return null;

  // Inherit end's meridiem onto the start token when Google omitted it
  // because both halves share a period ("12-10 pm", "1-8 pm"). If the
  // inherited choice produces start>end same-day (e.g. "11-2 pm" →
  // 11pm-2pm is invalid same-day) fall back to the opposite meridiem —
  // 11am-2pm is the intended lunch range.
  let startHour = start.hour;
  if (!start.meridiem) {
    const rawStartHour = start.hour;
    const inheritedHour = applyMeridiem(rawStartHour, end.meridiem);
    const inheritedMin = inheritedHour * 60 + start.minute;
    const endMinCheck = end.hour * 60 + end.minute;
    if (inheritedMin > endMinCheck) {
      const flipped: 'am' | 'pm' = end.meridiem === 'pm' ? 'am' : 'pm';
      startHour = applyMeridiem(rawStartHour, flipped);
    } else {
      startHour = inheritedHour;
    }
  }

  // Past-midnight close ("2 PM-4 AM", "5 PM-12 AM") is written AS-IS:
  // the main app interprets end<start as a next-day close. Do NOT add
  // 24 to endHour — the schema stores raw 0-23 values and the consumer
  // does the wraparound. Equal start/end ("12 PM-12 PM") is still
  // ambiguous (zero-duration vs 24h vs typo); skip instead of guessing.
  const startMin = startHour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  if (endMin === startMin) return null;

  return {
    startHour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute,
  };
}

// Match a TIME token in the time-portion of a row, used to extract
// ranges from a possibly multi-shift string. Mirrors the alternatives
// parseTimeToken accepts: noon, midnight, or H[:MM] with optional
// am/pm. We don't anchor the regex — it's used with .exec to scan for
// non-overlapping TIME-TIME ranges below.
const TIME_FRAGMENT = String.raw`(?:noon|midnight|\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?)`;
const RANGE_RE = new RegExp(
  `(${TIME_FRAGMENT})\\s*-\\s*(${TIME_FRAGMENT})`,
  'gi',
);

// Try to parse the time-string after the day label. Returns one of:
//   - { duration } when ok (single slot, OR N ranges collapsed to one
//     earliest-start → latest-end span)
//   - null when the string is unparseable (caller leaves the day as-is)
function parseDayTimeString(rawTime: string): ParsedDay | null {
  let t = rawTime.toLowerCase().trim();
  if (!t) return null;

  // Strip Google's holiday/special-event advisory suffix. The actual
  // hours value is still authoritative — only the "might differ" /
  // "might vary" warning is decoration. Without this strip the row
  // would reject and we'd leave a valid day unwritten over what is
  // just a calendar annotation (e.g. Juneteenth week).
  t = t.replace(/\s*hours might (?:differ|vary)\b.*$/i, '').trim();
  if (!t) return null;

  // Now strip live-status badges (Open now / Closes soon / Closes at 7
  // PM, etc.). These appear in the highlighted current-day row because
  // the bot reads inner_text of the whole cell.
  t = stripStatusBadges(t);
  if (!t) return null;

  t = stripCopyOpenHours(t);
  if (!t) return null;

  if (t === 'closed') return CLOSED_DAY;
  if (t.startsWith('open 24') || t === '24 hours' || t === 'open 24 hours') {
    return OPEN_24H_DAY;
  }

  // Reject decorations we explicitly don't parse:
  //   - holiday notes
  //   - parenthesised lunch-break notes etc. (the day-side annotation
  //     e.g. "Friday(Juneteenth)" is stripped earlier in splitDayLine —
  //     parens here are something else and we still skip)
  //   - semicolon-separated lists
  // Comma-separated split shifts ("11 AM-2 PM, 5-10 PM") still reject:
  // the multi-range parser below targets the space-separated and
  // glued-meridiem forms Google actually emits.
  if (t.includes(',')) return null;
  if (t.includes('holiday')) return null;
  if (t.includes('(')) return null;
  if (t.includes(';')) return null;

  // Glue fix for the split-shift case where Google omits the gap
  // between the first range's end-meridiem and the second range's
  // start hour ("3 pm5-10 pm", "3:30 pm4:15-8 pm"). Insert a space
  // between "(am|pm)" and an immediately-following digit so the
  // range tokeniser below can split cleanly.
  t = t.replace(/(am|pm)(?=\d)/gi, '$1 ');

  // Extract one or more TIME-TIME ranges. Multi-range handles split
  // shifts (lunch close / dinner open) which Google renders as two
  // ranges on one day line: "11:30 am-3 pm 5-10 pm" → lunch + dinner.
  const ranges: Duration[] = [];
  RANGE_RE.lastIndex = 0;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = RANGE_RE.exec(t)) !== null) {
    // Reject if there's non-whitespace junk BETWEEN ranges that the
    // range regex skipped over — that's text we don't understand and
    // we'd rather leave the day untouched than guess.
    const gap = t.slice(lastEnd, m.index).trim();
    if (gap.length > 0) return null;
    const range = parseRange(m[1], m[2]);
    if (!range) return null;
    ranges.push(range);
    lastEnd = m.index + m[0].length;
  }

  // Anything left after the last range (other than whitespace) is
  // unrecognised tail — skip rather than write a partial result.
  if (t.slice(lastEnd).trim().length > 0) return null;
  if (ranges.length === 0) return null;

  if (ranges.length === 1) {
    return { duration: ranges[0], isClosed: false };
  }

  // Collapse split-shift days (N>1 ranges) into a single envelope:
  // earliest start → latest end. The consumer schema stores one
  // duration per day, so we can't preserve the midday close — but
  // emitting the envelope is closer to truth than leaving the
  // placeholder default in place. Sort by start so the first range
  // contributes the start and the last range contributes the end;
  // this also handles the (rare) overnight-second-range case
  // ("11 am-2 pm 10 pm-2 am") correctly — the late-night range sorts
  // last and its end<start state is preserved as-is for the consumer
  // wraparound (same as a single overnight close).
  const sorted = [...ranges].sort(
    (a, b) =>
      a.startHour * 60 + a.startMinute - (b.startHour * 60 + b.startMinute),
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const collapsed: Duration = {
    startHour: first.startHour,
    startMinute: first.startMinute,
    endHour: last.endHour,
    endMinute: last.endMinute,
  };
  const collapsedStartMin = collapsed.startHour * 60 + collapsed.startMinute;
  const collapsedEndMin = collapsed.endHour * 60 + collapsed.endMinute;
  if (collapsedStartMin === collapsedEndMin) return null;

  return { duration: collapsed, isClosed: false };
}

// Split "Monday: 9 AM-5 PM" → ["Monday", "9 AM-5 PM"].
//
// This is the SINGLE place where Google's holiday/advisory decoration
// is stripped, in the spec-prescribed order:
//   (a) split day from time on the FIRST ":" only
//   (b) day: strip /\s*\([^)]*\)\s*/  (e.g. "Friday(Juneteenth)" → "Friday")
//   (c) time: strip /\s*Hours might (differ|vary)[^]*$/i  (e.g.
//       "10 am-6 pm Hours might differ" → "10 am-6 pm")
// THEN the caller validates the cleaned tokens. parseDayTimeString
// keeps its own copy of (c) as a defensive belt-and-suspenders strip
// and adds status-badge stripping for "Open now" et al.
function splitDayLine(line: string): { day: string; time: string } | null {
  // Pre-clean: strip "Copy open hours" UI text wherever it sits on the
  // line (Google's hours grid sometimes appends the copy-affordance label
  // to a row's text content). Done before splitting so the badge can't
  // disrupt the day/time partition either side of the colon, and so the
  // adjacent comma doesn't survive into the comma-reject downstream.
  line = stripCopyOpenHours(line);

  // (a) Split on FIRST colon. Anything before is the day label;
  //     anything after is the time spec.
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  let day = line.slice(0, colon);
  let time = line.slice(colon + 1);

  // (b) Day token strip — paren annotation is Google's holiday note,
  //     it doesn't change which weekday this row is.
  day = day.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

  // (c) Time strip — "Hours might differ" / "Hours might vary" is an
  //     advisory tail; the time range before it is authoritative.
  //     [^]* (not .*) so a stray newline can't end the match early.
  time = time.replace(/\s*Hours might (differ|vary)[^]*$/i, '').trim();

  if (!day || !time) return null;
  return { day, time };
}

/**
 * Parse a Google Maps hours array (e.g.
 *   ["Monday: 9 AM-5 PM", "Tuesday: Closed", …])
 * into a per-day patch the caller overlays onto the existing
 * regularTiming. Days that cannot be parsed are returned in
 * unparsedDays — the caller MUST leave the existing value for those days
 * untouched, NOT default them to Closed.
 */
export function parseHoursRaw(hoursRaw: unknown): HoursParseResult {
  const empty: HoursParseResult = {
    ok: false,
    kind: 'shape',
    parsedDays: {},
    unparsedDays: [],
    rejectDetails: [],
  };

  if (!Array.isArray(hoursRaw)) {
    return { ...empty, shapeError: 'hoursRaw_not_array' };
  }
  if (hoursRaw.length === 0) {
    // Empty hoursRaw — caller treats this as "captured nothing" and
    // sends to review (review:no_hours_captured), leaving regularTiming
    // untouched rather than certifying the placeholder.
    return { ...empty, kind: 'empty' };
  }

  const parsedDays: Partial<ParsedWeek> = {};
  const unparsedDays: string[] = [];
  const rejectDetails: { day?: string; raw: string; reason: string }[] = [];
  const seenDayKeys = new Set<keyof ParsedWeek>();

  for (const rawLine of hoursRaw) {
    if (typeof rawLine !== 'string') {
      rejectDetails.push({
        raw: String(rawLine),
        reason: 'non_string_entry',
      });
      continue;
    }

    const line = normalizeHoursLine(rawLine);
    const split = splitDayLine(line);
    if (!split) {
      console.warn(
        `[HOURS-PARSER] reject raw=${JSON.stringify(rawLine)} ` +
          `dayOk=false timeOk=false (no_day_label)`,
      );
      rejectDetails.push({ raw: rawLine, reason: 'no_day_label' });
      continue;
    }

    const dayKey = DAY_ALIASES[split.day.toLowerCase()];
    if (!dayKey) {
      console.warn(
        `[HOURS-PARSER] reject raw=${JSON.stringify(rawLine)} ` +
          `cleanedDay=${JSON.stringify(split.day)} ` +
          `cleanedTime=${JSON.stringify(split.time)} ` +
          `dayOk=false (unknown_day_label)`,
      );
      rejectDetails.push({
        day: split.day,
        raw: rawLine,
        reason: 'unknown_day_label',
      });
      continue;
    }

    // Track that we observed a row for this weekday — even if its time
    // doesn't parse, we surface the unparsed day via unparsedDays so the
    // operator UI knows we tried and skipped it.
    seenDayKeys.add(dayKey);

    const parsed = parseDayTimeString(split.time);
    if (!parsed) {
      console.warn(
        `[HOURS-PARSER] reject raw=${JSON.stringify(rawLine)} ` +
          `cleanedDay=${JSON.stringify(split.day)} ` +
          `cleanedTime=${JSON.stringify(split.time)} ` +
          `dayOk=true timeOk=false (unparseable_time — day left as-is)`,
      );
      if (!unparsedDays.includes(dayKey)) unparsedDays.push(dayKey);
      rejectDetails.push({
        day: dayKey,
        raw: rawLine,
        reason: 'unparseable_time',
      });
      continue;
    }

    parsedDays[dayKey] = parsed;
    // If a later row writes the same day, last-write-wins. Drop the
    // earlier unparsed entry if we just successfully wrote this day.
    const i = unparsedDays.indexOf(dayKey);
    if (i !== -1) unparsedDays.splice(i, 1);
  }

  // Bot may not have captured all 7 rows (logged separately). Any day
  // never seen in hoursRaw is silently absent from both parsedDays and
  // unparsedDays — caller will simply leave it as-is.
  void DAY_KEYS;
  void seenDayKeys;

  const parsedCount = Object.keys(parsedDays).length;
  if (parsedCount === 0) {
    return {
      ok: false,
      kind: 'none_parsed',
      parsedDays,
      unparsedDays,
      rejectDetails,
    };
  }

  return {
    ok: true,
    kind: 'parsed',
    parsedDays,
    unparsedDays,
    rejectDetails,
  };
}
