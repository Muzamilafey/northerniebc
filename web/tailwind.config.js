/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 50: '#eef3f9', 100: '#d5e0ee', 600: '#1d3a63', 700: '#14304f', 800: '#0f2744', 900: '#0b1f3a' },
        brand: { 50: '#fdf4ec', 100: '#f9e2cc', 400: '#eaa363', 500: '#e39046', 600: '#d17426', 700: '#a95a1a' },
        teal: { 600: '#0f766e', 700: '#115e59' }
      },
      fontFamily: { sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Noto Sans', 'Arial', 'sans-serif'] }
    }
  },
  plugins: []
};
