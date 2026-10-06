// the ЙЦУКЕН keys in QWERTY order: a shortcut pressed with the Russian layout
// on arrives as the Cyrillic letter on that key, "щ" instead of "o"
const RU = 'йцукенгшщзхъфывапролджэячсмитьбю'
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,."

/**
 * The Latin key a letter was typed on, so single-key shortcuts work whatever
 * the keyboard layout. Only for shortcuts — text fields keep what was typed.
 */
export function latinKey(input: string): string {
  const index = RU.indexOf(input.toLowerCase())
  if (input.length !== 1 || index === -1) return input
  const latin = EN[index]!
  return input === input.toLowerCase() ? latin : latin.toUpperCase()
}
