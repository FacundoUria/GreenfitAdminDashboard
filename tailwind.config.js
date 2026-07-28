/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        greenfit: {
          primary: '#80C026', // Verde institucional
          dark: '#121212',
          card: '#1E1E1E',
        }
      }
    },
  },
  plugins: [],
}