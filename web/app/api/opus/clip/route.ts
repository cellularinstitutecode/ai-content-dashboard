import { isAllowedEmail } from '@/lib/access';
import { reportError } from '@/lib/report';
import { NextRequest, NextResponse } from 'next/server';
import { opusCreateClipProject, opusGetExportableClips } from '@/lib/opus';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkRateLimit } from '@/lib/rate-limit';
import { persistClips } from '@/lib/drive';
import { parseVideoUrl } from '@/lib/composer';

export const runtime = 'nodejs';
// Multi-clip Drive uploads can take a while; give the poll path the same ceiling
// as the webhook so a run isn't killed mid-upload and retried from scratch.
export const maxDuration = 60;

// Pull the Opus project id out of whatever shape the create response uses,
// then normalize it to a trimmed string so it keys drafts consistently
// everywhere (create, poll, webhook).
function projectIdOf(project: any): string | null {
  const raw =
    project?.projectId ||
    project?.id ||
    project?.project?.id ||
    project?.project?.projectId ||
    null;
  const s = raw == null ? '' : String(raw).trim();
  return s || null;
}

// Best-effort thumbnail from the create response.
function thumbnailOf(project: any): string | null {
  return (
    project?.sourceInfo?.thumbnailUrl ||
    project?.sourceInfo?.thumbnail ||
    project?.thumbnailUrl ||
    null
  );
}

export async function POST(req: NextRequest) {
  try {
    const sb = await supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    // Starts a paid OpusClip job on the clinic's account, so the allowlist applies.
    if (!isAllowedEmail(user.email)) {
      return NextResponse.json(
        { error: 'forbidden', message: 'This account is not authorized for this workspace.' },
        { status: 403 },
      );
    }

    // Rate limit before kicking off an Opus clip job.
    const rl = await checkRateLimit(user.id, 'opus-clip');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    const { videoUrl, brandTemplateId, language, title } = await req.json();
    if (!videoUrl) return NextResponse.json({ error: 'videoUrl required' }, { status: 400 });

    // Only hosts OpusClip can actually ingest. The allowlist lived in the
    // browser (app/page.tsx) and was moved server-side for the assistant's
    // clip tool - but not for THIS route, which is the one the dashboard
    // actually calls. Same operation, two implementations, fix applied to one:
    // exactly the pattern that produced the autoPublish and redirect findings.
    const parsed = parseVideoUrl(String(videoUrl));
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.reason || 'Only YouTube and Vimeo links can be clipped.' },
        { status: 400 },
      );
    }

    // Forward the string that was validated, not the raw request value:
    // parseVideoUrl accepts a scheme-less host and String()-coerces, so raw
    // and validated could differ.
    const project = await opusCreateClipProject({ videoUrl: String(videoUrl), brandTemplateId, language, title });
    const projectId = projectIdOf(project);
    if (!projectId) {
      // Without a project id we could never map finished clips back to a draft,
      // so fail loudly instead of creating an orphan job. The raw `project`
      // object used to ride along in this response - it carries the org id and
      // internal job fields, which the browser has no use for.
      console.error('opus/clip: create returned no project id', JSON.stringify(project).slice(0, 500));
      return NextResponse.json({ error: 'opus returned no project id' }, { status: 502 });
    }
    const thumbnailUrl = thumbnailOf(project);
    const projectTitle = title || project?.sourceInfo?.title || null;

    const admin = supabaseAdmin();

    // Bookkeeping row (drives the "Clip jobs" stat) — keyed by projectId + user.
    const { error: clipErr } = await admin.from('clips').insert({
      user_id: user.id,
      opus_project_id: projectId,
      source_url: videoUrl,
      status: 'processing',
    });
    if (clipErr) console.error('opus/clip: clips insert failed', clipErr.message);

    // Create the gallery draft SERVER-SIDE, in the same request that owns the
    // authoritative projectId. Previously the client created this draft in a
    // second, best-effort call, which could save an empty projectId or lose the
    // race with the Opus webhook — the finished clips then had no draft to map
    // onto. Creating it here guarantees the draft exists and is keyed correctly
    // before any webhook or poll can fire.
    const pack = {
      kind: 'clip',
      video: videoUrl,
      thumb: thumbnailUrl || null,
      projectId,
      status: 'processing',
      clips: [] as any[],
    };
    const { data: draft, error: draftErr } = await admin
      .from('drafts')
      .insert({
        user_id: user.id,
        topic: projectTitle ? ('Video clips — ' + projectTitle) : ('Video clips from ' + videoUrl),
        pack,
        provider: 'opusclip',
      })
      .select()
      .single();
    // Without this draft the webhook has nothing to map the finished clips
    // onto, so the job would silently produce nothing the user can ever see.
    // Report it instead of returning ok:true with draft:null.
    if (draftErr || !draft) {
      console.error('opus/clip: gallery draft insert failed', draftErr?.message);
      return NextResponse.json(
        { error: 'Clip job started at OpusClip but could not be saved to your library. Please try again.', projectId },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      projectId,
      thumbnailUrl: thumbnailUrl || null,
      title: projectTitle,
      draft: draft || null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'opus failed' }, { status: 500 });
  }
}

// Locate this user's clip draft for a project. Matches on the JSON key first,
// and if that misses (e.g. the id was stored in a slightly different shape),
// falls back to the source_url recorded on the linked clips bookkeeping row.
async function findClipDraft(admin: any, userId: string, projectId: string) {
  const byKey = await admin
    .from('drafts')
    .select('id, pack')
    .eq('user_id', userId)
    .filter('pack->>projectId', 'eq', projectId)
    .limit(1);
  if (byKey.data && byKey.data[0]) return byKey.data[0];

  // Fallback: use the source_url from the clips row that owns this projectId.
  const clipRow = await admin
    .from('clips')
    .select('source_url')
    .eq('user_id', userId)
    .eq('opus_project_id', projectId)
    .limit(1);
  const sourceUrl = clipRow.data && clipRow.data[0] && clipRow.data[0].source_url;
  if (!sourceUrl) return null;
  const byUrl = await admin
    .from('drafts')
    .select('id, pack')
    .eq('user_id', userId)
    .filter('pack->>video', 'eq', sourceUrl)
    .filter('pack->>kind', 'eq', 'clip')
    .order('created_at', { ascending: false })
    .limit(1);
  return (byUrl.data && byUrl.data[0]) || null;
}

// Poll finished clips for a project. Also persists them onto the matching clip
// draft so the gallery can render playable/downloadable results without Opus
// having to fire the webhook (webhook is the fast path; this is the fallback).
export async function GET(req: NextRequest) {
  try {
    const sb = await supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    // This GET is not a cheap read: on the ready path it downloads every clip
    // from Opus and uploads it to Drive. The POST was capped and this was not,
    // even though the dashboard polls it every 5 seconds per pending job.
    const rl = await checkRateLimit(user.id, 'opus-poll');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }

    const projectId = (req.nextUrl.searchParams.get('projectId') || '').trim();
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

    // Ownership gate: only poll Opus for projects this user actually owns
    // (either a clips bookkeeping row or a clip draft). Without this, any
    // signed-in user could read another tenant's Opus project by guessing ids.
    const admin = supabaseAdmin();
    const ownedRow = await admin
      .from('clips')
      .select('id')
      .eq('user_id', user.id)
      .eq('opus_project_id', projectId)
      .limit(1);
    const draftRow = await findClipDraft(admin, user.id, projectId);
    if (!(ownedRow.data && ownedRow.data[0]) && !draftRow) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    let clips = await opusGetExportableClips(projectId);
    const ready = clips.length > 0;
    const status = ready ? 'ready' : 'processing';

    // Persist finished clips to Drive so we store permanent links instead of Opus's
    // short-lived signed CDN URLs. This mirrors the webhook's fast path; without it the
    // poll path would overwrite the draft with URLs that expire (Error: 30 on playback).
    // Pass the clips already stored on the draft so anything previously uploaded is
    // reused rather than re-downloaded and re-uploaded on every poll.
    if (ready) {
        const knownClips = Array.isArray(draftRow?.pack?.clips) ? draftRow.pack.clips : [];
        try { clips = await persistClips(clips, projectId, knownClips); }
        catch (err) { /* keep raw Opus clips if Drive persist fails entirely */ reportError('opus-clip:drive-persist', err); }
    }

    // Best-effort, idempotent persist onto this user's clip draft.
    try {
      const row = draftRow;
      if (row) {
        // Only write when something actually changed, so repeated polls don't
        // churn updated_at or clobber a webhook that already marked it ready.
        const prevCount = Array.isArray(row.pack?.clips) ? row.pack.clips.length : 0;
        if (ready && (prevCount !== clips.length || row.pack?.status !== 'ready')) {
          const pack = { ...(row.pack || {}), projectId, clips, status };
          await admin.from('drafts').update({ pack, updated_at: new Date().toISOString() }).eq('id', row.id);
        }
      }
      if (ready) {
        await admin.from('clips').update({ status: 'ready', result: clips }).eq('opus_project_id', projectId).eq('user_id', user.id);
      }
    } catch (err) { reportError('opus-clip:draft-update', err); }

    return NextResponse.json({ ok: true, status, clips });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'opus failed' }, { status: 500 });
  }
}
