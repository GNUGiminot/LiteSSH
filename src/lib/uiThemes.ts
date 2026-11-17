/** Палитры интерфейса. 'default' — штатные светлая/тёмная темы с переключателем в шапке. */
export interface UiPalette {
  label: string
  dark: boolean
  bg: string
  card: string
  line: string
  text: string
  muted: string
  accent: string
  onAccent: string
}

export const UI_THEMES: Record<string, UiPalette> = {
  parchment: { label: 'Пергамент', dark: false, bg: '#ece4d3', card: '#f7f1e3', line: '#dccfb4', text: '#3a2f25', muted: '#7a6a57', accent: '#9a5a2a', onAccent: '#fff8ee' },
  honey: { label: 'Мёд', dark: false, bg: '#f4ead0', card: '#fdf7e8', line: '#e6d7ae', text: '#3b3222', muted: '#80714f', accent: '#b06b0c', onAccent: '#fffaf0' },
  terracotta: { label: 'Терракота', dark: false, bg: '#efe2d9', card: '#fbf5f1', line: '#e2cdbf', text: '#3a2a24', muted: '#836a5f', accent: '#b4532f', onAccent: '#fff7f2' },
  sage: { label: 'Шалфей', dark: false, bg: '#e6ece4', card: '#f5f8f2', line: '#d0dacd', text: '#24302a', muted: '#63716a', accent: '#477a58', onAccent: '#f6fbf7' },
  blueprint: { label: 'Чертёж', dark: false, bg: '#e7edf3', card: '#f7f9fc', line: '#cfd9e4', text: '#16202b', muted: '#5b6878', accent: '#2b5fb8', onAccent: '#f5f8ff' },
  dusk: { label: 'Сумерки', dark: false, bg: '#ebe7f1', card: '#f8f6fb', line: '#dad3e5', text: '#2a2533', muted: '#6c6580', accent: '#6650ad', onAccent: '#faf8ff' },
  workshop: { label: 'Мастерская', dark: true, bg: '#26231f', card: '#2f2b26', line: '#433e37', text: '#ece5d8', muted: '#a59c8d', accent: '#e0a548', onAccent: '#241c10' },
  nightshift: { label: 'Ночная смена', dark: true, bg: '#141a24', card: '#1b2330', line: '#2a3445', text: '#dce4ef', muted: '#8a96aa', accent: '#3fb6a8', onAccent: '#071a18' }
}

const VARS = ['--surface-0', '--surface-1', '--surface-2', '--surface-3', '--content-1', '--content-2', '--content-3', '--on-accent']

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Смесь как color-mix(in srgb, a share, b). */
function mix(a: string, share: number, b: string): string {
  const x = rgb(a)
  const y = rgb(b)
  return x.map((v, i) => Math.round(v * share + y[i] * (1 - share))).join(' ')
}

/** Ставит CSS-переменные палитры на :root; без палитры — возвращает штатные из index.css. */
export function applyUiPalette(p: UiPalette | undefined): void {
  const style = document.documentElement.style
  if (!p) {
    for (const v of VARS) style.removeProperty(v)
    return
  }
  style.setProperty('--surface-0', rgb(p.bg).join(' '))
  style.setProperty('--surface-1', rgb(p.card).join(' '))
  style.setProperty('--surface-2', mix(p.text, 0.07, p.card))
  style.setProperty('--surface-3', rgb(p.line).join(' '))
  style.setProperty('--content-1', rgb(p.text).join(' '))
  style.setProperty('--content-2', rgb(p.muted).join(' '))
  style.setProperty('--content-3', mix(p.muted, 0.8, p.card))
  style.setProperty('--on-accent', rgb(p.onAccent).join(' '))
}
