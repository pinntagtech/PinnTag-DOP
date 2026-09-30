import { adaptGrouponScraperData } from './scraper-adapter';
import { isAttachEligible } from './business-matcher';

const card = (o: any = {}) => ({
  cardUUID: 'u1', title: '50% off massage', merchantName: 'Zen Spa',
  location: '123 Peachtree St NE, Atlanta, GA 30303', lat: 33.75, lng: -84.39,
  url: 'https://groupon.com/deals/x', scrapedAt: '2026-09-01T00:00:00Z',
  pricing: { bestPriceCents: 4900, strikeThroughCents: 9800, discountPercent: 50, currency: 'USD' },
  ...o,
});

describe('adaptGrouponScraperData', () => {
  it('maps a card to a business draft with addressLine1, no website', () => {
    const r = adaptGrouponScraperData([card()]);
    const b = r.groups[0].business;
    expect(b).toMatchObject({ name: 'Zen Spa', addressLine1: '123 Peachtree St NE', city: 'Atlanta', state: 'GA', postalCode: '30303' });
    expect(b.website).toBeUndefined();
    expect(b.promotions[0]).toMatchObject({ name: '50% off massage', cardUUID: 'u1', description: '$49 (was $98) - 50% off' });
  });
  it('rejects no-comma location, null merchant, dup uuid', () => {
    const r = adaptGrouponScraperData([card({ cardUUID: 'u0', location: '123 Main' }), card({ cardUUID: 'u2', merchantName: null }), card(), card()]);
    expect(r.rejected.map((x) => x.reason)).toEqual(expect.arrayContaining([expect.stringContaining('no comma'), 'missing merchantName', 'duplicate cardUUID in batch']));
    expect(r.groups).toHaveLength(1);
  });
  it('groups same merchant within 150m, splits distant same-name', () => {
    const r = adaptGrouponScraperData([card(), card({ cardUUID: 'u2', lat: 33.7501 }), card({ cardUUID: 'u3', lat: 33.80 })]);
    expect(r.groups.map((g) => g.promotions.length).sort()).toEqual([1, 2]);
  });
});

describe('groupon state + creatable', () => {
  it('takes state from sourceCity when location has none; flags no-street as not creatable', () => {
    const r = adaptGrouponScraperData([
      card({ location: '7173 Covington Highway, Lithonia', sourceCity: '/local/atlanta' }),
      card({ cardUUID: 'u9', merchantName: 'Buck', location: 'Buckhead, Atlanta', sourceCity: '/local/atlanta' }),
    ]);
    expect(r.groups[0].business.state).toBe('GA');
    expect(r.groups[0].creatable).toBe(true);
    expect(r.groups[1].creatable).toBe(false);
    expect(r.groups[1].cardUUIDs).toEqual(['u9']);
  });
});

describe('isAttachEligible', () => {
  it('guards claimed', () => {
    expect(isAttachEligible({ isClaimed: true, isFromCrawler: true })).toBe(false);
    expect(isAttachEligible({ isClaimed: false })).toBe(true);
    expect(isAttachEligible({ isCvb: true })).toBe(true);
    expect(isAttachEligible({})).toBe(false);
  });
});
