import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        bg: "hsl(var(--bg))",
        bg2: "hsl(var(--bg2))",
        card: "hsl(var(--card))",
        card2: "hsl(var(--card2))",
        border: "hsl(var(--border))",
        fg: "hsl(var(--fg))",
        muted: "hsl(var(--muted))",
        muted2: "hsl(var(--muted2))",
        accent: "hsl(var(--accent))",
        accent2: "hsl(var(--accent2))",
        danger: "hsl(var(--danger))",
        warn: "hsl(var(--warn))",
        success: "hsl(var(--success))",
      },
      boxShadow: {
        soft: "0 6px 16px -6px hsl(220 40% 2% / 0.24), 0 2px 4px -2px hsl(220 40% 2% / 0.12)",
        glow: "0 0 0 1px hsl(var(--accent) / 0.35), 0 8px 20px -6px hsl(var(--accent) / 0.28)",
        lift: "0 2px 6px -2px hsl(220 40% 2% / 0.18), 0 8px 20px -8px hsl(220 40% 2% / 0.14)",
      },
    }
  },
  plugins: []
} satisfies Config;
