// web/lib/approval-log.ts
// When a post is approved on the dashboard, write one row to the team's
// calendar sheet (its own "Dashboard Approvals" tab — nothing laid out by
// hand is touched). Fail-soft by design: the approval already happened in
// Metricool; the sheet is the record, not the gate.
import 'server-only';

import { appendApproval, sourcesConfigured } from '@/lib/google-sources';
import { reportError } from '@/lib/report';

export type ApprovalRecord = {
  publishDate: string;
  networks: string[];
  caption: string;
  mediaUrl: string;
  source: string;
  postId: string;
};

export async function recordApproval(rec: ApprovalRecord): Promise<boolean> {
  if (!sourcesConfigured()) return false;
  try {
    await appendApproval({
      approvedAt: new Date().toISOString(),
      publishDate: rec.publishDate,
      networks: rec.networks,
      caption: rec.caption,
      mediaUrl: rec.mediaUrl,
      source: rec.source,
      postId: rec.postId,
    });
    return true;
  } catch (e) {
    reportError('approval-log:sheet', e, { postId: rec.postId });
    return false;
  }
}
