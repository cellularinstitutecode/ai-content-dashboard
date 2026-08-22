'use client';

// One nav, four sections. The sub-pages used to render nothing but a
// "Back to dashboard" link, so getting from Calendar to Templates meant two
// clicks through a page you didn't want. This is the shared horizontal
// equivalent of the dashboard sidebar, sized for the sub-page headers.

export const SECTIONS = [
  { href: '/', label: 'Dashboard' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/brand', label: 'Brand Brain' },
  { href: '/templates', label: 'Templates' },
] as const;

export default function PageNav({ current }: { current: string }) {
  return (
    <nav aria-label="Sections" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {SECTIONS.map((s) => {
        const active = s.href === current;
        return (
          <a
            key={s.href}
            href={s.href}
            aria-current={active ? 'page' : undefined}
            style={{
              fontSize: 13,
              lineHeight: 1.2,
              textDecoration: 'none',
              padding: '7px 13px',
              borderRadius: 999,
              border: '1px solid ' + (active ? 'transparent' : 'rgba(0,0,0,0.10)'),
              background: active ? '#0071e3' : '#ffffff',
              color: active ? '#ffffff' : '#3a3a3c',
              fontWeight: active ? 600 : 500,
            }}
          >
            {s.label}
          </a>
        );
      })}
    </nav>
  );
}
