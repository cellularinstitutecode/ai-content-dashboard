import { redirect } from 'next/navigation';
import type { Route } from 'next';

export default function SourcesIndex() {
  redirect('/sources/calendar' as Route);
}
