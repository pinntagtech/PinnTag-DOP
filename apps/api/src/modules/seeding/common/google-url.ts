export const GOOGLE_IMAGE_HOST_REGEX =
  /googleusercontent|ggpht|streetviewpixels|googleapis\.com|gstatic/i;

export function isGoogleHostedUrl(url?: string | null): boolean {
  return !!url && GOOGLE_IMAGE_HOST_REGEX.test(url);
}
