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
        bg: '#050914',
        panel: '#0b1424',
        panel2: '#07111f',
        line: 'rgba(255,255,255,.10)',
        accent: '#3b82f6'
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        display: ['Sora', 'sans-serif']
      }
    }
  },
  plugins: []
};
export default config;
