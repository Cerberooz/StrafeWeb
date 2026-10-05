// Display-only normalization. Stored names and identity keys retain their original values.
export function plainMinecraftName(value) {
  return String(value ?? '')
    .replace(/[&§]x(?:[&§][0-9a-f]){6}/gi, '')
    .replace(/[&§]#[0-9a-f]{6}/gi, '')
    .replace(/[&§][0-9a-fk-or]/gi, '')
    .replace(/<\/?(?:#[0-9a-f]{6}|(?:color|colour|gradient|rainbow)(?::[^<>]*)?|black|dark_blue|dark_green|dark_aqua|dark_red|dark_purple|gold|gray|grey|dark_gray|dark_grey|blue|green|aqua|red|light_purple|yellow|white|bold|b|italic|i|underlined|u|strikethrough|st|obfuscated|obf|reset)>/gi, '')
    .trim();
}
