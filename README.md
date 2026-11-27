# png-squeeze — lossless PNG compressor

[![make.fun bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![make.fun rank](https://make.fun/badge/png-squeeze-01-run-20261127/yovmiar19/png-squeeze-01-run-20261127-entry/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![make.fun reward](https://make.fun/badge/png-squeeze-01-run-20261127/yovmiar19/png-squeeze-01-run-20261127-entry/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Lossless PNG compressor for the make.fun `png-squeeze-01-run-20261127`
competition: squeezes 1280×720 RGBA screenshots into the smallest PNG
possible, every pixel (including fully transparent pixels' colours) decoded
exactly.

## How it works

1. **Decode** the input PNG (stored zlib, unfiltered rows) to RGBA.
2. **Colour-type reduction**: palette (type 3 + tRNS) when ≤ 256 distinct
   RGBA colours, grey (type 0) / grey+alpha (type 4) when R=G=B everywhere,
   RGB (type 2) when opaque, else RGBA (type 6). Palette orderings
   (frequency / luminance / RGB value / first occurrence) are ranked by the
   better of their filter-0 and filter-2 proxies; the best one wins.
3. **Filter choice**: five fixed filters plus per-row MinSum plus a brute
   per-row search (each row tried under all 5 filters, ranked by zlib
   level-6 size over the previous rows + the candidate row). Candidates are
   ranked with a fast zlib level-6 proxy.
4. **Deflate**: the winner is compressed two ways and the smaller kept —
   (a) zlib level 9 (default + filtered strategies), and (b) a custom
   optimal-parse deflate: lazy-matching LZ77 for the initial Huffman cost
   model, a full match cache (longest match at every position, hash chains),
   then DP shortest-path parsing with iterative cost-model updates, dynamic
   Huffman (length-limited via package-merge), block splitting.
   Optimal parsing is skipped for RGBA images zlib already squeezes below
   2% of raw size (measured: it never wins there).
5. **Verify**: the output PNG is decoded again and every pixel compared
   against the input; on any mismatch the exact input bytes are written
   instead (never a lossy or wrong answer).

Deterministic: no clock, no randomness, instance ids processed in sorted
order, all cutoffs by amount of work (chain limits, DP iterations, block
sizes scale with input size only). Node 22 standard library only.

Practice-set result (grade-local, official): **716,217** vs the house
fixed-paeth baseline's 420,399 — all 8 instances answered, byte-for-byte
reproducible across runs, ~37 s local for the whole set.

## Layout

- `main.ts` — entrypoint: loops the 8 instances, writes `/output/<id>/image.png`
- `src/pngDecode.ts` — PNG decoder (IHDR/PLTE/tRNS/IDAT inflate + unfilter)
- `src/pngEncode.ts` — PNG writer (chunks + CRC-32)
- `src/colorReduce.ts` — colour-type reduction + palette + tRNS
- `src/filters.ts` — the five PNG filters + MinSum + brute per-row choice
- `src/compress.ts` — proxy ranking + final level-9 deflate
- `src/deflate.ts` — custom deflate: lazy LZ77, match cache, DP optimal
  parse, length-limited Huffman (package-merge), dynamic blocks, zlib wrapper

## License

MIT — see `LICENSE`.
