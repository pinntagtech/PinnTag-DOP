export const EventProjections = {
  list: {
    _id: 1,
    title: 1,
    type: 1,
    status: 1,
    businessProfile: 1,
    schedule: 1,
    isFree: 1,
    tags: 1,
    viewsCount: 1,
    totalLikes: 1,
    createdAt: 1,
  },
  detail: { __v: 0 },
} as const;

export const EventSortOrders = {
  default: { createdAt: -1 },
  byViews: { viewsCount: -1 },
} as const;
