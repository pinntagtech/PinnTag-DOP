import { parseHoursRaw } from './hours-parser';

describe('hours-parser', () => {
  describe('single range (regression)', () => {
    it('parses a basic "Monday: 9 AM-5 PM"', () => {
      const r = parseHoursRaw(['Monday: 9 AM-5 PM']);
      expect(r.ok).toBe(true);
      expect(r.parsedDays.monday).toEqual({
        duration: { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0 },
        isClosed: false,
      });
    });

    it('parses overnight close (end<start preserved as-is)', () => {
      const r = parseHoursRaw(['Friday: 9 PM-2 AM']);
      expect(r.parsedDays.friday).toEqual({
        duration: { startHour: 21, startMinute: 0, endHour: 2, endMinute: 0 },
        isClosed: false,
      });
    });

    it('inherits end meridiem onto a same-period start ("12-10 pm")', () => {
      const r = parseHoursRaw(['Saturday: 12-10 pm']);
      expect(r.parsedDays.saturday).toEqual({
        duration: { startHour: 12, startMinute: 0, endHour: 22, endMinute: 0 },
        isClosed: false,
      });
    });

    it('flips meridiem when same-period inheritance would invert ("11-2 pm")', () => {
      const r = parseHoursRaw(['Sunday: 11-2 pm']);
      expect(r.parsedDays.sunday).toEqual({
        duration: { startHour: 11, startMinute: 0, endHour: 14, endMinute: 0 },
        isClosed: false,
      });
    });

    it('rejects equal start/end ("12 PM-12 PM") as ambiguous', () => {
      const r = parseHoursRaw(['Tuesday: 12 PM-12 PM']);
      expect(r.kind).toBe('none_parsed');
      expect(r.unparsedDays).toContain('tuesday');
    });

    it('recognises Closed and Open 24 hours', () => {
      const r = parseHoursRaw([
        'Monday: Closed',
        'Tuesday: Open 24 hours',
      ]);
      expect(r.parsedDays.monday).toEqual({ duration: null, isClosed: true });
      expect(r.parsedDays.tuesday).toEqual({
        duration: { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 },
        isClosed: false,
      });
    });

    it('strips "Hours might differ" advisory tail', () => {
      const r = parseHoursRaw(['Wednesday: 10 AM-6 PM Hours might differ']);
      expect(r.parsedDays.wednesday).toEqual({
        duration: { startHour: 10, startMinute: 0, endHour: 18, endMinute: 0 },
        isClosed: false,
      });
    });
  });

  describe('split-shift (multi-range collapse)', () => {
    it('collapses space-separated two-range day to earliest→latest "11:30 am-3 pm 5-10 pm" → 11:30-22:00', () => {
      const r = parseHoursRaw(['Monday: 11:30 am–3 pm 5–10 pm']);
      expect(r.ok).toBe(true);
      expect(r.parsedDays.monday).toEqual({
        duration: { startHour: 11, startMinute: 30, endHour: 22, endMinute: 0 },
        isClosed: false,
      });
    });

    it('collapses glued meridiem-digit two-range day "12-3:30 pm4:15-8 pm" → 12:00-20:00', () => {
      const r = parseHoursRaw(['Tuesday: 12–3:30 pm4:15–8 pm']);
      expect(r.ok).toBe(true);
      expect(r.parsedDays.tuesday).toEqual({
        duration: { startHour: 12, startMinute: 0, endHour: 20, endMinute: 0 },
        isClosed: false,
      });
    });

    it('handles glued meridiem with no space at all "11 am-3pm5-10pm" → 11:00-22:00', () => {
      const r = parseHoursRaw(['Wednesday: 11 am-3pm5-10pm']);
      expect(r.ok).toBe(true);
      expect(r.parsedDays.wednesday).toEqual({
        duration: { startHour: 11, startMinute: 0, endHour: 22, endMinute: 0 },
        isClosed: false,
      });
    });

    it('preserves overnight collapse when latest end is past midnight', () => {
      // Lunch 11am-2pm + late-night 10pm-2am → envelope is 11:00 to
      // 02:00 (next day). end<start is preserved as-is so the consumer
      // wraps it the same way a single overnight close is wrapped.
      const r = parseHoursRaw(['Thursday: 11 am-2 pm 10 pm-2 am']);
      expect(r.ok).toBe(true);
      expect(r.parsedDays.thursday).toEqual({
        duration: { startHour: 11, startMinute: 0, endHour: 2, endMinute: 0 },
        isClosed: false,
      });
    });
  });

  describe('Copy open hours leak (BUG 2)', () => {
    it('strips trailing ", Copy open hours" before parsing', () => {
      const r = parseHoursRaw(['Sunday: 1 pm-1 am, Copy open hours']);
      expect(r.ok).toBe(true);
      expect(r.parsedDays.sunday).toEqual({
        duration: { startHour: 13, startMinute: 0, endHour: 1, endMinute: 0 },
        isClosed: false,
      });
    });

    it('strips leading "Copy open hours, " before the range', () => {
      const r = parseHoursRaw(['Saturday: Copy open hours, 4-10 pm']);
      expect(r.ok).toBe(true);
      expect(r.parsedDays.saturday).toEqual({
        duration: { startHour: 16, startMinute: 0, endHour: 22, endMinute: 0 },
        isClosed: false,
      });
    });

    it('strips bare "Copy open hours" with no comma', () => {
      const r = parseHoursRaw(['Friday: 4-10 pm Copy open hours']);
      expect(r.ok).toBe(true);
      expect(r.parsedDays.friday).toEqual({
        duration: { startHour: 16, startMinute: 0, endHour: 22, endMinute: 0 },
        isClosed: false,
      });
    });

    it('is case-insensitive ("COPY OPEN HOURS")', () => {
      const r = parseHoursRaw(['Thursday: 4-10 pm, COPY OPEN HOURS']);
      expect(r.parsedDays.thursday).toEqual({
        duration: { startHour: 16, startMinute: 0, endHour: 22, endMinute: 0 },
        isClosed: false,
      });
    });
  });

  describe('reject paths (regression)', () => {
    it('rejects comma-separated split shift ("11 AM-2 PM, 5-10 PM")', () => {
      const r = parseHoursRaw(['Monday: 11 AM-2 PM, 5-10 PM']);
      expect(r.kind).toBe('none_parsed');
      expect(r.unparsedDays).toContain('monday');
    });

    it('rejects unknown day label ("Confectionery: ...") with unknown_day_label', () => {
      const r = parseHoursRaw(['Confectionery: 12-3:30 pm4:15-8 pm']);
      expect(r.kind).toBe('none_parsed');
      expect(r.rejectDetails[0]?.reason).toBe('unknown_day_label');
    });

    it('rejects holiday-noted time portion', () => {
      const r = parseHoursRaw(['Monday: 9 AM-5 PM (holiday)']);
      expect(r.kind).toBe('none_parsed');
      expect(r.unparsedDays).toContain('monday');
    });
  });
});
