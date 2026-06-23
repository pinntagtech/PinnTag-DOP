import { parseHours, adaptScraperData } from './scraper-adapter';
import { parseHoursRaw } from '../resolve/hours-parser';
import { OPEN_24H_DURATION } from '../resolve/hours-constants';

// ─── Helpers ─────────────────────────────────────────────────────────────
const DAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

// Compact "HH:MM-HH:MM" for an open day, "closed" otherwise.
function fmt(day: any): string {
  if (!day || day.isClosed) return 'closed';
  const d = day.duration;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.startHour)}:${p(d.startMinute)}-${p(d.endHour)}:${p(d.endMinute)}`;
}

// Parse a glued blob and return a { day: "HH:MM-HH:MM" | "closed" } map.
function week(raw: string): Record<string, string> {
  const { weekDays } = parseHours(raw);
  return Object.fromEntries(DAYS.map((d) => [d, fmt(weekDays[d])]));
}

// Parse a single day's time text by wrapping it in a one-day glued blob.
function oneDay(timeText: string): string {
  return fmt(parseHours(`Monday${timeText}`).weekDays.monday);
}

// ─── Real scraped sample set (glued, noisy, verified against 70+ samples) ──
const SAMPLES = {
  gluedBasic8to8:
    'Tuesday8 am–8 pmWednesday8 am–8 pmThursday8 am–8 pmFriday(Juneteenth)8 am–8 pm Hours might differSaturday8 am–8 pmSunday8 am–8 pmMonday8 am–8 pmSuggest new hours',
  holidayHoursNoise:
    'Tuesday9 am–10 pmWednesday9 am–10 pmThursday9 am–10 pmFriday(Juneteenth)9 am–10 pm Holiday hoursSaturday9 am–9 pmSunday9 am–9 pmMonday9 am–10 pmSuggest new hours',
  sixToEleven:
    'Tuesday6 am–11 pmWednesday6 am–11 pmThursday6 am–11 pmFriday(Juneteenth)6 am–11 pm Hours might differSaturday6 am–11 pmSunday6 am–11 pmMonday6 am–11 pmSuggest new hours',
  midnightMix:
    'Tuesday9 am–10 pmWednesday9 am–12 amThursday9 am–12 amFriday(Juneteenth)9 am–12 am Holiday hoursSaturday8 am–12 amSunday8 am–10 pmMonday9 am–10 pmSuggest new hours',
  open24:
    'TuesdayOpen 24 hoursWednesdayOpen 24 hoursThursdayOpen 24 hoursFriday(Juneteenth)Open 24 hours Hours might differSaturdayOpen 24 hoursSundayOpen 24 hoursMondayOpen 24 hoursSuggest new hours',
  withClosedSunday:
    'Tuesday8:30 am–5 pmWednesday8:30 am–5 pmThursday8:30 am–5 pmFriday(Juneteenth)8:30 am–5 pm Hours might differSaturday8:30 am–5 pmSundayClosedMonday8:30 am–5 pmSuggest new hours',
  noonToMidnightOvernight:
    'Tuesday12 pm–12 amWednesday12 pm–12 amThursday12 pm–12 amFriday(Juneteenth)12 pm–2 am Hours might differSaturday11 am–2 amSunday11 am–12 amMonday12 pm–12 amSuggest new hours',
};

describe('parseHours — real glued samples', () => {
  it('basic glued 8 am–8 pm parses all 7 days (Juneteenth/advisory/suggest stripped)', () => {
    const w = week(SAMPLES.gluedBasic8to8);
    for (const d of DAYS) expect(w[d]).toBe('08:00-20:00');
  });

  it('strips "Holiday hours" advisory and keeps real per-day hours', () => {
    const w = week(SAMPLES.holidayHoursNoise);
    expect(w.tuesday).toBe('09:00-22:00');
    expect(w.saturday).toBe('09:00-21:00');
    expect(w.sunday).toBe('09:00-21:00');
    expect(w.monday).toBe('09:00-22:00');
  });

  it('parses 6 am–11 pm for every day', () => {
    const w = week(SAMPLES.sixToEleven);
    for (const d of DAYS) expect(w[d]).toBe('06:00-23:00');
  });

  it('handles "–12 am" close (→ 00:00) mixed with normal closes', () => {
    const w = week(SAMPLES.midnightMix);
    expect(w.tuesday).toBe('09:00-22:00');
    expect(w.wednesday).toBe('09:00-00:00');
    expect(w.thursday).toBe('09:00-00:00');
    expect(w.friday).toBe('09:00-00:00');
    expect(w.saturday).toBe('08:00-00:00');
    expect(w.sunday).toBe('08:00-22:00');
    expect(w.monday).toBe('09:00-22:00');
  });

  it('represents "Open 24 hours" as 0:00-23:59, isClosed:false, for all 7 days', () => {
    const { weekDays } = parseHours(SAMPLES.open24);
    for (const d of DAYS) {
      expect(weekDays[d]).toEqual({
        duration: { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 },
        isClosed: false,
      });
    }
  });

  it('parses minute precision and a real Closed day', () => {
    const w = week(SAMPLES.withClosedSunday);
    expect(w.tuesday).toBe('08:30-17:00');
    expect(w.sunday).toBe('closed');
    expect(w.monday).toBe('08:30-17:00');
    const { weekDays } = parseHours(SAMPLES.withClosedSunday);
    expect(weekDays.sunday).toEqual({ duration: null, isClosed: true });
  });

  it('handles noon→midnight and overnight closes stored as end<start', () => {
    const w = week(SAMPLES.noonToMidnightOvernight);
    expect(w.tuesday).toBe('12:00-00:00'); // 12 pm–12 am
    expect(w.friday).toBe('12:00-02:00'); // 12 pm–2 am overnight
    expect(w.saturday).toBe('11:00-02:00'); // 11 am–2 am overnight
    expect(w.sunday).toBe('11:00-00:00'); // 11 am–12 am
  });
});

describe('parseHours — per-day cases from the brief', () => {
  it('a. Closed', () => {
    const { weekDays } = parseHours('MondayClosed');
    expect(weekDays.monday).toEqual({ duration: null, isClosed: true });
  });

  it('b. Open 24 hours → 0:00-23:59', () => {
    expect(oneDay('Open 24 hours')).toBe('00:00-23:59');
  });

  it('c. single range with minutes "4:15 am–8:30 pm"', () => {
    expect(oneDay('4:15 am–8:30 pm')).toBe('04:15-20:30');
  });

  it('d. meridiem inherit "3–9 pm" → 15:00-21:00', () => {
    expect(oneDay('3–9 pm')).toBe('15:00-21:00');
  });

  it('d. meridiem inherit "12–8 pm" → 12:00-20:00', () => {
    expect(oneDay('12–8 pm')).toBe('12:00-20:00');
  });

  it('d. inherit-then-flip "11–2 pm" → 11:00-14:00 (start flips to am)', () => {
    expect(oneDay('11–2 pm')).toBe('11:00-14:00');
  });

  it('e. "12 pm–12 am" noon→midnight → 12:00-00:00', () => {
    expect(oneDay('12 pm–12 am')).toBe('12:00-00:00');
  });

  it('e. "9 am–12 am" → 09:00-00:00', () => {
    expect(oneDay('9 am–12 am')).toBe('09:00-00:00');
  });

  it('e. overnight "11 am–2 am" stored end<start → 11:00-02:00', () => {
    expect(oneDay('11 am–2 am')).toBe('11:00-02:00');
  });

  it('f. split shift "6 am–1 pm5–8:30 pm" → 06:00-20:30 envelope', () => {
    expect(oneDay('6 am–1 pm5–8:30 pm')).toBe('06:00-20:30');
  });

  it('f. split shift "9–11:45 am2:30–5:30 pm" → 09:00-17:30 envelope', () => {
    expect(oneDay('9–11:45 am2:30–5:30 pm')).toBe('09:00-17:30');
  });

  it('f. triple shift "7–8:30 am11:30 am–1 pm6–9 pm" → 07:00-21:00 envelope', () => {
    expect(oneDay('7–8:30 am11:30 am–1 pm6–9 pm')).toBe('07:00-21:00');
  });

  it('empty hours → all days closed', () => {
    const w = week('');
    for (const d of DAYS) expect(w[d]).toBe('closed');
  });
});

describe('24-hour encoding parity — adapter vs resolve parser (LOCKED 0:00-23:59)', () => {
  const EXPECTED = { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 };

  it('shared constant is 0:00-23:59', () => {
    expect({ ...OPEN_24H_DURATION }).toEqual(EXPECTED);
  });

  it('both parsers emit the IDENTICAL 24-hour duration', () => {
    const adapterDay = parseHours('MondayOpen 24 hours').weekDays.monday;
    const resolveDay = parseHoursRaw(['Monday: Open 24 hours']).parsedDays
      .monday;

    expect(adapterDay).toEqual({ duration: EXPECTED, isClosed: false });
    expect(resolveDay).toEqual({ duration: EXPECTED, isClosed: false });
    expect(adapterDay.duration).toEqual(resolveDay!.duration);
  });
});

// ─── Adapter-level behaviour ─────────────────────────────────────────────
const baseRec = {
  name: 'Test Venue',
  placeId: 'place-1',
  address: '1 Main St, Raleigh, NC 27614',
  coordinates: '35.8,-78.6',
};

function adaptOne(overrides: Record<string, any>) {
  const result = adaptScraperData([{ ...baseRec, ...overrides }], {});
  const record: any = result.records[0];
  return {
    record,
    stats: result.stats,
    warnings: (record.__warnings as string[]) ?? [],
    openDays: DAYS.filter(
      (d) => record.regularTiming.weekDays[d].isClosed === false,
    ),
  };
}

describe('adaptScraperData — status / continueJourney / countryCode', () => {
  it('sets status 4.1 and continueJourney:false on every record', () => {
    const { record } = adaptOne({});
    expect(record.status).toBe(4.1);
    expect(record.continueJourney).toBe(false);
  });

  it('parses the +NN prefix from the raw phone', () => {
    const { record } = adaptOne({ phone: '+44 20 7946 0958' });
    expect(record.countryCode).toBe('+44');
    expect(record.phone).toBe('2079460958');
  });

  it('infers +1 for a US record whose phone has no prefix', () => {
    const { record } = adaptOne({ phone: '802-347-3562' });
    expect(record.countryCode).toBe('+1');
  });

  it('does not stamp +1 on non-US coords with a prefix-less phone — flags instead', () => {
    const { record, warnings } = adaptOne({
      phone: '99888 77665',
      coordinates: '19.07,72.87', // Mumbai
      state: '',
      address: 'Some Rd, Mumbai',
    });
    expect(record.countryCode).toBe('');
    expect(
      warnings.some((w) => /countryCode could not be inferred/.test(w)),
    ).toBe(true);
  });

  it('countryCode key is always present', () => {
    const { record } = adaptOne({ phone: '' });
    expect(record).toHaveProperty('countryCode');
  });
});

describe('adaptScraperData — Stage B data-quality flags', () => {
  it('flags hours present but zero open days parsed', () => {
    const { stats, warnings } = adaptOne({ hours: 'open whenever lol' });
    expect(stats.hoursUnparsed).toBe(1);
    expect(warnings.some((w) => /none parsed/.test(w))).toBe(true);
  });

  it('does NOT flag hoursUnparsed when the glued format parses', () => {
    const { stats, openDays } = adaptOne({ hours: SAMPLES.gluedBasic8to8 });
    expect(openDays).toHaveLength(7);
    expect(stats.hoursUnparsed).toBe(0);
  });

  it('flags a phone number in the address field', () => {
    const { stats } = adaptOne({ address: '+1 802-347-3562' });
    expect(stats.addressInvalid).toBe(1);
  });

  it('flags a URL/handle in the address field', () => {
    const { stats } = adaptOne({ address: 'instagram.com/livemore' });
    expect(stats.addressInvalid).toBe(1);
  });

  it('flags zero coordinates', () => {
    const { stats } = adaptOne({ coordinates: '0,0' });
    expect(stats.noCoords).toBe(1);
  });

  it('flags empty name and empty placeId', () => {
    const { stats } = adaptOne({ name: '', place_name: '', placeId: '', url: '' });
    expect(stats.noName).toBe(1);
    expect(stats.noPlaceId).toBe(1);
  });

  it('clean record trips no data-quality flags', () => {
    const { stats } = adaptOne({ hours: SAMPLES.gluedBasic8to8 });
    expect(stats.addressInvalid).toBe(0);
    expect(stats.noCoords).toBe(0);
    expect(stats.noName).toBe(0);
    expect(stats.noPlaceId).toBe(0);
    expect(stats.hoursUnparsed).toBe(0);
  });
});
