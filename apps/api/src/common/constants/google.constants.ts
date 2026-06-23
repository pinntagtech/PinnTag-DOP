export const GooglePlacesConfig = {
  AUTOCOMPLETE_URL:
    'https://places.googleapis.com/v1/places:autocomplete',
  DETAILS_BASE_URL:
    'https://places.googleapis.com/v1/places',
  LOCATION_BIAS_RADIUS: 500,
  DEFAULT_LATITUDE: 33.848543,
  DEFAULT_LONGITUDE: -84.365372,
  AUTOCOMPLETE_FIELD_MASK:
    'suggestions.placePrediction.text.text,suggestions.placePrediction.placeId',
  DETAILS_FIELDS: [
    'displayName',
    'formattedAddress',
    'addressComponents',
    'location',
    'regularOpeningHours',
    'rating',
    'userRatingCount',
    'priceLevel',
    'websiteUri',
    'googleMapsUri',
    'nationalPhoneNumber',
    'primaryType',
    'types',
  ],
} as const;

export const GoogleAddressComponentTypes = {
  STREET_NUMBER: 'street_number',
  ROUTE: 'route',
  PREMISE: 'premise',
  ESTABLISHMENT: 'establishment',
  PLUS_CODE: 'plus_code',
  NEIGHBORHOOD: 'neighborhood',
  LOCALITY: 'locality',
  ADMIN_AREA_1: 'administrative_area_level_1',
  ADMIN_AREA_2: 'administrative_area_level_2',
  ADMIN_AREA_3: 'administrative_area_level_3',
  POSTAL_TOWN: 'postal_town',
  COUNTRY: 'country',
  POSTAL_CODE: 'postal_code',
} as const;

export const GoogleDayMap = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export const GoogleDefaultWeekDays = () => ({
  sunday: {
    duration: { startHour: 0, startMinute: 0, endHour: 0, endMinute: 0 },
  },
  monday: {
    duration: { startHour: 0, startMinute: 0, endHour: 0, endMinute: 0 },
  },
  tuesday: {
    duration: { startHour: 0, startMinute: 0, endHour: 0, endMinute: 0 },
  },
  wednesday: {
    duration: { startHour: 0, startMinute: 0, endHour: 0, endMinute: 0 },
  },
  thursday: {
    duration: { startHour: 0, startMinute: 0, endHour: 0, endMinute: 0 },
  },
  friday: {
    duration: { startHour: 0, startMinute: 0, endHour: 0, endMinute: 0 },
  },
  saturday: {
    duration: { startHour: 0, startMinute: 0, endHour: 0, endMinute: 0 },
  },
});

export const Google247WeekDays = () => ({
  sunday: {
    duration: { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 },
  },
  monday: {
    duration: { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 },
  },
  tuesday: {
    duration: { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 },
  },
  wednesday: {
    duration: { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 },
  },
  thursday: {
    duration: { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 },
  },
  friday: {
    duration: { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 },
  },
  saturday: {
    duration: { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 },
  },
});
