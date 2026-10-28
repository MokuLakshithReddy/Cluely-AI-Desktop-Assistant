/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#0d1117',
        card: '#161b22',
        border: '#30363d',
        accent: '#58a6ff',
      },
    },
  },
  plugins: [],
}

