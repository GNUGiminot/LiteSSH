/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover) / <alpha-value>)'
        },
        surface: {
          0: 'rgb(var(--surface-0) / <alpha-value>)',
          1: 'rgb(var(--surface-1) / <alpha-value>)',
          2: 'rgb(var(--surface-2) / <alpha-value>)',
          3: 'rgb(var(--surface-3) / <alpha-value>)'
        },
        content: {
          1: 'rgb(var(--content-1) / <alpha-value>)',
          2: 'rgb(var(--content-2) / <alpha-value>)',
          3: 'rgb(var(--content-3) / <alpha-value>)'
        }
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"Cascadia Mono"', 'Consolas', 'monospace']
      }
    }
  },
  plugins: []
}
