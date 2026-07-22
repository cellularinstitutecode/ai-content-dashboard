import './globals.css';
import type { Metadata } from 'next';
import DraftingAssistant from '@/components/DraftingAssistant';

export const metadata: Metadata = {
  title: 'AI Content Dashboard',
  description: 'Generate a multi-channel post pack, then send it to Metricool.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body className="glow">
        {children}
        <DraftingAssistant />
      </body>
    </html>
  );
}
