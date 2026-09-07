import { notFound } from 'next/navigation';
import SourcesView, { type Tab } from '@/components/SourcesView';

const KINDS: Tab[] = ['calendar', 'videos', 'images'];

// /sources/calendar · /sources/videos · /sources/images — each of the team's
// three Google documents as its own section, with the live document itself as
// the main element (see components/SourcesView.tsx).
export default async function SourceKindPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!KINDS.includes(kind as Tab)) notFound();
  return <SourcesView kind={kind as Tab} />;
}
