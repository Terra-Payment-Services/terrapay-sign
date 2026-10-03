/* eslint-disable @typescript-eslint/no-var-requires */
const { fontFamily } = require('tailwindcss/defaultTheme');
const { default: flattenColorPalette } = require('tailwindcss/lib/util/flattenColorPalette');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['variant', '&:is(.dark:not(.dark-mode-disabled) *)'],
  content: ['src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', ...fontFamily.sans],
        display: ['var(--font-display)', 'var(--font-sans)', ...fontFamily.sans],
        signature: ['var(--font-signature)'],
        noto: ['var(--font-noto)'],
      },
      zIndex: {
        9999: '9999',
      },
      aspectRatio: {
        'signature-pad': '16 / 7',
      },
      colors: {
        border: 'hsl(var(--border))',
        'field-border': 'hsl(var(--field-border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        'envelope-editor-background': 'hsl(var(--envelope-editor-background))',
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
          // Error text. The fill colour is too light to read as text on white.
          text: 'hsl(var(--destructive-text))',
        },
        overlay: 'rgb(var(--overlay) / <alpha-value>)',
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        'field-card': {
          DEFAULT: 'hsl(var(--field-card))',
          border: 'hsl(var(--field-card-border))',
          foreground: 'hsl(var(--field-card-foreground))',
        },
        widget: {
          DEFAULT: 'hsl(var(--widget))',
          foreground: 'hsl(var(--widget-foreground))',
        },
        // Tailwind's stock green/red/yellow/orange/blue/grey ramps are
        // redefined onto the TerraPay palette. Documenso uses them directly in
        // roughly forty places for status chips, badges and alerts, so
        // redefining the ramps re-skins all of those at once and keeps the
        // semantics (green means success, red means error) intact. Lightness
        // ordering matches Tailwind's so existing 50/700 pairings still
        // contrast.
        green: {
          50: '#F2FAF5',
          100: '#DFF3E5',
          200: '#BFE7CC',
          300: '#90D9A8',
          400: '#6BD28D',
          500: '#4ECB71',
          600: '#3CB061',
          700: '#2E8C4D',
          800: '#246B3B',
          900: '#1B5E20',
          950: '#0E3312',
        },
        emerald: {
          50: '#F2FAF5',
          100: '#DFF3E5',
          200: '#BFE7CC',
          300: '#90D9A8',
          400: '#6BD28D',
          500: '#4ECB71',
          600: '#3CB061',
          700: '#2E8C4D',
          800: '#246B3B',
          900: '#1B5E20',
          950: '#0E3312',
        },
        red: {
          50: '#FFEFEE',
          100: '#FFDAD9',
          200: '#FFC6C4',
          300: '#FFA9A6',
          400: '#FF7A73',
          500: '#EB5E57',
          600: '#C84A44',
          700: '#B83530',
          800: '#8F2926',
          900: '#6B1F1C',
          950: '#3D1110',
        },
        yellow: {
          50: '#FDF8E7',
          100: '#FAEFC4',
          200: '#F5E08C',
          300: '#F0DF73',
          400: '#E3BE3A',
          500: '#D4A017',
          600: '#B08413',
          700: '#8B4513',
          800: '#6E3A10',
          900: '#522C0C',
          950: '#2E1806',
        },
        amber: {
          50: '#FDF8E7',
          100: '#FAEFC4',
          200: '#F5E08C',
          300: '#F0DF73',
          400: '#E3BE3A',
          500: '#D4A017',
          600: '#B08413',
          700: '#8B4513',
          800: '#6E3A10',
          900: '#522C0C',
          950: '#2E1806',
        },
        orange: {
          50: '#FFF6EE',
          100: '#FFF1E2',
          200: '#FFD5B8',
          300: '#FFB88C',
          400: '#FF9A62',
          500: '#E87A3E',
          600: '#C96530',
          700: '#A35226',
          800: '#8B4513',
          900: '#6B350F',
          950: '#3D1E08',
        },
        blue: {
          50: '#F1F5FE',
          100: '#E8EEFB',
          200: '#D3E0FA',
          300: '#99C3FF',
          400: '#618FFF',
          500: '#4572E0',
          600: '#3B63C9',
          700: '#2B4994',
          800: '#213871',
          900: '#1A2C5A',
          950: '#111D3C',
        },
        gray: {
          50: '#f6f7f7',
          100: '#eeeff0',
          200: '#dedfe2',
          300: '#c2c5cb',
          400: '#8b92a0',
          500: '#6e7586',
          600: '#505766',
          700: '#3E4452',
          800: '#2C313B',
          900: '#21242a',
          950: '#121419',
        },
        slate: {
          50: '#f6f7f7',
          100: '#eeeff0',
          200: '#dedfe2',
          300: '#c2c5cb',
          400: '#8b92a0',
          500: '#6e7586',
          600: '#505766',
          700: '#3E4452',
          800: '#2C313B',
          900: '#21242a',
          950: '#121419',
        },
        // TerraPay design system ramps. The keys keep their original names
        // (`documenso`, `dawn`, `water`) because ~95 call sites and a handful
        // of E2E selectors reference them; only the values changed. Each ramp
        // keeps the lightness structure of the one it replaced, so existing
        // pairings like `bg-water text-water-700` still contrast.
        documenso: {
          DEFAULT: '#213871', // blue-900, brand primary
          50: '#F1F5FE', //     blue-50
          100: '#E8EEFB', //    blue-100
          200: '#D3E0FA', //
          300: '#99C3FF', //    blue-400
          400: '#618FFF', //    blue-500
          500: '#4572E0', //    blue-600
          600: '#3B63C9', //    blue-700
          700: '#2B4994', //    blue-800
          800: '#213871', //    blue-900
          900: '#1A2C5A', //
          950: '#111D3C', //
        },
        // Warm neutral, from the design system's cream and clay values.
        dawn: {
          DEFAULT: '#BF7A4B', // data-clay
          50: '#FFFAF4',
          100: '#FFF1E2', //    cream-100
          200: '#F4DCC0', //    cream-deep
          300: '#E8C49B',
          400: '#D9A273',
          500: '#BF7A4B', //    data-clay
          600: '#A3663E',
          700: '#855331',
          800: '#6B4327',
          900: '#553520',
          950: '#33200F',
        },
        // Cool accent, from the design system's teal and steel data values.
        water: {
          DEFAULT: '#D7E6EA', // light fill, matches the tint it replaced
          50: '#F2F9F9',
          100: '#E4F2F2',
          200: '#D7E6EA',
          300: '#ACE0DF', //    data-green2
          400: '#6FD0CA',
          500: '#2EC4B6', //    data-teal
          600: '#26A197',
          700: '#1F8078', //
          800: '#1A6660',
          900: '#155049',
          950: '#0C302C',
        },
        recipient: {
          green: 'hsl(var(--recipient-green))',
          blue: 'hsl(var(--recipient-blue))',
          purple: 'hsl(var(--recipient-purple))',
          orange: 'hsl(var(--recipient-orange))',
          yellow: 'hsl(var(--recipient-yellow))',
          pink: 'hsl(var(--recipient-pink))',
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
      },
      // TOPS elevation, tinted with blue-900 rather than black. Named
      // `elevation-*` because `shadow-card` would collide with the `card`
      // colour, which Tailwind also offers as a shadow colour.
      boxShadow: {
        'elevation-card': '0px 1px 3px rgba(33, 56, 113, 0.08), 0px 1px 2px rgba(33, 56, 113, 0.06)',
        'elevation-dropdown': '0px 4px 8px rgba(33, 56, 113, 0.10), 0px 2px 4px rgba(33, 56, 113, 0.06)',
        'elevation-dialog': '0px 8px 24px rgba(33, 56, 113, 0.12), 0px 4px 8px rgba(33, 56, 113, 0.08)',
        'elevation-toast': '0px 16px 48px rgba(33, 56, 113, 0.16), 0px 8px 16px rgba(33, 56, 113, 0.10)',
      },
      borderRadius: {
        DEFAULT: 'calc(var(--radius) - 3px)',
        '2xl': 'calc(var(--radius) + 4px)',
        xl: 'calc(var(--radius) + 2px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: 0 },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: 0 },
        },
        'caret-blink': {
          '0%,70%,100%': { opacity: '1' },
          '20%,50%': { opacity: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'caret-blink': 'caret-blink 1.25s ease-out infinite',
      },
      screens: {
        '3xl': '1920px',
        '4xl': '2560px',
        '5xl': '3840px',
        print: { raw: 'print' },
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
    require('@tailwindcss/typography'),
    require('@tailwindcss/container-queries'),
    addVariablesForColors,
  ],
};

function addVariablesForColors({ addBase, theme }) {
  const allColors = flattenColorPalette(theme('colors'));
  const newVars = Object.fromEntries(Object.entries(allColors).map(([key, val]) => [`--${key}`, val]));

  addBase({
    ':root': newVars,
  });
}
