// Server-only Metricool client.
// Docs: https://app.metricool.com/resources/apidocs/index.html
// Base: https://app.metricool.com/api  |  Auth header: X-Mc-Auth: <userToken>

export type Provider =
  | 'instagram' | 'facebook' | 'twitter' | 'linkedin'
  | 'tiktok' | 'youtube' | 'gmb' | 'pinterest' | 'threads'
  | 'bluesky';

export interface SchedulePostInput {
  text: string;
  providers: Provider[];
  // ISO date string in UTC (Metricool will translate)
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

  const body = {
    text: input.text,
    providers: input.providers,
    publicationDate: { dateTime: input.publicationDate, timezone: 'UTC' },
    firstCommentText: input.firstCommentText,
    media: input.media || [],
    autoPublish: input.autoPublish ?? true
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
