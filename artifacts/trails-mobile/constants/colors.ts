/**
 * Deep-ocean color palette — mirrors artifacts/trails/src/index.css
 *
 * All HSL values from the web app converted to hex.
 * background: hsl(220,40%,4%)   foreground: hsl(210,20%,85%)
 * primary:    hsl(180,80%,40%)  card:       hsl(220,40%,6%)
 */
const colors = {
  light: {
    // Legacy aliases
    text: '#D1D9E0',
    tint: '#14B8B8',

    // Core surfaces
    background: '#06090E',
    foreground: '#D1D9E0',

    // Cards / elevated surfaces
    card: '#090D15',
    cardForeground: '#D1D9E0',

    // Primary — bioluminescent teal
    primary: '#14B8B8',
    primaryForeground: '#0D1526',

    // Secondary — dark murky blue
    secondary: '#1B2232',
    secondaryForeground: '#D1D9E0',

    // Muted
    muted: '#121721',
    mutedForeground: '#8595AD',

    // Accent — dark teal highlight
    accent: '#133939',
    accentForeground: '#1AE6E6',

    // Destructive
    destructive: '#A32929',
    destructiveForeground: '#FFFFFF',

    // Borders + inputs
    border: '#151D28',
    input: '#1B2232',

    // Glow ring
    ring: '#1AE6E6',
  },

  // 0.75rem = 12px, matching web --radius
  radius: 12,
};

export default colors;
