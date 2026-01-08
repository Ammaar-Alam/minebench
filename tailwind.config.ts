import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(220 30% 6%)",
        card: "hsl(220 28% 10%)",
        border: "hsl(220 18% 18%)",
        fg: "hsl(220 20% 96%)",
        muted: "hsl(220 10% 65%)",
        accent: "hsl(270 90% 65%)"
      }
    }
  },
  plugins: []
} satisfies Config;
