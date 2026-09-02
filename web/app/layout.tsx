import './globals.css';
// Next 16 no longer re-exports Metadata from the package root.
import type { Metadata } from 'next/types';
import DraftingAssistant from '@/components/DraftingAssistant';
import { LiveContentProvider } from "@/components/LiveContentProvider";
import { WorkspaceProvider } from "@/components/workspace";
import ProgressProvider from "@/components/LoadingScreen";
import { SCHEDULE_TZ } from '@/lib/timezone';


export const metadata: Metadata = {
  title: 'AI Content Dashboard',
  description: 'Generate a multi-channel post pack, then send it to Metricool.'
};


export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Every scheduled time a person reads is rendered in this zone (see
    // lib/schedule-clock.ts). Stamping it here is what keeps the clock the app
    // WRITES with and the clock it DISPLAYS with from drifting apart — client
    // components cannot read SCHEDULE_TIMEZONE for themselves.
    <html lang="en" data-schedule-tz={SCHEDULE_TZ}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body className="glow">
        <WorkspaceProvider>
          <LiveContentProvider>
            <ProgressProvider>
              {children}
              <DraftingAssistant />
            </ProgressProvider>
          </LiveContentProvider>
        </WorkspaceProvider>
      </body>
    </html>
  );
}

