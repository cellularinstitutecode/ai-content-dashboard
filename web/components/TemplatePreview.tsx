'use client';

// components/TemplatePreview.tsx
// "Preview" on a saved template: one week's post for it, written the moment
// the panel opens, exactly as the Autopilot writes it — and shown in the same
// panel a dropped strategy's slot opens in (components/StrategyDrop.tsx
// SlotPanel): the copy per channel in an editor, "Verify / fix", a picture
// from the library or made, the keywords and the citation verdict. The post
// is saved to Recent Drafts like any other draft; nothing is scheduled and
// the template itself is not changed.

import { useEffect, useRef, useState } from 'react';
import { announce } from '@/components/refreshBus';
import { SlotPanel, slotKey, type EditableSlot } from '@/components/StrategyDrop';
import { requestDraft, requestFix, requestPicture, requestSave, scopeFor, withPicture, type PreviewDraft, type Writing } from '@/components/slotPreview';
import { isPaused } from '@/components/pauseBus';
import { friendlyError } from '@/lib/friendly-error';
import { slotFromTemplate, type TemplateLike } from '@/lib/strategy-upload';

export default function TemplatePreview({ template, onClose }: { template: TemplateLike; onClose: () => void }) {
  const [slot] = useState<EditableSlot | null>(() => {
    const s = slotFromTemplate(template);
    return s ? { ...s, _k: slotKey(), on: true } : null;
  });
  const [draft, setDraft] = useState<PreviewDraft | null>(null);
  const [writing, setWriting] = useState<Writing>(null);
  const [err, setErr] = useState<string | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const started = useRef(false);

  async function write(angle: string) {
    if (!slot) return;
    const { _k: _key, on: _on, ...plain } = slot;
    setWriting('text'); setErr(null);
    try {
      const made = await requestDraft(plain, '', angle, scopeFor(slot._k));
      setDraft(made);
      announce('drafts', 'stats');
      // The picture follows the copy, unless the page is paused (the pause button on the right-hand badge).
      if (made.draftId && !isPaused()) await picture(false, made.draftId, true);
      else if (made.draftId) setDraft((d) => (d ? { ...d, imageNote: 'Paused before the picture was started.' } : d));
    } catch (e) {
      setErr(friendlyError(e, 'The post could not be written just now.'));
    } finally {
      setWriting(null);
    }
  }

  async function picture(again: boolean, id?: string | null, keepBusy = false) {
    const draftId = id || draftRef.current?.draftId;
    if (!slot || !draftId) return;
    setWriting('picture');
    try {
      const out = await requestPicture(draftId, again, scopeFor(slot._k));
      setDraft((d) => (d ? withPicture(d, out) : d));
      if (out.image?.url) announce('drafts', 'images');
    } catch (e) {
      const note = friendlyError(e, 'The picture could not be made just now.');
      setDraft((d) => (d ? { ...d, imageNote: note } : d));
    } finally {
      if (!keepBusy) setWriting(null);
    }
  }

  async function fix() {
    const draftId = draftRef.current?.draftId;
    if (!slot || !draftId) return;
    setWriting('fix'); setErr(null);
    try {
      const out = await requestFix(draftId, scopeFor(slot._k));
      setDraft((d) => (d ? { ...d, pack: { ...d.pack, ...out.pack }, checks: out.checks, fixNote: out.note } : d));
      announce('drafts', 'stats');
    } catch (e) {
      setErr(friendlyError(e, 'The citation could not be checked just now.'));
    } finally {
      setWriting(null);
    }
  }

  async function save(edits: Record<string, string>): Promise<boolean> {
    const cur = draftRef.current;
    if (!cur?.draftId) return false;
    setWriting('saving'); setErr(null);
    try {
      const saved = await requestSave(cur.draftId, { ...cur.pack, ...edits });
      setDraft((d) => (d ? { ...d, pack: saved } : d));
      announce('drafts', 'stats');
      return true;
    } catch (e) {
      setErr(friendlyError(e, 'We could not save those changes.'));
      return false;
    } finally {
      setWriting(null);
    }
  }

  // Written as the panel opens, as a dropped strategy's posts are.
  useEffect(() => {
    if (!slot || started.current) return;
    started.current = true;
    void write(slot.angles[0] || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!slot) return null;
  return (
    <SlotPanel
      fixed
      slot={slot}
      draft={draft}
      writing={writing}
      draftErr={err}
      onWrite={(angle) => void write(angle)}
      onPicture={(again) => void picture(again)}
      onFix={() => void fix()}
      onLibraryPicked={(image, notes) => setDraft((d) => (d ? { ...d, image, imageQuality: 'library', imageNote: notes.join(' ') || undefined, pack: { ...d.pack, _image: image } } : d))}
      onSave={save}
      onChange={() => { /* the template is what it is; the preview does not edit it */ }}
      onRemove={onClose}
      onClose={onClose}
    />
  );
}
