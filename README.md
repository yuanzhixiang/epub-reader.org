# EPUB Reader Online

I still remember the frustration. I had a collection of EPUBs I wanted to read and study, but I couldn't find a single tool that felt _right_.

I surveyed everything on the market. The reality was disheartening: the interfaces were often cluttered and ugly, or they felt hostile—locking text away so I couldn't even copy a single chapter for my notes. The alternatives were heavy desktop apps that felt like overkill. All I wanted was something simple: a reader that was beautiful, instant, and empowered me to actually _use_ the content I was reading.

But it didn't exist.

So, I decided to build it myself. I poured my heart into creating the tool I always wished I had—one that combines aesthetics, ease of use, and freedom. Now, I'm sharing it with you, for free. I hope it brings a little more joy to your reading life.

---

A standalone, browser-based **epub reader** focused on fast local reading and TOC-driven navigation.

After you load an `.epub` file, the UI switches to a split view:

- Left: hierarchical table of contents
- Right: continuous chapter content

Clicking one TOC node renders the current node plus all descendant sections in one reading stream.

## Highlights

- Local-first EPUB processing in browser memory (no backend required for reading flow)
- Continuous content rendering in a single scrollable pane
- TOC node selection renders parent + children content together
- Content-pane-only select all (`Cmd/Ctrl + A` / `Ctrl + A` after focusing content area)
- Styled custom scrollbars and reader-focused typography

## How It Works

1. User drops or selects an EPUB file.
2. JSZip opens the archive in memory.
3. The app resolves OPF, parses manifest/spine, and builds TOC.
4. Clicking a TOC item re-renders the right pane with that node and all children.

## Tech Stack

- Plain HTML/CSS/JavaScript (no framework)
- [JSZip](https://stuk.github.io/jszip/) (loaded from CDN)
- Browser APIs (`DOMParser`, `XMLSerializer`, `File` / `ArrayBuffer`)

## Project Structure

```text
epub-viewer/
├── index.html
└── README.md
```

## Quick Start

Run as a static site (recommended to avoid local file restrictions and keep behavior consistent):

```bash
cd epub-viewer
npx serve .
```

Open the URL printed by `serve` (usually `http://localhost:3000`).

## Deployment

This is a static project and can be deployed to:

- GitHub Pages
- Netlify
- Vercel (static)
- Any static file host

## License

No license file is currently included. Add a `LICENSE` file before open-source distribution.
