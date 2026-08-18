'use strict';
/**
 * Short lines from Tom Bombadil's songs in J.R.R. Tolkien's The Lord of the Rings,
 * shown as a small reward once a redline is finished. Brief quotations, credited.
 */

const QUOTES = [
  { line: 'Hey dol! merry dol! ring a dong dillo!', source: 'The Old Forest' },
  { line: 'Ring a dong! hop along! fal lal the willow!', source: 'The Old Forest' },
  { line: 'Tom Bom, jolly Tom, Tom Bombadillo!', source: 'The Old Forest' },
  { line: 'Old Tom Bombadil is a merry fellow;\nbright blue his jacket is, and his boots are yellow.', source: 'The Old Forest' },
  { line: 'Hop along, my little friends, up the Withywindle!\nTom’s going on ahead candles for to kindle.', source: 'The Old Forest' },
  { line: 'Old Tom Bombadil water-lilies bringing\ncomes hopping home again. Can you hear him singing?', source: 'In the House of Tom Bombadil' },
  { line: 'Down along under Hill, shining in the sunlight,\nwaiting on the doorstep for the cold starlight!', source: 'In the House of Tom Bombadil' },
  { line: 'Light goes the weather-wind and the feathered starling.', source: 'In the House of Tom Bombadil' },
  { line: 'Hey! Come derry dol! Hop along, my hearties!', source: 'In the House of Tom Bombadil' },
  { line: 'Wake now my merry lads! Wake and hear me calling!', source: 'Fog on the Barrow-downs' },
  { line: 'Hey! now! Come hoy now! Whither do you wander?\nUp, down, near or far, here, there or yonder?', source: 'Fog on the Barrow-downs' },
  { line: 'Sharp-ears, Wise-nose, Swish-tail and Bumpkin,\nWhite-socks my little lad, and old Fatty Lumpkin!', source: 'Fog on the Barrow-downs' },
  { line: 'Get out, you old Wight! Vanish in the sunlight!', source: 'Fog on the Barrow-downs' },
  { line: 'Come, derry dol, merry dol, my darling!', source: 'The Old Forest' },
  { line: 'Ho! Tom Bombadil, Tom Bombadillo!\nBy water, wood and hill, by the reed and willow…', source: 'The Old Forest' },
  { line: 'None has ever caught him yet, for Tom, he is the master:\nhis songs are stronger songs, and his feet are faster.', source: 'In the House of Tom Bombadil' },
  { line: 'Fear no alder black! Heed no hoary willow!', source: 'Fog on the Barrow-downs' },
  { line: 'Hobbits! Ponies all! We are fond of parties.', source: 'In the House of Tom Bombadil' },
  { line: 'Tom’s country ends here: he will not pass the borders.', source: 'Fog on the Barrow-downs' },
  { line: 'Now let the song begin! Let us sing together.', source: 'In the House of Tom Bombadil' },
  { line: 'Ring a ding dillo! Wake now, my merry friends!', source: 'Fog on the Barrow-downs' },
  { line: 'Whoa! Whoa! steady there! Now, my little fellows,\nwhither are you going to, puffing like a bellows?', source: 'The Old Forest' },
  { line: 'Hey! Come merry dol! derry dol! My darling!', source: 'The Old Forest' },
  { line: 'Old Tom Bombadil is a merry fellow.', source: 'The Old Forest' },
];

const ATTRIBUTION = 'Tom Bombadil — J.R.R. Tolkien, The Fellowship of the Ring';

/** Rotate through the quotes so the same one doesn't come up twice in a row. */
function quoteAt(index) {
  const q = QUOTES[((index % QUOTES.length) + QUOTES.length) % QUOTES.length];
  return { ...q, attribution: ATTRIBUTION };
}

module.exports = { QUOTES, ATTRIBUTION, quoteAt };
