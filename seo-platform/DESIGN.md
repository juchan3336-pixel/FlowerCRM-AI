# SEO Platform Design System

## 1. Atmosphere & Identity

A quiet operations console for Korean local-business SEO. The signature is civic clarity: porcelain surfaces, botanical green accents, and dense schema/status information arranged without drama.

## 2. Color

| Role | Token | Light | Dark | Usage |
|---|---|---|---|---|
| Surface/primary | `--surface-primary` | `#f8faf8` | `#0d120f` | Page background |
| Surface/secondary | `--surface-secondary` | `#eef4ef` | `#151d18` | Panels |
| Surface/elevated | `--surface-elevated` | `#ffffff` | `#1d2821` | Cards |
| Text/primary | `--text-primary` | `#17231b` | `#f4fbf6` | Headlines/body |
| Text/secondary | `--text-secondary` | `#536158` | `#aebcaf` | Supporting copy |
| Border/default | `--border-default` | `#d8e3da` | `#2c3a31` | Dividers/cards |
| Accent/primary | `--accent-primary` | `#167044` | `#4fd08a` | CTA/focus |
| Accent/hover | `--accent-hover` | `#105c37` | `#7ee3aa` | Hover |
| Status/warning | `--status-warning` | `#b7791f` | `#f6c66b` | Caution |
| Status/error | `--status-error` | `#b42318` | `#ff8a7d` | Errors |

Accent is reserved for interactive elements and positive operational status. Raw colors outside this document are not allowed.

## 3. Typography

| Level | Size | Weight | Line Height | Tracking | Usage |
|---|---:|---:|---:|---:|---|
| Display | 48px | 700 | 1.1 | -0.02em | Home headline |
| H1 | 36px | 700 | 1.2 | -0.015em | Page titles |
| H2 | 28px | 650 | 1.3 | -0.01em | Sections |
| H3 | 20px | 650 | 1.4 | 0 | Cards |
| Body | 16px | 400 | 1.6 | 0 | Default |
| Body/sm | 14px | 400 | 1.5 | 0 | Metadata |
| Caption | 12px | 600 | 1.4 | 0.06em | Labels |

Primary font stack: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Mono stack: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`.

## 4. Spacing & Layout

Base unit is 4px. Page max width is 1120px. Use 16px mobile margins, 24px tablet gutters, and 32px desktop gutters.

## 5. Components

### Foundation Shell
- Structure: header, main content, footer.
- Spacing: 24px mobile, 32px desktop.
- States: links have hover, focus, and active styles.
- Accessibility: semantic landmarks and visible focus rings.

### Status Card
- Structure: title, one-line description, status badge.
- Variants: ready, planned, protected.
- Spacing: 20px inner, 16px gaps.
- States: hover only when linked; otherwise static.

## 6. Motion & Interaction

Motion is restrained. Interactive transitions use 150ms ease-out on color, border, opacity, and transform. Respect reduced motion.

## 7. Depth & Surface

Strategy: mixed. Use tonal shifts for layout sections and a single subtle border for cards. Shadows are reserved for overlays in later admin waves.
