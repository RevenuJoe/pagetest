import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Matches library.revenuagency.io
        sans: ["Montserrat", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      colors: {
        // Revenu brand palette — sourced from library.revenuagency.io and clients.revenuagency.io
        bg: "#FCF7F5",
        card: "#ffffff",
        ink: {
          DEFAULT: "#1c1f1d",
          soft: "#5b6361",
        },
        beige: {
          DEFAULT: "#E8DFD2", // pill inactive / line
          line: "#e8dfd2",
        },
        accent: {
          DEFAULT: "#2f7d6f",
          dark: "#1f6155",
          soft: "#d6e6e2",
          lite: "#76A09C",
        },
        warn:  "#D8865A",
        amber: "#D8A14E",
        bad:   "#C44536",
      },
      boxShadow: {
        card: "0 1px 2px rgba(20, 30, 28, 0.04), 0 6px 20px rgba(20, 30, 28, 0.05)",
        cardHover: "0 2px 4px rgba(20,30,28,0.05), 0 12px 28px rgba(20,30,28,0.08)",
      },
      borderRadius: {
        card: "18px",
      },
    },
  },
  plugins: [],
};

export default config;
