import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // Apple-inspired light system: near-white surfaces, calm blue accent
        canvas: '#f5f5f7',      // page background
        surface: '#ffffff',     // cards / panels
        subtle: '#fbfbfd',      // secondary surface
        line: 'rgba(0,0,0,0.08)',
        ink: {
          DEFAULT: '#1d1d1f',   // primary text
          soft: '#3a3a3c',
          muted: '#6e6e73',     // secondary text
          faint: '#a1a1a6'
        },
        accent: {
          DEFAULT: '#0071e3',   // Apple system blue
          hover: '#0077ed',
          soft: '#e8f1fe'
        },
        success: '#34c759',
        warn: '#ff9f0a',
        danger: '#ff3b30'
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Inter', 'system-ui', 'sans-serif'],
        display: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'Inter', 'system-ui', 'sans-serif']
      },
      fontSize: {
        'display': ['44px', { lineHeight: '1.08', letterSpacing: '-0.02em' }],
        'title': ['28px', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        'headline': ['20px', { lineHeight: '1.25', letterSpacing: '-0.01em' }]
      },
      borderRadius: {
        xl: '14px',
        '2xl': '18px',
        '3xl': '24px'
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)',
        soft: '0 1px 3px rgba(0,0,0,0.05)',
        pop: '0 12px 40px rgba(0,0,0,0.12)',
        focus: '0 0 0 4px rgba(0,113,227,0.18)'
      },
      transitionTimingFunction: {
        apple: 'cubic-bezier(0.28, 0.11, 0.32, 1)'
      }
    }
  },
  plugins: []
};

export default config;
