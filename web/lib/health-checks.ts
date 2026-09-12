// web/lib/health-checks.ts
// Every check /api/health runs, as a library instead of a route body.
//
// These seventeen checks lived inside the GET handler, which meant the only way
// to know whether anything was working was for a person to open System Status
// and look. The assistant — the thing people actually ask "is this broken?" —
// could not reach them, so it built its idea of the world from ONE of them (the
// schema probe) and cheerfully reported a healthy pipeline while the banner two
// inches above it said no video could be attached to any post.
//
// Nothing about the checks themselves changed in the move. The route still
// returns the same JSON, in the same order, with the same severities.
import 'server-only';

import { ALLOWED_EMAILS, ALLOWED_BLOG_IDS } from '@/lib/access';
import { keywordCapability } from '@/lib/semrush';
import { lastImageOutcome } from '@/lib/provider-status';
import { resolveFfmpeg } from '@/lib/audio-extract';
import { missingSchema } from '@/lib/schema-check';
import { resolveOwner } from '@/lib/sweep-owner';
import { sheetWriteAccess } from '@/lib/google-sources';
import { driveFolderReport } from '@/lib/drive';
import { serviceKeyVerdict } from '@/lib/supabase-key';
import { schemaDetail, type SchemaProbe } from '@/lib/schema-probe';

export type Check = {
  name: string;
  ok: boolean;
  severity: 'required' | 'optional';
  detail: string;
  /** A short machine code for WHY, where one check can fail for several reasons. */
  code?: string;
};

export type HealthReport = {
  checks: Check[];
  /**
   * The schema probes that came back missing, kept alongside the flattened
   * `database_schema` check.
   *
   * The assistant needs them un-flattened: the probe spans three migration
   * files, and a missing Autopilot table has nothing to do with video. Rolled
   * into one boolean, a templates migration opened the chat with a database
   * warning and never mentioned a single video.
   */
  schemaGaps: SchemaProbe[];
};

function has(name: string): boolean {
  return Boolean(process.env[name]);
}

/**
 * Run every check.
 *
 * Makes real calls — Drive, Sheets, the Semrush balance, an ffmpeg resolve — so
 * callers on a hot path want `cachedHealthReport()` below, not this.
 */
export async function runHealthChecks(): Promise<HealthReport> {
  const keywords = await keywordCapability();

  // Can this deployment actually read a Drive video? ffmpeg-static fetches its
  // binary in an install script and does not ship it in the tarball, so a
  // build that skips lifecycle scripts installs the package and leaves nothing
  // behind it — and the first sign of that was a person pressing Prepare.
  const ffmpeg = await resolveFfmpeg();

  // Did anyone actually run the .sql files? Nothing checked, ever.
  const schemaGaps = await missingSchema();

  // Can the automatic sweep find anybody to write as? Configuration said yes
  // — every Supabase variable was present — while the trigger got 503 no_owner
  // on every fire, and the message blamed a page the person had already saved.
  const owner = await resolveOwner();

  // Can the credential actually WRITE the sheet? "The Edit button works for
  // you" was taken as evidence once and was the wrong inference: the sheet was
  // open to anyone-with-the-link as a READER, the service account was on the
  // permission list nowhere, and the first write returned 403 — after the
  // transcription had been paid for. Google is asked directly here.
  const sheet = await sheetWriteAccess();

  // Is the copies folder somewhere the service account can actually write?
  // The `drive` check below has only ever tested that two environment variables
  // are non-empty — both were, for this entire project, while not one shareable
  // copy ever succeeded. A service account owns zero bytes of Drive storage, so
  // a folder outside a Shared Drive refuses every copy with storageQuotaExceeded
  // however empty it is. Two non-empty strings could never have caught that.
  const driveFolder = await driveFolderReport();
  const serviceKey = serviceKeyVerdict(process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Images: what the account last DID, not what is in the environment.
  const imagesConfigured = has('OPENAI_API_KEY') && process.env.IMAGE_GEN !== 'off';
  const lastImage = imagesConfigured ? await lastImageOutcome() : null;
  const imagesFailing = Boolean(lastImage && !lastImage.ok);

  const checks: Check[] = [
    {
      // Every migration in this repo is a file a human is asked to paste into
      // the Supabase SQL editor. Nothing ever checked that they had, so a
      // deployment could be fully configured — every key present, this
      // endpoint green — while Autopilot failed on every single tick because
      // autopilot.sql had never been run. Required severity: this is not a
      // degraded feature, it is a feature that cannot work at all.
      name: 'database_schema',
      ok: schemaGaps.length === 0,
      code: schemaGaps.length ? 'migration_pending' : undefined,
      severity: 'required',
      detail: schemaDetail(schemaGaps),
    },
    {
      name: 'supabase',
      ok: has('NEXT_PUBLIC_SUPABASE_URL') && has('NEXT_PUBLIC_SUPABASE_ANON_KEY') && has('SUPABASE_SERVICE_ROLE_KEY'),
      severity: 'required',
      detail: 'Database, auth and storage.',
    },
    {
      // Presence was never the question. The anon key and the service-role key
      // are both long JWTs, sit beside each other in the Supabase dashboard,
      // and are pasted into Vercel by hand — and holding the wrong one here
      // breaks nothing visibly: it just makes every privileged read return
      // zero rows, which reads as "the data was never saved".
      name: 'supabase_service_role',
      ok: serviceKey.ok,
      code: serviceKey.code,
      severity: 'required',
      detail: serviceKey.detail,
    },
    {
      // The other end of the automatic path: somewhere to PUT the result.
      name: 'sheet_write',
      ok: sheet.ok && sheet.canEdit,
      code: sheet.ok ? (sheet.canEdit ? undefined : 'read_only') : sheet.reason,
      severity: 'required',
      detail: sheet.detail,
    },
    {
      // The automatic path's single point of failure, asked live.
      name: 'sweep_owner',
      ok: owner.ok,
      code: owner.ok ? owner.source : owner.reason,
      severity: 'required',
      detail: owner.ok
        ? owner.detail + (owner.brandProfile ? '' : ' Save Brand Brain to give the copy the clinic’s voice.')
        : owner.detail,
    },
    {
      name: 'cron_secret',
      ok: has('CRON_SECRET'),
      severity: 'required',
      detail:
        'Without it BOTH scheduled jobs in vercel.json fail closed every day: ' +
        '/api/metricool/sync returns 401 at its bearer check, and /api/autopilot/tick ' +
        'falls through to session auth that a cron does not have. Autopilot never runs ' +
        'and post_metrics is never populated, so the learning loop has no data.',
    },
    {
      name: 'assistant_session_secret',
      // Only a DEDICATED secret is ok. Falling back to CRON_SECRET used to
      // report "Dedicated signing secret configured", which hid exactly the
      // coupling this check exists to surface: CRON_SECRET is a plaintext
      // bearer that travels in an Authorization header on every cron run, so
      // reusing it as the assistant's HMAC key means one leaked header lets an
      // attacker mint signed sessions.
      ok: has('ASSISTANT_SESSION_SECRET'),
      severity: 'optional',
      detail: has('ASSISTANT_SESSION_SECRET')
        ? 'Dedicated signing secret configured.'
        : has('CRON_SECRET')
          ? 'Borrowing CRON_SECRET - a bearer token sent on every cron invocation. ' +
            'Set ASSISTANT_SESSION_SECRET so a leaked cron header cannot forge sessions.'
        : has('SUPABASE_SERVICE_ROLE_KEY')
          ? 'Falling back to SUPABASE_SERVICE_ROLE_KEY. It works, but couples the most ' +
            'privileged credential in the system to an unrelated purpose.'
          : 'NO signing key at all. Assistant sessions cannot survive a round-trip: ' +
            'guided mode and yes/no confirmation are inert until one is set.',
    },
    {
      name: 'allowed_emails',
      // An allowlist configured under either name works; only the hard-coded
      // fallback is a real problem. Checking ALLOWED_EMAILS alone reported 503
      // degraded for a deployment that was configured, just under the other name.
      ok: has('ALLOWED_EMAILS') || has('NEXT_PUBLIC_ALLOWED_EMAILS'),
      severity: 'required',
      detail: has('ALLOWED_EMAILS')
        ? ALLOWED_EMAILS.length + ' address(es) allowed, set server-side.'
        : has('NEXT_PUBLIC_ALLOWED_EMAILS')
          ? ALLOWED_EMAILS.length + ' address(es) allowed, but only via ' +
            'NEXT_PUBLIC_ALLOWED_EMAILS - that value is inlined into the browser bundle, ' +
            'so the privileged account list is public and cannot rotate without a deploy. ' +
            'Set ALLOWED_EMAILS as well.'
          : 'No allowlist configured: it resolves to a hard-coded default in lib/access.ts, ' +
            'so changing who can sign in needs a code change and a deploy.',
    },
    {
      name: 'ai_provider',
      ok: has('ANTHROPIC_API_KEY') || has('OPENAI_API_KEY'),
      severity: 'required',
      detail: 'At least one generation provider must be configured.',
    },
    {
      name: 'metricool',
      ok: has('METRICOOL_USER_TOKEN') && has('METRICOOL_BLOG_ID') && has('METRICOOL_USER_ID'),
      severity: 'required',
      detail: ALLOWED_BLOG_IDS.size + ' brand profile(s) allowlisted for scheduling.',
    },
    {
      name: 'semrush',
      ok: keywords.ok,
      code: keywords.reason,
      severity: 'optional',
      detail: keywords.ok
        ? 'Live keyword research is running over ' +
          (keywords.transport === 'mcp' ? 'the Semrush MCP server (v4 key)' : 'the Standard API (v3 key)') +
          '. Balance ' + keywords.balance + ' units, floor ' + keywords.floor + '.'
        : keywords.reason === 'no_token'
          ? 'SEMRUSH_API_KEY is unset: the keyword layer degrades to cache-or-link-out — the Semrush ' +
            'panel, the assistant’s live grounding and Autopilot’s angle selection all lose their data.'
          : keywords.reason === 'budget'
            ? 'The key is set but the unit balance (' + keywords.balance + ') is at or below the protection ' +
              'floor (SEMRUSH_UNIT_FLOOR=' + keywords.floor + '), so every live lookup is refused. Top up units ' +
              'or lower the floor. Until then the keyword layer is serving cache-or-link-out only.'
            : keywords.transport === 'mcp'
              ? 'The key is a v4 key routed through the Semrush MCP server, where the balance is the monthly allowance ' +
                '(SEMRUSH_UNIT_ALLOWANCE) minus the spend logged in semrush_usage — and that log could not be read, so the ' +
                'spend guard fails closed. Check the database; this clears within 30s of the log being readable again.'
              : 'The key is set but countapiunits.html (a v3 endpoint) returns no number, so the spend guard ' +
                'fails closed and every live lookup is refused. A v4 key (semrtkn-…) is routed through the MCP server ' +
                'automatically; a key of any other shape is assumed to be a Standard API (v3) key, and if Semrush ' +
                'rejects it there, this is the result. If Semrush is merely down, this clears within 30s.',
    },
    {
      // Capability, not configuration. `has('OPENAI_API_KEY')` stayed true
      // through days of failed generations while the account sat at zero
      // credit, so this endpoint reported healthy about a feature that was
      // dead — the same mistake the semrush check above was corrected for.
      // The last real attempt is recorded by lib/images.ts on every call; a
      // failure older than a day is no longer evidence about right now.
      name: 'images',
      ok: imagesConfigured && !imagesFailing,
      code: !imagesConfigured ? 'not_configured' : imagesFailing ? (lastImage!.reason ?? 'other') : undefined,
      severity: 'optional',
      detail: !imagesConfigured
        ? 'AI hero images need OPENAI_API_KEY and IMAGE_GEN not set to "off".'
        : !imagesFailing
          ? 'AI hero images are configured' + (lastImage?.ok ? ' and the last generation succeeded.' : '.')
          : lastImage!.reason === 'no_credit'
            ? 'The key is set but the OpenAI account is out of credit: the last generation was refused for ' +
              'billing. Images, the vision check that keeps text off them, and the voice assistant all run on ' +
              'this one account, so all three are down until it is topped up. Text generation is unaffected — ' +
              'it runs on Anthropic.'
            : lastImage!.reason === 'bad_key'
              ? 'The key is set but OpenAI rejected it on the last generation. Check OPENAI_API_KEY has not ' +
                'been revoked or rotated.'
              : lastImage!.reason === 'rate_limited'
                ? 'OpenAI rate-limited the last generation. This usually clears itself; if it does not, the ' +
                  'account may be at a usage cap.'
                : 'The last image generation failed. Try one from the Image Studio to see the reason.',
    },
    {
      name: 'opus_webhook',
      ok: has('OPUS_WEBHOOK_SECRET') || has('OPUS_API_KEY'),
      severity: 'optional',
      detail: 'Without a secret the webhook refuses every call with 503; the poll fallback still delivers clips.',
    },
    {
      // Optional, not required: without it the Video Library asks for a pasted
      // transcript instead of making one, which is the old manual routine
      // rather than a broken app.
      name: 'audio_extractor',
      ok: ffmpeg.ok,
      code: ffmpeg.ok ? undefined : ffmpeg.reason,
      severity: 'optional',
      detail: ffmpeg.ok
        ? 'Drive videos can be transcribed: ffmpeg runs from ' + ffmpeg.path + '.'
        : ffmpeg.reason === 'absent'
          ? 'The ffmpeg binary was never fetched by the build. ffmpeg-static downloads it in an ' +
            'install script and does not ship it in the package, so a build that skips lifecycle ' +
            'scripts leaves nothing behind the path. Drive videos cannot be transcribed until this ' +
            'is fixed; the Video Library will ask for a pasted transcript. ' + ffmpeg.detail
          : ffmpeg.reason === 'copy_failed'
            ? 'The binary is present but not executable, and it could not be copied somewhere it ' +
              'would be. ' + ffmpeg.detail
            : 'No ffmpeg path is configured at all. Set FFMPEG_PATH, or reinstall ffmpeg-static.',
    },
    {
      name: 'drive',
      ok: has('GOOGLE_SERVICE_ACCOUNT_JSON') && has('DRIVE_FOLDER_ID'),
      severity: 'optional',
      code: !has('DRIVE_FOLDER_ID') ? 'no_folder' : !has('GOOGLE_SERVICE_ACCOUNT_JSON') ? 'no_service_account' : undefined,
      // This grew a second job and the check never said so. Besides clip
      // storage, DRIVE_FOLDER_ID is where the world-readable COPY of a video
      // goes — the only URL Metricool can fetch, because the clinic's own file
      // is private. Without it no video reaches any network, and the old wording
      // ("permanent clip storage") sent people looking at the wrong feature.
      detail: !has('DRIVE_FOLDER_ID')
        ? 'DRIVE_FOLDER_ID is not set. Videos cannot be attached to posts at all: the shareable copy has nowhere to go, so YouTube and TikTok drafts arrive empty.'
        : !has('GOOGLE_SERVICE_ACCOUNT_JSON')
          ? 'GOOGLE_SERVICE_ACCOUNT_JSON is not set, so nothing can read or copy anything in Drive.'
          : 'Holds the shareable copy of each video — the URL Metricool fetches — and permanent clip storage.',
    },
    {
      name: 'drive_storage',
      ok: driveFolder.ok,
      // Required, not optional: without it no video reaches any network at all.
      severity: 'required',
      code: driveFolder.error ? 'unreachable' : driveFolder.inSharedDrive ? undefined : 'not_shared_drive',
      detail: driveFolder.error
        ? 'Could not read the copies folder: ' + driveFolder.error
        : driveFolder.inSharedDrive
          ? 'Copies folder “' + driveFolder.folderName + '” is inside a Shared Drive, so the organisation owns the copies and the service account’s own 0-byte quota never applies.'
          : 'Copies folder “' + driveFolder.folderName + '” is NOT in a Shared Drive. A service account owns no storage of its own, so every video copy is refused there however empty it looks, and no video can be attached to any post. '
            + 'Create a Shared Drive, add the service account as Content manager, and point DRIVE_FOLDER_ID at a folder inside it.',
    },
    {
      name: 'rate_limiting',
      ok: process.env.RATE_LIMIT_FAIL_OPEN !== 'true',
      severity: 'required',
      detail:
        'RATE_LIMIT_FAIL_OPEN=true removes the only cap on AI spend whenever the database ' +
        'errors. It exists for a one-time migration bootstrap; leave it unset in production.',
    },
  ];

  return { checks, schemaGaps };
}

// --- the cached read -------------------------------------------------------
//
// The assistant asks for this on EVERY turn. Un-cached that is a Drive call, a
// Sheets call, a Semrush balance read and an ffmpeg resolve per message —
// latency the person waits through, and quota spent to answer "hello".
//
// Sixty seconds: long enough that a conversation costs one round of probes,
// short enough that fixing a variable and re-asking shows the fix.
const TTL_MS = 60_000;
let cached: { at: number; report: HealthReport } | null = null;
let inFlight: Promise<HealthReport> | null = null;

export async function cachedHealthReport(): Promise<HealthReport> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.report;
  // Share one round of probes between concurrent callers rather than starting
  // a second set while the first is still out.
  if (!inFlight) {
    inFlight = runHealthChecks()
      .then((report) => {
        cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
