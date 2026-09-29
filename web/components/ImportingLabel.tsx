'use client';

// components/ImportingLabel.tsx
// "Copying 45 MB… 12 s" — the tile caption while a Library photo is copied
// in. Counts up once a second so a long copy of a big photo does not read as
// stuck; a small photo just says the verb (lib/library-import.ts).

import { useEffect, useState } from 'react';
import { busyLabel } from '@/lib/library-import';

export default function ImportingLabel({ verb, size }: { verb: string; size: number | null | undefined }) {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{busyLabel(verb, size, (now - started) / 1000)}</>;
}
