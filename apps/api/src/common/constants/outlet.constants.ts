export const OutletProjections = {
  list: {
    _id: 1,
    name: 1,
    category: 1,
    city: 1,
    isActive: 1,
    isDeleted: 1,
    latitude: 1,
    longitude: 1,
    phone: 1,
    email: 1,
    createdAt: 1,
  },
  detail: { __v: 0 },
} as const;

export const OutletSortOrders = {
  default: { createdAt: -1 },
} as const;
