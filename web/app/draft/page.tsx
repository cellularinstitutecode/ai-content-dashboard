import Dashboard from '@/app/page';

// /draft — the creation workspace: Content Generator, Image Studio,
// Long-form to Shorts, the Publishing composer and topic research. The
// dashboard itself stays an overview (queue, Autopilot, SEO, library).
export default function DraftPage() {
  return <Dashboard mode="draft" />;
}
