export const BusinessProjections = {
  list: {
    _id: 1,
    name: 1,
    status: 1,
    email: 1,
    phone: 1,
    city: 1,
    isActive: 1,
    uniqueId: 1,
    logo: 1,
    verificationStatus: 1,
    createdAt: 1,
  },
  detail: { __v: 0 },
  populate: {
    outlets: 'name city isActive category',
    businessCategories: 'name',
    businessIndustry: 'name',
    country: 'name',
  },
} as const;

export const BusinessSortOrders = {
  default: { createdAt: -1 },
  byName: { name: 1 },
  byRating: { rating: -1 },
} as const;
