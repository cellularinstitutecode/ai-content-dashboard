// Server-only Metricool client.
// Docs: https://app.metricool.com/resources/apidocs/index.html
// Base: https://app.metricool.com/api  |  Auth header: X-Mc-Auth: <userToken>

import { formatForMetricool, SCHEDULE_TZ } from '@/lib/timezone';

export type Provider =
  | 'instagram' | 'facebook' | 'twitter' | 'linkedin'
  | 'tiktok' | 'youtube' | 'gmb' | 'pinterest' | 'threads'
  | 'bluesky';

export interface SchedulePostInput {
  text: string;
  providers: Provider[];
  // UTC instant (ISO string); converted to the clinic timezone's wall clock
  // for the Metricool API automatically.
  publicationDate: string;
  firstCommentText?: string;
  media?: { url: string }[];
  autoPublish?: boolean;
}

function env() {
  const token = process.env.METRICOOL_USER_TOKEN;
  const blogId = process.env.METRICOOL_BLOG_ID;
  const userId = process.env.METRICOOL_USER_ID;
  if (!token || !blogId || !userId) {
    throw new Error('Metricool env vars missing (METRICOOL_USER_TOKEN/BLOG_ID/USER_ID)');
  }
  return { token, blogId, userId };
}

export async function metricoolSchedulePost(input: SchedulePostInput) {
  const { token, blogId, userId } = env();
  const url = new URL('https://app.metricool.com/api/v2/scheduler/posts');
  url.searchParams.set('blogId', blogId);
  url.searchParams.set('userId', userId);

  // Metricool wants a wall-clock "YYYY-MM-DDTHH:MM:SS" plus an IANA timezone —
  // it rejects/misreads full ISO strings with 'Z' or milliseconds. Convert the
  // UTC instant we store internally into the clinic timezone's wall clock so
  // the post shows up in the Metricool planner at the intended local time.
  const at = new Date(input.publicationDate);
  const dateTime = isNaN(at.getTime())
    ? String(input.publicationDate)
    : formatForMetricool(at, SCHEDULE_TZ);
  const autoPublish = input.autoPublish ?? false;
  const body = {
    text: input.text,
    // Metricool's scheduler expects provider OBJECTS ({ network }), not bare
    // strings — this mirrors the interactive /api/metricool/schedule route.
    // Sending bare strings silently fails / mis-files the post.
    providers: input.providers.map((network) => ({ network })),
    publicationDate: { dateTime, timezone: SCHEDULE_TZ },
    firstCommentText: input.firstCommentText,
    media: input.media || [],
    // Publishing is a human decision: never auto-publish unless the caller
    // explicitly opts in (approveRun always passes false).
    autoPublish,
    // draft:true holds the post in Metricool's review queue rather than the live
    // queue. Without it, an autoPublish:false post can still land as live-pending.
    draft: !autoPublish
  };

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mc-Auth': token
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Metricool ' + res.status + ': ' + JSON.stringify(data));
  }
  return data;
}
