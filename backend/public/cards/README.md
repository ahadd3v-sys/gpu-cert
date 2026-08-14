# Card photographs

Empty on purpose, and the reason is worth reading before filling it.

There is no source that can be scraped for these. Wikidata has no image for a
GeForce RTX 3070 and no entry at all for a Radeon RX 9060 XT. TechPowerUp has
one for essentially every card ever made, and serving those from here would mean
their ad-funded bandwidth paying for this, which their terms prohibit and which
they block once they notice. It is also the first objection anyone raises about
a product whose whole pitch is trustworthiness.

So each picture is added deliberately, from somewhere it may legitimately come
from:

- A manufacturer press kit. NVIDIA and AMD publish product renders for editorial
  use, which covers reference designs.
- A photograph of the actual card, taken by you or by an owner who agreed.

To add one: drop the file here, then add a line to `CARD_IMAGES` in
`src/card-art.ts` keyed by what `normaliseModel` returns for that device name,
for example `rtx-3070` for "NVIDIA GeForce RTX 3070".

Anything without a picture falls back to a mark generated from the card's own
fingerprint, so an unphotographed card still renders and one released tomorrow
does too. That fallback is why this directory can stay mostly empty forever
without anything breaking.
