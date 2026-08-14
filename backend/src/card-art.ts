// Which cards have a picture, and how a model name finds it.
//
// The mechanism is here; the pictures are not, and that is deliberate.
//
// There is no source that can be scraped for these. Wikidata has no image for a
// GeForce RTX 3070 and no entry at all for a Radeon RX 9060 XT. TechPowerUp has
// one for essentially every card ever made and serving them from here would be
// their ad-funded bandwidth paying for a commercial product, which their terms
// prohibit and which they block when they notice, so the front page would
// eventually show holes. It is also precisely the objection that lands first
// when a trust product gets attention.
//
// So images are added deliberately, one at a time, from somewhere they may
// legitimately come from: a manufacturer press kit, a photograph of the actual
// card, or an owner who agreed. Drop a file in public/cards and add a line
// below. Anything without one falls back to the generated die mark, so a card
// nobody has photographed still renders, and a card released tomorrow does too.
//
// This is the part that could not be worked around. Sourcing pictures is a
// decision; having somewhere for them to go was the blocker.

/// Reduces a reported device name to something stable enough to match on.
///
/// Cards report themselves inconsistently: "NVIDIA GeForce RTX 3070",
/// "AMD Radeon RX 6600", sometimes with (TM) or a board partner's name
/// attached. Matching on the raw string would need an entry per variation.
export function normaliseModel(deviceName: string): string {
  return deviceName
    .toLowerCase()
    .replace(/\((r|tm)\)/g, " ")
    .replace(/\b(nvidia|amd|intel|geforce|radeon|graphics)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/// Model key to file name in public/cards. Empty until pictures exist that are
/// ours to use.
///
/// Keys are what normaliseModel produces, so "NVIDIA GeForce RTX 3070" looks up
/// "rtx-3070". Check with the same function rather than guessing the spelling.
const CARD_IMAGES: Record<string, string> = {};

/// The picture for a card, or null when there is not one.
///
/// Null is the normal case and always will be for most cards, so every caller
/// has to handle it. That is what stops this becoming a source of broken
/// images the first time an unfamiliar GPU turns up.
export function cardImage(deviceName: string): string | null {
  const key = normaliseModel(deviceName);
  // A generic name reduces to nothing: "AMD Radeon(TM) Graphics", which is what
  // integrated parts report, loses every word to the vendor filter. Without
  // this guard an empty key could match an accidental empty entry and put one
  // card's photograph on every unnamed device.
  if (key === "") return null;
  const file = CARD_IMAGES[key];
  return file ? `/cards/${file}` : null;
}
