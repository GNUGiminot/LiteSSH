// Каноническое представление сочетания клавиш, независимое от раскладки (через e.code).

const CODE_MAP: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space'
}

function baseKey(code: string): string {
  if (code.startsWith('Key')) return code.slice(3) // KeyE → E
  if (code.startsWith('Digit')) return code.slice(5) // Digit1 → 1
  return CODE_MAP[code] ?? code // PageUp, Tab, Enter, F3, ArrowLeft…
}

/** Строит канонический комбо-стринг из события, либо null для одиночного модификатора. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(baseKey(e.code))
  return parts.join('+')
}

/** Человекочитаемый вид комбо (для UI). */
export function prettyCombo(combo: string): string {
  return combo
    .replace('Meta', 'Cmd')
    .replace('PageUp', 'PgUp')
    .replace('PageDown', 'PgDn')
}
