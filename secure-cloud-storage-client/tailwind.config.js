/** @type {import('tailwindcss').Config} */
const withMT = require('@material-tailwind/react/utils/withMT')
module.exports = withMT({
  content: ['./src/renderer/src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Noto Sans TC'],
        serif: ['Noto Serif TC'],
        mono: ['Noto Sans TC'],
        display: ['Noto Sans TC']
      }
    }
  },
  plugins: []
})
