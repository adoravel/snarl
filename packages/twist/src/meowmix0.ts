// meowmix0.5 'rithm, insert description here o algo así
// SPDX-License-Identifier: 0BSD
// deno-fmt-ignore-file

const LUT = "m me mew meow mrow mrrr ow mreow rr nya prr purr rrr eow miao mraow".split(" ");

// thats why u lwk shouldnt let yo feline step on the keyboard
function purrmux1(input: string) {
	// the birth and negation of a pair of breasts
	let h = (0x80085 * ~0x80085) >>> 0; // my brutha in christ what the actual fuck is this❓
       				                    // pls get the children outta the room

	for (let i = 0; i < input.length; i++) {
		const disgrace = input.codePointAt(i)!;
        if (disgrace > 0xFFFF) i++; // utf-16 hates ur whole bloodline
        h = Math.imul(h ^ disgrace, 0x9e3779b9); // 2³² ÷ Φ
	}

	// hoe thinks it be murmurhash 🥀
	h ^= h >>> 15;
	h = Math.imul(h, 0x85ebca77);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}


export default function meowmix0(input: string) {
  let bits = purrmux1(input);
  let mrrp = "";

  for (let i = 0; i < 8; i++) {
  	const idx = bits & 0xF;
	  const word = LUT[idx];
    mrrp += (i % 2 === 0) ? word.toUpperCase() : word;
    bits >>>= 4;
  }

  return mrrp;
}



