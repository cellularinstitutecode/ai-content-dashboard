// web/lib/metricool-links.ts
// Where Metricool's own screens live, in one place.
//
// THE BUG THIS PREVENTS. Metricool's app resolves a brand only INSIDE a user,
// so every web link has to carry blogId AND userId. One link once carried only
// blogId, on a path nothing else confirmed, and pressing it landed on
// Metricool's "There was an error that prevented loading the page". The fix was
// to make every link the same shape — which only stays true if there is one
// place that builds them. A second copy of this string is how it comes back.
//
// Pure: no imports, so the test runner reads this file directly.

/** The clinic's default Metricool brand and the user it lives under. */
export const METRICOOL_BLOG_ID = '4308292';
export const METRICOOL_USER_ID = '3377431';

/**
 * The planner calendar for a brand — what is scheduled, and what already went out.
 *
 * `/planner/calendar` is the path that is known to work. Do not swap it for a
 * cleverer one without opening it first.
 */
export function metricoolPlannerUrl(blogId: string = METRICOOL_BLOG_ID, userId: string = METRICOOL_USER_ID): string {
  const blog = String(blogId || '').trim() || METRICOOL_BLOG_ID;
  const user = String(userId || '').trim() || METRICOOL_USER_ID;
  return 'https://app.metricool.com/planner/calendar?blogId=' + encodeURIComponent(blog) + '&userId=' + encodeURIComponent(user);
}
