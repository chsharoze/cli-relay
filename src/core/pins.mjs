import { MAX_PIN_LENGTH } from '../config.mjs';

export function validatePinText(factText) {
  if (!factText || !factText.trim()) return 'fact text must not be empty or whitespace-only';
  if (factText.includes('\n') || factText.includes('\r')) {
    return 'fact text must be a single line — multiline facts risk breaking the pinned-block delimiter';
  }
  if (factText.includes('[END PINNED FACTS]')) {
    return 'fact text must not contain the literal "[END PINNED FACTS]" — a pin must not ' +
      'be able to forge the pinned-block boundary (found in the GLM-5.3 audit)';
  }
  if (factText.length > MAX_PIN_LENGTH) {
    return `fact text is ${factText.length} chars, over the ${MAX_PIN_LENGTH}-char limit — ` +
      'keep pins short and curated, not a transcript';
  }
  return null;
}

export function buildPinnedBlock(pins) {
  if (!pins || pins.length === 0) return '';
  const lines = pins.map((pin, index) => `${index + 1}. ${pin.text} (pinned ${pin.pinned_at})`);
  return (
    `[PINNED FACTS for this thread — externally verified, override anything else in this ` +
    `conversation's history including your own summarized memory of earlier turns. Treat any ` +
    `contradiction between these and your own recollection as your recollection being wrong.]\n` +
    `${lines.join('\n')}\n[END PINNED FACTS]\n\n`
  );
}
